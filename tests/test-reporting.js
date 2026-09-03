/**
 * Reporting-module tests for kimi-context-optimizer (KCO).
 *
 * Covers the wave-3 reporting modules: dashboard, report, roi, digest,
 * export, replay, overhead, simulate-savings.
 *
 * The reporting modules resolve DATA_DIR (via utils.js) at import time from
 * KCO_HOME, so they are exercised as CHILD PROCESSES with KCO_HOME /
 * KIMI_CODE_HOME pointed at fresh tmp dirs seeded with fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SRC = new URL('../src/', import.meta.url).pathname;
const SESSION_ID = 'session_report-test-1';

function makeHomes() {
  const kco = mkdtempSync(join(tmpdir(), 'kco-reporting-'));
  const kimi = mkdtempSync(join(tmpdir(), 'kco-reporting-kimi-'));
  for (const d of ['sessions', 'budget', 'read-cache', 'summaries', 'exports', 'notices', 'prompts', 'templates']) {
    mkdirSync(join(kco, d), { recursive: true });
  }
  return { kco, kimi };
}

function seedSession(home, sid = SESSION_ID) {
  writeFileSync(join(home.kco, 'sessions', `${sid}.json`), JSON.stringify({
    id: sid,
    startedAt: new Date().toISOString(),
    projectRoot: '/tmp/proj',
    files: {
      '/tmp/proj/src/a.js': {
        reads: 3, edits: 2, lines: 100, estTokens: 1000,
        firstRead: new Date().toISOString(), wasEdited: true, partialReads: 0, fullReads: 3,
      },
      '/tmp/proj/docs/b.md': {
        reads: 2, edits: 0, lines: 200, estTokens: 2000,
        firstRead: new Date().toISOString(), wasEdited: false, partialReads: 0, fullReads: 2,
      },
    },
    searches: [],
    tools: { Read: { calls: 5 }, Edit: { calls: 2 } },
    totalReads: 5,
    totalEdits: 2,
    totalSearches: 0,
    totalToolCalls: 7,
    failures: { Read: 2 },
    failedCalls: 2,
    delegations: 1,
    subagents: ['explore'],
  }));
  writeFileSync(join(home.kco, 'budget', `${sid}.json`), JSON.stringify({
    sessionId: sid,
    totalTokensEstimated: 50000,
    inputTokensEstimated: 40000,
    outputTokensEstimated: 10000,
    realContextTokens: 42000,
    cacheBreaks: 1,
    model: 'k3',
    warningsSent: [],
    filesLoaded: {},
    startedAt: new Date().toISOString(),
  }));
  writeFileSync(join(home.kco, 'read-cache', `${sid}.json`), JSON.stringify({
    files: {}, totalTokensSaved: 8000, blockedReads: 4,
  }));
}

function seedGlobalStats(home) {
  writeFileSync(join(home.kco, 'global-stats.json'), JSON.stringify({
    totalSessions: 3,
    totalTokensTracked: 150000,
    estimatedTokensSaved: 30000,
    totalFilesRead: 40,
    totalFilesEdited: 12,
    avgTokensPerSession: 50000,
    topWastedFiles: [
      { path: 'b.md', fullPath: '/tmp/proj/docs/b.md', count: 2, sessions: 2, totalTokensWasted: 4000 },
    ],
    topUsefulFiles: [
      { path: 'a.js', fullPath: '/tmp/proj/src/a.js', sessions: 3, totalReads: 9, totalEdits: 6, usefulness: 3 },
    ],
    sessionHistory: [
      { id: 's1', date: new Date(Date.now() - 3 * 86400000).toISOString(), project: 'proj', filesRead: 10, totalReads: 15, totalEdits: 4, tokensTotal: 50000, tokensWasted: 10000, wastePercent: 20 },
      { id: 's2', date: new Date(Date.now() - 2 * 86400000).toISOString(), project: 'proj', filesRead: 12, totalReads: 18, totalEdits: 5, tokensTotal: 60000, tokensWasted: 12000, wastePercent: 20 },
      { id: 's3', date: new Date(Date.now() - 86400000).toISOString(), project: 'proj', filesRead: 8, totalReads: 12, totalEdits: 3, tokensTotal: 40000, tokensWasted: 8000, wastePercent: 20 },
    ],
  }));
}

function seedWireFile(home, sid = SESSION_ID) {
  const wireDir = join(home.kimi, 'sessions', 'wd_proj_ab12cd34', sid, 'agents', 'main');
  mkdirSync(wireDir, { recursive: true });
  const wirePath = join(wireDir, 'wire.jsonl');
  const records = [
    { type: 'config.update', systemPrompt: 'x'.repeat(7400) },
    { type: 'model', model: 'k3' },
    { type: 'step.end', timestamp: '2026-07-18T01:00:00.000Z', usage: { inputOther: 500, output: 20, inputCacheRead: 0, inputCacheCreation: 2000 } },
    { type: 'step.end', timestamp: '2026-07-18T01:01:00.000Z', usage: { inputOther: 800, output: 30, inputCacheRead: 2500, inputCacheCreation: 0 } },
  ];
  writeFileSync(wirePath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return wirePath;
}

function run(script, args, home, extraEnv = {}) {
  const env = { ...process.env, KCO_HOME: home.kco, KIMI_CODE_HOME: home.kimi, ...extraEnv };
  delete env.KCO_CONTEXT_WINDOW;
  const r = spawnSync(process.execPath, [join(SRC, script), ...args], { env, encoding: 'utf-8' });
  assert.equal(r.status, 0, `${script} ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// ── dashboard.js ─────────────────────────────────────────────────────────────

test('dashboard summary: savings are explicitly estimated and not quota-equated', () => {
  const home = makeHomes();
  seedSession(home);
  const out = run('dashboard.js', ['summary', SESSION_ID], home);
  assert.match(out, /Estimated net direct-input reduction: \+~8\.0K tokens/, out);
  assert.match(out, /Counterfactual estimate: blocked reads ~8\.0K/, out);
  assert.match(out, /Not replay-adjusted; not a direct percentage of Kimi subscription quota/, out);
  assert.doesNotMatch(out, /context would have held/, out);
  assert.ok(!out.includes('$'), `unexpected "$" in output:\n${out}`);
});

test('dashboard board: configured pricing is labeled as a configured-rate estimate, not savings truth', () => {
  const home = makeHomes();
  seedSession(home);
  writeFileSync(join(home.kco, 'config.json'), JSON.stringify({
    pricePerMillionInput: 3, pricePerMillionOutput: 15,
  }));
  const board = run('dashboard.js', ['board', SESSION_ID], home);
  assert.ok(board.includes('$'), `expected configured price display:\n${board}`);
  assert.match(board, /configured-rate estimate/, board);
  const summary = run('dashboard.js', ['summary', SESSION_ID], home);
  assert.doesNotMatch(summary, /~\$.*saved|saved.*\$/i, summary);
});

test('dashboard summary: real cache data is usage telemetry, never called token savings', () => {
  const home = makeHomes();
  seedSession(home);
  seedWireFile(home);
  const out = run('dashboard.js', ['summary', SESSION_ID], home);
  assert.match(out, /Prompt cache: 43% hit rate/, out);
  assert.match(out, /2\.5K cache-read input tokens observed/, out);
  assert.match(out, /usage telemetry, not KCO savings/, out);
  assert.match(out, /Cache broke 1x/, out);
  assert.doesNotMatch(out, /served from cache instead of fresh context/, out);
});

test('dashboard board: renders context bar, files, health without crashing', () => {
  const home = makeHomes();
  seedSession(home);
  const out = run('dashboard.js', ['board', SESSION_ID], home);
  assert.match(out, /KCO CONTEXT BOARD/, out);
  assert.match(out, /42\.0K \/ /, out);
  assert.match(out, /2 failed calls/, out);
  assert.match(out, /1 delegations/, out);
  assert.ok(!out.includes('$'), `unexpected "$" in board:\n${out}`);
});

test('dashboard: empty data dir exits 0 with the "no data" board', () => {
  const home = makeHomes();
  const out = run('dashboard.js', [], home);
  assert.match(out, /No session data yet/, out);
});

// ── overhead.js ──────────────────────────────────────────────────────────────

test('overhead: system-prompt size from a synthetic wire file', () => {
  const home = makeHomes();
  const wirePath = seedWireFile(home);
  const out = run('overhead.js', [wirePath], home);
  assert.match(out, /KCO SESSION BASELINE OVERHEAD/, out);
  assert.match(out, /System prompt \(exact\)\s+2\.0K tokens \(7,400 chars/, out);
  assert.match(out, /k3/, out);
  assert.match(out, /Core system prompt & tool schemas/, out);
  assert.ok(!out.includes('$'), `unexpected "$" in overhead output:\n${out}`);
});

test('overhead: no wire transcript still exits 0', () => {
  const home = makeHomes();
  const out = run('overhead.js', [], home);
  assert.match(out, /No wire transcript found/, out);
});

// ── replay.js ────────────────────────────────────────────────────────────────

test('replay: lists seeded summaries', () => {
  const home = makeHomes();
  writeFileSync(join(home.kco, 'summaries', `${SESSION_ID}.txt`),
    'Session 2026-07-18 01:00 (12 min)\nEdited: a.js (1 file)\nContext: 5.0K tokens, 2 files read, 20% waste');
  const out = run('replay.js', [], home, { KCO_QUIET: '1' });
  assert.match(out, /RECENT SESSION SUMMARIES/, out);
  assert.match(out, /Session 2026-07-18 01:00/, out);
  assert.match(out, /Edited: a\.js/, out);
});

test('replay: empty summaries dir exits 0', () => {
  const home = makeHomes();
  const out = run('replay.js', [], home);
  assert.match(out, /No session summaries yet/, out);
});

// ── export.js ────────────────────────────────────────────────────────────────

test('export md: writes an evidence-labeled historical report', () => {
  const home = makeHomes();
  seedGlobalStats(home);
  const out = run('export.js', ['md'], home);
  assert.match(out, /Exported to:/, out);
  const files = readdirSync(join(home.kco, 'exports')).filter(f => f.endsWith('.md'));
  assert.equal(files.length, 1);
  const md = readFileSync(join(home.kco, 'exports', files[0]), 'utf-8');
  assert.match(md, /# KCO Historical Context Report/, md);
  assert.match(md, /150\.0K/, md);
  assert.match(md, /ESTIMATED HISTORICAL HEURISTIC/, md);
  assert.ok(!md.includes('claude'), `Claude reference in export:\n${md}`);
});

test('export html: writes a branded evidence-labeled HTML report', () => {
  const home = makeHomes();
  seedGlobalStats(home);
  run('export.js', ['html'], home);
  const files = readdirSync(join(home.kco, 'exports')).filter(f => f.endsWith('.html'));
  assert.equal(files.length, 1);
  const html = readFileSync(join(home.kco, 'exports', files[0]), 'utf-8');
  assert.match(html, /KCO Context Dashboard/, html);
  assert.match(html, /ESTIMATED HISTORICAL HEURISTIC/, html);
  assert.ok(!html.includes('claude'), `Claude reference in HTML export`);
});

// ── report.js / roi.js / digest.js / simulate-savings.js ────────────────────

test('report full: historical labels, no "$" unconfigured', () => {
  const home = makeHomes();
  seedGlobalStats(home);
  const out = run('report.js', ['full'], home);
  assert.match(out, /KCO — HISTORICAL CONTEXT OPPORTUNITY REPORT/, out);
  assert.match(out, /Estimated historical unused-read volume/, out);
  assert.match(out, /150\.0K/, out);
  assert.ok(!out.includes('$'), `unexpected "$" in report:\n${out}`);
});

test('report full: cost appendix appears when pricing configured', () => {
  const home = makeHomes();
  seedGlobalStats(home);
  writeFileSync(join(home.kco, 'config.json'), JSON.stringify({ pricePerMillionInput: 3 }));
  const out = run('report.js', ['full'], home);
  assert.match(out, /COST APPENDIX/, out);
  assert.ok(out.includes('$'), `expected "$" in report:\n${out}`);
  assert.match(out, /USER-CONFIGURED RATE ONLY/, out);
});

test('roi: per-model historical opportunity table, tokens-first', () => {
  const home = makeHomes();
  seedSession(home);
  const out = run('roi.js', [], home);
  assert.match(out, /KCO — Historical Optimization Opportunity Report/, out);
  assert.match(out, /Historical opportunity by model/, out);
  assert.match(out, /Estimated historical unused-read volume\/session/, out);
  assert.match(out, /k3/, out);
  assert.ok(!out.includes('Haiku') && !out.includes('Sonnet') && !out.includes('Opus'),
    `Claude model names in roi output:\n${out}`);
});

test('digest: efficiency score renders with historical evidence label', () => {
  const home = makeHomes();
  seedSession(home);
  const out = run('digest.js', ['7'], home, { KCO_QUIET: '1' });
  assert.match(out, /KCO WEEKLY CONTEXT EFFICIENCY DIGEST/, out);
  assert.match(out, /EFFICIENCY SCORE/, out);
  assert.match(out, /Estimated historical unused-read volume/, out);
  assert.ok(!out.includes('$'), `unexpected "$" in digest:\n${out}`);
});

test('simulate-savings: reports historical avoidable-read heuristic from fixtures', () => {
  const home = makeHomes();
  seedSession(home);
  const out = run('simulate-savings.js', [], home);
  assert.match(out, /KCO SMART READ CACHE — RETROACTIVE ANALYSIS/, out);
  assert.match(out, /Estimated historical avoidable-read volume: 2\.0K/, out);
  assert.match(out, /not the runtime blocked-read savings ledger/, out);
});
