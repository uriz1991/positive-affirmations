// Deployed automatically via GitHub Actions (.github/workflows/deploy-functions.yml)
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const geminiApiKey = defineSecret('GEMINI_API_KEY');
const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
// Owner creates this in Secret Manager before deploying redeemReferral.
// It is the HMAC key for referralIdentities. A missing value fails closed.
const referralHashKey = defineSecret('REFERRAL_HASH_KEY');

const APP_URL = 'https://uriz1991.github.io/positive-affirmations/';

// stripe-node 17.7 bundles 2025-02-24.acacia. Later versions (2025-03-31.basil
// and after) remove Invoice.payment_intent and Invoice.charge. The deleted-
// account refund reads those fields, so the version is pinned instead of
// following the SDK default.
const STRIPE_API_VERSION = '2025-02-24.acacia';

function stripeClient() {
  return require('stripe')(secretValue(stripeSecretKey), { apiVersion: STRIPE_API_VERSION });
}

// Secret Manager values have shown up with stray whitespace/newlines from
// copy-paste in the past (e.g. a trailing \n makes Stripe reject an
// otherwise-correct key with "Invalid API Key") — trim defensively everywhere
// a secret is read.
function secretValue(secretParam) {
  return secretParam.value().trim();
}

// The Gemini SDK's errors carry the real reason (rate limit, invalid model,
// bad key, etc.) in fields beyond .message — logging only err.message has
// repeatedly turned "why did this fail" into a second round-trip through
// production logs. Capture everything useful in one place.
function describeGeminiError(err) {
  return {
    message: err?.message,
    name: err?.name,
    status: err?.status,
    statusText: err?.statusText,
    errorDetails: err?.errorDetails
  };
}

// Callable, HTTP, and scheduled functions stay in FUNCTION_REGION.
// A Firestore document trigger must run in the same region as the Firestore
// database. If that database is not in me-west1, change only
// FIRESTORE_TRIGGER_REGION before the first deploy of dropRewrittenDeletedUser.
const FUNCTION_REGION = 'me-west1';
const FIRESTORE_TRIGGER_REGION = 'me-west1';

setGlobalOptions({ region: FUNCTION_REGION, maxInstances: 3 });

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// Same picker and sentence pools as the page and the service worker.
// Hebrew pool: scripts/integrate-affirmations.js.
// Other languages: scripts/build-localized-pools.js.
const { pickFromPool, slotForReminder, personalTextsForLanguage, assignTokenOwners, tokensForUser } = require('./notification-select');
const {
  idsToCancel,
  stripeCallFailure,
  isMissingStripeCustomer,
  deletionTombstoneActive,
  deletionProtectsAccount,
  freshCancelFailureRemovesTombstone,
  tombstoneRollbackMatches,
  pendingDeletionDue,
  cancelFailureErrorCode,
  errorCodeForRollbackOutcome,
  rollbackFailedReleaseMatches,
  isStripeCancelFailed,
  rollbackAfterFailure,
  attemptIdWrittenByCall,
  nextDeletionAttempt,
  checkoutDecision,
  invoiceIdFromCheckoutSession,
  refundPlanFromInvoice,
  applyRefundPlan,
  blockedSenderUids,
  subscriptionNeedsCancel,
  subscriptionCancelIsSettled,
  invoicePaidAfterDeletion
} = require('./account-deletion');
const {
  isAllowedPrice,
  checkoutExpiresAtSeconds,
  openPendingCheckout,
  reserveCheckout,
  portalCustomerId,
  duplicateSubscriptionAction,
  storedSubscriptionDuplicatePlan,
  invoiceCanBeVoided,
  invoiceVoidIsSettled,
  customerIdOf,
  shouldApplyBillingEvent,
  billingPatchFromSubscription
} = require('./billing-policy');
const {
  validReferrerUid,
  isNewAccount,
  nextBonusUntil,
  grantedBonusDays,
  referralIdentityKeys,
  referralMonth,
  referralRedeemPlan,
  REFERRAL_RETENTION_MS
} = require('./referral-policy');
const { clipText, clipPlanInput, geminiFailureRefundable, JOURNAL_ENTRY_MAX } = require('./prompt-limits');
const { DAILY_GEN_LIMIT, claimQuota, releaseCount } = require('./usage-quota');
const { countCatalogFavorites, catalogTextsForPrompt } = require('./catalog-favorites');
const NOTIFICATION_POOLS = {
  he: require('./notification-pool.json').items,
  en: require('./notification-pool-en.json').items,
  fr: require('./notification-pool-fr.json').items,
  es: require('./notification-pool-es.json').items
};

function notificationPoolFor(data) {
  const lang = data && data.language;
  if (lang && lang !== 'he' && Array.isArray(NOTIFICATION_POOLS[lang]) && NOTIFICATION_POOLS[lang].length) {
    return NOTIFICATION_POOLS[lang];
  }
  return NOTIFICATION_POOLS.he;
}

function reminderLanguage(data) {
  const lang = data && data.language;
  return lang === 'en' || lang === 'fr' || lang === 'es' ? lang : 'he';
}

function userTokenRecord(userDoc) {
  const data = userDoc.data() || {};
  return {
    uid: userDoc.id,
    fcmTokens: Array.isArray(data.fcmTokens) ? data.fcmTokens : [],
    fcmTokenBoundAt: data.fcmTokenBoundAt,
    fcmTokenBound: data.fcmTokenBound && typeof data.fcmTokenBound === 'object' ? data.fcmTokenBound : null
  };
}

async function dropStaleFcmTokens(userDoc, stale) {
  if (!stale || !stale.length) return;
  try {
    await userDoc.ref.set({ fcmTokens: FieldValue.arrayRemove(...stale) }, { merge: true });
  } catch (err) {
    logger.error('Failed to drop stale FCM tokens', { uid: userDoc.id, message: err && err.message });
  }
}

// A reminder fires once per day, within a window after its set time (the
// scheduler runs every 5 min, so a 6-min window guarantees each reminder is
// caught exactly once even if a run is briefly delayed).
function isDueNow(currentMinutes, targetTime) {
  const [h, m] = targetTime.split(':').map(Number);
  const targetMinutes = h * 60 + m;
  const diff = currentMinutes - targetMinutes;
  return diff >= 0 && diff < 6;
}

