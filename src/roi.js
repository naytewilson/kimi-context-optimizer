#!/usr/bin/env node

/**
 * KCO historical optimization report.
 *
 * Despite the legacy filename `roi.js`, this command no longer projects
 * tracker waste into causal "KCO savings" or an effective-context multiplier.
 * Tracker history can support an estimated historical unused-read volume and a
 * what-if volume projection at a user-supplied session cadence. It cannot prove
 * future blocked-read savings or a percentage of Kimi subscription quota.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  SESSIONS_DIR, BUDGET_STATE_DIR,
  formatTokens, computeUsefulness, isMainModule,
  computeCost, formatCost,
} from './utils.js';

function analyzeWaste(session) {
  let total = 0;
  let unused = 0;
  let reads = 0;
  let edits = 0;

  for (const f of Object.values(session.files || {})) {
    const estimatedReadVolume = (f.estTokens || 0) * Math.max(1, f.reads || 1);
    total += estimatedReadVolume;
    reads += f.reads || 0;
    edits += f.edits || 0;
    if (computeUsefulness(f) <= 0 && (f.reads || 0) >= 1) unused += estimatedReadVolume;
  }

  return {
    total,
    wasted: unused,
    wastePct: total > 0 ? (unused / total) * 100 : 0,
    reads,
    edits,
    classification: 'ESTIMATED_HISTORICAL',
  };
}

function loadRecentSessions(days = 30) {
  if (!existsSync(SESSIONS_DIR)) return [];
  const cutoff = Date.now() - days * 86400000;
  const sessions = [];
  for (const f of readdirSync(SESSIONS_DIR).filter(x => x.endsWith('.json'))) {
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8'));
      if (!s.files || Object.keys(s.files).length === 0) continue;
      const ts = new Date(s.updatedAt || s.startedAt || 0).getTime();
      if (ts >= cutoff) sessions.push(s);
    } catch { /* skip corrupt */ }
  }
  return sessions;
}

function getSessionModel(session) {
  try {
    const b = JSON.parse(readFileSync(join(BUDGET_STATE_DIR, `${session.id}.json`), 'utf-8'));
    return b.model || 'unknown';
  } catch { return 'unknown'; }
}

function buildModelTable(sessions) {
  const table = {};
  for (const s of sessions) {
    const model = getSessionModel(s);
    const a = analyzeWaste(s);
    if (!table[model]) table[model] = { sessions: 0, total: 0, wasted: 0, reads: 0, edits: 0 };
    const m = table[model];
    m.sessions++;
    m.total += a.total;
    m.wasted += a.wasted;
    m.reads += a.reads;
    m.edits += a.edits;
  }
  return table;
}

function formatROIReport(sessions, sessionsPerDay = 5) {
  const modelTable = buildModelTable(sessions);
  let total = 0;
  let unused = 0;
  for (const s of sessions) {
    const a = analyzeWaste(s);
    total += a.total;
    unused += a.wasted;
  }

  const avgTotal = sessions.length ? total / sessions.length : 0;
  const avgUnused = sessions.length ? unused / sessions.length : 0;
  const historicalUnusedPct = total > 0 ? (unused / total) * 100 : 0;
  const projectedMonthVolume = avgUnused * Math.max(0, sessionsPerDay) * 30;

  let out = '\n';
  out += `  ╔${'═'.repeat(62)}╗\n`;
  out += '  ║        KCO — Historical Optimization Opportunity Report        ║\n';
  out += `  ╚${'═'.repeat(62)}╝\n\n`;
  out += `  Evidence class: ESTIMATED HISTORICAL HEURISTIC\n`;
  out += `  Data source: ${sessions.length} tracked session${sessions.length === 1 ? '' : 's'}\n`;
  out += `  Estimated historical read volume/session: ${formatTokens(avgTotal)}\n`;
  out += `  Estimated historical unused-read volume/session: ${formatTokens(avgUnused)} (${historicalUnusedPct.toFixed(1)}%)\n`;
  out += `  This is not the runtime blocked-read savings ledger and not a direct measurement of Kimi subscription quota.\n\n`;

  out += '  ── Historical opportunity by model ──────────────────────────────\n';
  out += '  Model           Sess  Unused%   Read vol   Unused vol\n';
  out += '  ' + '─'.repeat(56) + '\n';
  for (const [model, m] of Object.entries(modelTable).sort((a, b) => b[1].sessions - a[1].sessions)) {
    const pct = m.total > 0 ? (m.wasted / m.total) * 100 : 0;
    const avg = m.sessions ? m.total / m.sessions : 0;
    const avgWaste = m.sessions ? m.wasted / m.sessions : 0;
    out += `  ${model.padEnd(15)} ${String(m.sessions).padStart(4)}  ${pct.toFixed(1).padStart(6)}%  ${formatTokens(avg).padStart(9)}  ${formatTokens(avgWaste).padStart(11)}\n`;
  }

  out += '\n  ── What-if cadence projection ──────────────────────────────────\n';
  out += `  At ${sessionsPerDay} session${sessionsPerDay === 1 ? '' : 's'}/day with the same historical pattern,\n`;
  out += `  estimated historical avoidable-read volume would be ~${formatTokens(projectedMonthVolume)}/30 days.\n`;
  out += '  This is a volume projection, not a forecast of causal KCO savings.\n';

  const formatted = formatCost(computeCost(projectedMonthVolume, 'input'));
  if (formatted) {
    out += `  Configured-rate value of that historical volume: ~${formatted} (user-supplied rate only).\n`;
  }
  out += '\n';
  return out;
}

function main() {
  const sessionsPerDay = Math.max(0, parseInt(process.argv[2], 10) || 5);
  const sessions = loadRecentSessions(30);
  if (!sessions.length) {
    console.log('\n  No tracked sessions in the last 30 days. Use Kimi Code normally, then run /kco-roi again.\n');
    return;
  }
  console.log(formatROIReport(sessions, sessionsPerDay));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[kco] roi error: ${e.message}`); process.exit(0); }
}

export { analyzeWaste, buildModelTable, formatROIReport };
