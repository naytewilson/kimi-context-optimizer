/**
 * Public-claim guardrails.
 *
 * Runtime accounting can be conservative while docs/benchmarks still overclaim.
 * These tests make the evidence labels part of the shipped contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function assertEvidenceHonestPublicCopy(text, surface) {
  assert.match(text, /estimated net direct-input reduction/i, `${surface}: missing evidence label`);
  assert.match(text, /cache-read[^\n<]*usage telemetry/i, `${surface}: cache telemetry must be named as telemetry`);
  assert.match(text, /not[^\n<]*subscription quota/i, `${surface}: must reject direct quota conversion`);
  assert.doesNotMatch(text, /Token Savings Proof/i, `${surface}: old proof claim remains`);
  assert.doesNotMatch(text, /63% token savings/i, `${surface}: old fixed percentage remains`);
  assert.doesNotMatch(text, /63% fewer tokens/i, `${surface}: old title percentage remains`);
  assert.doesNotMatch(text, /KCO saved 60,055 tokens/i, `${surface}: old demo claim remains`);
  assert.doesNotMatch(text, /honest savings number measured against the wire transcript/i, `${surface}: counterfactual mislabeled as observed`);
  assert.doesNotMatch(text, /savings compound/i, `${surface}: compounding claim remains`);
}

test('README distinguishes observed usage from estimated counterfactual savings', () => {
  const text = readFileSync(join(root, 'README.md'), 'utf8');
  assertEvidenceHonestPublicCopy(text, 'README');
});

test('GitHub Pages landing copy uses the same evidence contract', () => {
  const text = readFileSync(join(root, 'docs', 'index.html'), 'utf8');
  assertEvidenceHonestPublicCopy(text, 'docs/index.html');
  assert.match(text, /Synthetic Counterfactual Benchmark/i);
  assert.doesNotMatch(text, />63%</);
});

test('benchmark is explicitly synthetic and uses runtime savings accounting identity', () => {
  const source = readFileSync(join(root, 'benchmark', 'run.js'), 'utf8');
  assert.match(source, /Synthetic Counterfactual Benchmark/);
  assert.match(source, /computeSavingsEstimate/);
  assert.doesNotMatch(source, /Token Savings Proof/);
  assert.doesNotMatch(source, /cheap cached-read bucket/i);

  const home = mkdtempSync(join(tmpdir(), 'kco-benchmark-claims-'));
  const result = spawnSync(process.execPath, [join(root, 'benchmark', 'run.js')], {
    cwd: root,
    env: { ...process.env, KCO_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ESTIMATED counterfactual direct-input reduction/);
  assert.match(result.stdout, /not measured live Kimi subscription quota savings/i);

  const data = JSON.parse(readFileSync(join(root, 'benchmark', 'results.json'), 'utf8'));
  assert.equal(data.classification, 'ESTIMATED');
  assert.equal(data.metric, 'counterfactual_direct_input_tokens');
  assert.ok(data.totalGrossAvoidedTokensEstimated >= 0);
  assert.ok(data.totalOverheadTokensEstimated >= 0);
  assert.equal(
    data.totalNetAvoidedTokensEstimated,
    data.totalGrossAvoidedTokensEstimated - data.totalOverheadTokensEstimated,
  );
});
