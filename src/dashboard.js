#!/usr/bin/env node

/**
 * KCO Context Board — the one-screen flagship (/kco) + SessionEnd summary.
 *
 * Aggregates everything the optimizer already tracks into a single view:
 *   • Context  — REAL tokens in the context window (wire.jsonl ground truth)
 *   • Saved    — tokens the Read Cache blocked, NET of KCO's own notices
 *   • Cache    — real prompt-cache hit rate + cache breaks this session
 *   • Files    — loaded / cold (read, never edited) / wasted reads
 *   • Health   — failed tool calls, subagent delegations
 *   • Prompt   — grade of your last prompt (from Prompt Coach)
 *   • Actions  — ready-to-run next steps (compact / coach)
 *
 * Two render modes:
 *   node dashboard.js            → the live board
 *   node dashboard.js summary    → the session-end "KCO saved you N tokens"
 *                                  report (wired to SessionEnd in the manifest)
 *
 * Port notes (vs the original claude-context-optimizer dashboard.js):
 *   - TOKENS FIRST. Kimi Code is a subscription CLI — the headline metric is
 *     tokens and % of the context window, not dollars. $ figures appear ONLY
 *     when the user configured pricePerMillion{Input,Output} in config.json
 *     (computeCost/formatCost return null otherwise).
 *   - Cache economics come from wire.jsonl via getSessionUsage() — the real
 *     hit rate and cache-read totals — with NO Anthropic 0.1x/1.25x billing
 *     math. Cache value is expressed as "tokens that didn't occupy fresh
 *     context"; cache breaks come from the budget hook's cacheBreaks counter.
 *   - The tasks module is not ported — the Tasks section is dropped.
 *   - Pure aggregation: only READS existing data files, never blocks/mutates.
 */

import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  SESSIONS_DIR, BUDGET_STATE_DIR, READ_CACHE_DIR, PROMPTS_DIR,
  loadJSON, loadConfig, getEffectiveBudget, formatTokens, displayPath,
  getLatestSessionId, isMainModule, computeCost, formatCost,
  updateCalibrationFromSession,
} from './utils.js';
import { loadLedger } from './notices.js';
import { getSessionUsage } from './wire-usage.js';
import { getActiveModel } from './kimi-config.js';

// ── Data gathering ──────────────────────────────────────────────────────────

function lastPromptGrade(sessionId) {
  try {
    const file = join(PROMPTS_DIR, `${sessionId}.jsonl`);
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return { grade: last.grade, score: last.score, suggestions: last.suggestions || [] };
  } catch { return null; }
}

