// Guarda a "casca" do app para abrir rápido e mesmo com internet ruim.
// Os dados (Supabase) nunca passam pelo cache.
const CACHE = "moneycau-v9";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Rede primeiro (para pegar atualizações), cache se estiver sem internet.
self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== "GET" || url.hostname.endsWith("supabase.co")) return;
  ev.respondWith(
    fetch(ev.request, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(ev.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(ev.request))
  );
});