exports.sendScheduledReminders = onSchedule('every 5 minutes', async () => {
  const usersSnap = await db.collection('users').get();
  const deletedIds = await uidsBlockedFromSending(usersSnap.docs.map((doc) => doc.id));
  const tokenOwner = assignTokenOwners(usersSnap.docs.map(userTokenRecord));

  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    if (deletedIds.has(userDoc.id)) return;
    const data = userDoc.data();
    const reminders = Array.isArray(data.reminders) ? data.reminders : [];
    const split = tokensForUser(userTokenRecord(userDoc), tokenOwner);
    await dropStaleFcmTokens(userDoc, split.stale);
    const tokens = split.owned;
    if (!reminders.length || !tokens.length) return;

    const timezone = data.timezone || 'Asia/Jerusalem';
    const now = new Date();

    let localTime;
    let todayKey;
    try {
      localTime = now.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
      todayKey = now.toLocaleDateString('en-CA', { timeZone: timezone });
    } catch {
      // Unknown/invalid timezone string — fall back to Israel time rather than skip the user entirely.
      localTime = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false });
      todayKey = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    }
    const [ch, cm] = localTime.split(':').map(Number);
    const currentMinutes = ch * 60 + cm;

    const sentRecord = data.remindersSentToday;
    const alreadySent = (sentRecord?.date === todayKey) ? (sentRecord.sentIds || []) : [];
    const newlySent = [];
    let history = Array.isArray(data.notificationRecentIds) ? data.notificationRecentIds.slice() : [];

    for (const reminder of reminders) {
      if (!reminder.enabled || !reminder.time || !reminder.id) continue;
      if (alreadySent.includes(reminder.id)) continue;
      if (!isDueNow(currentMinutes, reminder.time)) continue;

      const lang = reminderLanguage(data);
      const picked = pickFromPool({
        pool: notificationPoolFor(data),
        slot: slotForReminder(reminder),
        history,
        addressForm: data.addressForm === 'f' ? 'f' : 'm',
        personalTexts: personalTextsForLanguage(data.personalAffirmations, lang)
      });
      if (!picked || !picked.text) continue;
      history = picked.history;
      const fallbackTitle = lang === 'he' ? 'אמירות חיוביות' : 'Positive affirmations';
      const title = reminder.label || fallbackTitle;
      const tag = `reminder-${reminder.id}-${todayKey}`;

      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body: picked.text },
        data: { title, body: picked.text, tag, lang },
        webpush: {
          notification: { tag, renotify: false, dir: lang === 'he' ? 'rtl' : 'ltr', lang },
          fcmOptions: { link: 'https://uriz1991.github.io/positive-affirmations/' }
        }
      }).catch(() => null);

      newlySent.push(reminder.id);

      // Drop tokens FCM says are no longer valid (uninstalled, expired, etc.)
      if (response) {
        const deadTokens = [];
        response.responses.forEach((r, i) => {
          if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
            deadTokens.push(tokens[i]);
          }
        });
        if (deadTokens.length) {
          await userDoc.ref.set({ fcmTokens: FieldValue.arrayRemove(...deadTokens) }, { merge: true });
        }
      }
    }

    if (newlySent.length) {
      await userDoc.ref.set({
        remindersSentToday: { date: todayKey, sentIds: [...alreadySent, ...newlySent] },
        notificationRecentIds: history
      }, { merge: true });
    }
  }));
});

// ===== Daily affirmation generation (Gemini) =====
const CATEGORIES = {
  torah: 'אמונה יהודית',
  nachman: 'רבי נחמן מברסלב',
  faith: 'אמונה והשגחה',
  confidence: 'ביטחון עצמי',
  calm: 'שלווה ורוגע',
  success: 'הצלחה ושפע',
  'self-love': 'אהבה עצמית',
  change: 'התמודדות עם שינוי',
  gratitude: 'הכרת תודה',
  wealth: 'מנטליות עושר'
};

const AFFIRMATIONS_PER_DAY = 25;

exports.generateDailyAffirmations = onSchedule({
  schedule: '0 3 * * *',
  timeZone: 'Asia/Jerusalem',
  timeoutSeconds: 300,
  secrets: [geminiApiKey]
}, async () => {
  const genAI = new GoogleGenerativeAI(secretValue(geminiApiKey));
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // Give the model real examples of what users actually loved, as style
  // reference only — it must write new original lines, never copy these.
  const popularSnap = await db.doc('stats/popular-affirmations').get();
  // Catalog lines only. Personal text that an older aggregate stored here
  // must not be copied into the prompt.
  const popularExamples = catalogTextsForPrompt(popularSnap.data()?.top);

  const categoryKeys = Object.keys(CATEGORIES);
  const perCategory = Math.max(1, Math.round(AFFIRMATIONS_PER_DAY / categoryKeys.length));
  const batch = db.batch();
  let written = 0;

  for (const key of categoryKeys) {
    const prompt = [
      `כתוב ${perCategory} משפטי אמירה חיובית קצרים בעברית בנושא "${CATEGORIES[key]}".`,
      'כללים חשובים:',
      '- כל משפט חייב לפנות לכל המגדרים, לא רק לגבר או רק לאישה. הימנע מפעלים בגוף שני/ראשון שמחייבים נטייה מגדרית (למשל "אני מאמין" או "את מרגישה"). במקום זה נסח בצורה ניטרלית מגדרית, או השתמש בצורת "אני מאמין/ה" עם לוכסן כשאין ברירה.',
      '- כל משפט בשורה נפרדת, בלי מספור, בלי מרכאות, בלי הסברים נוספים.',
      '- אל תחזור על משפטים נפוצים או קלישאתיים מדי.',
      popularExamples.length
        ? `לרפרנס סגנוני בלבד (אל תעתיק, רק קבל השראה מהטון שעבד למשתמשים):\n${popularExamples.join('\n')}`
        : ''
    ].filter(Boolean).join('\n');

    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const lines = text.split('\n').map(l => l.replace(/^[-•\d.)\s]+/, '').trim()).filter(Boolean).slice(0, perCategory);

      lines.forEach((line) => {
        const ref = db.collection('generated-affirmations').doc();
        batch.set(ref, {
          text: line,
          category: key,
          language: 'he',
          createdAt: FieldValue.serverTimestamp()
        });
        written++;
      });
    } catch (err) {
      // One category failing (e.g. transient API error) shouldn't block the rest.
      logger.error('Daily affirmation generation failed for category', { category: key, ...describeGeminiError(err) });
    }
  }

  if (written > 0) await batch.commit();
});

// ===== Aggregate catalog favorites only =====
// Personal and other free-typed favorites are not public and are not counted.
// The next run replaces stats/popular-affirmations, which drops anything the
// old counter wrote that is not a catalog line.
exports.aggregatePopularAffirmations = onSchedule('every 24 hours', async () => {
  const usersSnap = await db.collection('users').get();
  const top = countCatalogFavorites(usersSnap.docs.map((doc) => doc.data().favorites));

  await db.doc('stats/popular-affirmations').set({
    top,
    updatedAt: FieldValue.serverTimestamp()
  });
});

// ===== Stripe: checkout + webhook =====
// Subscription status lives in its OWN doc (subscriptions/{uid}), never in
// users/{uid}. firestore.rules lets the owner write only profile fields, and
// subscriptions/{uid} stays client-read-only. Only the Admin SDK sets isPro.
// The Stripe webhook must be subscribed to checkout.session.completed and
// customer.subscription.created, updated, and deleted. That last part is a
// dashboard setting, not something this code can turn on.

