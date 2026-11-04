import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/detail.css';
import './styles/log.css';
import './styles/map2d.css';
import './styles/map.css';
import './styles/settings.css';
import './styles/terminal.css';
import { App } from './App';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
