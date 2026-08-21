const REFERRAL_GOAL = 30;
const REFERRAL_PROMPT_INTERVAL_MS = 4 * 60 * 60 * 1000;
const REFERRAL_REWARD_USD = 5;

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

function getReferralRewardStatus(count, rewarded = 0) {
  const safeCount = Math.max(0, Number(count) || 0);
  const safeRewarded = Math.max(0, Number(rewarded) || 0);
  return {
    rewarded: safeRewarded,
    earnedUsd: safeRewarded * REFERRAL_REWARD_USD,
    currentMilestone: safeCount % REFERRAL_GOAL,
    nextRewardUsd: REFERRAL_REWARD_USD,
    referralsUntilReward: REFERRAL_GOAL - (safeCount % REFERRAL_GOAL)
  };
}

module.exports = { REFERRAL_GOAL, REFERRAL_PROMPT_INTERVAL_MS, REFERRAL_REWARD_USD, getReferralProgress, getReferralRewardStatus, shouldShowReferralPrompt };
