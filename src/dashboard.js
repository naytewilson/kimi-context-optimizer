#!/usr/bin/env node

/**
 * KCO Context Board + SessionEnd summary.
 *
 * Evidence classes are kept separate:
 *   OBSERVED: wire context/input/output/cache counters.
 *   ESTIMATED: counterfactual tokens for reads KCO blocked, because those
 *              results never reached Kimi's tokenizer.
 *
 * The dashboard never calls cache-read tokens "saved", never mixes current
 * context size with cumulative-input savings, and never hides negative net
 * savings behind a zero clamp.
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
import { computeSavingsEstimate } from './savings-accounting.js';
import { computeReplayAmplification } from './quota-controller.js';

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
  const real = sessionId ? getSessionUsage(sessionId, cwd) : null;

  // Current context occupancy, distinct from cumulative processed input.
  const used = (real && real.contextTokens)
    || (budget && budget.realContextTokens)
    || (budget && budget.totalTokensEstimated)
    || 0;

  const inTok = (real && real.totalInputSide)
    || (real && (real.totalInput + real.totalCacheRead + real.totalCacheCreation))
    || (budget && budget.inputTokensEstimated)
    || 0;
  const outTok = (real && real.totalOutput)
    || (budget && budget.outputTokensEstimated)
    || 0;

  const model = (real && real.model)
    || (budget && budget.model)
    || activeModel.model || activeModel.alias || config.model;

  // Prompt-cache telemetry is OBSERVED usage. A cache hit can be cheaper/faster
  // than fresh input, but it is still input-side token processing and is NOT
  // counted as KCO blocked-read savings.
  let cacheEcon = null;
  if (real && (real.totalCacheRead > 0 || real.totalInput > 0 || real.totalCacheCreation > 0)) {
    cacheEcon = {
      hitPct: Math.round((real.cacheHitRate || 0) * 100),
      cacheReadTokens: real.totalCacheRead || 0,
      steps: real.steps || 0,
      breaks: (budget && budget.cacheBreaks) || 0,
    };
  }

  // Optional cost display is user-configured and remains secondary. KCO does
  // not infer Moonshot's subscription quota conversion from token counters.
  const inDollars = computeCost(inTok, 'input');
  const outDollars = computeCost(outTok, 'output');
  const dollars = (inDollars === null && outDollars === null)
    ? null : (inDollars || 0) + (outDollars || 0);

  const savedGross = (cache && (
    cache.grossAvoidedReadTokensEstimated ?? cache.totalTokensSaved
  )) || 0;
  const blockOverhead = (cache && cache.blockOverheadTokensEstimated) || 0;
  const blocked = (cache && cache.blockedReads) || 0;
  const overhead = sessionId ? (loadLedger(sessionId).tokensInjected || 0) : 0;
  const savings = computeSavingsEstimate({
    grossAvoidedReadTokensEstimated: savedGross,
    blockOverheadTokensEstimated: blockOverhead,
    noticeOverheadTokensEstimated: overhead,
  });
  const saved = savings.netAvoidedTokensEstimated; // may be negative, intentionally

  const replayAmplification = real && real.steps > 0
    ? computeReplayAmplification(real)
    : null;

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
    used, inTok, outTok, dollars, cacheEcon, replayAmplification,
    saved, savedGross, blockOverhead, overhead, blocked,
    savingsClassification: savings.classification,
    filesLoaded: cold.length + useful.length,
    totalReads, totalEdits, wastedReads,
    cold, useful, reclaimable, wastePct,
    failedCalls, delegations, prompt,
    hasData: !!(session || budget || cache || (real && real.steps > 0)),
  };
}

function bar(pct, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtModelWindow(d) {
  const w = d.contextWindow >= 1e6 ? `${(d.contextWindow / 1e6).toFixed(1)}M`
    : `${Math.round(d.contextWindow / 1000)}K`;
  return `${d.model} · ${w}`;
}

function fmtSignedEstimate(n) {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}~${formatTokens(Math.abs(n))}`;
}

export function renderBoard(d) {
  if (!d.hasData) {
    return [
      '  KCO CONTEXT BOARD',
      '  ───────────────────────────────────────────────',
      '  No session data yet. Keep working — reads, edits,',
      '  prompts and cache telemetry are tracked automatically.',
      '  Then run /kco again to see your live board.',
    ].join('\n');
  }

  const L = [];
  const pct = d.effectiveBudget > 0 ? Math.round((d.used / d.effectiveBudget) * 100) : 0;
  L.push(`  KCO CONTEXT BOARD               ${fmtModelWindow(d)}`);
  L.push('  ────────────────────────────────────────────────────────────');

  let budgetLine = `  Context  ${bar(pct)}  ${formatTokens(d.used)} / ${formatTokens(d.effectiveBudget)}  (${pct}% of window)`;
  if (d.dollars !== null) budgetLine += `  ${formatCost(d.dollars)} configured-rate estimate`;
  L.push(budgetLine);
  if (d.inTok > 0) L.push(`  Input    ${formatTokens(d.inTok)} cumulative input-side tokens processed`);

  const totalOverhead = (d.blockOverhead || 0) + (d.overhead || 0);
  if (d.savedGross > 0 || totalOverhead > 0) {
    L.push(
      `  Savings  EST ${fmtSignedEstimate(d.saved)} net direct-input tokens` +
      (d.blocked ? `  ·  ${d.blocked} redundant reads blocked` : '')
    );
    L.push(
      `           gross ~${formatTokens(d.savedGross)} − block feedback ~${formatTokens(d.blockOverhead || 0)}` +
      ` − delivered notices ~${formatTokens(d.overhead || 0)}`
    );
  } else {
    L.push('  Savings  EST ~0 direct-input tokens (no redundant read blocked yet)');
  }

  if (d.cacheEcon) {
    const c = d.cacheEcon;
    let line = `  Cache    ${bar(c.hitPct)}  ${c.hitPct}% hit  ·  ${formatTokens(c.cacheReadTokens)} cache-read input tokens`;
    if (c.breaks > 0) line += `  ·  ${c.breaks} cache break${c.breaks === 1 ? '' : 's'}`;
    L.push(line);
    L.push('           observed usage telemetry; not counted as KCO token savings');
  }

  if (d.replayAmplification !== null && d.replayAmplification !== undefined) {
    L.push(`  Replay   ${d.replayAmplification.toFixed(2)}x input-side/novel-side signal (diagnostic, not savings)`);
  }

  L.push(`  Files    ${d.filesLoaded} loaded  ·  ${d.totalReads} reads  ·  ${d.totalEdits} edits  ·  ${d.wastedReads} wasted reads (${d.cold.length} cold files)`);
  L.push(`  Health   ${d.failedCalls} failed calls  ·  ${d.delegations} delegations  ·  waste ${bar(d.wastePct, 8)} ${d.wastePct}%`);

  if (d.prompt) {
    const hint = d.prompt.suggestions && d.prompt.suggestions.length
      ? `  (${d.prompt.suggestions[0]})` : '';
    L.push(`  Prompt   last grade: ${d.prompt.grade}${hint}`);
  }

  L.push('  ────────────────────────────────────────────────────────────');
  const actions = buildActions(d);
  if (actions.length) for (const a of actions) L.push(`  ${a}`);
  else L.push('  ✅ Context is lean — nothing to optimize right now.');
  return L.join('\n');
}

function buildActions(d) {
  const out = [];
  if (d.reclaimable > 3000 && d.cold.length) {
    const top = d.cold.slice(0, 3).map(c => displayPath(c.path, 28)).join(', ');
    out.push(`⚡ Free ~${formatTokens(d.reclaimable)} estimated context: drop ${top} → /compact`);
  }
  if (d.cacheEcon && d.cacheEcon.breaks > 0) {
    out.push('🧊 Cache broke this session — avoid model/effort switching inside a warm session');
  }
  if (d.failedCalls >= 3) out.push(`🛠  ${d.failedCalls} failed tool calls — check /kco-replay`);
  if (d.prompt && d.prompt.grade && 'CDF'.includes(d.prompt.grade)) {
    out.push('✍️  Last prompt was vague — /kco-coach can sharpen the next one');
  }
  return out;
}

export function renderSummary(d) {
  if (!d.hasData || (d.saved === 0 && d.used === 0 && d.inTok === 0)) return '';
  const L = [];
  L.push('  ── KCO session summary ───────────────────────────────────────');

  if (d.savedGross > 0 || (d.blockOverhead || 0) > 0 || (d.overhead || 0) > 0) {
    L.push(`  Estimated net direct-input reduction: ${fmtSignedEstimate(d.saved)} tokens.`);
    L.push(
      `  Counterfactual estimate: blocked reads ~${formatTokens(d.savedGross)} − ` +
      `block feedback ~${formatTokens(d.blockOverhead || 0)} − ` +
      `delivered notices ~${formatTokens(d.overhead || 0)}.`
    );
    L.push('  Not replay-adjusted; not a direct percentage of Kimi subscription quota.');
  } else {
    L.push(`  Tracked ${formatTokens(d.used)} current-context tokens this session.`);
  }

  if (d.inTok > 0) {
    L.push(`  Observed/estimated cumulative input-side processing: ${formatTokens(d.inTok)} tokens.`);
  }

  if (d.cacheEcon) {
    const c = d.cacheEcon;
    L.push(
      `  Prompt cache: ${c.hitPct}% hit rate — ${formatTokens(c.cacheReadTokens)} cache-read input tokens observed; ` +
      `these are usage telemetry, not KCO savings.`
    );
    if (c.breaks > 0) L.push(`  ⚠ Cache broke ${c.breaks}x during the session.`);
  }

  if (d.replayAmplification !== null && d.replayAmplification !== undefined) {
    L.push(`  Replay signal: ${d.replayAmplification.toFixed(2)}x input-side/novel-side (diagnostic only).`);
  }

  if (d.reclaimable > 3000) {
    L.push(`  Tip: ~${formatTokens(d.reclaimable)} estimated cold context is still loaded — /compact before the next task.`);
  }
  return L.join('\n');
}

function main() {
  const mode = process.argv[2] || 'board';
  const sessionId = process.argv[3] || getLatestSessionId();
  const d = gather(sessionId);
  if (mode === 'summary') {
    const s = renderSummary(d);
    if (s) console.log(s);
    const budget = sessionId ? loadJSON(join(BUDGET_STATE_DIR, `${sessionId}.json`)) : null;
    if (budget && budget.realContextTokens && budget.totalTokensEstimated) {
      updateCalibrationFromSession(budget.realContextTokens, budget.totalTokensEstimated);
    }
  } else {
    console.log(renderBoard(d));
  }
}

if (isMainModule(import.meta.url)) {
  try { main(); }
  catch (e) { console.error(`[kco] dashboard error: ${e.message}`); process.exit(0); }
}
