// Duet service worker.
// N-35: navigation requests are network-first so a stale cached index.html
// is never served when the network is up (a stale shell produced a blank
// page). Same-origin JS/CSS assets use runtime caching: successful GET
// responses are cached and served cache-first.
const CACHE_NAME = 'duet-shell-v3';
const RUNTIME_CACHE = 'duet-runtime-v2';
const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/duet-icon.svg', '/hero-phones.jpg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => /^duet-(shell|runtime)-/.test(k) && k !== CACHE_NAME && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
        )
      )
  );
  self.clients.claim();
});

function offlinePage() {
  return new Response(
    '<!doctype html><html><body style="font-family:sans-serif;background:#09090b;color:#fff;padding:2rem;text-align:center"><h2>You are offline</h2><p>Duet requires an active internet connection for live synchronized playback.</p></body></html>',
    { headers: { 'Content-Type': 'text/html' } }
  );
}

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

  // Navigation: network-first — never serve a stale index.html while online.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => (await caches.match(event.request)) || offlinePage())
    );
    return;
  }

  // Same-origin JS/CSS: runtime cache, served cache-first.
  const isAsset =
    event.request.destination === 'script' ||
    event.request.destination === 'style' ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css');
  if (isAsset) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          if (res.ok && !res.headers.get('content-type')?.includes('text/html')) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // Other same-origin GETs (images, manifest, etc.): network-first, cache fallback.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