exports.createCheckoutSession = onCall({ secrets: [stripeSecretKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in before upgrading.');
  }
  const priceId = request.data?.priceId;
  if (!isAllowedPrice(priceId)) {
    throw new HttpsError('invalid-argument', 'Unknown price.');
  }

  const uid = request.auth.uid;
  const subRef = db.doc('subscriptions/' + uid);
  const now = Date.now();
  let reserved;
  try {
    reserved = await db.runTransaction(async (tx) => {
      const snap = await tx.get(subRef);
      const data = snap.exists ? snap.data() : null;
      const decision = reserveCheckout(data, now);
      if (decision.action === 'create') {
        // Claim only. trialUsed stays unset until the webhook sees a real
        // subscription, so backing out of Checkout does not burn the trial.
        tx.set(subRef, {
          pendingCheckoutClaim: decision.claimUntil,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
      return decision;
    });
  } catch (err) {
    logger.error('Checkout reservation failed', { uid, message: err.message });
    throw new HttpsError('internal', 'Could not start checkout. Try again.');
  }
  if (reserved.action === 'blocked') {
    throw new HttpsError('failed-precondition', 'This account already has a subscription. Use the subscription portal.');
  }
  if (reserved.action === 'reuse') return { url: reserved.url };
  if (reserved.action === 'in-progress') {
    const url = await waitForPendingCheckoutUrl(subRef);
    if (url) return { url };
    throw new HttpsError('aborted', 'Checkout is already starting. Try again.');
  }

  const stripe = stripeClient();
  let customerId = reserved.customerId;
  if (!customerId) {
    try {
      const customer = await stripe.customers.create(
        { metadata: { uid } },
        { idempotencyKey: 'customer-' + uid }
      );
      customerId = await rememberStripeCustomer(subRef, uid, customer.id);
    } catch (err) {
      logger.error('Stripe customer creation failed', { uid, message: err.message, type: err.type, code: err.code });
      await clearCheckoutClaim(subRef, uid);
      throw new HttpsError('internal', 'Could not start checkout. Try again.');
    }
  }
  const subscriptionData = { metadata: { uid, priceId } };
  if (reserved.trial) subscriptionData.trial_period_days = 7;
  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: uid,
    metadata: { uid, priceId },
    subscription_data: subscriptionData,
    success_url: `${APP_URL}?upgraded=1`,
    cancel_url: APP_URL,
    customer: customerId
  };
  // Stamp this immediately before the request. An earlier timestamp, once
  // floored, arrives under Stripe's 30-minute minimum and the call is rejected.
  const expiresAt = checkoutExpiresAtSeconds(Date.now());
  params.expires_at = expiresAt;

  let session;
  try {
    session = await stripe.checkout.sessions.create(params);
  } catch (err) {
    logger.error('Stripe checkout session creation failed', { uid, message: err.message, type: err.type, code: err.code });
    await clearCheckoutClaim(subRef, uid);
    throw new HttpsError('internal', 'Could not start checkout. Try again.');
  }

  try {
    const saved = await db.runTransaction(async (tx) => {
      const snap = await tx.get(subRef);
      const data = snap.exists ? snap.data() : null;
      if (reserveCheckout(data, Date.now()).action === 'blocked') return { blocked: true };
      const open = openPendingCheckout(data, Date.now());
      if (open && open.sessionId !== session.id) return { url: open.url };
      tx.set(subRef, {
        pendingCheckoutSessionId: session.id,
        pendingCheckoutUrl: session.url,
        pendingCheckoutExpiresAt: (session.expires_at || expiresAt) * 1000,
        pendingCheckoutClaim: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { url: session.url };
    });
    if (saved.blocked) {
      throw new HttpsError('failed-precondition', 'This account already has a subscription. Use the subscription portal.');
    }
    return { url: saved.url };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error('Failed to store pending checkout session', { uid, message: err.message });
    throw new HttpsError('internal', 'Could not start checkout. Try again.');
  }
});

async function rememberStripeCustomer(subRef, uid, createdId) {
  let chosen = createdId;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(subRef);
    const existing = portalCustomerId(snap.data());
    chosen = existing || createdId;
    if (!existing) {
      tx.set(subRef, {
        stripeCustomerId: chosen,
        stripeCustomerReserved: true,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  });
  await db.doc('stripeCustomers/' + chosen).set({ uid }, { merge: true });
  return chosen;
}

async function waitForPendingCheckoutUrl(subRef) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const snap = await subRef.get();
    const open = openPendingCheckout(snap.data(), Date.now());
    if (open) return open.url;
    const claimUntil = Number(snap.data() && snap.data().pendingCheckoutClaim);
    if (!Number.isFinite(claimUntil) || claimUntil <= Date.now()) return null;
  }
  return null;
}

async function clearCheckoutClaim(subRef, uid) {
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(subRef);
      const data = snap.data() || {};
      if (data.pendingCheckoutSessionId) return;
      tx.set(subRef, { pendingCheckoutClaim: FieldValue.delete() }, { merge: true });
    });
  } catch (err) {
    logger.error('Failed to clear checkout claim', { uid, message: err.message });
  }
}

// Lets a paying user cancel or manage their own subscription — without this,
// the only way to cancel is emailing support, which is not acceptable for a
// real paid product.
exports.createPortalSession = onCall({ secrets: [stripeSecretKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const uid = request.auth.uid;

  const subSnap = await db.doc('subscriptions/' + uid).get();
  const customerId = portalCustomerId(subSnap.data());
  if (!customerId) {
    throw new HttpsError('failed-precondition', 'No Stripe customer found for this account.');
  }

  const stripe = stripeClient();
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: APP_URL
    });
    return { url: session.url };
  } catch (err) {
    logger.error('Stripe portal session creation failed', { uid, message: err.message, type: err.type, code: err.code });
    throw new HttpsError('internal', 'Could not open the subscription portal. Try again.');
  }
});

exports.stripeWebhook = onRequest({ secrets: [stripeSecretKey, stripeWebhookSecret] }, async (req, res) => {
  const stripe = stripeClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], secretValue(stripeWebhookSecret));
  } catch (err) {
    logger.error('Stripe webhook signature verification failed', { message: err.message });
    res.status(400).send('Invalid signature');
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(stripe, event);
    } else if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      await applySubscriptionEvent(stripe, event);
    }
  } catch (err) {
    logger.error('Stripe webhook handling failed', {
      message: err.message,
      eventType: event?.type,
      eventId: event?.id
    });
    // Status changes and deleted-account refunds must retry. The handler is
    // idempotent, and Stripe stops retrying after its own schedule.
    res.status(500).json({ error: 'webhook handler failed' });
    return;
  }

  res.json({ received: true });
});

async function handleCheckoutCompleted(stripe, event) {
  const session = event.data.object;
  const uid = session.client_reference_id || session.metadata?.uid;
  if (!uid) return;
  const customerId = customerIdOf(session.customer);
  const deletionStatus = await deletionTombstoneStatus(uid);
  // A missing users/{uid} is normal: checkout often beats the first sync.
  // Only an account that is already being deleted must not become Pro.
  if (checkoutDecision(deletionStatus) === 'revoke-payment') {
    await revokeCheckoutForDeletedAccount(stripe, session);
    await db.doc('subscriptions/' + uid).delete();
    return;
  }

  const subId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription && session.subscription.id;
  if (!subId) {
    logger.error('Checkout completed without a subscription id', { uid, eventId: event.id });
    throw retryableWebhookError('checkout session has no subscription');
  }
  let subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subId);
  } catch (err) {
    logger.error('Could not load subscription for checkout', { uid, eventId: event.id, message: err.message });
    throw retryableWebhookError('subscription retrieve failed');
  }
  await resolveDuplicateOrApply(stripe, uid, subscription, event, customerId);
}

async function applySubscriptionEvent(stripe, event) {
  const hinted = event.data.object || {};
  const subId = hinted.id;
  if (!subId) {
    logger.error('Subscription event has no id', { eventId: event.id, type: event.type });
    return;
  }
  let subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subId);
  } catch (err) {
    if (isMissingStripeCustomer(err)) {
      // The subscription is already gone. Do not trust the event's status or price.
      subscription = {
        id: subId,
        status: 'canceled',
        customer: hinted.customer,
        metadata: hinted.metadata || {}
      };
    } else {
      logger.error('Could not load subscription for webhook', { eventId: event.id, message: err.message });
      throw retryableWebhookError('subscription retrieve failed');
    }
  }
  const customerId = customerIdOf(subscription.customer);
  let uid = subscription.metadata && subscription.metadata.uid;
  if (!uid && customerId) {
    const lookup = await db.doc('stripeCustomers/' + customerId).get();
    uid = lookup.data()?.uid;
  }
  if (!uid) {
    logger.error('Subscription event has no uid', { eventId: event.id, type: event.type, subId });
    return;
  }
  const tomb = await deletionTombstoneRecord(uid);
  if (tomb && deletionProtectsAccount(tomb.status)) {
    // The month already paid for is not refunded. Only a charge that landed
    // after the tombstone (a checkout during deletion) is.
    await settleDeletedAccountSubscription(stripe, subscription, tomb.deletedAtMs);
    await db.doc('subscriptions/' + uid).delete();
    return;
  }
  await resolveDuplicateOrApply(stripe, uid, subscription, event, customerId);
}

