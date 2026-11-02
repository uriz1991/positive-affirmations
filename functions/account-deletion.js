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

// Grant Pro for a real checkout. A missing users/{uid} doc is normal when
// checkout races ahead of the first sync. Only a deletion tombstone revokes.
function checkoutDecision(deletionStatus) {
  if (deletionTombstoneActive(deletionStatus)) return 'revoke-payment';
  return 'grant';
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

module.exports = {
  DELETION_STEP_ORDER,
  subscriptionNeedsCancel,
  idsToCancel,
  isMissingStripeCustomer,
  stripeCallFailure,
  deletionTombstoneActive,
  checkoutDecision,
  nextDeletionStep
};
