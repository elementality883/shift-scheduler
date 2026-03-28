// sw.js — Shift Scheduler Service Worker v0.99
// Caches the app shell for fast loads and offline fallback.
// Auto-updates: when a new version deploys, the new worker activates
// immediately and all open tabs reload automatically.

const CACHE_NAME = 'shift-scheduler-v1.0';

const CACHE_FILES = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;700;800&display=swap',
];

// ── Install ───────────────────────────────────────────────────────────────────
// Cache the app shell. skipWaiting() so the new SW activates immediately
// rather than waiting for all old tabs to close.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(CACHE_FILES).catch(err =>
        console.warn('[SW] Some files could not be cached:', err)
      )
    )
  );
  self.skipWaiting();
});

// ── Activate ──────────────────────────────────────────────────────────────────
// Delete old caches, claim all open clients, then send each tab a reload
// message so users automatically get the new version without a manual refresh.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll({ type: 'window' }).then(clients =>
          clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }))
        )
      )
  );
});

// ── Message handler ───────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — always network, never cached
  if(
    url.hostname.includes('jsonbin.io')   ||
    url.hostname.includes('webexapis.com')||
    url.hostname.includes('workers.dev')  ||
    url.hostname.includes('fonts.gstatic.com')
  ){
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell — network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if(response.ok && event.request.method === 'GET'){
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then(cached => {
          if(cached) return cached;
          return new Response(
            '<html><body style="font-family:sans-serif;text-align:center;padding:60px;' +
            'background:#0d0f14;color:#fff"><h2>📵 No connection</h2>' +
            '<p>Reconnect to the internet to use Shift Scheduler.</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        })
      )
  );
});
