#!/usr/bin/env node
// Exercises the shared reminder picker: no repeats across 20 morning picks,
// noon steps, and the evening question. Run: node scripts/notification-select.test.js
const assert = require('assert');
const { pickFromPool, slotForReminder } = require('../shared/notification-select');
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
