/* nue service worker: keeps the app shell available offline.
   News and prices are not cached here. The app keeps its own copy of the latest stories. */
var VERSION = 'nue-v3';
var SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'indicators.js',
  'viz.js',
  'ui.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/favicon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== VERSION && k !== 'nue-fonts'; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

function staleWhileRevalidate(cacheName, request) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (hit) {
      var fresh = fetch(request).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || fresh;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Web fonts: keep them so the app looks right offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(staleWhileRevalidate('nue-fonts', req));
    return;
  }

  // Only handle this site's own files. The relay and everything else go straight to the network.
  if (url.origin !== self.location.origin) return;

  // Opening the app: try the network, fall back to the saved page when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put('index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('index.html').then(function (hit) { return hit || caches.match('./'); });
      })
    );
    return;
  }

  e.respondWith(
    caches.open(VERSION).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        var fresh = fetch(req).then(function (res) {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || fresh;
      });
    })
  );
});
