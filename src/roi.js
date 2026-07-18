#!/usr/bin/env node

/**
 * KCO ROI Calculator — monthly savings from real session data (/kco-roi).
 *
 * Port notes (vs the original claude-context-optimizer roi.js):
 *   - The per-Claude-model $ table is replaced by a per-Kimi-model-alias
 *     table built from REAL data: each session's model comes from the budget
 *     hook's state (which reads it from wire.jsonl), savings are tokens and
 *     % of the context window preserved. A $ column is appended only when
 *     pricing is configured.
 *   - Kimi Code is a subscription CLI: the headline is tokens saved and
 *     effective context-window multiplier, not dollars.
 */

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  SESSIONS_DIR, BUDGET_STATE_DIR,
  formatTokens, loadJSON, ensureDataDirs, isMainModule,
  getPricing, computeCost, formatCost,
} from './utils.js';
import { getActiveModel } from './kimi-config.js';

ensureDataDirs();

function loadRecentSessions(days = 30) {
  if (!existsSync(SESSIONS_DIR)) return [];
  const cutoff = Date.now() - days * 86400000;
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const sessions = [];
  for (const f of files) {
    const data = loadJSON(join(SESSIONS_DIR, f));
    if (!data) continue;
    const ts = new Date(data.startedAt || 0).getTime();
    if (ts >= cutoff) sessions.push(data);
  }
  return sessions;
}

/** The model a session actually ran on (budget hook state, from wire.jsonl). */
function modelForSession(sessionId, fallback) {
  const state = sessionId ? loadJSON(join(BUDGET_STATE_DIR, `${sessionId}.json`)) : null;
  return (state && state.model) || fallback;
}

function analyzeWaste(sessions) {
  let totalTokens = 0;
  let wastedTokens = 0;
  let totalFiles = 0;
  let wastedFiles = 0;

  for (const s of sessions) {
    for (const [, fd] of Object.entries(s.files || {})) {
      const tokens = (fd.estTokens || 0) * Math.max(1, fd.reads || 1);
      totalTokens += tokens;
      totalFiles++;
      const useful = (fd.edits || 0) > 0 || (fd.partialReads || 0) > 0 || fd.wasEdited;
      if (!useful && (fd.reads || 0) >= 1) {
        wastedTokens += tokens;
        wastedFiles++;
      }
    }
  }
  return { totalTokens, wastedTokens, totalFiles, wastedFiles };
}

/**
 * Group sessions by the model alias they ran on and compute per-model
 * savings. Returns [{ model, sessions, wastePercent, avgTokens,
 * savedPerSession }].
 */
function buildModelTable(sessions, fallbackModel) {
  const groups = new Map();
  for (const s of sessions) {
    const model = modelForSession(s.id, fallbackModel);
    if (!groups.has(model)) groups.set(model, []);
    groups.get(model).push(s);
  }
  const rows = [];
  for (const [model, group] of groups) {
    const { totalTokens, wastedTokens } = analyzeWaste(group);
    const wastePercent = totalTokens > 0 ? (wastedTokens / totalTokens) * 100 : 0;
    const avgTokens = group.length > 0 ? totalTokens / group.length : 0;
    rows.push({
      model,
      sessions: group.length,
      wastePercent,
      avgTokens: Math.round(avgTokens),
      savedPerSession: Math.round(avgTokens * (wastePercent / 100)),
    });
  }
  rows.sort((a, b) => b.savedPerSession - a.savedPerSession);
  return rows;
}

