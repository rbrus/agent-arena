import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (SIL OFL): bundled into dist, never fetched from a CDN.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './styles/app.css';
import { App } from './inspector/App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
