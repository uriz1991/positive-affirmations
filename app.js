// ===== Positive Affirmations App =====

let affirmationsData = null;
let currentCategory = 'all';
let currentAffirmation = null;
let cameraStream = null;
let enabledCategories = null; // null = all enabled

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', async () => {
  await loadAffirmations();
  loadEnabledCategories();
  updateCategoryChips();
  loadTheme();
  loadFontSize();
  updateStreak();
  updateFavoritesChip();
  showRandomAffirmation();
  setupEventListeners();
  loadSettings();
  loadPersonalAffirmations();
  registerServiceWorker();
  startReminderChecker();
});

// ===== Load Affirmations =====
async function loadAffirmations() {
  try {
    const response = await fetch('./data/affirmations.json');
    affirmationsData = await response.json();
  } catch (e) {
    // Fallback if fetch fails (offline, first load)
    affirmationsData = {
      categories: { faith: 'אמונה והשגחה' },
      affirmations: [
        { text: 'הכל מדויק לי', category: 'faith' },
        { text: 'אני בדיוק במקום הנכון', category: 'faith' }
      ]
    };
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
    pool = affirmationsData.affirmations.concat(
      getPersonalAffirmations().map(text => ({ text, category: 'personal' }))
    ).filter(a => favs.includes(a.text));
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
      ? 'משפט אישי'
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

// ===== Event Listeners =====
function setupEventListeners() {
  // New affirmation button
  document.getElementById('newAffirmationBtn').addEventListener('click', showRandomAffirmation);

  // Category chips
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
    // Replace with your actual PayPal/Buy Me a Coffee link
    window.open('https://buymeacoffee.com/uriel.zion', '_blank', 'noopener,noreferrer');
  });

  // Settings
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsClose').addEventListener('click', closeSettings);
  document.getElementById('settingsBackdrop').addEventListener('click', closeSettings);

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

    // Update camera affirmation text
    document.getElementById('cameraAffirmation').textContent = currentAffirmation.text;
  } catch (err) {
    alert('לא ניתן לגשת למצלמה. אנא אפשר גישה למצלמה בהגדרות הדפדפן.');
  }
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
  const shareText = `"${text}"\n\nאמירות חיוביות יומיות 👉 ${appUrl}`;
  const shareData = {
    title: 'אמירות חיוביות',
    text: shareText,
    url: appUrl,
  };

  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch (err) {
      // User cancelled share
    }
  } else {
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(shareText);
      showToast('המשפט הועתק! אפשר להדביק ולשתף');
    } catch (err) {
      // Fallback for older browsers
      prompt('העתק את המשפט:', shareText);
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

  // Mirror to Cache Storage so SW can read settings when app is closed
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
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    alert('הדפדפן שלך לא תומך בהתראות');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    showToast('התראות הופעלו בהצלחה! תקבל תזכורות בשעות שהגדרת');
    saveSettings();
    startReminderChecker();
    registerPeriodicSync(); // enable background notifications when app is closed
  } else {
    showToast('לא ניתנה הרשאה להתראות');
  }
}

// Register Periodic Background Sync so SW can fire reminders even when app is closed.
// Requires: installed PWA + Chrome on Android + good engagement score.
async function registerPeriodicSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    if (!('periodicSync' in registration)) return;

    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state === 'granted') {
      await registration.periodicSync.register('affirmation-reminder', {
        minInterval: 30 * 60 * 1000 // browser may fire less often based on engagement
      });
    }
  } catch (e) {
    // Not supported — polling fallback (startReminderChecker) still works when app is open
  }
}

// ===== Reminder Checker =====
// Checks every 30 seconds if it's time for a reminder
let reminderInterval = null;

