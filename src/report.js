#!/usr/bin/env node

/**
 * KCO Report Generator — full token ROI report across sessions (/kco-report).
 *
 * Port notes (vs the original claude-context-optimizer report.js):
 *   - TOKENS FIRST: the report leads with tokens and waste %. The per-model
 *     $ table is gone — Kimi Code is a subscription CLI with no per-token
 *     billing. A $ appendix appears only when the user configured
 *     pricePerMillionInput in config.json.
 *   - AGENTS.md (not CLAUDE.md) in recommendations; /kco-* commands.
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import {
  SESSIONS_DIR, GLOBAL_STATS_FILE,
  formatTokens, loadJSON, isMainModule, getPricing, computeCost, formatCost,
} from './utils.js';

function generateFullReport() {
  const stats = loadJSON(GLOBAL_STATS_FILE);

  if (!stats || stats.totalSessions === 0) {
    console.log('No data yet — just use Kimi Code normally and tracking starts automatically!');
    return;
  }

  let report = '';

  report += '\n';
  report += `  ╔${'═'.repeat(62)}╗\n`;
  report += '  ║            KCO — TOKEN ROI REPORT (all sessions)           ║\n';
  report += `  ╚${'═'.repeat(62)}╝\n\n`;

  report += '  OVERVIEW\n';
  report += '  ' + '─'.repeat(50) + '\n';
  report += `  Total sessions tracked:     ${stats.totalSessions}\n`;
  report += `  Total tokens tracked:       ${formatTokens(stats.totalTokensTracked)}\n`;
  report += `  Estimated tokens wasted:    ${formatTokens(stats.estimatedTokensSaved)}\n`;
  report += `  Avg tokens per session:     ${formatTokens(stats.avgTokensPerSession)}\n`;
  report += `  Total files read:           ${stats.totalFilesRead}\n`;
  report += `  Total files edited:         ${stats.totalFilesEdited}\n`;

  const overallWaste = stats.totalTokensTracked > 0 ?
    Math.round((stats.estimatedTokensSaved / stats.totalTokensTracked) * 100) : 0;
  report += `  Overall waste ratio:        ${overallWaste}%\n`;
  report += '\n';

  if (stats.sessionHistory && stats.sessionHistory.length > 1) {
    // Filter out empty sessions from display
    const nonEmpty = stats.sessionHistory.filter(s => s.tokensTotal > 0);

    if (nonEmpty.length > 0) {
      report += '  RECENT SESSIONS\n';
      report += '  ' + '─'.repeat(50) + '\n';
      report += '  Date                Files  Reads  Edits  Waste%\n';

      for (const s of nonEmpty.slice(-10)) {
        const date = new Date(s.date).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        report += `  ${date.padEnd(20)} ${String(s.filesRead).padStart(5)}  ${String(s.totalReads).padStart(5)}  ${String(s.totalEdits).padStart(5)}  ${String(s.wastePercent).padStart(5)}%\n`;
      }
      report += '\n';

      // Trend analysis
      const recent5 = nonEmpty.slice(-5);
      const older5 = nonEmpty.slice(-10, -5);
      if (older5.length > 0) {
        const recentAvgWaste = recent5.reduce((s, x) => s + x.wastePercent, 0) / recent5.length;
        const olderAvgWaste = older5.reduce((s, x) => s + x.wastePercent, 0) / older5.length;
        const trend = recentAvgWaste < olderAvgWaste ? 'IMPROVING' :
                      recentAvgWaste > olderAvgWaste ? 'WORSENING' : 'STABLE';
        const icon = trend === 'IMPROVING' ? '↓' : trend === 'WORSENING' ? '↑' : '→';
        report += `  Waste trend: ${icon} ${trend} (${Math.round(olderAvgWaste)}% -> ${Math.round(recentAvgWaste)}%)\n\n`;
      }
    }
  }

  if (stats.topWastedFiles && stats.topWastedFiles.length > 0) {
    report += '  FILES TO SKIP NEXT TIME (read but never used)\n';
    report += '  ' + '─'.repeat(50) + '\n';

    for (const f of stats.topWastedFiles.slice(0, 10)) {
      report += `  ⚠ ${basename(f.fullPath).padEnd(30)} ${formatTokens(f.totalTokensWasted).padStart(6)} tokens wasted across ${f.sessions} sessions\n`;
    }
    report += '\n';
  }

  if (stats.topUsefulFiles && stats.topUsefulFiles.length > 0) {
    report += '  TOP USEFUL FILES (frequently edited)\n';
    report += '  ' + '─'.repeat(50) + '\n';

    for (const f of stats.topUsefulFiles.slice(0, 10)) {
      report += `  ✔ ${basename(f.fullPath).padEnd(30)} ${String(f.totalEdits).padStart(3)} edits, ${String(f.totalReads).padStart(3)} reads across ${f.sessions} sessions\n`;
    }
    report += '\n';
  }

  // ── Optional $ appendix — only when pricing is configured ──
  const pricing = getPricing();
  if (pricing.input !== null && stats.estimatedTokensSaved > 0) {
    report += '  COST APPENDIX (from your configured pricing)\n';
    report += '  ' + '─'.repeat(50) + '\n';
    report += `  Configured input rate:      $${pricing.input}/1M tokens\n`;
    report += `  Est. saveable (${formatTokens(stats.estimatedTokensSaved)}):  ${formatCost(computeCost(stats.estimatedTokensSaved, 'input'))}\n`;
    report += '\n';
  }

  report += '  RECOMMENDATIONS\n';
  report += '  ' + '─'.repeat(50) + '\n';

  if (overallWaste > 40) {
    report += '  Room to improve! Try:\n';
    report += '      - Use Grep/Glob to find specific files before reading\n';
    report += '      - Read only relevant sections with offset/limit\n';
    report += '      - Use the Agent tool for exploratory searches\n';
  } else if (overallWaste > 20) {
    report += '  Not bad! Save more by:\n';
    report += '      - Avoiding reading large config files fully\n';
    report += '      - Using /compact when switching tasks\n';
    report += '      - Moving stable reference info into AGENTS.md\n';
  } else {
    report += '  You\'re a context pro — tokens well spent!\n';
  }

  if (stats.avgTokensPerSession > 80000) {
    report += '  Large sessions detected — try splitting big tasks into focused sub-sessions.\n';
  }

  report += '\n';
  console.log(report);
}

function generateSessionList() {
  if (!existsSync(SESSIONS_DIR)) {
    console.log('No sessions yet — start using Kimi Code and tracking begins automatically!');
    return;
  }

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-20);

  console.log('\nRecent sessions:');
  for (const f of files) {
    const session = loadJSON(join(SESSIONS_DIR, f));
    if (session) {
      const fileCount = Object.keys(session.files || {}).length;
      if (fileCount === 0) continue; // Skip empty sessions
      console.log(`  ${session.id.substring(0, 12)}  ${session.startedAt || 'unknown'}  ${fileCount} files  ${session.totalEdits} edits`);
    }
  }
}

function main() {
  const action = process.argv[2] || 'full';

  switch (action) {
    case 'full':
      generateFullReport();
      break;
    case 'sessions':
      generateSessionList();
      break;
    default:
      console.log('Usage: kco-report [full|sessions]');
  }
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[kco] report error: ${e.message}`); process.exit(0); }
}
