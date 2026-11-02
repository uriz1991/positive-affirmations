#!/usr/bin/env node
// Run: node scripts/security-policy.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ALLOWED_PRICE_IDS,
  isAllowedPrice,
  trialEligible,
  duplicateSubscriptionAction,
  storedSubscriptionDuplicatePlan,
  checkoutBlocked,
  CHECKOUT_SESSION_TTL_MS,
  checkoutExpiresAtSeconds,
  reserveCheckout,
  portalCustomerId,
  shouldApplyBillingEvent,
  billingPatchFromSubscription
} = require('../functions/billing-policy');
const {
  REFERRAL_BONUS_DAYS,
  MAX_BONUS_DAYS,
  validReferrerUid,
  isNewAccount,
  nextBonusUntil,
  grantedBonusDays,
  referralIdentityKeys,
  referralMonth,
  referralRedeemPlan,
  REFERRALS_PER_MONTH
} = require('../functions/referral-policy');
const { DAILY_GEN_LIMIT, claimQuota, releaseCount } = require('../functions/usage-quota');
const { clipPlanInput, geminiFailureRefundable, GOAL_MAX, JOURNAL_ENTRY_MAX } = require('../functions/prompt-limits');
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
  assert.strictEqual(trialEligible({ stripeCustomerId: 'cus_new', stripeCustomerReserved: true }), true);
  assert.strictEqual(trialEligible({ stripeSubscriptionId: 'sub_1' }), false);
  assert.strictEqual(trialEligible({ status: 'canceled' }), false);
  assert.strictEqual(trialEligible({ isPro: true }), false);
});

check('a second live subscription is cancelled instead of replacing the first', () => {
  const live = { stripeSubscriptionId: 'sub_first', status: 'active', isPro: true };
  assert.strictEqual(duplicateSubscriptionAction(live, { id: 'sub_first', status: 'active' }), 'apply');
  assert.strictEqual(duplicateSubscriptionAction(live, { id: 'sub_second', status: 'active' }), 'cancel-incoming');
  assert.strictEqual(duplicateSubscriptionAction(live, { id: 'sub_second', status: 'trialing' }), 'cancel-incoming');
  assert.strictEqual(duplicateSubscriptionAction(live, { id: 'sub_second', status: 'canceled' }), 'ignore');
  assert.strictEqual(duplicateSubscriptionAction(
    { stripeSubscriptionId: 'sub_old', status: 'canceled', isPro: false },
    { id: 'sub_new', status: 'active' }
  ), 'apply');
  assert.strictEqual(storedSubscriptionDuplicatePlan('active'), 'cancel-incoming');
  assert.strictEqual(storedSubscriptionDuplicatePlan('past_due'), 'cancel-stored');
  assert.strictEqual(storedSubscriptionDuplicatePlan('unpaid'), 'cancel-stored');
  assert.strictEqual(storedSubscriptionDuplicatePlan('canceled'), 'replace');
});

check('gemini credit is refunded only for transport, 5xx, and quota failures', () => {
  assert.strictEqual(geminiFailureRefundable({ status: 500 }), true);
  assert.strictEqual(geminiFailureRefundable({ status: 429, message: 'quota' }), true);
  assert.strictEqual(geminiFailureRefundable({ code: 'ECONNRESET' }), true);
  assert.strictEqual(geminiFailureRefundable({ message: 'fetch failed' }), true);
  assert.strictEqual(geminiFailureRefundable({ status: 400, message: 'bad request' }), false);
  assert.strictEqual(geminiFailureRefundable({ status: 200 }), false);
  assert.strictEqual(geminiFailureRefundable(new Error('Could not parse')), false);
  const clipped = clipPlanInput({
    goalData: { goal: 'x'.repeat(GOAL_MAX + 50), steps: [{ text: 'y'.repeat(400), done: true }] },
    journal: ['z'.repeat(JOURNAL_ENTRY_MAX + 20), 'kept']
  });
  assert.strictEqual(clipped.goal.length, GOAL_MAX);
  assert.ok(clipped.completedSteps[0].length <= 300);
  assert.ok(clipped.journal.every((line) => line.length <= JOURNAL_ENTRY_MAX));
  const newestFirst = Array.from({ length: 12 }, (_, i) => 'j' + i);
  const recent = clipPlanInput({ goalData: { goal: 'g', steps: [] }, journal: newestFirst });
  assert.strictEqual(recent.journal[0], 'j0');
  assert.strictEqual(recent.journal.length, 10);
  assert.strictEqual(recent.journal.includes('j11'), false);
});

