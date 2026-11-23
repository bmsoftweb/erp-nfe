/**
 * Concentrador (doc/plano-concentrador.md, fases 1 e 2): os módulos do ERP mandam
 * a nota em JSON com uma referência própria, e o BMNFe numera, gera, assina,
 * transmite e responde. Mandar a mesma referência de novo nunca cria outra nota:
 * devolve a que existe ou continua de onde parou.
 *
 *   POST /api/emitir              { referencia, documento, sincrono?, transmitir? }
 *                                 documento.ide.modelo: '55' ou '65' (sem ele, o da configuração)
 *                                 transmitir: false = numera, gera, assina e valida; a nota fica
 *                                 "assinada", pronta para o Enviar da tela (nada vai à SEFAZ)
 *   GET  /api/emitir/:referencia  situação, sem transmitir (consulta a SEFAZ se ficou sem resposta)
 *   GET  /api/emitir-pendentes    referências paradas sem autorização (números a inutilizar)
 *   POST /api/calcular            { documento }: impostos por item e totais, sem número, sem
 *                                 assinar e sem gravar nada (o pedido do erp-vendas)
 */
import crypto from 'crypto';
import { Router } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../db.js';
import { carregarCertificado, carregarEmitente, Contexto, montarContexto } from '../nfe/contexto.js';
import { lerConfig } from '../config.js';
import { assinar, assinarDocumentoSha256 } from '../nfe/assinatura.js';
import { calcularNota, gerarNFe, qrCodeComDigest } from '../nfe/gerarNFe.js';
import { autorizar, consultarChave, consultarRecibo, enviarEvento, inutilizar, montarProcNFe } from '../nfe/operacoes.js';
import { exigirValido, FalhaSchema, validarNFe } from '../nfe/validacao.js';
import { dataHoraMysql } from '../nfe/datas.js';
import { recortarElemento, semDeclaracao, valorTag } from '../nfe/xml.js';
import { exigirSerie, reservarNumero } from '../nfe/numeracao.js';
import { comModelo, decidir, exigirCSC, PRAZO_PROCESSANDO_S, situacaoPeloStatus, validarReferencia } from '../nfe/concentrador.js';
import { empresaDaRequisicao, rota } from './nfe.js';

interface Linha {
  id: number;
  referencia: string;
  chave: string | null;
  modelo: string;
  serie: number;
  numero: number;
  situacao: string;
  recibo: string | null;
  protocolo: string | null;
  codigo_status: number | null;
  motivo: string | null;
  xml: string | null;
  xml_protocolo: string | null;
  /** Segundos desde a última mudança da linha */
  idade: number;
}

const texto = (err: any) => String(err?.message || err).slice(0, 255);

async function buscar(
  empresaId: number,
  referencia: string,
  con: Pick<PoolConnection, 'query'> = pool,
): Promise<Linha | undefined> {
  try {
    const [linhas] = await con.query<any[]>(
      `SELECT id, referencia, chave, modelo, serie, numero, situacao, recibo, protocolo, codigo_status,
              motivo, xml, xml_protocolo, TIMESTAMPDIFF(SECOND, atualizado_em, NOW()) AS idade
         FROM nfe_documentos WHERE empresa_id = ? AND referencia = ? LIMIT 1`,
      [empresaId, referencia],
    );
    return linhas[0];
  } catch (err: any) {
    if (err?.code === 'ER_BAD_FIELD_ERROR') {
      throw new Error('Falta a coluna referencia em nfe_documentos: rode o extras/2026-11-05_concentrador.sql no banco.');
    }
    throw err;
  }
}

/** Os nomes das colunas são fixos, do próprio código; só os valores vêm de fora */
async function atualizar(id: number, campos: Record<string, unknown>) {
  const nomes = Object.keys(campos);
  await pool.query(
    `UPDATE nfe_documentos SET ${nomes.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`,
    [...nomes.map((n) => campos[n]), id],
  );
}

function resposta(l: Linha, repetida = false) {
  return {
    success: true,
    referencia: l.referencia,
    situacao: l.situacao,
    chave: l.chave,
    modelo: l.modelo,
    serie: l.serie,
    numero: l.numero,
    protocolo: l.protocolo,
    cStat: l.codigo_status,
    motivo: l.motivo,
    /** nfeProc (nota + protocolo) quando autorizada, cancelada ou denegada */
    xml: l.xml_protocolo,
    /** true quando nada foi transmitido nesta chamada: a nota já estava resolvida */
    repetida,
  };
}

/**
 * Primeira vez da referência: reserva o número e grava o rascunho antes de qualquer
 * coisa. O GET_LOCK da referência faz as chamadas simultâneas com a mesma referência
 * esperarem a primeira; sem ele, cada uma reservaria um número e as perdedoras
 * deixariam buracos na série.
 */
async function criar(ctx: Contexto, referencia: string, documento: any): Promise<Linha> {
  // O nome do lock tem no máximo 64 caracteres; a referência tem até 80
  const trava = `bmnfe:${crypto.createHash('sha1').update(`${ctx.empresaId}:${referencia}`).digest('hex')}`;
  const con = await pool.getConnection();
  try {
    const [[{ obtida }]] = await con.query<any[]>('SELECT GET_LOCK(?, 15) AS obtida', [trava]);
    if (Number(obtida) !== 1) throw new Error('Outra chamada está criando esta referência. Tente de novo em instantes.');

    // Daqui até soltar o lock, tudo pela conexão do lock: cada chamada usa uma só do pool
    const existente = await buscar(ctx.empresaId, referencia, con);
    if (existente) return existente;

    const serie = Number(documento.ide.serie ?? 1);
    // Série fora do cadastro (ou inativa) nem reserva número
    await exigirSerie({ empresaId: ctx.empresaId, modelo: ctx.config.geral.modeloDF, serie }, con);
    const numero = await reservarNumero({
      empresaId: ctx.empresaId, modelo: ctx.config.geral.modeloDF, serie, ambiente: ctx.config.webservice.ambiente,
    }, con);
    await con.query(
      `INSERT INTO nfe_documentos (empresa_id, referencia, modelo, serie, numero, situacao, ambiente, dados)
       VALUES (?, ?, ?, ?, ?, 'rascunho', ?, CAST(? AS JSON))`,
      [ctx.empresaId, referencia, ctx.config.geral.modeloDF, serie, numero, ctx.config.webservice.ambiente,
        JSON.stringify(documento)],
    );
    return (await buscar(ctx.empresaId, referencia, con))!;
  } finally {
    await con.query('SELECT RELEASE_LOCK(?)', [trava]).catch(() => {});
    con.release();
  }
}

