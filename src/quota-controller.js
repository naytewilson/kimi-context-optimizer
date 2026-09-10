/**
 * Quota-efficiency controller for KCO.
 *
 * This module deliberately does not model Moonshot billing. It derives an
 * operational replay signal from Kimi's own wire usage so KCO can notice when
 * a substantial context is being carried through many model steps even though
 * the static context-window percentage is still modest.
 */

export const DEFAULT_QUOTA_POLICY = Object.freeze({
  quotaMode: true,
  quotaMinContextTokens: 80_000,
  quotaMinSteps: 8,
  quotaReplayAmplification: 3.0,
});

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Cumulative input-side work divided by the non-cache-read input side.
 *
 * Denominator = inputOther + cacheCreation. Cache reads are intentionally not
 * called "waste"; a high ratio merely means a large prefix is being replayed
 * relative to newly introduced input and is therefore worth considering for
 * compaction when the context is already substantial.
 */
export function computeReplayAmplification(usage = {}) {
  const inputOther = finiteNonNegative(usage.totalInput);
  const cacheCreation = finiteNonNegative(usage.totalCacheCreation);
  const inputSide = finiteNonNegative(usage.totalInputSide)
    || inputOther + finiteNonNegative(usage.totalCacheRead) + cacheCreation;
  const novelSide = Math.max(inputOther + cacheCreation, 1);
  return Math.round((inputSide / novelSide) * 100) / 100;
}

/** Pure policy gate. */
export function shouldRecommendQuotaCompact({
  contextTokens = 0,
  steps = 0,
  replayAmplification = 0,
  config = {},
} = {}) {
  const policy = { ...DEFAULT_QUOTA_POLICY, ...(config || {}) };
  if (policy.quotaMode === false) {
    return { recommend: false, reason: 'quota mode disabled' };
  }
  if (contextTokens < policy.quotaMinContextTokens) {
    return { recommend: false, reason: 'context below quota threshold' };
  }
  if (steps < policy.quotaMinSteps) {
    return { recommend: false, reason: 'too few usage steps for a stable replay signal' };
  }
  if (replayAmplification < policy.quotaReplayAmplification) {
    return { recommend: false, reason: 'replay amplification below threshold' };
  }
  return {
    recommend: true,
    reason:
      `replay amplification ${replayAmplification.toFixed(2)}x with ` +
      `${Math.round(contextTokens / 1000)}K context across ${steps} usage steps`,
  };
}
