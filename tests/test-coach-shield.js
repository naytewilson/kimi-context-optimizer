/**
 * Tests for prompt-coach.js and context-shield.js (KCO port).
 *
 * Uses temp dirs: KCO_HOME is pointed at os.tmpdir() before importing the
 * modules under test (utils.js resolves DATA_DIR at import time). Hook-mode
 * behaviour is tested by spawning the scripts as child processes with a
 * synthetic Kimi hook payload on stdin — including the UserPromptSubmit
 * `prompt` as an ARRAY of content parts, exactly like Kimi sends it.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── Temp home (must be set before importing src modules) ─────────────────────

const kcoHome = mkdtempSync(join(tmpdir(), 'kco-test-coach-'));
process.env.KCO_HOME = kcoHome;

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

let coach, shield;

before(async () => {
  coach = await import('../src/prompt-coach.js');
  shield = await import('../src/context-shield.js');
});

// ── Child-process helper ─────────────────────────────────────────────────────

/** Fresh isolated KCO home per spawned hook (patterns, ledgers, prompt logs). */
function freshHome() {
  return mkdtempSync(join(tmpdir(), 'kco-test-hook-'));
}

function spawnScript(script, { args = [], payload = null, home, cwd = PROJECT_ROOT } = {}) {
  const env = { ...process.env, KCO_HOME: home || freshHome() };
  // Quiet mode (KCO_QUIET / CI=true) would silence the coach — tests need it off.
  delete env.KCO_QUIET;
  delete env.CI;
  const res = spawnSync('node', [join(SRC_DIR, script), ...args], {
    input: payload ? JSON.stringify(payload) : '',
    env,
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  assert.equal(res.status, 0, `${script} exited ${res.status}, stderr: ${res.stderr}`);
  return res;
}

function promptPayload(text, sessionId, extra = {}) {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId,
    cwd: PROJECT_ROOT,
    // Kimi sends prompt as an ARRAY of content parts, not a string.
    prompt: [{ type: 'text', text }],
    ...extra,
  };
}

// ── prompt-coach: classification (pure) ──────────────────────────────────────

test('classifyPrompt: EN chat "thanks" → chat', () => {
  assert.equal(coach.classifyPrompt('thanks'), 'chat');
});

test('classifyPrompt: RU chat "спасибо, всё ок" → chat', () => {
  assert.equal(coach.classifyPrompt('спасибо, всё ок'), 'chat');
});

test('classifyPrompt: question shape → question', () => {
  assert.equal(coach.classifyPrompt('why does the build fail on CI?'), 'question');
  assert.equal(coach.classifyPrompt('как работает кэш?'), 'question');
});

test('classifyPrompt: work request → task', () => {
  assert.equal(coach.classifyPrompt('fix the crash in src/auth/login.ts'), 'task');
});

// ── prompt-coach: analysis (pure) ────────────────────────────────────────────

test('analyzePrompt: weak unbounded prompt scores <80 with suggestions', () => {
  const a = coach.analyzePrompt('improve the code please make it better');
  assert.ok(a.score < 80, `expected weak score, got ${a.score}`);
  assert.ok(a.suggestions.length > 0, 'expected at least one suggestion');
});

test('analyzePrompt: specific task prompt scores ≥80', () => {
  const a = coach.analyzePrompt(
    'Fix the TypeError in src/auth/login.ts:42 so that the login tests pass again'
  );
  assert.ok(a.score >= 80, `expected strong score, got ${a.score}`);
});

// ── prompt-coach: hook mode (child process) ──────────────────────────────────

test('hook: weak task prompt → coaching on stdout, grade logged to jsonl', () => {
  const home = freshHome();
  const sid = 'session_coach-weak';
  const res = spawnScript('prompt-coach.js', {
    home,
    payload: promptPayload('improve the code please make it better', sid),
  });
  assert.match(res.stdout, /\[prompt-coach\] Prompt quality:/);
  assert.match(res.stdout, /Suggestions/);

  // Grade must be appended to prompts/<sid>.jsonl
  const logFile = join(home, 'prompts', `${sid}.jsonl`);
  assert.ok(existsSync(logFile), 'prompt log file missing');
  const entries = readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'task');
  assert.ok(entries[0].score < 80);
});

test('hook: strong task prompt → silent', () => {
  const res = spawnScript('prompt-coach.js', {
    payload: promptPayload(
      'Fix the TypeError in src/auth/login.ts:42 so that the login tests pass again',
      'session_coach-strong'
    ),
  });
  assert.equal(res.stdout.trim(), '', `expected silence, got: ${res.stdout}`);
});

test('hook: RU chat "спасибо" → silent (array prompt parts)', () => {
  const home = freshHome();
  const sid = 'session_coach-ru';
  const res = spawnScript('prompt-coach.js', {
    home,
    payload: promptPayload('спасибо', sid),
  });
  assert.equal(res.stdout.trim(), '', `expected silence, got: ${res.stdout}`);

  // Chat prompts are logged with kind=chat and no grade.
  const logFile = join(home, 'prompts', `${sid}.jsonl`);
  const entries = readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(entries[0].kind, 'chat');
  assert.equal(entries[0].grade, '-');
});

test('hook: questions are graded for history but never coached', () => {
  const res = spawnScript('prompt-coach.js', {
    payload: promptPayload('why is everything broken?', 'session_coach-question'),
  });
  assert.equal(res.stdout.trim(), '', `expected silence, got: ${res.stdout}`);
});

