#!/usr/bin/env node
// Exercises the shared reminder picker: no repeats across 20 morning picks,
// noon steps, and the evening question. Run: node scripts/notification-select.test.js
const assert = require('assert');
const {
  pickFromPool,
  slotForReminder,
  shouldSkipLocalReminders,
  buildLocalizedPool,
  personalTextsForLanguage,
  favoriteStorageKey,
  isFavoriteEntry,
  withoutFavorite,
  favoriteDisplayText,
  assignTokenOwners,
  tokensForUser,
  tokenFieldKey
} = require('../shared/notification-select');
const { localizedPoolDoc } = require('./build-localized-pools');
const pool = require('../data/notification-pool.json').items;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
  } catch (err) {
    failures++;
    console.log('FAIL ' + name);
    console.log('    ' + err.message);
  }
}

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function picks(slot, count, extra) {
  const random = mulberry32(extra && extra.seed || 7);
  let history = (extra && extra.history) || [];
  const out = [];
  for (let i = 0; i < count; i++) {
    const picked = pickFromPool({
      pool,
      slot,
      history,
      addressForm: extra && extra.addressForm,
      personalTexts: extra && extra.personalTexts,
      personalRate: extra && extra.personalRate,
      random
    });
    assert.ok(picked, 'picker returned nothing for ' + slot);
    history = picked.history;
    out.push(picked);
  }
  return out;
}

check('morning / noon / evening from id and from hour', () => {
  assert.strictEqual(slotForReminder({ id: 'default-morning', time: '22:00' }), 'morning');
  assert.strictEqual(slotForReminder({ id: 'default-noon', time: '08:00' }), 'noon');
  assert.strictEqual(slotForReminder({ id: 'default-evening', time: '08:00' }), 'evening');
  assert.strictEqual(slotForReminder({ id: 'custom', time: '08:30', label: 'בוקר' }), 'morning');
  assert.strictEqual(slotForReminder({ id: 'r9', time: '13:00' }), 'noon');
  assert.strictEqual(slotForReminder({ id: 'r9', time: '21:15' }), 'evening');
  assert.strictEqual(slotForReminder({ id: 'r9', time: '06:00' }), 'morning');
});

check('20 morning picks do not repeat', () => {
  const morning = picks('morning', 20, { personalRate: 0, seed: 11 });
  const ids = morning.map((row) => row.id);
  assert.strictEqual(new Set(ids).size, 20, 'repeated id in ' + ids.join(','));
  morning.forEach((row) => {
    assert.strictEqual(row.slot, 'morning');
    assert.ok(row.text && row.text.length > 8, row.text);
  });
  console.log('    morning sample:', morning.slice(0, 3).map((row) => row.text).join(' | '));
});

check('noon is today\'s step, unique until the 17 steps run out', () => {
  const noon = picks('noon', 17, { personalRate: 0, seed: 3 });
  const ids = noon.map((row) => row.id);
  assert.strictEqual(new Set(ids).size, 17);
  noon.forEach((row) => {
    assert.strictEqual(row.kind, 'step');
    assert.ok(!row.text.includes('מה עשית היום בפועל'), row.text);
  });
  const eighteenth = picks('noon', 18, { personalRate: 0, seed: 3 });
  assert.strictEqual(eighteenth[17].id, eighteenth[0].id, '18th noon pick should be the oldest step');
  console.log('    noon sample:', noon[0].text);
});

check('evening asks what you actually did, even after it was just sent', () => {
  const first = picks('evening', 1, { personalRate: 0, seed: 1 })[0];
  assert.ok(first.text.startsWith('מה עשית היום בפועל'), first.text);
  const again = picks('evening', 1, { personalRate: 0, seed: 1, history: [first.id] })[0];
  assert.strictEqual(again.text, first.text);
  console.log('    evening:', first.text);
});

check('female address form uses textF', () => {
  const sample = pool.find((item) => item.slot === 'morning' && item.textF && item.textF !== item.text);
  assert.ok(sample, 'expected at least one gendered morning line');
  const picked = pickFromPool({
    pool: [sample],
    slot: 'morning',
    history: [],
    addressForm: 'f',
    personalRate: 0,
    random: () => 0
  });
  assert.strictEqual(picked.text, sample.textF);
  const male = pickFromPool({
    pool: [sample],
    slot: 'morning',
    history: [],
    addressForm: 'm',
    personalRate: 0,
    random: () => 0
  });
  assert.strictEqual(male.text, sample.text);
  console.log('    female:', picked.text);
});

check('a personal sentence is occasional, not every pick', () => {
  const always = picks('morning', 8, { personalRate: 1, personalTexts: ['המשפט האישי שלי לבדיקה'], seed: 5 });
  assert.ok(always.every((row) => row.slot === 'personal'));
  assert.ok(always.every((row) => row.text === 'המשפט האישי שלי לבדיקה'));
  const never = picks('morning', 8, { personalRate: 0, personalTexts: ['המשפט האישי שלי לבדיקה'], seed: 5 });
  assert.ok(never.every((row) => row.slot === 'morning'));
});

check('local reminders stay on unless the signed-in user saved the token', () => {
  assert.strictEqual(shouldSkipLocalReminders({ signedIn: false, currentUid: null, serverUid: 'uid-a' }), false);
  assert.strictEqual(shouldSkipLocalReminders({ signedIn: true, currentUid: 'uid-a', serverUid: null }), false);
  assert.strictEqual(shouldSkipLocalReminders({ signedIn: true, currentUid: 'uid-b', serverUid: 'uid-a' }), false);
  assert.strictEqual(shouldSkipLocalReminders({ signedIn: false, currentUid: null, serverUid: null }), false);
  assert.strictEqual(shouldSkipLocalReminders({ signedIn: true, currentUid: 'uid-a', serverUid: 'uid-a' }), true);
});

