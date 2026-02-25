const CACHE_NAME = 'affirmations-v1.0.4';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './data/affirmations.json'
];

// Install - cache assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
        // Cache new requests dynamically
        if (response.status === 200 && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      if (event.request.destination === 'document') {
        return caches.match('./index.html');
      }
    })
  );
});

// Handle messages from main app
self.addEventListener('message', (event) => {
  if (event.data.type === 'SHOW_NOTIFICATION') {
    showNotification(event.data.title);
  }
});

// Show notification with random affirmation
async function showNotification(title) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match('./data/affirmations.json');
    if (response) {
      const data = await response.json();
      const affirmations = data.affirmations;
      const random = affirmations[Math.floor(Math.random() * affirmations.length)];

      self.registration.showNotification(title, {
        body: random.text,
        icon: './assets/icon-192.png',
        badge: './assets/icon-192.png',
        dir: 'rtl',
        lang: 'he',
        tag: 'affirmation-' + title,
        renotify: true
      });
    }
  } catch (e) {
    self.registration.showNotification(title, {
      body: 'הכל מדויק לי',
      dir: 'rtl',
      lang: 'he'
    });
  }
}

// Handle notification click - open app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) {
        return clients[0].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
