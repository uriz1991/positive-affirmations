// The Gemini daily counter lives in usage/{uid}, which clients cannot write.
// A missing usage doc is seeded once from the legacy users/{uid} counter so
// an honest subscriber does not get a second quota on the day this ships.
// After the usage doc exists, the user doc is ignored.

const DAILY_GEN_LIMIT = 5;

function countForToday(data, today) {
  if (!data || data.aiGenDate !== today) return 0;
  const n = Number(data.aiGenCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

// usageData null means the usage doc does not exist yet.
function claimQuota(usageData, userData, today, limit) {
  const cap = Number(limit);
  const count = usageData ? countForToday(usageData, today) : countForToday(userData, today);
  if (count >= cap) return { ok: false, count };
  return { ok: true, count, next: count + 1, date: today };
}

function releaseCount(data, today) {
  const count = countForToday(data, today);
  return { aiGenCount: Math.max(0, count - 1), aiGenDate: today };
}

module.exports = {
  DAILY_GEN_LIMIT,
  countForToday,
  claimQuota,
  releaseCount
};
