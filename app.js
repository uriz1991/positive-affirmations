// ===== Positive Affirmations App =====

let affirmationsData = null;
let currentCategory = 'all';
let currentAffirmation = null;
let cameraStream = null;

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', async () => {
  await loadAffirmations();
  showRandomAffirmation();
  setupEventListeners();
  loadSettings();
  loadPersonalAffirmations();
  registerServiceWorker();
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

  // Add personal affirmations to pool
  const personal = getPersonalAffirmations();
  if (personal.length > 0) {
    pool = pool.concat(personal.map(text => ({ text, category: 'personal' })));
  }

  // Filter by category
  if (currentCategory !== 'all') {
    pool = pool.filter(a => a.category === currentCategory);
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

  // Notification button
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
  const shareData = {
    title: 'אמירות חיוביות',
    text: `"${text}" - מתוך אפליקציית אמירות חיוביות`,
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
      await navigator.clipboard.writeText(`"${text}" - מתוך אפליקציית אמירות חיוביות`);
      showToast('המשפט הועתק! אפשר להדביק ולשתף');
    } catch (err) {
      // Fallback for older browsers
      prompt('העתק את המשפט:', `"${text}"`);
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

  // Update service worker with new schedule
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'UPDATE_REMINDERS',
      settings
    });
  }
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
    showToast('התראות הופעלו בהצלחה!');
    saveSettings();
  } else {
    showToast('לא ניתנה הרשאה להתראות');
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

// ===== Service Worker =====
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (err) {
      console.log('Service Worker registration failed:', err);
    }
  }
}