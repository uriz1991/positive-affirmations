# העלאה ראשונה ל-Google Play

המסמך הזה הוא רשימת הצעדים שלך. שום דבר כאן לא נפתח, לא פורסם ולא מוזג. אפל תבוא אחר כך, בסוף יש מה עובר אליה.

האתר החי נשאר כרגיל. גרסת החנות היא אותו אתר בתוך Chrome, עם סימן `?source=play` שמסתיר תשלום מחוץ לחנות.

## מה כבר מוכן בבראנץ' הזה

- תיקייה `android/` — עטיפת Trusted Web Activity. האתר לא נכתב מחדש.
- Workflow ידני: Actions → **Build Android AAB**. בונה AAB לבדיקה בלבד. אין secrets בקוד.
- בגרסת Play מוסתרים כפתור השדרוג ל-Stripe, ניהול המנוי, והקישור לתרומה. מי שכבר Pro ומחובר ממשיך לקבל את התכונות.
- מחיקת חשבון בהגדרות ← חשבון, ועמוד ציבורי `delete-account.html`.
- טיוטות לחנות ב-`store/google-play/`.

לפני שמעלים AAB לחנות חייבים למזג את הבראנץ' ולתת לאתר ול-Cloud Functions להתעדכן. בלי זה גרסת החנות עדיין תראה את Stripe, ובלי הפונקציה `deleteAccount` כפתור המחיקה לא ישלים את מחיקת הענן.

## 1. חשבון מפתח

נרשמים ל-Google Play Console (עמלה חד-פעמית). לא יוצרים את זה מתוך הריפו.

חשבון **אישי** שנפתח אחרי 13 בנובמבר 2023 חייב, לפני פרסום לכולם, בדיקה סגורה: לפחות 12 בודקים שנשארו רשומים 14 ימים רצופים. אחר כך מגישים בקשה ל-production מתוך הקונסול. אם החשבון ישן יותר, הדרישה הזו כנראה לא חלה — בודקים מה הקונסול מציג אצלך, לא מנחשים.

## 2. שם החבילה

ברירת המחדל: `io.github.uriz1991.positiveaffirmations`

מחליטים על השם הסופי **לפני** ההעלאה הראשונה. אחרי פרסום אי אפשר להחליף אותו. אם משנים, מעדכנים גם את `android/gradle.properties` וגם את `android/assetlinks.template.json`.

## 3. Digital Asset Links

Chrome בודק את הקובץ רק בשורש הדומיין:

`https://uriz1991.github.io/.well-known/assetlinks.json`

נבדק ב-2 בנובמבר 2026: גם `https://uriz1991.github.io/` וגם הנתיב של assetlinks מחזירים 404. האתר הזה הוא project site תחת `/positive-affirmations/`, אז קובץ בתוך הריפו הזה יגיע לכתובת הלא נכונה ולא יאמת את האפליקציה.

אפשרויות, בלי לפתוח שום ריפו עכשיו:

1. **ריפו נפרד לשם המשתמש** `uriz1991/uriz1991.github.io`, עם קובץ יחיד `.well-known/assetlinks.json` (מעתיקים מ-`android/assetlinks.template.json` אחרי שיש טביעת אצבע אמיתית). אתר המשתמש תופס את שורש `uriz1991.github.io`. אתר הפרויקט ב-`/positive-affirmations/` נשאר. צריך להפעיל GitHub Pages על הריפו החדש.
2. **דומיין משלך** על הפרויקט הזה (CNAME). אז שורש הדומיין הוא הריפו הזה, ואפשר לשים כאן `/.well-known/assetlinks.json`. כתובת הפתיחה ב-`AndroidManifest.xml` חייבת להיות אותו דומיין.

בלי אימות האפליקציה עדיין נפתחת ב-Chrome, אז התחברות, התראות, service worker ומצב לא-מקוון ממשיכים לעבוד. מה שחסר: סרגל הכתובת נשאר למעלה, וההתראות פחות מקושרות לשם האפליקציה. בביקורת של Play לפעמים מבקשים להשלים את האימות.

את טביעת ה-SHA-256 לוקחים מ-Play Console → App integrity → **App signing key certificate**, אחרי ההעלאה הראשונה עם Play App Signing. לא משתמשים בטביעת מפתח ה-debug, ולא בטביעת מפתח ההעלאה, בשביל המשתמשים שמתקינים מהחנות.

## 4. חתימה

ה-AAB מה-workflow חתום ב-debug. לא מעלים אותו.

יוצרים upload keystore (הפקודה ב-`android/README.md`), שומרים אותו מחוץ לגיט, ובונים `bundleRelease`. בהעלאה הראשונה מפעילים Play App Signing. גוגל שומר את מפתח החתימה של האפליקציה. אצלך נשאר רק מפתח ההעלאה. אם הוא אובד, עדכון האפליקציה נתקע.

אחר כך אפשר להכניס את המפתח כ-secrets ל-workflow. לא שמים סיסמה בקוד.

## 5. סדר העלאה

