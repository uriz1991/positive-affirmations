const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

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
