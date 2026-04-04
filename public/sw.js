/// <reference lib="webworker" />
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = 'elegoo-web-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  sw.clients.claim();
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only cache GET requests for same-origin
  if (request.method !== 'GET') return;

  // Skip MQTT WebSocket and camera streams
  if (request.url.includes(':9001') || request.url.includes(':8080')) return;

  event.respondWith(
    caches.match(request).then(cached => {
      // Network-first for HTML, cache-first for assets
      if (request.destination === 'document') {
        return fetch(request)
          .then(response => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
            return response;
          })
          .catch(() => cached ?? new Response('Offline', { status: 503 }));
      }

      // Cache-first for JS/CSS
      if (cached) return cached;
      return fetch(request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      });
    })
  );
});
