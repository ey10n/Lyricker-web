// オフラインでも開けるよう、アプリのファイルを端末に保存しておく。
// つながっているときは常に最新を取りに行き（取れたら保存し直す）、
// つながらないときだけ保存しておいたものを使う。AI との通信（別のサイト）には関わらない。

const CACHE = 'lyricker-v3';
const ASSETS = [
  './',
  'index.html',
  'app.css',
  'js/app.js',
  'js/diff.js',
  'js/store.js',
  'js/ai.js',
  'js/gemini.js',
  'js/prompts.js',
  'js/cloud.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) ||
        (req.mode === 'navigate' ? caches.match('index.html') : Response.error())),
  );
});
