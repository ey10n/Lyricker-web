// オフラインでも開けるよう、アプリのファイルを端末に保存しておく。
// つながっているときは常に最新を取りに行き（取れたら保存し直す）、
// つながらないときだけ保存しておいたものを使う。AI との通信（別のサイト）には関わらない。
//
// GitHub Pages は「10 分間はキャッシュしてよい」と返すので、そのままだと公開し直した直後に
// 古いファイルを掴んでしまう。取りに行くときは必ずサーバーに確かめる（no-cache / reload）。
//
// 公開し直すときは CACHE の番号と、js/app.js の APP_VERSION を同じ番号に上げる。

const CACHE = 'lyricker-v12';
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
  'js/secrets.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
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
    fetch(req, { cache: 'no-cache' })
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
