const test = require('node:test');
const assert = require('node:assert/strict');

const { getReferralProgress, shouldShowReferralPrompt } = require('../utils/referral');

test('referral progress reflects the current number of registered referrals', () => {
  assert.deepEqual(getReferralProgress(7), { count: 7, goal: 30, percent: 23 });
  assert.deepEqual(getReferralProgress(41), { count: 41, goal: 30, percent: 100 });
});

test('referral prompt is hidden for four hours after dismissal', () => {
  const now = 2_000_000;
  assert.equal(shouldShowReferralPrompt(now, now - 4 * 60 * 60 * 1000 + 1), false);
  assert.equal(shouldShowReferralPrompt(now, now - 4 * 60 * 60 * 1000), true);
  assert.equal(shouldShowReferralPrompt(now, null), true);
});
