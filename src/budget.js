#!/usr/bin/env node

/**
 * Context Budget Monitor v3.0 (KCO — Kimi Code port)
 *
 * Tracks token accumulation during a session (input + estimated output) and
 * warns when approaching a configurable budget limit. Model-aware: the real
 * context window comes from ~/.kimi-code/config.toml (e.g. 1M for k3).
 *
 * Port notes (vs the original claude-context-optimizer budget.js):
 *   - HEADLINE IMPROVEMENT: ground truth comes from wire.jsonl via
 *     getSessionUsage(sessionId, cwd) — the true contextTokens the model
 *     actually carried on its last step — instead of parsing Claude
 *     transcripts. The budget % is REAL, not estimated. Estimation stays as
 *     the fallback when the wire file is unavailable.
 *   - PostToolUse carries `tool_output` (full result string) — its real
 *     length beats stat-based guessing for input-side accounting.
 *   - Cost is OPTIONAL: Kimi has no per-token billing by default, so
 *     computeCost()/formatCost() return null unless the user configures
 *     pricePerMillion{Input,Output} in config.json. All user-facing numbers
 *     lead with tokens and % of window; $ appears only when configured.
 *   - Context-rot warning fires only when maxContextSize >= 1M (e.g. k3).
 *   - "CCO" → "KCO", "/cco" → "/kco" in all user-facing text.
 */

import { join, extname } from 'path';
import { statSync } from 'fs';
import {
  BUDGET_STATE_DIR,
  formatTokens, loadConfig, getEffectiveBudget,
  displayPath, loadJSON, saveJSON, ensureDataDirs, loadBudgetConfig,
  estimateTokens, estimateTokensFromString, getCalibrationFactor,
  computeCost, formatCost,
} from './utils.js';
import { isMainModule, runHook } from './hook-io.js';
import { emitNotice } from './notices.js';
import { getActiveModel } from './kimi-config.js';
import { getSessionUsage } from './wire-usage.js';

ensureDataDirs();

function loadBudgetState(sessionId) {
  const file = join(BUDGET_STATE_DIR, `${sessionId}.json`);
  return loadJSON(file) || {
    sessionId,
    totalTokensEstimated: 0,
    inputTokensEstimated: 0,
    outputTokensEstimated: 0,
    warningsSent: [],
    filesLoaded: {},
    compactSuggested: false,
    lastCompactSuggestAt: 0,
    autoCompactSentAt: 0,
    criticalSentAt: 0,
    startedAt: new Date().toISOString()
  };
}

function saveBudgetState(state) {
  const file = join(BUDGET_STATE_DIR, `${state.sessionId}.json`);
  saveJSON(file, state);
}

/**
 * Estimate input + output tokens consumed by a tool call.
 * Returns { input, output }.
 */
function estimateToolTokens(toolName, toolInput) {
  switch (toolName) {
    case 'Read': {
      // Input = file contents echoed back into context. Cap the assumed line
      // count by the file's real size (a full read of a 40-line file is 40
      // lines, not the 2000-line default) and use the extension-aware ratio.
      let lines = toolInput?.limit || 2000;
      const fp = toolInput?.path || '';
      try {
        const sizeLines = Math.ceil(statSync(fp).size / 36); // ~35 chars + newline
        lines = Math.min(lines, Math.max(1, sizeLines));
      } catch { /* deleted/unreadable — keep default */ }
      return { input: estimateTokens(lines, extname(fp)), output: 0 };
    }
    case 'Edit': {
      const oldLen = (toolInput?.old_string || '').length;
      const newLen = (toolInput?.new_string || '').length;
      // Output: the new string Kimi generated.
      return {
        input: Math.round(oldLen / 3.7) + 50,
        output: Math.round(newLen / 3.7) + 30
      };
    }
    case 'Write': {
      const contentLen = (toolInput?.content || '').length;
      // Pure output — Kimi wrote the whole file.
      return { input: 30, output: Math.round(contentLen / 3.7) };
    }
    case 'Grep':
      return { input: 200, output: 50 };
    case 'Glob':
      return { input: 100, output: 30 };
    case 'Bash':
      // Command echo + typical output; real size comes from tool_output below.
      return { input: 300, output: 20 };
    case 'Agent':
      // Subagents emit a summary back; estimate moderate output.
      return { input: 500, output: 1000 };
    default:
      // MCP and unknown tools — small default.
      if (toolName && toolName.startsWith('mcp__')) {
        return { input: 200, output: 300 };
      }
      return { input: 50, output: 50 };
  }
}

