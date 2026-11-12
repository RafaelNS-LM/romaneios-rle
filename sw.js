// Romaneios RLE – service worker
// Abre rápido (guarda a tela no aparelho) e sempre busca a versão nova quando há internet.
const VERSAO = 'romaneios-rle-v2';
const ARQUIVOS = [
  './', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // envios/pesquisas vão direto ao servidor
  const url = new URL(req.url);
  if (url.hostname.endsWith('google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  // Tela: rede primeiro (pega atualização), cache se estiver sem internet
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(req).then((r) => { const c = r.clone(); caches.open(VERSAO).then((k) => k.put('./index.html', c)); return r; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  // Ícones e biblioteca de PDF: cache primeiro
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then((resp) => {
    const c = resp.clone(); caches.open(VERSAO).then((k) => k.put(req, c)); return resp;
  })));
});
