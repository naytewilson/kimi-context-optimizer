import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeObservedPairedUsageDelta } from '../src/savings-accounting.js';

function usage(overrides = {}) {
  return {
    totalInput: 0,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalInputSide: 0,
    totalOutput: 0,
    recognizedUsageRows: 1,
    model: 'k3',
    ...overrides,
  };
}

test('paired accounting uses Kimi total-input identity and preserves output tradeoffs', () => {
  const control = usage({
    totalInput: 400,
    totalCacheRead: 500,
    totalCacheCreation: 100,
    totalInputSide: 1000,
    totalOutput: 100,
  });
  const optimized = usage({
    totalInput: 300,
    totalCacheRead: 350,
    totalCacheCreation: 50,
    totalInputSide: 700,
    totalOutput: 120,
  });

  const d = computeObservedPairedUsageDelta(control, optimized);

  assert.equal(d.classification, 'OBSERVED_PAIRED_RUN_DELTA');
  assert.equal(d.comparable, true);
  assert.deepEqual(d.control, {
    inputOtherTokens: 400,
    cacheReadTokens: 500,
    cacheCreationTokens: 100,
    inputTokens: 1000,
    outputTokens: 100,
    totalProviderTokens: 1100,
  });
  assert.deepEqual(d.optimized, {
    inputOtherTokens: 300,
    cacheReadTokens: 350,
    cacheCreationTokens: 50,
    inputTokens: 700,
    outputTokens: 120,
    totalProviderTokens: 820,
  });
  assert.deepEqual(d.avoided, {
    inputOtherTokens: 100,
    cacheReadTokens: 150,
    cacheCreationTokens: 50,
    inputTokens: 300,
    outputTokens: -20,
    totalProviderTokens: 280,
  });
  assert.equal(d.reductionPct.inputTokens, 30);
  assert.equal(d.reductionPct.outputTokens, -20);
  assert.ok(Math.abs(d.reductionPct.totalProviderTokens - (280 / 1100 * 100)) < 1e-12);
  assert.equal(d.subscriptionQuotaEquivalent, null);
  assert.equal(d.causalClaim, false);
});

test('paired accounting never clamps a regression into fake savings', () => {
  const control = usage({ totalInputSide: 1000, totalOutput: 100 });
  const optimized = usage({ totalInputSide: 1200, totalOutput: 150 });
  const d = computeObservedPairedUsageDelta(control, optimized);

  assert.equal(d.avoided.inputTokens, -200);
  assert.equal(d.avoided.outputTokens, -50);
  assert.equal(d.avoided.totalProviderTokens, -250);
  assert.equal(d.reductionPct.inputTokens, -20);
  assert.equal(d.reductionPct.outputTokens, -50);
});

test('different models are arithmetically measurable but not a valid savings comparison', () => {
  const control = usage({ model: 'k3', totalInputSide: 1000, totalOutput: 100 });
  const optimized = usage({ model: 'k3-256k', totalInputSide: 700, totalOutput: 90 });
  const d = computeObservedPairedUsageDelta(control, optimized);

  assert.equal(d.avoided.inputTokens, 300);
  assert.equal(d.comparable, false);
  assert.ok(d.comparabilityReasons.some((x) => /model mismatch/i.test(x)));
});

test('missing provider usage rows makes the pair non-comparable', () => {
  const control = usage({ recognizedUsageRows: 0, totalInputSide: 0, totalOutput: 0 });
  const optimized = usage({ totalInputSide: 700, totalOutput: 90 });
  const d = computeObservedPairedUsageDelta(control, optimized);

  assert.equal(d.comparable, false);
  assert.ok(d.comparabilityReasons.some((x) => /provider usage/i.test(x)));
  assert.equal(d.reductionPct.inputTokens, null);
  assert.equal(d.reductionPct.outputTokens, null);
  assert.equal(d.reductionPct.totalProviderTokens, null);
});

test('paired percentage denominators are the control run and zero denominators return null', () => {
  const zero = usage({ totalInputSide: 0, totalOutput: 0 });
  const optimized = usage({ totalInputSide: 0, totalOutput: 0 });
  const d = computeObservedPairedUsageDelta(zero, optimized);

  assert.equal(d.reductionPct.inputTokens, null);
  assert.equal(d.reductionPct.outputTokens, null);
  assert.equal(d.reductionPct.totalProviderTokens, null);
});
