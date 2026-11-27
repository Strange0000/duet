const CACHE_NAME = 'duet-shell-v1';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/hero-phones.jpg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API, Socket.IO, or third-party media streams
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      return new Response(
        '<!doctype html><html><body style="font-family:sans-serif;background:#09090b;color:#fff;padding:2rem;text-align:center"><h2>You are offline</h2><p>Duet requires an active internet connection for live synchronized playback.</p></body></html>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    })
  );
});
