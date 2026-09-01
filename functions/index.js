// Deployed automatically via GitHub Actions (.github/workflows/deploy-functions.yml)
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const geminiApiKey = defineSecret('GEMINI_API_KEY');
const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

const APP_URL = 'https://uriz1991.github.io/positive-affirmations/';

// Secret Manager values have shown up with stray whitespace/newlines from
// copy-paste in the past (e.g. a trailing \n makes Stripe reject an
// otherwise-correct key with "Invalid API Key") — trim defensively everywhere
// a secret is read.
function secretValue(secretParam) {
  return secretParam.value().trim();
}

setGlobalOptions({ region: 'me-west1', maxInstances: 3 });

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// Shown as the notification body when the app itself has no better text to offer.
const FALLBACK_AFFIRMATIONS = [
  'הכל מדויק לי',
  'אני בדיוק במקום הנכון, בזמן הנכון',
  'אני מאמין בעצמי וביכולות שלי',
  'ההצלחה שלי בדרך אליי',
  'אני ראוי לשפע גדול ואני מקבל אותו בפתיחות',
  'כל צעד קטן שלי הוא צעד קדימה',
  'אני חזק יותר ממה שאני חושב'
];

function pickFallbackAffirmation() {
  return FALLBACK_AFFIRMATIONS[Math.floor(Math.random() * FALLBACK_AFFIRMATIONS.length)];
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

  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    const data = userDoc.data();
    const reminders = Array.isArray(data.reminders) ? data.reminders : [];
    const tokens = Array.isArray(data.fcmTokens) ? data.fcmTokens : [];
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

    for (const reminder of reminders) {
      if (!reminder.enabled || !reminder.time || !reminder.id) continue;
      if (alreadySent.includes(reminder.id)) continue;
      if (!isDueNow(currentMinutes, reminder.time)) continue;

      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: {
          title: reminder.label || 'אמירות חיוביות',
          body: pickFallbackAffirmation()
        },
        webpush: {
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
        remindersSentToday: { date: todayKey, sentIds: [...alreadySent, ...newlySent] }
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
    } catch {
      // One category failing (e.g. transient API error) shouldn't block the rest.
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

  const stripe = require('stripe')(secretValue(stripeSecretKey));
  const uid = request.auth.uid;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: uid,
      metadata: { uid },
      subscription_data: { metadata: { uid } },
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

  const stripe = require('stripe')(secretValue(stripeSecretKey));
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
  const stripe = require('stripe')(secretValue(stripeSecretKey));
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
        await db.doc('subscriptions/' + uid).set({
          isPro: true,
          stripeCustomerId: session.customer,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        // Reverse lookup so the cancellation event (which only carries the
        // Stripe customer id, not our uid) can find the right user.
        await db.doc('stripeCustomers/' + session.customer).set({ uid });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const lookup = await db.doc('stripeCustomers/' + customerId).get();
      const uid = lookup.data()?.uid || subscription.metadata?.uid;
      if (uid) {
        await db.doc('subscriptions/' + uid).set({
          isPro: false,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }
  } catch (err) {
    // Stripe retries on non-2xx; still ack so a transient Firestore error
    // doesn't cause endless webhook retries — logged so it's not silent.
    logger.error('Stripe webhook handling failed', { message: err.message, eventType: event?.type });
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
  const journal = Array.isArray(userData.journal) ? userData.journal.slice(-10) : [];
  const completedSteps = (userData.goalData?.steps || []).filter(s => s.done).map(s => s.text);

  const genAI = new GoogleGenerativeAI(secretValue(geminiApiKey));
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

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
    logger.error('Gemini generation failed for personal plan', { message: err.message });
    throw new HttpsError('internal', `AI generation failed: ${err.message}`);
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
});
