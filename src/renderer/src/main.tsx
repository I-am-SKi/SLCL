import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

// Apply the persisted palette before the first paint so switching to light mode
// never flashes a dark frame. `appearance.ts` mirrors the choice into
// localStorage (sync) while the authoritative value lives in settings.
try {
  const mode = localStorage.getItem('slcl-color-mode');
  if (mode === 'light') document.documentElement.setAttribute('data-mode', 'light');
} catch {
  /* localStorage unavailable — the dark default applies */
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
