// ===== Positive Affirmations App =====

let affirmationsData = null;
let currentCategory = 'all';
let currentAffirmation = null;
let cameraStream = null;
let enabledCategories = null; // null = all enabled
let currentLang = 'he';
let translations = {};

// ===== i18n =====
function t(key) {
  return translations[key] || key;
}

async function loadLanguage(lang) {
  const affFile = lang === 'he' ? './data/affirmations.json' : `./data/affirmations-${lang}.json`;
  try {
    const [localeRes, affirmRes] = await Promise.all([
      fetch(`./locales/${lang}.json`),
      fetch(affFile)
    ]);
    translations = await localeRes.json();
    affirmationsData = await affirmRes.json();
  } catch {
    // Fallback
    translations = {};
    if (!affirmationsData) {
      affirmationsData = {
        categories: { faith: 'אמונה והשגחה' },
        affirmations: [{ text: 'הכל מדויק לי', category: 'faith' }]
      };
    }
  }

  currentLang = lang;
  localStorage.setItem('app-language', lang);

  const isRTL = lang === 'he';
  document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
  document.documentElement.lang = lang;
  document.title = t('appTitle');

  applyTranslations();
  renderCategoryChips();
  loadEnabledCategories();
  updateCategoryChips();
  showRandomAffirmation();
  updateLangButtons();
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (key && translations[key]) el.textContent = translations[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    if (key && translations[key]) el.placeholder = translations[key];
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const key = el.dataset.i18nAria;
    if (key && translations[key]) el.setAttribute('aria-label', translations[key]);
  });
}

function updateLangButtons() {
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === currentLang);
  });
}

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  const savedLang = localStorage.getItem('app-language') || 'he';
  await loadLanguage(savedLang);
  loadTheme();
  loadFontSize();
  updateStreak();
  loadSettings();
  loadPersonalAffirmations();
  registerServiceWorker();
  startReminderChecker();
  maybeShowOnboarding();
});

// ===== Show Random Affirmation =====
function showRandomAffirmation() {
  const textEl = document.getElementById('affirmationText');
  const badgeEl = document.getElementById('currentCategory');

  let pool = affirmationsData.affirmations;

  // Filter by enabled categories (from settings)
  if (enabledCategories && enabledCategories.length > 0) {
    pool = pool.filter(a => enabledCategories.includes(a.category));
  }

  // Add personal affirmations to pool
  const personal = getPersonalAffirmations();
  if (personal.length > 0) {
    pool = pool.concat(personal.map(text => ({ text, category: 'personal' })));
  }

  // Filter by selected category chip
  if (currentCategory === 'favorites') {
    const favs = getFavorites();
    pool = pool.filter(a => favs.includes(a.text));
  } else if (currentCategory !== 'all') {
    pool = pool.filter(a => a.category === currentCategory || a.category === 'personal');
  }

  if (pool.length === 0) {
    pool = affirmationsData.affirmations;
  }

  // Pick random, avoid same as current
  let next;
  do {
    next = pool[Math.floor(Math.random() * pool.length)];
  } while (next === currentAffirmation && pool.length > 1);

  currentAffirmation = next;

  // Animate transition
  textEl.classList.add('fade-out');

  setTimeout(() => {
    textEl.textContent = next.text;
    const categoryName = next.category === 'personal'
      ? t('personalItem')
      : (affirmationsData.categories[next.category] || next.category);
    badgeEl.textContent = categoryName;

    textEl.classList.remove('fade-out');
    textEl.classList.add('fade-in');

    setTimeout(() => {
      textEl.classList.remove('fade-in');
    }, 50);
  }, 300);

  // Update camera overlay too
  const cameraAffirmation = document.getElementById('cameraAffirmation');
  if (cameraAffirmation) {
    cameraAffirmation.textContent = next.text;
  }

  setTimeout(updateFavoriteBtn, 350); // after animation
}

