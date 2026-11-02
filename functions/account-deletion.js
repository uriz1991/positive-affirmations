// Pure decisions for account deletion and the Stripe webhook.
// index.js performs the Stripe and Firebase calls.

const DELETION_STEP_ORDER = [
  'cancel-subscriptions',
  'mark-pending',
  'delete-firestore',
  'delete-stripe-customer',
  'delete-auth-user',
  'mark-done'
];

function subscriptionNeedsCancel(status) {
  return status !== 'canceled' && status !== 'incomplete_expired';
}

function idsToCancel(subscriptions) {
  if (!Array.isArray(subscriptions)) return [];
  return subscriptions
    .filter((sub) => sub && sub.id && subscriptionNeedsCancel(sub.status))
    .map((sub) => sub.id);
}

function isMissingStripeCustomer(err) {
  const code = err && (err.code || (err.raw && err.raw.code));
  return code === 'resource_missing';
}

// A missing customer (already deleted) must not block a retry.
// Every other Stripe error stops the run before Auth is deleted.
function stripeCallFailure(err) {
  if (isMissingStripeCustomer(err)) return 'continue';
  return 'stop';
}

function deletionTombstoneActive(status) {
  return status === 'pending' || status === 'done';
}

// A fresh deletion writes pending before the Stripe cancel. The hourly job
// skips that doc until this window passes, so it cannot finish the account
// while this attempt can still delete the tombstone.
const CANCEL_GRACE_MS = 2 * 60 * 1000;

function deletionProtectsAccount(status) {
  return status === 'pending' || status === 'done';
}

// Grant Pro for a real checkout. A missing users/{uid} doc is normal when
// checkout races ahead of the first sync. A deletion in progress revokes.
function checkoutDecision(deletionStatus) {
  if (deletionProtectsAccount(deletionStatus)) return 'revoke-payment';
  return 'grant';
}

// A brand-new delete whose Stripe cancel fails must remove the tombstone.
// A tombstone that was already pending stays, so the hourly job can retry.
function cancelFailureRollsBackTombstone(existedBefore) {
  return !existedBefore;
}

function isStripeCancelFailed(err) {
  return String((err && err.message) || '').includes('stripe-cancel-failed');
}

// Roll back only the pending tombstone this call wrote. A pre-existing
// pending doc, or one another attempt already replaced, stays for retry.
function tombstoneRollbackMatches(current, attemptId) {
  return !!(current
    && current.status === 'pending'
    && attemptId
    && current.attemptId === attemptId);
}

function freshCancelFailureRemovesTombstone(existedBefore, err, current, attemptId) {
  return cancelFailureRollsBackTombstone(existedBefore)
    && isStripeCancelFailed(err)
    && tombstoneRollbackMatches(current, attemptId);
}

function pendingDeletionDue(doc, nowMs) {
  if (!doc || doc.status !== 'pending') return false;
  const started = Number(doc.cancelStartedAt);
  if (!Number.isFinite(started)) return true;
  return Number(nowMs) - started >= CANCEL_GRACE_MS;
}

// Idempotent resume. Each flag is "this step already succeeded".
function nextDeletionStep(state) {
  const current = state || {};
  if (!current.subscriptionsSettled) return 'cancel-subscriptions';
  if (!deletionTombstoneActive(current.tombstoneStatus)) return 'mark-pending';
  if (!current.firestoreDeleted) return 'delete-firestore';
  if (!current.customerSettled) return 'delete-stripe-customer';
  if (!current.authDeleted) return 'delete-auth-user';
  if (current.tombstoneStatus !== 'done') return 'mark-done';
  return 'finished';
}

// Subscription checkout leaves session.payment_intent null. The charge is on
// the invoice. A trial invoice has amount_paid 0: cancel only, do not refund.
function invoiceIdFromCheckoutSession(session) {
  if (!session || session.invoice == null || session.invoice === '') return null;
  if (typeof session.invoice === 'string') return session.invoice;
  return session.invoice.id || null;
}

