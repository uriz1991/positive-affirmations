import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAnalytics, logEvent } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as fbSignOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  arrayRemove,
  deleteField,
  collection,
  query,
  orderBy,
  limit,
  getDocs
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  getMessaging,
  getToken,
  onMessage
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js';
import {
  getFunctions,
  httpsCallable
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';

// Generated in Firebase Console → Project Settings → Cloud Messaging → Web configuration → Generate key pair.
// This is a public key, safe to ship in client code.
const VAPID_KEY = 'BEJBV-sQctztQOt3piWukn6KaXtqGWr0yT9_0GVhVSqpcVgc1xPu7xc1Z71KnKCv4vlz3nLoHhcv69VqJSZ550s';

const firebaseConfig = {
  apiKey: 'AIzaSyC0AFO8gOk1VizEGnuQBBaoEX6ddH-qyek',
  authDomain: 'positive-affirmations-9f382.firebaseapp.com',
  projectId: 'positive-affirmations-9f382',
  storageBucket: 'positive-affirmations-9f382.firebasestorage.app',
  messagingSenderId: '388138822180',
  appId: '1:388138822180:web:98e5d4297847947ffc06b1',
  measurementId: 'G-G7VJ1Y9H1L'
};

const firebaseApp = initializeApp(firebaseConfig);
const analytics = getAnalytics(firebaseApp);
const auth = getAuth(firebaseApp);
const provider = new GoogleAuthProvider();
const db = getFirestore(firebaseApp);
const messaging = getMessaging(firebaseApp);
const functions = getFunctions(firebaseApp, 'me-west1');
const createCheckoutSessionFn = httpsCallable(functions, 'createCheckoutSession');
const createPortalSessionFn = httpsCallable(functions, 'createPortalSession');
const generatePersonalPlanFn = httpsCallable(functions, 'generatePersonalPlan');
const redeemReferralFn = httpsCallable(functions, 'redeemReferral');
const deleteAccountFn = httpsCallable(functions, 'deleteAccount');

// Fields saveUserData may write. fcmTokens and fcmTokenBound are written
// only by saveFcmToken / removeFcmToken. Server-owned fields (isPro,
// referredBy, referralCount, aiGenCount, personalPlan, …) are not here.
function fcmBoundPatch(existing, nextTokens, newKey, select) {
  const patch = {};
  if (newKey) patch[newKey] = Date.now();
  if (select && select.tokenFieldKey) {
    existing.forEach((old) => {
      if (nextTokens.indexOf(old) !== -1) return;
      const oldKey = select.tokenFieldKey(old);
      if (oldKey && oldKey !== newKey) patch[oldKey] = deleteField();
    });
  }
  return Object.keys(patch).length ? patch : null;
}

function clipText(value, max) {
  return typeof value === 'string' && value.length > max ? value.slice(0, max) : value;
}

function clipStringList(list, maxItems, maxLen) {
  if (!Array.isArray(list)) return list;
  return list.slice(0, maxItems).map((item) => clipText(item, maxLen));
}

function clipGoalData(goalData) {
  if (goalData == null || typeof goalData !== 'object' || Array.isArray(goalData)) return goalData;
  const next = Object.assign({}, goalData);
  if (typeof next.goal === 'string') next.goal = clipText(next.goal, 500);
  if (Array.isArray(next.steps)) {
    next.steps = next.steps.slice(0, 20).map((step) => {
      if (!step || typeof step !== 'object') return step;
      const copy = Object.assign({}, step);
      copy.text = clipText(copy.text, 300);
      return copy;
    });
  }
  return next;
}

function fallbackFcmTokens(existing, token, limit) {
  const list = (Array.isArray(existing) ? existing : []).filter((item) => typeof item === 'string' && item);
  if (!token || list.indexOf(token) !== -1) return list.slice(0, limit);
  const room = list.length >= limit ? list.slice(list.length - (limit - 1)) : list.slice();
  room.push(token);
  return room;
}

const CLIENT_USER_FIELDS = [
  'goalData',
  'journal',
  'favorites',
  'personalAffirmations',
  'reminders',
  'timezone',
  'addressForm',
  'language'
];

window.AppAuth = {
  signIn: () => signInWithPopup(auth, provider),
  // Trusted Web Activity blocks window.open, so the Play build uses a redirect.
  signInWithRedirect: () => signInWithRedirect(auth, provider),
  getRedirectResult: () => getRedirectResult(auth),
  signOut: () => fbSignOut(auth),
  // Server deletes Firestore data and the Auth user. No client re-auth.
  deleteCloudAccount: async () => {
    const result = await deleteAccountFn();
    return result.data;
  },
  onChange: (callback) => onAuthStateChanged(auth, callback),
  logEvent: (name, params) => logEvent(analytics, name, params),
  loadUserData: async (uid) => {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? snap.data() : null;
  },
  // Must stay inside the firestore.rules clientUserFields() allowlist.
  // Unknown keys are dropped so one extra field cannot fail the whole sync.
  saveUserData: async (uid, data) => {
    const payload = { updatedAt: Date.now() };
    CLIENT_USER_FIELDS.forEach((key) => {
      if (!data || !Object.prototype.hasOwnProperty.call(data, key)) return;
      // null is not a map, and one null field used to reject the whole sync.
      if (key === 'goalData' && data[key] == null) return;
      if (key === 'goalData') payload.goalData = clipGoalData(data.goalData);
      else if (key === 'journal') payload.journal = clipStringList(data.journal, 100, 300);
      else if (key === 'favorites') payload.favorites = clipStringList(data.favorites, 200, 500);
      else if (key === 'personalAffirmations') payload.personalAffirmations = clipStringList(data.personalAffirmations, 50, 500);
      else if (key === 'reminders') payload.reminders = Array.isArray(data.reminders) ? data.reminders.slice(0, 30) : data.reminders;
      else payload[key] = data[key];
    });
    await setDoc(doc(db, 'users', uid), payload, { merge: true });
  },
  saveFcmToken: async (uid, token) => {
    const ref = doc(db, 'users', uid);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const existing = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];
      const bound = data.fcmTokenBound && typeof data.fcmTokenBound === 'object' ? data.fcmTokenBound : null;
      const select = window.NotificationSelect;
      const nextTokens = select && select.fcmTokensForSave
        ? select.fcmTokensForSave(existing, bound, token, 20)
        : fallbackFcmTokens(existing, token, 20);
      const key = select && select.tokenFieldKey ? select.tokenFieldKey(token) : null;
      const patch = { fcmTokens: nextTokens };
      const boundPatch = fcmBoundPatch(existing, nextTokens, key, select);
      if (boundPatch) patch.fcmTokenBound = boundPatch;
      tx.set(ref, patch, { merge: true });
    });
  },
  removeFcmToken: async (uid, token) => {
    const select = window.NotificationSelect;
    const key = select && select.tokenFieldKey ? select.tokenFieldKey(token) : null;
    const patch = { fcmTokens: arrayRemove(token) };
    if (key) patch.fcmTokenBound = { [key]: deleteField() };
    await setDoc(doc(db, 'users', uid), patch, { merge: true });
  },
  getFcmToken: async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      return await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    } catch {
      return null;
    }
  },
  onForegroundMessage: (callback) => onMessage(messaging, callback),
  loadGeneratedAffirmations: async () => {
    const q = query(collection(db, 'generated-affirmations'), orderBy('createdAt', 'desc'), limit(300));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data());
  },
  loadPopularAffirmations: async () => {
    const snap = await getDoc(doc(db, 'stats', 'popular-affirmations'));
    return snap.exists() ? (snap.data().top || []) : [];
  },
  loadSubscriptionStatus: async (uid) => {
    const snap = await getDoc(doc(db, 'subscriptions', uid));
    if (!snap.exists()) return { isPro: false, bonusUntil: null };
    const data = snap.data();
    const bonusUntil = data.bonusProUntil?.toDate?.() || null;
    const bonusActive = bonusUntil && bonusUntil.getTime() > Date.now();
    return { isPro: !!data.isPro || !!bonusActive, bonusUntil: bonusActive ? bonusUntil : null };
  },
  startCheckout: async (priceId) => {
    const result = await createCheckoutSessionFn({ priceId });
    return result.data.url;
  },
  startPortalSession: async () => {
    const result = await createPortalSessionFn();
    return result.data.url;
  },
  generatePersonalPlan: async () => {
    const result = await generatePersonalPlanFn();
    return result.data;
  },
  redeemReferral: async (referrerUid) => {
    const result = await redeemReferralFn({ referrerUid });
    return result.data;
  }
};

window.dispatchEvent(new Event('appauth-ready'));