/** Grava o resultado de um protocolo (do envio, do recibo ou da consulta pela chave) */
async function aplicarProtocolo(l: Linha, xml: string, protNFe: string, cStat: number, motivo: string) {
  const situacao = situacaoPeloStatus(cStat);
  const usouNumero = situacao !== 'rejeitada';
  await atualizar(l.id, {
    situacao,
    protocolo: usouNumero ? valorTag(protNFe, 'nProt') || null : null,
    codigo_status: cStat,
    motivo: motivo.slice(0, 255),
    xml_protocolo: usouNumero ? montarProcNFe(xml, protNFe) : null,
  });
  // NFC-e de contingência gerada de novo e autorizada: o DANFE tem de sair de novo (art. 104, § 4º, III) até o módulo confirmar
  if (situacao === 'autorizada') {
    await pool.query(
      `UPDATE nfe_documentos SET dados = JSON_SET(dados, '$.reimprimir', CAST('true' AS JSON))
        WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(dados, '$.regerada')) = 'true'`,
      [l.id],
    );
  }
}

/**
 * Nota que saiu sem resposta: descobre na SEFAZ o que aconteceu com ela. Vem antes
 * de qualquer reenvio, porque gerar de novo muda a chave e, se a primeira tiver sido
 * autorizada, a segunda volta com a rejeição 539 e a autorizada fica sem dono.
 */
async function verificar(ctx: Contexto, l: Linha): Promise<'resolvida' | 'nao_consta' | 'pendente' | 'fora'> {
  try {
    if (l.recibo) {
      const r = await consultarRecibo(ctx, l.recibo);
      if (r.dados?.emProcessamento) return 'pendente';
      if (r.dados?.protNFe && r.dados.chave === l.chave && l.xml) {
        await aplicarProtocolo(l, l.xml, r.dados.protNFe, r.dados.cStatNota, r.dados.motivoNota);
        return 'resolvida';
      }
    }
    if (!l.chave || !l.xml) return 'nao_consta';

    const c = await consultarChave(ctx, l.chave);
    if (c.cStat === 217) return 'nao_consta'; // NF-e não consta na base da SEFAZ
    if (c.dados?.protNFe) {
      // Vale o cStat da consulta: nota cancelada traz o protocolo original, de autorização
      await aplicarProtocolo(l, l.xml, c.dados.protNFe, c.cStat, c.xMotivo);
      return 'resolvida';
    }
    // Serviço paralisado ou resposta sem cStat: a SEFAZ está fora
    return SEFAZ_PARADA.includes(c.cStat) || !c.cStat ? 'fora' : 'pendente';
  } catch (err) {
    // SEFAZ fora do ar ou sem resposta: continua sem saber, o módulo pergunta depois
    return semComunicacao(err) ? 'fora' : 'pendente';
  }
}

// ---------------------------------------------------------------------------
// Contingência offline da NFC-e (tpEmis 9) — Requisito III do PAF-NFC-e de SC
// ---------------------------------------------------------------------------

/** cStat de serviço fora do ar: a nota não foi processada e sai em contingência */
const SEFAZ_PARADA = [108, 109];

/** Erro de rede ou tempo esgotado: a SEFAZ não respondeu (não é erro da nota, do certificado nem do schema) */
const ERROS_REDE = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR'];
const semComunicacao = (err: any) => ERROS_REDE.includes(err?.code) || err?.name === 'AbortError' ||
  /não respondeu|tempo (de conexão )?esgotado|timeout|abort/i.test(String(err?.message || ''));

/** NFC-e vedada a partir deste total (RICMS/SC Anexo 11, art. 96, § 7º); vale para emitente do PAF-NFC-e de SC */
const LIMITE_NFCE = 200000;

/**
 * Entrada em contingência (dhCont), gravada uma vez e repetida em todas as notas até o retorno à
 * emissão normal (§ 1º do Requisito III): vale o dhCont da NFC-e mais recente da fila de contingência, enquanto
 * nenhuma NFC-e normal for autorizada depois dela; fila vazia (todas transmitidas) = a próxima começa agora.
 * Sempre "AAAA-MM-DDTHH:MM:SS" (hora de Brasília): com espaço, o dataDoDocumento lia no fuso do
 * servidor, e na Vercel (UTC) o dhCont saía 3 h antes.
 */
