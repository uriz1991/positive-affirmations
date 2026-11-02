// Pure referral decisions. index.js writes the lock in a transaction.
// referralIdentities/{sha256} survives account deletion. referrals/{uid} does not.
const crypto = require('crypto');

const REFERRAL_BONUS_DAYS = 7;
const MAX_BONUS_DAYS = 365;
const REFERRALS_PER_MONTH = 3;
const REFERRAL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
// creationTime and lastSignInTime match on the first sign-in. A few minutes
// of slack covers clock skew. A later sign-in is not a new account.
const FIRST_SESSION_SLACK_MS = 15 * 60 * 1000;
// Firebase Auth UIDs from Google sign-in are alphanumeric. Rejecting other
// characters also stops a "/" from becoming a nested document path.
const UID_RE = /^[A-Za-z0-9]{20,128}$/;

function validReferrerUid(referrerUid, selfUid) {
  if (typeof referrerUid !== 'string' || typeof selfUid !== 'string') return false;
  if (!referrerUid || referrerUid === selfUid) return false;
  return UID_RE.test(referrerUid);
}

function isNewAccount(metadata, nowMs) {
  const created = Date.parse(metadata && metadata.creationTime);
  const last = Date.parse(metadata && metadata.lastSignInTime);
  if (!Number.isFinite(created) || !Number.isFinite(last) || !Number.isFinite(nowMs)) return false;
  if (nowMs - created > NEW_ACCOUNT_MS) return false;
  if (created - nowMs > 5 * 60 * 1000) return false;
  if (last < created - 60 * 1000) return false;
  if (last - created > FIRST_SESSION_SLACK_MS) return false;
  return true;
}

// Stack 7 days on the later of now and the current bonus end, and never
// past MAX_BONUS_DAYS from now. addedMs 0 means the cap is already reached;
// the redemption is still recorded so it cannot be replayed.
function nextBonusUntil(currentUntilMs, nowMs) {
  const now = Number(nowMs);
  const current = Number(currentUntilMs) || 0;
  const cap = now + MAX_BONUS_DAYS * 86400000;
  const base = Math.max(now, current);
  if (base >= cap) return { untilMs: base, addedMs: 0 };
  const untilMs = Math.min(base + REFERRAL_BONUS_DAYS * 86400000, cap);
  return { untilMs, addedMs: untilMs - base };
}

function grantedBonusDays(addedMs) {
  return Math.round(Number(addedMs) / 86400000);
}

// HMAC so the key is not a bare SHA-256 of an email or Google subject.
// Without the secret the hash is useless; callers must fail closed.
function hashReferralIdentity(value, key) {
  if (typeof key !== 'string' || !key) return null;
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex');
}

// Google's subject (provider uid) is stable across Firebase user deletion.
// Email covers a provider that has no stable subject. The Firebase uid is
// only a fallback when Auth has neither.
function referralIdentityKeys(userRecord, key) {
  const raw = [];
  const providers = (userRecord && userRecord.providerData) || [];
  providers.forEach((provider) => {
    if (provider && provider.providerId && provider.uid) {
      raw.push(provider.providerId + '\n' + provider.uid);
    }
    if (provider && provider.email) {
      raw.push('email\n' + String(provider.email).trim().toLowerCase());
    }
  });
  if (userRecord && userRecord.email) {
    raw.push('email\n' + String(userRecord.email).trim().toLowerCase());
  }
  if (!raw.length && userRecord && userRecord.uid) raw.push('uid\n' + userRecord.uid);
  return [...new Set(raw)].map((value) => hashReferralIdentity(value, key)).filter(Boolean);
}

function referralMonth(nowMs) {
  const date = new Date(Number(nowMs));
  return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
}

function monthCount(data, month) {
  if (!data || data.month !== month) return 0;
  const count = Number(data.count);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

// already: this person (or their Google account) already redeemed. No bonus.
// capped: this referrer already received REFERRALS_PER_MONTH grants this UTC
// month. Do not consume the referee's identity, so a later month can still grant.
// grant: write the identity lock and add the bonus.
function referralRedeemPlan(input) {
  const legacy = typeof input.legacyReferrer === 'string' && input.legacyReferrer;
  if (input.identitiesExist || input.redemptionExists || legacy) {
    return { action: 'already', legacy: legacy || null };
  }
  const count = monthCount(input.monthData, input.month);
  if (count >= REFERRALS_PER_MONTH) return { action: 'capped', count };
  return { action: 'grant', count };
}

module.exports = {
  REFERRAL_BONUS_DAYS,
  MAX_BONUS_DAYS,
  REFERRALS_PER_MONTH,
  REFERRAL_RETENTION_MS,
  NEW_ACCOUNT_MS,
  FIRST_SESSION_SLACK_MS,
  validReferrerUid,
  isNewAccount,
  nextBonusUntil,
  grantedBonusDays,
  hashReferralIdentity,
  referralIdentityKeys,
  referralMonth,
  monthCount,
  referralRedeemPlan
};
