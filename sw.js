// Service Worker — 수집 툴 PWA
// 네트워크 우선 전략: API 응답은 항상 최신, UI 셸만 캐시

const CACHE = 'collector-v1';
const SHELL = ['/', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API 요청은 항상 네트워크 — 캐시 금지
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cafe') || url.pathname.startsWith('/relay')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // UI 셸 — 캐시 우선, 실패 시 네트워크
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
    if (res.ok && e.request.method === 'GET') {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
    }
    return res;
  })));
});
