// 繧ｪ繝輔Λ繧､繝ｳ縺ｧ繧る幕縺代ｋ繧医≧縲√い繝励Μ縺ｮ繝輔ぃ繧､繝ｫ繧堤ｫｯ譛ｫ縺ｫ菫晏ｭ倥＠縺ｦ縺翫￥縲・// 縺､縺ｪ縺後▲縺ｦ縺・ｋ縺ｨ縺阪・蟶ｸ縺ｫ譛譁ｰ繧貞叙繧翫↓陦後″・亥叙繧後◆繧我ｿ晏ｭ倥＠逶ｴ縺呻ｼ峨・// 縺､縺ｪ縺後ｉ縺ｪ縺・→縺阪□縺台ｿ晏ｭ倥＠縺ｦ縺翫＞縺溘ｂ縺ｮ繧剃ｽｿ縺・・I 縺ｨ縺ｮ騾壻ｿ｡・亥挨縺ｮ繧ｵ繧､繝茨ｼ峨↓縺ｯ髢｢繧上ｉ縺ｪ縺・・
const CACHE = 'lyricker-v7';
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