// ===== Category Chips (dynamic) =====
function renderCategoryChips() {
  const container = document.getElementById('categories');
  const wasActive = currentCategory;
  container.innerHTML = '';

  // "All" chip
  const allChip = document.createElement('button');
  allChip.className = 'category-chip' + (wasActive === 'all' ? ' active' : '');
  allChip.dataset.category = 'all';
  allChip.textContent = t('categoryAll');
  container.appendChild(allChip);

  // "Favorites" chip
  const favChip = document.createElement('button');
  favChip.id = 'favoritesChip';
  favChip.className = 'category-chip' + (wasActive === 'favorites' ? ' active' : '');
  favChip.dataset.category = 'favorites';
  favChip.innerHTML = '&#9829; ' + t('categoryFavorites');
  favChip.style.display = getFavorites().length > 0 ? '' : 'none';
  container.appendChild(favChip);

  // Category chips from affirmations data
  Object.entries(affirmationsData.categories).forEach(([key, name]) => {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (wasActive === key ? ' active' : '');
    chip.dataset.category = key;
    chip.textContent = name;
    container.appendChild(chip);
  });

  // Reset active category if current one no longer exists
  const stillExists = wasActive === 'all' || wasActive === 'favorites' ||
    Object.keys(affirmationsData.categories).includes(wasActive);
  if (!stillExists) currentCategory = 'all';
}

// ===== Onboarding =====
function maybeShowOnboarding() {
  if (!localStorage.getItem('onboarding-hidden')) {
    document.getElementById('onboardingBackdrop').classList.add('active');
  }
}

function closeOnboarding() {
  if (document.getElementById('dontShowOnboarding').checked) {
    localStorage.setItem('onboarding-hidden', '1');
  }
  document.getElementById('onboardingBackdrop').classList.remove('active');
}

// ===== Event Listeners =====
function setupEventListeners() {
  // New affirmation button
  document.getElementById('newAffirmationBtn').addEventListener('click', showRandomAffirmation);

  // Help button
  document.getElementById('helpBtn').addEventListener('click', () => {
    document.getElementById('dontShowOnboarding').checked = false;
    document.getElementById('onboardingBackdrop').classList.add('active');
  });

  // Onboarding close
  document.getElementById('onboardingClose').addEventListener('click', closeOnboarding);
  document.getElementById('onboardingBackdrop').addEventListener('click', (e) => {
    if (e.target === document.getElementById('onboardingBackdrop')) closeOnboarding();
  });

  // Category chips (event delegation)
  document.getElementById('categories').addEventListener('click', (e) => {
    const chip = e.target.closest('.category-chip');
    if (!chip) return;
    document.querySelectorAll('.category-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentCategory = chip.dataset.category;
    showRandomAffirmation();
  });

  // Camera button
  document.getElementById('cameraBtn').addEventListener('click', () => {
    document.getElementById('cameraDialog').classList.add('active');
  });

  // Camera confirm
  document.getElementById('cameraConfirm').addEventListener('click', () => {
    document.getElementById('cameraDialog').classList.remove('active');
    openCamera();
  });

  // Camera deny
  document.getElementById('cameraDeny').addEventListener('click', () => {
    document.getElementById('cameraDialog').classList.remove('active');
  });

  // Camera close
  document.getElementById('cameraClose').addEventListener('click', closeCamera);

  // Camera next affirmation
  document.getElementById('cameraNextBtn').addEventListener('click', () => {
    showRandomAffirmation();
    document.getElementById('cameraAffirmation').textContent = currentAffirmation.text;
  });

  // Share button
  document.getElementById('shareBtn').addEventListener('click', shareAffirmation);

  // Donate button
  document.getElementById('donateBtn').addEventListener('click', (e) => {
    e.preventDefault();
    window.open('https://buymeacoffee.com/uriel.zion', '_blank', 'noopener,noreferrer');
  });

  // Settings
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsClose').addEventListener('click', closeSettings);
  document.getElementById('settingsBackdrop').addEventListener('click', closeSettings);

  // Language selector
  document.getElementById('langSelector').addEventListener('click', async (e) => {
    const btn = e.target.closest('.lang-btn');
    if (!btn || btn.dataset.lang === currentLang) return;
    currentCategory = 'all';
    await loadLanguage(btn.dataset.lang);
    renderCategoryToggles(); // re-render in new language
  });

  // Notification buttons
  document.getElementById('enableNotifications').addEventListener('click', requestNotificationPermission);

  // Reminder toggles and times
  ['morning', 'noon', 'evening'].forEach(period => {
    document.getElementById(`${period}Toggle`).addEventListener('change', saveSettings);
    document.getElementById(`${period}Time`).addEventListener('change', saveSettings);
  });

  // Personal affirmations
  document.getElementById('addPersonalBtn').addEventListener('click', addPersonalAffirmation);
  document.getElementById('personalInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addPersonalAffirmation();
  });

  // Check for update
  document.getElementById('checkUpdateBtn').addEventListener('click', checkForUpdate);

  // Theme toggle
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);

  // Favorite button
  document.getElementById('favoriteBtn').addEventListener('click', toggleFavorite);

  // Font size slider
  document.getElementById('fontSizeSlider').addEventListener('input', (e) => {
    const scale = e.target.value / 100;
    document.documentElement.style.setProperty('--font-scale', scale);
    localStorage.setItem('font-scale', e.target.value);
  });

  // Export favorites
  document.getElementById('exportFavoritesBtn').addEventListener('click', exportFavorites);

  // Stop camera stream if the user leaves the page
  window.addEventListener('beforeunload', () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
    }
  });

  // Swipe gesture on affirmation container
  let touchStartX = 0;
  let touchStartY = 0;
  const swipeArea = document.querySelector('.affirmation-container');
  swipeArea.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  swipeArea.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      showRandomAffirmation();
    }
  }, { passive: true });
}

