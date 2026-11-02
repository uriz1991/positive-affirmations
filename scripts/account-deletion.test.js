#!/usr/bin/env node
// Run: node scripts/account-deletion.test.js
const assert = require('assert');
const {
  DELETION_STEP_ORDER,
  subscriptionNeedsCancel,
  idsToCancel,
  isMissingStripeCustomer,
  stripeCallFailure,
  checkoutDecision,
  nextDeletionStep,
  invoiceIdFromCheckoutSession,
  refundPlanFromInvoice,
  applyRefundPlan,
  blockedSenderUids
} = require('../functions/account-deletion');

let failures = 0;
const tests = [];
function check(name, fn) {
  tests.push({ name, fn });
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

check('a missing Stripe customer continues; any other error stops', () => {
  assert.strictEqual(isMissingStripeCustomer({ code: 'resource_missing' }), true);
  assert.strictEqual(isMissingStripeCustomer({ raw: { code: 'resource_missing' } }), true);
  assert.strictEqual(stripeCallFailure({ code: 'resource_missing' }), 'continue');
  assert.strictEqual(stripeCallFailure({ code: 'rate_limit' }), 'stop');
  assert.strictEqual(stripeCallFailure(null), 'stop');
});

check('checkout grants Pro unless the account deletion tombstone is pending or done', () => {
  assert.strictEqual(checkoutDecision(null), 'grant');
  assert.strictEqual(checkoutDecision(undefined), 'grant');
  assert.strictEqual(checkoutDecision(''), 'grant');
  assert.strictEqual(checkoutDecision('pending'), 'revoke-payment');
  assert.strictEqual(checkoutDecision('done'), 'revoke-payment');
});

check('deletion order cancels Stripe, marks pending, deletes data, then Auth last', () => {
  assert.deepStrictEqual(DELETION_STEP_ORDER, [
    'cancel-subscriptions',
    'mark-pending',
    'delete-firestore',
    'delete-stripe-customer',
    'delete-auth-user',
    'mark-done'
  ]);
  assert.ok(DELETION_STEP_ORDER.indexOf('delete-auth-user') > DELETION_STEP_ORDER.indexOf('delete-firestore'));
  assert.ok(DELETION_STEP_ORDER.indexOf('mark-pending') < DELETION_STEP_ORDER.indexOf('delete-firestore'));
  assert.strictEqual(DELETION_STEP_ORDER[DELETION_STEP_ORDER.length - 1], 'mark-done');
});

check('a retry resumes after the last successful step', () => {
  assert.strictEqual(nextDeletionStep({}), 'cancel-subscriptions');
  assert.strictEqual(nextDeletionStep({
    subscriptionsSettled: true
  }), 'mark-pending');
  assert.strictEqual(nextDeletionStep({
    subscriptionsSettled: true,
    tombstoneStatus: 'pending'
  }), 'delete-firestore');
  assert.strictEqual(nextDeletionStep({
    subscriptionsSettled: true,
    tombstoneStatus: 'pending',
    firestoreDeleted: true
  }), 'delete-stripe-customer');
  assert.strictEqual(nextDeletionStep({
    subscriptionsSettled: true,
    tombstoneStatus: 'pending',
    firestoreDeleted: true,
    customerSettled: true
  }), 'delete-auth-user');
  assert.strictEqual(nextDeletionStep({
    subscriptionsSettled: true,
    tombstoneStatus: 'pending',
    firestoreDeleted: true,
    customerSettled: true,
    authDeleted: true
  }), 'mark-done');
  assert.strictEqual(nextDeletionStep({
    subscriptionsSettled: true,
    tombstoneStatus: 'done',
    firestoreDeleted: true,
    customerSettled: true,
    authDeleted: true
  }), 'finished');
});

check('walking every step from empty reaches finished in the documented order', () => {
  const state = {};
  const seen = [];
  for (let i = 0; i < 8; i++) {
    const step = nextDeletionStep(state);
    seen.push(step);
    if (step === 'finished') break;
    if (step === 'cancel-subscriptions') state.subscriptionsSettled = true;
    else if (step === 'mark-pending') state.tombstoneStatus = 'pending';
    else if (step === 'delete-firestore') state.firestoreDeleted = true;
    else if (step === 'delete-stripe-customer') state.customerSettled = true;
    else if (step === 'delete-auth-user') state.authDeleted = true;
    else if (step === 'mark-done') state.tombstoneStatus = 'done';
  }
  assert.deepStrictEqual(seen, DELETION_STEP_ORDER.concat('finished'));
});

check('a subscription checkout refunds the invoice charge, not session.payment_intent', async () => {
  const session = {
    mode: 'subscription',
    payment_intent: null,
    invoice: 'in_paid'
  };
  assert.strictEqual(invoiceIdFromCheckoutSession(session), 'in_paid');
  const plan = refundPlanFromInvoice({
    id: 'in_paid',
    amount_paid: 1490,
    payment_intent: 'pi_paid'
  });
  assert.strictEqual(plan.action, 'refund');
  assert.strictEqual(plan.idempotencyKey, 'refund-in_paid');
  assert.strictEqual(plan.paymentIntentId, 'pi_paid');
  const calls = [];
  const outcome = await applyRefundPlan(plan, async (p) => {
    calls.push(p);
  });
  assert.strictEqual(outcome, 'refunded');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].idempotencyKey, 'refund-in_paid');
});

check('a trial invoice with amount_paid 0 is not refunded', async () => {
  const session = { mode: 'subscription', payment_intent: null, invoice: 'in_trial' };
  assert.strictEqual(invoiceIdFromCheckoutSession(session), 'in_trial');
  const plan = refundPlanFromInvoice({
    id: 'in_trial',
    amount_paid: 0,
    payment_intent: null
  });
  assert.strictEqual(plan.action, 'nothing-to-refund');
  let called = false;
  const outcome = await applyRefundPlan(plan, async () => { called = true; });
  assert.strictEqual(outcome, 'nothing-to-refund');
  assert.strictEqual(called, false);
});

check('charge_already_refunded is success and is not retried', async () => {
  const plan = refundPlanFromInvoice({
    id: 'in_again',
    amount_paid: 1490,
    charge: 'ch_1'
  });
  assert.strictEqual(plan.idempotencyKey, 'refund-in_again');
  const outcome = await applyRefundPlan(plan, async () => {
    const err = new Error('already refunded');
    err.code = 'charge_already_refunded';
    throw err;
  });
  assert.strictEqual(outcome, 'already-refunded');
});

check('a failed deletedAccounts read blocks every candidate send', () => {
  const candidates = ['u1', 'u2', 'u3'];
  const blocked = blockedSenderUids([], candidates, true);
  assert.strictEqual(blocked.size, 3);
  candidates.forEach((uid) => assert.strictEqual(blocked.has(uid), true));
  const ok = blockedSenderUids([{ id: 'u2', status: 'pending' }], candidates, false);
  assert.strictEqual(ok.has('u1'), false);
  assert.strictEqual(ok.has('u2'), true);
  assert.strictEqual(ok.has('u3'), false);
});

(async () => {
  for (const test of tests) {
    try {
      await test.fn();
      console.log('ok  ' + test.name);
    } catch (err) {
      failures++;
      console.log('FAIL ' + test.name);
      console.log('    ' + (err && err.message));
    }
  }
  if (failures) {
    console.log(failures + ' failed');
    process.exit(1);
  }
  console.log('account-deletion checks passed');
})();
