#!/usr/bin/env node

/**
 * KCO historical context-efficiency digest (/kco-digest).
 *
 * The digest grades behavior from tracker history. Its unused-read token volume
 * is an ESTIMATED HISTORICAL HEURISTIC, not the runtime blocked-read savings
 * ledger and not a measurement of Kimi subscription quota.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  SESSIONS_DIR, formatTokens, loadJSON, computeUsefulness, isMainModule,
} from './utils.js';

function loadRecentSessions(days = 7) {
  if (!existsSync(SESSIONS_DIR)) return [];
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const sessions = [];
  for (const f of readdirSync(SESSIONS_DIR).filter(x => x.endsWith('.json'))) {
    const s = loadJSON(join(SESSIONS_DIR, f));
    if (!s || !s.files || Object.keys(s.files).length === 0) continue;
    const ts = new Date(s.updatedAt || s.endedAt || s.startedAt || 0).getTime();
    if (ts >= cutoff) sessions.push(s);
  }
  return sessions;
}

function historicalMetrics(sessions) {
  let totalReadVolume = 0;
  let unusedReadVolume = 0;
  let reads = 0;
  let edits = 0;
  let searches = 0;
  let failures = 0;

  for (const s of sessions) {
    reads += s.totalReads || 0;
    edits += s.totalEdits || 0;
    searches += s.totalSearches || 0;
    failures += s.failedCalls || 0;
    for (const f of Object.values(s.files || {})) {
      const volume = (f.estTokens || 0) * Math.max(1, f.reads || 1);
      totalReadVolume += volume;
      if (computeUsefulness(f) <= 0 && (f.reads || 0) > 0) unusedReadVolume += volume;
    }
  }

  return {
    totalReadVolume,
    unusedReadVolume,
    unusedPct: totalReadVolume > 0 ? (unusedReadVolume / totalReadVolume) * 100 : 0,
    reads, edits, searches, failures,
  };
}

/** 0..100 behavioral efficiency score. This is a heuristic grade, not savings. */
function calculateEfficiencyScore(sessions) {
  if (!sessions.length) return { score: 0, grade: 'N/A', breakdown: {} };
  const m = historicalMetrics(sessions);
  const contextPrecision = Math.max(0, 100 - Math.round(m.unusedPct));
  const editEfficiency = m.reads > 0 ? Math.min(100, Math.round((m.edits / m.reads) * 200)) : 100;
  const searchAccuracy = (m.searches + m.reads) > 0
    ? Math.max(0, Math.min(100, Math.round((m.searches / (m.searches + m.reads)) * 100 + 70)))
    : 100;
  const focusScore = Math.max(0, 100 - Math.min(60, m.failures * 5));
  const score = Math.round(
    contextPrecision * 0.40 + editEfficiency * 0.25 + searchAccuracy * 0.15 + focusScore * 0.20,
  );
  const grade = score >= 90 ? 'S' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : score >= 50 ? 'D' : 'F';
  return { score, grade, breakdown: { contextPrecision, editEfficiency, searchAccuracy, focusScore } };
}

function renderDigest(sessions, days) {
  if (!sessions.length) return '\n  No tracked sessions in this period.\n';
  const m = historicalMetrics(sessions);
  const e = calculateEfficiencyScore(sessions);
  const barWidth = 40;
  const filled = Math.max(0, Math.min(barWidth, Math.round(e.score / 100 * barWidth)));

  let out = '\n';
  out += `  ╔${'═'.repeat(62)}╗\n`;
  out += '  ║            KCO WEEKLY CONTEXT EFFICIENCY DIGEST              ║\n';
  out += `  ╚${'═'.repeat(62)}╝\n\n`;
  out += '  Evidence class: ESTIMATED HISTORICAL HEURISTIC\n';
  out += '  Estimated historical unused-read volume is behavioral history, not the runtime blocked-read savings ledger.\n\n';
  out += '  EFFICIENCY SCORE\n';
  out += '  ' + '─'.repeat(54) + '\n';
  out += `  Grade: ${e.grade}  Score: ${e.score}/100\n`;
  out += `  [${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}]\n\n`;
  out += `  Breakdown:\n`;
  out += `    Context Precision .... ${e.breakdown.contextPrecision}/100\n`;
  out += `    Edit Efficiency ...... ${e.breakdown.editEfficiency}/100\n`;
  out += `    Search Accuracy ...... ${e.breakdown.searchAccuracy}/100\n`;
  out += `    Focus Score .......... ${e.breakdown.focusScore}/100\n\n`;
  out += `  STATS (last ${days} days)\n`;
  out += '  ' + '─'.repeat(54) + '\n';
  out += `  Sessions:                                ${sessions.length}\n`;
  out += `  Estimated historical read volume:        ${formatTokens(m.totalReadVolume)}\n`;
  out += `  Estimated historical unused-read volume: ${formatTokens(m.unusedReadVolume)} (${m.unusedPct.toFixed(1)}%)\n`;
  out += `  Reads / edits / searches:                 ${m.reads} / ${m.edits} / ${m.searches}\n`;
  out += `  Failed tool calls:                        ${m.failures}\n\n`;
  out += '  Interpretation: this digest describes historical optimization opportunity.\n';
  out += '  It is not causal KCO savings and not a direct measurement of Kimi subscription quota.\n';
  return out;
}

function main() {
  const days = Math.max(1, parseInt(process.argv[2], 10) || 7);
  const sessions = loadRecentSessions(days);
  console.log(renderDigest(sessions, days));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[kco] digest error: ${e.message}`); process.exit(0); }
}

export { loadRecentSessions, calculateEfficiencyScore, renderDigest };
