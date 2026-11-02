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
  blockedSenderUids,
  subscriptionCancelIsSettled,
  invoicePaidAfterDeletion,
  deletionSubscriptionAction,
  cancelFailureRollsBackTombstone,
  isStripeCancelFailed,
  tombstoneRollbackMatches,
  freshCancelFailureRemovesTombstone,
  pendingDeletionDue,
  CANCEL_GRACE_MS,
  cancelFailureErrorCode,
  cancelFailureResumesSync,
  errorCodeForRollbackOutcome,
  rollbackFailedReleaseMatches,
  rollbackAfterFailure,
  attemptIdWrittenByCall,
  nextDeletionAttempt,
  DELETION_STUCK_AFTER,
  DELETION_ERROR_MAX,
  sanitizedDeletionError
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

check('deleting an account does not refund the month already paid', () => {
  const deletedAt = Date.parse('2026-11-02T12:00:00Z');
  const paidBefore = Math.floor(Date.parse('2026-10-02T12:00:00Z') / 1000);
  const paidAfter = Math.floor(Date.parse('2026-11-02T12:05:00Z') / 1000);
  const usedMonth = {
    id: 'in_used',
    amount_paid: 1490,
    status_transitions: { paid_at: paidBefore }
  };
  const duringDeletion = {
    id: 'in_late',
    amount_paid: 1490,
    status_transitions: { paid_at: paidAfter }
  };
  const alreadyEnded = deletionSubscriptionAction('canceled', usedMonth, deletedAt);
  assert.strictEqual(alreadyEnded.cancel, false);
  assert.strictEqual(alreadyEnded.refund, false);
  const cancelOnly = deletionSubscriptionAction('active', usedMonth, deletedAt);
  assert.strictEqual(cancelOnly.cancel, true);
  assert.strictEqual(cancelOnly.refund, false);
  assert.strictEqual(invoicePaidAfterDeletion(usedMonth, deletedAt), false);
  const checkoutAfterDelete = deletionSubscriptionAction('active', duringDeletion, deletedAt);
  assert.strictEqual(checkoutAfterDelete.cancel, true);
  assert.strictEqual(checkoutAfterDelete.refund, true);
  assert.strictEqual(invoicePaidAfterDeletion({
    id: 'in_same',
    amount_paid: 1490,
    status_transitions: { paid_at: Math.floor(deletedAt / 1000) }
  }, deletedAt), false);
  assert.strictEqual(subscriptionCancelIsSettled({ code: 'resource_missing' }), true);
  assert.strictEqual(subscriptionCancelIsSettled({
    message: 'You cannot cancel a subscription that is canceled.'
  }), false);
  assert.strictEqual(subscriptionCancelIsSettled({
    type: 'StripeInvalidRequestError',
    message: 'You cannot cancel a subscription that is canceled.'
  }), true);
  assert.strictEqual(subscriptionCancelIsSettled({
    type: 'StripeCardError',
    message: 'The payment was canceled.'
  }), false);
  assert.strictEqual(subscriptionCancelIsSettled({ code: 'rate_limit', message: 'slow down' }), false);
});

check('a failed first Stripe cancel leaves no tombstone', () => {
  const attemptId = 'attempt-1';
  const written = { status: 'pending', attemptId, cancelStartedAt: 1 };
  const cancelFailed = { message: 'stripe-cancel-failed' };
  assert.strictEqual(freshCancelFailureRemovesTombstone(false, cancelFailed, written, attemptId), true);
  assert.strictEqual(cancelFailureRollsBackTombstone(false), true);
  assert.strictEqual(isStripeCancelFailed(cancelFailed), true);
  assert.strictEqual(tombstoneRollbackMatches(written, attemptId), true);
  assert.strictEqual(freshCancelFailureRemovesTombstone(true, cancelFailed, written, attemptId), false);
  assert.strictEqual(freshCancelFailureRemovesTombstone(false, { message: 'auth-delete-failed' }, written, attemptId), false);
  assert.strictEqual(freshCancelFailureRemovesTombstone(false, cancelFailed, {
    status: 'done',
    attemptId
  }, attemptId), false);
  assert.strictEqual(tombstoneRollbackMatches({
    status: 'pending',
    attemptId: 'attempt-2'
  }, attemptId), false);
  assert.strictEqual(tombstoneRollbackMatches(null, attemptId), false);
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.strictEqual(pendingDeletionDue({ status: 'pending' }, now), true);
  assert.strictEqual(pendingDeletionDue({
    status: 'pending',
    cancelStartedAt: now - 10 * 1000
  }, now), false);
  assert.strictEqual(pendingDeletionDue({
    status: 'pending',
    cancelStartedAt: now - CANCEL_GRACE_MS
  }, now), true);
  assert.strictEqual(pendingDeletionDue({ status: 'done', cancelStartedAt: now }, now), false);
  assert.strictEqual(pendingDeletionDue({ status: 'rollback-failed' }, now), false);
});

