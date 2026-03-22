// ============================================
// Claude Code Mobile Bridge — Service Worker
// Network-first strategy with app shell cache
// ============================================

const CACHE_NAME = 'claude-mobile-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json'
];

// ── Install: cache the app shell ────────────
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// ── Activate: clean up old caches ───────────
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function (name) {
            return name !== CACHE_NAME;
          })
          .map(function (name) {
            return caches.delete(name);
          })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ── Fetch: network-first, fallback to cache ─
self.addEventListener('fetch', function (event) {
  // Skip non-GET requests and WebSocket upgrades
  if (event.request.method !== 'GET') return;

  // Don't cache WebSocket or API requests
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/ws')) return;

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        // If we got a valid response, clone and cache it
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(function () {
        // Network failed — try cache
        return caches.match(event.request).then(function (cachedResponse) {
          if (cachedResponse) return cachedResponse;
          // If the request is for a page, return cached index.html
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          // Nothing in cache either
          return new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          });
        });
      })
  );
});
