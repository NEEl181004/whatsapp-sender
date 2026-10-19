// Service Worker for WhatsApp Direct Sender PWA
const CACHE_NAME = 'wa-dispatcher-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  // Let network handle dynamic API and socket requests directly
  if (e.request.url.includes('/api/') || e.request.url.includes('/socket.io/')) {
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
