#!/usr/bin/env node

/**
 * KCO cross-session historical context report (/kco-report).
 *
 * `global-stats.json` is tracker-derived history. Its legacy field
 * `estimatedTokensSaved` is interpreted here as estimated historical
 * unused-read volume, never as the runtime blocked-read savings ledger.
 */

import { basename } from 'path';
import {
  GLOBAL_STATS_FILE, formatTokens, loadJSON, isMainModule,
  getPricing, computeCost, formatCost,
} from './utils.js';

function generateReport(stats) {
  if (!stats || stats.totalSessions === 0) {
    return '\n  No session data yet. Use Kimi Code normally, then run /kco-report.\n';
  }

  const total = stats.totalTokensTracked || 0;
  const historicalUnused = stats.estimatedTokensSaved || 0;
  const ratio = total > 0 ? Math.min(100, Math.round((historicalUnused / total) * 100)) : 0;
  const avg = stats.avgTokensPerSession || (stats.totalSessions ? total / stats.totalSessions : 0);

  let out = '\n';
  out += `  ╔${'═'.repeat(62)}╗\n`;
  out += '  ║        KCO — HISTORICAL CONTEXT OPPORTUNITY REPORT          ║\n';
  out += `  ╚${'═'.repeat(62)}╝\n\n`;
  out += '  Evidence class: ESTIMATED HISTORICAL HEURISTIC\n';
  out += '  This report uses tracker history, not the runtime blocked-read savings ledger.\n\n';
  out += '  OVERVIEW\n';
  out += '  ' + '─'.repeat(56) + '\n';
  out += `  Sessions tracked:                         ${stats.totalSessions}\n`;
  out += `  Total tracked token volume:               ${formatTokens(total)}\n`;
  out += `  Estimated historical unused-read volume:  ${formatTokens(historicalUnused)}\n`;
  out += `  Historical unused-read ratio:              ${ratio}%\n`;
  out += `  Avg tracked tokens/session:                ${formatTokens(avg)}\n`;
  out += `  Files read / edited:                       ${stats.totalFilesRead || 0} / ${stats.totalFilesEdited || 0}\n`;

  if (stats.topWastedFiles && stats.topWastedFiles.length) {
    out += '\n  TOP HISTORICAL UNUSED-READ FILES\n';
    out += '  ' + '─'.repeat(56) + '\n';
    for (const f of stats.topWastedFiles.slice(0, 10)) {
      out += `  ${basename(f.fullPath || f.path || 'unknown').padEnd(30)} ~${formatTokens(f.totalTokensWasted || 0)} estimated historical unused-read volume across ${f.sessions || 0} session(s)\n`;
    }
  }

  if (stats.topUsefulFiles && stats.topUsefulFiles.length) {
    out += '\n  TOP HISTORICALLY USEFUL FILES\n';
    out += '  ' + '─'.repeat(56) + '\n';
    for (const f of stats.topUsefulFiles.slice(0, 10)) {
      out += `  ${basename(f.fullPath || f.path || 'unknown').padEnd(30)} ${f.totalEdits || 0} edits · ${f.totalReads || 0} reads · ${f.sessions || 0} session(s)\n`;
    }
  }

  out += '\n  INTERPRETATION\n';
  out += '  ' + '─'.repeat(56) + '\n';
  out += '  Estimated historical avoidable-read volume is an optimization-opportunity heuristic.\n';
  out += '  It is not a direct measurement of Kimi subscription quota and is not causal KCO savings.\n';
  out += '  Use /kco for the separate runtime counterfactual ledger with KCO overhead subtraction.\n';

  const pricing = getPricing();
  if (pricing.input !== null || pricing.output !== null) {
    out += '\n  COST APPENDIX — USER-CONFIGURED RATE ONLY\n';
    out += '  ' + '─'.repeat(56) + '\n';
    const trackedCost = formatCost(computeCost(total, 'input'));
    const unusedCost = formatCost(computeCost(historicalUnused, 'input'));
    if (trackedCost) out += `  Tracked input-volume value at configured rate: ~${trackedCost}\n`;
    if (unusedCost) out += `  Historical unused-read volume at configured rate: ~${unusedCost}\n`;
    out += '  These are configured-rate estimates, not authoritative Kimi subscription billing.\n';
  }
  out += '\n';
  return out;
}

function main() {
  const mode = process.argv[2] || 'full';
  const stats = loadJSON(GLOBAL_STATS_FILE);
  if (mode !== 'full') {
    console.log(generateReport(stats));
    return;
  }
  console.log(generateReport(stats));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[kco] report error: ${e.message}`); process.exit(0); }
}

export { generateReport };
