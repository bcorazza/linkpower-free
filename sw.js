// App-shell cache so the tool still opens with no network. Network-first, so
// a new deployment is picked up immediately instead of serving a stale shell.
const CACHE = 'linkpower-free-v2';
const ASSETS = ['./', './index.html', './app.js', './manifest.webmanifest',
                './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // This worker's scope covers everything under the repo root, but /starlink/ is
  // a DIFFERENT app. Leave it alone — otherwise the offline fallback below could
  // serve the LinkPower page in place of the Starlink app.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/starlink/')) return;

  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => {
      // Only fall back to the app shell for an actual navigation, never for
      // a sub-resource request (that would swap one app's HTML for another's).
      if (hit) return hit;
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    }))
  );
});
