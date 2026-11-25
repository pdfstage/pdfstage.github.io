const CACHE_NAME = 'pdfstage-v2';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './cast/',
  './cast/index.html',
  './cast/cast.js',
  './cast/ppsx-reader.js',
  './cast/ogg-opus.js',
  './cast/pdf-attach.js',
  './cast/zip-store.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        const live = await fetch(req, { cache: 'no-cache' });
        if (live && live.ok) {
          cache.put(req, live.clone());
        }
        return live;
      } catch {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (url.pathname.includes('/cast')) {
          return (await cache.match('./cast/index.html')) || (await cache.match('./index.html'));
        }
        return await cache.match('./index.html');
      }
    })
  );
});
