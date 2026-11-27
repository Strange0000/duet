import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

/* N-08: ErrorBoundary — a render exception shows a friendly screen with a
   Reload button instead of a white screen. */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Duet render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-950 px-5 text-center text-white">
          <h1 className="font-display text-2xl font-bold">Something went wrong</h1>
          <p className="max-w-sm text-sm text-zinc-400">
            Duet hit an unexpected error. Your room may still be active — reloading
            will take you back to the start.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-full bg-white px-6 py-2.5 text-sm font-bold text-zinc-950"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
// Self-hosted fonts (F-15): no Google Fonts request at runtime.
// Manrope (body) 400–700, Bricolage Grotesque (display) 500–800.
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/bricolage-grotesque/500.css';
import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
import './index.css';

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
