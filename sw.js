const CACHE_NAME = 'affirmations-v1.2.2';

const SETTINGS_CACHE = 'affirmations-settings';
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

// Activate - clean old caches (keep SETTINGS_CACHE)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== SETTINGS_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  // Always fetch sw.js from network so update checks are never stale
  if (event.request.url.includes('sw.js')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((response) => {
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

// ===== Settings Cache Helpers =====
// SW cannot access localStorage — we use Cache Storage instead
async function getFromSettingsCache(key) {
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    const response = await cache.match('/_settings/' + key);
    if (!response) return null;
    return await response.json();
  } catch { return null; }
}

async function saveToSettingsCache(key, data) {
  try {
    const cache = await caches.open(SETTINGS_CACHE);
    await cache.put('/_settings/' + key, new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch {}
}

// ===== Periodic Background Sync =====
// Fires even when the app is fully closed (Chrome Android, installed PWA)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'affirmation-reminder') {
    event.waitUntil(checkAndNotifyFromBackground());
  }
});

async function checkAndNotifyFromBackground() {
  const settings = await getFromSettingsCache('reminder-settings');
  if (!settings) return;

  const now = new Date();
  const today = now.toDateString();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const sentKey = 'reminders-sent-' + today;
  const sent = (await getFromSettingsCache(sentKey)) || {};

  const periods = {
    morning: 'בוקר טוב!',
    noon: 'תזכורת צהריים',
    evening: 'ערב טוב!'
  };

  let updated = false;
  for (const [period, title] of Object.entries(periods)) {
    if (!settings[period]?.enabled) continue;
    if (sent[period]) continue; // already sent today

    const time = settings[period].time;
    if (!time) continue;

    const [h, m] = time.split(':').map(Number);
    const settingMinutes = h * 60 + m;

    // Send if current time is past the set time (not exact match — periodic sync fires at browser discretion)
    if (currentMinutes >= settingMinutes) {
      await showNotification(title);
      sent[period] = true;
      updated = true;
    }
  }

  if (updated) {
    await saveToSettingsCache(sentKey, sent);
  }
}

// ===== Messages from main app =====
self.addEventListener('message', (event) => {
  if (event.data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(showNotification(event.data.title));

  } else if (event.data.type === 'SAVE_SETTINGS') {
    // App saves settings → also mirror to Cache Storage so SW can read them
    event.waitUntil(saveToSettingsCache('reminder-settings', event.data.settings));

  } else if (event.data.type === 'MARK_SENT') {
    // Main app sent a notification → mark in Cache Storage to avoid SW duplicate
    const today = new Date().toDateString();
    event.waitUntil(
      getFromSettingsCache('reminders-sent-' + today).then(async (sent) => {
        const updated = { ...(sent || {}), [event.data.period]: true };
        await saveToSettingsCache('reminders-sent-' + today, updated);
      })
    );

  } else if (event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    );
  }
});

// ===== Show Notification =====
async function showNotification(title) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match('./data/affirmations.json');
    if (response) {
      const data = await response.json();
      const affirmations = data.affirmations;
      const random = affirmations[Math.floor(Math.random() * affirmations.length)];

      await self.registration.showNotification(title, {
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
    await self.registration.showNotification(title, {
      body: 'הכל מדויק לי',
      dir: 'rtl',
      lang: 'he'
    });
  }
}

// ===== Notification click - open app =====
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('./');
    })
  );
});