async function writeSubscriptionSnapshot(uid, subscription, event, customerId, options) {
  const force = !!(options && options.force);
  const patch = billingPatchFromSubscription(subscription, event.created);
  if (patch.malformed) {
    logger.error('Retrieved subscription is missing a price id', { uid, eventId: event.id, type: event.type, status: patch.status });
    throw retryableWebhookError('subscription payload missing price');
  }
  if (patch.priceRejected) {
    logger.error('Subscription price is not allowlisted', { uid, eventId: event.id, type: event.type, priceId: patch.priceId });
  }
  const ref = db.doc('subscriptions/' + uid);
  const storedCustomer = patch.stripeCustomerId || customerId || null;
  const action = await db.runTransaction(async (tx) => {
    const existingSnap = await tx.get(ref);
    const existing = existingSnap.exists ? existingSnap.data() : null;
    const duplicate = duplicateSubscriptionAction(existing, subscription);
    if (!force && (duplicate === 'cancel-incoming' || duplicate === 'ignore')) {
      return { action: duplicate, storedSubscriptionId: existing && existing.stripeSubscriptionId || null };
    }
    if (!shouldApplyBillingEvent(existing, event.created)) {
      if (customerId && existing && !existing.stripeCustomerId) {
        tx.set(ref, { stripeCustomerId: customerId }, { merge: true });
      }
      return { action: 'stale' };
    }
    tx.set(ref, {
      isPro: patch.isPro,
      status: patch.status,
      priceId: patch.priceId,
      stripeSubscriptionId: patch.stripeSubscriptionId,
      stripeCustomerId: storedCustomer,
      currentPeriodEnd: patch.currentPeriodEnd,
      billingEventAt: patch.billingEventAt,
      billingEventId: event.id,
      trialUsed: true,
      pendingCheckoutSessionId: FieldValue.delete(),
      pendingCheckoutUrl: FieldValue.delete(),
      pendingCheckoutExpiresAt: FieldValue.delete(),
      pendingCheckoutClaim: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (storedCustomer) tx.set(db.doc('stripeCustomers/' + storedCustomer), { uid }, { merge: true });
    return { action: 'applied' };
  });
  if (action && action.action === 'stale') {
    logger.info('Ignoring stale billing event', { uid, type: event.type, eventId: event.id });
  }
  return action;
}

function latestInvoiceId(subscription) {
  if (!subscription) return null;
  if (typeof subscription.latest_invoice === 'string') return subscription.latest_invoice;
  return subscription.latest_invoice && subscription.latest_invoice.id || null;
}

async function cancelSubscriptionIdempotent(stripe, subscription) {
  if (!subscription || !subscription.id) return;
  if (!subscriptionNeedsCancel(subscription.status)) return;
  try {
    await stripe.subscriptions.cancel(subscription.id);
  } catch (err) {
    if (subscriptionCancelIsSettled(err)) return;
    throw retryableWebhookError(err.message);
  }
}

async function voidOpenLatestInvoice(stripe, subscription) {
  const invoiceId = latestInvoiceId(subscription);
  if (!invoiceId) return;
  let invoice;
  try {
    invoice = await stripe.invoices.retrieve(invoiceId);
  } catch (err) {
    if (invoiceVoidIsSettled(err)) return;
    throw retryableWebhookError(err && err.message);
  }
  if (!invoiceCanBeVoided(invoice && invoice.status)) return;
  try {
    await stripe.invoices.voidInvoice(invoiceId);
  } catch (err) {
    if (invoiceVoidIsSettled(err)) return;
    throw retryableWebhookError(err && err.message);
  }
}

async function refundLatestInvoice(stripe, subscription, predicate) {
  const invoiceId = latestInvoiceId(subscription);
  if (!invoiceId) return;
  let invoice;
  try {
    invoice = await stripe.invoices.retrieve(invoiceId);
  } catch (err) {
    if (subscriptionCancelIsSettled(err)) return;
    throw retryableWebhookError(err && err.message);
  }
  if (predicate && !predicate(invoice)) return;
  const plan = refundPlanFromInvoice(invoice);
  const outcome = await applyRefundPlan(plan, (refundPlan) => {
    const body = refundPlan.paymentIntentId
      ? { payment_intent: refundPlan.paymentIntentId }
      : { charge: refundPlan.chargeId };
    return stripe.refunds.create(body, { idempotencyKey: refundPlan.idempotencyKey });
  });
  if (outcome === 'retry') throw retryableWebhookError('refund did not complete for ' + invoiceId);
}

// Duplicate checkout: re-fetch the stored subscription. Active or trialing
// means cancel the new one. past_due or unpaid means cancel the stored one
// so it is not left running beside the new subscription.
async function resolveDuplicateOrApply(stripe, uid, subscription, event, customerId) {
  const result = await writeSubscriptionSnapshot(uid, subscription, event, customerId);
  if (!result || result.action !== 'cancel-incoming') return;
  let storedSub = null;
  let stripeStatus = 'canceled';
  if (result.storedSubscriptionId) {
    try {
      storedSub = await stripe.subscriptions.retrieve(result.storedSubscriptionId);
      stripeStatus = storedSub && storedSub.status;
    } catch (err) {
      if (!subscriptionCancelIsSettled(err)) throw retryableWebhookError(err.message);
    }
  }
  const plan = storedSubscriptionDuplicatePlan(stripeStatus);
  if (plan === 'cancel-incoming') {
    await cancelSubscriptionIdempotent(stripe, subscription);
    await refundLatestInvoice(stripe, subscription);
    return;
  }
  if (plan === 'cancel-stored') {
    await cancelSubscriptionIdempotent(stripe, storedSub || {
      id: result.storedSubscriptionId,
      status: stripeStatus
    });
  }
  // Cancel pauses collection but leaves the invoice open. Void after cancel:
  // voiding a past_due subscription's open invoice first can mark it active.
  // A retry sees the stored subscription already canceled and still voids.
  if (storedSub && (plan === 'cancel-stored' || !subscriptionNeedsCancel(storedSub.status))) {
    await voidOpenLatestInvoice(stripe, storedSub);
  }
  await writeSubscriptionSnapshot(uid, subscription, event, customerId, { force: true });
}

async function settleDeletedAccountSubscription(stripe, subscription, deletedAtMs) {
  await cancelSubscriptionIdempotent(stripe, subscription);
  await refundLatestInvoice(stripe, subscription, (invoice) => invoicePaidAfterDeletion(invoice, deletedAtMs));
}

// ===== Referral program: 7 bonus days of AI Coach per new signup =====
// The lock is referrals/{referredUid}, written only here. Clearing
// users/{uid}.referredBy (or deleting that doc) cannot redeem again.
// An account that already has referredBy is migrated into the lock
// without granting another week.

exports.redeemReferral = onCall({ secrets: [referralHashKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const uid = request.auth.uid;
  const referrerUid = request.data?.referrerUid;
  if (!validReferrerUid(referrerUid, uid)) {
    throw new HttpsError('invalid-argument', 'Invalid referral link.');
  }
  if (deletionProtectsAccount(await deletionTombstoneStatus(uid))) {
    throw new HttpsError('failed-precondition', 'Invalid referral link.');
  }
  if (deletionProtectsAccount(await deletionTombstoneStatus(referrerUid))) {
    throw new HttpsError('not-found', 'Referrer not found.');
  }

  let userRecord;
  try {
    userRecord = await getAuth().getUser(uid);
  } catch (err) {
    logger.error('redeemReferral caller lookup failed', { uid, message: err.message });
    throw new HttpsError('failed-precondition', 'Invalid referral link.');
  }
  if (!isNewAccount(userRecord.metadata, Date.now())) {
    throw new HttpsError('failed-precondition', 'Referral is only available for a new account.');
  }

  try {
    await getAuth().getUser(referrerUid);
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') {
      throw new HttpsError('not-found', 'Referrer not found.');
    }
    logger.error('redeemReferral referrer lookup failed', { uid, message: err.message });
    throw new HttpsError('internal', 'Could not redeem referral. Try again.');
  }

  const hashKey = secretValue(referralHashKey);
  if (!hashKey) {
    throw new HttpsError('failed-precondition', 'Referral is unavailable.');
  }
  const now = Date.now();
  const month = referralMonth(now);
  const identityRefs = referralIdentityKeys(userRecord, hashKey).map((id) => db.doc('referralIdentities/' + id));
  let result;
  try {
    result = await db.runTransaction(async (tx) => {
      const redemptionRef = db.doc('referrals/' + uid);
      const userRef = db.doc('users/' + uid);
      const subRef = db.doc('subscriptions/' + referrerUid);
      const monthlyRef = db.doc('referralMonthly/' + referrerUid);
      const identitySnaps = [];
      for (const ref of identityRefs) identitySnaps.push(await tx.get(ref));
      const redemption = await tx.get(redemptionRef);
      const userSnap = await tx.get(userRef);
      const subSnap = await tx.get(subRef);
      const monthSnap = await tx.get(monthlyRef);
      const legacy = userSnap.data()?.referredBy;
      const plan = referralRedeemPlan({
        identitiesExist: identitySnaps.some((snap) => snap.exists),
        redemptionExists: redemption.exists,
        legacyReferrer: legacy,
        monthData: monthSnap.exists ? monthSnap.data() : null,
        month
      });
      if (plan.action === 'capped') return { capped: true };
      if (plan.action === 'already') {
        writeReferralIdentities(tx, identityRefs, identitySnaps, plan.legacy || referrerUid, uid);
        if (!redemption.exists) {
          tx.set(redemptionRef, {
            referrerUid: plan.legacy || referrerUid,
            redeemedAt: FieldValue.serverTimestamp(),
            source: plan.legacy ? 'legacy-user-field' : 'identity'
          });
        }
        return { already: true };
      }
      const currentUntilMs = subSnap.data()?.bonusProUntil?.toMillis?.() || 0;
      const bonus = nextBonusUntil(currentUntilMs, now);
      writeReferralIdentities(tx, identityRefs, identitySnaps, referrerUid, uid);
      tx.set(redemptionRef, {
        referrerUid,
        redeemedAt: FieldValue.serverTimestamp(),
        bonusUntil: new Date(bonus.untilMs)
      });
      tx.set(monthlyRef, { month, count: plan.count + 1 }, { merge: true });
      if (bonus.addedMs > 0) {
        tx.set(subRef, { bonusProUntil: new Date(bonus.untilMs) }, { merge: true });
      }
      // The in-app "you've invited N friends" counter. The client can read
      // it and cannot write it (firestore.rules).
      tx.set(db.doc('users/' + referrerUid), {
        referralCount: FieldValue.increment(1)
      }, { merge: true });
      return { already: false, bonusDays: grantedBonusDays(bonus.addedMs) };
    });
  } catch (err) {
    logger.error('redeemReferral transaction failed', { uid, message: err.message });
    throw new HttpsError('internal', 'Could not redeem referral. Try again.');
  }

  if (result.capped) {
    throw new HttpsError('resource-exhausted', 'Referral limit reached for this month.');
  }
  if (result.already) {
    throw new HttpsError('already-exists', 'Referral already redeemed for this account.');
  }
  return { bonusDays: result.bonusDays };
});

function writeReferralIdentities(tx, refs, snaps, referrerUid) {
  const expireAt = new Date(Date.now() + REFERRAL_RETENTION_MS);
  refs.forEach((ref, index) => {
    if (snaps[index] && snaps[index].exists) return;
    tx.set(ref, {
      referrerUid,
      redeemedAt: FieldValue.serverTimestamp(),
      expireAt
    });
  });
}

function hasActiveAccess(subData) {
  if (!subData) return false;
  if (subData.isPro) return true;
  const bonusUntilMs = subData.bonusProUntil?.toMillis?.() || 0;
  return bonusUntilMs > Date.now();
}

// ===== AI Coach: personalized plan (paid or referral-bonus, checked server-side) =====
exports.generatePersonalPlan = onCall({ secrets: [geminiApiKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const uid = request.auth.uid;

  const subSnap = await db.doc('subscriptions/' + uid).get();
  if (!hasActiveAccess(subSnap.data())) {
    throw new HttpsError('permission-denied', 'This feature requires an active subscription or referral bonus.');
  }

  const userSnap = await db.doc('users/' + uid).get();
  const clipped = clipPlanInput(userSnap.data() || {});
  if (!clipped.goal) {
    throw new HttpsError('failed-precondition', 'Set a goal before generating a personal plan.');
  }

  // ₪14.90/month only covers a handful of Gemini calls. The counter is
  // usage/{uid}, reserved in a transaction before the API call so parallel
  // requests cannot all read 0. The credit comes back only when Gemini
  // itself fails (network, 5xx, quota). A bad JSON reply spends it.
  const today = new Date().toISOString().slice(0, 10);
  const usageRef = db.doc('usage/' + uid);
  let reservedQuota = false;
  let refundQuota = false;
  try {
    const decision = await db.runTransaction(async (tx) => {
      const usageSnap = await tx.get(usageRef);
      const freshUser = await tx.get(db.doc('users/' + uid));
      const claim = claimQuota(
        usageSnap.exists ? usageSnap.data() : null,
        freshUser.data(),
        today,
        DAILY_GEN_LIMIT
      );
      if (!claim.ok) return claim;
      tx.set(usageRef, { aiGenCount: claim.next, aiGenDate: today }, { merge: true });
      return claim;
    });
    if (!decision.ok) {
      throw new HttpsError('resource-exhausted', 'Daily plan generation limit reached, try again tomorrow.');
    }
    reservedQuota = true;

    const genAI = new GoogleGenerativeAI(secretValue(geminiApiKey));
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = [
      `היעד של המשתמש: "${clipped.goal}"`,
      clipped.completedSteps.length ? `צעדים שכבר השלים: ${clipped.completedSteps.join('; ')}` : '',
      clipped.journal.length ? `רגעי אמונה שרשם ביומן שלו: ${clipped.journal.join('; ')}` : '',
      '',
      'בהתבסס על זה, כתוב עבורו:',
      '1. שמונה משפטי אמירה חיוביים אישיים וספציפיים ליעד הזה (לא כלליים) — כל אחד בשורה נפרדת, בגוף ראשון, בניסוח ניטרלי מגדרית.',
      '2. שלוש תובנות קצרות (2-3 משפטים כל אחת) בהשראת "חשוב והתעשר" ו"מדע ההתעשרות" על איך לזהות הזדמנויות הקשורות ליעד הזה בחיי היומיום.',
      '',
      'החזר JSON תקני בלבד, במבנה: {"affirmations": ["...", ...], "insights": ["...", "...", "..."]}'
    ].filter(Boolean).join('\n');

    let result;
    try {
      result = await model.generateContent(prompt);
    } catch (err) {
      refundQuota = geminiFailureRefundable(err);
      logger.error('Gemini generation failed for personal plan', describeGeminiError(err));
      throw new HttpsError('internal', 'AI generation failed. Try again.');
    }

    let parsed;
    try {
      const raw = result.response.text().replace(/```json|```/g, '').trim();
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpsError('internal', 'Could not parse the generated plan — try again.');
    }

    await db.doc('users/' + uid).set({
      personalPlan: {
        affirmations: parsed.affirmations || [],
        insights: parsed.insights || [],
        generatedAt: FieldValue.serverTimestamp()
      }
    }, { merge: true });

    return parsed;
  } catch (err) {
    if (reservedQuota && refundQuota) await releaseQuota(usageRef, today, uid);
    throw err;
  }
});

async function releaseQuota(usageRef, today, uid) {
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(usageRef);
      tx.set(usageRef, releaseCount(snap.data(), today), { merge: true });
    });
  } catch (err) {
    logger.error('Failed to release Gemini quota', { uid, message: err.message });
  }
}

