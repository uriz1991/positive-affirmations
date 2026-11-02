// Text sent to Gemini is clipped here. A parse failure must not refund the
// daily credit: a subscriber can otherwise keep prompting until the model
// returns non-JSON and never spend the 5/day cap.

const GOAL_MAX = 500;
const JOURNAL_ENTRY_MAX = 300;
const JOURNAL_PROMPT_COUNT = 10;
const STEP_MAX = 300;
const STEP_COUNT = 20;

function clipText(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function clipPlanInput(userData) {
  const goalData = userData && userData.goalData;
  const steps = Array.isArray(goalData && goalData.steps) ? goalData.steps : [];
  const journal = Array.isArray(userData && userData.journal) ? userData.journal : [];
  return {
    goal: clipText(goalData && goalData.goal, GOAL_MAX),
    journal: journal.slice(-JOURNAL_PROMPT_COUNT).map((entry) => clipText(entry, JOURNAL_ENTRY_MAX)).filter(Boolean),
    completedSteps: steps.filter((step) => step && step.done).map((step) => clipText(step.text, STEP_MAX)).filter(Boolean).slice(0, STEP_COUNT),
    pendingSteps: steps.filter((step) => step && !step.done).map((step) => clipText(step.text, STEP_MAX)).filter(Boolean).slice(0, STEP_COUNT)
  };
}

// Refund a reserved Gemini credit only when the API itself failed in a way
// the caller did not cause: network, 5xx, or quota/rate limit.
// A 4xx, a safety block, or a 200 with unparseable text spends the credit.
function geminiFailureRefundable(err) {
  const status = Number(err && (err.status || err.statusCode));
  if (status === 429 || (Number.isFinite(status) && status >= 500)) return true;
  const code = err && err.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED') {
    return true;
  }
  if (Number.isFinite(status) && status > 0) return false;
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('fetch failed')
    || msg.includes('network')
    || msg.includes('socket hang up')
    || msg.includes('timeout')
    || msg.includes('quota')
    || msg.includes('rate limit')
    || msg.includes('resource exhausted')
    || msg.includes('unavailable');
}

module.exports = {
  GOAL_MAX,
  JOURNAL_ENTRY_MAX,
  JOURNAL_PROMPT_COUNT,
  STEP_MAX,
  clipText,
  clipPlanInput,
  geminiFailureRefundable
};
