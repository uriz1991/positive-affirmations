#!/usr/bin/env node
// Run: node scripts/security-policy.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ALLOWED_PRICE_IDS,
  isAllowedPrice,
  trialEligible,
  checkoutBlocked,
  shouldApplyBillingEvent,
  billingPatchFromSubscription
} = require('../functions/billing-policy');
const {
  REFERRAL_BONUS_DAYS,
  MAX_BONUS_DAYS,
  validReferrerUid,
  isNewAccount,
  nextBonusUntil,
  grantedBonusDays
} = require('../functions/referral-policy');
const { DAILY_GEN_LIMIT, claimQuota, releaseCount } = require('../functions/usage-quota');
const {
  catalogDisplayText,
  countCatalogFavorites,
  catalogTextsForPrompt
} = require('../functions/catalog-favorites');
const { buildCatalogIndex } = require('./build-catalog-index');

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

const DAY = 86400000;
const PRICE = ALLOWED_PRICE_IDS[0];

function stamp(ms) {
  return new Date(ms).toUTCString();
}

function sub(status, priceId) {
  return {
    id: 'sub_123',
    status,
    customer: 'cus_123',
    current_period_end: 1700000000,
    items: { data: [{ price: { id: priceId || PRICE } }] }
  };
}

check('checkout accepts only the server price allowlist', () => {
  assert.deepStrictEqual(ALLOWED_PRICE_IDS, ['price_1UAlkS5TpYQiqdPxShalBZVP']);
  assert.strictEqual(isAllowedPrice(PRICE), true);
  assert.strictEqual(isAllowedPrice('price_cheaper'), false);
  assert.strictEqual(isAllowedPrice(''), false);
  assert.strictEqual(isAllowedPrice(null), false);
});

check('a trial is offered once, and a referral bonus does not use it up', () => {
  assert.strictEqual(trialEligible(null), true);
  assert.strictEqual(trialEligible(undefined), true);
  assert.strictEqual(trialEligible({ bonusProUntil: 1 }), true);
  assert.strictEqual(trialEligible({ trialUsed: true, bonusProUntil: 1 }), false);
  assert.strictEqual(trialEligible({ stripeCustomerId: 'cus_1' }), false);
  assert.strictEqual(trialEligible({ stripeSubscriptionId: 'sub_1' }), false);
  assert.strictEqual(trialEligible({ status: 'canceled' }), false);
  assert.strictEqual(trialEligible({ isPro: true }), false);
});

check('an open subscription blocks another checkout; a canceled one does not', () => {
  assert.strictEqual(checkoutBlocked(null), false);
  assert.strictEqual(checkoutBlocked({ bonusProUntil: 1 }), false);
  assert.strictEqual(checkoutBlocked({ isPro: true }), true);
  assert.strictEqual(checkoutBlocked({ status: 'active' }), true);
  assert.strictEqual(checkoutBlocked({ status: 'trialing' }), true);
  assert.strictEqual(checkoutBlocked({ status: 'past_due' }), true);
  assert.strictEqual(checkoutBlocked({ status: 'unpaid' }), true);
  assert.strictEqual(checkoutBlocked({ status: 'paused' }), true);
  assert.strictEqual(checkoutBlocked({ status: 'canceled' }), false);
  assert.strictEqual(checkoutBlocked({ status: 'incomplete_expired' }), false);
});

check('an older billing event cannot overwrite a newer one', () => {
  assert.strictEqual(shouldApplyBillingEvent(null, 100), true);
  assert.strictEqual(shouldApplyBillingEvent({}, 100), true);
  assert.strictEqual(shouldApplyBillingEvent({ billingEventAt: 200 }, 200), true);
  assert.strictEqual(shouldApplyBillingEvent({ billingEventAt: 200 }, 150), false);
  assert.strictEqual(shouldApplyBillingEvent({ billingEventAt: 200 }, null), false);
});