// ===== Camera =====
async function openCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' }
    });
    cameraStream = stream;
    const video = document.getElementById('cameraVideo');
    video.srcObject = stream;
    document.getElementById('cameraSection').classList.add('active');
    const cameraAff = document.getElementById('cameraAffirmation');
    cameraAff.textContent = currentAffirmation.text;

    // Double-tap to favorite
    let lastTap = 0;
    cameraAff.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastTap < 350) {
        toggleFavorite();
        showCameraHeart(cameraAff);
      }
      lastTap = now;
    });
  } catch (err) {
    alert(t('cameraError'));
  }
}

function showCameraHeart(el) {
  const heart = document.createElement('span');
  heart.textContent = '♥';
  heart.style.cssText = `
    position: absolute; font-size: 3rem; color: #e05;
    pointer-events: none; animation: heartPop 0.8s ease forwards;
    left: 50%; top: 50%; transform: translate(-50%, -50%);
  `;
  el.style.position = 'relative';
  el.appendChild(heart);
  setTimeout(() => heart.remove(), 800);
}

function closeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  document.getElementById('cameraSection').classList.remove('active');
}

// ===== Share =====
async function shareAffirmation() {
  const text = currentAffirmation.text;
  const appUrl = 'https://uriz1991.github.io/positive-affirmations/';
  const shareText = `"${text}"\n\n${t('shareText')} 👉 ${appUrl}`;
  const shareData = { title: t('shareTitle'), text: shareText, url: appUrl };

  if (navigator.share) {
    try { await navigator.share(shareData); } catch {}
  } else {
    try {
      await navigator.clipboard.writeText(shareText);
      showToast(t('toastCopied'));
    } catch {
      prompt(t('copyPrompt'), shareText);
    }
  }
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--accent); color: white; padding: 12px 24px;
    border-radius: 12px; font-size: 0.9rem; z-index: 200;
    animation: fadeInUp 0.3s ease;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ===== Settings =====
function openSettings() {
  document.getElementById('settingsPanel').classList.add('active');
  document.getElementById('settingsBackdrop').classList.add('active');
  renderCategoryToggles();
  updateNotificationStatus();
}

function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('active');
  document.getElementById('settingsBackdrop').classList.remove('active');
}

function saveSettings() {
  const settings = {
    morning: {
      enabled: document.getElementById('morningToggle').checked,
      time: document.getElementById('morningTime').value
    },
    noon: {
      enabled: document.getElementById('noonToggle').checked,
      time: document.getElementById('noonTime').value
    },
    evening: {
      enabled: document.getElementById('eveningToggle').checked,
      time: document.getElementById('eveningTime').value
    }
  };

  localStorage.setItem('reminder-settings', JSON.stringify(settings));

  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SAVE_SETTINGS', settings });
  }

  startReminderChecker();
}

