// ===== Positive Affirmations App =====

let affirmationsData = null;
let currentCategory = 'all';
let currentAffirmation = null;
let cameraStream = null;
let enabledCategories = null; // null = all enabled
let categoryOrder = null; // null = default order from data
let currentLang = 'he';
let translations = {};
let goalData = { goal: '', steps: [] };
let visualizeInterval = null;
let currentUser = null;
let cloudSyncEnabled = false;
let isPro = false;
let lastPersonalPlan = null;

// Created in Stripe Dashboard → Product catalog → your subscription product.
const STRIPE_MONTHLY_PRICE_ID = 'price_1UAlkS5TpYQiqdPxShalBZVP';

const GOAL_EXTRA_PATTERNS = {
  he: {
    business: /עסק|כסף|הכנסה|עושר|כלכל/,
    crisis: /דאון|חרדה|פחד|מצוקה|קשה|לחוץ|לחץ/,
    health: /בריאות|משקל|כושר|ספורט/,
    relationship: /זוגיות|אהבה|קשר|מערכת יחסים/
  },
  en: {
    business: /business|money|income|wealth|financ/i,
    crisis: /anxi|fear|stress|crisis|depress/i,
    health: /health|weight|fitness|sport|exercise/i,
    relationship: /relationship|love|partner|marriage/i
  },
  fr: {
    business: /entrepris|argent|revenu|richesse|financ/i,
    crisis: /anxiét|peur|stress|crise|dépress/i,
    health: /santé|poids|forme|sport/i,
    relationship: /relation|amour|couple|mariage/i
  },
  es: {
    business: /negocio|dinero|ingreso|riqueza|financ/i,
    crisis: /ansiedad|miedo|estrés|crisis|depres/i,
    health: /salud|peso|forma f[ií]sica|deporte/i,
    relationship: /relaci[oó]n|amor|pareja|matrimonio/i
  }
};

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
  loadCategoryOrder();
  renderCategoryChips();
  loadEnabledCategories();
  updateCategoryChips();
  showRandomAffirmation();
  updateLangButtons();
  loadGeneratedContent();
  reapplyPersonalPlanIfAny();
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
  migrateOldReminders();
  loadPersonalAffirmations();
  loadGoalData();
  renderGoalBanner();
  registerServiceWorker();
  startReminderChecker();
  maybeShowOnboarding();
  if (window.AppAuth) {
    window.AppAuth.onChange(handleAuthChange);
    window.AppAuth.onForegroundMessage((payload) => {
      const title = payload.notification?.title || payload.data?.title || '';
      const body = payload.notification?.body || payload.data?.body || '';
      showToast(`${title}${body ? ' — ' + body : ''}`);
    });
  }
  if (Notification.permission === 'granted') registerFcmToken();

  if (new URLSearchParams(window.location.search).get('upgraded') === '1') {
    showToast(t('toastUpgradeProcessing'));
    history.replaceState({}, '', window.location.pathname);
    pollForProAfterUpgrade();
  }

  captureReferralParam();
});

