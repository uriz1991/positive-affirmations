# טיוטת Google Play

לא מעלים את זה לקונסול מהריפו. זה טקסט וקבצים למילוי ידני.

הצילומים צולמו מגרסת Play המקומית (`?source=play`), כדי שלא יופיע בהם כפתור תשלום מחוץ לחנות. המסך עצמו הוא אותו ממשק של האתר החי.

## קבצים

| קובץ | מידה | שימוש |
| --- | --- | --- |
| `icon-512.png` | 512×512 | אייקון החנות, מתוך `assets/icon-512.png` |
| `feature-graphic-1024x500.png` | 1024×500 | Feature graphic |
| `screenshots/01-home.png` … | 1080×1920 | טלפון |

קישור מדיניות פרטיות:

`https://uriz1991.github.io/positive-affirmations/privacy.html`

קישור מחיקת חשבון:

`https://uriz1991.github.io/positive-affirmations/delete-account.html`

שני הקישורים יעבדו אחרי מיזוג ל-main. עמוד המחיקה החדש עדיין לא באתר החי.

## שם האפליקציה (עד 30 תווים)

השם בתוך האפליקציה: «אמירות חיוביות» (`manifest.json` ו-`locales/he.json`). באנגלית: Positive Affirmations.

Play מאפשר שם נפרד לכל שפה. מומלץ:

1. עברית: **אמירות חיוביות** (14 תווים) — אותו שם כמו באפליקציה.
2. אנגלית: **Positive Affirmations** (21 תווים) — אותו שם כמו `locales/en.json`.
3. חלופה קצרה יותר אם רוצים «יומי» בשם: **אמירות יומיות** (13) / **Daily Affirmations** (18).

לא לבחור שם אחד מעורב עברית-אנגלית לשתי השפות. כל שפה מקבלת את השם שלה.

## תיאור קצר (עד 80)

עברית (51 תווים):

משפט חיובי בכל רגע, יעד יומי ותזכורות. בלי פרסומות.

English (60 characters):

A positive affirmation, a daily goal, and reminders. No ads.

## תיאור מלא

### עברית

אמירות חיוביות היא אפליקציה יומית למשפט אחד שמחזיר אותך להאמין, ליעד גדול, ולצעדים קטנים.

מה יש בפנים:

- משפט חדש בכל לחיצה, בעברית, עם קטגוריות של אמונה, ביטחון, שקט, הצלחה, תודה ועוד
- יעד אחד גדול, מחולק לצעדים, עם תזכורת על הצעד של היום
- תזכורות בשעות שאתה בוחר
- מצב מצלמה: אתה רואה את עצמך ואומר את המשפט. שום תמונה לא נשמרת ולא נשלחת
- מועדפים, משפטים אישיים, ויומן «רגעי אמונה»
- עובד גם בלי אינטרנט אחרי הטעינה הראשונה
- בלי פרסומות

התחברות עם Google היא בחירה. היא מסנכרנת את היעד, היומן, המועדפים והתזכורות בין מכשירים, ומאפשרת תזכורות גם כשהאפליקציה סגורה.

אנגלית, צרפתית וספרדית קיימות באפליקציה. צרפתית וספרדית עדיין ניסיוניות. הפנייה בעברית יכולה להיות בלשון זכר או נקבה.

אם כבר יש לך מנוי AI Coach מהאתר, ההתחברות שומרת עליו. בגרסה הזו אין רכישה חדשה בתוך Google Play.

נכתב על ידי אוריאל ציון.

### English

Positive Affirmations is a daily app: one sentence that brings you back to believing, one big goal, and small steps.

What's inside:

- A new affirmation on every tap, in Hebrew first, with categories for faith, confidence, calm, success, gratitude, and more
- One big goal, broken into steps, with today's step kept in view
- Reminders at the times you choose
- Camera mode: you see yourself and say the sentence. No photo is saved or sent
- Favorites, your own sentences, and a belief journal
- Works offline after the first load
- No ads

Google sign-in is optional. It syncs your goal, journal, favorites, and reminders across devices, and it lets reminders arrive when the app is closed.

English, French, and Spanish are in the app. French and Spanish are still experimental. Hebrew can address you in masculine or feminine wording.

If you already have an AI Coach subscription from the website, signing in keeps it. This version does not sell a new subscription inside Google Play.

Developed by Uriel Zion.