function formatROIReport(sessions, sessionsPerDay) {
  const activeModel = getActiveModel();
  const contextWindow = activeModel.maxContextSize;
  const fallbackModel = activeModel.model || activeModel.alias || 'kimi';
  const pricing = getPricing();
  const priced = pricing.input !== null;

  const lines = [];
  lines.push('');
  lines.push('  ╔══════════════════════════════════════════════════════════════╗');
  lines.push('  ║              KCO — Return on Investment Report              ║');
  lines.push('  ╚══════════════════════════════════════════════════════════════╝');
  lines.push('');

  let wastePercent, avgTokens, dataSource;

  if (sessions.length > 0) {
    const { totalTokens, wastedTokens } = analyzeWaste(sessions);
    wastePercent = totalTokens > 0 ? (wastedTokens / totalTokens) * 100 : 35;
    avgTokens = totalTokens / sessions.length;
    dataSource = `${sessions.length} sessions (last 30 days)`;
  } else {
    wastePercent = 35;
    avgTokens = 80000;
    dataSource = 'Industry estimate (no local data yet)';
  }

  lines.push(`  Data source: ${dataSource}`);
  lines.push(`  Average waste: ${wastePercent.toFixed(1)}%`);
  lines.push(`  Avg tokens/session: ${formatTokens(Math.round(avgTokens))}`);
  lines.push(`  Sessions/day: ${sessionsPerDay}`);
  lines.push('');

  // Savings overview — tokens first
  const savedTokensPerSession = Math.round(avgTokens * (wastePercent / 100));
  const monthlyTokens = savedTokensPerSession * sessionsPerDay * 30;
  lines.push('  ── What KCO Saves You (tokens) ──────────────────────────────');
  lines.push(`  Per session:   ~${formatTokens(savedTokensPerSession)} tokens blocked/deduplicated`);
  lines.push(`  Per day:       ~${formatTokens(savedTokensPerSession * sessionsPerDay)} tokens`);
  lines.push(`  Per month:     ~${formatTokens(monthlyTokens)} tokens`);
  lines.push(`  Window preserved per session: ${((savedTokensPerSession / contextWindow) * 100).toFixed(1)}% of the ${formatTokens(contextWindow)} context window`);
  lines.push('');

  // Per-model table — real aliases from session wire data
  const modelRows = sessions.length > 0
    ? buildModelTable(sessions, fallbackModel)
    : [{ model: fallbackModel, sessions: 0, wastePercent, avgTokens: Math.round(avgTokens), savedPerSession: savedTokensPerSession }];

  lines.push('  ── Monthly Savings by Model ─────────────────────────────────');
  lines.push('');
  const header = priced
    ? '  Model           Sess  Waste%   Tok/sess   Saved/mo   $/mo'
    : '  Model           Sess  Waste%   Tok/sess   Saved/mo';
  lines.push(header);
  lines.push('  ' + '─'.repeat(header.length - 2));
  for (const row of modelRows) {
    const perMonth = row.savedPerSession * sessionsPerDay * 30;
    let line = `  ${row.model.padEnd(15)} ${String(row.sessions).padStart(4)}  ${row.wastePercent.toFixed(1).padStart(6)}%  ${formatTokens(row.avgTokens).padStart(9)}  ${formatTokens(perMonth).padStart(9)}`;
    if (priced) {
      line += `  ${formatCost(computeCost(perMonth, 'input')) || '—'}`;
    }
    lines.push(line);
  }
  lines.push('');

  // Context budget multiplier — against the REAL active window
  const multiplier = (1 / (1 - Math.min(99, wastePercent) / 100)).toFixed(1);
  lines.push('  ── Effective Context Multiplier ─────────────────────────────');
  lines.push(`  KCO makes your context window ${multiplier}x more effective`);
  lines.push(`  ${formatTokens(contextWindow)} context → effectively ${formatTokens(Math.round(contextWindow * parseFloat(multiplier)))} of useful context`);
  lines.push('');

  if (priced) {
    lines.push('  ── Cost Appendix (from your configured pricing) ─────────────');
    const monthlyDollars = formatCost(computeCost(monthlyTokens, 'input'));
    const yearlyDollars = formatCost(computeCost(monthlyTokens * 12, 'input'));
    lines.push(`  Monthly: ${monthlyDollars}   Yearly: ${yearlyDollars}  (at $${pricing.input}/1M input tokens)`);
    lines.push('');
  } else {
    lines.push('  Tip: set pricePerMillionInput/Output in config.json to see $ figures.');
    lines.push('');
  }

  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const sessionsPerDay = parseInt(args[0]) || 5;
  const sessions = loadRecentSessions(30);
  console.log(formatROIReport(sessions, sessionsPerDay));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[kco] roi error: ${e.message}`); process.exit(0); }
}

// Exposed for tests
export { analyzeWaste, buildModelTable, formatROIReport };
