const REFERRAL_GOAL = 30;
const REFERRAL_PROMPT_INTERVAL_MS = 4 * 60 * 60 * 1000;

function getReferralProgress(count) {
  const safeCount = Math.max(0, Number(count) || 0);
  return {
    count: safeCount,
    goal: REFERRAL_GOAL,
    percent: Math.min(100, Math.round((safeCount / REFERRAL_GOAL) * 100))
  };
}

function shouldShowReferralPrompt(now = Date.now(), lastShownAt) {
  if (!lastShownAt) return true;
  return Number(now) - Number(lastShownAt) >= REFERRAL_PROMPT_INTERVAL_MS;
}

module.exports = { REFERRAL_GOAL, REFERRAL_PROMPT_INTERVAL_MS, getReferralProgress, shouldShowReferralPrompt };
