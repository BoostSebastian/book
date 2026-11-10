// Enkel offline-cache: appens egna filer cachas, omslag cachas när de visas.
const CACHE = 'mina-bocker-v20';
const ASSETS = ['./', 'index.html', 'styles.css', 'config.js', 'vendor/supabase-2.118.0.js', 'vendor/jszip-3.10.1.min.js', 'vendor/epub-0.3.93.min.js', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Egna filer: nätverk först (så uppdateringar syns), cache som reserv offline.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
    return;
  }

  // Bokomslag: cache först. (CORS-hämtningar för bokryggsfärger går förbi cachen.)
  if (req.destination === 'image' && req.mode !== 'cors') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
  }
});
