// 311 VoiceCH: sąsaja atsidaro ir be interneto (tinklas pirmiau, atsarginė kopija telefone)
const CACHE = 'vc311-v2';
const CORE = ['/', '/qrcode.js', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (/^\/(ws|audio|apk|health|webver|version|fw|monoklis|\.well-known)/.test(u.pathname)) return;
  const key = e.request.mode === 'navigate' ? '/' : e.request; // pagrindinis puslapis saugomas be kvietimo parametrų
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
      return r;
    }).catch(() => caches.match(key).then(r => r || (e.request.mode === 'navigate' ? caches.match('/') : Response.error())))
  );
});