1. לאשר את שם החבילה ואת שם האפליקציה בחנות (הצעות ב-`store/google-play/README.md`).
2. למזג את הבראנץ' ל-main. ה-deploy הקיים מעלה את האתר. שינוי ב-`functions/` מעלה את `deleteAccount` עם ה-workflow של הפונקציות. בלי זה מחיקת החשבון לא מוחקת את הענן.
3. לבנות AAB חתום במפתח ההעלאה.
4. לפתוח אפליקציה ב-Play Console, למלא את טיוטת החנות, מדיניות הפרטיות (`privacy.html`), וקישור מחיקת חשבון (`delete-account.html`).
5. להעלות את ה-AAB למסלול **בדיקה סגורה**, לא ישר ל-production.
6. לצרף בודקים. בחשבון אישי חדש: 12 אנשים, 14 יום.
7. אחרי שהקונסול מאפשר, להגיש ל-production. זה צעד נפרד, לא חלק מהבראנץ' הזה.
8. אחרי שיש App signing certificate, לפרסם את `assetlinks.json` בשורש הדומיין ולוודא שהסרגל נעלם.

## לפני מיזוג: הטריגר הראשון של Eventarc

`dropRewrittenDeletedUser` ב-`functions/index.js` הוא טריגר Firestore הראשון בפרויקט (`onDocumentWritten`, דור 2). טריגר כזה עובד רק על מסד Firestore במצב Native, ובאותו מיקום כמו `FIRESTORE_TRIGGER_REGION`. הקבוע עכשיו הוא `me-west1`. שאר הפונקציות נשארות ב-`FUNCTION_REGION`, גם הוא `me-west1`.

בודקים את המצב והמיקום, ואם `locationId` שונה מ-`me-west1` משנים רק את `FIRESTORE_TRIGGER_REGION` לפני הדיפלוי הראשון:

```bash
gcloud firestore databases list --project positive-affirmations-9f382 --format='table(name,type,locationId)'
```

`type` צריך להיות `FIRESTORE_NATIVE`.

את ה-APIים מפעילים פעם אחת ידנית (עדיף כבעל הפרויקט, בלי לתת לחשבון הדיפלוי `roles/serviceusage.serviceUsageAdmin`):

```bash
gcloud services enable eventarc.googleapis.com run.googleapis.com pubsub.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project positive-affirmations-9f382
```

על חשבון השירות של `GCP_SA_KEY` (זה ש-GitHub Actions משתמש בו לדיפלוי):

- `roles/cloudfunctions.admin`
- `roles/run.admin`
- `roles/eventarc.developer`
- `roles/iam.serviceAccountUser`
- `roles/artifactregistry.writer`
- `roles/cloudbuild.builds.editor`
- `roles/iam.securityReviewer` — קריאה של מדיניות ה-IAM של הפרויקט (`resourcemanager.projects.getIamPolicy`). דיפלוי הפונקציות קורא את המדיניות כדי לבדוק אם כריכה כבר קיימת. בלי זה הוא נכשל לפני שהוא מספיק לדווח מה חסר (הכשל האחרון ביקש את `roles/run.invoker` על חשבון הריצה). התפקיד הזה קורא מדיניות ולא משנה אותה. עדיף על `roles/resourcemanager.projectIamAdmin`.

`roles/artifactregistry.admin` צריך רק אם מגדירים מדיניות ניקוי (cleanup policy). לא נדרש כאן.

בדיפלוי הראשון של הטריגר, כלי הדיפלוי מנסה לעדכן את מדיניות ה-IAM של סוכני גוגל. בלי `roles/resourcemanager.projectIamAdmin` על חשבון הדיפלוי זה נופל עם `failed to modify the IAM policy`. עדיף לא לתת את התפקיד הזה, ובמקום זה בעל הפרויקט נותן את התפקידים לסוכנים פעם אחת:

- `service-PROJECT_NUMBER@gcp-sa-eventarc.iam.gserviceaccount.com` → `roles/eventarc.serviceAgent`
- `service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com` → `roles/iam.serviceAccountTokenCreator` (חובה בפרויקטים שנפתחו לפני אפריל 2021)
- `PROJECT_NUMBER-compute@developer.gserviceaccount.com` (חשבון הריצה) → `roles/eventarc.eventReceiver`
- `PROJECT_NUMBER-compute@developer.gserviceaccount.com` (חשבון הריצה) → `roles/run.invoker`

`roles/run.invoker` על חשבון הריצה חסר היום. דיפלוי הפונקציות האחרון נכשל כי הוא ביקש את הכריכה הזו: פונקציות דור 2 רצות כשירות Cloud Run, ו-Cloud Scheduler / Eventarc צריכים הרשאת invoke על חשבון הריצה. בעל הפרויקט נותן אותה פעם אחת. חשבון הדיפלוי לא צריך `roles/resourcemanager.projectIamAdmin` בשביל זה, אם הכריכה כבר קיימת והוא יכול לקרוא את המדיניות (`roles/iam.securityReviewer` למעלה).

אם בכל זאת נותנים לחשבון הדיפלוי `roles/resourcemanager.projectIamAdmin`, הוא יכול להעניק את התפקידים האלה בעצמו. לא שניהם חובה.

