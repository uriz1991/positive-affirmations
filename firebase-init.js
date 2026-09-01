import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAnalytics, logEvent } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  arrayUnion,
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

window.AppAuth = {
  signIn: () => signInWithPopup(auth, provider),
  signOut: () => fbSignOut(auth),
  onChange: (callback) => onAuthStateChanged(auth, callback),
  logEvent: (name, params) => logEvent(analytics, name, params),
  loadUserData: async (uid) => {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? snap.data() : null;
  },
  saveUserData: async (uid, data) => {
    await setDoc(doc(db, 'users', uid), { ...data, updatedAt: Date.now() }, { merge: true });
  },
  saveFcmToken: async (uid, token) => {
    await setDoc(doc(db, 'users', uid), { fcmTokens: arrayUnion(token) }, { merge: true });
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
