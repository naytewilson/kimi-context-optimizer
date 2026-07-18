/**
 * Real token usage from the Kimi Code session wire transcript (KCO port).
 *
 * Replaces the original's transcript-usage.js (Claude transcript JSONL). Kimi
 * writes ground-truth usage to
 *   ~/.kimi-code/sessions/wd_<hash>/<session_id>/agents/main/wire.jsonl
 * Records of interest (verified — see docs/hook-payloads.md):
 *   - {"type":"step.end", ..., "usage":{"inputOther":N,"output":N,
 *      "inputCacheRead":N,"inputCacheCreation":N}} — per-step real usage;
 *      the LAST record's input sum = current context size.
 *   - {"type":"context.append_loop_event","event":{"type":"tool.result", ...,
 *      "result":{"output":"…"}}} — full tool outputs (size attribution).
 *   - {"type":"config.update","systemPrompt":"…"} — exact system-prompt size.
 *   - {"type":"model","model":…} — model identity records.
 *
 * Parsing is defensive: unknown record types and malformed lines are skipped,
 * and the file may be growing while we read it.
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { getKimiHome } from './kimi-config.js';

// How old a wire.jsonl may be for the "most recent" fallback in findWireFile.
const FALLBACK_MAX_AGE_MS = 10 * 60 * 1000;

// Parse cache: file path → { mtimeMs, size, parsed }. The PostToolUse hot path
// calls getSessionUsage() on every tool call; re-parsing a multi-MB JSONL file
// each time would waste CPU. Keyed on (mtimeMs, size) so a growing file
// invalidates naturally.
const _parseCache = new Map();

// ── Wire file discovery ──────────────────────────────────────────────────────

/**
 * Locate the wire.jsonl for a session.
 *  1. Exact match: ~/.kimi-code/sessions/wd_<hash>/<sessionId>/agents/main/wire.jsonl
 *  2. Fallback: the most recently modified wire.jsonl (any session) touched in
 *     the last 10 minutes — preferring a wd_ dir whose name contains the cwd
 *     basename (Kimi names working-dir dirs `wd_<basename>_<hash>`).
 * Returns an absolute path or null when nothing matches.
 */
