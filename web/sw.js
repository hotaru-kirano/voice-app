// Offline support.
// - App files: network-first, so updates show up on the next reload; falls back
//   to the cache when offline.
// - The on-device speech library (versioned CDN URLs): cache-first.
// - Model weights are cached by the Moonshine library itself
//   ("moonshine-models-v1"); this worker never touches that cache.
// It also adds cross-origin isolation headers so the on-device model can use
// all CPU cores (SharedArrayBuffer), which GitHub Pages can't set itself.
const APP_CACHE = 'voice-drafts-v6';
const CDN_CACHE = 'voice-drafts-cdn-v2';
// Left behind by the earlier Transformers.js engine (~300 MB of model files).
const OBSOLETE = ['transformers-cache'];
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'local-stt.js',
  'stt-worker.js',
  'pcm-worklet.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => (k.startsWith('voice-') && k !== APP_CACHE && k !== CDN_CACHE) || OBSOLETE.includes(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isolate(res) {
  if (!res || res.type === 'opaque' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function appFile(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const copy = res.clone();
      caches.open(APP_CACHE).then((c) => c.put(req, copy));
    }
    return isolate(res);
  } catch (err) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return isolate(cached);
    throw err;
  }
}

async function cdnFile(req) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) event.respondWith(appFile(req));
  else if (url.hostname === 'cdn.jsdelivr.net') event.respondWith(cdnFile(req));
});