function refundPlanFromInvoice(invoice) {
  if (!invoice || !invoice.id) return { action: 'missing-invoice' };
  const amountPaid = Number(invoice.amount_paid || 0);
  if (!(amountPaid > 0)) {
    return { action: 'nothing-to-refund', invoiceId: invoice.id, amountPaid: 0 };
  }
  const paymentIntentId = typeof invoice.payment_intent === 'string'
    ? invoice.payment_intent
    : invoice.payment_intent && invoice.payment_intent.id;
  const chargeId = typeof invoice.charge === 'string'
    ? invoice.charge
    : invoice.charge && invoice.charge.id;
  if (!paymentIntentId && !chargeId) {
    return { action: 'retry', invoiceId: invoice.id, amountPaid };
  }
  return {
    action: 'refund',
    invoiceId: invoice.id,
    amountPaid,
    paymentIntentId: paymentIntentId || null,
    chargeId: chargeId || null,
    idempotencyKey: 'refund-' + invoice.id
  };
}

function refundOutcome(err) {
  if (err && err.code === 'charge_already_refunded') return 'success';
  return 'retry';
}

// Canceling a subscription that is already gone must not become a webhook 500.
// Stripe retries that 500 for days.
function subscriptionCancelIsSettled(err) {
  if (isMissingStripeCustomer(err)) return true;
  const code = err && (err.code || (err.raw && err.raw.code));
  if (code === 'resource_missing') return true;
  // "canceled" inside an unrelated error must not look settled. Only Stripe's
  // invalid-request error for a subscription that is already canceled does.
  if (!err || err.type !== 'StripeInvalidRequestError') return false;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('canceled') || msg.includes('cancelled');
}

// paid_at is Unix seconds. A charge from before the tombstone is the month
// the person already used and must not be refunded. A charge after deletedAt
// is a checkout that landed during deletion and still should be.
function invoicePaidAfterDeletion(invoice, deletedAtMs) {
  const deletedMs = Number(deletedAtMs);
  if (!invoice || !Number.isFinite(deletedMs)) return false;
  const paidAt = invoice.status_transitions && invoice.status_transitions.paid_at;
  const paidSec = Number(paidAt);
  if (!Number.isFinite(paidSec) || paidSec <= 0) return false;
  return paidSec * 1000 > deletedMs;
}

// What the deletion webhook should do with a subscription event.
// Already-ended subscriptions are not cancelled again. The last paid month
// is not refunded. A checkout paid after the tombstone still is.
function deletionSubscriptionAction(status, invoice, deletedAtMs) {
  return {
    cancel: subscriptionNeedsCancel(status),
    refund: invoicePaidAfterDeletion(invoice, deletedAtMs)
  };
}

// createRefund is called only when money was collected. already-refunded is success.
async function applyRefundPlan(plan, createRefund) {
  if (!plan || plan.action === 'nothing-to-refund') return 'nothing-to-refund';
  if (!plan || plan.action === 'missing-invoice' || plan.action === 'retry') return 'retry';
  if (plan.action !== 'refund') return 'retry';
  try {
    await createRefund(plan);
    return 'refunded';
  } catch (err) {
    if (refundOutcome(err) === 'success') return 'already-refunded';
    return 'retry';
  }
}

// One deletedAccounts read becomes a set of uids that must not be notified.
// A failed read blocks every candidate. An empty set would send to deleted accounts.
function blockedSenderUids(tombstones, candidateUids, readFailed) {
  const candidates = Array.isArray(candidateUids) ? candidateUids : [];
  if (readFailed) return new Set(candidates);
  const blocked = new Set();
  (tombstones || []).forEach((row) => {
    if (row && row.id) blocked.add(row.id);
  });
  return blocked;
}

module.exports = {
  DELETION_STEP_ORDER,
  subscriptionNeedsCancel,
  idsToCancel,
  isMissingStripeCustomer,
  stripeCallFailure,
  deletionTombstoneActive,
  deletionProtectsAccount,
  CANCEL_GRACE_MS,
  cancelFailureRollsBackTombstone,
  isStripeCancelFailed,
  tombstoneRollbackMatches,
  freshCancelFailureRemovesTombstone,
  pendingDeletionDue,
  checkoutDecision,
  nextDeletionStep,
  invoiceIdFromCheckoutSession,
  refundPlanFromInvoice,
  refundOutcome,
  applyRefundPlan,
  blockedSenderUids,
  subscriptionCancelIsSettled,
  invoicePaidAfterDeletion,
  deletionSubscriptionAction
};
