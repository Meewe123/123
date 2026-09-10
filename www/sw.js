/**
 * Offline cache. The game is fully playable with no network — the service
 * worker precaches the shell on install and serves cache-first afterwards.
 * Bump CACHE when shipping a new build to retire the old files.
 */

const CACHE = 'orbital-rush-v1.0.0';

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'styles/main.css',
  'src/main.js',
  'src/engine/util.js',
  'src/engine/rng.js',
  'src/engine/audio.js',
  'src/engine/storage.js',
  'src/engine/haptics.js',
  'src/engine/fx.js',
  'src/engine/input.js',
  'src/engine/loop.js',
  'src/game/config.js',
  'src/game/world.js',
  'src/game/render.js',
  'src/game/meta.js',
  'src/game/autopilot.js',
  'src/ui/ui.js',
  'assets/icons/icon-180.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match('index.html'))),
  );
});
