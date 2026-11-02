// Pure Stripe billing decisions. index.js performs the Stripe and Firestore calls.
// The monthly price the website sends (app.js STRIPE_MONTHLY_PRICE_ID).
// Checkout rejects every other price id, including ones a client invents.
const ALLOWED_PRICE_IDS = ['price_1UAlkS5TpYQiqdPxShalBZVP'];

const PRO_STATUSES = ['active', 'trialing'];

function isAllowedPrice(priceId) {
  return typeof priceId === 'string' && ALLOWED_PRICE_IDS.includes(priceId);
}

// A referral bonus doc has bonusProUntil and must still be allowed to start
// a paid trial. Any Stripe history means the trial was already offered.
function trialEligible(sub) {
  if (!sub) return true;
  if (sub.trialUsed) return false;
  if (sub.stripeCustomerId) return false;
  if (sub.stripeSubscriptionId) return false;
  if (sub.status) return false;
  if (sub.isPro) return false;
  return true;
}

// A second checkout while a subscription is still open double-bills.
// Canceled and expired-incomplete accounts can start a new one (no trial).
function checkoutBlocked(sub) {
  if (!sub) return false;
  if (sub.isPro) return true;
  if (!sub.status) return false;
  return sub.status !== 'canceled' && sub.status !== 'incomplete_expired';
}

function subscriptionPriceId(subscription) {
  const items = subscription && subscription.items && subscription.items.data;
  if (!Array.isArray(items) || !items.length) return null;
  const price = items[0].price;
  if (!price) return null;
  if (typeof price === 'string') return price;
  return price.id || null;
}

function customerIdOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.id || null;
}

// Only a newer-or-equal Stripe event may change Pro. event.created is seconds.
// A late checkout.session.completed must not turn isPro back on after a
// newer past_due / unpaid / canceled event was already stored.
function shouldApplyBillingEvent(existing, eventCreated) {
  const incoming = Number(eventCreated);
  if (!Number.isFinite(incoming)) return false;
  if (!existing || existing.billingEventAt == null) return true;
  return incoming >= Number(existing.billingEventAt);
}

// active/trialing on an allowlisted price is Pro. Every other status
// (past_due, unpaid, canceled, incomplete, paused, …) is not.
// A pro-looking status with no price id is malformed: the caller must not
// write isPro false from a payload we failed to read.
function billingPatchFromSubscription(subscription, eventCreated) {
  const priceId = subscriptionPriceId(subscription);
  const status = (subscription && subscription.status) || null;
  const proStatus = PRO_STATUSES.includes(status);
  if (proStatus && !priceId) {
    return { malformed: true, status, priceId: null };
  }
  const priceKnown = isAllowedPrice(priceId);
  return {
    malformed: false,
    isPro: proStatus && priceKnown,
    status,
    priceId: priceId || null,
    priceRejected: proStatus && !priceKnown,
    stripeSubscriptionId: (subscription && subscription.id) || null,
    stripeCustomerId: customerIdOf(subscription && subscription.customer),
    currentPeriodEnd: (subscription && subscription.current_period_end) || null,
    billingEventAt: Number(eventCreated),
    trialUsed: true
  };
}

module.exports = {
  ALLOWED_PRICE_IDS,
  PRO_STATUSES,
  isAllowedPrice,
  trialEligible,
  checkoutBlocked,
  subscriptionPriceId,
  customerIdOf,
  shouldApplyBillingEvent,
  billingPatchFromSubscription
};
