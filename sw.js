// Romaneios RLE – service worker
// 1) Abre rápido (guarda a tela no aparelho) e busca a versão nova quando há internet.
// 2) Faz o ENVIO DAS FOTOS em 2º plano (separado da tela): no Android continua/retoma
//    mesmo com o app minimizado ou fechado (Background Sync).
importScripts('fila.js');

const VERSAO = 'romaneios-rle-v3';
const ARQUIVOS = [
  './', './index.html', './fila.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)));
    await self.clients.claim();
    RLEFila.processar();   // retoma envios que ficaram pela metade
  })());
});

// ---------- envio em 2º plano ----------
RLEFila.aoMudar(async (item) => {
  const cs = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  cs.forEach((c) => c.postMessage({ tipo: 'item', item }));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.tipo === 'processar') e.waitUntil(RLEFila.processar());
});

// Android/Chrome: o sistema chama isto quando há internet, mesmo com o app fechado
self.addEventListener('sync', (e) => {
  if (e.tag === 'enviar-romaneios') {
    e.waitUntil(RLEFila.processar().then((terminou) => { if (!terminou) throw new Error('pendente'); }));
  }
});

// ---------- cache da tela ----------
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // envios/pesquisas vão direto ao servidor
  const url = new URL(req.url);
  if (url.hostname.endsWith('google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/fila.js')) {
    e.respondWith(
      fetch(req).then((r) => {
        const c = r.clone();
        caches.open(VERSAO).then((k) => k.put(req.mode === 'navigate' ? './index.html' : req, c));
        return r;
      }).catch(() => caches.match(req.mode === 'navigate' ? './index.html' : req))
    );
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then((resp) => {
    const c = resp.clone(); caches.open(VERSAO).then((k) => k.put(req, c)); return resp;
  })));
});
