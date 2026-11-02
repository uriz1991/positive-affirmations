importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
importScripts('shared/notification-select.js');

firebase.initializeApp({
  apiKey: 'AIzaSyC0AFO8gOk1VizEGnuQBBaoEX6ddH-qyek',
  authDomain: 'positive-affirmations-9f382.firebaseapp.com',
  projectId: 'positive-affirmations-9f382',
  storageBucket: 'positive-affirmations-9f382.firebasestorage.app',
  messagingSenderId: '388138822180',
  appId: '1:388138822180:web:98e5d4297847947ffc06b1'
});

const messaging = firebase.messaging();

// Fires when a push arrives while the app is fully closed / backgrounded
messaging.onBackgroundMessage((payload) => {
  // A message that already has a notification field is shown by the browser.
  // Calling showNotification here as well is the duplicate.
  if (payload.notification) return;
  const title = payload.data?.title || 'אמירות חיוביות';
  const body = payload.data?.body || '';
  if (!body) return;
  const lang = payload.data?.lang === 'en' || payload.data?.lang === 'fr' || payload.data?.lang === 'es'
    ? payload.data.lang
    : 'he';
  self.registration.showNotification(title, {
    body,
    icon: './assets/icon-192.png',
    badge: './assets/icon-192.png',
    dir: lang === 'he' ? 'rtl' : 'ltr',
    lang,
    tag: payload.data?.tag || 'affirmation'
  });
});

const CACHE_NAME = 'affirmations-v1.2.54';

const SETTINGS_CACHE = 'affirmations-settings';
const ASSETS = [
  './',
  './index.html',
  './privacy.html',
  './delete-account.html',
  './shared/play-build.js',
  './style.css',
  './app.js',
  './init-lang.js',
  './firebase-init.js',
  './manifest.json',
  './data/affirmations.json',
  './data/affirmations-en.json',
  './data/affirmations-fr.json',
  './data/affirmations-es.json',
  './locales/he.json',
  './locales/en.json',
  './locales/fr.json',
  './locales/es.json',
  './shared/notification-select.js',
  './data/notification-pool.json',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

// Install - cache assets. Each file is cached independently so one 404
// doesn't abort the whole install (cache.addAll fails atomically).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {})))
    )
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

async function loadNotificationPool() {
  const lang = await getFromSettingsCache('app-lang');
  if (lang && lang !== 'he') {
    const localized = await getFromSettingsCache('notification-pool');
    return Array.isArray(localized) ? localized : [];
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match('./data/notification-pool.json');
    if (!response) return [];
    const data = await response.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

async function checkAndNotifyFromBackground() {
  // Push is already delivered by Cloud Functions when a token is registered.
  if (await getFromSettingsCache('fcm-active')) return;

  const reminders = await getFromSettingsCache('reminders-list');
  if (!Array.isArray(reminders) || !reminders.length) return;
  if (!self.NotificationSelect) return;
  const pool = await loadNotificationPool();
  if (!pool.length) return;

  const now = new Date();
  const today = now.toDateString();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const addressForm = (await getFromSettingsCache('address-form')) === 'f' ? 'f' : 'm';
  let history = await getFromSettingsCache('notification-recent-ids');
  if (!Array.isArray(history)) history = [];

  const sentKey = 'reminders-sent-' + today;
  const sent = (await getFromSettingsCache(sentKey)) || {};

  let updated = false;
  for (const r of reminders) {
    if (!r.enabled) continue;
    if (sent[r.id]) continue; // already sent today
    if (!r.time) continue;

    const [h, m] = r.time.split(':').map(Number);
    const settingMinutes = h * 60 + m;
    const diff = currentMinutes - settingMinutes;

    // Fire only within a grace window after the set time (periodic sync runs
    // at browser discretion, not on the minute) — never for times long past,
    // or every overdue reminder bursts out together in one sync.
    if (diff >= 0 && diff <= 30) {
      const picked = self.NotificationSelect.pickFromPool({
        pool,
        slot: self.NotificationSelect.slotForReminder(r),
        history,
        addressForm
      });
      if (!picked) continue;
      history = picked.history;
      await showNotification(r.label, picked.text, 'reminder-' + r.id + '-' + today);
      sent[r.id] = true;
      updated = true;
    }
  }

  if (updated) {
    await saveToSettingsCache(sentKey, sent);
    await saveToSettingsCache('notification-recent-ids', history);
  }
}

// ===== Messages from main app =====
self.addEventListener('message', (event) => {
  if (event.data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(showNotification(event.data.title, event.data.body, event.data.tag));

  } else if (event.data.type === 'SAVE_SETTINGS') {
    // App saves settings → also mirror to Cache Storage so SW can read them
    event.waitUntil(Promise.all([
      saveToSettingsCache('reminders-list', event.data.reminders),
      saveToSettingsCache('fcm-active', !!event.data.fcmActive),
      saveToSettingsCache('address-form', event.data.addressForm === 'f' ? 'f' : 'm'),
      saveToSettingsCache('app-lang', event.data.lang === 'en' || event.data.lang === 'fr' || event.data.lang === 'es' ? event.data.lang : 'he'),
      saveToSettingsCache('notification-pool', Array.isArray(event.data.notificationPool) ? event.data.notificationPool : [])
    ]));

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
async function showNotification(title, passedBody, tag) {
  let body = passedBody || '';
  const storedLang = await getFromSettingsCache('app-lang');
  const lang = storedLang === 'en' || storedLang === 'fr' || storedLang === 'es' ? storedLang : 'he';
  const dir = lang === 'he' ? 'rtl' : 'ltr';

  if (!body && self.NotificationSelect) {
    try {
      const pool = await loadNotificationPool();
      const addressForm = (await getFromSettingsCache('address-form')) === 'f' ? 'f' : 'm';
      let history = await getFromSettingsCache('notification-recent-ids');
      if (!Array.isArray(history)) history = [];
      const picked = self.NotificationSelect.pickFromPool({
        pool,
        slot: 'morning',
        history,
        addressForm,
        personalRate: 0
      });
      if (picked) {
        body = picked.text;
        await saveToSettingsCache('notification-recent-ids', picked.history);
      }
    } catch {}
  }

  const options = {
    body: body || '',
    icon: './assets/icon-192.png',
    badge: './assets/icon-192.png',
    dir,
    lang,
    tag: tag || ('affirmation-' + title),
    renotify: false
  };
  try {
    await self.registration.showNotification(title, options);
  } catch (e) {
    await self.registration.showNotification(title, { body: body || '', tag: options.tag });
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
