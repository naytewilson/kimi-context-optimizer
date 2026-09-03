/**
 * Historical analytics must not masquerade as causal runtime savings.
 *
 * `global-stats.json` and tracker session files contain heuristic read/use
 * history. That is useful for optimization advice, but it is not the same
 * quantity as the runtime read-cache counterfactual savings ledger.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

function home() {
  const kco = mkdtempSync(join(tmpdir(), 'kco-historical-labels-'));
  const kimi = mkdtempSync(join(tmpdir(), 'kco-historical-labels-kimi-'));
  for (const d of ['sessions', 'budget', 'read-cache', 'summaries', 'exports', 'notices', 'prompts']) {
    mkdirSync(join(kco, d), { recursive: true });
  }

  const now = new Date().toISOString();
  const session = {
    id: 'session_hist_1', startedAt: now, updatedAt: now, projectRoot: '/tmp/proj',
    totalReads: 5, totalEdits: 1, totalSearches: 1,
    files: {
      '/tmp/proj/a.js': { reads: 3, fullReads: 3, edits: 1, wasEdited: true, partialReads: 0, estTokens: 1000 },
      '/tmp/proj/b.md': { reads: 2, fullReads: 2, edits: 0, wasEdited: false, partialReads: 0, estTokens: 2000 },
    },
  };
  writeFileSync(join(kco, 'sessions', 'session_hist_1.json'), JSON.stringify(session));
  writeFileSync(join(kco, 'budget', 'session_hist_1.json'), JSON.stringify({ sessionId: 'session_hist_1', model: 'k3' }));
  writeFileSync(join(kco, 'global-stats.json'), JSON.stringify({
    totalSessions: 1,
    totalTokensTracked: 7000,
    estimatedTokensSaved: 4000,
    totalFilesRead: 2,
    totalFilesEdited: 1,
    avgTokensPerSession: 7000,
    topWastedFiles: [{ path: 'b.md', fullPath: '/tmp/proj/b.md', count: 2, sessions: 1, totalTokensWasted: 4000 }],
    topUsefulFiles: [{ path: 'a.js', fullPath: '/tmp/proj/a.js', sessions: 1, totalReads: 3, totalEdits: 1, usefulness: 1 }],
    sessionHistory: [{
      id: 'session_hist_1', date: now, project: 'proj', filesRead: 2,
      totalReads: 5, totalEdits: 1, tokensTotal: 7000, tokensWasted: 4000, wastePercent: 57,
    }],
  }));
  return { kco, kimi };
}

function run(script, args = []) {
  const h = home();
  const r = spawnSync(process.execPath, [join(src, script), ...args], {
    cwd: root,
    env: { ...process.env, KCO_HOME: h.kco, KIMI_CODE_HOME: h.kimi, KCO_QUIET: '1' },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 0, `${script}: ${r.stderr}`);
  return { ...h, stdout: r.stdout };
}

function assertHistoricalLabel(text, surface) {
  assert.match(text, /estimated historical (unused-read|avoidable-read) volume/i,
    `${surface} must name the historical heuristic honestly`);
  assert.doesNotMatch(text, /what kco saves you/i, `${surface} must not call the heuristic causal savings`);
  assert.doesNotMatch(text, /effective context multiplier/i, `${surface} must not invent a context multiplier`);
  assert.doesNotMatch(text, /makes your context window .*x more effective/i, `${surface} must not invent effective context`);
  assert.doesNotMatch(text, /tokens that would have been saved/i, `${surface} must not present historical heuristic as counterfactual proof`);
  assert.doesNotMatch(text, /saveable/i, `${surface} must not label all historical waste as saveable`);
  assert.doesNotMatch(text, /saved\/mo|saved \(/i, `${surface} must not project historical waste as saved tokens`);
}

test('simulate command labels its result as historical heuristic, not runtime savings proof', () => {
  const { stdout } = run('simulate-savings.js');
  assertHistoricalLabel(stdout, 'simulate-savings');
  assert.match(stdout, /not the runtime blocked-read savings ledger/i);
});

test('ROI command reports historical optimization opportunity without multiplier or quota claim', () => {
  const { stdout } = run('roi.js', ['5']);
  assertHistoricalLabel(stdout, 'roi');
  assert.match(stdout, /not a direct measurement of kimi subscription quota/i);
});

test('full report labels global-stats waste as historical estimated volume', () => {
  const { stdout } = run('report.js', ['full']);
  assertHistoricalLabel(stdout, 'report');
});

test('digest labels waste statistics as historical estimates', () => {
  const { stdout } = run('digest.js', ['7']);
  assertHistoricalLabel(stdout, 'digest');
});

test('markdown and html exports carry the historical-estimate caveat and no saveable claim', () => {
  const h = home();
  for (const mode of ['md', 'html']) {
    const r = spawnSync(process.execPath, [join(src, 'export.js'), mode], {
      cwd: root,
      env: { ...process.env, KCO_HOME: h.kco, KIMI_CODE_HOME: h.kimi, KCO_QUIET: '1' },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
  }
  const files = readdirSync(join(h.kco, 'exports'));
  assert.ok(files.some((f) => f.endsWith('.md')));
  assert.ok(files.some((f) => f.endsWith('.html')));
  for (const f of files) {
    const text = readFileSync(join(h.kco, 'exports', f), 'utf8');
    assertHistoricalLabel(text, `export ${f}`);
    assert.match(text, /not the runtime blocked-read savings ledger/i);
  }
});