check('only active and trialing on the allowlisted price stay Pro', () => {
  assert.strictEqual(billingPatchFromSubscription(sub('active'), 10).isPro, true);
  assert.strictEqual(billingPatchFromSubscription(sub('trialing'), 10).isPro, true);
  ['past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused'].forEach((status) => {
    const patch = billingPatchFromSubscription(sub(status), 10);
    assert.strictEqual(patch.isPro, false, status);
    assert.strictEqual(patch.malformed, false, status);
  });
  const rejected = billingPatchFromSubscription(sub('active', 'price_other'), 10);
  assert.strictEqual(rejected.isPro, false);
  assert.strictEqual(rejected.priceRejected, true);
  const missing = billingPatchFromSubscription({ id: 'sub_x', status: 'active', items: { data: [] } }, 10);
  assert.strictEqual(missing.malformed, true);
  const canceled = billingPatchFromSubscription(sub('canceled'), 10);
  assert.strictEqual(canceled.trialUsed, true);
  assert.strictEqual(canceled.status, 'canceled');
  assert.strictEqual(canceled.stripeCustomerId, 'cus_123');
});

check('referrer ids are alphanumeric and cannot be the caller or a path', () => {
  const self = 'aaaaaaaaaaaaaaaaaaaa';
  assert.strictEqual(validReferrerUid('bbbbbbbbbbbbbbbbbbbb', self), true);
  assert.strictEqual(validReferrerUid(self, self), false);
  assert.strictEqual(validReferrerUid('users/bbbbbbbbbbbbbbbbbbbb', self), false);
  assert.strictEqual(validReferrerUid('short', self), false);
  assert.strictEqual(validReferrerUid('bbbbbbbbbbbbbbbbbbbb/extra', self), false);
  assert.strictEqual(validReferrerUid('', self), false);
  assert.strictEqual(validReferrerUid(null, self), false);
});

check('only a first-session account created within a day can redeem', () => {
  const now = Date.parse('2026-11-02T12:00:00.000Z');
  assert.strictEqual(isNewAccount({
    creationTime: stamp(now - 60 * 1000),
    lastSignInTime: stamp(now - 60 * 1000)
  }, now), true);
  assert.strictEqual(isNewAccount({
    creationTime: stamp(now - 10 * 60 * 1000),
    lastSignInTime: stamp(now - 60 * 1000)
  }, now), true);
  assert.strictEqual(isNewAccount({
    creationTime: stamp(now - 2 * DAY),
    lastSignInTime: stamp(now - 2 * DAY)
  }, now), false);
  assert.strictEqual(isNewAccount({
    creationTime: stamp(now - 60 * 1000),
    lastSignInTime: stamp(now + 20 * 60 * 1000)
  }, now), false);
  assert.strictEqual(isNewAccount({}, now), false);
});

check('referral bonus stacks seven days and stops at a year', () => {
  const now = 1_700_000_000_000;
  const fresh = nextBonusUntil(0, now);
  assert.strictEqual(fresh.addedMs, REFERRAL_BONUS_DAYS * DAY);
  assert.strictEqual(grantedBonusDays(fresh.addedMs), 7);
  assert.strictEqual(fresh.untilMs, now + 7 * DAY);

  const stacked = nextBonusUntil(now + 3 * DAY, now);
  assert.strictEqual(stacked.untilMs, now + 10 * DAY);

  const nearCap = nextBonusUntil(now + (MAX_BONUS_DAYS - 1) * DAY, now);
  assert.strictEqual(nearCap.untilMs, now + MAX_BONUS_DAYS * DAY);
  assert.strictEqual(grantedBonusDays(nearCap.addedMs), 1);

  const capped = nextBonusUntil(now + (MAX_BONUS_DAYS + 10) * DAY, now);
  assert.strictEqual(capped.addedMs, 0);
  assert.strictEqual(grantedBonusDays(capped.addedMs), 0);
});

check('gemini quota is five per UTC day and ignores a lowered user-doc counter once usage exists', () => {
  assert.strictEqual(DAILY_GEN_LIMIT, 5);
  const today = '2026-11-02';
  const first = claimQuota(null, null, today, 5);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.next, 1);

  const seeded = claimQuota(null, { aiGenDate: today, aiGenCount: 5 }, today, 5);
  assert.strictEqual(seeded.ok, false);
  assert.strictEqual(seeded.count, 5);

  const yesterday = claimQuota(null, { aiGenDate: '2026-11-01', aiGenCount: 5 }, today, 5);
  assert.strictEqual(yesterday.ok, true);

  const serverWins = claimQuota(
    { aiGenDate: today, aiGenCount: 4 },
    { aiGenDate: today, aiGenCount: 0 },
    today,
    5
  );
  assert.strictEqual(serverWins.ok, true);
  assert.strictEqual(serverWins.next, 5);

  const exhausted = claimQuota({ aiGenDate: today, aiGenCount: 5 }, { aiGenCount: 0 }, today, 5);
  assert.strictEqual(exhausted.ok, false);
  assert.deepStrictEqual(releaseCount({ aiGenDate: today, aiGenCount: 1 }, today), {
    aiGenCount: 0,
    aiGenDate: today
  });
});