function captureReferralParam() {
  const ref = new URLSearchParams(window.location.search).get('ref');
  if (ref) {
    localStorage.setItem('referral-code', ref);
    history.replaceState({}, '', window.location.pathname);
    logAnalyticsEvent('referral_link_visited', { referrer: ref });
  }
}

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

  // Category chips from affirmations data (in user-defined order)
  getCategoryOrder().forEach(key => {
    const name = affirmationsData.categories[key];
    if (!name) return;
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
  // Any close (X, backdrop, or start button) means "seen it" — the checkbox
  // no longer gates this, it would otherwise show again on every reload.
  localStorage.setItem('onboarding-hidden', '1');
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

  // Camera double-tap to favorite (bound once — openCamera used to re-bind this on every open)
  let lastCameraTap = 0;
  document.getElementById('cameraAffirmation').addEventListener('click', () => {
    const now = Date.now();
    if (now - lastCameraTap < 350) {
      toggleFavorite();
      showCameraHeart(document.getElementById('cameraAffirmation'));
    }
    lastCameraTap = now;
  });

  // Share button
  document.getElementById('shareBtn').addEventListener('click', shareAffirmation);

  // Donate / footer upgrade link: pushes toward the real AI Coach subscription
  // (actual value in return) rather than a generic tip jar, since that's now
  // the app's real paid tier; Pro users already support that way, so for them
  // this becomes a thank-you with a one-time-coffee option instead.
  document.getElementById('donateBtn').addEventListener('click', (e) => {
    e.preventDefault();
    if (isPro) {
      window.open('https://buymeacoffee.com/uriel.zion', '_blank', 'noopener,noreferrer');
    } else {
      document.getElementById('upgradeDialog').classList.add('active');
    }
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

  // Reminders
  document.getElementById('addReminderBtn').addEventListener('click', addReminder);

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

  // Google sign-in
  document.getElementById('googleSignInBtn').addEventListener('click', handleGoogleSignIn);
  document.getElementById('googleSignOutBtn').addEventListener('click', handleGoogleSignOut);
  document.getElementById('shareInviteBtn').addEventListener('click', shareInviteLink);

  // Upgrade / AI Coach
  document.getElementById('upgradeAiBtn').addEventListener('click', () => {
    if (isPro) return; // disabled state already covers this, but guard anyway
    document.getElementById('upgradeDialog').classList.add('active');
  });
  document.getElementById('upgradeCancelBtn').addEventListener('click', () => {
    document.getElementById('upgradeDialog').classList.remove('active');
  });
  document.getElementById('upgradeConfirmBtn').addEventListener('click', () => {
    document.getElementById('upgradeDialog').classList.remove('active');
    handleUpgradeClick();
  });
  document.getElementById('regeneratePlanBtn').addEventListener('click', handleGeneratePlan);
  document.getElementById('manageSubscriptionBtn').addEventListener('click', handleManagePortal);
  document.getElementById('upgradeSuccessCloseBtn').addEventListener('click', () => {
    document.getElementById('upgradeSuccessDialog').classList.remove('active');
  });
  document.getElementById('upgradeSuccessGenerateBtn').addEventListener('click', () => {
    document.getElementById('upgradeSuccessDialog').classList.remove('active');
    openSettings();
    document.querySelector('.settings-tab[data-tab="goal"]')?.click();
    setTimeout(handleGeneratePlan, 350);
  });

  // Settings tabs
  document.getElementById('settingsTabs').addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.settings-tab');
    if (!tabBtn) return;
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    tabBtn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector(`.tab-content[data-tab-content="${tabBtn.dataset.tab}"]`).classList.add('active');
  });

  // Goal banner
  document.getElementById('goalBannerEmpty').addEventListener('click', () => {
    openSettings();
    setTimeout(() => document.getElementById('goalInput').focus(), 350);
  });
  document.getElementById('goalBanner').addEventListener('click', openVisualize);
  document.getElementById('saveGoalBtn').addEventListener('click', handleSaveGoal);
  document.getElementById('goalAiNudge').addEventListener('click', () => {
    logAnalyticsEvent('goal_ai_nudge_clicked');
    document.getElementById('upgradeDialog').classList.add('active');
  });
  document.getElementById('goalInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSaveGoal();
  });

  // Visualize overlay
  document.getElementById('visualizeClose').addEventListener('click', closeVisualize);
  document.getElementById('visualizeSection').addEventListener('click', (e) => {
    if (e.target.id === 'visualizeSection') closeVisualize();
  });

  // Belief journal
  document.getElementById('addJournalBtn').addEventListener('click', addJournalEntry);
  document.getElementById('journalInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addJournalEntry();
  });

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
  renderReminders();
  document.getElementById('goalInput').value = goalData.goal || '';
  renderGoalSteps();
  renderJournalList();
}

function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('active');
  document.getElementById('settingsBackdrop').classList.remove('active');
}

// ===== Reminders (flexible list, user can add/remove any number) =====
function defaultReminders() {
  return [
    { id: 'default-morning', time: '08:00', enabled: true, label: t('notifMorning') },
    { id: 'default-noon', time: '13:00', enabled: true, label: t('notifNoon') },
    { id: 'default-evening', time: '21:00', enabled: true, label: t('notifEvening') }
  ];
}

function migrateOldReminders() {
  if (localStorage.getItem('reminders-list')) return;
  const old = localStorage.getItem('reminder-settings');
  if (!old) return;
  try {
    const settings = JSON.parse(old);
    const list = [];
    if (settings.morning) list.push({ id: 'r1', time: settings.morning.time, enabled: settings.morning.enabled, label: t('notifMorning') });
    if (settings.noon) list.push({ id: 'r2', time: settings.noon.time, enabled: settings.noon.enabled, label: t('notifNoon') });
    if (settings.evening) list.push({ id: 'r3', time: settings.evening.time, enabled: settings.evening.enabled, label: t('notifEvening') });
    if (list.length) localStorage.setItem('reminders-list', JSON.stringify(list));
  } catch {}
}

