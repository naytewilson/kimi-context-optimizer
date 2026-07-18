#!/usr/bin/env node

/**
 * KCO Weekly/Daily Digest Generator (/kco-digest).
 *
 * Aggregates session data over a time period and generates
 * a comprehensive digest with trends, insights, and an efficiency score.
 *
 * Port notes (vs the original claude-context-optimizer digest.js):
 *   - TOKENS FIRST: the EST. COST table (per-Claude-model $) is replaced by a
 *     single cost row shown only when pricing is configured.
 *   - Naming: KCO, Kimi, AGENTS.md, /kco-* commands.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  SESSIONS_DIR, formatTokens, computeUsefulness,
  getDonationMessage, isMainModule, getPricing, computeCost, formatCost,
} from './utils.js';

function getSessionsInRange(days) {
  if (!existsSync(SESSIONS_DIR)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const sessions = [];

  for (const f of files) {
    try {
      const session = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8'));
      // Skip empty sessions
      if (!session.files || Object.keys(session.files).length === 0) continue;
      const sessionDate = new Date(session.updatedAt || session.startedAt);
      if (sessionDate >= cutoff) {
        sessions.push(session);
      }
    } catch {
      // skip corrupt files
    }
  }

  return sessions.sort((a, b) =>
    new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );
}

function calculateEfficiencyScore(sessions) {
  if (sessions.length === 0) return { score: 0, grade: '-', breakdown: {} };

  let totalTokens = 0;
  let wastedTokens = 0;
  let totalReads = 0;
  let totalEdits = 0;
  let totalSearches = 0;
  let reReads = 0;

  for (const session of sessions) {
    for (const [, fileData] of Object.entries(session.files || {})) {
      const tokens = (fileData.estTokens || 0) * (fileData.reads || 1);
      totalTokens += tokens;

      // Use consistent usefulness scoring
      const usefulness = computeUsefulness(fileData);
      if (usefulness <= 0 && (fileData.reads || 0) >= 1) {
        wastedTokens += tokens;
      }

      if (fileData.reads > 2 && !fileData.wasEdited) {
        reReads += fileData.reads - 1;
      }

      totalReads += fileData.reads || 0;
      totalEdits += fileData.edits || 0;
    }
    totalSearches += session.totalSearches || 0;
  }

  const wasteScore = totalTokens > 0 ?
    Math.max(0, 100 - Math.round((wastedTokens / totalTokens) * 100)) : 100;

  const editRatio = totalReads > 0 ? totalEdits / totalReads : 0;
  const editScore = Math.min(100, Math.round(editRatio * 200));

  const searchEfficiency = totalSearches > 0 && totalReads > 0 ?
    Math.min(100, Math.round((1 - totalSearches / (totalSearches + totalReads)) * 100)) : 80;

  const reReadPenalty = totalReads > 0 ?
    Math.max(0, 100 - Math.round((reReads / totalReads) * 100)) : 100;

  const score = Math.round(
    wasteScore * 0.40 +
    editScore * 0.25 +
    searchEfficiency * 0.15 +
    reReadPenalty * 0.20
  );

  let grade;
  if (score >= 90) grade = 'S';
  else if (score >= 80) grade = 'A';
  else if (score >= 70) grade = 'B';
  else if (score >= 55) grade = 'C';
  else if (score >= 40) grade = 'D';
  else grade = 'F';

  return {
    score,
    grade,
    breakdown: { wasteScore, editScore, searchEfficiency, reReadPenalty },
    stats: { totalTokens, wastedTokens, totalReads, totalEdits, totalSearches, sessions: sessions.length }
  };
}

function generateDigest(days) {
  const sessions = getSessionsInRange(days);
  const efficiency = calculateEfficiencyScore(sessions);
  const period = days === 1 ? 'DAILY' : days === 7 ? 'WEEKLY' : `${days}-DAY`;

  let output = '\n';
  output += `  ╔${'═'.repeat(62)}╗\n`;
  output += `  ║            KCO ${period} CONTEXT EFFICIENCY DIGEST              ║\n`;
  output += `  ╚${'═'.repeat(62)}╝\n\n`;

  if (sessions.length === 0) {
    output += '  No sessions in this period yet. Just use Kimi Code and data appears here automatically!\n';
    console.log(output);
    return;
  }

  const scoreBar = '█'.repeat(Math.round(efficiency.score / 2.5)) +
                   '░'.repeat(40 - Math.round(efficiency.score / 2.5));

  output += `  EFFICIENCY SCORE\n`;
  output += `  ${'─'.repeat(54)}\n`;
  output += `  Grade: ${efficiency.grade}  Score: ${efficiency.score}/100\n`;
  output += `  [${scoreBar}]\n\n`;

  output += `  Breakdown:\n`;
  output += `    Context Precision .... ${efficiency.breakdown.wasteScore}/100  (${efficiency.breakdown.wasteScore >= 70 ? 'good' : 'needs work'})\n`;
  output += `    Edit Efficiency ...... ${efficiency.breakdown.editScore}/100  (${efficiency.breakdown.editScore >= 50 ? 'good' : 'low edits vs reads'})\n`;
  output += `    Search Accuracy ...... ${efficiency.breakdown.searchEfficiency}/100\n`;
  output += `    Focus Score .......... ${efficiency.breakdown.reReadPenalty}/100  (${efficiency.breakdown.reReadPenalty >= 70 ? 'focused' : 'too much re-reading'})\n\n`;

  output += `  STATS (last ${days} days)\n`;
  output += `  ${'─'.repeat(54)}\n`;
  output += `  Sessions:         ${efficiency.stats.sessions}\n`;
  output += `  Total tokens:     ${formatTokens(efficiency.stats.totalTokens)}\n`;
  output += `  Wasted tokens:    ${formatTokens(efficiency.stats.wastedTokens)}\n`;
  output += `  Files read:       ${efficiency.stats.totalReads}\n`;
  output += `  Files edited:     ${efficiency.stats.totalEdits}\n`;
  output += `  Searches:         ${efficiency.stats.totalSearches}\n`;

  // $ only when the user configured pricing — tokens are the headline.
  const pricing = getPricing();
  if (pricing.input !== null) {
    output += `\n  EST. COST (from your configured pricing)\n`;
    output += `  ${'─'.repeat(54)}\n`;
    const total = computeCost(efficiency.stats.totalTokens, 'input');
    const wasted = computeCost(efficiency.stats.wastedTokens, 'input');
    output += `  Total: ${formatCost(total)}   Wasted: ${formatCost(wasted)}   Saveable: ${formatCost(wasted)}  (at $${pricing.input}/1M input tokens)\n`;
  }

  if (sessions.length > 1) {
    output += `\n  SESSION BREAKDOWN\n`;
    output += `  ${'─'.repeat(54)}\n`;
    output += `  #   Date          Files  Edits  Tokens    Waste\n`;

    sessions.forEach((s, i) => {
      const date = new Date(s.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const fileCount = Object.keys(s.files || {}).length;
      const totalTok = Object.values(s.files || {}).reduce((sum, f) =>
        sum + (f.estTokens || 0) * (f.reads || 1), 0);
      const wasteTok = Object.values(s.files || {}).reduce((sum, f) => {
        const u = computeUsefulness(f);
        return u <= 0 ? sum + (f.estTokens || 0) * (f.reads || 1) : sum;
      }, 0);
      const wastePct = totalTok > 0 ? Math.round((wasteTok / totalTok) * 100) : 0;

      output += `  ${String(i + 1).padStart(2)}  ${date.padEnd(12)}  ${String(fileCount).padStart(5)}  ${String(s.totalEdits || 0).padStart(5)}  ${formatTokens(totalTok).padStart(8)}  ${String(wastePct).padStart(4)}%\n`;
    });
  }

  output += `\n  TIPS\n`;
  output += `  ${'─'.repeat(54)}\n`;

  if (efficiency.score >= 80) {
    output += `  You're a context efficiency master! Keep it up.\n`;
  } else {
    if (efficiency.breakdown.wasteScore < 70) {
      output += `  - Some files were read but never used. Try Grep first to pinpoint\n`;
      output += `    what you need, then Read only that.\n`;
    }
    if (efficiency.breakdown.editScore < 40) {
      output += `  - Lots of reading, not much editing. Give Kimi a precise task\n`;
      output += `    description so it reads fewer files.\n`;
    }
    if (efficiency.breakdown.reReadPenalty < 60) {
      output += `  - Files getting re-read a lot. Add key facts to AGENTS.md so they\n`;
      output += `    stay in context, or go easy on /compact.\n`;
    }
  }

  output += getDonationMessage();
  output += '\n';
  console.log(output);
}

function main() {
  const days = parseInt(process.argv[2]) || 7;
  generateDigest(days);
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[kco] digest error: ${e.message}`); process.exit(0); }
}

// Exposed for tests
export { getSessionsInRange, calculateEfficiencyScore };
