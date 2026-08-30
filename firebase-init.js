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
  setDoc
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

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
  }
};

window.dispatchEvent(new Event('appauth-ready'));