export function gather(sessionId, cwd = process.cwd()) {
  const config = loadConfig();
  const activeModel = getActiveModel();
  const contextWindow = activeModel.maxContextSize;
  const effectiveBudget = getEffectiveBudget(config);

  const session = sessionId ? loadJSON(join(SESSIONS_DIR, `${sessionId}.json`)) : null;
  const budget = sessionId ? loadJSON(join(BUDGET_STATE_DIR, `${sessionId}.json`)) : null;
  const cache = sessionId ? loadJSON(join(READ_CACHE_DIR, `${sessionId}.json`)) : null;

  // GROUND TRUTH from the session wire transcript (exact per-step API usage).
  // Falls back to the budget hook's stored realContextTokens, then to the
  // chars-per-token estimate.
  const real = sessionId ? getSessionUsage(sessionId, cwd) : null;
  const used = (real && real.contextTokens)
    || (budget && budget.realContextTokens)
    || (budget && budget.totalTokensEstimated)
    || 0;
  const inTok = (real && (real.totalInput + real.totalCacheRead + real.totalCacheCreation))
    || (budget && budget.inputTokensEstimated) || 0;
  const outTok = (real && real.totalOutput)
    || (budget && budget.outputTokensEstimated) || 0;

  // The session's REAL model (from the wire / budget hook) beats the static
  // config — window and labels follow it.
  const model = (real && real.model)
    || (budget && budget.model)
    || activeModel.model || activeModel.alias || config.model;

  // Cache economics — REAL data, token-denominated. totalCacheRead = tokens
  // served from the prompt cache instead of occupying fresh context. Breaks
  // are counted by the budget hook (>5 min pause with a warm context).
  let cacheEcon = null;
  if (real && (real.totalCacheRead > 0 || real.totalInput > 0)) {
    const breaks = (budget && budget.cacheBreaks) || 0;
    cacheEcon = {
      hitPct: Math.round((real.cacheHitRate || 0) * 100),
      cacheReadTokens: real.totalCacheRead,
      steps: real.steps,
      breaks,
      // What the cached tokens would have cost as fresh input — null unless
      // the user configured pricing.
      dollars: computeCost(real.totalCacheRead, 'input'),
    };
  }

  // Optional $ for the session itself (estimates in, real out when wired).
  const inDollars = computeCost(inTok, 'input');
  const outDollars = computeCost(outTok, 'output');
  const dollars = (inDollars === null && outDollars === null)
    ? null : (inDollars || 0) + (outDollars || 0);

  const savedGross = (cache && cache.totalTokensSaved) || 0;
  const blocked = (cache && cache.blockedReads) || 0;
  // NET savings — subtract the tokens KCO's own notices injected into context
  // this session. This is the honest number: what KCO saved minus what KCO
  // cost. If it's ever negative, the optimizer is net-negative.
  const overhead = sessionId ? (loadLedger(sessionId).tokensInjected || 0) : 0;
  const saved = Math.max(0, savedGross - overhead);
  const multiplier = used > 0 ? (used + saved) / used : 1;

  // Cold / droppable context: files read but never edited (mirrors the budget
  // hook's compact recommendation). These are the safe-to-drop candidates.
  const cold = [];
  const useful = [];
  let totalReads = 0;
  let totalEdits = 0;
  let wastedReads = 0;
  if (session && session.files) {
    for (const [path, f] of Object.entries(session.files)) {
      const tokens = (f.estTokens || 0) * Math.max(1, f.reads || 1);
      totalReads += f.reads || 0;
      totalEdits += f.edits || 0;
      if (f.edits > 0 || f.wasEdited) {
        useful.push({ path, tokens: f.estTokens || 0, edits: f.edits || 0 });
      } else if ((f.reads || 0) >= 1) {
        cold.push({ path, tokens, reads: f.reads || 0 });
        wastedReads += f.reads || 0;
      }
    }
  }
  cold.sort((a, b) => b.tokens - a.tokens);
  useful.sort((a, b) => b.edits - a.edits);
  const reclaimable = cold.reduce((s, c) => s + c.tokens, 0);
  const wastePct = used > 0 ? Math.min(100, Math.round((reclaimable / used) * 100)) : 0;

  const failedCalls = (session && session.failedCalls) || 0;
  const delegations = (session && session.delegations) || 0;
  const prompt = sessionId ? lastPromptGrade(sessionId) : null;

  return {
    model, contextWindow, effectiveBudget,
    used, inTok, outTok, dollars, cacheEcon,
    saved, savedGross, overhead, blocked, multiplier,
    filesLoaded: cold.length + useful.length,
    totalReads, totalEdits, wastedReads,
    cold, useful, reclaimable, wastePct,
    failedCalls, delegations, prompt,
    hasData: !!(session || budget || cache || (real && real.steps > 0)),
  };
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function bar(pct, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtModelWindow(d) {
  const w = d.contextWindow >= 1e6 ? `${(d.contextWindow / 1e6).toFixed(1)}M`
    : `${Math.round(d.contextWindow / 1000)}K`;
  return `${d.model} · ${w}`;
}

// ── Board ───────────────────────────────────────────────────────────────────

export function renderBoard(d) {
  if (!d.hasData) {
    return [
      '  KCO CONTEXT BOARD',
      '  ───────────────────────────────────────────────',
      '  No session data yet. Keep working — reads, edits,',
      '  prompts and cache savings are tracked automatically.',
      '  Then run /kco again to see your live board.',
    ].join('\n');
  }

  const L = [];
  const pct = d.effectiveBudget > 0 ? Math.round((d.used / d.effectiveBudget) * 100) : 0;
  L.push(`  KCO CONTEXT BOARD               ${fmtModelWindow(d)}`);
  L.push('  ────────────────────────────────────────────────────────────');

  let budgetLine = `  Context  ${bar(pct)}  ${formatTokens(d.used)} / ${formatTokens(d.effectiveBudget)}  (${pct}% of window)`;
  if (d.dollars !== null) budgetLine += `  ${formatCost(d.dollars)}`;
  L.push(budgetLine);

  if (d.saved > 0) {
    const ov = d.overhead > 0 ? `  (gross ${formatTokens(d.savedGross)} − KCO ${formatTokens(d.overhead)})` : '';
    L.push(`  Saved    +${formatTokens(d.saved)} net  →  ${d.multiplier.toFixed(2)}x effective` +
      (d.blocked ? `  ·  ${d.blocked} reads blocked` : '') + ov);
  } else if (d.savedGross > 0) {
    L.push(`  Saved    net ~0  (cache saved ${formatTokens(d.savedGross)}, KCO notices cost ${formatTokens(d.overhead)})`);
  } else {
    L.push('  Saved    (cache warming up — savings appear after repeat reads)');
  }

  if (d.cacheEcon) {
    const c = d.cacheEcon;
    let line = `  Cache    ${bar(c.hitPct)}  ${c.hitPct}% hit  ·  ${formatTokens(c.cacheReadTokens)} tokens served from cache`;
    const cacheCost = formatCost(c.dollars);
    if (cacheCost) line += ` (~${cacheCost} of fresh input avoided)`;
    if (c.breaks > 0) line += `  ·  ${c.breaks} cache break${c.breaks === 1 ? '' : 's'}`;
    L.push(line);
  }

  L.push(`  Files    ${d.filesLoaded} loaded  ·  ${d.totalReads} reads  ·  ${d.totalEdits} edits  ·  ${d.wastedReads} wasted reads (${d.cold.length} cold files)`);
  L.push(`  Health   ${d.failedCalls} failed calls  ·  ${d.delegations} delegations  ·  waste ${bar(d.wastePct, 8)} ${d.wastePct}%`);

  if (d.prompt) {
    const hint = d.prompt.suggestions && d.prompt.suggestions.length
      ? `  (${d.prompt.suggestions[0]})` : '';
    L.push(`  Prompt   last grade: ${d.prompt.grade}${hint}`);
  }

  // ── Actions ──
  L.push('  ────────────────────────────────────────────────────────────');
  const actions = buildActions(d);
  if (actions.length) {
    for (const a of actions) L.push(`  ${a}`);
  } else {
    L.push('  ✅ Context is lean — nothing to optimize right now.');
  }

  return L.join('\n');
}

function buildActions(d) {
  const out = [];
  if (d.reclaimable > 3000 && d.cold.length) {
    const top = d.cold.slice(0, 3).map(c => displayPath(c.path, 28)).join(', ');
    out.push(`⚡ Free ~${formatTokens(d.reclaimable)}:  drop ${top}  → /compact`);
  }
  if (d.cacheEcon && d.cacheEcon.breaks > 0) {
    out.push('🧊 Cache broke this session — batch long pauses, or /compact before stepping away');
  }
  if (d.failedCalls >= 3) {
    out.push(`🛠  ${d.failedCalls} failed tool calls — check /kco-replay for what went wrong`);
  }
  if (d.prompt && d.prompt.grade && 'CDF'.includes(d.prompt.grade)) {
    out.push('✍️  Last prompt was vague — /kco-coach can sharpen the next one');
  }
  return out;
}

// ── Session-end summary ───────────────────────────────────────────────────────

export function renderSummary(d) {
  if (!d.hasData || (d.saved === 0 && d.used === 0)) return '';
  const L = [];
  L.push('  ── KCO session summary ───────────────────────────────────────');

  if (d.saved > 0) {
    // Headline: tokens saved as % of what the context WOULD have held without
    // KCO. Tokens-first — this is a subscription CLI, tokens are the currency.
    const wouldHaveHeld = d.used + d.saved;
    const pct = wouldHaveHeld > 0 ? Math.round((d.saved / wouldHaveHeld) * 100) : 0;
    L.push(`  ★ KCO saved ${formatTokens(d.saved)} tokens this session — ${pct}% of what the context would have held.`);
    const ov = d.overhead > 0 ? ` (net of ${formatTokens(d.overhead)} KCO notice overhead)` : '';
    const savedDollars = formatCost(computeCost(d.saved, 'input'));
    L.push(`  ${formatTokens(d.blocked ? d.savedGross : d.saved)} blocked-read tokens${d.blocked ? ` across ${d.blocked} blocked reads` : ''}${ov}` +
      (savedDollars ? ` (~${savedDollars})` : '') + '.');
    L.push(`  Your ${formatTokens(d.effectiveBudget)} context window worked like ${formatTokens(Math.round(d.used + d.saved))} (${d.multiplier.toFixed(2)}x).`);
  } else {
    const cost = formatCost(d.dollars);
    L.push(`  Tracked ${formatTokens(d.used)} tokens this session${cost ? ` (${cost})` : ''}.`);
  }

  if (d.cacheEcon) {
    const c = d.cacheEcon;
    const cacheCost = formatCost(c.dollars);
    L.push(`  Prompt cache: ${c.hitPct}% hit rate — ${formatTokens(c.cacheReadTokens)} tokens served from cache instead of fresh context` +
      (cacheCost ? ` (~${cacheCost} of input avoided)` : '') + '.');
    if (c.breaks > 0) {
      L.push(`  ⚠ Cache broke ${c.breaks}x — warm context had to be re-processed.` +
        ` Common causes: >5 min pauses, editing AGENTS.md mid-session, switching models.`);
    }
  }

  if (d.reclaimable > 3000) {
    L.push(`  Tip: ~${formatTokens(d.reclaimable)} of cold context is still loaded — /compact before the next task.`);
  }
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main() {
  const mode = process.argv[2] || 'board';
  const sessionId = process.argv[3] || getLatestSessionId();
  const d = gather(sessionId);
  if (mode === 'summary') {
    const s = renderSummary(d);
    if (s) console.log(s);
    // Session is over — let ground truth teach the estimator its local drift.
    const budget = sessionId ? loadJSON(join(BUDGET_STATE_DIR, `${sessionId}.json`)) : null;
    if (budget && budget.realContextTokens && budget.totalTokensEstimated) {
      updateCalibrationFromSession(budget.realContextTokens, budget.totalTokensEstimated);
    }
  } else {
    console.log(renderBoard(d));
  }
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (e) { console.error(`[kco] dashboard error: ${e.message}`); process.exit(0); }
}