function loadSettings() {
  const saved = localStorage.getItem('reminder-settings');
  if (!saved) return;

  let settings;
  try { settings = JSON.parse(saved); } catch { return; }
  if (!settings) return;

  if (settings.morning) {
    document.getElementById('morningToggle').checked = settings.morning.enabled;
    document.getElementById('morningTime').value = settings.morning.time;
  }
  if (settings.noon) {
    document.getElementById('noonToggle').checked = settings.noon.enabled;
    document.getElementById('noonTime').value = settings.noon.time;
  }
  if (settings.evening) {
    document.getElementById('eveningToggle').checked = settings.evening.enabled;
    document.getElementById('eveningTime').value = settings.evening.time;
  }
}

// ===== Notifications =====
function updateNotificationStatus() {
  const statusEl = document.getElementById('notificationStatus');
  if (!statusEl) return;
  if (!('Notification' in window)) {
    statusEl.textContent = t('notifNotSupported');
    return;
  }
  switch (Notification.permission) {
    case 'granted':  statusEl.textContent = t('notifGranted'); break;
    case 'denied':   statusEl.textContent = t('notifBlocked'); break;
    default:         statusEl.textContent = '';
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    alert(t('notifNotSupported'));
    return;
  }

  const permission = await Notification.requestPermission();
  updateNotificationStatus();
  if (permission === 'granted') {
    showToast(t('notifEnabled'));
    saveSettings();
    startReminderChecker();
    registerPeriodicSync();
  } else {
    showToast(t('notifDenied'));
  }
}

async function registerPeriodicSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    if (!('periodicSync' in registration)) return;
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state === 'granted') {
      await registration.periodicSync.register('affirmation-reminder', {
        minInterval: 30 * 60 * 1000
      });
    }
  } catch {}
}

// ===== Reminder Checker =====
let reminderInterval = null;

function startReminderChecker() {
  if (reminderInterval) clearInterval(reminderInterval);
  checkReminders();
  reminderInterval = setInterval(checkReminders, 30000);
}

function checkReminders() {
  if (Notification.permission !== 'granted') return;

  const saved = localStorage.getItem('reminder-settings');
  if (!saved) return;

  let settings;
  try { settings = JSON.parse(saved); } catch { return; }

  const now = new Date();
  const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const today = now.toDateString();

  let sent = {};
  try {
    const sentData = localStorage.getItem('reminders-sent');
    sent = sentData ? JSON.parse(sentData) : {};
    if (sent._date !== today) sent = { _date: today };
  } catch {
    sent = { _date: today };
  }

  const periods = {
    morning: t('notifMorning'),
    noon:    t('notifNoon'),
    evening: t('notifEvening')
  };

  Object.entries(periods).forEach(([period, title]) => {
    if (!settings[period] || !settings[period].enabled) return;
    if (sent[period]) return;
    if (isTimeMatch(currentTime, settings[period].time)) {
      sendNotification(title, period);
      sent[period] = true;
      localStorage.setItem('reminders-sent', JSON.stringify(sent));
    }
  });
}

function isTimeMatch(current, target) {
  const [cH, cM] = current.split(':').map(Number);
  const [tH, tM] = target.split(':').map(Number);
  const currentMinutes = cH * 60 + cM;
  const targetMinutes = tH * 60 + tM;
  return currentMinutes === targetMinutes || currentMinutes === targetMinutes + 1;
}

function sendNotification(title, period) {
  const body = currentAffirmation ? currentAffirmation.text : '';
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SHOW_NOTIFICATION', title, body });
    if (period) {
      navigator.serviceWorker.controller.postMessage({ type: 'MARK_SENT', period });
    }
  } else {
    new Notification(title, {
      body,
      dir: currentLang === 'he' ? 'rtl' : 'ltr',
      lang: currentLang
    });
  }
}

