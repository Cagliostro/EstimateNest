import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Room URLs (/ABC123) are ephemeral and must not be indexed; this also covers
// any unknown route (NotFound). Runs before the first render. Trailing slashes
// are normalized so /legal/ stays indexable (matches the sitemap entry).
const pathname = window.location.pathname.replace(/\/$/, '') || '/';
if (!['/', '/legal'].includes(pathname)) {
  const meta = document.createElement('meta');
  meta.name = 'robots';
  meta.content = 'noindex,nofollow';
  document.head.appendChild(meta);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <Toaster position="bottom-right" />
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>
);
