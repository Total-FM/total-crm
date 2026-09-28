// يخزّن واجهة التطبيق ليفتح بسرعة. بيانات العملاء لا تُخزَّن هنا؛ تأتي دائماً من الخادم.
const CACHE = "total-crm-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest",
  "vendor/supabase.js", "icons/logo.png", "icons/icon-192.png", "icons/icon-512.png",
  "vendor/tajawal-arabic-400-normal.woff2", "vendor/tajawal-arabic-700-normal.woff2", "vendor/tajawal-arabic-800-normal.woff2"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // طلبات Supabase تمر مباشرة
  // الشبكة أولاً ثم النسخة المخزنة، حتى يصل كل تحديث فوراً
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