test('cli: grade subcommand prints a report', () => {
  const res = spawnScript('prompt-coach.js', {
    args: ['grade', 'improve the code please make it better'],
  });
  assert.match(res.stdout, /PROMPT QUALITY/);
  assert.match(res.stdout, /Suggestions/);
});

// ── context-shield: hook mode (child process) ────────────────────────────────

const WASTED_FILE = join(PROJECT_ROOT, 'src', 'utils.js');

function seedWastedPatterns(home, filePath, sessions = 4, tokens = 12000) {
  writeFileSync(join(home, 'patterns.json'), JSON.stringify({
    projects: {
      _global: {
        fileFrequency: {},
        wastedReads: { [filePath]: { sessions, totalTokensWasted: tokens } },
        coOccurrence: {},
      },
    },
    taskPatterns: {},
    lastUpdated: null,
  }));
}

function readPayload(filePath, sessionId) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: PROJECT_ROOT,
    tool_name: 'Read',
    // Kimi Read input uses `path`, not `file_path`.
    tool_input: { path: filePath },
    tool_call_id: 'toolu_test1',
  };
}

test('shield: warns on historically wasted file (seeded patterns.json)', () => {
  const home = freshHome();
  seedWastedPatterns(home, WASTED_FILE, 4);
  const res = spawnScript('context-shield.js', {
    home,
    payload: readPayload(WASTED_FILE, 'session_shield-warn'),
  });
  assert.match(res.stdout, /\[context-shield\]/);
  assert.match(res.stdout, /utils\.js/);
});

test('shield: 5+ wasted sessions → stronger "went unused" warning', () => {
  const home = freshHome();
  seedWastedPatterns(home, WASTED_FILE, 6, 40000);
  const res = spawnScript('context-shield.js', {
    home,
    payload: readPayload(WASTED_FILE, 'session_shield-strong'),
  });
  assert.match(res.stdout, /went unused in 6 past sessions/);
});

test('shield: unknown file with no history → silent', () => {
  const res = spawnScript('context-shield.js', {
    payload: readPayload(join(PROJECT_ROOT, 'src', 'hook-io.js'), 'session_shield-clean'),
  });
  assert.equal(res.stdout.trim(), '', `expected silence, got: ${res.stdout}`);
});

test('shield: never blocks — exit 0 even for known waste', () => {
  const home = freshHome();
  seedWastedPatterns(home, WASTED_FILE, 10, 99999);
  const res = spawnScript('context-shield.js', {
    home,
    payload: readPayload(WASTED_FILE, 'session_shield-noblock'),
  });
  assert.equal(res.status, 0);
  assert.equal(res.stderr.trim(), '');
});

// ── context-shield: .contextignore CLI ───────────────────────────────────────

test('shield cli: apply writes wasted files to .contextignore', () => {
  const home = freshHome();
  // realpath: on macOS /var → /private/var, and the child process's cwd is
  // fully resolved, so patterns.json must be keyed by the resolved path.
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'kco-test-proj-')));
  mkdirSync(join(project, 'logs'), { recursive: true });
  const wastedAbs = join(project, 'logs', 'debug.log');

  // Patterns keyed by THIS project root so buildIgnoreSuggestions picks it up.
  writeFileSync(join(home, 'patterns.json'), JSON.stringify({
    projects: {
      [project]: {
        fileFrequency: {},
        wastedReads: { [wastedAbs]: { sessions: 5, totalTokensWasted: 40000 } },
        coOccurrence: {},
      },
    },
    taskPatterns: {},
    lastUpdated: null,
  }));

  const res = spawnScript('context-shield.js', {
    args: ['apply'],
    home,
    cwd: project,
  });
  assert.match(res.stdout, /CONTEXTIGNORE APPLIED/);

  const ignoreFile = join(project, '.contextignore');
  assert.ok(existsSync(ignoreFile), '.contextignore was not created');
  const content = readFileSync(ignoreFile, 'utf-8');
  assert.match(content, /\/kco-shield apply/);
  assert.ok(
    content.split('\n').some(l => l.trim() === join('logs', 'debug.log')),
    `expected "logs/debug.log" rule in .contextignore, got:\n${content}`
  );

  // Second run: the pattern is already ignored → no candidates, no duplicate.
  const res2 = spawnScript('context-shield.js', { args: ['apply'], home, cwd: project });
  assert.match(res2.stdout, /No \.contextignore candidates/);
  const after = readFileSync(ignoreFile, 'utf-8');
  assert.equal(after, content, '.contextignore should be unchanged on re-apply');
});

test('buildIgnoreSuggestions: dedupes against existing ignore lines (pure)', () => {
  const project = '/tmp/fakeproj';
  const patterns = {
    projects: {
      [project]: {
        wastedReads: {
          '/tmp/fakeproj/a.log': { sessions: 5, totalTokensWasted: 50000 },
          '/tmp/fakeproj/b.log': { sessions: 4, totalTokensWasted: 30000 },
          '/tmp/fakeproj/c.log': { sessions: 2, totalTokensWasted: 99000 }, // < 3 sessions
        },
      },
    },
  };
  const out = shield.buildIgnoreSuggestions(patterns, project, ['a.log\n']);
  assert.deepEqual(out.map(s => s.pattern), ['b.log']);
  assert.equal(out[0].tokens, 30000);
});
