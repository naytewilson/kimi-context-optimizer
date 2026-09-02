/**
 * Savings-accounting invariants.
 *
 * KCO may observe real Kimi usage, but a blocked read is a counterfactual: the
 * provider never tokenized the blocked result. Therefore blocked-read savings
 * MUST be labeled estimated unless an exact tokenizer/counterfactual oracle is
 * available. These tests enforce the accounting identity and prevent the UI
 * from turning prompt-cache counters into fake context savings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KCO_HOME = mkdtempSync(join(tmpdir(), 'kco-savings-state-'));
process.env.KIMI_CODE_HOME = mkdtempSync(join(tmpdir(), 'kco-savings-kimi-'));

async function accounting() {
  try { return await import('../src/savings-accounting.js'); }
  catch { assert.fail('savings-accounting.js must exist'); }
}

test('net savings estimate is gross avoided minus every model-visible KCO overhead, with no zero clamp', async () => {
  const s = await accounting();
  assert.deepEqual(s.computeSavingsEstimate({
    grossAvoidedReadTokensEstimated: 10_000,
    blockOverheadTokensEstimated: 700,
    noticeOverheadTokensEstimated: 300,
  }), {
    grossAvoidedReadTokensEstimated: 10_000,
    blockOverheadTokensEstimated: 700,
    noticeOverheadTokensEstimated: 300,
    totalOverheadTokensEstimated: 1_000,
    netAvoidedTokensEstimated: 9_000,
    classification: 'ESTIMATED',
  });

  const negative = s.computeSavingsEstimate({
    grossAvoidedReadTokensEstimated: 100,
    blockOverheadTokensEstimated: 150,
    noticeOverheadTokensEstimated: 75,
  });
  assert.equal(negative.netAvoidedTokensEstimated, -125,
    'negative net must remain visible instead of being clamped to zero');
});

test('blocked read estimate uses the actual requested text range, not average line length', async () => {
  const s = await accounting();
  const f = join(tmpdir(), `kco-range-${process.pid}.js`);
  writeFileSync(f, [
    'x',
    'const veryLong = "' + 'a'.repeat(380) + '";',
    'y',
    'z',
  ].join('\n'));

  const full = s.estimateReadRangeTokens(f, { offset: 0, limit: 4, calibrationFactor: 1 });
  const narrow = s.estimateReadRangeTokens(f, { offset: 1, limit: 1, calibrationFactor: 1 });
  assert.ok(full.tokensEstimated > narrow.tokensEstimated);
  assert.ok(narrow.characters > 380, `expected actual long line chars, got ${narrow.characters}`);
  assert.equal(full.classification, 'ESTIMATED');
  assert.equal(narrow.classification, 'ESTIMATED');
});

test('notice overhead is charged when text is delivered, not merely queued', async () => {
  const notices = await import('../src/notices.js');
  const sid = `session-savings-notice-${process.pid}`;
  const text = '[context-budget] compact for quota efficiency';

  assert.equal(notices.queueNotice(sid, { kind: 'savings:delivery', text }), true);
  assert.equal(notices.loadLedger(sid).tokensInjected || 0, 0,
    'queued-but-never-delivered text did not enter model context');

  assert.equal(notices.flushPendingNotices(sid), text);
  assert.ok((notices.loadLedger(sid).tokensInjected || 0) > 0,
    'delivery charges the model-visible estimated overhead');
});

test('prompt-cache reads are usage/replay input, not blocked-read token savings', async () => {
  const dashboard = await import('../src/dashboard.js');
  const d = {
    hasData: true,
    model: 'k3', contextWindow: 262144, effectiveBudget: 200000,
    used: 100000, inTok: 500000, outTok: 1000, dollars: null,
    cacheEcon: { hitPct: 80, cacheReadTokens: 400000, steps: 10, breaks: 0, dollars: null },
    savingsClassification: 'ESTIMATED',
    saved: 0, savedGross: 0, blockOverhead: 0, overhead: 0, blocked: 0,
    filesLoaded: 0, totalReads: 0, totalEdits: 0, wastedReads: 0,
    cold: [], useful: [], reclaimable: 0, wastePct: 0,
    failedCalls: 0, delegations: 0, prompt: null,
  };
  const board = dashboard.renderBoard(d);
  assert.match(board, /cache-read input/i);
  assert.doesNotMatch(board, /served from cache instead of fresh context/i);
  assert.doesNotMatch(board, /fresh input avoided/i);
});

test('session summary labels blocked-read token savings as an estimate, never proven ground truth', async () => {
  const dashboard = await import('../src/dashboard.js');
  const d = {
    hasData: true,
    model: 'k3', contextWindow: 262144, effectiveBudget: 200000,
    used: 100000, inTok: 120000, outTok: 1000, dollars: null,
    cacheEcon: null,
    savingsClassification: 'ESTIMATED',
    saved: 9000, savedGross: 10000, blockOverhead: 700, overhead: 300, blocked: 2,
    filesLoaded: 0, totalReads: 0, totalEdits: 0, wastedReads: 0,
    cold: [], useful: [], reclaimable: 0, wastePct: 0,
    failedCalls: 0, delegations: 0, prompt: null,
  };
  const summary = dashboard.renderSummary(d);
  assert.match(summary, /estimated/i);
  assert.doesNotMatch(summary, /context window worked like/i);
  assert.doesNotMatch(summary, /KCO saved 9\.0K tokens this session/i,
    'unqualified exact-sounding savings headline is forbidden');
});
