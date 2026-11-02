// Pure referral decisions. The redemption record itself is referrals/{uid},
// which only the Admin SDK writes. index.js runs that write in a transaction.
const REFERRAL_BONUS_DAYS = 7;
const MAX_BONUS_DAYS = 365;
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

module.exports = {
  REFERRAL_BONUS_DAYS,
  MAX_BONUS_DAYS,
  NEW_ACCOUNT_MS,
  FIRST_SESSION_SLACK_MS,
  validReferrerUid,
  isNewAccount,
  nextBonusUntil,
  grantedBonusDays
};