הדיפלוי הראשון עדיין יכול ליפול פעם אחת בזמן שגוגל מסיימים ליצור את סוכן Eventarc. מחכים כמה דקות ומריצים את דיפלוי הפונקציות שוב. זו לא תקלה בקוד.

## 6. מה המשתמש רואה בחנות

מוסתר: שדרוג Stripe, «נהל מנוי», וקישור התרומה (Buy Me a Coffee לא מופיע במסך היום; אם יחזור, גם הוא מוסתר).

נשאר: כל האפליקציה החינמית, התחברות עם Google, סנכרון, תזכורות, ומשתמש Pro קיים. אין עדיין חיוב דרך Play Billing. כשתוסיפו אותו אחר כך, זה עדכון נפרד.

הזמנת חברים עדיין נותנת 7 ימי AI Coach. זה לא תשלום. אם הביקורת תבקש, אפשר להסתיר גם את זה בגרסת Play.

התחברות בגרסת Play עוברת redirect כי חלון קופץ נחסם ב-TWA. באתר נשאר החלון הקופץ.

סיכון שלא תוקן כאן, וצריך בדיקה על טלפון אמיתי לפני העלאה: מ-Chrome 115 הדפדפן מפריד אחסון של אתר צד-שלישי. `signInWithRedirect` רץ מול `authDomain` על `positive-affirmations-9f382.firebaseapp.com`, והאפליקציה עצמה על `uriz1991.github.io`. אלה שני אתרים שונים, וההתחברות בגרסת Play יכולה להיכשל גם כשהחלון הקופץ באתר עובד. לא משנים את זה בבראנץ' הזה.

אפשרויות, בקצרה:

- דומיין משלך על האתר, ואותו דומיין גם כ-`authDomain` ב-Firebase (Authorized domains, ואז עדכון `firebase-init.js`). זה גם פותר את `assetlinks.json`, כי שורש הדומיין יהיה הריפו הזה.
- להשאיר את github.io ורק אחרי בדיקה על מכשיר אמיתי. אם ה-redirect נכשל, לא מעלים לחנות עד שיש דומיין.

מחיקת חשבון לא תלויה ב-redirect. השרת מוחק את משתמש ה-Firebase. אם ביטול מנוי פעיל ב-Stripe נכשל, לא נמחק כלום.

מחיקת חשבון רצה לפי סדר שאפשר לחזור עליו: קודם ביטול המנוי ב-Stripe (לקוח שכבר לא קיים לא עוצר), אחר כך סימון `deletedAccounts/{uid}` במצב `pending`, מחיקת המסמכים, מחיקת לקוח Stripe, ורק בסוף מחיקת משתמש ההתחברות. עד שהשלב האחרון מצליח אפשר ללחוץ שוב. עבודה שנתקעת ב-`pending` ממשיכה מעצמה כל שעה. תזכורות והמאמן השבועי מדלגים על מזהים שנמצאים ב-`deletedAccounts`. כתיבה מחדש של `users/{uid}` אחרי הסימון נמחקת בשרת.

מכשיר אחר עם אסימון שעדיין בתוקף (עד כשעה) יכול לנסות לכתוב. הכלל שסוגר את זה נמצא ב-`firestore.rules` (`notDeleted`: אי אפשר ליצור או לעדכן את `users/{userId}` כל עוד קיים `deletedAccounts/{userId}`). הוא לא עולה עם דיפלוי הפונקציות. מפרסמים אותו בנפרד, אחרי בדיקת האמולטור:

`firebase deploy --only firestore:rules --project positive-affirmations-9f382`

עד שהכללים מפורסמים, `dropRewrittenDeletedUser` עדיין מוחק כתיבה מחדש אחרי הסימון.

## 7. מה עובר לאפל אחר כך

- אותו אתר, אותה מדיניות פרטיות, ואותו עמוד מחיקת חשבון.
- גם אפל דורשת את מנגנון התשלום שלה למנוי דיגיטלי. אפשר להסתיר Stripe באותה צורה, עם סימן נפרד (למשל `source=ios`), בלי לשנות את האתר הרגיל.
- אין ב-iOS מקבילה של TWA. עטיפה לחנות היא בדרך כלל WKWebView או כלי כמו Capacitor, וההתחברות עם Google שם פחות «בחינם» מאשר ב-Chrome.
- אם באפליקציית iOS יש התחברות עם Google, אפל בדרך כלל דורשת גם Sign in with Apple.
- צילומי המסך והאייקון של Play לא מתאימים במידות של App Store. צריך סט חדש.
- שם החבילה באנדרואיד לא קשור ל-bundle id של אפל.

## החלטות שנשארו אצלך

- שם החבילה הסופי, לפני ההעלאה הראשונה.
- שם התצוגה בחנות: עברית «אמירות חיוביות» ואנגלית «Positive Affirmations», או אחת מהחלופות בטיוטה.
- איפה יגור `assetlinks.json`: ריפו `uriz1991.github.io`, או דומיין משלך.
- אם להשאיר את משפט «מנוי קיים מהאתר» בתיאור החנות.
- מתי למזג ולפרוס. בלי זה אין מה להעלות לחנות.