async function inicioContingencia(empresaId: number, ambiente: number, excetoId: number): Promise<string> {
  // A mais recente: com uma NFC-e normal autorizada no meio, as anteriores são de outra contingência
  const [[r]] = await pool.query<any[]>(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(dados, '$.ide.dataContingencia')) AS inicio,
            DATE_FORMAT(data_emissao, '%Y-%m-%d %H:%i:%s') AS emissao
       FROM nfe_documentos
      WHERE empresa_id = ? AND modelo = '65' AND ambiente = ? AND id <> ? AND situacao = 'contingencia'
      ORDER BY data_emissao DESC, id DESC LIMIT 1`,
    [empresaId, ambiente, excetoId],
  );
  const anterior = r?.inicio && r.inicio !== 'null' ? String(r.inicio) : null;
  if (anterior) {
    // NFC-e normal (tpEmis 1) autorizada depois da emissão dela: aquela contingência acabou e esta começa agora
    const [[voltou]] = await pool.query<any[]>(
      `SELECT 1 AS ok FROM nfe_documentos
        WHERE empresa_id = ? AND modelo = '65' AND ambiente = ? AND situacao = 'autorizada'
          AND SUBSTRING(chave, 35, 1) = '1' AND data_emissao > ? LIMIT 1`,
      [empresaId, ambiente, r.emissao || anterior.slice(0, 19).replace('T', ' ')],
    );
    if (!voltou) return anterior.replace(' ', 'T');
  }
  return dataHoraMysql().replace(' ', 'T');
}

/** NFC-e de contingência (tpEmis 9 na chave) */
const ehContingencia = (chave: string | null | undefined) => chave?.[34] === '9';

/**
 * Gera a nota com tpEmis 9, assina e grava como "contingencia". O XML volta para o PDV imprimir o DANFE;
 * a transmissão fica para o transmitirContingencia.
 * - `normal`: a tentativa normal chegou a ser enviada (sem resposta ou serviço paralisado). O número dela não
 *   pode ser reutilizado em contingência (RICMS/SC Anexo 11, art. 104, § 5º, I): a contingência pega outro, e
 *   a normal é cancelada ou inutilizada quando a SEFAZ voltar (art. 105; resolverNormais).
 * - `refazer`: NFC-e de contingência recusada gerada de novo com o mesmo número, série, data de emissão e
 *   dhCont (art. 104, § 4º).
 */
async function emitirEmContingencia(ctx: Contexto, l: Linha, documento: any, numero: number, motivo: string,
  normal?: { chave: string; xml: string }, refazer?: { emissao: string; inicio: string; justificativa?: string; normal?: any }) {
  if (normal) {
    numero = await reservarNumero({ empresaId: ctx.empresaId, modelo: l.modelo, serie: l.serie, ambiente: ctx.config.webservice.ambiente });
  }
  const inicio = refazer?.inicio || (await inicioContingencia(ctx.empresaId, ctx.config.webservice.ambiente, l.id));
  const emissao = refazer?.emissao || dataHoraMysql().replace(' ', 'T');
  const formatoImpressao = await exigirSerie({ empresaId: ctx.empresaId, modelo: l.modelo, serie: l.serie });
  const doc = {
    ...documento,
    ide: {
      ...documento.ide, serie: l.serie, numero, formatoImpressao, tipoEmissao: 9, dataEmissao: emissao,
      // Gerada de novo: mesmo cNF, para a chave do DANFE já entregue continuar valendo (art. 104, § 4º)
      ...(refazer && l.chave && { codigoNumerico: Number(l.chave.slice(35, 43)) }),
      dataContingencia: inicio,
      justificativaContingencia: refazer?.justificativa || documento.ide?.justificativaContingencia || 'Sem comunicacao com a SEFAZ autorizadora da NFC-e',
    },
  };
  const gerada = gerarNFe(ctx, doc);
  if (ctx.paf && Number(gerada.totais.vNF) >= LIMITE_NFCE) {
    throw new Error('NFC-e é vedada para operação de R$ 200.000,00 ou mais (RICMS/SC Anexo 11, art. 96, § 7º): emita NF-e (modelo 55).');
  }
  // Gerada de novo: sem mudar as variáveis do imposto, o destinatário nem a data de emissão (art. 104, § 4º, I)
  if (refazer && l.xml) {
    const fixos = (x: string) => {
      const tot = recortarElemento(x, 'ICMSTot') || '';
      const ibs = recortarElemento(x, 'IBSCBSTot') || '';
      const dest = recortarElemento(x, 'dest') || '';
      const is = recortarElemento(x, 'ISTot') || '';
      return [...['vNF', 'vBC', 'vICMS', 'vBCST', 'vST', 'vIPI', 'vFCP', 'vFCPST', 'vPIS', 'vCOFINS'].map((t) => valorTag(tot, t)),
        valorTag(ibs, 'vIBS'), valorTag(ibs, 'vCBS'), valorTag(is, 'vIS'),
        valorTag(dest, 'CPF'), valorTag(dest, 'CNPJ'), valorTag(dest, 'idEstrangeiro'), valorTag(x, 'dhEmi')].join('|');
    };
    if (fixos(gerada.xml) !== fixos(l.xml)) {
      throw new Error('A NFC-e em contingência só pode ser gerada de novo com os mesmos valores, destinatário e data (Anexo 11, art. 104, § 4º, I).');
    }
  }
  const xml = qrCodeComDigest(ctx, `<?xml version="1.0" encoding="UTF-8"?>` +
    assinar(semDeclaracao(gerada.xml), 'infNFe', `NFe${gerada.chave}`, ctx.certificado));
  exigirValido(await validarNFe(xml), `Falha na validação da NFC-e em contingência: ${numero}`, ctx.config.geral.exibirErroSchema);
  await atualizar(l.id, {
    situacao: 'contingencia', chave: gerada.chave, numero, xml, data_emissao: emissao.replace('T', ' '),
    valor_total: gerada.totais.vNF,
    recibo: null, protocolo: null, codigo_status: null, xml_protocolo: null, motivo: `Emitida em contingência: ${motivo}`.slice(0, 255),
    // A tentativa normal ainda não resolvida (art. 105) acompanha a nota gerada de novo
    dados: JSON.stringify({ ...doc, ...(refazer && { regerada: true }), ...(normal ? { normal: { chave: normal.chave, xml: normal.xml, numero: l.numero } } : refazer?.normal ? { normal: refazer.normal } : {}) }),
  });
}

/**
 * Tentativas normais que ficaram sem resposta antes da contingência (art. 105 do Anexo 11): autorizada → cancela
 * (a venda está na NFC-e de contingência); não consta na SEFAZ → inutiliza o número. Roda depois da fila.
 * Sem resposta, fica para a próxima rodada (dados.normal.resolvida em branco); resposta definitiva sem solução = 'falhou'.
 */
async function resolverNormais(ctx: Contexto) {
  // Resposta da SEFAZ que não muda tentando de novo ('falhou' com o motivo); fora do ar e consumo indevido esperam
  const definitiva = (cStat: number) => cStat > 0 && !SEFAZ_PARADA.includes(cStat) && cStat !== 656;
  const [linhas] = await pool.query<any[]>(
    `SELECT id, serie, dados FROM nfe_documentos
      WHERE empresa_id = ? AND modelo = '65' AND ambiente = ? AND situacao <> 'contingencia'
        AND JSON_EXTRACT(dados, '$.normal.chave') IS NOT NULL AND JSON_EXTRACT(dados, '$.normal.resolvida') IS NULL`,
    [ctx.empresaId, ctx.config.webservice.ambiente],
  );
  for (const l of linhas) {
    const dados = typeof l.dados === 'string' ? JSON.parse(l.dados) : l.dados;
    const n = dados.normal;
    let resolvida: string | null = null;
    let motivo = '';
    let autorizada = false;
    try {
      const c = await consultarChave(ctx, n.chave);
      const situacao = situacaoPeloStatus(c.cStat);
      if (c.dados?.protNFe && situacao === 'autorizada') {
        autorizada = true;
        const justificativa = 'Venda registrada na NFC-e emitida em contingencia (RICMS/SC Anexo 11, art. 105, I)';
        const ret = await enviarEvento(ctx, { chave: n.chave, tipoEvento: '110111', protocolo: valorTag(c.dados.protNFe, 'nProt'), justificativa });
        await pool.query(
          `INSERT INTO nfe_eventos (empresa_id, chave, tipo_evento, descricao, sequencia, ambiente, data_evento, justificativa, protocolo, codigo_status, motivo, xml, xml_retorno)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ctx.empresaId, n.chave, '110111', ret.dados?.descricao ?? 'Cancelamento', ret.dados?.sequencia ?? 1, ctx.config.webservice.ambiente, dataHoraMysql(),
            justificativa, ret.dados?.protocolo || null, ret.cStat, ret.xMotivo, ret.dados?.xmlEnvio || null, ret.dados?.procEventoNFe || ret.xml],
        );
        if (ret.sucesso || ret.cStat === 573) resolvida = 'cancelada';
        // 501: passou o prazo do cancelamento; a correção é NF-e de estorno (art. 106, parágrafo único). Não tenta de novo
        else if (ret.cStat === 501) resolvida = 'estornar';
        else if (definitiva(ret.cStat)) resolvida = 'falhou';
        motivo = resolvida === 'estornar'
          ? `NFC-e ${n.numero} (normal) autorizada e fora do prazo de cancelamento: emitir NF-e de estorno (Anexo 11, art. 106)`
          : `${ret.cStat} - ${ret.xMotivo}`;
      } else if (situacao === 'cancelada' || situacao === 'denegada' || c.cStat === 135) {
        resolvida = situacao === 'denegada' ? 'denegada' : 'cancelada';
        motivo = `${c.cStat} - ${c.xMotivo}`;
      } else if (c.cStat === 217) {
        const p = { ano: 2000 + Number(n.chave.slice(2, 4)), modelo: '65', serie: Number(l.serie), numeroInicial: Number(n.numero), numeroFinal: Number(n.numero),
          justificativa: 'Numero nao autorizado: a venda saiu em NFC-e de contingencia (RICMS/SC Anexo 11, art. 105, II)' };
        const ret = await inutilizar(ctx, p);
        await pool.query(
          `INSERT INTO nfe_inutilizacoes (empresa_id, ano, modelo, serie, numero_inicial, numero_final, justificativa, ambiente, protocolo, codigo_status, motivo, xml, xml_retorno)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [ctx.empresaId, p.ano, p.modelo, p.serie, p.numeroInicial, p.numeroFinal, p.justificativa, ctx.config.webservice.ambiente,
            ret.dados?.protocolo || null, ret.cStat, ret.xMotivo, ret.dados?.xmlEnvio || null, ret.dados?.procInutNFe || ret.xml],
        );
        // 563: já há pedido para a mesma faixa; 256: o número já está inutilizado
        if ([102, 563, 256].includes(ret.cStat)) resolvida = 'inutilizada';
        else if (definitiva(ret.cStat)) resolvida = 'falhou';
        motivo = `${ret.cStat} - ${ret.xMotivo}`;
      } else {
        if (definitiva(c.cStat)) resolvida = 'falhou';
        motivo = `${c.cStat} - ${c.xMotivo}`;
      }
    } catch (err) {
      motivo = texto(err);
    }
    // Normal autorizada e não cancelada: o Menu Fiscal a inclui no J1
    if (autorizada && (resolvida === 'falhou' || resolvida === 'estornar')) {
      await pool.query("UPDATE nfe_documentos SET dados = JSON_SET(dados, '$.normal.autorizada', CAST('true' AS JSON)) WHERE id = ?", [l.id]);
    }
    // Sem resolver, '$.normal.resolvida' continua ausente (JSON null não seria IS NULL na próxima rodada)
    await pool.query(
      resolvida
        ? "UPDATE nfe_documentos SET dados = JSON_SET(dados, '$.normal.motivo', ?, '$.normal.resolvida', ?) WHERE id = ?"
        : "UPDATE nfe_documentos SET dados = JSON_SET(dados, '$.normal.motivo', ?) WHERE id = ?",
      resolvida ? [motivo.slice(0, 255), resolvida, l.id] : [motivo.slice(0, 255), l.id],
    );
  }
}

/**
 * Transmite as NFC-e em contingência da empresa, da mais antiga para a mais nova, sem
 * gerar de novo (o DANFE já foi entregue com esta chave). Para na primeira sem resposta:
 * as outras esperam a próxima rodada (`erro` preenchido só nesse caso). `sefazFora`: parou porque a SEFAZ não
 * respondeu (rede, tempo esgotado, cStat 108/109); só então a venda nova sai em contingência. Nota que a SEFAZ
 * recusou (lote ou protocolo) ou que não passa no schema sai da fila como rejeitada e vai para `recusadas`.
 * `autorizadas`: NFC-e geradas de novo (art. 104, § 4º) autorizadas e ainda não reimpressas (dados.reimprimir), de
 * qualquer rodada: o módulo reimprime e confirma em POST /emitir/reimpresso.
 */
export interface Autorizada { chave: string; referencia: string }
type Fila = {
  transmitidas: number; pendentes: number; erro?: string; sefazFora: boolean; autorizadas: Autorizada[];
  recusadas: Recusada[]; estornos: Estorno[];
};

/** Último sefazFora de cada empresa, para quem chega com a fila ocupada. ponytail: por processo (cada instância da Vercel tem o seu) */
const ultimoSefazFora = new Map<number, boolean>();

/**
 * Uma fila por empresa de cada vez (cron, timer do servidor, caixas e emissões chamam juntos): a que chega com
 * outra rodando só devolve a situação. Reenviar o mesmo lote em paralelo é o que dá consumo indevido na SEFAZ.
 * `sonda`: transmite só a primeira da fila, para a venda decidir se a SEFAZ está fora sem esperar a fila inteira.
 */
export async function transmitirContingencia(ctx: Contexto, sonda = false): Promise<Fila> {
  const c = await pool.getConnection();
  const trava = `nfce-contingencia-${ctx.empresaId}`;
  const avisos = async () => ({ autorizadas: await aReimprimir(ctx), recusadas: await contingenciasRecusadas(ctx), estornos: await estornosPendentes(ctx) });
  try {
    const [[{ ok }]] = await c.query<any[]>('SELECT GET_LOCK(?, 0) AS ok', [trava]);
    if (!ok) {
      const [[{ n }]] = await pool.query<any[]>(
        "SELECT COUNT(*) AS n FROM nfe_documentos WHERE empresa_id = ? AND modelo = '65' AND ambiente = ? AND situacao = 'contingencia'",
        [ctx.empresaId, ctx.config.webservice.ambiente],
      );
      return { transmitidas: 0, pendentes: Number(n), sefazFora: ultimoSefazFora.get(ctx.empresaId) ?? false, ...(await avisos()) };
    }
    try {
      const r = await transmitirFila(ctx, sonda);
      ultimoSefazFora.set(ctx.empresaId, r.sefazFora);
      return { ...r, ...(await avisos()) };
    } finally {
      await c.query('SELECT RELEASE_LOCK(?)', [trava]);
    }
  } finally {
    c.release();
  }
}

async function transmitirFila(ctx: Contexto, sonda: boolean): Promise<Omit<Fila, 'recusadas' | 'estornos' | 'autorizadas'>> {
  const [linhas] = await pool.query<any[]>(
    `SELECT id, referencia, chave, modelo, serie, numero, situacao, recibo, protocolo, codigo_status, motivo, xml,
            xml_protocolo, 0 AS idade
       FROM nfe_documentos
      WHERE empresa_id = ? AND modelo = '65' AND ambiente = ? AND situacao = 'contingencia'
      ORDER BY data_emissao, id`,
    [ctx.empresaId, ctx.config.webservice.ambiente],
  );
  let transmitidas = 0;
  let quantasRecusadas = 0;
  const parou = async (erro: string, sefazFora: boolean) => {
    // Com a SEFAZ fora as tentativas normais (art. 105) esperam; com outro erro, resolvem já (na sonda, o timer resolve)
    if (!sefazFora && !sonda) await resolverNormais(ctx).catch((err) => console.error('Contingência: tentativas normais:', err));
    return { transmitidas, pendentes: linhas.length - transmitidas - quantasRecusadas, erro, sefazFora };
  };
  for (const l of (sonda ? linhas.slice(0, 1) : linhas) as Linha[]) {
    let ret: Awaited<ReturnType<typeof autorizar>>;
    try {
      ret = await autorizar(ctx, l.xml!, { sincrono: true });
    } catch (err) {
      // XML que não passa no schema nunca vai passar: sai da fila como recusada, para ser gerado de novo
      if (err instanceof FalhaSchema) {
        await atualizar(l.id, { situacao: 'rejeitada', codigo_status: null, motivo: `Contingência recusada: ${texto(err)}`.slice(0, 255) });
        quantasRecusadas++;
        continue;
      }
      return parou(texto(err), semComunicacao(err));
    }
    const d = ret.dados || {};
    // SEFAZ fora (serviço paralisado ou resposta sem cStat): a nota continua na fila
    if (SEFAZ_PARADA.includes(ret.cStat) || !ret.cStat) return parou(`${ret.cStat} - ${ret.xMotivo}`, true);
    // Consumo indevido (656) ou lote só recebido (recibo): nada definitivo sobre a nota, continua na fila
    if (!d.protNFe && (ret.cStat === 656 || d.recibo)) return parou(`${ret.cStat} - ${ret.xMotivo}`, false);
    if (d.protNFe && situacaoPeloStatus(d.cStatNota) !== 'rejeitada') {
      await aplicarProtocolo(l, l.xml!, d.protNFe, d.cStatNota, d.motivoNota);
    } else if (d.cStatNota === 204 || ret.cStat === 204) {
      if ((await verificar(ctx, l)) !== 'resolvida') continue;
    } else if (!d.protNFe && ret.cStat >= 280 && ret.cStat <= 286) {
      // Lote recusado pelo certificado do transmissor (280–286): não é da nota, a fila para e ela continua nela
      return parou(`${ret.cStat} - ${ret.xMotivo}`, false);
    } else {
      // Inclui o lote recusado inteiro (cStat do lote, sem protNFe): definitivo para esta nota
      // Recusada: a SEFAZ respondeu e a nota não entrou. Sai da fila como rejeitada (reenviar a mesma nota a cada
      // minuto é o laço que suspende o credenciamento, RICMS/SC Anexo 11, art. 113-A). Corrigida, gera de novo com o
      // mesmo número, série e data de emissão (art. 104, § 4º): POST /emitir/:referencia/regerar ou a mesma referência
      const cStat = d.cStatNota || ret.cStat;
      await atualizar(l.id, { situacao: 'rejeitada', codigo_status: cStat, motivo: `Contingência recusada: ${cStat} - ${d.motivoNota || ret.xMotivo}`.slice(0, 255) });
      quantasRecusadas++;
      continue;
    }
    transmitidas++;
  }
  if (!sonda) await resolverNormais(ctx).catch((err) => console.error('Contingência: tentativas normais:', err));
  return { transmitidas, pendentes: linhas.length - transmitidas - quantasRecusadas, sefazFora: false };
}

/** NFC-e geradas de novo, autorizadas e ainda não reimpressas (art. 104, § 4º, III) */
async function aReimprimir(ctx: Contexto): Promise<Autorizada[]> {
  const [linhas] = await pool.query<any[]>(
    `SELECT chave, referencia FROM nfe_documentos
      WHERE empresa_id = ? AND modelo = '65' AND ambiente = ? AND JSON_UNQUOTE(JSON_EXTRACT(dados, '$.reimprimir')) = 'true'
      ORDER BY data_emissao, id`,
    [ctx.empresaId, ctx.config.webservice.ambiente],
  );
  return linhas;
}

export interface Estorno { referencia: string; numero: number; chave: string; motivo: string }

/**
 * Tentativa normal autorizada que não deu para cancelar no prazo: a venda pede NF-e de estorno (art. 106, parágrafo
 * único). Sem limite de data: o aviso só some com a chave do estorno gravada (POST /emitir/:referencia/estorno).
 */
async function estornosPendentes(ctx: Contexto): Promise<Estorno[]> {
  const [linhas] = await pool.query<any[]>(
    `SELECT referencia, JSON_UNQUOTE(JSON_EXTRACT(dados, '$.normal.numero')) AS numero, JSON_UNQUOTE(JSON_EXTRACT(dados, '$.normal.chave')) AS chave,
            JSON_UNQUOTE(JSON_EXTRACT(dados, '$.normal.motivo')) AS motivo
       FROM nfe_documentos
      WHERE empresa_id = ? AND modelo = '65' AND ambiente = ? AND JSON_UNQUOTE(JSON_EXTRACT(dados, '$.normal.resolvida')) = 'estornar'
        AND JSON_EXTRACT(dados, '$.normal.estorno') IS NULL`,
    [ctx.empresaId, ctx.config.webservice.ambiente],
  );
  return linhas;
}

export interface Recusada { referencia: string; numero: number; chave: string; motivo: string }

/** NFC-e de contingência recusadas e ainda não geradas de novo: os módulos avisam o operador (art. 104, § 4º) */
async function contingenciasRecusadas(ctx: Contexto): Promise<Recusada[]> {
  const [linhas] = await pool.query<any[]>(
    `SELECT referencia, numero, chave, motivo FROM nfe_documentos
      WHERE empresa_id = ? AND modelo = '65' AND ambiente = ? AND situacao = 'rejeitada' AND SUBSTRING(chave, 35, 1) = '9'
      ORDER BY data_emissao, id`,
    [ctx.empresaId, ctx.config.webservice.ambiente],
  );
  return linhas;
}

/**
 * Transmissão autônoma (Requisito III, II): todas as empresas com NFC-e em contingência, sem depender
 * de caixa aberto. Roda pelo /api/cron/contingencia (Vercel Cron ou agendador externo) e, no servidor
 * local, a cada minuto (server.ts). Uma empresa com problema (certificado vencido) não para as outras.
 */
export async function transmitirContingenciaDeTodas() {
  const [empresas] = await pool.query<any[]>(`SELECT DISTINCT empresa_id FROM nfe_documentos
      WHERE modelo = '65' AND (situacao = 'contingencia'
         OR (JSON_EXTRACT(dados, '$.normal.chave') IS NOT NULL AND JSON_EXTRACT(dados, '$.normal.resolvida') IS NULL))`);
  const resultado: Record<number, unknown> = {};
  for (const { empresa_id } of empresas) {
    try {
      const ctx = comModelo(await montarContexto(Number(empresa_id)), '65');
      resultado[empresa_id] = await transmitirContingencia(ctx);
    } catch (err) {
      resultado[empresa_id] = { erro: texto(err) };
    }
  }
  return resultado;
}

/**
 * Gera, assina, valida e transmite. A linha já está "processando" nas mãos desta chamada.
 * Sem transmitir, para depois de gravar o XML assinado e devolve os totais calculados.
 * Com `contingencia`, a NFC-e que não chega à SEFAZ sai em contingência offline.
 */
async function gerarETransmitir(ctx: Contexto, l: Linha, documento: any, sincrono: boolean, transmitir = true, contingencia = false) {
  // NFC-e de contingência recusada (art. 104, § 4º): o DANFE já saiu com este número; gera de novo com o mesmo
  // número, série, data de emissão e dhCont, e transmite na hora (sem resposta, volta para a fila)
  if (l.modelo === '65' && ehContingencia(l.chave)) {
    const [[a]] = await pool.query<any[]>(
      `SELECT JSON_UNQUOTE(JSON_EXTRACT(dados, '$.ide.dataContingencia')) AS inicio,
              JSON_UNQUOTE(JSON_EXTRACT(dados, '$.ide.justificativaContingencia')) AS justificativa,
              DATE_FORMAT(data_emissao, '%Y-%m-%dT%H:%i:%s') AS emissao, JSON_EXTRACT(dados, '$.normal') AS normal
         FROM nfe_documentos WHERE id = ?`,
      [l.id],
    );
    try {
      await emitirEmContingencia(ctx, l, documento, l.numero, 'gerada de novo depois da recusa (art. 104, § 4º)', undefined,
        { emissao: a.emissao, inicio: a.inicio, justificativa: a.justificativa, normal: typeof a.normal === 'string' ? JSON.parse(a.normal) : a.normal ?? undefined });
    } catch (err) {
      await atualizar(l.id, { situacao: 'rejeitada', motivo: `Contingência recusada; nova geração falhou: ${texto(err)}`.slice(0, 255) });
      throw err;
    }
    await transmitirContingencia(ctx);
    return;
  }
  // 539: o número foi usado na SEFAZ por outra chave; esta nota precisa de outro
  const numero = l.codigo_status === 539
    ? await reservarNumero({
        empresaId: ctx.empresaId, modelo: l.modelo, serie: l.serie, ambiente: ctx.config.webservice.ambiente,
      })
    : l.numero;
  const dados = JSON.stringify(documento);

  let xml: string;
  let gerada: ReturnType<typeof gerarNFe>;
  try {
    const formatoImpressao = await exigirSerie({ empresaId: ctx.empresaId, modelo: l.modelo, serie: l.serie });
    // PAF-NFC-e: a NFC-e do caminho normal é sempre tpEmis 1; a contingência (9) só sai pelo emitirEmContingencia
    const tipoEmissao = ctx.paf && l.modelo === '65' ? 1 : documento.ide.tipoEmissao;
    gerada = gerarNFe(ctx, { ...documento, ide: { ...documento.ide, serie: l.serie, numero, formatoImpressao, tipoEmissao } });
    // NFC-e vedada a partir de R$ 200.000,00 (RICMS/SC Anexo 11, art. 96, § 7º): sai NF-e
    if (ctx.paf && l.modelo === '65' && Number(gerada.totais.vNF) >= LIMITE_NFCE) {
      throw new Error('NFC-e é vedada para operação de R$ 200.000,00 ou mais (RICMS/SC Anexo 11, art. 96, § 7º): emita NF-e (modelo 55).');
    }
    xml = `<?xml version="1.0" encoding="UTF-8"?>` +
      assinar(semDeclaracao(gerada.xml), 'infNFe', `NFe${gerada.chave}`, ctx.certificado);
    exigirValido(
      await validarNFe(xml),
      `Falha na validação dos dados da nota: ${numero}`,
      ctx.config.geral.exibirErroSchema,
    );
  } catch (err) {
    // Volta a rascunho com o mesmo número: o módulo corrige e manda a mesma referência
    await atualizar(l.id, { situacao: 'rascunho', numero, codigo_status: null, motivo: texto(err), dados });
    throw err;
  }

  const dest = documento.destinatario;
  await atualizar(l.id, {
    chave: gerada.chave, numero, data_emissao: dataHoraMysql(),
    destinatario_documento: (dest?.cnpj || dest?.cpf || '').replace(/\D/g, '') || null,
    destinatario_nome: dest?.nome || null, valor_total: gerada.totais.vNF, dados, xml,
    recibo: null, protocolo: null, codigo_status: null, motivo: null, xml_protocolo: null,
  });
  if (!transmitir) {
    await atualizar(l.id, { situacao: 'assinada' });
    return gerada.totais;
  }
  const enviada: Linha = { ...l, chave: gerada.chave, numero, xml, recibo: null };

  const usaContingencia = contingencia && l.modelo === '65';
  if (usaContingencia) {
    // A fila de contingência vai primeiro; só se a SEFAZ continuar sem responder esta também sai em
    // contingência. Fila parada por outro erro (certificado, consumo indevido…) não põe a venda em tpEmis 9
    const fila = await transmitirContingencia(ctx, true);
    if (fila.sefazFora) {
      await emitirEmContingencia(ctx, l, documento, numero, fila.erro || 'SEFAZ indisponível');
      return;
    }
  }

  let ret: Awaited<ReturnType<typeof autorizar>>;
  try {
    ret = await autorizar(ctx, xml, { sincrono });
  } catch (err) {
    // Só a falta de comunicação põe a venda em contingência (como na fila); outro erro fica como envio sem resposta
    if (usaContingencia && semComunicacao(err)) {
      await emitirEmContingencia(ctx, l, documento, numero, texto(err), { chave: gerada.chave, xml });
      return;
    }
    await atualizar(l.id, { situacao: 'enviada', motivo: `Sem resposta da SEFAZ: ${texto(err)}`.slice(0, 255) });
    return;
  }
  // Serviço paralisado ou resposta sem cStat (HTTP 5xx, HTML, SOAP Fault): SEFAZ fora
  if (usaContingencia && (SEFAZ_PARADA.includes(ret.cStat) || !ret.cStat)) {
    // A normal foi transmitida: o número dela não volta em contingência
    await emitirEmContingencia(ctx, l, documento, numero, `${ret.cStat} - ${ret.xMotivo}`, { chave: gerada.chave, xml });
    return;
  }
  if (!ret.cStat) {
    // Sem cStat não se sabe se a nota entrou: fica como enviada sem resposta (a consulta resolve), não rejeitada
    await atualizar(l.id, { situacao: 'enviada', motivo: `Sem resposta da SEFAZ: ${ret.xMotivo || 'resposta sem cStat'}`.slice(0, 255) });
    return;
  }

  const d = ret.dados || {};
  if (d.cStatNota === 204 || ret.cStat === 204) {
    // Duplicidade: esta mesma chave já estava na SEFAZ; a consulta traz o protocolo
    if ((await verificar(ctx, enviada)) !== 'resolvida') {
      await atualizar(l.id, { situacao: 'enviada', codigo_status: 204, motivo: ret.xMotivo });
    }
  } else if (d.protNFe) {
    await aplicarProtocolo(enviada, xml, d.protNFe, d.cStatNota, d.motivoNota);
  } else if (d.recibo) {
    await atualizar(l.id, { situacao: 'enviada', recibo: d.recibo, codigo_status: ret.cStat, motivo: ret.xMotivo });
  } else {
    // Lote recusado inteiro (cStat do lote): a nota não entrou
    await atualizar(l.id, { situacao: 'rejeitada', codigo_status: ret.cStat, motivo: ret.xMotivo });
  }
}

export function criarRotasEmitir(): Router {
  const r = Router();

  /** Mesmo motor do emitir, parado antes da chave: não usa certificado, número nem banco (só lê a configuração) */
  r.post('/calcular', rota(async (req, res) => {
    const empresaId = empresaDaRequisicao(req);
    const documento = req.body?.documento;
    if (!documento?.ide || !Array.isArray(documento.itens)) {
      throw new Error('Informe os dados da nota: documento com ide e itens.');
    }
    const [config, emitente] = await Promise.all([lerConfig(empresaId), carregarEmitente(empresaId)]);
    const ctx = comModelo({ config, emitente }, documento.ide.modelo);
    const { calculados, totais, idDest, indFinal, indIEDest } = calcularNota(ctx, documento);
    res.json({
      success: true,
      modelo: ctx.config.geral.modeloDF,
      indicadores: { idDestino: idDest, consumidorFinal: indFinal, indIEDest: indIEDest ?? null },
      itens: calculados.map((c, n) => ({ item: n + 1, ...c.valores })),
      totais,
    });
  }));

  r.post('/emitir', rota(async (req, res) => {
    const empresaId = empresaDaRequisicao(req);
    const referencia = validarReferencia(req.body?.referencia);
    const documento = req.body?.documento;
    if (!documento?.ide || !Array.isArray(documento.itens)) {
      throw new Error('Informe os dados da nota: documento com ide e itens.');
    }
    const sincrono = req.body?.sincrono !== false;
    const transmitir = req.body?.transmitir !== false;
    const contingencia = req.body?.contingencia === true;
    let ctx = comModelo(await montarContexto(empresaId), documento.ide.modelo);

    const existente = await buscar(empresaId, referencia);
    if (existente && documento.ide.modelo && String(documento.ide.modelo) !== existente.modelo) {
      throw new Error(`A referência ${referencia} já é de uma nota modelo ${existente.modelo}. Use outra referência para o modelo ${documento.ide.modelo}.`);
    }
    // Nota que já existe segue no modelo dela, mesmo que a configuração tenha mudado
    if (existente) ctx = comModelo(ctx, existente.modelo);
    // PAF-NFC-e (Requisito IV, II): NFC-e só para consumidor final pessoa física ou sem IE
    const dest = documento.destinatario;
    if (ctx.paf && ctx.config.geral.modeloDF === '65' && dest &&
      (String(dest.cnpj || '').replace(/\D/g, '') || String(dest.inscricaoEstadual || '').trim() || Number(dest.indIEDest) === 1)) {
      throw new Error('NFC-e é só para consumidor final pessoa física ou sem inscrição estadual (PAF-NFC-e, Requisito IV, II): para destinatário com CNPJ ou IE, emita NF-e (modelo 55).');
    }
    exigirCSC(ctx.config);
    let l = existente || (await criar(ctx, referencia, documento));
    let acao = decidir(l.situacao, l.idade);

    if (acao === 'verificar') {
      const v = await verificar(ctx, l);
      l = (await buscar(empresaId, referencia))!;
      // SEFAZ fora com a normal parada há mais de 120 s: a venda sai em contingência com outro número, e a normal
      // fica guardada para ser cancelada ou inutilizada quando a SEFAZ voltar (art. 104, § 5º, I; art. 105)
      if (v === 'fora' && contingencia && l.modelo === '65' && l.chave && l.xml && !ehContingencia(l.chave)) {
        const [tomada] = await pool.query<any>(
          `UPDATE nfe_documentos SET situacao = 'processando', atualizado_em = NOW()
            WHERE id = ? AND situacao IN ('enviada', 'processando') AND TIMESTAMPDIFF(SECOND, atualizado_em, NOW()) >= ?`,
          [l.id, PRAZO_PROCESSANDO_S],
        );
        if (tomada.affectedRows) {
          try {
            await emitirEmContingencia(ctx, l, documento, l.numero, 'SEFAZ sem resposta para a NFC-e enviada', { chave: l.chave, xml: l.xml });
          } catch (err) {
            await atualizar(l.id, { situacao: l.situacao });
            throw err;
          }
          return res.json(resposta((await buscar(empresaId, referencia))!));
        }
      }
      if (v === 'pendente' || v === 'fora') return res.status(202).json(resposta(l, true));
      if (v === 'resolvida') return res.json(resposta(l, true));
      // Não consta na SEFAZ: a nota nunca chegou lá e pode ser gerada de novo
      await atualizar(l.id, { situacao: 'rascunho' });
      l = { ...l, situacao: 'rascunho' };
      acao = 'gerar';
    }

    if (acao === 'devolver') return res.json(resposta(l, true));
    if (acao === 'usada') {
      return res.status(409).json({
        ...resposta(l, true),
        success: false,
        error: `A referência ${referencia} já foi usada na nota ${l.numero}, que está ${l.situacao}. Use outra referência.`,
      });
    }

    // Só uma chamada passa daqui com a mesma referência: a que mudar a situação primeiro
    const [tomada] = await pool.query<any>(
      `UPDATE nfe_documentos SET situacao = 'processando'
        WHERE id = ? AND situacao IN ('rascunho', 'assinada', 'rejeitada')`,
      [l.id],
    );
    if (acao === 'ocupada' || !tomada.affectedRows) {
      return res.status(409).json({
        ...resposta(l, true),
        success: false,
        error: 'A nota desta referência está sendo processada agora. Consulte o resultado em instantes.',
      });
    }

    const totais = await gerarETransmitir(ctx, l, documento, sincrono, transmitir, contingencia);
    l = (await buscar(empresaId, referencia))!;
    res.status(l.situacao === 'enviada' ? 202 : 200).json({ ...resposta(l), ...(totais && { totais }) });
  }));

  r.get('/emitir/:referencia', rota(async (req, res) => {
    const empresaId = empresaDaRequisicao(req);
    const referencia = validarReferencia(req.params.referencia);
    let l = await buscar(empresaId, referencia);
    if (!l) return res.status(404).json({ success: false, error: `Nenhuma nota com a referência ${referencia}.` });

    if (decidir(l.situacao, l.idade) === 'verificar') {
      const v = await verificar(comModelo(await montarContexto(empresaId), l.modelo), l);
      if (v === 'nao_consta') {
        await atualizar(l.id, { situacao: 'rascunho', motivo: 'A nota não chegou à SEFAZ. Mande a mesma referência de novo.' });
      }
      l = (await buscar(empresaId, referencia))!;
    }
    res.status(['enviada', 'processando'].includes(l.situacao) ? 202 : 200).json(resposta(l));
  }));

  /**
   * Transmite as NFC-e emitidas em contingência (Requisito III, II: automática e autônoma).
   * O PDV chama a cada minuto enquanto houver pendentes; também roda antes de cada emissão.
   */
  r.post('/emitir-contingencia', rota(async (req, res) => {
    const empresaId = empresaDaRequisicao(req);
    const ctx = comModelo(await montarContexto(empresaId), '65');
    res.json({ success: true, ...(await transmitirContingencia(ctx)) });
  }));

  /**
   * O módulo reimprimiu o DANFE das NFC-e geradas de novo e autorizadas (as `autorizadas` da fila; art. 104, § 4º, III).
   * Body: { chaves: string[] }. Devolve { success, limpas } (quantas saíram da lista).
   */
  r.post('/emitir/reimpresso', rota(async (req, res) => {
    const empresaId = empresaDaRequisicao(req);
    const chaves = (Array.isArray(req.body?.chaves) ? req.body.chaves : [])
      .map((c: unknown) => String(c).replace(/\D/g, '')).filter((c: string) => c.length === 44);
    if (!chaves.length) throw new Error('Informe as chaves reimpressas: { chaves: [...] }.');
    const [feito] = await pool.query<any>(
      `UPDATE nfe_documentos SET dados = JSON_REMOVE(dados, '$.reimprimir')
        WHERE empresa_id = ? AND chave IN (?) AND JSON_EXTRACT(dados, '$.reimprimir') IS NOT NULL`,
      [empresaId, chaves],
    );
    res.json({ success: true, limpas: feito.affectedRows });
  }));

  /**
   * NFC-e de contingência recusada pela SEFAZ: gera de novo pelos dados gravados (com a configuração e o cadastro
   * de agora), com o mesmo número, série, data de emissão e dhCont, e transmite (art. 104, § 4º). Depois o módulo
   * reimprime o DANFE. Se o erro estiver nos dados da venda, o módulo manda a mesma referência com o documento corrigido.
   */
  r.post('/emitir/:referencia/regerar', rota(async (req, res) => {
    const empresaId = empresaDaRequisicao(req);
    const referencia = validarReferencia(req.params.referencia);
    const l = await buscar(empresaId, referencia);
    if (!l) return res.status(404).json({ success: false, error: `Nenhuma nota com a referência ${referencia}.` });
    if (l.situacao !== 'rejeitada' || !ehContingencia(l.chave)) throw new Error('Só a NFC-e de contingência recusada pela SEFAZ é gerada de novo.');
    const [[{ dados }]] = await pool.query<any[]>('SELECT dados FROM nfe_documentos WHERE id = ?', [l.id]);
    const { normal: _normal, ...documento } = typeof dados === 'string' ? JSON.parse(dados) : dados;
    const ctx = comModelo(await montarContexto(empresaId), l.modelo);
    exigirCSC(ctx.config);
    const [tomada] = await pool.query<any>("UPDATE nfe_documentos SET situacao = 'processando' WHERE id = ? AND situacao = 'rejeitada'", [l.id]);
    if (!tomada.affectedRows) throw new Error('A nota desta referência está sendo processada agora. Consulte o resultado em instantes.');
    await gerarETransmitir(ctx, l, documento, true, true, true);
    res.json(resposta((await buscar(empresaId, referencia))!));
  }));

  /**
   * Chave da NF-e de estorno (art. 106, parágrafo único) da tentativa normal que não deu para cancelar:
   * grava em dados.normal.estorno e o aviso de estorno pendente some. Body: { chave } (NF-e autorizada da empresa,
   * com finNFe 3 = ajuste, inciso I, e refNFe = chave da NFC-e estornada, inciso III).
   */
  r.post('/emitir/:referencia/estorno', rota(async (req, res) => {
    const empresaId = empresaDaRequisicao(req);
    const referencia = validarReferencia(req.params.referencia);
    const chave = String(req.body?.chave || '').replace(/\D/g, '');
    const [[nfe]] = await pool.query<any[]>(
      "SELECT xml FROM nfe_documentos WHERE empresa_id = ? AND chave = ? AND modelo = '55' AND situacao = 'autorizada' LIMIT 1",
      [empresaId, chave],
    );
    if (chave.length !== 44 || !nfe?.xml) throw new Error('Informe a chave de uma NF-e (modelo 55) autorizada desta empresa.');
    const [[ref]] = await pool.query<any[]>(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(dados, '$.normal.chave')) AS normal FROM nfe_documentos WHERE empresa_id = ? AND referencia = ? LIMIT 1",
      [empresaId, referencia],
    );
    if (valorTag(nfe.xml, 'finNFe') !== '3') throw new Error('A NF-e de estorno tem de ter a finalidade de ajuste (finNFe 3; RICMS/SC Anexo 11, art. 106, parágrafo único, I).');
    const referenciadas = [...String(nfe.xml).matchAll(/<refNFe>(\d{44})<\/refNFe>/g)].map((m) => m[1]);
    if (!ref?.normal || !referenciadas.includes(ref.normal)) {
      throw new Error(`A NF-e de estorno tem de referenciar (refNFe) a chave da NFC-e estornada${ref?.normal ? ` ${ref.normal}` : ''} (art. 106, parágrafo único, III).`);
    }
    const [feito] = await pool.query<any>(
      `UPDATE nfe_documentos SET dados = JSON_SET(dados, '$.normal.estorno', ?)
        WHERE empresa_id = ? AND referencia = ? AND JSON_UNQUOTE(JSON_EXTRACT(dados, '$.normal.resolvida')) = 'estornar'`,
      [chave, empresaId, referencia],
    );
    if (!feito.affectedRows) throw new Error(`A referência ${referencia} não tem NF-e de estorno pendente.`);
    res.json({ success: true, referencia, estorno: chave });
  }));

  /**
   * Assina com o e-CNPJ do estabelecimento o XML <menuFiscal> gerado pelo Menu Fiscal do
   * PAF-NFC-e (Requisito XII). Só aceita essa raiz: a rota não assina documento qualquer.
   */
  r.post('/assinar-menu-fiscal', rota(async (req, res) => {
    const empresaId = empresaDaRequisicao(req);
    const xml = String(req.body?.xml || '').replace(/^<\?xml[^>]*>\s*/, '');
    if (!/^<menuFiscal xmlns="http:\/\/www\.sef\.sc\.gov\.br\/nfce">[\s\S]*<\/menuFiscal>$/.test(xml) || xml.includes('<Signature')) {
      throw new Error('Mande o XML <menuFiscal xmlns="http://www.sef.sc.gov.br/nfce"> sem assinatura.');
    }
    const cert = await carregarCertificado(empresaId);
    res.json({ success: true, xml: `<?xml version="1.0" encoding="UTF-8"?>${assinarDocumentoSha256(xml, cert)}` });
  }));

  /**
   * Referências paradas sem autorização há N dias (padrão 7): números a inutilizar. Fora a NFC-e de contingência
   * recusada: o número dela é proibido de inutilizar (art. 104, § 5º, II), ela é gerada de novo (regerar)
   */
  r.get('/emitir-pendentes', rota(async (req, res) => {
    const empresaId = empresaDaRequisicao(req);
    const dias = req.query.dias === undefined ? 7 : Math.max(0, Number(req.query.dias) || 0);
    const [linhas] = await pool.query<any[]>(
      `SELECT referencia, modelo, serie, numero, situacao, codigo_status, motivo, data_emissao, atualizado_em
         FROM nfe_documentos
        WHERE empresa_id = ? AND referencia IS NOT NULL
          AND situacao IN ('rascunho', 'assinada', 'rejeitada') AND COALESCE(SUBSTRING(chave, 35, 1), '') <> '9'
          AND atualizado_em < NOW() - INTERVAL ? DAY
        ORDER BY modelo, serie, numero`,
      [empresaId, dias],
    );
    res.json({ success: true, dias, itens: linhas });
  }));

  return r;
}
