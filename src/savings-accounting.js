/**
 * Mathematically conservative savings accounting.
 *
 * Important distinction:
 *   - Kimi wire usage is OBSERVED actual usage.
 *   - A blocked read never reaches Kimi's tokenizer, so its token count is a
 *     COUNTERFACTUAL ESTIMATE. We never promote it to ground truth.
 *
 * Session direct-input estimate:
 *
 *   net_avoided_est = gross_blocked_read_est
 *                     - block_feedback_overhead_est
 *                     - delivered_notice_overhead_est
 *
 * This intentionally does NOT multiply by replay/cache amplification. A
 * blocked result might have been replayed on later calls, but behavior and
 * compaction would also have changed. Replay is reported separately as an
 * observed efficiency signal rather than smuggled into a fake precise saving.
 *
 * For an actual matched control/optimized experiment we can be stricter. Kimi
 * defines total input as:
 *
 *   input = input_other + input_cache_read + input_cache_creation
 *
 * and provider-token volume as:
 *
 *   provider_total = input + output
 *
 * A paired run therefore has an OBSERVED arithmetic delta:
 *
 *   avoided_input  = control_input  - optimized_input
 *   avoided_output = control_output - optimized_output
 *   avoided_total  = control_total  - optimized_total
 *
 * Negative values are regressions and are never clamped away. This is a token
 * volume comparison, NOT a claim about Kimi subscription-quota units: the
 * subscription's weighting/conversion function is not exposed here.
 */

import { readFileSync } from 'fs';
import { extname } from 'path';
import { estimateTokensFromString } from './utils.js';

function nonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function calibratedEstimate(text, ext, calibrationFactor) {
  const factor = typeof calibrationFactor === 'number' && Number.isFinite(calibrationFactor)
    ? Math.min(2, Math.max(0.5, calibrationFactor))
    : 1;
  return Math.max(0, Math.round(estimateTokensFromString(text, ext) * factor));
}

/**
 * Estimate the counterfactual tokens Kimi would have received for a Read.
 * Uses the ACTUAL requested characters from disk, not average chars/line.
 * `offset` is zero-based and `limit` is a line count.
 */
export function estimateReadRangeTokens(
  filePath,
  { offset = 0, limit = 1000, calibrationFactor = 1 } = {},
) {
  try {
    const text = readFileSync(filePath, 'utf8');
    const lines = text.split('\n');
    const safeOffset = Math.max(0, Math.min(lines.length, Math.trunc(offset) || 0));
    const safeLimit = Math.max(0, Math.trunc(limit) || 0);
    const selected = lines.slice(safeOffset, safeOffset + safeLimit).join('\n');
    return {
      tokensEstimated: calibratedEstimate(selected, extname(filePath), calibrationFactor),
      characters: selected.length,
      lines: Math.min(safeLimit, Math.max(0, lines.length - safeOffset)),
      classification: 'ESTIMATED',
    };
  } catch {
    return {
      tokensEstimated: 0,
      characters: 0,
      lines: 0,
      classification: 'ESTIMATED',
    };
  }
}

/** Estimate model-visible KCO text overhead with the same calibrated heuristic. */
export function estimateVisibleTextTokens(text, calibrationFactor = 1) {
  return calibratedEstimate(String(text || ''), '', calibrationFactor);
}

/**
 * Pure counterfactual accounting identity. Negative net is intentionally
 * preserved: if KCO talks more than it prevents, the result must say so rather
 * than flooring at zero and awarding itself a participation trophy.
 */
export function computeSavingsEstimate({
  grossAvoidedReadTokensEstimated = 0,
  blockOverheadTokensEstimated = 0,
  noticeOverheadTokensEstimated = 0,
} = {}) {
  const gross = nonNegativeFinite(grossAvoidedReadTokensEstimated);
  const block = nonNegativeFinite(blockOverheadTokensEstimated);
  const notice = nonNegativeFinite(noticeOverheadTokensEstimated);
  const overhead = block + notice;
  return {
    grossAvoidedReadTokensEstimated: gross,
    blockOverheadTokensEstimated: block,
    noticeOverheadTokensEstimated: notice,
    totalOverheadTokensEstimated: overhead,
    netAvoidedTokensEstimated: gross - overhead,
    classification: 'ESTIMATED',
  };
}

