const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const geminiApiKey = defineSecret('GEMINI_API_KEY');

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
  const genAI = new GoogleGenerativeAI(geminiApiKey.value());
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
