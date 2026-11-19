import React, { useCallback, useEffect, useState } from 'react';
import { CertificadoInfo, Emitente, Meta, Painel, StatusBanco, Usuario } from './types';
import * as api from './services/api';
import { ThemeMode, applyTheme, getInitialTheme } from './utils/theme';
import { lerSessao, limparSessao, salvarSessao } from './utils/session';
import { limparConfigListas } from './utils/configListas';
import { MENU, Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { LoginView } from './components/LoginView';
import { Dashboard } from './components/Dashboard';
import { DocumentosView } from './components/DocumentosView';
import { ConsultasView } from './components/ConsultasView';
import { EventosView } from './components/EventosView';
import { InutilizacaoView } from './components/InutilizacaoView';
import { DistribuicaoView } from './components/DistribuicaoView';
import { ConfiguracoesView } from './components/ConfiguracoesView';
import { LogView } from './components/LogView';
import { TabelasView } from './components/TabelasView';
import { SeriesView } from './components/SeriesView';

const SUBTITULOS: Record<string, string> = {
  painel: 'Indicadores da emissão, certificado e últimas falhas',
  documentos: 'Geração, transmissão, DANFE e envio por e-mail',
  consultas: 'Status do serviço, chave de acesso, recibo e cadastro',
  eventos: 'Cancelamento, carta de correção e manifestação do destinatário',
  inutilizacao: 'Faixas de numeração que não serão utilizadas',
  distribuicao: 'Documentos emitidos contra o CNPJ, no Ambiente Nacional',
  series: 'Séries de emissão e o formato do DANFE de cada uma',
  tabelas: 'CFOP, NCM e municípios oficiais dos combos do ERP, baixados sob pedido',
  configuracoes: 'Certificado, webservices, emitente, arquivos, DANFE e e-mail',
  log: 'Histórico de comunicação com a SEFAZ',
};

/**
 * Link vindo do erp-vendas (botão "NFe"): #sso=<token de 5 min>&chave=<chave da nota>.
 * O token vira uma sessão normal e o hash sai da barra de endereço na hora.
 */
function lerLink() {
  const h = new URLSearchParams(window.location.hash.slice(1));
  const link = { sso: h.get('sso'), chave: h.get('chave') || undefined };
  if (link.sso || link.chave) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return link;
}

export default function App() {
  const [link] = useState(lerLink);
  // ---------------------------------------------------------------
  // Tema
  // ---------------------------------------------------------------
  const [tema, setTema] = useState<ThemeMode>(() => getInitialTheme());
  useEffect(() => { applyTheme(tema); }, [tema]);
  const alternarTema = useCallback(() => setTema((t) => (t === 'dark' ? 'light' : 'dark')), []);

  // ---------------------------------------------------------------
  // Sessão
  // ---------------------------------------------------------------
  const [sessaoSalva] = useState(() => {
    const salva = lerSessao();
    // O token precisa estar no cliente HTTP antes das primeiras chamadas do painel
    api.definirToken(salva.token);
    return salva;
  });
  const [usuario, setUsuario] = useState<Usuario | null>(sessaoSalva.usuario);
  const [emitente, setEmitente] = useState<Emitente | null>(sessaoSalva.empresa);
  /** Motivo mostrado na tela de login quando a sessão expira ou é revogada */
  const [avisoLogin, setAvisoLogin] = useState<string | null>(null);
  const [entrandoPorLink, setEntrandoPorLink] = useState(!!link.sso);

  // ---------------------------------------------------------------
  // Estado geral
  // ---------------------------------------------------------------
  const [abaAtiva, setAbaAtiva] = useState(link.chave ? 'documentos' : 'painel');
  const [menuMobile, setMenuMobile] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [painel, setPainel] = useState<Painel | null>(null);
  const [statusBanco, setStatusBanco] = useState<StatusBanco | null>(null);
  const [certificado, setCertificado] = useState<CertificadoInfo | null>(null);
  const [ambiente, setAmbiente] = useState(2);

  const recarregar = useCallback(async () => {
    if (!emitente) return;

    api.buscarStatusBanco().then(setStatusBanco).catch(() => setStatusBanco(null));
    api.buscarMeta().then(setMeta).catch(() => setMeta(null));
    api.buscarPainel().then(setPainel).catch(() => setPainel(null));

    try {
      const dados = await api.buscarConfig();
      setCertificado(dados.certificado);
      setAmbiente(dados.config.webservice.ambiente);
      setEmitente((atual) => (atual ? { ...atual, ...dados.emitente } : atual));
    } catch {
      // Banco sem as tabelas ou sessão inválida: o painel mostra o aviso
    }
  }, [emitente?.id]);

  useEffect(() => { recarregar(); }, [recarregar]);

  const sair = useCallback(() => {
    setUsuario(null);
    setEmitente(null);
    setPainel(null);
    setMeta(null);
    setCertificado(null);
    setAbaAtiva('painel');
    api.definirToken(null);
    // As preferências das grades são do usuário que saiu
    limparConfigListas();
    limparSessao();
  }, []);

  // Token vencido (12 h) ou acesso revogado: o servidor responde 401 e volta ao login
  useEffect(() => {
    api.aoExpirarSessao((mensagem) => {
      sair();
      setAvisoLogin(mensagem);
    });
  }, [sair]);

  // Entrada pelo link do erp-vendas: troca o token curto por uma sessão (fica só nesta aba)
  useEffect(() => {
    if (!link.sso) return;
    api.definirToken(link.sso);
    api.renovarSessao()
      .then((r) => {
        api.definirToken(r.token);
        limparConfigListas();
        salvarSessao(r.usuario, r.empresa, r.token, false);
        setUsuario(r.usuario);
        setEmitente(r.empresa);
      })
      .catch((e) => {
        // Link vencido ou usuário sem acesso: segue a sessão salva, se houver
        api.definirToken(sessaoSalva.token);
        setAvisoLogin(e.message);
      })
      .finally(() => setEntrandoPorLink(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (entrandoPorLink) {
    return <div className="h-screen flex items-center justify-center text-sm text-stone-500 bg-stone-100/70 dark:bg-stone-950">Entrando…</div>;
  }

  if (!usuario || !emitente) {
    return (
      <LoginView
        tema={tema}
        onAlternarTema={alternarTema}
        avisoInicial={avisoLogin}
        onEntrou={(novoUsuario, novaEmpresa, token, lembrar) => {
          api.definirToken(token);
          setUsuario(novoUsuario);
          setEmitente(novaEmpresa);
          salvarSessao(novoUsuario, novaEmpresa, token, lembrar);
          setAvisoLogin(null);
          setAbaAtiva('painel');
        }}
      />
    );
  }

  const item = MENU.find((m) => m.id === abaAtiva);
  const contagens: Record<string, number> = {
    documentos: painel?.contagens?.documentos ?? 0,
    eventos: painel?.contagens?.eventos ?? 0,
    inutilizacao: painel?.contagens?.inutilizacoes ?? 0,
    distribuicao: painel?.contagens?.distribuidos ?? 0,
  };

  return (
    <div className="h-screen overflow-hidden bg-stone-100/70 dark:bg-stone-950 text-stone-900 dark:text-stone-100
      flex font-sans antialiased selection:bg-blue-600 selection:text-white">
      <Sidebar
        abaAtiva={abaAtiva}
        onTrocarAba={setAbaAtiva}
        contagens={contagens}
        usuario={usuario}
        razaoSocial={emitente.nome_fantasia || emitente.razao_social}
        onSair={sair}
        abertaNoMobile={menuMobile}
        onFecharMobile={() => setMenuMobile(false)}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Header
          titulo={item?.rotulo || 'BMNFe'}
          subtitulo={SUBTITULOS[abaAtiva]}
          emitente={emitente}
          certificado={certificado}
          statusBanco={statusBanco}
          ambiente={ambiente}
          tema={tema}
          onAlternarTema={alternarTema}
          onAtualizar={recarregar}
          onAbrirMenuMobile={() => setMenuMobile(true)}
        />

        {abaAtiva === 'painel' ? (
          // O painel é o único com margem e cartões
          <main className="flex-1 overflow-y-auto min-h-0">
            <div className="px-4 sm:px-6 py-5">
              <Dashboard painel={painel} statusBanco={statusBanco} onNavegar={setAbaAtiva} />
            </div>
          </main>
        ) : (
          // As demais telas seguem o b2b admin: ocupam toda a área útil, chapadas, sem margem
          <main className="flex-1 flex flex-col overflow-y-auto min-h-0 bg-white dark:bg-stone-900">
            {abaAtiva === 'documentos' && (
              <DocumentosView meta={meta} emitente={emitente} onRecarregarPainel={recarregar} chaveInicial={link.chave} />
            )}
            {abaAtiva === 'consultas' && (
              <ConsultasView meta={meta} ufPadrao={emitente.uf || 'SP'} />
            )}
            {abaAtiva === 'eventos' && <EventosView meta={meta} />}
            {abaAtiva === 'inutilizacao' && (
              <InutilizacaoView meta={meta} modeloPadrao={painel?.modelo || '55'} />
            )}
            {abaAtiva === 'distribuicao' && <DistribuicaoView meta={meta} />}
            {abaAtiva === 'series' && <SeriesView />}
            {abaAtiva === 'tabelas' && <TabelasView />}
            {abaAtiva === 'configuracoes' && <ConfiguracoesView meta={meta} onSalvou={recarregar} />}
            {abaAtiva === 'log' && <LogView />}
          </main>
        )}
      </div>
    </div>
  );
}
