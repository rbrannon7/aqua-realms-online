const CACHE = 'aqua-realms-__DEPLOY_VERSION__';
const PRECACHE = ['/', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Let WebSocket and non-GET requests pass through
  if (request.method !== 'GET' || url.protocol === 'ws:' || url.protocol === 'wss:') return;

  // Network-first for HTML navigation so updates deploy immediately
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(() => caches.match('/'))
    );
    return;
  }

  // Cache-first for images and audio — card art never changes between deploys
  if (/\.(jpg|jpeg|png|gif|webp|mp3|ogg|woff2?)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Default: network with cache fallback
  e.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});
