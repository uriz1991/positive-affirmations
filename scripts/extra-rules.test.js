#!/usr/bin/env node
// Mirrors the client write shapes in firebase-init.js.
// Run under the Firestore emulator (npm run test:rules).
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, arrayUnion, arrayRemove } = require('firebase/firestore');

const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
let fails = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (err) {
    fails++;
    console.log('FAIL ' + name + ' :: ' + String(err && err.message).split('\n')[0]);
  }
}

const tokens = (count) => Array.from({ length: count }, (_, i) => 'tok' + i);

async function main() {
  const env = await initializeTestEnvironment({
    projectId: 'demo-positive-affirmations',
    firestore: { rules: RULES, host: '127.0.0.1', port: 8080 }
  });
  const seed = (docPath, data) => env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), docPath), data);
  });
  const as = (uid) => env.authenticatedContext(uid).firestore();
  const sync = (lang = 'he') => ({
    updatedAt: Date.now(),
    goalData: { goal: '', steps: [] },
    journal: [],
    favorites: [],
    personalAffirmations: [],
    reminders: [{ id: 'r', time: '08:00', enabled: true }],
    timezone: 'Asia/Jerusalem',
    addressForm: 'm',
    language: lang
  });

  try {
    await check('saveUserData merge on missing doc (first sign-in)', () => assertSucceeds(setDoc(doc(as('u1'), 'users/u1'), sync(), { merge: true })));
    await check('saveFcmToken merge on missing doc (token before first sync)', () => assertSucceeds(setDoc(doc(as('u2'), 'users/u2'), { fcmTokens: arrayUnion('t1'), fcmTokenBound: { tabc: Date.now() } }, { merge: true })));
    await check('saveFcmToken merge on existing doc', () => assertSucceeds(setDoc(doc(as('u1'), 'users/u1'), { fcmTokens: arrayUnion('t2'), fcmTokenBound: { txyz: Date.now() } }, { merge: true })));
    await check('removeFcmToken', () => assertSucceeds(setDoc(doc(as('u1'), 'users/u1'), { fcmTokens: arrayRemove('t2') }, { merge: true })));
    await seed('users/legacy', {
      settings: { a: 1 },
      fcmTokenBoundAt: 5,
      referredBy: 'x',
      aiGenCount: 3,
      aiGenDate: '2026-11-02',
      personalPlan: {},
      weeklyCoach: {},
      remindersSentToday: {},
      notificationRecentIds: [],
      referralCount: 2,
      language: 'xx',
      fcmTokens: tokens(25)
    });
    await check('sync on legacy doc with server fields, odd stored language and 25 tokens', () => assertSucceeds(setDoc(doc(as('legacy'), 'users/legacy'), { updatedAt: Date.now(), favorites: ['a'] }, { merge: true })));
    await check('EDGE: full sync on legacy doc (rewrites language) works', () => assertSucceeds(setDoc(doc(as('legacy'), 'users/legacy'), sync('he'), { merge: true })));
    await check('EDGE: saveFcmToken when doc already has 25 tokens (expected DENY)', () => assertFails(setDoc(doc(as('legacy'), 'users/legacy'), { fcmTokens: arrayUnion('new'), fcmTokenBound: { tn: 1 } }, { merge: true })));
    await check('EDGE: removeFcmToken when doc has 25 tokens shrinks the list', () => assertSucceeds(setDoc(doc(as('legacy'), 'users/legacy'), { fcmTokens: arrayRemove('tok0') }, { merge: true })));
    await check('language outside allowlist denied', () => assertFails(setDoc(doc(as('u1'), 'users/u1'), { language: 'ar', updatedAt: 1 }, { merge: true })));
    await seed('users/ref', { referralCount: 1 });
    await check('client sync after server created doc with only referralCount', () => assertSucceeds(setDoc(doc(as('ref'), 'users/ref'), sync(), { merge: true })));
    await check('client cannot touch referralCount', () => assertFails(setDoc(doc(as('ref'), 'users/ref'), { referralCount: 99 }, { merge: true })));
    await check('client cannot remove referredBy via full overwrite', async () => {
      await seed('users/r2', { referredBy: 'x', favorites: [] });
      await assertFails(setDoc(doc(as('r2'), 'users/r2'), { favorites: [] }));
    });
    await seed('deletedAccounts/gone', { status: 'done' });
    await check('tombstone done blocks merge write', () => assertFails(setDoc(doc(as('gone'), 'users/gone'), sync(), { merge: true })));
    await check('unauthenticated read of stats allowed', () => assertSucceeds(getDoc(doc(env.unauthenticatedContext().firestore(), 'stats/popular-affirmations'))));
    await check('usage/referrals unreadable by owner', () => assertFails(getDoc(doc(as('u1'), 'usage/u1'))));
  } finally {
    await env.cleanup();
  }

  if (fails) {
    console.log(fails + ' FAILED');
    process.exit(1);
  }
  console.log('all extra checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
