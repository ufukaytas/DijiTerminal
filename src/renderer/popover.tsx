// Menü çubuğu açılır listesinin giriş noktası (06/01). Ana pencereden ayrı, three.js'siz küçük bir React ağacı.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/detail.css';
import './styles/popover.css';
import { PopoverApp } from './popover/PopoverApp';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <PopoverApp />
    </StrictMode>,
  );
}