// ===== Weekly proactive AI coach (Pro only) =====
// The point of paying isn't a one-shot content generator — it's not having
// to go re-explain your situation to ChatGPT every week. This runs itself:
// reads what's already in the app (goal, steps, recent journal entries),
// writes one short weekly update, pushes it, and folds the new affirmation
// into the normal rotation. No goal and no journal means nothing to work
// with, so that user is skipped rather than getting a generic message.
exports.sendWeeklyCoachInsight = onSchedule({
  schedule: '0 8 * * 0',
  timeZone: 'Asia/Jerusalem',
  timeoutSeconds: 300,
  secrets: [geminiApiKey]
}, async () => {
  const usersSnap = await db.collection('users').get();
  const deletedIds = await uidsBlockedFromSending(usersSnap.docs.map((doc) => doc.id));
  const tokenOwner = assignTokenOwners(usersSnap.docs.map(userTokenRecord));
  const genAI = new GoogleGenerativeAI(secretValue(geminiApiKey));
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    const uid = userDoc.id;
    if (deletedIds.has(uid)) return;
    try {
      const data = userDoc.data();
      const clipped = clipPlanInput(data);
      const goal = clipped.goal;
      // Journal entries are stored newest-first. clipPlanInput keeps the
      // tail of the array, so take the recent head from the raw list and
      // clip each line.
      const recentJournal = (Array.isArray(data.journal) ? data.journal : [])
        .slice(0, 7)
        .map((entry) => clipText(entry, JOURNAL_ENTRY_MAX))
        .filter(Boolean);
      if (!goal && !recentJournal.length) return;

      const subSnap = await db.doc('subscriptions/' + uid).get();
      if (!hasActiveAccess(subSnap.data())) return;

      const completedSteps = clipped.completedSteps;
      const pendingSteps = clipped.pendingSteps;
      const female = data.addressForm === 'f';

      const prompt = [
        goal ? `היעד של המשתמש: "${goal}"` : '',
        completedSteps.length ? `צעדים שכבר ${female ? 'השלימה' : 'השלים'}: ${completedSteps.join('; ')}` : '',
        pendingSteps.length ? `צעדים שנותרו ${female ? 'לה' : 'לו'}: ${pendingSteps.join('; ')}` : '',
        recentJournal.length
          ? (female
            ? `רגעי אמונה שרשמה ביומן שלה לאחרונה: ${recentJournal.join('; ')}`
            : `רגעי אמונה שרשם ביומן שלו לאחרונה: ${recentJournal.join('; ')}`)
          : '',
        '',
        female
          ? 'פני אל המשתמשת בלשון נקבה. כתבי עבורה עדכון שבועי קצר, אישי, וממוקד בפעולה למרות הפחד:'
          : 'פני אל המשתמש בלשון זכר. כתוב עבורו עדכון שבועי קצר, אישי, וממוקד בפעולה למרות הפחד:',
        female
          ? '1. תובנה אחת (2-3 משפטים) על ההתקדמות, מבוססת רק על מה שלמעלה. אם יש היסוס או דחייה, דברי עליהם ישירות.'
          : '1. תובנה אחת (2-3 משפטים) על ההתקדמות, מבוססת רק על מה שלמעלה. אם יש היסוס או דחייה, דבר עליהם ישירות.',
        '2. אתגר אחד לשבוע הקרוב: צעד קונקרטי אחד שנדחה מתוך פחד, ושנעשה גם כשהלב דופק. לא תוכנית מושלמת — פעולה קטנה.',
        '3. משפט אמירה חיובי אחד וחדש, ספציפי למצב, שמחזק פעולה למרות הפחד.',
        '',
        'החזר JSON תקני בלבד, במבנה: {"insight": "...", "challenge": "...", "affirmation": "..."}'
      ].filter(Boolean).join('\n');

      let result;
      try {
        result = await model.generateContent(prompt);
      } catch (err) {
        logger.error('Weekly coach Gemini call failed', { uid, ...describeGeminiError(err) });
        return;
      }

      let parsed;
      try {
        const raw = result.response.text().replace(/```json|```/g, '').trim();
        parsed = JSON.parse(raw);
      } catch (err) {
        logger.error('Weekly coach parse failed', { uid, message: err.message });
        return;
      }

      await db.doc('users/' + uid).set({
        weeklyCoach: {
          insight: parsed.insight || '',
          challenge: parsed.challenge || '',
          affirmation: parsed.affirmation || '',
          generatedAt: FieldValue.serverTimestamp()
        }
      }, { merge: true });

      const split = tokensForUser(userTokenRecord(userDoc), tokenOwner);
      await dropStaleFcmTokens(userDoc, split.stale);
      const tokens = split.owned;
      if (tokens.length && (parsed.challenge || parsed.insight)) {
        await messaging.sendEachForMulticast({
          tokens,
          notification: {
            title: 'המאמן השבועי שלך 🎯',
            body: parsed.challenge || parsed.insight
          },
          webpush: { fcmOptions: { link: APP_URL } }
        }).catch(() => null);
      }
    } catch (err) {
      logger.error('Weekly coach failed for user', { uid, message: err.message });
    }
  }));
});