check('non-Hebrew pools never include Hebrew', () => {
  const affirmations = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../data/affirmations-en.json'), 'utf8')).affirmations;
  const evening = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../locales/en.json'), 'utf8')).journalDesc;
  const localized = buildLocalizedPool(affirmations.concat([{ text: 'אני מאמין בעצמי' }]), evening);
  assert.ok(localized.length > 10);
  localized.forEach((item) => {
    assert.ok(!/[\u0590-\u05FF]/.test(item.text), item.text);
    assert.ok(item.slot === 'morning' || item.slot === 'noon' || item.slot === 'evening');
  });
  const eveningItem = localized.find((item) => item.slot === 'evening');
  assert.strictEqual(eveningItem.text, evening);
  assert.ok(eveningItem.text.startsWith('What did you actually do today'));
  const morning = pickFromPool({ pool: localized, slot: 'morning', history: [], personalRate: 0, random: () => 0 });
  assert.ok(!/[\u0590-\u05FF]/.test(morning.text), morning.text);
  const dropped = personalTextsForLanguage(['שלום', 'A step I wrote'], 'en');
  assert.deepStrictEqual(dropped, ['A step I wrote']);
  console.log('    english evening:', eveningItem.text);
});

check('favorites keep an id and still match older text entries', () => {
  const item = { id: 'a1', text: 'אני חושב בגדול', textF: 'אני חושבת בגדול' };
  assert.strictEqual(favoriteStorageKey(item), 'a1');
  assert.strictEqual(isFavoriteEntry(['אני חושב בגדול'], item), true);
  assert.strictEqual(isFavoriteEntry(['a1'], item), true);
  assert.strictEqual(isFavoriteEntry(['אני חושבת בגדול'], item), true);
  assert.strictEqual(isFavoriteEntry(['something else'], item), false);
  assert.deepStrictEqual(withoutFavorite(['a1', 'אני חושב בגדול', 'keep me'], item), ['keep me']);
  const list = [item];
  assert.strictEqual(favoriteDisplayText('a1', list, 'f'), 'אני חושבת בגדול');
  assert.strictEqual(favoriteDisplayText('אני חושב בגדול', list, 'f'), 'אני חושבת בגדול');
  assert.strictEqual(favoriteDisplayText('אני חושב בגדול', list, 'm'), 'אני חושב בגדול');
  assert.strictEqual(favoriteDisplayText('a sentence with no match', list, 'f'), 'a sentence with no match');
  const hebrew = [{ id: 'asmdeaj', text: 'אני סומך על התהליך', textF: 'אני סומכת על התהליך' }];
  const english = [{ id: 'en1', text: 'I trust the process' }];
  assert.strictEqual(
    favoriteDisplayText('asmdeaj', english, 'm', { fallbackAffirmations: hebrew }),
    'אני סומך על התהליך'
  );
  assert.strictEqual(
    favoriteDisplayText('asmdeaj', english, 'f', { fallbackAffirmations: hebrew }),
    'אני סומכת על התהליך'
  );
  assert.strictEqual(favoriteDisplayText('asmdeaj', english, 'm'), '');
});

check('bundled language pools match build-localized-pools.js', () => {
  const fs = require('fs');
  const path = require('path');
  for (const lang of ['en', 'fr', 'es']) {
    const bundled = fs.readFileSync(path.join(__dirname, '../functions', `notification-pool-${lang}.json`), 'utf8');
    const fresh = JSON.stringify(localizedPoolDoc(lang), null, 2) + '\n';
    assert.strictEqual(bundled, fresh, lang + ' pool drifted from build-localized-pools.js');
  }
});

check('a device token stays with the newest signed-in user', () => {
  const phone = 'phone-token';
  const laptop = 'laptop-token';
  const phoneKey = tokenFieldKey(phone);
  const laptopKey = tokenFieldKey(laptop);
  const owners = assignTokenOwners([
    {
      uid: 'user-a',
      fcmTokens: [phone, laptop],
      fcmTokenBoundAt: 900,
      fcmTokenBound: { [laptopKey]: 1000 }
    },
    {
      uid: 'user-b',
      fcmTokens: [phone],
      fcmTokenBound: { [phoneKey]: 400 }
    }
  ]);
  assert.strictEqual(owners.get(phone).uid, 'user-b');
  assert.strictEqual(owners.get(laptop).uid, 'user-a');
  const splitA = tokensForUser({ uid: 'user-a', fcmTokens: [phone, laptop] }, owners);
  assert.deepStrictEqual(splitA.stale, [phone]);
  assert.deepStrictEqual(splitA.owned, [laptop]);

  const legacySingle = assignTokenOwners([
    { uid: 'old', fcmTokens: ['only'], fcmTokenBoundAt: 10 },
    { uid: 'older', fcmTokens: ['only'], fcmTokenBoundAt: 5 }
  ]);
  assert.strictEqual(legacySingle.get('only').uid, 'old');

  const laptopRefresh = assignTokenOwners([
    { uid: 'user-a', fcmTokens: [phone, laptop], fcmTokenBoundAt: 900 },
    { uid: 'user-b', fcmTokens: [phone], fcmTokenBoundAt: 200 }
  ]);
  assert.strictEqual(laptopRefresh.get(phone).uid, 'user-b');
});

check('recent history stays capped at 40', () => {
  const rows = picks('morning', 50, { personalRate: 0, seed: 9 });
  assert.ok(rows[49].history.length <= 40);
  const recent = new Set(rows[49].history);
  assert.ok(!recent.has(rows[0].id) || rows.length <= 40);
});

if (failures) {
  console.log('\n' + failures + ' failed');
  process.exit(1);
}
console.log('\nall notification selection checks passed');
