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

// One stable Gemini Flash model id for every generateContent call.
// Checked 2026-11-02: stable, and no shutdown date announced.
const GEMINI_MODEL = 'gemini-3.8-flash';

// Status or code plus a short message. Omit errorDetails, prompts, journal
// text, and user ids — errorDetails can echo the request.
function geminiErrorStatus(err) {
  if (!err || typeof err !== 'object') return null;
  if (err.status != null && err.status !== '') return err.status;
  if (err.code != null && err.code !== '') return err.code;
  return null;
}

function shortGeminiMessage(err) {
  const raw = typeof err?.message === 'string' ? err.message.split('\n')[0] : '';
  const compact = raw.replace(/\s+/g, ' ').trim();
  // Prompts and journal text are Hebrew. Keep a short English API line only.
  if (!compact || compact.length > 180 || /[\u0590-\u05FF]/.test(compact)) {
    return 'Gemini request failed';
  }
  return compact;
}

function logGeminiFailure(functionName, err, extra) {
  logger.error('Gemini call failed', {
    functionName,
    model: GEMINI_MODEL,
    status: geminiErrorStatus(err),
    message: shortGeminiMessage(err),
    ...(extra || {})
  });
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
  deletionTombstoneActive,
  checkoutDecision,
  invoiceIdFromCheckoutSession,
  refundPlanFromInvoice,
  applyRefundPlan,
  blockedSenderUids
} = require('./account-deletion');
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
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  // Give the model real examples of what users actually loved, as style
  // reference only — it must write new original lines, never copy these.
  const popularSnap = await db.doc('stats/popular-affirmations').get();
  const popularExamples = (popularSnap.data()?.top || []).slice(0, 8).map(p => p.text);

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
      logGeminiFailure('generateDailyAffirmations', err, { category: key });
    }
  }

  if (written > 0) await batch.commit();
});

// ===== Aggregate what users actually favorited, across everyone =====
exports.aggregatePopularAffirmations = onSchedule('every 24 hours', async () => {
  const usersSnap = await db.collection('users').get();
  const counts = new Map();

  usersSnap.docs.forEach((doc) => {
    const favorites = doc.data().favorites;
    if (!Array.isArray(favorites)) return;
    favorites.forEach((text) => {
      if (typeof text !== 'string' || !text.trim()) return;
      counts.set(text, (counts.get(text) || 0) + 1);
    });
  });

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([text, count]) => ({ text, count }));

  await db.doc('stats/popular-affirmations').set({
    top,
    updatedAt: FieldValue.serverTimestamp()
  });
});

// ===== Stripe: checkout + webhook =====
// Subscription status lives in its OWN doc (subscriptions/{uid}), never in
// users/{uid} — the client's Firestore rule lets a user write their own
// users/{uid} doc, so a subscription flag there could be self-granted from
// devtools. subscriptions/{uid} is client-read-only; only this webhook
// (Admin SDK, bypasses rules) can ever set isPro.

exports.createCheckoutSession = onCall({ secrets: [stripeSecretKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in before upgrading.');
  }
  const priceId = request.data?.priceId;
  if (!priceId || typeof priceId !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing priceId.');
  }

  const stripe = stripeClient();
  const uid = request.auth.uid;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: uid,
      metadata: { uid },
      subscription_data: { metadata: { uid }, trial_period_days: 7 },
      success_url: `${APP_URL}?upgraded=1`,
      cancel_url: APP_URL
    });
  } catch (err) {
    logger.error('Stripe checkout session creation failed', { message: err.message, type: err.type });
    throw new HttpsError('internal', `Stripe error: ${err.message}`);
  }

  return { url: session.url };
});

// Lets a paying user cancel or manage their own subscription — without this,
// the only way to cancel is emailing support, which is not acceptable for a
// real paid product.
exports.createPortalSession = onCall({ secrets: [stripeSecretKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const uid = request.auth.uid;

  const subSnap = await db.doc('subscriptions/' + uid).get();
  const customerId = subSnap.data()?.stripeCustomerId;
  if (!customerId) {
    throw new HttpsError('failed-precondition', 'No active subscription found for this account.');
  }

  const stripe = stripeClient();
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: APP_URL
    });
    return { url: session.url };
  } catch (err) {
    logger.error('Stripe portal session creation failed', { message: err.message });
    throw new HttpsError('internal', `Stripe error: ${err.message}`);
  }
});

