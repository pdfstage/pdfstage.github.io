const APP_VERSION = '0.8.4';
const CACHE_NAME = `pdfstage-v${APP_VERSION}`;
const SHELL_ASSETS = [
  './',
  './index.html',
  './pwa.js',
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

function isCastPath(pathname) {
  return /\/cast(?:\/|$)/.test(pathname || '');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Bypass HTTP max-age=600 (GitHub Pages) when populating a new version's precache.
    await Promise.all(SHELL_ASSETS.map(async (assetUrl) => {
      const req = new Request(assetUrl, { cache: 'reload' });
      const res = await fetch(req);
      if (!res || !res.ok) {
        throw new Error(`Precache fehlgeschlagen für ${assetUrl} (${res ? res.status : 'network'})`);
      }
      await cache.put(assetUrl, res);
    }));
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept the Service Worker script itself so update checks always reach the network.
  if (url.pathname.endsWith('/sw.js')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    if (req.mode === 'navigate' && /\/cast\/?$/.test(url.pathname)) {
      const castShell = (await cache.match('./cast/index.html')) || (await cache.match('./cast/'));
      if (castShell) return castShell;
    }

    try {
      const live = await fetch(req);
      if (live && live.ok && live.type === 'basic') {
        cache.put(req, live.clone()).catch(() => {});
      }
      return live;
    } catch {
      if (req.mode === 'navigate') {
        if (isCastPath(url.pathname)) {
          return (await cache.match('./cast/index.html')) || (await cache.match('./cast/')) || Response.error();
        }
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
      return Response.error();
    }
  })());
});
