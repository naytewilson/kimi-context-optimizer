/**
 * Tooling-module tests for kimi-context-optimizer (KCO).
 *
 * Covers: agentsmd-analyzer (analysis of a synthetic bloated AGENTS.md),
 * doctor (child process against a synthetic environment), sync-version
 * (fixture kimi.plugin.json), tasks store (start/finish attribution
 * round-trip), plus anatomy / smart-pack smoke tests.
 *
 * Temp dirs: KCO_HOME (KCO state) and KIMI_CODE_HOME (fake Kimi CLI home)
 * are pointed at os.tmpdir() before importing the modules under test —
 * utils.js resolves DATA_DIR at import time, so imports are dynamic.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ── Temp homes (must be set before importing src modules) ────────────────────

const kcoHome = mkdtempSync(join(tmpdir(), 'kco-tools-'));
const kimiHome = mkdtempSync(join(tmpdir(), 'kco-tools-kimi-'));
process.env.KCO_HOME = kcoHome;
process.env.KIMI_CODE_HOME = kimiHome;
delete process.env.KCO_CONTEXT_WINDOW;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let analyzer, tasks, anatomy, smartPack;

before(async () => {
  analyzer = await import('../src/agentsmd-analyzer.js');
  tasks = await import('../src/tasks.js');
  anatomy = await import('../src/anatomy.js');
  smartPack = await import('../src/smart-pack.js');
});

// ── agentsmd-analyzer ────────────────────────────────────────────────────────

function bloatedAgentsMd() {
  const lines = [
    '# Project Rules',
    '',
    'Please make sure to always run the full test suite before you commit any code.',
    'It is important that you never commit directly to the main branch.',
    'You should always write descriptive commit messages for every change.',
    '',
    '## Code Style',
    '',
  ];
  // One oversized section (>1000 tokens): 150 lines of prose.
  for (let i = 0; i < 150; i++) {
    lines.push(`Rule number ${i}: when you are working on feature ${i}, do not under any circumstances skip the linter step.`);
  }
  lines.push('', '## Duplicated Wisdom', '');
  // Duplicate lines (>=10 chars after normalization, repeated).
  for (let i = 0; i < 4; i++) {
    lines.push('Always keep the build green before merging anything into the release branch.');
  }
  lines.push('', '## Long Example', '', '```js');
  for (let i = 0; i < 30; i++) lines.push(`const exampleLine${i} = doSomethingVerbose(${i});`);
  lines.push('```', '');
  return lines.join('\n');
}

test('agentsmd: bloated AGENTS.md — sections, tokens, suggestions', () => {
  const res = analyzer.analyzeContent(bloatedAgentsMd(), '/tmp/proj/AGENTS.md');
  assert.ok(res.tokens > 0, 'token estimate should be > 0');
  assert.ok(res.sections.length >= 4, `expected >=4 sections, got ${res.sections.length}`);
  const titles = res.sections.map(s => s.title);
  assert.ok(titles.includes('Project Rules'));
  assert.ok(titles.includes('Code Style'));
  assert.ok(titles.includes('Duplicated Wisdom'));
  // Every section carries a positive token estimate.
  assert.ok(res.sections.every(s => s.tokens > 0));
  // Suggestions: size/section_size + duplicates + verbose + code_block.
  assert.ok(res.issues.length > 0, 'expected non-empty suggestions');
  const types = new Set(res.issues.map(i => i.type));
  assert.ok(types.has('duplicates'), 'duplicates should be detected');
  assert.ok(types.has('verbose'), 'verbose patterns should be detected');
  assert.ok(types.has('section_size'), 'oversized section should be detected');
  assert.ok(types.has('code_block'), 'long code block should be detected');
  assert.ok(res.totalSavings > 0);
  // Report renders and points at the skill.
  const report = analyzer.formatReport(res);
  assert.match(report, /AGENTS\.MD ANALYSIS/);
  assert.match(report, /\/kco-agentsmd/);
});

test('agentsmd: clean file yields no issues', () => {
  const res = analyzer.analyzeContent('# Rules\n- Always test.\n- Never force-push.\n- Keep functions small.', '/tmp/proj/AGENTS.md');
  assert.equal(res.issues.length, 0);
  assert.match(analyzer.formatReport(res), /clean and efficient/);
});

test('agentsmd: findAgentsFiles finds project + user-level files', () => {
  const proj = mkdtempSync(join(tmpdir(), 'kco-agents-proj-'));
  writeFileSync(join(proj, 'AGENTS.md'), '# project\n');
  const fakeHome = mkdtempSync(join(tmpdir(), 'kco-agents-home-'));
  mkdirSync(join(fakeHome, '.agents'), { recursive: true });
  writeFileSync(join(fakeHome, '.agents', 'AGENTS.md'), '# user\n');
  // os.homedir() honours $HOME on POSIX — swap it just for this call.
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const found = analyzer.findAgentsFiles(proj);
    assert.ok(found.includes(join(proj, 'AGENTS.md')), 'project AGENTS.md');
    assert.ok(found.includes(join(fakeHome, '.agents', 'AGENTS.md')), 'user-level AGENTS.md');
  } finally {
    process.env.HOME = prevHome;
  }
});

// ── doctor (child process against a synthetic environment) ──────────────────

test('doctor: exit 0 with PASS lines in a synthetic environment', () => {
  const dKco = mkdtempSync(join(tmpdir(), 'kco-doctor-data-'));
  const dKimi = mkdtempSync(join(tmpdir(), 'kco-doctor-kimi-'));
  writeFileSync(join(dKimi, 'config.toml'), [
    'default_model = "kimi-code/k3"',
    '',
    '[models."kimi-code/k3"]',
    'model = "k3"',
    'max_context_size = 262144',
    '',
  ].join('\n'));
  const wireDir = join(dKimi, 'sessions', 'wd_proj_ab12cd34', 'session_test-1', 'agents', 'main');
  mkdirSync(wireDir, { recursive: true });
  writeFileSync(join(wireDir, 'wire.jsonl'),
    JSON.stringify({ type: 'step.end', usage: { inputOther: 10, output: 5 } }) + '\n');

  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'doctor.js')], {
    encoding: 'utf-8',
    env: { ...process.env, KCO_HOME: dKco, KIMI_CODE_HOME: dKimi },
  });
  assert.equal(r.status, 0, `doctor must always exit 0 (fail-open).\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /\[PASS\]/, 'expected at least one PASS line');
  assert.match(r.stdout, /\[PASS\] node version/);
  assert.match(r.stdout, /\[PASS\] data directory writable/);
  assert.match(r.stdout, /\[PASS\] plugin manifest/);
  assert.match(r.stdout, /\[PASS\] Kimi CLI config/);
  assert.match(r.stdout, /\[PASS\] wire transcripts reachable/);
  // No managed copy in the fixture → pass with a source-checkout note.
  assert.match(r.stdout, /\[PASS\] managed plugin copy in sync/);
  // Summary line present.
  assert.match(r.stdout, /\d+ pass, \d+ warn, \d+ fail/);
});

test('doctor: warns when no wire transcripts and stale managed copy', () => {
  const dKco = mkdtempSync(join(tmpdir(), 'kco-doctor-data2-'));
  const dKimi = mkdtempSync(join(tmpdir(), 'kco-doctor-kimi2-'));
  writeFileSync(join(dKimi, 'config.toml'), 'default_model = "kimi-code/k3"\n[models."kimi-code/k3"]\nmax_context_size = 262144\n');
  mkdirSync(join(dKimi, 'sessions'), { recursive: true });
  // Managed copy with a deliberately stale version.
  const managedDir = join(dKimi, 'plugins', 'managed', 'kimi-context-optimizer');
  mkdirSync(managedDir, { recursive: true });
  writeFileSync(join(managedDir, 'kimi.plugin.json'), JSON.stringify({ name: 'kimi-context-optimizer', version: '0.0.0-stale' }));

  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'doctor.js')], {
    encoding: 'utf-8',
    env: { ...process.env, KCO_HOME: dKco, KIMI_CODE_HOME: dKimi },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[WARN\] wire transcripts reachable.*estimation fallback/s);
  assert.match(r.stdout, /\[WARN\] managed plugin copy in sync.*reinstall to apply changes/s);
});

// ── sync-version ─────────────────────────────────────────────────────────────

test('sync-version: updates a fixture kimi.plugin.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'kco-sync-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'kimi-context-optimizer', version: '2.3.4' }, null, 2) + '\n');
  writeFileSync(join(root, 'kimi.plugin.json'),
    JSON.stringify({ name: 'kimi-context-optimizer', version: '1.0.0', description: 'keep me', hooks: [] }, null, 2) + '\n');

  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-version.js'), root], { encoding: 'utf-8' });
  assert.equal(r.status, 0, `sync-version failed.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /1\.0\.0 → 2\.3\.4/);

  const manifest = JSON.parse(readFileSync(join(root, 'kimi.plugin.json'), 'utf-8'));
  assert.equal(manifest.version, '2.3.4');
  assert.equal(manifest.description, 'keep me', 'description must not be clobbered');

  // Idempotent second run.
  const r2 = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-version.js'), root], { encoding: 'utf-8' });
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /already in sync: 2\.3\.4/);
});

// ── tasks store ──────────────────────────────────────────────────────────────

test('tasks: start/finish attribution round-trip (pure + disk)', () => {
  // Pure: start a task, attribution is delta from tokensAtStart.
  let state = tasks.emptyState();
  const start = tasks.addTask(state, {
    name: 'port tooling modules', project: '/p', sessionId: 's1',
    tokensNow: 1000, files: ['src/doctor.js'], stamp: '2026-07-18T00:00:00.000Z',
  });
  state = start.state;
  assert.equal(start.task.id, 1);
  assert.equal(start.task.status, 'active');
  assert.equal(tasks.getActiveTask(state, { project: '/p', sessionId: 's1' }).name, 'port tooling modules');
  assert.equal(tasks.taskSpend(start.task, 1400), 400);

  // Starting a second task completes the first (one active per scope).
  const second = tasks.addTask(state, {
    name: 'write tests', project: '/p', sessionId: 's1', tokensNow: 1500,
    stamp: '2026-07-18T00:05:00.000Z',
  });
  state = second.state;
  const first = state.tasks.find(t => t.id === 1);
  assert.equal(first.status, 'done');
  assert.equal(first.tokensAtEnd, 1500);
  assert.equal(tasks.taskSpend(first, 9999), 500, 'done tasks use tokensAtEnd, not tokensNow');

  // Finish the second task.
  const done = tasks.completeActiveTask(state, {
    project: '/p', sessionId: 's1', tokensNow: 2100, note: 'all green',
    stamp: '2026-07-18T00:10:00.000Z',
  });
  assert.ok(done.task);
  assert.equal(done.task.note, 'all green');
  assert.equal(tasks.taskSpend(done.task, 0), 600);
  assert.equal(tasks.getActiveTask(done.state, { project: '/p', sessionId: 's1' }), null);

  // Disk round-trip via TASKS_FILE (KCO_HOME tmp dir).
  tasks.saveTasks(done.state);
  const loaded = tasks.loadTasks();
  assert.equal(loaded.tasks.length, 2);
  const t2 = loaded.tasks.find(t => t.id === 2);
  assert.equal(t2.name, 'write tests');
  assert.equal(t2.status, 'done');
  assert.equal(tasks.taskSpend(t2, 0), 600);
  assert.equal(loaded.nextId, 3);
  assert.equal(tasks.tasksForProject(loaded, '/p').length, 2);
  assert.equal(tasks.tasksForProject(loaded, '/other').length, 0);
});

test('tasks: completing with no active task is a no-op', () => {
  const state = tasks.emptyState();
  const r = tasks.completeActiveTask(state, { project: '/p', tokensNow: 5 });
  assert.equal(r.task, null);
  assert.equal(r.state.tasks.length, 0);
});

// ── anatomy / smart-pack smoke ───────────────────────────────────────────────

test('anatomy: generates a structure map for a tmp project', () => {
  const proj = mkdtempSync(join(tmpdir(), 'kco-anatomy-'));
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'index.js'), 'export function main() {}\nconsole.log(main);\n');
  writeFileSync(join(proj, 'package.json'), '{"name":"tmp"}\n');
  const out = anatomy.generateAnatomy(proj);
  assert.match(out, /# Project Anatomy:/);
  assert.match(out, /src\/index\.js/);
  assert.match(out, /## Summary/);
});

test('smart-pack: buildPack returns a ranked pack without crashing', () => {
  const proj = mkdtempSync(join(tmpdir(), 'kco-pack-'));
  writeFileSync(join(proj, 'login.js'), 'export function login() { return true; }\n');
  const pack = smartPack.buildPack('fix login bug in login.js', proj);
  assert.ok(Array.isArray(pack.files));
  assert.ok(pack.totalEstTokens >= 0);
  // The mentioned file exists → top of the pack with relevance 100.
  assert.equal(pack.files[0].file, join(proj, 'login.js'));
  assert.equal(pack.files[0].relevance, 100);
});
