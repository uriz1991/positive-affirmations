// Pure Stripe billing decisions. index.js performs the Stripe and Firestore calls.
// The monthly price the website sends (app.js STRIPE_MONTHLY_PRICE_ID).
// Checkout rejects every other price id, including ones a client invents.
const ALLOWED_PRICE_IDS = ['price_1UAlkS5TpYQiqdPxShalBZVP'];

const PRO_STATUSES = ['active', 'trialing'];
// Stripe rejects expires_at under 30 minutes from the moment it receives the
// request. 31 minutes, rounded up, still clears that floor after the call.
const CHECKOUT_SESSION_TTL_MS = 31 * 60 * 1000;
// Held only while this process is calling Stripe. A crash must not block
// checkout for the whole session lifetime.
const CHECKOUT_CLAIM_TTL_MS = 2 * 60 * 1000;

function isAllowedPrice(priceId) {
  return typeof priceId === 'string' && ALLOWED_PRICE_IDS.includes(priceId);
}

// A referral bonus doc has bonusProUntil and must still be allowed to start
// a paid trial. Any Stripe history means the trial was already offered.
function trialEligible(sub) {
  if (!sub) return true;
  if (sub.trialUsed) return false;
  if (sub.stripeSubscriptionId) return false;
  if (sub.status) return false;
  if (sub.isPro) return false;
  // Reservation stores stripeCustomerId before payment and sets
  // stripeCustomerReserved. A customer id without that flag was written by
  // an earlier webhook, so the trial was already offered.
  if (sub.stripeCustomerId && !sub.stripeCustomerReserved) return false;
  return true;
}

// A second live subscription must not replace the one we already track.
// cancel-incoming: cancel and refund the subscription this event is about.
// ignore: a different subscription's past_due/canceled event must not clear Pro.
// After Stripe is re-fetched: active/trialing means cancel the new subscription.
// past_due/unpaid/paused/incomplete are still open, so cancel that stored
// subscription instead of leaving it beside the new one.
function storedSubscriptionDuplicatePlan(stripeStatus) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'cancel-incoming';
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid' || stripeStatus === 'incomplete' || stripeStatus === 'paused') {
    return 'cancel-stored';
  }
  return 'replace';
}

function duplicateSubscriptionAction(existing, incoming) {
  if (!existing || !incoming || !incoming.id || !existing.stripeSubscriptionId) return 'apply';
  if (existing.stripeSubscriptionId === incoming.id) return 'apply';
  const existingOpen = existing.isPro === true || existing.status === 'active' || existing.status === 'trialing';
  if (!existingOpen) return 'apply';
  if (incoming.status === 'active' || incoming.status === 'trialing') return 'cancel-incoming';
  return 'ignore';
}

// A second checkout while a subscription is still open double-bills.
// Canceled and expired-incomplete accounts can start a new one (no trial).
function checkoutBlocked(sub) {
  if (!sub) return false;
  if (sub.isPro) return true;
  if (!sub.status) return false;
  return sub.status !== 'canceled' && sub.status !== 'incomplete_expired';
}

function checkoutExpiresAtSeconds(nowMs) {
  const now = Number(nowMs);
  return Math.ceil((now + CHECKOUT_SESSION_TTL_MS) / 1000);
}

// A session the user can still pay in. An abandoned or expired one is not a
// trial and must not be treated as one.
function openPendingCheckout(sub, nowMs) {
  if (!sub || !sub.pendingCheckoutSessionId || !sub.pendingCheckoutUrl) return null;
  const expiresAt = Number(sub.pendingCheckoutExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  return { sessionId: sub.pendingCheckoutSessionId, url: sub.pendingCheckoutUrl };
}

// blocked: send the user to the portal.
// reuse: a Checkout session is still open; hand back that URL.
// in-progress: another call is creating the session; do not create a second one.
// create: no trial flag is written here. The webhook sets trialUsed.
function reserveCheckout(sub, nowMs) {
  if (checkoutBlocked(sub)) return { action: 'blocked' };
  const open = openPendingCheckout(sub, nowMs);
  if (open) return { action: 'reuse', url: open.url, sessionId: open.sessionId };
  const claimUntil = Number(sub && sub.pendingCheckoutClaim);
  if (Number.isFinite(claimUntil) && claimUntil > nowMs) return { action: 'in-progress' };
  return {
    action: 'create',
    trial: trialEligible(sub),
    customerId: (sub && sub.stripeCustomerId) || null,
    claimUntil: nowMs + CHECKOUT_CLAIM_TTL_MS
  };
}

// Portal access follows the Stripe customer, not isPro. past_due and unpaid
// customers still need the portal to pay.
function portalCustomerId(sub) {
  if (!sub || typeof sub.stripeCustomerId !== 'string') return null;
  const id = sub.stripeCustomerId.trim();
  return id || null;
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
  CHECKOUT_SESSION_TTL_MS,
  CHECKOUT_CLAIM_TTL_MS,
  isAllowedPrice,
  trialEligible,
  duplicateSubscriptionAction,
  storedSubscriptionDuplicatePlan,
  checkoutBlocked,
  checkoutExpiresAtSeconds,
  openPendingCheckout,
  reserveCheckout,
  portalCustomerId,
  subscriptionPriceId,
  customerIdOf,
  shouldApplyBillingEvent,
  billingPatchFromSubscription
};