exports.stripeWebhook = onRequest({ secrets: [stripeSecretKey, stripeWebhookSecret] }, async (req, res) => {
  const stripe = stripeClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], secretValue(stripeWebhookSecret));
  } catch (err) {
    logger.error('Stripe webhook signature verification failed', { message: err.message });
    res.status(400).send(`Webhook signature error: ${err.message}`);
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.client_reference_id || session.metadata?.uid;
      if (uid) {
        const status = await deletionTombstoneStatus(uid);
        // A missing users/{uid} is normal: checkout often beats the first sync.
        // Only an account that is already being deleted must not become Pro.
        if (checkoutDecision(status) === 'revoke-payment') {
          await revokeCheckoutForDeletedAccount(stripe, session);
          await db.doc('subscriptions/' + uid).delete();
        } else {
          await db.doc('subscriptions/' + uid).set({
            isPro: true,
            stripeCustomerId: session.customer,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          // Reverse lookup so the cancellation event (which only carries the
          // Stripe customer id, not our uid) can find the right user.
          await db.doc('stripeCustomers/' + session.customer).set({ uid });
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const lookup = await db.doc('stripeCustomers/' + customerId).get();
      const uid = lookup.data()?.uid || subscription.metadata?.uid;
      if (uid) {
        if (deletionTombstoneActive(await deletionTombstoneStatus(uid))) {
          await db.doc('subscriptions/' + uid).delete();
        } else {
          await db.doc('subscriptions/' + uid).set({
            isPro: false,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
      }
    }
  } catch (err) {
    logger.error('Stripe webhook handling failed', { message: err.message, eventType: event?.type });
    // A failed cancel/refund for a deleted account must retry. Other failures
    // still ack so a transient Firestore error does not loop forever.
    if (err && err.retryWebhook) {
      res.status(500).json({ error: err.message });
      return;
    }
  }

  res.json({ received: true });
});

// ===== Referral program: 7 bonus days of AI Coach per new signup =====
const REFERRAL_BONUS_DAYS = 7;

exports.redeemReferral = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const uid = request.auth.uid;
  const referrerUid = request.data?.referrerUid;
  if (!referrerUid || typeof referrerUid !== 'string' || referrerUid === uid) {
    throw new HttpsError('invalid-argument', 'Invalid referral link.');
  }

  const userRef = db.doc('users/' + uid);
  const userSnap = await userRef.get();
  if (userSnap.data()?.referredBy) {
    throw new HttpsError('already-exists', 'Referral already redeemed for this account.');
  }

  const referrerSnap = await db.doc('users/' + referrerUid).get();
  if (!referrerSnap.exists) {
    throw new HttpsError('not-found', 'Referrer not found.');
  }

  const subRef = db.doc('subscriptions/' + referrerUid);
  const subSnap = await subRef.get();
  const now = Date.now();
  const currentUntilMs = subSnap.data()?.bonusProUntil?.toMillis?.() || 0;
  const newUntil = new Date(Math.max(now, currentUntilMs) + REFERRAL_BONUS_DAYS * 24 * 60 * 60 * 1000);

  await subRef.set({ bonusProUntil: newUntil }, { merge: true });
  await userRef.set({ referredBy: referrerUid }, { merge: true });
  // Visible on the referrer's own record — both for the in-app "you've
  // invited N friends" counter and so you can see referral activity per
  // user directly in the Firestore console without building a dashboard.
  await db.doc('users/' + referrerUid).set({
    referralCount: FieldValue.increment(1)
  }, { merge: true });

  return { bonusDays: REFERRAL_BONUS_DAYS };
});

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
  const userData = userSnap.data() || {};
  const goal = userData.goalData?.goal || '';
  if (!goal) {
    throw new HttpsError('failed-precondition', 'Set a goal before generating a personal plan.');
  }

  // ₪14.90/month only covers a handful of Gemini calls — without a cap, one
  // user hammering "regenerate" could make a single subscriber unprofitable.
  const DAILY_GEN_LIMIT = 5;
  const today = new Date().toISOString().slice(0, 10);
  const genCountToday = userData.aiGenDate === today ? (userData.aiGenCount || 0) : 0;
  if (genCountToday >= DAILY_GEN_LIMIT) {
    throw new HttpsError('resource-exhausted', 'Daily plan generation limit reached, try again tomorrow.');
  }

  const journal = Array.isArray(userData.journal) ? userData.journal.slice(-10) : [];
  const completedSteps = (userData.goalData?.steps || []).filter(s => s.done).map(s => s.text);

  const genAI = new GoogleGenerativeAI(secretValue(geminiApiKey));
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const prompt = [
    `היעד של המשתמש: "${goal}"`,
    completedSteps.length ? `צעדים שכבר השלים: ${completedSteps.join('; ')}` : '',
    journal.length ? `רגעי אמונה שרשם ביומן שלו: ${journal.join('; ')}` : '',
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
    logGeminiFailure('generatePersonalPlan', err);
    throw new HttpsError('unavailable', 'AI service is temporarily unavailable.');
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
    },
    aiGenCount: genCountToday + 1,
    aiGenDate: today
  }, { merge: true });

  return parsed;
});

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
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    const uid = userDoc.id;
    if (deletedIds.has(uid)) return;
    try {
      const data = userDoc.data();
      const goal = data.goalData?.goal || '';
      const journal = Array.isArray(data.journal) ? data.journal : [];
      if (!goal && !journal.length) return;

      const subSnap = await db.doc('subscriptions/' + uid).get();
      if (!hasActiveAccess(subSnap.data())) return;

      const steps = data.goalData?.steps || [];
      const completedSteps = steps.filter((s) => s.done).map((s) => s.text);
      const pendingSteps = steps.filter((s) => !s.done).map((s) => s.text);
      // Journal entries are stored newest-first with no timestamps, so "this
      // week" is approximated as the most recent handful rather than a real
      // date filter.
      const recentJournal = journal.slice(0, 7);
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
        logGeminiFailure('sendWeeklyCoachInsight', err);
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
  const snap = await db.doc('deletedAccounts/' + uid).get();
  if (!snap.exists) return null;
  return snap.data()?.status || 'pending';
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

// Idempotent. Auth is deleted last, so until that succeeds the person is
// still signed in and can call this again. A scheduled job runs the same
// steps for tombstones left at status pending.
//
// Another device can still write users/{uid} for up to an hour because an
// ID token stays valid. dropRewrittenDeletedUser removes those writes, and
// the reminder jobs skip any uid in deletedAccounts. The Firestore rule that
// would deny the write is documented in PLAY_RELEASE.md and is not deployed
// from this repo.
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
  await cancelCustomerSubscriptions(stripe, customerId, uid);

  await tombRef.set({
    deletedAt: tomb.deletedAt || FieldValue.serverTimestamp(),
    status: 'pending',
    customerId: customerId || null
  }, { merge: true });

  await db.doc('users/' + uid).delete();
  await db.doc('subscriptions/' + uid).delete();
  if (customerId) await db.doc('stripeCustomers/' + customerId).delete();

  if (customerId) {
    try {
      await stripe.customers.del(customerId);
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

exports.deleteAccount = onCall({ secrets: [stripeSecretKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in first.');
  }
  const uid = request.auth.uid;
  const subSnap = await db.doc('subscriptions/' + uid).get();
  return finishAccountDeletion(uid, subSnap.data()?.stripeCustomerId || null);
});

exports.finishPendingAccountDeletions = onSchedule({
  schedule: 'every 60 minutes',
  secrets: [stripeSecretKey]
}, async () => {
  const snap = await db.collection('deletedAccounts').where('status', '==', 'pending').get();
  for (const tomb of snap.docs) {
    try {
      await finishAccountDeletion(tomb.id, tomb.data()?.customerId || null);
    } catch (err) {
      logger.error('Pending account deletion did not finish', { uid: tomb.id, message: err.message });
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