check('popular aggregation and the gemini prompt keep catalog lines only', () => {
  const index = require('../functions/catalog-index.json');
  const id = Object.keys(index.byId)[0];
  const catalogText = index.byId[id];
  const textF = Object.keys(index.texts).find((text) => text !== catalogText && !index.byId[text]);
  assert.ok(id && catalogText);
  assert.strictEqual(catalogDisplayText(id), catalogText);
  assert.strictEqual(catalogDisplayText(catalogText), catalogText);
  assert.strictEqual(catalogDisplayText('  ' + catalogText + '  '), catalogText);
  assert.strictEqual(catalogDisplayText('אני רוצה להבריא ולמצוא שקט'), null);
  assert.strictEqual(catalogDisplayText('buy cheap followers'), null);
  if (textF) assert.strictEqual(catalogDisplayText(textF), textF);

  const top = countCatalogFavorites([
    [id, catalogText, 'a private hope', textF].filter(Boolean),
    [id, 'another private line']
  ]);
  const texts = top.map((row) => row.text);
  assert.ok(texts.includes(catalogText));
  assert.strictEqual(texts.includes('a private hope'), false);
  assert.strictEqual(texts.includes('another private line'), false);
  const catalogRow = top.find((row) => row.text === catalogText);
  assert.strictEqual(catalogRow.count, 2);

  const prompt = catalogTextsForPrompt([
    { text: catalogText, count: 3 },
    { text: 'a private hope', count: 9 },
    { id, text: 'not even a real sentence', count: 1 }
  ]);
  assert.deepStrictEqual(prompt, [catalogText]);
});

check('the committed catalog index matches data/affirmations*.json', () => {
  const built = buildCatalogIndex((file) => fs.readFileSync(path.join(__dirname, '..', 'data', file), 'utf8'));
  const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'functions', 'catalog-index.json'), 'utf8'));
  assert.deepStrictEqual(committed.byId, built.byId);
  assert.deepStrictEqual(committed.texts, built.texts);
});

check('client Firestore writes stay inside the rules allowlist', () => {
  const root = path.join(__dirname, '..');
  const init = fs.readFileSync(path.join(root, 'firebase-init.js'), 'utf8');
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  const fields = init.match(/const CLIENT_USER_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(fields, 'CLIENT_USER_FIELDS missing');
  const names = [...fields[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepStrictEqual(names, [
    'goalData', 'journal', 'favorites', 'personalAffirmations',
    'reminders', 'timezone', 'addressForm', 'language'
  ]);
  names.concat(['updatedAt', 'fcmTokens', 'fcmTokenBound']).forEach((name) => {
    assert.ok(rules.includes("'" + name + "'"), name + ' missing from rules');
  });
  ['isPro', 'referredBy', 'referralCount', 'aiGenCount', 'aiGenDate', 'personalPlan', 'stripeCustomerId'].forEach((name) => {
    assert.strictEqual(names.includes(name), false, name);
  });

  const clientFiles = ['app.js', 'firebase-init.js', 'sw.js', 'init-lang.js', 'shared/play-build.js', 'shared/notification-select.js'];
  clientFiles.forEach((file) => {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    if (file !== 'firebase-init.js') {
      assert.strictEqual(src.includes('setDoc('), false, file + ' setDoc');
      assert.strictEqual(src.includes('updateDoc('), false, file + ' updateDoc');
    }
  });
  assert.strictEqual(init.includes('updateDoc('), false);
  const writes = init.match(/setDoc\([\s\S]*?\);/g) || [];
  assert.strictEqual(writes.length, 3);
});

check('callable errors do not echo Stripe or Gemini messages', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  assert.strictEqual(src.includes('Stripe error:'), false);
  assert.strictEqual(src.includes('AI generation failed: ${'), false);
  assert.strictEqual(src.includes('Webhook signature error:'), false);
  assert.ok(src.includes('Could not start checkout. Try again.'));
  assert.ok(src.includes('AI generation failed. Try again.'));
  assert.ok(src.includes("res.status(400).send('Invalid signature')"));
});

if (failures) {
  console.log(failures + ' failed');
  process.exit(1);
}
console.log('all security policy checks passed');
