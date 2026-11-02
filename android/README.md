# עטיפת אנדרואיד (Trusted Web Activity)

האפליקציה בחנות היא אותו אתר, שנפתח בתוך Chrome. אין כאן WebView נפרד ואין כתיבה מחדש של ההתחברות או של ההתראות.

הספרייה היא `android-browser-helper`, אותה ספרייה ש-Bubblewrap מייצר סביבה. הפרויקט שמור כאן מראש כדי שאפשר לבנות AAB בלי להריץ אשף אינטראקטיבי.

## מה נפתח

`LauncherActivity` פותח:

`https://uriz1991.github.io/positive-affirmations/?source=play`

הפרמטר `source=play` הוא הסימן לאתר להסתיר תשלום מחוץ לחנות (Stripe) וקישור תרומה. בלי הפרמטר, האתר מתנהג כמו היום. הסימן נשמר ל-session גם אם כתובת הדף משתנה אחר כך, וגם אם Chrome שולח `document.referrer` שמתחיל ב-`android-app://`.

## שם החבילה — קבוע אחרי ההעלאה הראשונה

ברירת המחדל, ב-`gradle.properties`:

`io.github.uriz1991.positiveaffirmations`

זה placeholder. אם השם הסופי אחר, משנים אותו **לפני** העלאת ה-AAB הראשון ל-Play, ואותו ערך בדיוק ב-`assetlinks.template.json`. אחרי שהאפליקציה פורסמה, Google לא נותנים להחליף `applicationId`.

`versionCode` מתחיל ב-1. כל העלאה חדשה לחנות חייבת מספר גבוה יותר, ואי אפשר לרדת אחורה.

## בניית AAB לבדיקה

ב-GitHub: Actions → **Build Android AAB** → Run workflow.

ה-workflow רץ רק בלחיצה (`workflow_dispatch`). אין בו secrets. הארטיפקט הוא `app-debug.aab`, חתום בתעודת debug של אנדרואיד. **Play Console ידחה את הקובץ הזה.** הוא רק מוכיח שהפרויקט נבנה.

במחשב, עם Android SDK 36:

```bash
cd android
./gradlew bundleDebug
```

## חתימת העלאה ו-Play App Signing

למסלול בדיקה ולפרסום צריך AAB חתום במפתח **העלאה** (upload key), לא בתעודת debug.

1. יוצרים מפתח פעם אחת ושומרים אותו במקום בטוח. אם הוא אובד, אי אפשר לעדכן את האפליקציה בלי עזרה מגוגל.

```bash
keytool -genkeypair -v -keystore upload-keystore.jks -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

2. מעתיקים את `keystore.properties.example` אל `android/keystore.properties` (הקובץ הזה ב-gitignore) וממלאים את הסיסמאות. שמים את קובץ ה-`.jks` ליד, או נותנים לו נתיב ב-`storeFile`.
3. `./gradlew bundleRelease` יוצר AAB חתום. זה הקובץ שמעלים ל-Play.
4. בהעלאה הראשונה מסמנים את Play App Signing. גוגל מחזיק את מפתח החתימה של האפליקציה. המפתח שיצרתם הוא רק מפתח ההעלאה.
5. ב-Play Console → App integrity מעתיקים את טביעת ה-SHA-256 של **App signing key certificate** (לא של מפתח ההעלאה) אל `assetlinks.template.json`, ואז מפרסמים את הקובץ בשורש הדומיין. בלי זה סרגל הכתובת נשאר. ראו `PLAY_RELEASE.md`.

אחר כך אפשר לשים את ה-keystore ב-GitHub Actions כ-secret (למשל `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`) ולבנות `bundleRelease` ב-workflow. אין לעשות את זה לפני שהמפתח קיים, ואין לשים סיסמה בקוד.

## התחברות עם Google

באתר נשאר חלון קופץ. בתוך ה-TWA חלון קופץ נחסם, ולכן רק בגרסת Play ההתחברות (ואימות מחדש לפני מחיקת חשבון) עוברת דרך redirect של אותו דפדפן. צריך לאשר את זה על מכשיר אמיתי אחרי שהאתר המעודכן באוויר.