/**
 * Build a compact recommendation with specific files to drop.
 */
function buildCompactRecommendation(state) {
  const droppable = Object.entries(state.filesLoaded)
    .filter(([, d]) => d.reads > 0 && d.edits === 0)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 5);

  if (droppable.length === 0) return null;

  const reclaimable = droppable.reduce((sum, [, d]) => sum + d.tokens, 0);
  let msg = `[context-budget] You can free ~${formatTokens(reclaimable)} tokens with /compact:`;
  for (const [path, d] of droppable) {
    msg += `\n  drop ${displayPath(path, 40)} (~${formatTokens(d.tokens)}, ${d.reads} reads, 0 edits)`;
  }

  return { message: msg, reclaimableTokens: reclaimable, files: droppable.map(([p]) => p) };
}

/**
 * Session cost so far, or null when pricing is not configured (the default on
 * Kimi — subscription CLI with no per-token billing). All cost UI passes
 * through this so unconfigured pricing hides cleanly.
 */
function sessionCost(state) {
  const inDollars = computeCost(state.inputTokensEstimated, 'input');
  const outDollars = computeCost(state.outputTokensEstimated, 'output');
  if (inDollars === null && outDollars === null) return null;
  return (inDollars || 0) + (outDollars || 0);
}

async function main(event) {
  if (!event || event.hook_event_name !== 'PostToolUse') return;

  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || {};
  const sessionId = event.session_id || 'unknown';
  const config = loadConfig();
  const budgetConfig = loadBudgetConfig();
  const state = loadBudgetState(sessionId);

  const est = estimateToolTokens(toolName, toolInput);
  // GROUND TRUTH per tool call: PostToolUse carries the actual tool_output
  // that just entered the context — its real size beats any stat-based guess
  // (and covers Bash/MCP output, which estimation can't see at all).
  let respTokens = 0;
  if (event.tool_output !== undefined) {
    try {
      const respText = typeof event.tool_output === 'string'
        ? event.tool_output : JSON.stringify(event.tool_output);
      respTokens = estimateTokensFromString(respText || '');
    } catch { /* keep estimate */ }
  }
  // Self-calibration: sessions with wire.jsonl ground truth teach the local
  // real/estimated drift (see utils.updateCalibrationFromSession). Input-side
  // only — output estimates already come from exact string lengths.
  const inAdded = respTokens > 0 ? respTokens : Math.round(est.input * getCalibrationFactor());
  const outAdded = est.output;

  // A single huge tool result is the #1 avoidable context burn. Nudge once per
  // occurrence with the concrete fix for that tool.
  if (respTokens >= 10_000) {
    const fix = toolName === 'Read'
      ? 'read with offset/limit or Grep the file instead'
      : toolName === 'Bash'
        ? 'pipe through tail/head/grep next time'
        : 'narrow the query';
    emitNotice(sessionId, {
      kind: 'budget:bigresult',
      text: `[context-budget] ${toolName} result was ~${formatTokens(respTokens)} tokens — ${fix}.`,
      priority: 'normal',
    });
  }
  state.inputTokensEstimated += inAdded;
  state.outputTokensEstimated += outAdded;
  state.totalTokensEstimated = state.inputTokensEstimated + state.outputTokensEstimated;

  const filePath = toolInput?.path;
  if (filePath) {
    if (!state.filesLoaded[filePath]) {
      // Cap the map: the whole state file is rewritten on every tool call, so
      // unbounded growth makes long sessions O(n²). Evict the coldest file.
      const keys = Object.keys(state.filesLoaded);
      if (keys.length >= 500) {
        const coldest = keys.reduce((min, k) =>
          state.filesLoaded[k].tokens < state.filesLoaded[min].tokens ? k : min, keys[0]);
        delete state.filesLoaded[coldest];
      }
      state.filesLoaded[filePath] = { tokens: 0, reads: 0, edits: 0 };
    }
    state.filesLoaded[filePath].tokens += inAdded;
    if (toolName === 'Read') state.filesLoaded[filePath].reads++;
    if (toolName === 'Edit' || toolName === 'Write') state.filesLoaded[filePath].edits++;
  }

  // Prefer GROUND TRUTH from the session wire transcript (exact API usage
  // counts) over the chars-per-token estimate. Estimation stays as the
  // fallback when wire.jsonl is unavailable. THIS is KCO's headline win:
  // the budget % below is the real context fill, not a guess.
  const real = getSessionUsage(sessionId, event.cwd || process.cwd());
  if (real && real.contextTokens > 0) {
    state.realContextTokens = real.contextTokens;
  }
  // The session's REAL model (from the wire) — window and display follow it.
  if (real && real.model) state.model = real.model;

  const activeModel = getActiveModel();
  const contextWindow = activeModel.maxContextSize;
  const effectiveBudget = getEffectiveBudget(config);
  const modelLabel = state.model || activeModel.model || activeModel.alias || config.model;

  // ── Cache-break guard ──────────────────────────────────────────────────────
  // The prompt cache lives ~5 minutes. A longer pause with a warm context
  // means the whole cached prefix had to be re-processed. We can't stop a
  // break that already happened, but naming its real size teaches the habit:
  // batch pauses, /compact (or finish) before stepping away. Cost is named in
  // TOKENS (the universal currency); $ only appears when pricing is
  // configured — usually it isn't, so the notice is token-only.
  const nowMs = Date.now();
  if (state.lastEventAt && (state.realContextTokens || 0) >= 20_000) {
    const gapMin = (nowMs - state.lastEventAt) / 60_000;
    if (gapMin >= 5) {
      state.cacheBreaks = (state.cacheBreaks || 0) + 1;
      let text =
        `[context-budget] ~${Math.round(gapMin)} min pause — the prompt cache (~5-min TTL) went cold; ` +
        `re-warming ${formatTokens(state.realContextTokens)} tokens of context`;
      const cost = computeCost(state.realContextTokens, 'input');
      const formatted = formatCost(cost);
      text += formatted ? ` (~${formatted} extra). ` : '. ';
      text += 'Batch pauses: finish the task first, or /compact before a long break.';
      emitNotice(sessionId, {
        kind: `budget:cachebreak:${state.cacheBreaks}`,
        text,
      });
    }
  }
  state.lastEventAt = nowMs;
  const contextNow = state.realContextTokens || state.totalTokensEstimated;
  const usagePercent = Math.round((contextNow / effectiveBudget) * 100);

  // ── Context-rot zone (quality, not capacity) ──────────────────────────────
  // On 1M-window models intelligence degrades well before the window fills —
  // community consensus puts the "dumb zone" at ~300–400K tokens. Budget-%
  // warnings (50/70/85) never fire that early on 1M, so this is a separate,
  // one-shot quality signal. Only meaningful on 1M+ windows (e.g. k3).
  if (contextWindow >= 1_000_000 && contextNow >= 350_000 && !state.rotWarned) {
    state.rotWarned = true;
    const rec = buildCompactRecommendation(state);
    emitNotice(sessionId, {
      kind: 'budget:rot',
      priority: 'critical',
      text:
        `[context-budget] ${formatTokens(contextNow)} in context — entering the degradation zone (~300-400K on 1M models: ` +
        `quality drops long before the window fills). Prefer /compact focused on the current task, or finish and start fresh.` +
        (rec ? ` Free ~${formatTokens(rec.reclaimableTokens)} now: /compact.` : ''),
    });
  }

  // ── Threshold warnings (gated by the session noise budget) ────────────────
  // Only actionable signals reach Kimi's context, and only a few per session.
  // 85%+ is critical (always shown, carries a /compact recommendation); the
  // early 50/70 nudges are 'normal' and may be suppressed once the cap is hit.
  for (const threshold of config.warnAt) {
    if (usagePercent >= threshold && !state.warningsSent.includes(threshold)) {
      state.warningsSent.push(threshold);

      const src = state.realContextTokens ? '' : '~';
      let msg = `[context-budget] ${usagePercent}% of context window used (${src}${formatTokens(contextNow)}/${formatTokens(effectiveBudget)})`;
      msg += ` | ${modelLabel}: in ${formatTokens(state.inputTokensEstimated)} / out ${formatTokens(state.outputTokensEstimated)}`;
      const cost = sessionCost(state);
      const formatted = formatCost(cost);
      if (formatted) msg += ` | Cost: ${formatted}`;

      if (threshold >= 85) {
        const rec = buildCompactRecommendation(state);
        if (rec) msg += '\n' + rec.message;
        else msg += ` | Consider /compact to free context`;
      }

      emitNotice(sessionId, {
        kind: `budget:${threshold}`,
        text: msg,
        priority: threshold >= 85 ? 'critical' : 'normal',
      });
    }
  }

  // ── Auto-compact directives ──────────────────────────────────────────────
  // These are the highest-value signals (they trigger an actual /compact that
  // frees real tokens), so they're 'critical' — always allowed past the cap.
  if (budgetConfig.autoCompactEnabled) {
    const { autoCompactThreshold, criticalThreshold } = budgetConfig;

    if (usagePercent >= criticalThreshold) {
      const tokensSinceCritical = state.totalTokensEstimated - (state.criticalSentAt || 0);
      if (tokensSinceCritical >= 5000 || !state.criticalSentAt) {
        state.criticalSentAt = state.totalTokensEstimated;
        const rec = buildCompactRecommendation(state);
        const reclaimMsg = rec ? ` Free ~${formatTokens(rec.reclaimableTokens)} tokens.` : '';
        emitNotice(sessionId, {
          kind: 'budget:critical',
          priority: 'critical',
          text:
            `[context-budget] CRITICAL: ${usagePercent}% of context window used (${formatTokens(contextNow)}/${formatTokens(effectiveBudget)}). ` +
            `Run /compact immediately or the session will lose older context.${reclaimMsg}`,
        });
      }
    } else if (usagePercent >= autoCompactThreshold) {
      const tokensSinceAutoCompact = state.totalTokensEstimated - (state.autoCompactSentAt || 0);
      if (tokensSinceAutoCompact >= 10000 || !state.autoCompactSentAt) {
        state.autoCompactSentAt = state.totalTokensEstimated;
        const rec = buildCompactRecommendation(state);
        const reclaimMsg = rec ? ` Free ~${formatTokens(rec.reclaimableTokens)} tokens.` : '';
        emitNotice(sessionId, {
          kind: 'budget:autocompact',
          priority: 'critical',
          text:
            `[context-budget] Auto-compact recommended — ${usagePercent}% of context window used. ` +
            `Run /compact now to free tokens and keep the session efficient.${reclaimMsg}`,
        });
      }
    }
  } else if (usagePercent >= config.autoCompactAt) {
    const tokensSinceLast = state.totalTokensEstimated - (state.lastCompactSuggestAt || 0);
    if (tokensSinceLast >= 10000) {
      state.lastCompactSuggestAt = state.totalTokensEstimated;
      const rec = buildCompactRecommendation(state);
      if (rec && rec.reclaimableTokens > 5000) {
        emitNotice(sessionId, {
          kind: 'budget:still',
          priority: 'critical',
          text: `[context-budget] Still at ${usagePercent}% — run /compact to reclaim ~${formatTokens(rec.reclaimableTokens)} tokens`,
        });
      }
    }
  }

  // Note: the "KCO makes your budget Nx more effective" brag stays removed —
  // it was pure FYI that spent context to praise itself. The /kco dashboard
  // reports NET savings (saved − the optimizer's own injected tokens) instead.

  saveBudgetState(state);
}

// Run the hook only when executed directly — importing for tests must not read stdin.
if (isMainModule(import.meta.url)) runHook(main);

// Exposed for tests
export { estimateToolTokens, buildCompactRecommendation, sessionCost, main };
