// sw.js — Shift Scheduler Service Worker
// Caches the app shell so it loads instantly and works offline.
// When a new version is deployed, the cache is refreshed automatically.

const CACHE_NAME = 'shift-scheduler-v0.93';

// Files to cache for offline use — the app shell
const CACHE_FILES = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;700;800&display=swap',
];

// ── Install: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_FILES).catch(err => {
        // Font CDN may fail in some environments — non-fatal
        console.warn('[SW] Some files could not be cached:', err);
      });
    })
  );
  // Activate immediately — don't wait for old tabs to close
  self.skipWaiting();
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: network first, cache fallback ─────────────────────────────────────
// Strategy:
//   API calls (JSONBin, WebEx, Google Fonts) — network only, never cache
//   App shell (index.html, manifest) — network first, fall back to cache
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache API calls — always go to network
  if(
    url.hostname.includes('jsonbin.io') ||
    url.hostname.includes('webexapis.com') ||
    url.hostname.includes('workers.dev')
  ){
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell — network first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses for the app shell
        if(response.ok && event.request.method === 'GET'){
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — serve from cache
        return caches.match(event.request).then(cached => {
          if(cached) return cached;
          // If nothing cached, return a simple offline page
          return new Response(
            '<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0d0f14;color:#fff">' +
            '<h2>📵 Offline</h2><p>Connect to the internet to use Shift Scheduler.</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        });
      })
  );
});