export function findWireFile(sessionId, cwd) {
  try {
    const sessionsRoot = join(getKimiHome(), 'sessions');
    let wdDirs;
    try {
      wdDirs = readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('wd_'))
        .map((d) => d.name);
    } catch {
      return null;
    }

    // 1. Exact session-id lookup.
    if (sessionId) {
      for (const wd of wdDirs) {
        const candidate = join(sessionsRoot, wd, sessionId, 'agents', 'main', 'wire.jsonl');
        if (existsSync(candidate)) return candidate;
      }
    }

    // 2. Fallback: most recent wire.jsonl across all sessions.
    const now = Date.now();
    const candidates = [];
    for (const wd of wdDirs) {
      const wdPath = join(sessionsRoot, wd);
      let sessionDirs;
      try {
        sessionDirs = readdirSync(wdPath, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch { continue; }
      for (const sid of sessionDirs) {
        const wirePath = join(wdPath, sid, 'agents', 'main', 'wire.jsonl');
        try {
          const st = statSync(wirePath);
          if (now - st.mtimeMs <= FALLBACK_MAX_AGE_MS) {
            candidates.push({ path: wirePath, mtimeMs: st.mtimeMs, wd });
          }
        } catch { /* no wire.jsonl here */ }
      }
    }
    if (candidates.length === 0) return null;

    // Prefer the wire file whose wd_ dir matches the cwd basename.
    if (cwd) {
      const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (slug) {
        const matching = candidates.filter((c) => c.wd.toLowerCase().includes(slug));
        if (matching.length > 0) {
          matching.sort((a, b) => b.mtimeMs - a.mtimeMs);
          return matching[0].path;
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0].path;
  } catch {
    return null;
  }
}

// ── Wire parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a wire.jsonl file into a usage summary. Pure apart from file reads —
 * exported for tests. Tolerates the file growing mid-read (a record cut
 * mid-line simply fails JSON.parse and is skipped).
 */
export function parseWireText(text) {
  const result = {
    contextTokens: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    cacheHitRate: 0,
    steps: 0,
    model: null,
    systemPromptChars: 0,
    lastStepAt: null,
    toolOutputs: [], // chronological [{ toolCallId, outputLength }]
  };

  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    // Per-step ground-truth usage.
    if (obj.type === 'step.end' && obj.usage && typeof obj.usage === 'object') {
      const u = obj.usage;
      const inputOther = u.inputOther || 0;
      const output = u.output || 0;
      const cacheRead = u.inputCacheRead || 0;
      const cacheCreation = u.inputCacheCreation || 0;
      result.steps++;
      result.totalInput += inputOther;
      result.totalOutput += output;
      result.totalCacheRead += cacheRead;
      result.totalCacheCreation += cacheCreation;
      // Current context = what the LAST step sent to the model.
      result.contextTokens = inputOther + cacheRead + cacheCreation;
      const ts = obj.timestamp || obj.ts || obj.time || obj.at;
      if (typeof ts === 'string') result.lastStepAt = ts;
      else if (typeof ts === 'number') result.lastStepAt = new Date(ts).toISOString();
      continue;
    }

    // Exact system-prompt size (overhead audit).
    if (obj.type === 'config.update' && typeof obj.systemPrompt === 'string') {
      result.systemPromptChars = obj.systemPrompt.length;
      continue;
    }

    // Tool outputs (for size attribution fallback).
    if (obj.type === 'context.append_loop_event' && obj.event && obj.event.type === 'tool.result') {
      const ev = obj.event;
      const out = ev.result && typeof ev.result.output === 'string' ? ev.result.output : '';
      result.toolOutputs.push({
        toolCallId: ev.toolCallId || ev.tool_call_id || (ev.result && ev.result.toolCallId) || null,
        outputLength: out.length,
      });
      continue;
    }

    // Model identity — keep the most recent record that carries a name.
    if (typeof obj.model === 'string' && obj.model) {
      result.model = obj.model;
    }
  }

  const totalInputSide = result.totalInput + result.totalCacheRead + result.totalCacheCreation;
  result.cacheHitRate = totalInputSide > 0 ? result.totalCacheRead / totalInputSide : 0;
  return result;
}

/** Read + parse a wire file, caching by (path, mtimeMs, size). */
function readWireParsed(wirePath) {
  try {
    const st = statSync(wirePath);
    const cached = _parseCache.get(wirePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.parsed;
    }
    const parsed = parseWireText(readFileSync(wirePath, 'utf-8'));
    _parseCache.set(wirePath, { mtimeMs: st.mtimeMs, size: st.size, parsed });
    // Keep the map small — sessions come and go.
    if (_parseCache.size > 32) {
      const firstKey = _parseCache.keys().next().value;
      _parseCache.delete(firstKey);
    }
    return parsed;
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

const EMPTY_USAGE = {
  contextTokens: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheCreation: 0,
  cacheHitRate: 0,
  steps: 0,
  model: null,
  systemPromptChars: 0,
  lastStepAt: null,
};

/**
 * Ground-truth usage for a session from its wire.jsonl.
 * Returns { contextTokens, totalInput, totalOutput, totalCacheRead,
 * totalCacheCreation, cacheHitRate, steps, model, systemPromptChars,
 * lastStepAt } — all numbers default to 0, strings to null, when the wire
 * file is missing or carries no such data.
 */
export function getSessionUsage(sessionId, cwd) {
  const wirePath = findWireFile(sessionId, cwd);
  if (!wirePath) return { ...EMPTY_USAGE };
  const parsed = readWireParsed(wirePath);
  if (!parsed) return { ...EMPTY_USAGE };
  const { toolOutputs, ...usage } = parsed;
  return usage;
}

/**
 * The last `limit` tool outputs recorded in the wire, oldest→newest:
 * [{ toolCallId, outputLength }]. Used for size attribution when the hook
 * payload's tool_output is unavailable.
 */
export function getRecentToolOutputs(sessionId, cwd, limit = 10) {
  const wirePath = findWireFile(sessionId, cwd);
  if (!wirePath) return [];
  const parsed = readWireParsed(wirePath);
  if (!parsed) return [];
  return parsed.toolOutputs.slice(-limit);
}

/** Clear the parse cache. Useful for tests. */
export function clearWireCache() {
  _parseCache.clear();
}
