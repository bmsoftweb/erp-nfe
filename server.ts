import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createApp } from './server/app.js';
import { transmitirContingenciaDeTodas } from './server/rotas/emitir.js';

/** Entrada para execução local. Na Vercel quem serve as rotas é api/index.ts. */
const PORT = Number(process.env.PORT) || 3000;

async function iniciar() {
  const app = createApp();

  // =========================================================================
  // VITE / SPA
  // =========================================================================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  // Servidor contínuo: transmite sozinho as NFC-e em contingência a cada minuto (Requisito III, II do
  // PAF-NFC-e). Na Vercel quem chama é o cron de /api/cron/contingencia, a cada 15 min (vercel.json), para não
  // gastar invocação; o caixa aberto transmite a cada minuto e a fila também vai antes de cada emissão
  setInterval(() => transmitirContingenciaDeTodas().catch((err) => console.error('Contingência:', err)), 60_000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BMNFe rodando em http://0.0.0.0:${PORT}`);
    console.log(`MySQL: ${process.env.MYSQL_HOST || 'localhost'} / ${process.env.MYSQL_DATABASE || 'bmnfe'}`);
  });
}

iniciar().catch((err) => {
  console.error('Falha ao iniciar o BMNFe:', err);
  process.exit(1);
});
