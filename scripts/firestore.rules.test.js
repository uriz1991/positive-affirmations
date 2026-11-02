#!/usr/bin/env node
// Run under the Firestore emulator:
//   firebase emulators:exec --only firestore --project demo-positive-affirmations \
//     "node scripts/firestore.rules.test.js"
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} = require('@firebase/rules-unit-testing');
const {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove
} = require('firebase/firestore');

const PROJECT_ID = 'demo-positive-affirmations';
const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

const profile = {
  goalData: { goal: 'לסיים את הקורס', steps: [{ text: 'פרק 1', done: false }] },
  journal: ['רגע אמונה'],
  favorites: ['asmdeaj'],
  personalAffirmations: ['משפט אישי שנשאר אצלי'],
  reminders: [{ id: 'r1', time: '08:00', enabled: true, label: 'בוקר' }],
  timezone: 'Asia/Jerusalem',
  addressForm: 'f',
  language: 'he',
  updatedAt: Date.now()
};

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log('ok  ' + name);
    })
    .catch((err) => {
      failures++;
      console.log('FAIL ' + name);
      console.log('    ' + (err && err.message));
    });
}

async function seed(env, writes) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [pathName, data] of writes) {
      await setDoc(doc(db, pathName), data);
    }
  });
}

async function main() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: RULES }
  });

  try {
    await check('a signed-in user can create and update profile, favorites, journal, reminders, and settings', async () => {
      const alice = env.authenticatedContext('alice').firestore();
      await assertSucceeds(setDoc(doc(alice, 'users/alice'), profile));
      await assertSucceeds(updateDoc(doc(alice, 'users/alice'), {
        favorites: ['asmdeaj', 'aagxdaa'],
        journal: ['רגע אמונה', 'עוד אחד'],
        language: 'en',
        addressForm: 'm',
        timezone: 'Europe/Paris',
        updatedAt: Date.now()
      }));
      const saved = await assertSucceeds(getDoc(doc(alice, 'users/alice')));
      if (saved.data().language !== 'en') throw new Error('language was not saved');
      if (saved.data().favorites.length !== 2) throw new Error('favorites were not saved');
    });

    await check('a null goal does not reject the rest of the sync', async () => {
      const alice = env.authenticatedContext('alice').firestore();
      await assertSucceeds(setDoc(doc(alice, 'users/alice'), {
        goalData: null,
        favorites: ['asmdeaj'],
        updatedAt: Date.now()
      }, { merge: true }));
      const saved = await getDoc(doc(alice, 'users/alice'));
      if (!saved.data().favorites || saved.data().favorites[0] !== 'asmdeaj') {
        throw new Error('favorites were dropped with a null goal');
      }
    });

    await check('fcm token add and remove are allowed', async () => {
      const alice = env.authenticatedContext('alice').firestore();
      await assertSucceeds(setDoc(doc(alice, 'users/alice'), {
        fcmTokens: arrayUnion('token-a'),
        fcmTokenBound: { tabc: Date.now() }
      }, { merge: true }));
      await assertSucceeds(setDoc(doc(alice, 'users/alice'), {
        fcmTokens: arrayRemove('token-a')
      }, { merge: true }));
    });

    await check('existing server fields do not block a normal sync', async () => {
      await seed(env, [[
        'users/carol',
        { referredBy: 'bbbbbbbbbbbbbbbbbbbb', aiGenCount: 4, aiGenDate: '2026-11-02', favorites: ['old'] }
      ]]);
      const carol = env.authenticatedContext('carol').firestore();
      await assertSucceeds(setDoc(doc(carol, 'users/carol'), {
        favorites: ['asmdeaj'],
        updatedAt: Date.now()
      }, { merge: true }));
      const saved = await getDoc(doc(carol, 'users/carol'));
      if (saved.data().referredBy !== 'bbbbbbbbbbbbbbbbbbbb') throw new Error('server field was dropped');
    });

    await check('the owner cannot write billing, referral, or gemini counter fields', async () => {
      const alice = env.authenticatedContext('alice').firestore();
      await assertFails(updateDoc(doc(alice, 'users/alice'), { isPro: true }));
      await assertFails(updateDoc(doc(alice, 'users/alice'), { referredBy: 'bbbbbbbbbbbbbbbbbbbb' }));
      await assertFails(updateDoc(doc(alice, 'users/alice'), { referralCount: 99 }));
      await assertFails(updateDoc(doc(alice, 'users/alice'), { aiGenCount: 0, aiGenDate: '2026-11-02' }));
      await assertFails(updateDoc(doc(alice, 'users/alice'), { personalPlan: { affirmations: ['x'] } }));
      await assertFails(updateDoc(doc(alice, 'users/alice'), { stripeCustomerId: 'cus_evil' }));
      await assertFails(setDoc(doc(alice, 'subscriptions/alice'), { isPro: true }));
      await assertFails(setDoc(doc(alice, 'usage/alice'), { aiGenCount: 0 }));
      await assertFails(setDoc(doc(alice, 'referrals/alice'), { referrerUid: 'bbbbbbbbbbbbbbbbbbbb' }));
    });

    await check('a user cannot delete their doc', async () => {
      const alice = env.authenticatedContext('alice').firestore();
      await assertFails(deleteDoc(doc(alice, 'users/alice')));
    });

    await check('a deleted account cannot recreate or update the user doc', async () => {
      await seed(env, [
        ['deletedAccounts/dave', { status: 'done' }],
        ['users/erin', { favorites: ['asmdeaj'] }],
        ['deletedAccounts/erin', { status: 'pending' }]
      ]);
      const dave = env.authenticatedContext('dave').firestore();
      await assertFails(setDoc(doc(dave, 'users/dave'), profile));
      const erin = env.authenticatedContext('erin').firestore();
      await assertFails(updateDoc(doc(erin, 'users/erin'), { favorites: ['aagxdaa'], updatedAt: Date.now() }));
    });

    await check('there are no cross-user reads or writes', async () => {
      const alice = env.authenticatedContext('alice').firestore();
      await assertFails(getDoc(doc(alice, 'users/carol')));
      await assertFails(getDoc(doc(alice, 'subscriptions/carol')));
      await assertFails(setDoc(doc(alice, 'users/carol'), { favorites: ['nope'] }, { merge: true }));
      await assertFails(getDoc(doc(alice, 'deletedAccounts/dave')));
      await assertFails(getDoc(doc(alice, 'referrals/alice')));
      await assertFails(getDoc(doc(alice, 'usage/alice')));
      await assertFails(getDoc(doc(alice, 'stripeCustomers/cus_123')));
    });

    await check('the owner can read their own subscription and nobody writes public docs', async () => {
      await seed(env, [['subscriptions/alice', { isPro: true }]]);
      const alice = env.authenticatedContext('alice').firestore();
      const sub = await assertSucceeds(getDoc(doc(alice, 'subscriptions/alice')));
      if (!sub.data().isPro) throw new Error('owner could not read isPro');
      await assertFails(setDoc(doc(alice, 'stats/popular-affirmations'), { top: [] }));
      await assertFails(setDoc(doc(alice, 'generated-affirmations/x'), { text: 'spam' }));
      const anon = env.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(anon, 'users/alice')));
      await assertSucceeds(getDoc(doc(anon, 'stats/popular-affirmations')));
    });
  } finally {
    await env.cleanup();
  }

  if (failures) {
    console.log(failures + ' failed');
    process.exit(1);
  }
  console.log('all firestore rules checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