function startReminderChecker() {
  if (reminderInterval) clearInterval(reminderInterval);

  // Check immediately on start
  checkReminders();

  // Then check every 30 seconds
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

  // Get already-sent reminders for today
  let sent = {};
  try {
    const sentData = localStorage.getItem('reminders-sent');
    sent = sentData ? JSON.parse(sentData) : {};
    // Reset if it's a new day
    if (sent._date !== today) {
      sent = { _date: today };
    }
  } catch {
    sent = { _date: today };
  }

  const periods = {
    morning: 'בוקר טוב!',
    noon: 'תזכורת צהריים',
    evening: 'ערב טוב!'
  };

  Object.entries(periods).forEach(([period, title]) => {
    if (!settings[period] || !settings[period].enabled) return;
    if (sent[period]) return; // Already sent today

    const reminderTime = settings[period].time;

    // Check if current time matches (within a 2-minute window)
    if (isTimeMatch(currentTime, reminderTime)) {
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
  // Match within a 2-minute window
  return currentMinutes >= targetMinutes && currentMinutes <= targetMinutes + 1;
}

function sendNotification(title, period) {
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SHOW_NOTIFICATION', title });
    // Tell SW this period was already handled — prevents duplicate from periodicSync
    if (period) {
      navigator.serviceWorker.controller.postMessage({ type: 'MARK_SENT', period });
    }
  } else {
    // Fallback: show notification directly
    new Notification(title, {
      body: currentAffirmation ? currentAffirmation.text : 'הכל מדויק לי',
      dir: 'rtl',
      lang: 'he'
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
    showToast('ניתן להוסיף עד 50 משפטים אישיים');
    return;
  }
  personal.push(text);
  localStorage.setItem('personal-affirmations', JSON.stringify(personal));

  input.value = '';
  renderPersonalList();

  // Show the new affirmation immediately on the main screen
  currentAffirmation = { text, category: 'personal' };
  const textEl = document.getElementById('affirmationText');
  const badgeEl = document.getElementById('currentCategory');
  textEl.classList.add('fade-out');
  setTimeout(() => {
    textEl.textContent = text;
    badgeEl.textContent = 'משפט אישי';
    textEl.classList.remove('fade-out');
    textEl.classList.add('fade-in');
    setTimeout(() => textEl.classList.remove('fade-in'), 50);
  }, 300);
  updateFavoriteBtn();
  showToast('המשפט נוסף ומוצג ✓');
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
    btn.setAttribute('aria-label', 'מחק');
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
      enabledCategories = Array.isArray(parsed) ? parsed : null;
    } else {
      enabledCategories = null; // null = all enabled
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

  const allCategories = Object.entries(affirmationsData.categories);
  const allEnabled = !enabledCategories; // null = all

  allCategories.forEach(([key, name]) => {
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
    if (cat === 'all') {
      chip.style.display = '';
      return;
    }
    if (!enabledCategories || enabledCategories.includes(cat)) {
      chip.style.display = '';
    } else {
      chip.style.display = 'none';
      // If this hidden chip was active, switch to "all"
      if (chip.classList.contains('active')) {
        chip.classList.remove('active');
        document.querySelector('.category-chip[data-category="all"]').classList.add('active');
        currentCategory = 'all';
      }
    }
  });
}

// ===== Service Worker =====
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      // Once SW is ready, mirror saved settings so background sync can read them
      await navigator.serviceWorker.ready;
      syncSettingsToSW();
    } catch (err) {
      console.log('Service Worker registration failed:', err);
    }
  }
}

// Push current localStorage settings into SW Cache Storage
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
    showToast('נשמר למועדפים ♥');
  } else {
    favs.splice(idx, 1);
    showToast('הוסר מהמועדפים');
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
  const hasFavs = getFavorites().length > 0;
  chip.style.display = hasFavs ? '' : 'none';
  if (!hasFavs && currentCategory === 'favorites') {
    currentCategory = 'all';
    document.querySelectorAll('.category-chip').forEach(c => c.classList.remove('active'));
    document.querySelector('.category-chip[data-category="all"]').classList.add('active');
  }
}

function exportFavorites() {
  const favs = getFavorites();
  if (favs.length === 0) {
    showToast('אין מועדפים לייצוא');
    return;
  }
  const text = 'המשפטים המועדפים שלי:\n\n' + favs.map((f, i) => `${i + 1}. ${f}`).join('\n');
  if (navigator.share) {
    navigator.share({ title: 'המועדפים שלי', text });
  } else {
    navigator.clipboard.writeText(text).then(() => showToast('המועדפים הועתקו ללוח ✓'));
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
  statusEl.textContent = 'מחפש עדכונים...';

  try {
    // Fetch sw.js fresh from network (bypass all caches)
    const response = await fetch('./sw.js?_=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('network');

    const text = await response.text();
    const match = text.match(/CACHE_NAME\s*=\s*['"]affirmations-v([\d.]+)['"]/);
    if (!match) throw new Error('parse');

    const latestVersion = match[1];
    const currentVersion = document.getElementById('appVersion').textContent.trim();

    const isNewer = compareVersions(latestVersion, currentVersion) > 0;

    if (isNewer) {
      statusEl.textContent = `עדכון זמין (${latestVersion}) – מנקה ומרענן...`;

      // Clear all caches
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }

      // Unregister SW so it reinstalls fresh
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.unregister();

      setTimeout(() => location.reload(true), 600);
    } else {
      statusEl.textContent = `✓ אתה בגרסה העדכונית (${currentVersion})`;
      btn.disabled = false;
    }
  } catch (e) {
    statusEl.textContent = 'שגיאה בבדיקה – בדוק חיבור לאינטרנט';
    btn.disabled = false;
  }
}