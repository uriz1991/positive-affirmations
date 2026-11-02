#!/usr/bin/env node
// One-time owner script. Not run by deploy, CI, or this repo's tests.
//
// Compares subscriptions where isPro is true with the live Stripe subscription
// and prints rows whose Stripe status is not active or trialing.
//
// Dry run (default):
//   STRIPE_SECRET_KEY=... GOOGLE_APPLICATION_CREDENTIALS=... \
//     node scripts/reconcile-pro-subscriptions.js
//
// Write the corrected snapshot only when you pass --apply:
//   node scripts/reconcile-pro-subscriptions.js --apply
//
// Requires the functions dependencies (firebase-admin, stripe) to be installed.

const path = require('path');
const apply = process.argv.includes('--apply');

function stripeStatusMeansPro(status) {
  return status === 'active' || status === 'trialing';
}

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Set STRIPE_SECRET_KEY. This script does not run on its own.');
    process.exit(1);
  }
  const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
  const Stripe = require(path.join(__dirname, '..', 'functions', 'node_modules', 'stripe'));
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY.trim());
  const snap = await db.collection('subscriptions').where('isPro', '==', true).get();
  let mismatches = 0;
  for (const docSnap of snap.docs) {
    const data = docSnap.data() || {};
    const subId = data.stripeSubscriptionId;
    if (!subId) {
      mismatches++;
      console.log(docSnap.id + ' isPro=true but has no stripeSubscriptionId');
      continue;
    }
    const subscription = await stripe.subscriptions.retrieve(subId);
    const shouldBePro = stripeStatusMeansPro(subscription.status);
    if (shouldBePro) continue;
    mismatches++;
    console.log(docSnap.id + ' isPro=true stripe=' + subscription.status + ' sub=' + subId);
    if (!apply) continue;
    await docSnap.ref.set({
      isPro: false,
      status: subscription.status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
  console.log((apply ? 'updated ' : 'would update ') + mismatches + ' of ' + snap.size + ' Pro docs');
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
