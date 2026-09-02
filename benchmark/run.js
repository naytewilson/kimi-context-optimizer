#!/usr/bin/env node

/**
 * KCO Synthetic Counterfactual Benchmark
 *
 * This is intentionally NOT a live Kimi A/B and NOT a subscription-quota
 * benchmark. It asks a narrower, defensible question over deterministic files:
 *
 *   If KCO blocks a redundant read, how much direct input text is estimated to
 *   be avoided after subtracting the model-visible KCO feedback required to
 *   block/redirect that read?
 *
 * Runtime and benchmark use the same accounting identity:
 *
 *   net estimate = gross blocked-read estimate - model-visible KCO overhead
 *
 * No replay multiplier. No cache-read tokens counted as savings. No conversion
 * to subscription credits. Humanity has suffered enough denominator crimes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeSavingsEstimate,
  estimateReadRangeTokens,
  estimateVisibleTextTokens,
} from '../src/savings-accounting.js';
import { parseFileStructure, formatDigest } from '../src/file-digest.js';
import { formatTokens } from '../src/utils.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const RESULTS = join(HERE, 'results.json');

function lineCount(filePath) {
  return readFileSync(filePath, 'utf8').split('\n').length;
}

function wholeFileEstimate(filePath) {
  const lines = lineCount(filePath);
  return estimateReadRangeTokens(filePath, {
    offset: 0,
    limit: lines,
    calibrationFactor: 1,
  });
}

function digestFor(filePath) {
  try {
    return formatDigest(parseFileStructure(filePath), lineCount(filePath));
  } catch {
    return '';
  }
}

/**
 * Representative repeat-read feedback using the same evidence class as
 * runtime. The exact wording can evolve; its token cost is always subtracted.
 */
function repeatReadFeedback(filePath, grossTokensEstimated) {
  const lines = lineCount(filePath);
  const digest = digestFor(filePath);
  return (
    `⛔ [read-cache] Already loaded ${basename(filePath)} this session ` +
    `(${lines} lines, ~${formatTokens(grossTokensEstimated)} estimated tokens). ` +
    `File unchanged.\n${digest}\n` +
    `→ Use ReadFile with line_offset/n_lines for the section you actually need.`
  );
}

function ignoreFeedback(filePath) {
  return (
    `🚫 [contextignore] ${basename(filePath)} matches a .contextignore rule. ` +
    `Use Grep, or remove the rule to read it.`
  );
}

function repeatedReadScenario(name, filePath, blockedReads) {
  const one = wholeFileEstimate(filePath);
  const feedback = repeatReadFeedback(filePath, one.tokensEstimated);
  const feedbackTokens = estimateVisibleTextTokens(feedback, 1);
  const gross = one.tokensEstimated * blockedReads;
  const overhead = feedbackTokens * blockedReads;
  const accounting = computeSavingsEstimate({
    grossAvoidedReadTokensEstimated: gross,
    blockOverheadTokensEstimated: overhead,
    noticeOverheadTokensEstimated: 0,
  });

  return {
    name,
    file: basename(filePath),
    blockedReads,
    grossAvoidedTokensEstimated: accounting.grossAvoidedReadTokensEstimated,
    overheadTokensEstimated: accounting.totalOverheadTokensEstimated,
    netAvoidedTokensEstimated: accounting.netAvoidedTokensEstimated,
    classification: accounting.classification,
  };
}

function ignoredReadScenario(name, filePath) {
  const one = wholeFileEstimate(filePath);
  const overhead = estimateVisibleTextTokens(ignoreFeedback(filePath), 1);
  const accounting = computeSavingsEstimate({
    grossAvoidedReadTokensEstimated: one.tokensEstimated,
    blockOverheadTokensEstimated: overhead,
    noticeOverheadTokensEstimated: 0,
  });

  return {
    name,
    file: basename(filePath),
    blockedReads: 1,
    grossAvoidedTokensEstimated: accounting.grossAvoidedReadTokensEstimated,
    overheadTokensEstimated: accounting.totalOverheadTokensEstimated,
    netAvoidedTokensEstimated: accounting.netAvoidedTokensEstimated,
    classification: accounting.classification,
  };
}

const largeModule = join(FIXTURES, 'large-module.js');
const config = join(FIXTURES, 'config.json');
const fixtureReadme = join(FIXTURES, 'README.md');
const lockfile = join(FIXTURES, 'package-lock.json');

const scenarios = [
  repeatedReadScenario('One redundant large-module read', largeModule, 1),
  repeatedReadScenario('Four redundant large-module reads', largeModule, 4),
  repeatedReadScenario('Two redundant config reads', config, 2),
  repeatedReadScenario('Two redundant documentation reads', fixtureReadme, 2),
  ignoredReadScenario('One policy-blocked lockfile read', lockfile),
];

const totalGross = scenarios.reduce((sum, s) => sum + s.grossAvoidedTokensEstimated, 0);
const totalOverhead = scenarios.reduce((sum, s) => sum + s.overheadTokensEstimated, 0);
const totalNet = scenarios.reduce((sum, s) => sum + s.netAvoidedTokensEstimated, 0);

// Assert the accounting identity inside the benchmark itself. If a future edit
// introduces a hidden bucket, fail loudly instead of printing a pretty lie.
if (totalNet !== totalGross - totalOverhead) {
  throw new Error(
    `accounting identity violated: net=${totalNet}, gross=${totalGross}, overhead=${totalOverhead}`,
  );
}

console.log('');
console.log('KCO Synthetic Counterfactual Benchmark');
console.log('='.repeat(76));
console.log('Scenario'.padEnd(42) + 'Gross EST'.padStart(11) + 'Overhead EST'.padStart(14) + 'Net EST'.padStart(9));
console.log('-'.repeat(76));
for (const scenario of scenarios) {
  console.log(
    scenario.name.padEnd(42) +
    formatTokens(scenario.grossAvoidedTokensEstimated).padStart(11) +
    formatTokens(scenario.overheadTokensEstimated).padStart(14) +
    formatTokens(scenario.netAvoidedTokensEstimated).padStart(9)
  );
}
console.log('-'.repeat(76));
console.log(
  'TOTAL'.padEnd(42) +
  formatTokens(totalGross).padStart(11) +
  formatTokens(totalOverhead).padStart(14) +
  formatTokens(totalNet).padStart(9)
);
console.log('');
console.log(`ESTIMATED counterfactual direct-input reduction: ~${formatTokens(totalNet)} tokens`);
console.log('This is a synthetic fixture benchmark, not measured live Kimi subscription quota savings.');
console.log('No replay multiplier is applied, and prompt-cache reads are not counted as savings.');
console.log('');

const output = {
  classification: 'ESTIMATED',
  metric: 'counterfactual_direct_input_tokens',
  generatedAt: new Date().toISOString(),
  totalGrossAvoidedTokensEstimated: totalGross,
  totalOverheadTokensEstimated: totalOverhead,
  totalNetAvoidedTokensEstimated: totalNet,
  scenarios,
  limitations: [
    'Synthetic deterministic repository fixtures, not a live Kimi A/B experiment.',
    'Blocked-read token volume is counterfactual and estimated from actual fixture text.',
    'Model-visible KCO feedback overhead is subtracted from gross avoided input.',
    'No replay or prompt-cache multiplier is applied to claimed savings.',
    'No conversion from raw tokens to Kimi subscription credits is attempted.',
  ],
};

writeFileSync(RESULTS, JSON.stringify(output, null, 2) + '\n');
