/**
 * Regras do concentrador (doc/plano-concentrador.md, fase 2), sem banco nem SEFAZ,
 * para o autoteste conferir: é a parte que, se errar, gera nota duplicada.
 */
import type { ConfigNFe } from '../config.js';

/**
 * `ide.modelo` do documento ('55' NF-e ou '65' NFC-e) no lugar do modelo da configuração,
 * para a mesma empresa emitir os dois pelo concentrador. Sem ele, vale a configuração.
 * Basta trocar no contexto: gerarNFe, URLs da SEFAZ, série e numeração leem dali.
 */
export function comModelo<T extends { config: ConfigNFe }>(ctx: T, modelo: unknown): T {
  if (modelo === undefined || modelo === null || modelo === '') return ctx;
  const m = String(modelo);
  if (m !== '55' && m !== '65') throw new Error('ide.modelo deve ser 55 (NF-e) ou 65 (NFC-e).');
  return {
    ...ctx,
    config: { ...ctx.config, geral: { ...ctx.config.geral, modeloDF: m } },
    modelo: m === '65' ? 'NFCe' : 'NFe',
  };
}

/** NFC-e sem CSC sai com o QR Code inválido: barra antes de reservar número */
export function exigirCSC(config: ConfigNFe) {
  if (config.geral.modeloDF === '65' && (!String(config.geral.idCSC || '').trim() || !String(config.geral.csc || '').trim())) {
    throw new Error('NFC-e exige o CSC (identificador e código) em Configurações › Geral.');
  }
  if (config.geral.modeloDF === '65' && !/^\d{1,6}$/.test(String(config.geral.idCSC).trim())) {
    throw new Error('O identificador do CSC deve ser numérico (ex.: 000001), em Configurações › Geral. Confira se o código do CSC não foi digitado no lugar do identificador.');
  }
}

/** Depois disso, uma nota "processando" é tratada como enviada sem resposta (o processo caiu) */
export const PRAZO_PROCESSANDO_S = 120;

/**
 * O que fazer com uma referência que chegou de novo:
 * - nova: não existe, reserva número e emite;
 * - gerar: nunca foi aceita pela SEFAZ, gera de novo com o mesmo número;
 * - ocupada: outra chamada está transmitindo agora;
 * - verificar: saiu sem resposta, consulta na SEFAZ antes de qualquer coisa;
 * - devolver: já autorizada, só responde;
 * - usada: cancelada ou denegada, a referência não serve mais.
 */
export type Acao = 'nova' | 'gerar' | 'ocupada' | 'verificar' | 'devolver' | 'usada';

export function decidir(situacao: string | undefined, idadeS: number): Acao {
  switch (situacao) {
    case undefined:
      return 'nova';
    case 'rascunho':
    case 'assinada':
    case 'rejeitada':
      return 'gerar';
    case 'processando':
      return idadeS < PRAZO_PROCESSANDO_S ? 'ocupada' : 'verificar';
    case 'enviada':
      return 'verificar';
    case 'autorizada':
    // Em contingência o DANFE já saiu com esta chave: nunca gera de novo, a fila transmite
    case 'contingencia':
      return 'devolver';
    default:
      return 'usada';
  }
}

/** Situação da nota pelo cStat do protocolo ou da consulta pela chave */
export function situacaoPeloStatus(cStat: number): 'autorizada' | 'cancelada' | 'denegada' | 'rejeitada' {
  if (cStat === 100 || cStat === 150) return 'autorizada';
  if ([101, 151, 155].includes(cStat)) return 'cancelada';
  if ([110, 205, 301, 302, 303].includes(cStat)) return 'denegada';
  return 'rejeitada';
}

/** A referência do módulo de origem: até 80 caracteres, sem controle */
export function validarReferencia(valor: unknown): string {
  const ref = String(valor ?? '').trim();
  if (!ref || ref.length > 80 || /[\x00-\x1f]/.test(ref)) {
    throw new Error('Informe a referência da nota no módulo de origem (1 a 80 caracteres, ex.: PDV-000123).');
  }
  return ref;
}
