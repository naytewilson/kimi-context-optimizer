/**
 * Core hook tests for kimi-context-optimizer (KCO): tracker, budget, read-cache.
 *
 * Two layers:
 *   1. Pure-function unit tests (imported modules — KCO_HOME / KIMI_CODE_HOME
 *      are pointed at temp dirs BEFORE the dynamic imports, since utils.js
 *      resolves DATA_DIR at import time).
 *   2. PROTOCOL tests: each hook main is spawned as a child process
 *      (`node src/xxx.js`) with the payload on stdin, asserting exit codes
 *      (0 = allow/advise, 2 = block) and stderr/stdout content. This directly
 *      tests the Kimi hook contract: block = stderr reason + exit 2,
 *      advisory = stdout + exit 0.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ── Temp homes (must be set before importing src modules) ────────────────────

const kcoHome = mkdtempSync(join(tmpdir(), 'kco-hooks-test-'));
const kimiHome = mkdtempSync(join(tmpdir(), 'kco-hooks-kimi-'));
process.env.KCO_HOME = kcoHome;
process.env.KIMI_CODE_HOME = kimiHome;
delete process.env.KCO_CONTEXT_WINDOW;

const workDir = mkdtempSync(join(tmpdir(), 'kco-hooks-work-'));
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

let tracker, readCache, budget;

before(async () => {
  tracker = await import('../src/tracker.js');
  readCache = await import('../src/read-cache.js');
  budget = await import('../src/budget.js');
});

// ── Child-process hook runner ────────────────────────────────────────────────

function runHook(script, payload, env = {}) {
  const res = spawnSync(process.execPath, [join(srcDir, script)], {
    input: JSON.stringify(payload),
    env: { ...process.env, KCO_HOME: kcoHome, KIMI_CODE_HOME: kimiHome, ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  return res; // { status, stdout, stderr }
}

function sessionState(sid) {
  const f = join(kcoHome, 'sessions', `${sid}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null;
}

function budgetState(sid) {
  const f = join(kcoHome, 'budget', `${sid}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null;
}

function readCacheState(sid) {
  const f = join(kcoHome, 'read-cache', `${sid}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null;
}

// A small source file with structural landmarks (for digest assertions).
const smallFile = join(workDir, 'small.js');
writeFileSync(smallFile, [
  'import { x } from "./dep.js";',
  '',
  'export function alpha(a) {',
  '  return a * 2;',
  '}',
  '',
  'export function beta(b) {',
  '  return b + 1;',
  '}',
  '',
  'export const gamma = 42;',
  '',
].join('\n'));

// ── Pure units: tracker.trackFailure ─────────────────────────────────────────

test('trackFailure: counts per tool, advisory exactly once at 3rd failure', () => {
  const session = {};
  const err = { code: 'invalid_params', message: 'missing field: path', retryable: false };
  assert.equal(tracker.trackFailure(session, 'Read', err), null);
  assert.equal(tracker.trackFailure(session, 'Read', err), null);
  const advisory = tracker.trackFailure(session, 'Read', err);
  assert.ok(advisory && advisory.includes('Read failed 3x'), `got: ${advisory}`);
  assert.ok(advisory.includes('path'), 'advisory should mention correct usage');
  // 4th failure: counted, but no repeat advisory
  assert.equal(tracker.trackFailure(session, 'Read', err), null);
  assert.equal(session.failures.Read, 4);
  assert.equal(session.failedCalls, 4);
  // Unknown tool gets a generic hint
  const other = tracker.trackFailure(session, 'mcp__x', null);
  assert.equal(other, null); // only 1 failure so far
});

test('updateExploreStreak: fires once at 12 read-only calls + 20K tokens', () => {
  const session = {};
  for (let i = 0; i < 11; i++) {
    assert.equal(tracker.updateExploreStreak(session, 'Read', 2000), false);
  }
  // 12th call, 24K tokens accumulated → fire
  assert.equal(tracker.updateExploreStreak(session, 'Read', 2000), true);
  // Once per session
  assert.equal(tracker.updateExploreStreak(session, 'Read', 2000), false);
  // Edit resets the streak
  const s2 = {};
  for (let i = 0; i < 11; i++) tracker.updateExploreStreak(s2, 'Grep', 2000);
  tracker.updateExploreStreak(s2, 'Edit', 0);
  assert.equal(s2.explore.streak, 0);
});

// ── Pure units: read-cache big-file nudge + budget estimation ────────────────

test('shouldNudgeBigFile: only first, untargeted, huge reads', () => {
  const base = { entry: null, hasOffset: false, hasLimit: false, lines: 2000, threshold: 1500, enabled: true };
  assert.equal(readCache.shouldNudgeBigFile(base), true);
  assert.equal(readCache.shouldNudgeBigFile({ ...base, entry: {} }), false);
  assert.equal(readCache.shouldNudgeBigFile({ ...base, hasOffset: true }), false);
  assert.equal(readCache.shouldNudgeBigFile({ ...base, hasLimit: true }), false);
  assert.equal(readCache.shouldNudgeBigFile({ ...base, lines: 100 }), false);
  assert.equal(readCache.shouldNudgeBigFile({ ...base, enabled: false }), false);
});

test('estimateToolTokens: Read uses Kimi `path` field and caps by file size', () => {
  const est = budget.estimateToolTokens('Read', { path: smallFile });
  // 11-line file: capped far below the 2000-line default
  assert.ok(est.input > 0 && est.input < 500, `got ${est.input}`);
  assert.equal(est.output, 0);
  const w = budget.estimateToolTokens('Write', { path: '/tmp/x', content: 'x'.repeat(370) });
  assert.equal(w.output, 100);
});

// ── Protocol: tracker PostToolUse ────────────────────────────────────────────

test('tracker PostToolUse: tracks reads/edits/searches, exits 0', () => {
  const sid = 'session_track-basic';
  const read = runHook('tracker.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'Read', tool_input: { path: smallFile }, tool_output: 'file contents',
  });
  assert.equal(read.status, 0, `stderr: ${read.stderr}`);

  runHook('tracker.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'Edit', tool_input: { path: smallFile, old_string: 'a', new_string: 'b' },
    tool_output: 'ok',
  });
  runHook('tracker.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'Grep', tool_input: { pattern: 'alpha', path: workDir }, tool_output: 'small.js:3',
  });

  const s = sessionState(sid);
  assert.ok(s, 'session file written');
  assert.equal(s.totalReads, 1);
  assert.equal(s.totalEdits, 1);
  assert.equal(s.totalSearches, 1);
  assert.equal(s.totalToolCalls, 3);
  assert.ok(s.files[smallFile], 'file tracked by Kimi `path` field');
  assert.equal(s.files[smallFile].reads, 1);
  assert.equal(s.files[smallFile].edits, 1);
  assert.equal(s.files[smallFile].wasEdited, true);
  assert.equal(s.searches[0].pattern, 'alpha');
  assert.equal(s.tools.Read.calls, 1);
});

test('tracker PostToolUseFailure: counts failures, one advisory at 3rd, exit 0', () => {
  const sid = 'session_track-fail';
  const payload = {
    hook_event_name: 'PostToolUseFailure', session_id: sid, cwd: workDir,
    tool_name: 'Read', tool_input: { path: '/nope' },
    error: { code: 'invalid_params', message: 'missing field: path', retryable: false },
  };
  const r1 = runHook('tracker.js', payload);
  const r2 = runHook('tracker.js', payload);
  const r3 = runHook('tracker.js', payload);
  const r4 = runHook('tracker.js', payload);
  for (const r of [r1, r2, r3, r4]) assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(r1.stdout, '', 'no advisory before threshold');
  assert.equal(r2.stdout, '', 'no advisory before threshold');
  assert.ok(r3.stdout.includes('[kco] Read failed 3x'), `stdout: ${r3.stdout}`);
  assert.equal(r4.stdout, '', 'advisory fires once per session');

  const s = sessionState(sid);
  assert.equal(s.failures.Read, 4);
  assert.equal(s.failedCalls, 4);
});

test('tracker SubagentStop: counts delegations and records subagent names', () => {
  const sid = 'session_track-deleg';
  runHook('tracker.js', { hook_event_name: 'SubagentStart', session_id: sid, cwd: workDir, subagent_type: 'explore' });
  runHook('tracker.js', { hook_event_name: 'SubagentStop', session_id: sid, cwd: workDir, subagent_type: 'explore' });
  const s = sessionState(sid);
  assert.equal(s.delegations, 1);
  assert.deepEqual(s.subagents, ['explore']);
});

test('tracker SessionEnd: finalizes into patterns/global-stats and summary', () => {
  const sid = 'session_track-end';
  runHook('tracker.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'Read', tool_input: { path: smallFile }, tool_output: 'x',
  });
  const end = runHook('tracker.js', { hook_event_name: 'SessionEnd', session_id: sid, cwd: workDir, reason: 'exit' });
  assert.equal(end.status, 0, `stderr: ${end.stderr}`);
  assert.ok(existsSync(join(kcoHome, 'patterns.json')), 'patterns.json written');
  assert.ok(existsSync(join(kcoHome, 'global-stats.json')), 'global-stats.json written');
  assert.ok(existsSync(join(kcoHome, 'summaries', `${sid}.txt`)), 'session summary written');
  const stats = JSON.parse(readFileSync(join(kcoHome, 'global-stats.json'), 'utf-8'));
  assert.ok(stats.totalSessions >= 1);
});

// ── Protocol: budget ─────────────────────────────────────────────────────────

function seedBudget(sid, state) {
  mkdirSync(join(kcoHome, 'budget'), { recursive: true });
  writeFileSync(join(kcoHome, 'budget', `${sid}.json`), JSON.stringify({
    sessionId: sid,
    totalTokensEstimated: 0,
    inputTokensEstimated: 0,
    outputTokensEstimated: 0,
    warningsSent: [],
    filesLoaded: {},
    compactSuggested: false,
    lastCompactSuggestAt: 0,
    autoCompactSentAt: 0,
    criticalSentAt: 0,
    startedAt: new Date().toISOString(),
    ...state,
  }));
}

test('budget: estimation fallback crosses 50% → warns once, exit 0', () => {
  const sid = 'session_budget-est';
  // Effective budget = min(200000 default, 262144 window) = 200000 → 50% = 100K
  seedBudget(sid, { totalTokensEstimated: 99_000, inputTokensEstimated: 99_000 });

  const payload = {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'Read', tool_input: { path: smallFile },
    tool_output: 'x'.repeat(4000), // ~1081 tokens → pushes past 100K
  };
  const first = runHook('budget.js', payload);
  assert.equal(first.status, 0, `stderr: ${first.stderr}`);
  assert.ok(first.stdout.includes('50% of context window used'), `stdout: ${first.stdout}`);
  assert.ok(first.stdout.includes('~'), 'estimation fallback marks numbers as approximate');

  const st = budgetState(sid);
  assert.ok(st.warningsSent.includes(50));
  assert.ok(st.totalTokensEstimated > 100_000);

  // Warning-once: second call over the same threshold stays silent
  const second = runHook('budget.js', payload);
  assert.equal(second.status, 0);
  assert.ok(!second.stdout.includes('context window used'), `stdout: ${second.stdout}`);
});

test('budget: wire ground truth overrides estimation (real % + model)', () => {
  const sid = 'session_budget-wire';
  // Fake wire.jsonl: last step.end input sum = 190K → 95% of the 200K budget
  const wireDir = join(kimiHome, 'sessions', 'wd_work_ab12cd34', sid, 'agents', 'main');
  mkdirSync(wireDir, { recursive: true });
  writeFileSync(join(wireDir, 'wire.jsonl'), [
    JSON.stringify({ type: 'model', model: 'k3' }),
    JSON.stringify({
      type: 'step.end', timestamp: '2026-07-18T01:00:00.000Z',
      usage: { inputOther: 190_000, output: 500, inputCacheRead: 0, inputCacheCreation: 0 },
    }),
  ].join('\n') + '\n');

  seedBudget(sid, {});
  const res = runHook('budget.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_output: 'small result',
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  // Real context = 190K/200K = 95% — all thresholds fire at once; 85/95 are
  // critical (bypass the notice cap) so the 95% line must appear.
  assert.ok(res.stdout.includes('95% of context window used'), `stdout: ${res.stdout}`);
  assert.ok(res.stdout.includes('190.0K'), 'leads with real token count');
  assert.ok(!res.stdout.includes('$'), 'no $ figures when pricing is unconfigured');

  const st = budgetState(sid);
  assert.equal(st.realContextTokens, 190_000);
  assert.equal(st.model, 'k3');
  assert.deepEqual(st.warningsSent.sort((a, b) => a - b), [50, 70, 85, 95]);
});

test('budget: big tool_output (≥10K tokens) triggers one-line fix advisory', () => {
  const sid = 'session_budget-big';
  seedBudget(sid, {});
  const res = runHook('budget.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'Bash', tool_input: { command: 'cat huge.log' },
    tool_output: 'y'.repeat(40_000), // ~10.8K tokens
  });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('pipe through tail/head/grep'), `stdout: ${res.stdout}`);
});

// ── Protocol: read-cache block/allow matrix ──────────────────────────────────

const preRead = (sid, path, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: sid, cwd: workDir,
  tool_name: 'Read', tool_input: { path, ...extra },
});

test('read-cache: first read allowed (exit 0), second identical read blocked with file map (exit 2)', () => {
  const sid = 'session_rc-block';
  const first = runHook('read-cache.js', preRead(sid, smallFile));
  assert.equal(first.status, 0, `stderr: ${first.stderr}`);

  const second = runHook('read-cache.js', preRead(sid, smallFile));
  assert.equal(second.status, 2, 'redundant read must exit 2 (block)');
  assert.ok(second.stderr.includes('Already loaded'), `stderr: ${second.stderr}`);
  assert.ok(second.stderr.includes('File map'), 'block reason carries the structural map');
  assert.ok(second.stderr.includes('function alpha()'), 'map names real landmarks');

  const cache = readCacheState(sid);
  assert.equal(cache.blockedReads, 1);
  assert.ok(cache.totalTokensSaved > 0);
});

test('read-cache: read after Edit is allowed again (cache invalidated)', () => {
  const sid = 'session_rc-edit';
  assert.equal(runHook('read-cache.js', preRead(sid, smallFile)).status, 0);
  // Simulate the edit the model would have made after a blocked/allowed read
  const edit = runHook('read-cache.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'Edit', tool_input: { path: smallFile, old_string: 'a', new_string: 'b' },
    tool_output: 'ok',
  });
  assert.equal(edit.status, 0);
  assert.equal(readCacheState(sid).files[smallFile], undefined, 'entry invalidated');
  // Re-read passes
  assert.equal(runHook('read-cache.js', preRead(sid, smallFile)).status, 0);
});

test('read-cache: uncovered partial range allowed, covered range blocked', () => {
  const sid = 'session_rc-range';
  // Full first read covers lines [0, 2000)
  assert.equal(runHook('read-cache.js', preRead(sid, smallFile)).status, 0);
  // Uncovered range → allowed
  const uncovered = runHook('read-cache.js', preRead(sid, smallFile, { offset: 3000, limit: 50 }));
  assert.equal(uncovered.status, 0, `stderr: ${uncovered.stderr}`);
  // Now [3000,3050) is cached too — repeating it blocks
  const covered = runHook('read-cache.js', preRead(sid, smallFile, { offset: 3000, limit: 50 }));
  assert.equal(covered.status, 2);
  assert.ok(covered.stderr.includes('section is already loaded'), `stderr: ${covered.stderr}`);
});

test('read-cache: big-file first read blocks once with the map, second read allowed', () => {
  const sid = 'session_rc-bigfile';
  const bigFile = join(workDir, 'big.js');
  const lines = [];
  for (let i = 0; i < 1600; i++) lines.push(`export function fn${i}() { return ${i}; }`);
  writeFileSync(bigFile, lines.join('\n'));

  const first = runHook('read-cache.js', preRead(sid, bigFile));
  assert.equal(first.status, 2, 'first full read of a huge file gets the map instead');
  assert.ok(first.stderr.includes('File map'), `stderr: ${first.stderr}`);
  assert.ok(first.stderr.includes('1600 lines'));

  const second = runHook('read-cache.js', preRead(sid, bigFile));
  assert.equal(second.status, 0, 'one-shot nudge: next read passes');
});

test('read-cache: PreCompact clears the cache', () => {
  const sid = 'session_rc-compact';
  assert.equal(runHook('read-cache.js', preRead(sid, smallFile)).status, 0);
  assert.ok(Object.keys(readCacheState(sid).files).length > 0);
  const pc = runHook('read-cache.js', { hook_event_name: 'PreCompact', session_id: sid, cwd: workDir });
  assert.equal(pc.status, 0);
  assert.deepEqual(readCacheState(sid).files, {});
  // Fresh read after compaction is allowed
  assert.equal(runHook('read-cache.js', preRead(sid, smallFile)).status, 0);
});

test('read-cache: .contextignore match blocks with exit 2', () => {
  const sid = 'session_rc-ignore';
  writeFileSync(join(workDir, '.contextignore'), 'secret.txt\n');
  const secret = join(workDir, 'secret.txt');
  writeFileSync(secret, 's3cret');
  // The hook's process.cwd() is the test runner cwd, so the project-level
  // .contextignore lives there only if cwd matches — spawn with cwd=workDir.
  const res = spawnSync(process.execPath, [join(srcDir, 'read-cache.js')], {
    input: JSON.stringify(preRead(sid, secret)),
    env: { ...process.env, KCO_HOME: kcoHome, KIMI_CODE_HOME: kimiHome },
    cwd: workDir,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  assert.equal(res.status, 2);
  assert.ok(res.stderr.includes('contextignore'), `stderr: ${res.stderr}`);
});
