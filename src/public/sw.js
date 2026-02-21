const CACHE = 'creator-engine-v1';
const ASSETS = ['/app', '/manifest.webmanifest', '/assets/icon-192.svg', '/assets/icon-512.svg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request).catch(() => caches.match('/app'))));
});