// ===== Personal Affirmations =====
function getPersonalAffirmations() {
  try {
    const saved = localStorage.getItem('personal-affirmations');
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addPersonalAffirmation() {
  const input = document.getElementById('personalInput');
  const text = input.value.trim();
  if (!text || text.length > 200) return;

  const personal = getPersonalAffirmations();
  if (personal.length >= 50) {
    showToast(t('personalMax'));
    return;
  }
  personal.push(text);
  localStorage.setItem('personal-affirmations', JSON.stringify(personal));

  input.value = '';
  renderPersonalList();

  currentAffirmation = { text, category: 'personal' };
  const textEl = document.getElementById('affirmationText');
  const badgeEl = document.getElementById('currentCategory');
  textEl.classList.add('fade-out');
  setTimeout(() => {
    textEl.textContent = text;
    badgeEl.textContent = t('personalItem');
    textEl.classList.remove('fade-out');
    textEl.classList.add('fade-in');
    setTimeout(() => textEl.classList.remove('fade-in'), 50);
  }, 300);
  updateFavoriteBtn();
  showToast(t('personalAdded'));
}

function removePersonalAffirmation(index) {
  const personal = getPersonalAffirmations();
  personal.splice(index, 1);
  localStorage.setItem('personal-affirmations', JSON.stringify(personal));
  renderPersonalList();
}

function loadPersonalAffirmations() {
  renderPersonalList();
}

function renderPersonalList() {
  const list = document.getElementById('personalList');
  const personal = getPersonalAffirmations();
  list.innerHTML = '';

  if (personal.length === 0) return;

  personal.forEach((text, i) => {
    const div = document.createElement('div');
    div.className = 'personal-item';

    const span = document.createElement('span');
    span.textContent = text;

    const btn = document.createElement('button');
    btn.innerHTML = '&#10005;';
    btn.setAttribute('aria-label', t('deleteBtn'));
    btn.addEventListener('click', () => removePersonalAffirmation(i));

    div.appendChild(span);
    div.appendChild(btn);
    list.appendChild(div);
  });
}

// ===== Category Preferences =====
function loadEnabledCategories() {
  try {
    const saved = localStorage.getItem('enabled-categories');
    if (saved) {
      const parsed = JSON.parse(saved);
      enabledCategories = Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
    } else {
      enabledCategories = null;
    }
  } catch {
    enabledCategories = null;
  }
}

function saveEnabledCategories() {
  const checkboxes = document.querySelectorAll('#categoryToggles input[type="checkbox"]');
  const selected = [];
  checkboxes.forEach(cb => {
    if (cb.checked) selected.push(cb.dataset.category);
  });

  enabledCategories = selected.length > 0 ? selected : null;
  localStorage.setItem('enabled-categories', JSON.stringify(selected));
  updateCategoryChips();
  showRandomAffirmation();
}

function renderCategoryToggles() {
  const container = document.getElementById('categoryToggles');
  if (!container || !affirmationsData) return;
  container.innerHTML = '';

  const allEnabled = !enabledCategories;

  Object.entries(affirmationsData.categories).forEach(([key, name]) => {
    const row = document.createElement('div');
    row.className = 'category-toggle-row';

    const label = document.createElement('label');
    label.textContent = name;

    const toggle = document.createElement('label');
    toggle.className = 'toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.category = key;
    input.checked = allEnabled || enabledCategories.includes(key);
    input.addEventListener('change', saveEnabledCategories);

    const slider = document.createElement('span');
    slider.className = 'toggle-slider';

    toggle.appendChild(input);
    toggle.appendChild(slider);
    row.appendChild(label);
    row.appendChild(toggle);
    container.appendChild(row);
  });
}

function updateCategoryChips() {
  const chips = document.querySelectorAll('.category-chip[data-category]');
  chips.forEach(chip => {
    const cat = chip.dataset.category;
    if (cat === 'all' || cat === 'favorites') return;
    if (!enabledCategories || enabledCategories.includes(cat)) {
      chip.style.display = '';
    } else {
      chip.style.display = 'none';
      if (chip.classList.contains('active')) {
        chip.classList.remove('active');
        const allChip = document.querySelector('.category-chip[data-category="all"]');
        if (allChip) allChip.classList.add('active');
        currentCategory = 'all';
      }
    }
  });
}

// ===== Service Worker =====
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;

    if (navigator.serviceWorker.controller) {
      syncSettingsToSW();
    }

    navigator.serviceWorker.addEventListener('controllerchange', syncSettingsToSW, { once: true });
  } catch (err) {
    console.log('Service Worker registration failed:', err);
  }
}

function syncSettingsToSW() {
  if (!navigator.serviceWorker?.controller) return;
  const saved = localStorage.getItem('reminder-settings');
  if (!saved) return;
  try {
    navigator.serviceWorker.controller.postMessage({
      type: 'SAVE_SETTINGS',
      settings: JSON.parse(saved)
    });
  } catch {}
}