function observedUsageTotals(usage = {}) {
  const inputOtherTokens = nonNegativeFinite(usage.totalInput);
  const cacheReadTokens = nonNegativeFinite(usage.totalCacheRead);
  const cacheCreationTokens = nonNegativeFinite(usage.totalCacheCreation);
  const componentInput = inputOtherTokens + cacheReadTokens + cacheCreationTokens;
  const reportedInputSide = nonNegativeFinite(usage.totalInputSide);

  // wire-usage.js already computes totalInputSide from the three components.
  // Accept a supplied total for callers/tests that only retained the aggregate,
  // otherwise reconstruct it from the Kimi-defined component identity.
  const inputTokens = reportedInputSide > 0 || componentInput === 0
    ? reportedInputSide
    : componentInput;
  const outputTokens = nonNegativeFinite(usage.totalOutput);

  return {
    inputOtherTokens,
    cacheReadTokens,
    cacheCreationTokens,
    inputTokens,
    outputTokens,
    totalProviderTokens: inputTokens + outputTokens,
  };
}

function reductionPercent(controlValue, optimizedValue) {
  if (!(controlValue > 0)) return null;
  return ((controlValue - optimizedValue) / controlValue) * 100;
}

/**
 * Compare two completed Kimi runs using provider-reported token usage.
 *
 * This function proves only the arithmetic difference between the two observed
 * runs. It does not, by itself, prove causality: model stochasticity, cache
 * state, task drift, tool behavior, or environment drift can change a run.
 * Callers should only describe the pair as a savings experiment when those
 * controls were held fixed (ideally over repeated, order-balanced pairs).
 */
export function computeObservedPairedUsageDelta(controlUsage = {}, optimizedUsage = {}) {
  const control = observedUsageTotals(controlUsage);
  const optimized = observedUsageTotals(optimizedUsage);
  const controlHasUsage = nonNegativeFinite(controlUsage.recognizedUsageRows) > 0;
  const optimizedHasUsage = nonNegativeFinite(optimizedUsage.recognizedUsageRows) > 0;

  const comparabilityReasons = [];
  if (!controlHasUsage || !optimizedHasUsage) {
    comparabilityReasons.push('provider usage is missing from one or both runs');
  }

  const controlModel = typeof controlUsage.model === 'string' ? controlUsage.model : null;
  const optimizedModel = typeof optimizedUsage.model === 'string' ? optimizedUsage.model : null;
  if (controlModel && optimizedModel && controlModel !== optimizedModel) {
    comparabilityReasons.push(`model mismatch: ${controlModel} vs ${optimizedModel}`);
  }

  const avoided = {
    inputOtherTokens: control.inputOtherTokens - optimized.inputOtherTokens,
    cacheReadTokens: control.cacheReadTokens - optimized.cacheReadTokens,
    cacheCreationTokens: control.cacheCreationTokens - optimized.cacheCreationTokens,
    inputTokens: control.inputTokens - optimized.inputTokens,
    outputTokens: control.outputTokens - optimized.outputTokens,
    totalProviderTokens: control.totalProviderTokens - optimized.totalProviderTokens,
  };

  const hasObservedPair = controlHasUsage && optimizedHasUsage;
  const reductionPct = {
    inputTokens: hasObservedPair
      ? reductionPercent(control.inputTokens, optimized.inputTokens)
      : null,
    outputTokens: hasObservedPair
      ? reductionPercent(control.outputTokens, optimized.outputTokens)
      : null,
    totalProviderTokens: hasObservedPair
      ? reductionPercent(control.totalProviderTokens, optimized.totalProviderTokens)
      : null,
  };

  return {
    classification: 'OBSERVED_PAIRED_RUN_DELTA',
    comparable: comparabilityReasons.length === 0,
    comparabilityReasons,
    control,
    optimized,
    avoided,
    reductionPct,
    subscriptionQuotaEquivalent: null,
    causalClaim: false,
  };
}