function getReminders() {
  try {
    const saved = localStorage.getItem('reminders-list');
    const parsed = saved ? JSON.parse(saved) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // No reminders saved yet — persist the defaults immediately so their ids
  // stay stable across calls (this function is polled every 30s).
  const defaults = defaultReminders();
  localStorage.setItem('reminders-list', JSON.stringify(defaults));
  return defaults;
}

function saveReminders(reminders) {
  localStorage.setItem('reminders-list', JSON.stringify(reminders));
  syncSettingsToSW();
  startReminderChecker();
  pushToCloud();
}

function renderReminders() {
  const container = document.getElementById('remindersList');
  if (!container) return;
  const reminders = getReminders();
  container.innerHTML = '';

  reminders.forEach(r => {
    const row = document.createElement('div');
    row.className = 'reminder-row';
    row.dataset.id = r.id;

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'reminder-label';
    labelInput.value = r.label;
    labelInput.maxLength = 40;
    labelInput.addEventListener('change', () => updateReminder(r.id, { label: labelInput.value.trim() || r.label }));

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.className = 'reminder-time';
    timeInput.value = r.time;
    timeInput.addEventListener('change', () => updateReminder(r.id, { time: timeInput.value }));

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = r.enabled;
    toggleInput.addEventListener('change', () => updateReminder(r.id, { enabled: toggleInput.checked }));
    const slider = document.createElement('span');
    slider.className = 'toggle-slider';
    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(slider);

    const delBtn = document.createElement('button');
    delBtn.className = 'reminder-delete';
    delBtn.innerHTML = '&#10005;';
    delBtn.setAttribute('aria-label', t('deleteBtn'));
    delBtn.addEventListener('click', () => removeReminder(r.id));

    row.appendChild(labelInput);
    row.appendChild(timeInput);
    row.appendChild(toggleLabel);
    row.appendChild(delBtn);
    container.appendChild(row);
  });
}

function updateReminder(id, changes) {
  const reminders = getReminders().map(r => r.id === id ? { ...r, ...changes } : r);
  saveReminders(reminders);
}

function removeReminder(id) {
  const reminders = getReminders().filter(r => r.id !== id);
  saveReminders(reminders);
  renderReminders();
}

function addReminder() {
  const reminders = getReminders();
  if (reminders.length >= 10) {
    showToast(t('remindersMax'));
    return;
  }
  reminders.push({ id: 'r' + Date.now(), time: '12:00', enabled: true, label: t('newReminderLabel') });
  saveReminders(reminders);
  renderReminders();
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
  checkXiaomiNotice();
}

function checkXiaomiNotice() {
  const notice = document.getElementById('xiaomiNotice');
  if (!notice) return;
  const isMiui = /miui|xiaomi|redmi|poco/i.test(navigator.userAgent);
  notice.style.display = (isMiui && Notification.permission === 'granted') ? '' : 'none';
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
    startReminderChecker();
    registerPeriodicSync();
    await registerFcmToken();
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

// ===== FCM (real push notifications, work even when the app is fully closed) =====
async function registerFcmToken() {
  if (!window.AppAuth?.getFcmToken) return;
  try {
    const token = await window.AppAuth.getFcmToken();
    if (!token) return;
    localStorage.setItem('fcm-token', token);
    if (cloudSyncEnabled && currentUser && window.AppAuth.saveFcmToken) {
      await window.AppAuth.saveFcmToken(currentUser.uid, token);
    }
  } catch {}
}

// ===== Reminder Checker (foreground fallback — the server-side FCM job is the reliable path) =====
let reminderInterval = null;

function startReminderChecker() {
  if (reminderInterval) clearInterval(reminderInterval);
  checkReminders();
  reminderInterval = setInterval(checkReminders, 30000);
}

function checkReminders() {
  if (Notification.permission !== 'granted') return;

  const reminders = getReminders();
  if (!reminders.length) return;

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

  reminders.forEach(r => {
    if (!r.enabled) return;
    if (sent[r.id]) return;
    if (isTimeMatch(currentTime, r.time)) {
      sendNotification(r.label, r.id);
      sent[r.id] = true;
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

function sendNotification(title, reminderId) {
  const body = currentAffirmation ? currentAffirmation.text : '';
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SHOW_NOTIFICATION', title, body });
    if (reminderId) {
      navigator.serviceWorker.controller.postMessage({ type: 'MARK_SENT', period: reminderId });
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
  pushToCloud();
}

function removePersonalAffirmation(index) {
  const personal = getPersonalAffirmations();
  personal.splice(index, 1);
  localStorage.setItem('personal-affirmations', JSON.stringify(personal));
  renderPersonalList();
  pushToCloud();
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

// ===== Category Order =====
function loadCategoryOrder() {
  try {
    const saved = localStorage.getItem('category-order');
    categoryOrder = saved ? JSON.parse(saved) : null;
  } catch {
    categoryOrder = null;
  }
}

function saveCategoryOrder(order) {
  categoryOrder = order;
  localStorage.setItem('category-order', JSON.stringify(order));
  renderCategoryChips();
  updateCategoryChips();
}

function getCategoryOrder() {
  const allKeys = Object.keys(affirmationsData.categories);
  if (!categoryOrder) return allKeys;
  const ordered = categoryOrder.filter(k => allKeys.includes(k));
  allKeys.forEach(k => { if (!ordered.includes(k)) ordered.push(k); });
  return ordered;
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

  getCategoryOrder().forEach(key => {
    const name = affirmationsData.categories[key];
    if (!name) return;

    const row = document.createElement('div');
    row.className = 'category-toggle-row';
    row.draggable = true;
    row.dataset.key = key;

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '☰';
    handle.setAttribute('aria-hidden', 'true');

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
    row.appendChild(handle);
    row.appendChild(label);
    row.appendChild(toggle);
    container.appendChild(row);
  });

  initCategoryDragDrop(container);
}

function initCategoryDragDrop(container) {
  let dragSrc = null;

  // Desktop drag-and-drop
  container.addEventListener('dragstart', e => {
    const row = e.target.closest('.category-toggle-row');
    if (!row) return;
    dragSrc = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragend', () => {
    if (dragSrc) dragSrc.classList.remove('dragging');
    dragSrc = null;
    container.querySelectorAll('.category-toggle-row').forEach(r => r.classList.remove('drag-over'));
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.category-toggle-row');
    if (!row || row === dragSrc) return;
    container.querySelectorAll('.category-toggle-row').forEach(r => r.classList.remove('drag-over'));
    row.classList.add('drag-over');
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    const row = e.target.closest('.category-toggle-row');
    if (!row || row === dragSrc || !dragSrc) return;
    const rows = [...container.querySelectorAll('.category-toggle-row')];
    const fromIdx = rows.indexOf(dragSrc);
    const toIdx = rows.indexOf(row);
    if (fromIdx !== toIdx) {
      if (fromIdx < toIdx) row.after(dragSrc);
      else row.before(dragSrc);
      saveCategoryOrder([...container.querySelectorAll('.category-toggle-row')].map(r => r.dataset.key));
    }
    container.querySelectorAll('.category-toggle-row').forEach(r => r.classList.remove('drag-over'));
  });

  // Touch drag-and-drop
  let touchSrc = null;
  let touchClone = null;
  let touchStartY = 0;
  let touchStartScrollY = 0;

  container.addEventListener('touchstart', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const row = handle.closest('.category-toggle-row');
    if (!row) return;
    touchSrc = row;
    touchStartY = e.touches[0].clientY;
    touchStartScrollY = window.scrollY;

    touchClone = row.cloneNode(true);
    const rect = row.getBoundingClientRect();
    touchClone.style.cssText = `
      position: fixed;
      left: ${rect.left}px;
      top: ${rect.top}px;
      width: ${rect.width}px;
      opacity: 0.85;
      z-index: 9999;
      pointer-events: none;
      background: var(--card-bg);
      box-shadow: 0 4px 20px rgba(0,0,0,0.25);
      border-radius: 8px;
      padding: 8px 0;
    `;
    document.body.appendChild(touchClone);
    row.classList.add('dragging');
    e.preventDefault();
  }, { passive: false });

  container.addEventListener('touchmove', e => {
    if (!touchSrc || !touchClone) return;
    e.preventDefault();
    const touch = e.touches[0];
    const dy = touch.clientY - touchStartY;
    const rect = touchSrc.getBoundingClientRect();
    touchClone.style.top = (rect.top + dy) + 'px';

    container.querySelectorAll('.category-toggle-row').forEach(r => r.classList.remove('drag-over'));
    const target = [...container.querySelectorAll('.category-toggle-row:not(.dragging)')].find(r => {
      const rRect = r.getBoundingClientRect();
      return touch.clientY >= rRect.top && touch.clientY <= rRect.bottom;
    });
    if (target) target.classList.add('drag-over');
  }, { passive: false });

  container.addEventListener('touchend', e => {
    if (!touchSrc || !touchClone) return;
    const touch = e.changedTouches[0];
    const target = [...container.querySelectorAll('.category-toggle-row:not(.dragging)')].find(r => {
      const rRect = r.getBoundingClientRect();
      return touch.clientY >= rRect.top && touch.clientY <= rRect.bottom;
    });
    if (target) {
      const rows = [...container.querySelectorAll('.category-toggle-row')];
      const fromIdx = rows.indexOf(touchSrc);
      const toIdx = rows.indexOf(target);
      if (fromIdx < toIdx) target.after(touchSrc);
      else target.before(touchSrc);
      saveCategoryOrder([...container.querySelectorAll('.category-toggle-row')].map(r => r.dataset.key));
    }
    touchSrc.classList.remove('dragging');
    container.querySelectorAll('.category-toggle-row').forEach(r => r.classList.remove('drag-over'));
    touchClone.remove();
    touchClone = null;
    touchSrc = null;
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
  try {
    navigator.serviceWorker.controller.postMessage({
      type: 'SAVE_SETTINGS',
      reminders: getReminders()
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
    logAnalyticsEvent('favorite_added');
  } else {
    favs.splice(idx, 1);
    showToast(t('toastFavRemoved'));
  }
  localStorage.setItem('favorites', JSON.stringify(favs));
  updateFavoriteBtn();
  updateFavoritesChip();
  pushToCloud();
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

// ===== Big Goal =====
function loadGoalData() {
  try {
    const saved = localStorage.getItem('goal-data');
    goalData = saved ? JSON.parse(saved) : { goal: '', steps: [] };
  } catch {
    goalData = { goal: '', steps: [] };
  }
}

function saveGoalData() {
  localStorage.setItem('goal-data', JSON.stringify(goalData));
}

function generateGoalSteps(goalText) {
  let base = t('goalStepsBase');
  if (!Array.isArray(base) || base.length < 5) {
    base = [
      'תגדיר לעצמך בבירור איך זה נראה כשהיעד הזה כבר הושג',
      'דמיין את זה כל יום למשך דקה - כאילו זה כבר קרה',
      'מצא את הצעד הקטן ביותר שאתה יכול לעשות היום',
      'שים לב לכל רגע אמונה בדרך ותעד אותו',
      'סקור את ההתקדמות שלך פעם בשבוע ותחדש מחויבות'
    ];
  }

  const patterns = GOAL_EXTRA_PATTERNS[currentLang] || GOAL_EXTRA_PATTERNS.he;
  let extraText = null;
  for (const [type, regex] of Object.entries(patterns)) {
    if (regex.test(goalText)) {
      extraText = t('goalExtra' + type.charAt(0).toUpperCase() + type.slice(1));
      break;
    }
  }

  const steps = [base[0]];
  if (extraText) steps.push(extraText);
  steps.push(base[1], base[2], base[3], base[4]);
  return steps.map(text => ({ text, done: false }));
}

function handleSaveGoal() {
  const input = document.getElementById('goalInput');
  const text = input.value.trim();
  if (!text) return;

  if (goalData.goal !== text) {
    goalData = { goal: text, steps: generateGoalSteps(text) };
    saveGoalData();
    showToast(t('goalSaved').replace('{n}', goalData.steps.length));
    logAnalyticsEvent('goal_set', { step_count: goalData.steps.length });
    pushToCloud();
  }
  renderGoalBanner();
  renderGoalSteps();
}

function toggleGoalStep(index) {
  goalData.steps[index].done = !goalData.steps[index].done;
  saveGoalData();
  renderGoalSteps();
  renderGoalBanner();
  if (goalData.steps[index].done) logAnalyticsEvent('goal_step_completed');
  pushToCloud();
}

function renderGoalBanner() {
  const banner = document.getElementById('goalBanner');
  const empty = document.getElementById('goalBannerEmpty');
  const nudge = document.getElementById('goalAiNudge');
  if (!goalData.goal) {
    banner.style.display = 'none';
    empty.style.display = '';
    if (nudge) nudge.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  banner.style.display = '';
  const done = goalData.steps.filter(s => s.done).length;
  banner.textContent = `🎯 ${goalData.goal} · ${done}/${goalData.steps.length} · 🧘`;
  if (nudge) nudge.style.display = isPro ? 'none' : '';
}

function renderGoalSteps() {
  const container = document.getElementById('goalSteps');
  if (!container) return;
  container.innerHTML = '';

  goalData.steps.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'goal-step-row' + (step.done ? ' done' : '');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = step.done;
    checkbox.addEventListener('change', () => toggleGoalStep(i));

    const span = document.createElement('span');
    span.textContent = step.text;

    row.appendChild(checkbox);
    row.appendChild(span);
    container.appendChild(row);
  });
}

// ===== Visualize =====
function openVisualize() {
  if (!goalData.goal && !currentAffirmation) return;
  logAnalyticsEvent('visualize_started');
  document.getElementById('visualizeGoalText').textContent = goalData.goal ? `🎯 ${goalData.goal}` : '';
  document.getElementById('visualizeAffirmationText').textContent = currentAffirmation ? currentAffirmation.text : '';
  document.getElementById('visualizeSection').classList.add('active');

  let seconds = 60;
  const timerEl = document.getElementById('visualizeTimer');
  timerEl.textContent = seconds;
  clearInterval(visualizeInterval);
  visualizeInterval = setInterval(() => {
    seconds -= 1;
    timerEl.textContent = seconds;
    if (seconds <= 0) closeVisualize();
  }, 1000);
}

function closeVisualize() {
  clearInterval(visualizeInterval);
  visualizeInterval = null;
  document.getElementById('visualizeSection').classList.remove('active');
}

// ===== Belief Journal =====
function getJournalEntries() {
  try {
    const saved = localStorage.getItem('belief-journal');
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addJournalEntry() {
  const input = document.getElementById('journalInput');
  const text = input.value.trim();
  if (!text || text.length > 200) return;

  const entries = getJournalEntries();
  entries.unshift(text);
  localStorage.setItem('belief-journal', JSON.stringify(entries.slice(0, 200)));

  input.value = '';
  renderJournalList();
  showToast(t('journalAdded'));
  logAnalyticsEvent('journal_entry_added');
  pushToCloud();
}

function removeJournalEntry(index) {
  const entries = getJournalEntries();
  entries.splice(index, 1);
  localStorage.setItem('belief-journal', JSON.stringify(entries));
  renderJournalList();
  pushToCloud();
}

function renderJournalList() {
  const list = document.getElementById('journalList');
  if (!list) return;
  const entries = getJournalEntries();
  list.innerHTML = '';

  entries.forEach((text, i) => {
    const div = document.createElement('div');
    div.className = 'personal-item';

    const span = document.createElement('span');
    span.textContent = text;

    const btn = document.createElement('button');
    btn.innerHTML = '&#10005;';
    btn.setAttribute('aria-label', t('deleteBtn'));
    btn.addEventListener('click', () => removeJournalEntry(i));

    div.appendChild(span);
    div.appendChild(btn);
    list.appendChild(div);
  });
}

// ===== Google Auth =====
async function handleAuthChange(user) {
  const signedOutEl = document.getElementById('accountSignedOut');
  const signedInEl = document.getElementById('accountSignedIn');
  currentUser = user;
  cloudSyncEnabled = !!user;

  if (user) {
    signedOutEl.style.display = 'none';
    signedInEl.style.display = '';
    document.getElementById('accountAvatar').src = user.photoURL || '';
    document.getElementById('accountName').textContent = user.displayName || user.email || '';
    await syncFromCloud(user.uid);
    if (Notification.permission === 'granted') registerFcmToken();
    await checkSubscriptionStatus();
    await maybeRedeemReferral(user);
    renderInviteLink(user);
  } else {
    signedOutEl.style.display = '';
    signedInEl.style.display = 'none';
    isPro = false;
    updateUpgradeChipUI();
  }
}

// ===== Cloud Sync (Firestore) =====
// On sign-in: if the account already has cloud data, it wins and overwrites
// this device's local copy. If not (first time this account is used),
// this device's current local data is pushed up as the initial cloud copy.
function mergeStringArrays(local, cloud) {
  const combined = [...(Array.isArray(local) ? local : []), ...(Array.isArray(cloud) ? cloud : [])];
  return [...new Set(combined)];
}

function mergeReminders(local, cloud) {
  const map = new Map();
  (Array.isArray(local) ? local : []).forEach(r => map.set(r.id, r));
  (Array.isArray(cloud) ? cloud : []).forEach(r => map.set(r.id, r));
  return [...map.values()];
}

// Merges cloud data into local rather than overwriting it — a non-empty
// local list is never replaced by an empty cloud one (e.g. signing into an
// account with no cloud data yet, or an older cloud copy, used to wipe out
// whatever the user had already built up on this device).
async function syncFromCloud(uid) {
  if (!window.AppAuth?.loadUserData) return;
  try {
    const cloud = await window.AppAuth.loadUserData(uid);
    if (cloud) {
      if (cloud.goalData?.goal) {
        goalData = cloud.goalData;
        saveGoalData();
      }
      // else: local goal (if any) is kept as-is and pushed back up below.

      localStorage.setItem('belief-journal', JSON.stringify(mergeStringArrays(getJournalEntries(), cloud.journal)));
      localStorage.setItem('favorites', JSON.stringify(mergeStringArrays(getFavorites(), cloud.favorites)));
      localStorage.setItem('personal-affirmations', JSON.stringify(mergeStringArrays(getPersonalAffirmations(), cloud.personalAffirmations)));
      localStorage.setItem('reminders-list', JSON.stringify(mergeReminders(getReminders(), cloud.reminders)));
      syncSettingsToSW();
      startReminderChecker();

      renderGoalBanner();
      renderGoalSteps();
      renderJournalList();
      renderPersonalList();
      renderReminders();
      updateFavoritesChip();
      showRandomAffirmation();

      showToast(t('toastSynced'));
      await pushToCloud(); // write the merged result back up so both sides converge
    } else {
      await pushToCloud();
    }
  } catch {
    showToast(t('toastSyncError'));
  }
}

async function pushToCloud() {
  if (!cloudSyncEnabled || !currentUser || !window.AppAuth?.saveUserData) return;
  try {
    await window.AppAuth.saveUserData(currentUser.uid, {
      goalData,
      journal: getJournalEntries(),
      favorites: getFavorites(),
      personalAffirmations: getPersonalAffirmations(),
      reminders: getReminders(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  } catch {
    showToast(t('toastSyncError'));
  }
}

async function handleGoogleSignIn() {
  if (!window.AppAuth) return;
  try {
    await window.AppAuth.signIn();
    showToast(t('toastSignedIn'));
  } catch {
    showToast(t('toastSignInError'));
  }
}

async function handleGoogleSignOut() {
  if (!window.AppAuth) return;
  await window.AppAuth.signOut();
  showToast(t('toastSignedOut'));
}

// ===== Growing affirmation pool (AI-generated daily + cross-user favorites) =====
// Hebrew only for now. Cached per calendar day so it's one Firestore read
// per day per visitor, not one per page load.
async function loadGeneratedContent() {
  if (!window.AppAuth?.loadGeneratedAffirmations || currentLang !== 'he' || !affirmationsData) return;

  const today = new Date().toDateString();
  const cacheKey = 'generated-content-cache';
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch {}

  let generated, popular;
  if (cached && cached.date === today) {
    ({ generated, popular } = cached);
  } else {
    try {
      [generated, popular] = await Promise.all([
        window.AppAuth.loadGeneratedAffirmations(),
        window.AppAuth.loadPopularAffirmations()
      ]);
      localStorage.setItem(cacheKey, JSON.stringify({ date: today, generated, popular }));
    } catch {
      return;
    }
  }

  if (Array.isArray(generated)) {
    affirmationsData.affirmations.push(
      ...generated.filter(g => g?.language === 'he' && g.text && g.category)
    );
  }

  if (Array.isArray(popular) && popular.length) {
    if (!affirmationsData.categories.popular) {
      affirmationsData.categories.popular = t('categoryPopular');
    }
    affirmationsData.affirmations.push(...popular.map(p => ({ text: p.text, category: 'popular' })));
  }

  renderCategoryChips();
  updateCategoryChips();
}

// ===== Subscription / AI Coach =====
let proBonusUntil = null;

async function checkSubscriptionStatus() {
  if (!window.AppAuth?.loadSubscriptionStatus || !currentUser) return;
  try {
    const status = await window.AppAuth.loadSubscriptionStatus(currentUser.uid);
    isPro = status.isPro;
    proBonusUntil = status.bonusUntil;
  } catch (err) {
    console.error('checkSubscriptionStatus failed:', err);
    logAnalyticsEvent('subscription_status_check_failed', { code: err?.code || 'unknown' });
    isPro = false;
    proBonusUntil = null;
  }
  updateUpgradeChipUI();
  if (isPro) renderStoredPersonalPlan();
}

// After the Stripe redirect: auth may still be restoring and the webhook may
// still be landing in Firestore, so poll for a bit instead of checking once —
// a single early check used to silently miss and leave the user thinking
// nothing happened even though the payment (and the write) succeeded.
async function pollForProAfterUpgrade() {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (currentUser) await checkSubscriptionStatus();
    if (isPro) {
      logAnalyticsEvent('checkout_completed');
      document.getElementById('upgradeSuccessDialog')?.classList.add('active');
      return;
    }
  }
}

function updateUpgradeChipUI() {
  const btn = document.getElementById('upgradeAiBtn');
  const planEl = document.getElementById('personalPlan');
  const donateLabel = document.getElementById('donateBtnLabel');
  const nudge = document.getElementById('goalAiNudge');
  if (donateLabel) donateLabel.textContent = isPro ? t('btnDonateProThanks') : t('btnDonate');
  if (nudge) nudge.style.display = (isPro || !goalData.goal) ? 'none' : '';
  if (!btn) return;
  if (isPro) {
    btn.textContent = proBonusUntil
      ? t('proActiveBonusChip').replace('{date}', proBonusUntil.toLocaleDateString(currentLang === 'he' ? 'he-IL' : currentLang))
      : t('proActiveChip');
    btn.disabled = true;
    if (planEl) planEl.style.display = '';
  } else {
    btn.textContent = t('upgradeAiChip');
    btn.disabled = false;
    if (planEl) planEl.style.display = 'none';
    removeAiCoachFromPool();
  }
}

function removeAiCoachFromPool() {
  lastPersonalPlan = null;
  if (!affirmationsData) return;
  affirmationsData.affirmations = affirmationsData.affirmations.filter(a => a.category !== 'ai-coach');
  delete affirmationsData.categories['ai-coach'];
  renderCategoryChips();
  updateCategoryChips();
}

async function handleUpgradeClick() {
  // Signing in used to be a hard stop here (a toast, then the user has to go
  // find the account tab themselves) — that's exactly the kind of extra step
  // that loses people right before Checkout, so do it inline instead.
  if (!currentUser) {
    if (!window.AppAuth?.signIn) {
      showToast(t('toastSignInFirst'));
      return;
    }
    try {
      const result = await window.AppAuth.signIn();
      currentUser = result.user;
    } catch {
      showToast(t('toastSignInError'));
      return;
    }
  }
  if (!window.AppAuth?.startCheckout) return;
  try {
    const url = await window.AppAuth.startCheckout(STRIPE_MONTHLY_PRICE_ID);
    logAnalyticsEvent('checkout_started');
    window.location.href = url;
  } catch {
    showToast(t('toastCheckoutError'));
  }
}

async function handleGeneratePlan() {
  if (!window.AppAuth?.generatePersonalPlan) return;
  const btn = document.getElementById('regeneratePlanBtn');
  if (btn) btn.disabled = true;
  try {
    const plan = await window.AppAuth.generatePersonalPlan();
    renderPersonalPlan(plan);
    logAnalyticsEvent('personal_plan_generated');
  } catch (err) {
    if (err?.code === 'functions/failed-precondition') showToast(t('toastPlanNeedsGoal'));
    else if (err?.code === 'functions/resource-exhausted') showToast(t('toastPlanDailyLimit'));
    else showToast(t('toastPlanError'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleManagePortal() {
  if (!window.AppAuth?.startPortalSession) return;
  try {
    const url = await window.AppAuth.startPortalSession();
    window.location.href = url;
  } catch {
    showToast(t('toastPortalError'));
  }
}

function renderStoredPersonalPlan() {
  // Shown immediately from the last generated plan, before the user asks to regenerate.
  if (!window.AppAuth?.loadUserData || !currentUser) return;
  window.AppAuth.loadUserData(currentUser.uid).then((data) => {
    if (data?.personalPlan) renderPersonalPlan(data.personalPlan);
  }).catch(() => {});
}

// Re-applies the last rendered plan after a language switch, which reloads
// affirmationsData from scratch and would otherwise silently drop the paid
// AI Coach content out of the rotation until the next sign-in.
function reapplyPersonalPlanIfAny() {
  if (isPro && lastPersonalPlan) mergePersonalPlanIntoPool(lastPersonalPlan);
}

function renderPersonalPlan(plan) {
  const affEl = document.getElementById('personalPlanAffirmations');
  const insightsEl = document.getElementById('personalPlanInsights');
  const emptyEl = document.getElementById('personalPlanEmpty');
  if (!affEl || !insightsEl) return;

  lastPersonalPlan = plan;
  const hasContent = Array.isArray(plan.affirmations) && plan.affirmations.length > 0;
  if (emptyEl) emptyEl.style.display = hasContent ? 'none' : '';

  affEl.innerHTML = '';
  (plan.affirmations || []).forEach((text) => {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:0.85rem; padding:6px 0; border-bottom:1px solid var(--card-border);';
    p.textContent = text;
    affEl.appendChild(p);
  });

  insightsEl.innerHTML = '';
  (plan.insights || []).forEach((text) => {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:0.8rem; color:var(--text-secondary); padding:6px 0;';
    p.textContent = '💡 ' + text;
    insightsEl.appendChild(p);
  });

  mergePersonalPlanIntoPool(plan);
}

// Makes the paid AI content actually show up in everyday use — not just a
// list sitting in Settings that a paying user has no reason to revisit.
function mergePersonalPlanIntoPool(plan) {
  if (!affirmationsData || !Array.isArray(plan.affirmations) || !plan.affirmations.length) return;

  affirmationsData.affirmations = affirmationsData.affirmations.filter(a => a.category !== 'ai-coach');
  affirmationsData.affirmations.push(
    ...plan.affirmations.map(text => ({ text, category: 'ai-coach' }))
  );
  if (!affirmationsData.categories['ai-coach']) {
    affirmationsData.categories['ai-coach'] = t('categoryAiCoach');
  }
  renderCategoryChips();
  updateCategoryChips();
}

// ===== Referral program =====
async function maybeRedeemReferral(user) {
  const referrerUid = localStorage.getItem('referral-code');
  if (!referrerUid || !window.AppAuth?.redeemReferral) return;

  // Only a brand-new account should redeem — an existing user re-signing in
  // with a stale ?ref= link in their history shouldn't keep granting bonuses.
  const isNewAccount = user.metadata?.creationTime === user.metadata?.lastSignInTime;
  if (!isNewAccount) {
    localStorage.removeItem('referral-code');
    return;
  }

  try {
    await window.AppAuth.redeemReferral(referrerUid);
    showToast(t('toastReferralWelcome'));
    logAnalyticsEvent('referral_redeemed', { referrer: referrerUid });
  } catch {
    // Already redeemed, self-referral, or referrer not found — fail silently.
  } finally {
    localStorage.removeItem('referral-code');
  }
}

function renderInviteLink(user) {
  const el = document.getElementById('inviteLink');
  if (!el) return;
  el.value = `https://uriz1991.github.io/positive-affirmations/?ref=${user.uid}`;

  const countEl = document.getElementById('inviteCount');
  if (countEl && window.AppAuth?.loadUserData) {
    window.AppAuth.loadUserData(user.uid).then((data) => {
      const count = data?.referralCount || 0;
      countEl.textContent = count > 0 ? t('inviteCount').replace('{n}', count) : '';
    }).catch(() => {});
  }
}

async function shareInviteLink() {
  const link = document.getElementById('inviteLink')?.value;
  if (!link) return;
  const text = t('inviteShareText');
  if (navigator.share) {
    try { await navigator.share({ title: t('shareTitle'), text, url: link }); } catch {}
  } else {
    try {
      await navigator.clipboard.writeText(`${text}\n${link}`);
      showToast(t('toastCopied'));
    } catch {
      prompt(t('copyPrompt'), link);
    }
  }
}

function logAnalyticsEvent(name, params) {
  if (window.AppAuth?.logEvent) {
    try { window.AppAuth.logEvent(name, params); } catch {}
  }
}
