const CACHE_NAME = 'its-maps-cache-v1';
const OFFLINE_URLS = [
  '/',
  '/index.html',
  '/favicon.svg'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        try {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        } catch (e) {
          // ignore opaque responses and other failures
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
