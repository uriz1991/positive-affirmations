#!/usr/bin/env node
// Run: node scripts/account-deletion.test.js
const assert = require('assert');
const {
  subscriptionNeedsCancel,
  idsToCancel,
  mayWriteSubscription,
  isMissingStripeCustomer
} = require('../functions/account-deletion');

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

check('active, trialing, and past_due subscriptions must be cancelled', () => {
  assert.strictEqual(subscriptionNeedsCancel('active'), true);
  assert.strictEqual(subscriptionNeedsCancel('trialing'), true);
  assert.strictEqual(subscriptionNeedsCancel('past_due'), true);
  assert.strictEqual(subscriptionNeedsCancel('unpaid'), true);
  assert.strictEqual(subscriptionNeedsCancel('paused'), true);
});

check('already-cancelled subscriptions are not cancelled again', () => {
  assert.strictEqual(subscriptionNeedsCancel('canceled'), false);
  assert.strictEqual(subscriptionNeedsCancel('incomplete_expired'), false);
});

check('only live subscription ids are returned', () => {
  const ids = idsToCancel([
    { id: 'sub_live', status: 'active' },
    { id: 'sub_done', status: 'canceled' },
    { id: 'sub_trial', status: 'trialing' },
    { status: 'active' },
    null
  ]);
  assert.deepStrictEqual(ids, ['sub_live', 'sub_trial']);
});

check('a webhook may write a subscription only while the account still exists', () => {
  assert.strictEqual(mayWriteSubscription(true, true), true);
  assert.strictEqual(mayWriteSubscription(false, true), false);
  assert.strictEqual(mayWriteSubscription(true, false), false);
  assert.strictEqual(mayWriteSubscription(false, false), false);
});

check('a missing Stripe customer is safe to treat as already deleted', () => {
  assert.strictEqual(isMissingStripeCustomer({ code: 'resource_missing' }), true);
  assert.strictEqual(isMissingStripeCustomer({ raw: { code: 'resource_missing' } }), true);
  assert.strictEqual(isMissingStripeCustomer({ code: 'rate_limit' }), false);
  assert.strictEqual(isMissingStripeCustomer(null), false);
});

if (failures) {
  console.log(failures + ' failed');
  process.exit(1);
}
console.log('account-deletion checks passed');