// One collection read per run, ids plus status only. A failed read blocks
// every candidate so a tombstone outage cannot look like "not deleted".
async function uidsBlockedFromSending(uids) {
  if (!uids.length) return new Set();
  try {
    const snap = await db.collection('deletedAccounts').select('status').get();
    return blockedSenderUids(
      snap.docs.map((doc) => ({ id: doc.id, status: doc.get('status') })),
      uids,
      false
    );
  } catch (err) {
    logger.error('Could not read deletedAccounts; skipping sends', { message: err.message });
    return blockedSenderUids([], uids, true);
  }
}

async function deletionTombstoneStatus(uid) {
  const record = await deletionTombstoneRecord(uid);
  return record ? record.status : null;
}

function timestampMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : null;
}

async function deletionTombstoneRecord(uid) {
  const snap = await db.doc('deletedAccounts/' + uid).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    status: data.status || 'pending',
    deletedAtMs: timestampMillis(data.deletedAt)
  };
}

function retryableWebhookError(message) {
  const err = new Error(message);
  err.retryWebhook = true;
  return err;
}

// Payment landed for an account that is already pending or done. Cancel the
// subscription and refund a collected charge. Do not only drop our row.
async function revokeCheckoutForDeletedAccount(stripe, session) {
  const subId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription && session.subscription.id;
  if (subId) {
    try {
      await stripe.subscriptions.cancel(subId);
    } catch (err) {
      if (stripeCallFailure(err) === 'stop') throw retryableWebhookError(err.message);
    }
  }
  // mode=subscription leaves session.payment_intent null. The money is on the invoice.
  const invoiceId = invoiceIdFromCheckoutSession(session);
  if (!invoiceId) throw retryableWebhookError('checkout session has no invoice');
  let invoice;
  try {
    invoice = await stripe.invoices.retrieve(invoiceId);
  } catch (err) {
    throw retryableWebhookError(err && err.message);
  }
  const plan = refundPlanFromInvoice(invoice);
  const outcome = await applyRefundPlan(plan, (refundPlan) => {
    const body = refundPlan.paymentIntentId
      ? { payment_intent: refundPlan.paymentIntentId }
      : { charge: refundPlan.chargeId };
    return stripe.refunds.create(body, { idempotencyKey: refundPlan.idempotencyKey });
  });
  if (outcome === 'retry') {
    throw retryableWebhookError('refund did not complete for ' + invoiceId);
  }
}

