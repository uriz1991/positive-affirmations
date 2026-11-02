// Pure decisions for account deletion. The callable in index.js performs the
// Stripe and Firebase calls; these helpers are what the tests lock in.

function subscriptionNeedsCancel(status) {
  return status !== 'canceled' && status !== 'incomplete_expired';
}

function idsToCancel(subscriptions) {
  if (!Array.isArray(subscriptions)) return [];
  return subscriptions
    .filter((sub) => sub && sub.id && subscriptionNeedsCancel(sub.status))
    .map((sub) => sub.id);
}

// Stripe webhooks must not recreate subscriptions/{uid} after the account is
// gone. Both the Auth user and the users/{uid} document have to still exist.
// Auth deletion does not expire an ID token immediately, so the user-doc
// check covers a webhook that lands after the document is removed.
function mayWriteSubscription(authExists, userDocExists) {
  return !!authExists && !!userDocExists;
}

function isMissingStripeCustomer(err) {
  const code = err && (err.code || (err.raw && err.raw.code));
  return code === 'resource_missing';
}

module.exports = {
  subscriptionNeedsCancel,
  idsToCancel,
  mayWriteSubscription,
  isMissingStripeCustomer
};
