# Security follow-ups (owner only)

Code changes for the 2026-11-02 review are in the repo. Nothing in this file has been applied. Do not treat a merge as permission to change IAM, rotate keys, or deploy. Each item needs the project owner in Google Cloud, Firebase, Stripe, or GitHub.

## Before the new code is live

1. **Firestore rules are not deployed by the functions workflow.** After reviewing `firestore.rules`, publish them yourself:

   `firebase deploy --only firestore:rules --project positive-affirmations-9f382`

   Until that happens, a signed-in client can still write `users/{uid}` without a field allowlist. The new functions no longer trust `referredBy` or `aiGenCount` on that doc, but the rules are what stop the write itself and what stop a deleted account from recreating `users/{uid}`.

2. **Stripe webhook events.** The handler now processes `customer.subscription.created`, `customer.subscription.updated`, and `customer.subscription.deleted`, and sets Pro only for `active` and `trialing` on the allowlisted price. In the Stripe dashboard, the endpoint must subscribe to those three events plus `checkout.session.completed`. If `updated` is not subscribed, a `past_due` or `unpaid` subscription stays Pro until some other event arrives.

3. **Referral backfill.** New redemptions are stored in `referrals/{uid}` inside a transaction. A user who still has `users/{uid}.referredBy` and calls redeem again is migrated into that doc without another bonus. Someone who already cleared `referredBy`, and whose Auth account is still inside the 24-hour new-account window, can receive one more bonus the first time they call the new function. Accounts older than 24 hours cannot redeem even if the field is empty. Optional one-time copy, before or with the functions deploy: for each `users/{uid}` where `referredBy` is a non-empty string and `referrals/{uid}` does not exist, create `referrals/{uid}` with that `referrerUid` and do not add bonus days.

4. **Gemini counters.** The authoritative counter is `usage/{uid}`. The first call after deploy, if that doc is missing, seeds from `users/{uid}.aiGenCount` / `aiGenDate`. A client who already zeroed those fields gets a fresh 5 for that day. After `usage/{uid}` exists, the user doc is ignored.

5. **Popular list.** The next `aggregatePopularAffirmations` run (daily) overwrites `stats/popular-affirmations` with catalog lines only. Until that run, the website ignores popular entries that are not in the loaded catalog. Lines already written into `generated-affirmations` while personal favorites were in the prompt are not deleted by this change. Delete that collection in the console if those documents should not remain public.

6. **Trials.** Checkout grants `trial_period_days: 7` only when `subscriptions/{uid}` has no `trialUsed`, Stripe customer, subscription id, status, or `isPro`. Creating the Checkout session sets `trialUsed`. Closing the tab uses up the trial; a Stripe API failure rolls it back. Existing customers with `stripeCustomerId` do not get another trial. No backfill is required for them.

## Runtime service accounts

Every Cloud Function still runs as the default compute service account, which has Editor. `setGlobalOptions` does not set `serviceAccount`.

Create a dedicated runtime service account per function (or one per group that shares the same permissions) and set it on that function. Do not leave Editor on the default compute service account or the App Engine default service account once nothing still needs it. Leave the Google-managed Google APIs service agent as it is.

Minimum roles, and only on the functions that need them:

| Function | Needs |
|---|---|
| All functions that read or write Firestore | `roles/datastore.user` |
| `deleteAccount`, `finishPendingAccountDeletions` | `roles/firebaseauth.admin` (deleteUser) |
| `sendScheduledReminders`, `sendWeeklyCoachInsight` | `roles/firebasecloudmessaging.admin` |
| `stripeWebhook`, `createCheckoutSession`, `createPortalSession`, `deleteAccount`, `finishPendingAccountDeletions` | `roles/secretmanager.secretAccessor` on the Stripe secrets only |
| `generateDailyAffirmations`, `generatePersonalPlan`, `sendWeeklyCoachInsight` | `roles/secretmanager.secretAccessor` on `GEMINI_API_KEY` only |
| `dropRewrittenDeletedUser` and the scheduled functions | `roles/eventarc.eventReceiver` |
| All of them | `roles/logging.logWriter` |

Resource-level secret access, not project-level Secret Accessor. The compute service account also needs `roles/run.invoker` (the last functions deploy failed asking for it) and `roles/eventarc.eventReceiver`. Those are listed in `PLAY_RELEASE.md`. The deploy service account needs to read the project IAM policy (`roles/iam.securityReviewer`) so the deploy can see those bindings. It should not be given `roles/resourcemanager.projectIamAdmin` for this.

After the functions run as the dedicated accounts, remove Editor from:

- `PROJECT_NUMBER-compute@developer.gserviceaccount.com`
- `positive-affirmations-9f382@appspot.gserviceaccount.com`

Confirm nothing else (Cloud Build, a forgotten function) still runs as them before removing it.

`github-deploy`'s `roles/iam.serviceAccountUser` is at project level. Narrow it to the runtime service account of each function, so the deploy key cannot act as the Editor accounts.

## Deploy key

`GCP_SA_KEY` is a long-lived JSON key used by `.github/workflows/deploy-functions.yml`. Replace it with Workload Identity Federation: `google-github-actions/auth` with `workload_identity_provider` and `service_account`, restricted to `repo:uriz1991/positive-affirmations:ref:refs/heads/main`. Then delete the JSON key and check for other user-managed keys on `github-deploy` and `firebase-adminsdk`.

The workflow still authenticates with the JSON key. Federation is not wired up here.

Narrow what the deploy service account can do, after a deploy still succeeds:

- Cloud Functions Admin can drop to Cloud Functions Developer if the deploy still works.
- Artifact Registry Admin is not required for this repo (Writer is).
- Secret Manager Secret Accessor is not required to deploy. Remove it so the key cannot read the Stripe secret or the webhook secret. If binding a runtime account to a secret needs a policy change, grant `secretmanager.secrets.setIamPolicy` on those secrets only, or do that once by hand.
- Firebase Admin is broader than a functions deploy needs. Remove it and confirm a deploy still works. `roles/firebase.viewer` is the upper bound to try.
- `roles/iam.securityReviewer` is the read of the project IAM policy described above. It does not replace a human granting `roles/run.invoker`.

## GitHub

Turn on branch protection for `main`: require a pull request, and do not allow the deploy workflows to run from an unprotected push if that can be required. The functions deploy runs on every push to `main` that touches `functions/`.

Review who has write access, and turn on secret scanning and push protection if they are not already on. Dependabot can keep the pinned action SHAs and `functions/package-lock.json` updated. This change only pins the actions and the lockfile. It does not add branch protection or Dependabot.