async function cancelCustomerSubscriptions(stripe, customerId, uid) {
  if (!customerId) return;
  let listed;
  try {
    listed = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100
    });
  } catch (err) {
    if (stripeCallFailure(err) === 'continue') return;
    logger.error('Stripe list during account deletion failed', { uid, message: err.message });
    throw new HttpsError('failed-precondition', 'stripe-cancel-failed');
  }
  for (const subId of idsToCancel(listed.data)) {
    try {
      await stripe.subscriptions.cancel(subId);
    } catch (err) {
      if (stripeCallFailure(err) === 'continue') continue;
      logger.error('Stripe cancel during account deletion failed', { uid, subId, message: err.message });
      throw new HttpsError('failed-precondition', 'stripe-cancel-failed');
    }
  }
}

async function customerIdsForUser(stripe, uid, hint) {
  const ids = new Set();
  if (hint) ids.add(hint);
  const mapped = await db.collection('stripeCustomers').where('uid', '==', uid).get();
  mapped.docs.forEach((docSnap) => ids.add(docSnap.id));
  // Free accounts have no customer. Searching Stripe for them, and failing
  // the deletion when search errors, would block a user who never paid.
  if (ids.size === 0) return [];
  try {
    const found = await stripe.customers.search({
      query: "metadata['uid']:'" + uid + "'",
      limit: 100
    });
    (found.data || []).forEach((customer) => {
      if (customer && customer.id) ids.add(customer.id);
    });
  } catch (err) {
    logger.error('Stripe customer search failed during account deletion; continuing with known customers', { uid, message: err.message });
  }
  return [...ids];
}

async function clearReferralIdentityUsers(uid) {
  const refs = [];
  let hashKey = '';
  try {
    hashKey = secretValue(referralHashKey);
  } catch (err) {
    throw new Error('referral-identity-cleanup-failed');
  }
  if (!hashKey) throw new Error('referral-identity-cleanup-failed');
  try {
    const userRecord = await getAuth().getUser(uid);
    referralIdentityKeys(userRecord, hashKey).forEach((id) => {
      refs.push(db.doc('referralIdentities/' + id));
    });
  } catch (err) {
    if (!err || err.code !== 'auth/user-not-found') throw err;
  }
  const asReferrer = await db.collection('referralIdentities').where('referrerUid', '==', uid).get();
  asReferrer.docs.forEach((docSnap) => refs.push(docSnap.ref));
  const seen = new Set();
  for (const ref of refs) {
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    const snap = await ref.get();
    if (!snap.exists) continue;
    await ref.set({
      referrerUid: FieldValue.delete(),
      firebaseUid: FieldValue.delete()
    }, { merge: true });
  }
  // referrals/{invitedUid} still names this account as the inviter. The
  // invited account's own doc is deleted when that account is deleted.
  const invited = await db.collection('referrals').where('referrerUid', '==', uid).get();
  for (const docSnap of invited.docs) {
    await docSnap.ref.set({ referrerUid: FieldValue.delete() }, { merge: true });
  }
}

// Idempotent. Auth is deleted last, so until that succeeds the person is
// still signed in and can call this again. A scheduled job runs the same
// steps for pending tombstones, except one whose Stripe cancel started
// inside the grace window.
//
// Another device can still write users/{uid} for up to an hour because an
// ID token stays valid. dropRewrittenDeletedUser removes those writes, and
// the reminder jobs skip any uid in deletedAccounts. firestore.rules denies
// the write while deletedAccounts/{uid} exists. Publishing those rules is a
// separate step from the functions deploy (see PLAY_RELEASE.md).
async function finishAccountDeletion(uid, customerHint) {
  const tombRef = db.doc('deletedAccounts/' + uid);
  const tombSnap = await tombRef.get();
  const tomb = tombSnap.data() || {};
  if (tomb.status === 'done') return { deleted: true, status: 'done' };

  let customerId = customerHint || tomb.customerId || null;
  if (!customerId) {
    const subSnap = await db.doc('subscriptions/' + uid).get();
    customerId = subSnap.data()?.stripeCustomerId || null;
  }

  const stripe = stripeClient();
  const customerIds = await customerIdsForUser(stripe, uid, customerId);
  const generatedAttemptId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  // Create or claim inside one transaction. The attempt id written here is
  // always this call's, so a second call cannot roll back the first.
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(tombRef);
    const data = snap.exists ? (snap.data() || {}) : null;
    if (data && data.status === 'done') return { done: true };
    const existedBefore = !!data;
    const attemptId = attemptIdWrittenByCall(data && data.attemptId, generatedAttemptId);
    const startedAt = Date.now();
    if (!existedBefore) {
      // pending, but younger than the grace window, so the hourly job skips it.
      // A failed cancel deletes this doc again, so the account stays.
      tx.set(tombRef, {
        deletedAt: new Date(startedAt),
        status: 'pending',
        attemptId,
        cancelStartedAt: startedAt,
        customerId: customerIds[0] || customerId || null
      });
      return { existedBefore: false, attemptId };
    }
    // Keep the refund cutoff. Do not refresh cancelStartedAt, or the hourly
    // retry would wait out the grace window.
    const patch = {
      attemptId,
      customerId: customerIds[0] || customerId || data.customerId || null
    };
    if (!data.deletedAt) patch.deletedAt = new Date(startedAt);
    if (data.status !== 'pending') patch.status = 'pending';
    tx.set(tombRef, patch, { merge: true });
    return { existedBefore: true, attemptId };
  });
  if (claim.done) return { deleted: true, status: 'done' };
  const existedBefore = claim.existedBefore;
  const attemptId = claim.attemptId;
  try {
    for (const id of customerIds) {
      await cancelCustomerSubscriptions(stripe, id, uid);
    }
  } catch (err) {
    if (isStripeCancelFailed(err) && existedBefore) {
      throw new HttpsError('failed-precondition', cancelFailureErrorCode(true));
    }
    if (freshCancelFailureRemovesTombstone(existedBefore, err, { status: 'pending', attemptId }, attemptId)) {
      const outcome = await rollBackFreshTombstone(tombRef, attemptId, uid);
      throw new HttpsError('failed-precondition', errorCodeForRollbackOutcome(outcome));
    }
    throw err;
  }
  if (!existedBefore) {
    // Cancel succeeded. Later steps may fail and must be retried immediately.
    await tombRef.set({ cancelStartedAt: FieldValue.delete() }, { merge: true });
  }

  await db.doc('users/' + uid).delete();
  await db.doc('subscriptions/' + uid).delete();
  await db.doc('usage/' + uid).delete();
  // The hash stays so the same Google account cannot redeem again. The
  // user ids on that doc are removed. A TTL on expireAt drops the hash later.
  try {
    await clearReferralIdentityUsers(uid);
  } catch (err) {
    logger.error('Could not clear referral identity user ids; tombstone stays pending for the hourly retry', { uid, message: err && err.message });
    throw new HttpsError('internal', 'referral-identity-cleanup-failed');
  }
  await db.doc('referrals/' + uid).delete();
  await db.doc('referralMonthly/' + uid).delete();
  for (const id of customerIds) {
    await db.doc('stripeCustomers/' + id).delete();
    try {
      await stripe.customers.del(id);
    } catch (err) {
      if (stripeCallFailure(err) === 'stop') {
        logger.error('Stripe customer delete failed; Auth user kept so this can retry', { uid, message: err.message });
        throw new HttpsError('failed-precondition', 'stripe-customer-delete-failed');
      }
    }
  }

  try {
    await getAuth().deleteUser(uid);
  } catch (err) {
    if (!err || err.code !== 'auth/user-not-found') {
      logger.error('Auth delete failed; Firestore data is already removed and the login can retry', { uid, message: err && err.message });
      throw new HttpsError('internal', 'auth-delete-failed');
    }
  }

  await tombRef.set({ status: 'done', customerId: customerId || null }, { merge: true });
  return { deleted: true, status: 'done' };
}

