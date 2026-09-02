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
 * Pure accounting identity. Negative net is intentionally preserved: if KCO
 * talks more than it prevents, the result must say so rather than flooring at
 * zero and awarding itself a participation trophy.
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
