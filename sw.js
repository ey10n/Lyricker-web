// オフラインでも開けるよう、アプリのファイルを端末に保存しておく。
// つながっているときは常に最新を取りに行き（取れたら保存し直す）、
// つながらないときだけ保存しておいたものを使う。AI との通信（別のサイト）には関わらない。
//
// GitHub Pages は「10 分間はキャッシュしてよい」と返すので、そのままだと公開し直した直後に
// 古いファイルを掴んでしまう。取りに行くときは必ずサーバーに確かめる（no-cache / reload）。
//
// 公開し直すときは CACHE の番号と、js/app.js の APP_VERSION を同じ番号に上げる。

const CACHE = 'lyricker-v27';
// 読みの辞書（vendor/ の下、十数 MB）は版を上げても取り直さないよう、別の入れ物に置いて保存したものを先に使う。
// vendor/ の中身を差し替えたときは、この番号を上げる
const VENDOR_CACHE = 'lyricker-vendor-1';
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
  'js/player.js',
  'js/mora.js',
  'js/mora-worker.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== VENDOR_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(VENDOR_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
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
