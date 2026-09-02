/**
 * Current Kimi CLI hook/tool compatibility.
 *
 * Kimi's current public docs name built-ins ReadFile, WriteFile,
 * StrReplaceFile and Shell, while the July 2026 live-capture fixtures in this
 * fork used Read/Edit/Write/Bash. KCO must accept both generations or its
 * accounting can silently become zero while looking healthy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const kcoHome = mkdtempSync(join(tmpdir(), 'kco-current-hooks-state-'));
const kimiHome = mkdtempSync(join(tmpdir(), 'kco-current-hooks-kimi-'));
const workDir = mkdtempSync(join(tmpdir(), 'kco-current-hooks-work-'));
const srcDir = join(repoRoot, 'src');

process.env.KCO_HOME = kcoHome;
process.env.KIMI_CODE_HOME = kimiHome;

function runHook(script, payload) {
  return spawnSync(process.execPath, [join(srcDir, script)], {
    input: JSON.stringify(payload),
    env: { ...process.env, KCO_HOME: kcoHome, KIMI_CODE_HOME: kimiHome },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function stateFile(dir, sid) {
  return JSON.parse(readFileSync(join(kcoHome, dir, `${sid}.json`), 'utf8'));
}

test('hook compatibility normalizes current and legacy built-in tool names', async () => {
  const io = await import('../src/hook-io.js');
  assert.equal(typeof io.canonicalToolName, 'function');
  assert.equal(io.canonicalToolName('ReadFile'), 'Read');
  assert.equal(io.canonicalToolName('Read'), 'Read');
  assert.equal(io.canonicalToolName('WriteFile'), 'Write');
  assert.equal(io.canonicalToolName('Write'), 'Write');
  assert.equal(io.canonicalToolName('StrReplaceFile'), 'Edit');
  assert.equal(io.canonicalToolName('Edit'), 'Edit');
  assert.equal(io.canonicalToolName('Shell'), 'Bash');
  assert.equal(io.canonicalToolName('Bash'), 'Bash');
});

test('hook compatibility reads current file_path and ReadFile line range fields', async () => {
  const io = await import('../src/hook-io.js');
  assert.equal(typeof io.getToolPath, 'function');
  assert.equal(typeof io.getReadRange, 'function');

  assert.equal(io.getToolPath({ file_path: '/tmp/current.js' }), '/tmp/current.js');
  assert.equal(io.getToolPath({ path: '/tmp/legacy.js' }), '/tmp/legacy.js');
  assert.deepEqual(io.getReadRange({ line_offset: 2, n_lines: 3 }, 10), { offset: 1, limit: 3, end: 4 });
  assert.deepEqual(io.getReadRange({ offset: 1, limit: 3 }, 10), { offset: 1, limit: 3, end: 4 });
  assert.deepEqual(io.getReadRange({ line_offset: -2, n_lines: 2 }, 10), { offset: 8, limit: 2, end: 10 });
  assert.deepEqual(io.getReadRange({ offset: 3000, limit: 50 }, 10), { offset: 3000, limit: 50, end: 3050 });
});

test('manifest matches both current and legacy Kimi built-in tool names', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'kimi.plugin.json'), 'utf8'));
  const hooks = manifest.hooks || [];

  const preRead = hooks.find((h) => h.event === 'PreToolUse' && /read-cache\.js/.test(h.command));
  assert.ok(preRead);
  assert.match('ReadFile', new RegExp(preRead.matcher));
  assert.match('Read', new RegExp(preRead.matcher));

  const postEdit = hooks.find((h) => h.event === 'PostToolUse' && /read-cache\.js/.test(h.command));
  assert.ok(postEdit);
  for (const name of ['WriteFile', 'StrReplaceFile', 'Write', 'Edit']) {
    assert.match(name, new RegExp(postEdit.matcher), `${name} must trigger read-cache invalidation`);
  }

  const budgetHook = hooks.find((h) => h.event === 'PostToolUse' && /budget\.js/.test(h.command));
  assert.ok(budgetHook);
  for (const name of ['ReadFile', 'Read', 'WriteFile', 'Write', 'StrReplaceFile', 'Edit', 'Shell', 'Bash']) {
    assert.match(name, new RegExp(budgetHook.matcher), `${name} must trigger budget accounting`);
  }
});

test('read-cache blocks a redundant current ReadFile and current StrReplaceFile invalidates it', () => {
  const file = join(workDir, 'current.js');
  writeFileSync(file, 'line 1\nline 2\nline 3\nline 4\n');
  const sid = `session-current-tools-${process.pid}`;
  const readPayload = {
    hook_event_name: 'PreToolUse', session_id: sid, cwd: workDir,
    tool_name: 'ReadFile', tool_input: { path: file, line_offset: 1, n_lines: 4 },
  };

  const first = runHook('read-cache.js', readPayload);
  assert.equal(first.status, 0, first.stderr);
  const second = runHook('read-cache.js', readPayload);
  assert.equal(second.status, 2, 'redundant current ReadFile must be blocked');

  const edit = runHook('read-cache.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'StrReplaceFile', tool_input: { file_path: file, old_str: 'line 1', new_str: 'line one' },
    tool_output: 'ok',
  });
  assert.equal(edit.status, 0, edit.stderr);

  const afterEdit = runHook('read-cache.js', readPayload);
  assert.equal(afterEdit.status, 0, 'current edit tool invalidates read cache');
});

test('tracker records current ReadFile and StrReplaceFile under canonical semantics', () => {
  const file = join(workDir, 'tracker-current.js');
  writeFileSync(file, 'a\nb\nc\nd\n');
  const sid = `session-current-tracker-${process.pid}`;

  assert.equal(runHook('tracker.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'ReadFile', tool_input: { path: file, line_offset: 1, n_lines: 2 },
    tool_output: 'a\nb',
  }).status, 0);
  assert.equal(runHook('tracker.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'StrReplaceFile', tool_input: { file_path: file, old_str: 'a', new_str: 'A' },
    tool_output: 'ok',
  }).status, 0);

  const s = stateFile('sessions', sid);
  assert.equal(s.totalReads, 1);
  assert.equal(s.totalEdits, 1);
  assert.equal(s.files[file].reads, 1);
  assert.equal(s.files[file].edits, 1);
});

test('budget queues a current Shell big-result advisory and current ReadFile bookkeeping uses the real path', () => {
  const file = join(workDir, 'budget-current.js');
  writeFileSync(file, 'one\ntwo\nthree\n');
  const sid = `session-current-budget-${process.pid}`;

  const read = runHook('budget.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'ReadFile', tool_input: { path: file, line_offset: 1, n_lines: 2 },
    tool_output: 'one\ntwo',
  });
  assert.equal(read.status, 0, read.stderr);
  const state = stateFile('budget', sid);
  assert.ok(state.filesLoaded[file], 'current ReadFile path must be attributed');
  assert.equal(state.filesLoaded[file].reads, 1);

  const shell = runHook('budget.js', {
    hook_event_name: 'PostToolUse', session_id: sid, cwd: workDir,
    tool_name: 'Shell', tool_input: { command: 'cat giant.log' },
    tool_output: 'x'.repeat(40_000),
  });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, '', 'observation hook queues model-visible advice instead of narrating immediately');

  const flush = runHook('notice-flush.js', {
    hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: workDir, prompt: 'continue',
  });
  assert.equal(flush.status, 0, flush.stderr);
  assert.match(flush.stdout, /Shell result was/);
  assert.match(flush.stdout, /tail\/head\/grep/);
});

test('context-shield recognizes current ReadFile and emits the historical-waste warning', () => {
  const file = join(workDir, 'shield-current.js');
  writeFileSync(file, 'const x = 1;\n');
  writeFileSync(join(kcoHome, 'patterns.json'), JSON.stringify({
    projects: {
      [workDir]: {
        fileFrequency: {},
        wastedReads: { [file]: { count: 5, sessions: 5, totalTokensWasted: 5000 } },
        coOccurrence: {},
      },
    },
    taskPatterns: {},
    lastUpdated: new Date().toISOString(),
  }));

  const sid = `session-current-shield-${process.pid}`;
  const result = runHook('context-shield.js', {
    hook_event_name: 'PreToolUse', session_id: sid, cwd: workDir,
    tool_name: 'ReadFile', tool_input: { path: file, line_offset: 1, n_lines: 1 },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /went unused in 5 past sessions/);
});