check('one Google account cannot redeem again, and a referrer is capped per month', () => {
  const crypto = require('crypto');
  const key = 'test-referral-key';
  const record = {
    uid: 'firebase-uid-1',
    email: 'Person@Example.com',
    providerData: [{ providerId: 'google.com', uid: 'google-subject', email: 'Person@Example.com' }]
  };
  const again = referralIdentityKeys(record, key);
  assert.deepStrictEqual(again, referralIdentityKeys(record, key));
  assert.ok(again.length >= 1);
  const unsalted = crypto.createHash('sha256').update('google.com\ngoogle-subject').digest('hex');
  assert.notStrictEqual(again[0], unsalted);
  assert.notStrictEqual(again[0], referralIdentityKeys(record, 'other-key')[0]);
  assert.deepStrictEqual(referralIdentityKeys(record, ''), []);
  const deleted = referralIdentityKeys({
    uid: 'firebase-uid-2',
    email: 'person@example.com',
    providerData: [{ providerId: 'google.com', uid: 'google-subject', email: 'person@example.com' }]
  }, key);
  assert.deepStrictEqual(deleted, again);
  assert.strictEqual(referralMonth(Date.UTC(2026, 10, 2)), '2026-11');
  assert.strictEqual(referralRedeemPlan({
    identitiesExist: true, redemptionExists: false, legacyReferrer: '', monthData: null, month: '2026-11'
  }).action, 'already');
  assert.strictEqual(referralRedeemPlan({
    identitiesExist: false,
    redemptionExists: false,
    legacyReferrer: '',
    monthData: { month: '2026-11', count: REFERRALS_PER_MONTH },
    month: '2026-11'
  }).action, 'capped');
  assert.strictEqual(referralRedeemPlan({
    identitiesExist: false,
    redemptionExists: false,
    legacyReferrer: '',
    monthData: { month: '2026-10', count: 3 },
    month: '2026-11'
  }).action, 'grant');
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

check('checkout expiry stays at least 31 minutes ahead of creation', () => {
  assert.ok(CHECKOUT_SESSION_TTL_MS >= 31 * 60 * 1000);
  [0, 1, 999, 1000, 1500, 1_700_000_000_500].forEach((now) => {
    const expiresAt = checkoutExpiresAtSeconds(now);
    assert.strictEqual(Number.isInteger(expiresAt), true);
    const ahead = expiresAt * 1000 - now;
    assert.ok(ahead >= 31 * 60 * 1000, 'short by ' + (31 * 60 * 1000 - ahead) + 'ms at ' + now);
  });
  const created = Date.now();
  assert.ok(checkoutExpiresAtSeconds(created) * 1000 - created >= 31 * 60 * 1000);
});

check('an open checkout session is reused and does not burn the trial', () => {
  const now = 1_700_000_000_000;
  const fresh = reserveCheckout(null, now);
  assert.strictEqual(fresh.action, 'create');
  assert.strictEqual(fresh.trial, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(fresh, 'trialUsed'), false);

  const abandoned = {
    pendingCheckoutSessionId: 'cs_old',
    pendingCheckoutUrl: 'https://checkout.stripe.com/old',
    pendingCheckoutExpiresAt: now - 1
  };
  assert.strictEqual(trialEligible(abandoned), true);
  assert.strictEqual(reserveCheckout(abandoned, now).action, 'create');

  const open = reserveCheckout({
    pendingCheckoutSessionId: 'cs_live',
    pendingCheckoutUrl: 'https://checkout.stripe.com/live',
    pendingCheckoutExpiresAt: now + 60 * 1000
  }, now);
  assert.strictEqual(open.action, 'reuse');
  assert.strictEqual(open.url, 'https://checkout.stripe.com/live');
  assert.strictEqual(open.sessionId, 'cs_live');

  assert.strictEqual(reserveCheckout({ pendingCheckoutClaim: now + 1000 }, now).action, 'in-progress');
  assert.strictEqual(reserveCheckout({ pendingCheckoutClaim: now - 1 }, now).action, 'create');
});

check('past_due and unpaid customers can open the portal without being Pro', () => {
  assert.strictEqual(portalCustomerId({ status: 'past_due', isPro: false, stripeCustomerId: 'cus_due' }), 'cus_due');
  assert.strictEqual(portalCustomerId({ status: 'unpaid', isPro: false, stripeCustomerId: ' cus_unpaid ' }), 'cus_unpaid');
  assert.strictEqual(portalCustomerId({ status: 'past_due', isPro: false }), null);
  assert.strictEqual(reserveCheckout({ status: 'past_due', stripeCustomerId: 'cus_due' }, 1).action, 'blocked');
  assert.strictEqual(reserveCheckout({ status: 'unpaid', stripeCustomerId: 'cus_unpaid' }, 1).action, 'blocked');
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
  assert.ok(init.includes('runTransaction'));
  const writes = init.match(/setDoc\([\s\S]*?\);/g) || [];
  assert.strictEqual(writes.length, 2);
});

check('callable errors do not echo Stripe or Gemini messages', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  assert.strictEqual(src.includes('Stripe error:'), false);
  assert.strictEqual(src.includes('AI generation failed: ${'), false);
  assert.strictEqual(src.includes('Webhook signature error:'), false);
  assert.ok(src.includes('Could not start checkout. Try again.'));
  assert.ok(src.includes('AI generation failed. Try again.'));
  assert.ok(src.includes("res.status(400).send('Invalid signature')"));
  const trialWrites = src.match(/trialUsed:\s*true/g) || [];
  assert.strictEqual(trialWrites.length, 1);
  const createAt = src.indexOf('stripe.checkout.sessions.create');
  const stampedAt = src.lastIndexOf('checkoutExpiresAtSeconds(Date.now())', createAt);
  assert.ok(stampedAt !== -1 && stampedAt < createAt);
  assert.strictEqual(src.includes('checkoutExpiresAtSeconds(now)'), false);
  assert.ok(src.includes('pendingCheckoutExpiresAt: (session.expires_at || expiresAt) * 1000'));
  assert.ok(src.includes('pendingCheckoutSessionId: session.id'));
  assert.ok(src.includes('if (reservedQuota && refundQuota) await releaseQuota'));
  assert.ok(src.includes("idempotencyKey: 'customer-' + uid"));
  assert.ok(src.includes('stripe.subscriptions.retrieve(subId)'));
});

if (failures) {
  console.log(failures + ' failed');
  process.exit(1);
}
console.log('all security policy checks passed');
