self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  // Apenas repassa a requisição para a internet (modo online obrigatório)
  e.respondWith(fetch(e.request));
});