// ===== Theme =====
function loadTheme() {
  const theme = localStorage.getItem('theme') || 'dark';
  if (theme === 'light') {
    document.body.classList.add('light-mode');
    document.getElementById('themeBtn').textContent = '☽';
  } else {
    document.getElementById('themeBtn').textContent = '☀';
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  document.getElementById('themeBtn').textContent = isLight ? '☽' : '☀';
}

// ===== Streak =====
function updateStreak() {
  const today = new Date().toDateString();
  let data = {};
  try { data = JSON.parse(localStorage.getItem('streak-data') || '{}'); } catch {}

  if (data.lastDate !== today) {
    const yesterday = new Date(Date.now() - 86400000).toDateString();
    data.count = (data.lastDate === yesterday) ? (data.count || 0) + 1 : 1;
    data.lastDate = today;
    localStorage.setItem('streak-data', JSON.stringify(data));
  }

  const count = data.count || 1;
  if (count >= 2) {
    document.getElementById('streakCount').textContent = count;
    document.getElementById('streakBadge').style.display = '';
  }
}

// ===== Favorites =====
function getFavorites() {
  try { return JSON.parse(localStorage.getItem('favorites') || '[]'); } catch { return []; }
}

function toggleFavorite() {
  if (!currentAffirmation) return;
  const text = currentAffirmation.text;
  const favs = getFavorites();
  const idx = favs.indexOf(text);
  if (idx === -1) {
    favs.push(text);
    showToast(t('toastFavAdded'));
  } else {
    favs.splice(idx, 1);
    showToast(t('toastFavRemoved'));
  }
  localStorage.setItem('favorites', JSON.stringify(favs));
  updateFavoriteBtn();
  updateFavoritesChip();
}

function updateFavoriteBtn() {
  const btn = document.getElementById('favoriteBtn');
  const favs = getFavorites();
  const isFav = currentAffirmation && favs.includes(currentAffirmation.text);
  btn.innerHTML = isFav ? '&#9829;' : '&#9825;';
  btn.classList.toggle('active', isFav);
}

function updateFavoritesChip() {
  const chip = document.getElementById('favoritesChip');
  if (!chip) return;
  const hasFavs = getFavorites().length > 0;
  chip.style.display = hasFavs ? '' : 'none';
  if (!hasFavs && currentCategory === 'favorites') {
    currentCategory = 'all';
    document.querySelectorAll('.category-chip').forEach(c => c.classList.remove('active'));
    const allChip = document.querySelector('.category-chip[data-category="all"]');
    if (allChip) allChip.classList.add('active');
  }
}

function exportFavorites() {
  const favs = getFavorites();
  if (favs.length === 0) {
    showToast(t('toastFavEmpty'));
    return;
  }
  const text = t('favListTitle') + '\n\n' + favs.map((f, i) => `${i + 1}. ${f}`).join('\n');
  if (navigator.share) {
    navigator.share({ title: t('favShareTitle'), text });
  } else {
    navigator.clipboard.writeText(text).then(() => showToast(t('toastFavCopied')));
  }
}

// ===== Font Size =====
function loadFontSize() {
  const saved = localStorage.getItem('font-scale') || '100';
  document.getElementById('fontSizeSlider').value = saved;
  document.documentElement.style.setProperty('--font-scale', saved / 100);
}

// ===== Check for Update =====
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkForUpdate() {
  const btn = document.getElementById('checkUpdateBtn');
  const statusEl = document.getElementById('updateStatus');

  btn.disabled = true;
  statusEl.textContent = t('updateChecking');

  try {
    const response = await fetch('./sw.js?_=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('network');

    const text = await response.text();
    const match = text.match(/CACHE_NAME\s*=\s*['"]affirmations-v([\d.]+)['"]/);
    if (!match) throw new Error('parse');

    const latestVersion = match[1];
    const currentVersion = document.getElementById('appVersion').textContent.trim();
    const isNewer = compareVersions(latestVersion, currentVersion) > 0;

    if (isNewer) {
      statusEl.textContent = t('updateAvailable').replace('{v}', latestVersion);
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.unregister();
      setTimeout(() => location.reload(true), 600);
    } else {
      statusEl.textContent = t('updateCurrent').replace('{v}', currentVersion);
      btn.disabled = false;
    }
  } catch {
    statusEl.textContent = t('updateError');
    btn.disabled = false;
  }
}