check('a retry of a partial deletion stays pending and does not resume sync', () => {
  assert.strictEqual(cancelFailureErrorCode(true), 'deletion-pending');
  assert.strictEqual(cancelFailureErrorCode(false), 'stripe-cancel-failed');
  assert.strictEqual(cancelFailureResumesSync('deletion-pending'), false);
  assert.strictEqual(cancelFailureResumesSync('deletion-rollback-failed'), false);
  assert.strictEqual(cancelFailureResumesSync('stripe-cancel-failed'), true);
  assert.strictEqual(freshCancelFailureRemovesTombstone(true, { message: 'stripe-cancel-failed' }, {
    status: 'pending',
    attemptId: 'old'
  }, 'old'), false);
});

check('a rollback that fails twice is marked and does not resume sync', () => {
  assert.strictEqual(rollbackAfterFailure(0), 'retry');
  assert.strictEqual(rollbackAfterFailure(1), 'retry');
  assert.strictEqual(rollbackAfterFailure(2), 'mark-rollback-failed');
  assert.strictEqual(errorCodeForRollbackOutcome('rollback-failed'), 'deletion-rollback-failed');
  assert.strictEqual(cancelFailureResumesSync(errorCodeForRollbackOutcome('rollback-failed')), false);
  assert.strictEqual(pendingDeletionDue({ status: 'rollback-failed', attemptId: 'a' }, Date.now()), false);
});

check('the hourly job deletes a rollback-failed tombstone only when the attempt id is unchanged', () => {
  const attemptId = 'attempt-1';
  assert.strictEqual(rollbackFailedReleaseMatches({
    status: 'rollback-failed',
    attemptId
  }, attemptId), true);
  assert.strictEqual(rollbackFailedReleaseMatches({
    status: 'rollback-failed',
    attemptId: 'attempt-2'
  }, attemptId), false);
  assert.strictEqual(rollbackFailedReleaseMatches({
    status: 'pending',
    attemptId
  }, attemptId), false);
  assert.strictEqual(rollbackFailedReleaseMatches(null, attemptId), false);
});

check('a failed rollback-failed write stays pending for the hourly deletion', () => {
  assert.strictEqual(errorCodeForRollbackOutcome('kept'), 'deletion-pending');
  assert.strictEqual(cancelFailureResumesSync(errorCodeForRollbackOutcome('kept')), false);
  assert.strictEqual(errorCodeForRollbackOutcome('removed'), 'stripe-cancel-failed');
  assert.strictEqual(cancelFailureResumesSync(errorCodeForRollbackOutcome('removed')), true);
});

check('a second call writes its own attempt id and does not inherit the first', () => {
  const first = 'attempt-first';
  const second = 'attempt-second';
  assert.strictEqual(attemptIdWrittenByCall(first, second), second);
  assert.notStrictEqual(attemptIdWrittenByCall(first, second), first);
  assert.strictEqual(tombstoneRollbackMatches({
    status: 'pending',
    attemptId: first
  }, second), false);
  assert.strictEqual(tombstoneRollbackMatches({
    status: 'pending',
    attemptId: second
  }, second), true);
});

check('the hourly job marks a deletion stuck after 24 failures and keeps counting', () => {
  const before = nextDeletionAttempt(DELETION_STUCK_AFTER - 2, 'stripe-cancel-failed');
  assert.strictEqual(before.attempts, 23);
  assert.strictEqual(before.stuck, false);
  assert.strictEqual(before.lastError, 'stripe-cancel-failed');
  const stuck = nextDeletionAttempt(before.attempts, 'deletion-pending');
  assert.strictEqual(stuck.attempts, 24);
  assert.strictEqual(stuck.stuck, true);
  assert.strictEqual(stuck.lastError, 'deletion-pending');
  const later = nextDeletionAttempt(stuck.attempts, 'deletion-pending');
  assert.strictEqual(later.attempts, 25);
  assert.strictEqual(later.stuck, true);
  assert.strictEqual(nextDeletionAttempt(undefined, '').attempts, 1);
  const noisy = nextDeletionAttempt(0, {
    code: 'failed-precondition',
    message: 'stripe-cancel-failed for user@example.com ' + 'x'.repeat(400)
  });
  assert.ok(noisy.lastError.length <= DELETION_ERROR_MAX);
  assert.ok(noisy.lastError.startsWith('failed-precondition: '));
  assert.strictEqual(noisy.lastError.includes('user@example.com'), false);
  assert.ok(noisy.lastError.includes('[redacted]'));
  assert.strictEqual(sanitizedDeletionError('stripe-cancel-failed'), 'stripe-cancel-failed');
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
