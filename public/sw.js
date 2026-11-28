// Minimal service worker for PWA installability
const CACHE_NAME = 'elegoo-web-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

/**
 * Requests the worker must leave to the browser. The camera (`/api/stream`, `/webcam`)
 * is an endless multipart/x-mixed-replace MJPEG response: re-served through this worker,
 * iOS Safari received one or two frames, dropped the connection and showed the <img> as
 * broken, while the same page without the worker streamed for hours. The rest of `/api/`
 * is live printer data with no offline copy worth serving, and `/ws` and non-GET requests
 * gain nothing from a detour either.
 */
function isLive(request) {
  if (request.method !== 'GET') return true;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return true;
  const path = url.pathname;
  return path.startsWith('/api/') || path.startsWith('/webcam') || path === '/ws';
}

self.addEventListener('fetch', (event) => {
  if (isLive(event.request)) return;
  // Network-first strategy — always prefer live data from printer
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
