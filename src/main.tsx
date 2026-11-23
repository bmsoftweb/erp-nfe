import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { instalarSelecaoAoFocar } from './utils/selecaoAoFocar';
import { Dica } from './components/Dica';

instalarSelecaoAoFocar();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Dica />
    {/* Consultas, eventos e DANFE do PAF-NFC-e sem o Menu Fiscal (Requisito VI, § 1º, II) */}
    <p className="fixed bottom-1 right-2 z-[999] text-[10px] font-black tracking-widest text-stone-400 pointer-events-none">MENU FISCAL INACESSÍVEL NESTA TELA</p>
  </StrictMode>,
);
