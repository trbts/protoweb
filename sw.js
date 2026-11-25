// ProtoWeb · service worker (PWA)
// - Guarda só os arquivos do próprio app (HTML, CSS, JS, ícones) para abrir rápido e instalar.
// - NÃO guarda API, login (Firebase Auth), protocolos nem anexos: esses dados são sensíveis e sempre vêm da rede.
// - Os arquivos são buscados na rede primeiro: ao publicar uma atualização do site, ela chega sozinha.
//   Só mude VERSION se alterar a lista PRECACHE ou quiser forçar a limpeza do cache antigo.
const VERSION = "v1";
const SHELL = "protoweb-shell-" + VERSION;
const RUNTIME = "protoweb-ext-" + VERSION;

const PRECACHE = [
  "./", "index.html", "css/style.css", "js/app.js", "js/config.js",
  "pwa.js", "manifest.webmanifest", "protoweb.svg", "protoweb-horizontal.svg", "protoweb.ico",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];

// Únicos endereços de outros domínios que podem ficar em cache (arquivos estáticos e versionados).
const EXT_STATIC = ["www.gstatic.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // tolerante: se um arquivo falhar, a instalação não é cancelada
    await Promise.allSettled(PRECACHE.map((u) => c.add(new Request(u, { cache: "reload" }))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL, RUNTIME];
    for (const k of await caches.keys()) if (k.startsWith("protoweb-") && !keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => { if (e.data === "SKIP_WAITING") self.skipWaiting(); });

// Rede primeiro (sempre a versão mais nova), cache como reserva se estiver sem internet.
async function networkFirst(req, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) || (fallbackKey && (await cache.match(fallbackKey)));
    if (hit) return hit;
    throw err;
  }
}

// Cache primeiro, atualiza em segundo plano (fontes e bibliotecas versionadas).
async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // POST/PUT/DELETE da API passam direto
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // páginas: rede primeiro; sem internet, abre o app já salvo
    if (req.mode === "navigate") return e.respondWith(networkFirst(req, SHELL, "index.html").catch(() => caches.match("index.html")));
    return e.respondWith(networkFirst(req, SHELL));
  }
  if (EXT_STATIC.includes(url.hostname)) return e.respondWith(staleWhileRevalidate(req));
  // todo o resto (API do Worker, Firebase Auth/Identity, anexos) não é interceptado nem guardado
});
