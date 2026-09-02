/**
 * Quota-hardening contract tests.
 *
 * These fixtures model the current Kimi Code data contract documented on
 * 2026-09-02: $KIMI_CODE_HOME/session_index.jsonl plus
 * sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl containing
 * usage.record rows with camelCase usage fields.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const kimiHome = mkdtempSync(join(tmpdir(), 'kco-quota-kimi-'));
const kcoHome = mkdtempSync(join(tmpdir(), 'kco-quota-state-'));
process.env.KIMI_CODE_HOME = kimiHome;
process.env.KCO_HOME = kcoHome;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
let wireUsage;

before(async () => {
  wireUsage = await import('../src/wire-usage.js');
});

beforeEach(() => {
  wireUsage?.clearWireCache();
});

function wirePath(workDirKey, sessionId) {
  return join(kimiHome, 'sessions', workDirKey, sessionId, 'agents', 'main', 'wire.jsonl');
}

function createSession({ workDirKey, sessionId, workDir, records, updatedAt = Date.now() }) {
  const path = wirePath(workDirKey, sessionId);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = new Date(updatedAt);
  utimesSync(path, t, t);
  return { path, index: { sessionId, sessionDir: `sessions/${workDirKey}/${sessionId}`, workDir } };
}

function writeIndex(entries) {
  writeFileSync(join(kimiHome, 'session_index.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function usageRecord({ model = 'kimi-code/k3-256k', inputOther, cacheRead, cacheCreation = 0, output, time }) {
  return {
    type: 'usage.record',
    model,
    usageScope: 'turn',
    time,
    usage: {
      inputOther,
      inputCacheRead: cacheRead,
      inputCacheCreation: cacheCreation,
      output,
    },
  };
}

test('parseWireText accepts current Kimi Code usage.record rows', () => {
  const text = [
    usageRecord({ inputOther: 1200, cacheRead: 8000, cacheCreation: 100, output: 300, time: 1788390000000 }),
    usageRecord({ inputOther: 900, cacheRead: 12000, cacheCreation: 0, output: 250, time: 1788390060000 }),
  ].map(JSON.stringify).join('\n') + '\n';

  const u = wireUsage.parseWireText(text);
  assert.equal(u.steps, 2);
  assert.equal(u.contextTokens, 12_900);
  assert.equal(u.totalInput, 2_100);
  assert.equal(u.totalCacheRead, 20_000);
  assert.equal(u.totalCacheCreation, 100);
  assert.equal(u.totalOutput, 550);
  assert.equal(u.totalInputSide, 22_200);
  assert.equal(u.recognizedUsageRows, 2);
  assert.deepEqual(u.wireSchemas, ['usage.record']);
  assert.equal(u.model, 'kimi-code/k3-256k');
  assert.equal(u.lastStepAt, new Date(1788390060000).toISOString());
});

test('findWireFile resolves exact session through session_index.jsonl', () => {
  const target = createSession({
    workDirKey: 'wd_proj_target', sessionId: 'session_target', workDir: '/work/proj',
    records: [usageRecord({ inputOther: 10, cacheRead: 20, output: 1, time: Date.now() - 60_000 })],
    updatedAt: Date.now() - 60_000,
  });
  const unrelated = createSession({
    workDirKey: 'wd_other_newer', sessionId: 'session_other', workDir: '/work/other',
    records: [usageRecord({ inputOther: 999, cacheRead: 999, output: 9, time: Date.now() })],
    updatedAt: Date.now(),
  });
  writeIndex([target.index, unrelated.index]);

  assert.equal(wireUsage.findWireFile('session_target', '/work/proj'), target.path);
});

test('findWireFile never falls back to a different session for a missing session id', () => {
  const unrelated = createSession({
    workDirKey: 'wd_proj_only', sessionId: 'session_real', workDir: '/work/proj',
    records: [usageRecord({ inputOther: 100, cacheRead: 200, output: 1, time: Date.now() })],
  });
  writeIndex([unrelated.index]);

  assert.equal(wireUsage.findWireFile('session_missing', '/work/proj'), null);
  const usage = wireUsage.getSessionUsage('session_missing', '/work/proj');
  assert.equal(usage.contextTokens, 0);
  assert.equal(usage.recognizedUsageRows, 0);
});

test('findWireFile without session id uses exact workDir from the index', () => {
  const target = createSession({
    workDirKey: 'wd_proj_exact', sessionId: 'session_exact', workDir: '/work/proj',
    records: [usageRecord({ inputOther: 11, cacheRead: 22, output: 1, time: Date.now() - 10_000 })],
    updatedAt: Date.now() - 10_000,
  });
  const similarButWrong = createSession({
    workDirKey: 'wd_proj_similar', sessionId: 'session_similar', workDir: '/work/proj-copy',
    records: [usageRecord({ inputOther: 33, cacheRead: 44, output: 1, time: Date.now() })],
    updatedAt: Date.now(),
  });
  writeIndex([target.index, similarButWrong.index]);

  assert.equal(wireUsage.findWireFile(null, '/work/proj'), target.path);
});

test('incremental reader tolerates a partial appended JSON line and completes it later', () => {
  const first = usageRecord({ inputOther: 100, cacheRead: 1000, output: 10, time: 1788390000000 });
  const second = usageRecord({ inputOther: 200, cacheRead: 2000, output: 20, time: 1788390060000 });
  const session = createSession({
    workDirKey: 'wd_incremental', sessionId: 'session_incremental', workDir: '/work/incremental', records: [first],
  });
  writeIndex([session.index]);

  const initial = wireUsage.getSessionUsage('session_incremental', '/work/incremental');
  assert.equal(initial.steps, 1);
  assert.equal(initial.contextTokens, 1100);

  const encoded = JSON.stringify(second) + '\n';
  const split = Math.floor(encoded.length / 2);
  appendFileSync(session.path, encoded.slice(0, split));

  const partial = wireUsage.getSessionUsage('session_incremental', '/work/incremental');
  assert.equal(partial.steps, 1, 'partial JSON must not be counted yet');
  assert.equal(partial.contextTokens, 1100);

  appendFileSync(session.path, encoded.slice(split));
  const complete = wireUsage.getSessionUsage('session_incremental', '/work/incremental');
  assert.equal(complete.steps, 2);
  assert.equal(complete.contextTokens, 2200);
  assert.equal(complete.totalInput, 300);
  assert.equal(complete.totalCacheRead, 3000);
  assert.equal(complete.totalOutput, 30);
});

// ── Quota controller ─────────────────────────────────────────────────────────

test('quota controller computes replay amplification from real input-side usage', async () => {
  let quota;
  try { quota = await import('../src/quota-controller.js'); }
  catch { assert.fail('quota-controller.js must exist'); }

  const amp = quota.computeReplayAmplification({
    totalInputSide: 100_000,
    totalInput: 10_000,
    totalCacheCreation: 10_000,
  });
  assert.equal(amp, 5);
});

test('quota controller recommends early compaction only after context, step, and replay gates', async () => {
  let quota;
  try { quota = await import('../src/quota-controller.js'); }
  catch { assert.fail('quota-controller.js must exist'); }

  assert.equal(quota.shouldRecommendQuotaCompact({
    contextTokens: 79_999, steps: 20, replayAmplification: 10,
  }).recommend, false);
  assert.equal(quota.shouldRecommendQuotaCompact({
    contextTokens: 120_000, steps: 7, replayAmplification: 10,
  }).recommend, false);
  assert.equal(quota.shouldRecommendQuotaCompact({
    contextTokens: 120_000, steps: 20, replayAmplification: 2.99,
  }).recommend, false);

  const hit = quota.shouldRecommendQuotaCompact({
    contextTokens: 120_000, steps: 20, replayAmplification: 5.2,
  });
  assert.equal(hit.recommend, true);
  assert.match(hit.reason, /replay/i);
});

// ── Read-cache quota mode ────────────────────────────────────────────────────

test('quota-mode read cache does not expire unchanged context on wall clock alone', async () => {
  const readCache = await import('../src/read-cache.js');
  assert.equal(typeof readCache.isReadCacheTimeStale, 'function');

  const twentyMinutes = 20 * 60 * 1000;
  assert.equal(readCache.isReadCacheTimeStale({
    readAtMs: 1,
    nowMs: 1 + twentyMinutes,
    quotaMode: true,
    readCacheTimeStalenessMs: 0,
  }), false);

  assert.equal(readCache.isReadCacheTimeStale({
    readAtMs: 1,
    nowMs: 1 + twentyMinutes,
    quotaMode: true,
    readCacheTimeStalenessMs: 10 * 60 * 1000,
  }), true);
});

// ── Observation-hook notice delivery ─────────────────────────────────────────

test('notice queue deduplicates normal notices and flushes them once', async () => {
  const notices = await import('../src/notices.js');
  assert.equal(typeof notices.queueNotice, 'function');
  assert.equal(typeof notices.flushPendingNotices, 'function');

  const sid = 'session_notice-queue';
  assert.equal(notices.queueNotice(sid, {
    kind: 'budget:quota', text: 'compact for quota efficiency', priority: 'normal',
  }), true);
  assert.equal(notices.queueNotice(sid, {
    kind: 'budget:quota', text: 'duplicate', priority: 'normal',
  }), false);
  assert.equal(notices.flushPendingNotices(sid), 'compact for quota efficiency');
  assert.equal(notices.flushPendingNotices(sid), '');
});

test('UserPromptSubmit notice-flush hook injects queued actionable text', async () => {
  const notices = await import('../src/notices.js');
  assert.equal(typeof notices.queueNotice, 'function');
  const sid = 'session_notice-flush';
  notices.queueNotice(sid, {
    kind: 'budget:quota-flush', text: '[context-budget] compact soon', priority: 'normal',
  });

  const result = spawnSync(process.execPath, [join(repoRoot, 'src', 'notice-flush.js')], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: '/work/proj', prompt: 'continue' }),
    env: { ...process.env, KCO_HOME: kcoHome, KIMI_CODE_HOME: kimiHome },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /compact soon/);

  const manifest = JSON.parse(readFileSync(join(repoRoot, 'kimi.plugin.json'), 'utf8'));
  assert.ok(manifest.hooks.some((h) => h.event === 'UserPromptSubmit' && /notice-flush\.js/.test(h.command)));
});

// ── Doctor live-contract classifier ──────────────────────────────────────────

test('doctor distinguishes supported usage transcripts from schema drift', async () => {
  const doctor = await import('../src/doctor.js');
  assert.equal(typeof doctor.classifyWireContracts, 'function');

  const supported = join(kimiHome, 'doctor-supported.jsonl');
  writeFileSync(supported, JSON.stringify(usageRecord({
    inputOther: 100, cacheRead: 200, output: 10, time: Date.now(),
  })) + '\n');
  const unsupported = join(kimiHome, 'doctor-unsupported.jsonl');
  writeFileSync(unsupported, JSON.stringify({ type: 'future.usage.shape', counters: { input: 42 } }) + '\n');

  const ok = doctor.classifyWireContracts([supported]);
  assert.equal(ok.status, 'supported');
  assert.equal(ok.recognizedUsageRows, 1);
  assert.deepEqual(ok.wireSchemas, ['usage.record']);

  const drift = doctor.classifyWireContracts([unsupported]);
  assert.equal(drift.status, 'unsupported');
  assert.equal(drift.recognizedUsageRows, 0);
});
