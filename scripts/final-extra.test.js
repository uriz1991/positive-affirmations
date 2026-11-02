#!/usr/bin/env node
// Rules checks from the final review of PR 20. Run under the emulator.
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, arrayRemove, deleteField } = require('firebase/firestore');

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

const list = (count, prefix = 'x') => Array.from({ length: count }, (_, i) => prefix + i);

async function main() {
  const env = await initializeTestEnvironment({
    projectId: 'demo-positive-affirmations',
    firestore: { rules: RULES, host: '127.0.0.1', port: 8080 }
  });
  const seed = (docPath, data) => env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), docPath), data);
  });
  const asUser = (uid) => env.authenticatedContext(uid).firestore();

  try {
    await seed('users/big', {
      journal: list(150),
      favorites: list(300),
      personalAffirmations: list(80),
      goalData: { goal: 'g'.repeat(900), steps: list(30) },
      fcmTokens: list(25, 't'),
      fcmTokenBound: { a: 1 }
    });
    const big = doc(asUser('big'), 'users/big');
    await check('big legacy doc: write not touching big fields', () => assertSucceeds(setDoc(big, { updatedAt: Date.now(), timezone: 'UTC' }, { merge: true })));
    await check('big legacy doc: clipped sync (new client) allowed', () => assertSucceeds(setDoc(big, {
      updatedAt: 1,
      journal: list(100),
      favorites: list(200),
      personalAffirmations: list(50),
      goalData: { goal: 'g'.repeat(500), steps: list(20) }
    }, { merge: true })));
    await seed('users/big2', { journal: list(150) });
    await check('OLD unclipped client re-sending 150 journal (unchanged) allowed (not affected key)', () => assertSucceeds(setDoc(doc(asUser('big2'), 'users/big2'), { updatedAt: 1, journal: list(150) }, { merge: true })));
    await check('OLD unclipped client adding entry to 150 journal DENIED (whole sync)', () => assertFails(setDoc(doc(asUser('big2'), 'users/big2'), { updatedAt: 1, journal: ['new', ...list(150)] }, { merge: true })));
    await check('goal 501 chars denied', () => assertFails(setDoc(big, { goalData: { goal: 'g'.repeat(501), steps: [] } }, { merge: true })));
    await check('goalData null allowed', () => assertSucceeds(setDoc(big, { goalData: null }, { merge: true })));
    await seed('users/tok', { fcmTokens: list(25, 't') });
    const tok = doc(asUser('tok'), 'users/tok');
    await check('fcm 25 -> 24 via arrayRemove allowed', () => assertSucceeds(setDoc(tok, { fcmTokens: arrayRemove('t0') }, { merge: true })));
    await check('fcm 24 -> 25 grow denied', () => assertFails(setDoc(tok, { fcmTokens: [...list(24, 't').slice(1), 't0', 'new'] }, { merge: true })));
    await check('fcm replace with 20 (saveFcmToken tx shape) + fcmTokenBound delete', () => assertSucceeds(setDoc(tok, {
      fcmTokens: list(20, 'n'),
      fcmTokenBound: { k1: Date.now(), old: deleteField() }
    }, { merge: true })));
    await check('fcm 21 on create denied', () => assertFails(setDoc(doc(asUser('new1'), 'users/new1'), { fcmTokens: list(21) }, { merge: true })));
    await check('referralIdentities unreadable', () => assertFails(getDoc(doc(asUser('big'), 'referralIdentities/abc'))));
    await check('referralMonthly own doc unreadable/unwritable', () => assertFails(setDoc(doc(asUser('big'), 'referralMonthly/big'), { count: 0 })));
    await check('client cannot write pendingCheckout/stripeCustomerReserved on subscriptions', () => assertFails(setDoc(doc(asUser('big'), 'subscriptions/big'), { stripeCustomerReserved: true }, { merge: true })));
  } finally {
    await env.cleanup();
  }

  if (fails) {
    console.log(fails + ' FAILED');
    process.exit(1);
  }
  console.log('all final checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
