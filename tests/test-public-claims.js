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

test('README distinguishes observed usage from estimated counterfactual savings', () => {
  const text = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(text, /estimated net direct-input reduction/i);
  assert.match(text, /cache-read.*usage telemetry/i);
  assert.match(text, /not.*subscription quota/i);
  assert.doesNotMatch(text, /Token Savings Proof/i);
  assert.doesNotMatch(text, /63% token savings/i);
  assert.doesNotMatch(text, /honest savings number measured against the wire transcript/i);
  assert.doesNotMatch(text, /savings compound/i);
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
