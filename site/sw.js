// site/sw.js — Offline / fast-reload service worker for AgentMesh.
//
// Strategy (see docs/PERFORMANCE.md):
//   * The app shell (index.html, app.js, style.css) -> NETWORK FIRST with a
//     cache fallback. A board is a dev tool that ships often; serving a stale
//     app.js against a fresh index.html is worse than a 40 ms network round
//     trip. Offline still works: the cached shell is the fallback.
//   * Other static assets -> stale-while-revalidate: instant from cache,
//       refreshed in the background.
//   * /api/* and /events -> network only. A stale mesh view is worse than a
//     slow one, and the SSE stream must never be buffered.
//
// The cache name carries the app version. Bump it whenever app.js/style.css
// change so a stale shell can never be paired with a new bundle.

const VERSION = 'v1.3.0';
const CACHE_NAME = `agentmesh-${VERSION}`;

const SHELL = new Set(['/', '/index.html', '/app.js', '/style.css']);

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/landing.html',
  '/docs.html',
  '/playground.html',
  '/blog.html',
  '/style.css',
  '/app.js',
  '/board-tldraw.js',
  '/vendor.mjs',
  '/manifest.webmanifest',
  '/llms.txt',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // One missing asset must not fail the whole install.
      .then((cache) => Promise.allSettled(STATIC_ASSETS.map((a) => cache.add(a))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Live data is never cached: SSE must stream, API must be fresh.
  if (url.pathname.startsWith('/api/') || url.pathname === '/events' || url.pathname === '/state') return;

  // The shell is fetched fresh every time; the cache is only the offline net.
  if (SHELL.has(url.pathname) || req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(url.pathname === '/' ? '/index.html' : req).then((r) => r || Response.error()))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
