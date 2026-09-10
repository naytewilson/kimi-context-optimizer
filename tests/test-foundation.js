/**
 * Foundation tests for kimi-context-optimizer (KCO).
 *
 * Uses temp dirs: KCO_HOME (KCO state) and KIMI_CODE_HOME (fake Kimi CLI home
 * with sessions/ and config.toml) are pointed at os.tmpdir() before importing
 * the modules under test. utils.js resolves DATA_DIR at import time, so it is
 * imported dynamically AFTER the env is set.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Temp homes (must be set before importing src modules) ────────────────────

const kcoHome = mkdtempSync(join(tmpdir(), 'kco-test-'));
const kimiHome = mkdtempSync(join(tmpdir(), 'kco-kimi-'));
process.env.KCO_HOME = kcoHome;
process.env.KIMI_CODE_HOME = kimiHome;
delete process.env.KCO_CONTEXT_WINDOW;

let utils, hookIo, wireUsage, kimiConfig;

before(async () => {
  utils = await import('../src/utils.js');
  hookIo = await import('../src/hook-io.js');
  wireUsage = await import('../src/wire-usage.js');
  kimiConfig = await import('../src/kimi-config.js');
});

// ── hook-io: getPromptText ───────────────────────────────────────────────────

test('getPromptText: array of content parts → first text', () => {
  assert.equal(hookIo.getPromptText({ prompt: [{ type: 'text', text: 'hello world' }] }), 'hello world');
});

test('getPromptText: multiple text parts join with newline', () => {
  const payload = { prompt: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] };
  assert.equal(hookIo.getPromptText(payload), 'one\ntwo');
});

test('getPromptText: plain string prompt', () => {
  assert.equal(hookIo.getPromptText({ prompt: 'just a string' }), 'just a string');
});

test('getPromptText: missing / empty prompt → empty string', () => {
  assert.equal(hookIo.getPromptText({}), '');
  assert.equal(hookIo.getPromptText({ prompt: [] }), '');
  assert.equal(hookIo.getPromptText({ prompt: [{ type: 'image' }] }), '');
  assert.equal(hookIo.getPromptText(null), '');
});

test('isMainModule: true only for the entry point', () => {
  // node --test runs each test file as its own process with argv[1] = the
  // test file, so THIS module is the entry point here...
  assert.equal(hookIo.isMainModule(import.meta.url), true);
  // ...and any imported src module is not.
  assert.equal(utils.isMainModule(new URL('../src/utils.js', import.meta.url).href), false);
  assert.equal(hookIo.isMainModule(new URL('../src/hook-io.js', import.meta.url).href), false);
});

// ── wire-usage: getSessionUsage against a synthetic wire.jsonl ───────────────

const SESSION_ID = 'session_test-0001';

function buildWireFixture() {
  const wireDir = join(kimiHome, 'sessions', 'wd_myproj_ab12cd34', SESSION_ID, 'agents', 'main');
  mkdirSync(wireDir, { recursive: true });
  const records = [
    { type: 'config.update', systemPrompt: 'SYS' }, // 3 chars
    { type: 'model', model: 'k3', usageScope: 'session' },
    {
      type: 'step.end',
      timestamp: '2026-07-18T01:00:00.000Z',
      usage: { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 500 },
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'tool.result', toolCallId: 'tc1', result: { output: 'hello world' } }, // 11 chars
    },
    {
      type: 'step.end',
      timestamp: '2026-07-18T01:01:00.000Z',
      usage: { inputOther: 200, output: 20, inputCacheRead: 600, inputCacheCreation: 100 },
    },
    'this is not json — must be skipped',
    { type: 'unknown.record.type', whatever: true },
  ];
  const text = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
  writeFileSync(join(wireDir, 'wire.jsonl'), text);
  return join(wireDir, 'wire.jsonl');
}

test('wire-usage: getSessionUsage reads last step.end for contextTokens', () => {
  buildWireFixture();
  wireUsage.clearWireCache();
  const u = wireUsage.getSessionUsage(SESSION_ID, '/tmp/myproj');
  // Last step.end: 200 + 600 + 100
  assert.equal(u.contextTokens, 900);
  assert.equal(u.steps, 2);
  assert.equal(u.totalInput, 300);
  assert.equal(u.totalOutput, 30);
  assert.equal(u.totalCacheRead, 600);
  assert.equal(u.totalCacheCreation, 600);
  // 600 / (300 + 600 + 600) = 0.4
  assert.ok(Math.abs(u.cacheHitRate - 0.4) < 1e-9, `cacheHitRate was ${u.cacheHitRate}`);
  assert.equal(u.model, 'k3');
  assert.equal(u.systemPromptChars, 3);
  assert.equal(u.lastStepAt, '2026-07-18T01:01:00.000Z');
});

test('wire-usage: findWireFile refuses an unrelated fallback for an unknown session', () => {
  // Exact hook session ids are authority. An unrelated recent transcript must
  // never be borrowed merely because its working-directory slug looks close.
  buildWireFixture();
  const found = wireUsage.findWireFile('session_does-not-exist', '/tmp/myproj');
  assert.equal(found, null);
});

test('wire-usage: getRecentToolOutputs returns last N outputs', () => {
  wireUsage.clearWireCache();
  const outs = wireUsage.getRecentToolOutputs(SESSION_ID, '/tmp/myproj', 10);
  assert.equal(outs.length, 1);
  assert.equal(outs[0].toolCallId, 'tc1');
  assert.equal(outs[0].outputLength, 11);
});

test('wire-usage: missing file → all defaults, never throws', () => {
  const emptyHome = mkdtempSync(join(tmpdir(), 'kco-kimi-empty-'));
  mkdirSync(join(emptyHome, 'sessions'), { recursive: true });
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = emptyHome;
  try {
    assert.equal(wireUsage.findWireFile('session_nope', '/tmp/nowhere'), null);
    const u = wireUsage.getSessionUsage('session_nope', '/tmp/nowhere');
    assert.deepEqual(u, {
      contextTokens: 0, totalInput: 0, totalOutput: 0,
      totalCacheRead: 0, totalCacheCreation: 0, totalInputSide: 0, cacheHitRate: 0,
      steps: 0, recognizedUsageRows: 0, wireSchemas: [],
      model: null, systemPromptChars: 0, lastStepAt: null,
    });
    assert.deepEqual(wireUsage.getRecentToolOutputs('session_nope', '/tmp/nowhere', 5), []);
  } finally {
    process.env.KIMI_CODE_HOME = prev;
  }
});

// ── kimi-config: config.toml parsing ─────────────────────────────────────────

function writeKimiConfig(home, text) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), text);
}

test('kimi-config: parses default_model + quoted section with dots/slash', () => {
  writeKimiConfig(kimiHome, [
    'default_model = "kimi-code/k3"',
    '',
    '[models."kimi-code/k3"]',
    'model = "k3"',
    'max_context_size = 1048576',
    'display_name = "K3"',
    '',
    '[other]',
    'unrelated = "value"',
    '',
  ].join('\n'));
  const m = kimiConfig.getActiveModel();
  assert.equal(m.alias, 'kimi-code/k3');
  assert.equal(m.model, 'k3');
  assert.equal(m.displayName, 'K3');
  assert.equal(m.maxContextSize, 1048576);
});

test('kimi-config: missing default_model → defaults', () => {
  const home = mkdtempSync(join(tmpdir(), 'kco-kimi-nodefault-'));
  writeKimiConfig(home, '[models."kimi-code/k3"]\nmodel = "k3"\n');
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    const m = kimiConfig.getActiveModel();
    assert.equal(m.alias, null);
    assert.equal(m.model, null);
    assert.equal(m.displayName, null);
    assert.equal(m.maxContextSize, 262144);
  } finally {
    process.env.KIMI_CODE_HOME = prev;
  }
});

test('kimi-config: missing config.toml → defaults, never throws', () => {
  const home = mkdtempSync(join(tmpdir(), 'kco-kimi-nofile-'));
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
  try {
    const m = kimiConfig.getActiveModel();
    assert.equal(m.alias, null);
    assert.equal(m.maxContextSize, 262144);
  } finally {
    process.env.KIMI_CODE_HOME = prev;
  }
});

test('kimi-config: KCO_CONTEXT_WINDOW overrides everything', () => {
  writeKimiConfig(kimiHome, 'default_model = "kimi-code/k3"\n[models."kimi-code/k3"]\nmax_context_size = 1048576\n');
  process.env.KCO_CONTEXT_WINDOW = '131072';
  try {
    assert.equal(kimiConfig.getActiveModel().maxContextSize, 131072);
  } finally {
    delete process.env.KCO_CONTEXT_WINDOW;
  }
});

// ── utils: token estimation + pricing ────────────────────────────────────────

test('utils: token estimation sanity', () => {
  // 100 lines × 35 chars/line ÷ 3.8 chars/token ≈ 921
  assert.equal(utils.estimateTokens(100, '.js'), 921);
  // Unknown extension falls back to 3.7
  assert.equal(utils.estimateTokens(100, '.wat'), Math.round(3500 / 3.7));
  assert.equal(utils.estimateTokensFromString('x'.repeat(370), '.js'), Math.round(370 / 3.8));
  assert.equal(utils.estimateTokensFromString(''), 0);
  assert.ok(utils.TOKEN_RATIOS['.ts'] > 0);
});

test('utils: pricing is null by default (cost features hidden)', () => {
  const p = utils.getPricing();
  assert.equal(p.input, null);
  assert.equal(p.output, null);
  assert.equal(utils.computeCost(1_000_000, 'input'), null);
  assert.equal(utils.computeCost(1_000_000, 'output'), null);
  assert.equal(utils.formatCost(null), null);
});

test('utils: configured pricing enables computeCost/formatCost', () => {
  writeFileSync(join(kcoHome, 'config.json'), JSON.stringify({
    pricePerMillionInput: 5,
    pricePerMillionOutput: 25,
  }));
  try {
    assert.deepEqual(utils.getPricing(), { input: 5, output: 25 });
    assert.equal(utils.computeCost(1_000_000, 'input'), 5);
    assert.equal(utils.computeCost(2_000_000, 'output'), 50);
    assert.equal(utils.formatCost(1.234), '$1.23');
    assert.equal(utils.formatCost(0.005), '$0.0050');
  } finally {
    writeFileSync(join(kcoHome, 'config.json'), '{}');
  }
});

test('utils: calibration EMA clamps to 0.5–2 with alpha 0.3', () => {
  assert.equal(utils.emaCalibration(1, 1), 1);
  assert.equal(utils.emaCalibration(1, 10), 1.3);   // ratio clamps to 2 → 1*0.7 + 2*0.3
  assert.equal(utils.emaCalibration(1, 0), 0.85);   // ratio clamps to 0.5 → 1*0.7 + 0.5*0.3
});
