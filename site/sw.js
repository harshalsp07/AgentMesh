// site/sw.js — Offline Service Worker for AgentMesh
const CACHE_NAME = 'agentmesh-v1.2.1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/landing.html',
  '/docs.html',
  '/playground.html',
  '/blog.html',
  '/style.css',
  '/app.js',
  '/vendor.mjs',
  '/manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
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
  // Only handle GET requests and ignore SSE /events or dynamic API requests
  if (e.request.method !== 'GET' || e.request.url.includes('/events') || e.request.url.includes('/api/')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request).catch(() => caches.match('/index.html')))
  );
});