המשפט על מנוי קיים הוא החלטה שלך. בלי המשפט, לקוח ששילם באתר לא יבין למה ה-AI Coach עדיין שם. עם המשפט, אין מחיר ואין קישור תשלום.

## Data safety — טיוטה לפי מה שהאפליקציה באמת עושה

לא נמכר מידע. התעבורה מוצפנת (HTTPS, Firebase). אפשר לבקש מחיקה באפליקציה ובעמוד `delete-account.html`.

| סוג | נאסף? | מתי | למה | משותף עם |
| --- | --- | --- | --- | --- |
| שם, אימייל, תמונת פרופיל | כן, אופציונלי | התחברות Google | ניהול חשבון | Google Firebase Auth |
| תוכן שהמשתמש כתב: יעד, צעדים, יומן, מועדפים, משפטים אישיים | כן, רק אחרי התחברות | סנכרון | תפקוד האפליקציה | Firebase Firestore. אצל מנוי Pro גם Google Gemini (יעד, צעדים, יומן אחרון) כדי לייצר תוכנית. לא נשלחים אימייל או כרטיס |
| מזהה מכשיר להתראות (FCM token) | כן, אם אישרו התראות והתחברו | תזכורות | תפקוד האפליקציה | Firebase Cloud Messaging |
| אזור זמן | כן, עם התזכורות | סנכרון | לשלוח תזכורת בשעה הנכונה | Firestore |
| פעילות באפליקציה | כן | אירועים אנונימיים (הוגדר יעד, הושלם צעד). בלי תוכן המשפטים | אנליטיקה | Google Analytics |
| תמונות מהמצלמה | לא | המצלמה מוצגת במכשיר בלבד | — | — |
| מיקום GPS | לא | נשמר אזור זמן, לא מיקום | — | — |
| מספר כרטיס | לא | Stripe באתר מעבד תשלום. אנחנו שומרים רק סטטוס מנוי ומזהה לקוח Stripe, ורק אם נרשמו באתר. גרסת Play לא פותחת תשלום | תפקוד (זיהוי Pro קיים) | Stripe, רק במנוי מהאתר |

«נמכר לצד שלישי»: לא. «משותף» במובן של ספק תשתית: Google (Firebase, Analytics, FCM, Gemini) ו-Stripe למנויי אתר.

בטופס עצמו מסמנים מחיקה: יש דרך באפליקציה ויש עמוד אינטרנט.

## Content rating — צ'קליסט

קטגוריה: כלי עזר / אורח חיים, או Reference / Personalization לפי מה שהשאלון מציע. לא משחק.

- אלימות: אין
- דם, פחד, הימורים: אין
- מין או עירום: אין
- שפה גסה: אין. הטקסט הוא משפטי אמונה וחיזוק
- סמים, אלכוהול, טבק: אין
- שיח עם משתמשים אחרים, צ'אט ציבורי, או תוכן גולשים שכולם רואים: אין. משפט אישי נשאר בחשבון
- שיתוף משפט החוצה (Share) קיים. זה לא רשת חברתית בתוך האפליקציה
- מיקום משותף עם משתמשים אחרים: אין
- רכישה דיגיטלית בתוך גרסת Play: אין בגרסה הזו. לא לסמן IAP עד שיהיה Play Billing
- פרסומות: אין
- תוכן גולשים לא מבוקר שמוצג לאחרים: אין
- גיל יעד: כללי. הציון הצפוי הוא Everyone / PEGI 3 / IARC 3+, אם התשובות למעלה נשארות נכון

השאלון הרשמי ארוך יותר. עונים לפי ההתנהגות של גרסת Play, לא לפי כפתור ה-Stripe שמוסתר בה.

## צילומי מסך

צולמו מגרסת Play המקומית, 1080×1920, בלי כפתור תשלום.

1. `01-home.png` — מסך הבית עם משפט. אין שורת שדרוג.
2. `02-category.png` — קטגוריית «אמונה והשגחה».
3. `03-settings-goal.png` — הגדרות, יעד. כרטיס ה-AI Coach והשדרוג מוסתרים.
4. `04-settings-account.png` — חשבון לפני התחברות: כפתור Google, וקישור «איך מוחקים חשבון». כפתור «מחק חשבון» עצמו מופיע רק אחרי התחברות.
5. `05-reminders.png` — תזכורות.