exports.deleteAccount = onCall({ secrets: [stripeSecretKey, referralHashKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const uid = request.auth.uid;
  const subSnap = await db.doc('subscriptions/' + uid).get();
  try {
    return await finishAccountDeletion(uid, subSnap.data()?.stripeCustomerId || null);
  } catch (err) {
    await noteDeletionAttempt(uid, err);
    throw err;
  }
});

async function noteDeletionAttempt(uid, err) {
  const ref = db.doc('deletedAccounts/' + uid);
  let update = null;
  try {
    await db.runTransaction(async (tx) => {
      update = null;
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      update = nextDeletionAttempt(snap.get('attempts'), err);
      tx.set(ref, {
        attempts: update.attempts,
        lastError: update.lastError
      }, { merge: true });
    });
  } catch (writeErr) {
    logger.error('Could not record a deletion attempt', {
      uid,
      message: writeErr && writeErr.message
    });
    return null;
  }
  if (update && update.stuck) {
    logger.error('deletion-stuck', {
      uid,
      attempts: update.attempts,
      lastError: update.lastError
    });
  }
  return update;
}

async function releaseRollbackFailedTombstone(tombRef, attemptId) {
  let released = false;
  await db.runTransaction(async (tx) => {
    released = false;
    const snap = await tx.get(tombRef);
    if (!snap.exists) return;
    if (!rollbackFailedReleaseMatches(snap.data(), attemptId)) return;
    tx.delete(tombRef);
    released = true;
  });
  return released;
}

async function deleteMatchingTombstone(tombRef, attemptId) {
  let outcome = 'kept';
  await db.runTransaction(async (tx) => {
    outcome = 'kept';
    const snap = await tx.get(tombRef);
    if (!snap.exists) {
      outcome = 'removed';
      return;
    }
    if (!tombstoneRollbackMatches(snap.data(), attemptId)) return;
    tx.delete(tombRef);
    outcome = 'removed';
  });
  return outcome;
}

async function markRollbackFailed(tombRef, attemptId) {
  let marked = false;
  await db.runTransaction(async (tx) => {
    marked = false;
    const snap = await tx.get(tombRef);
    if (!snap.exists) return;
    if (!tombstoneRollbackMatches(snap.data(), attemptId)) return;
    tx.set(tombRef, { status: 'rollback-failed' }, { merge: true });
    marked = true;
  });
  return marked;
}

async function rollBackFreshTombstone(tombRef, attemptId, uid) {
  let failedTries = 0;
  while (rollbackAfterFailure(failedTries) === 'retry') {
    try {
      return await deleteMatchingTombstone(tombRef, attemptId);
    } catch (err) {
      failedTries += 1;
      if (rollbackAfterFailure(failedTries) === 'retry') {
        logger.warn('deletion tombstone rollback failed; retrying once', {
          uid,
          message: err && err.message
        });
        continue;
      }
      logger.error('deletion tombstone rollback-failed', {
        uid,
        message: err && err.message
      });
      try {
        const marked = await markRollbackFailed(tombRef, attemptId);
        return marked ? 'rollback-failed' : 'kept';
      } catch (markErr) {
        logger.error('could not mark deletion tombstone rollback-failed', {
          uid,
          message: markErr && markErr.message
        });
        // The doc is still pending. The hourly job finishes that deletion.
        return 'kept';
      }
    }
  }
  return 'kept';
}

exports.finishPendingAccountDeletions = onSchedule({
  schedule: 'every 60 minutes',
  secrets: [stripeSecretKey, referralHashKey]
}, async () => {
  const now = Date.now();
  const [pending, rollbackFailed] = await Promise.all([
    db.collection('deletedAccounts').where('status', '==', 'pending').get(),
    db.collection('deletedAccounts').where('status', '==', 'rollback-failed').get()
  ]);
  for (const tomb of rollbackFailed.docs) {
    try {
      const released = await releaseRollbackFailedTombstone(tomb.ref, tomb.get('attemptId'));
      if (released) {
        logger.info('released rollback-failed deletion tombstone; account was not deleted', {
          uid: tomb.id
        });
      }
    } catch (err) {
      const update = await noteDeletionAttempt(tomb.id, err);
      logger.error('Could not release a rollback-failed deletion tombstone', {
        uid: tomb.id,
        message: update ? update.lastError : ''
      });
    }
  }
  const due = pending.docs.filter((tomb) => pendingDeletionDue({
    status: tomb.get('status'),
    cancelStartedAt: tomb.get('cancelStartedAt')
  }, now));
  for (const tomb of due) {
    try {
      await finishAccountDeletion(tomb.id, tomb.data()?.customerId || null);
    } catch (err) {
      const update = await noteDeletionAttempt(tomb.id, err);
      if (!update || !update.stuck) {
        logger.error('Pending account deletion did not finish', {
          uid: tomb.id,
          message: update ? update.lastError : ''
        });
      }
    }
  }
});

// A still-valid ID token can recreate users/{uid} after deletion. Drop it.
exports.dropRewrittenDeletedUser = onDocumentWritten({
  document: 'users/{uid}',
  region: FIRESTORE_TRIGGER_REGION
}, async (event) => {
  if (!event.data || !event.data.after.exists) return;
  const uid = event.params.uid;
  const status = await deletionTombstoneStatus(uid);
  if (!deletionTombstoneActive(status)) return;
  await event.data.after.ref.delete();
});
