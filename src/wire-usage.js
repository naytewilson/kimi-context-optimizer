/**
 * Real token usage from Kimi Code wire transcripts.
 *
 * Current Kimi Code data authority (2026-09):
 *   $KIMI_CODE_HOME/session_index.jsonl
 *   $KIMI_CODE_HOME/sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl
 *
 * Supported usage schemas:
 *   - current: { type: "usage.record", usage: { inputOther, output,
 *       inputCacheRead, inputCacheCreation }, model, time }
 *   - legacy KCO fixture: { type: "step.end", usage: { ... } }
 *
 * Exact hook session ids never fall back to another session. The parser is
 * append-aware: once a transcript has been parsed, only newly appended bytes
 * are decoded until the file is truncated or replaced.
 */

import {
  readFileSync, statSync, existsSync, readdirSync,
  openSync, readSync, closeSync,
} from 'fs';
import { join, isAbsolute } from 'path';
import { getKimiHome } from './kimi-config.js';

const _parseCache = new Map();

function emptyParsed() {
  return {
    contextTokens: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    totalInputSide: 0,
    cacheHitRate: 0,
    steps: 0,
    recognizedUsageRows: 0,
    wireSchemas: [],
    model: null,
    systemPromptChars: 0,
    lastStepAt: null,
    toolOutputs: [],
  };
}

function normalizeTime(value) {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // Current Kimi Code uses epoch milliseconds; tolerate epoch seconds too.
  const ms = value < 1e12 ? value * 1000 : value;
  try { return new Date(ms).toISOString(); } catch { return null; }
}

function usageNumber(u, camel, snake) {
  const value = u?.[camel] ?? u?.[snake] ?? 0;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function addSchema(result, schema) {
  if (!result.wireSchemas.includes(schema)) result.wireSchemas.push(schema);
}

function refreshDerived(result) {
  result.totalInputSide = result.totalInput + result.totalCacheRead + result.totalCacheCreation;
  result.cacheHitRate = result.totalInputSide > 0
    ? result.totalCacheRead / result.totalInputSide
    : 0;
  return result;
}

function applyUsage(result, obj, schema) {
  const u = obj.usage;
  if (!u || typeof u !== 'object') return false;

  const inputOther = usageNumber(u, 'inputOther', 'input_other');
  const output = usageNumber(u, 'output', 'output');
  const cacheRead = usageNumber(u, 'inputCacheRead', 'input_cache_read');
  const cacheCreation = usageNumber(u, 'inputCacheCreation', 'input_cache_creation');

  result.steps++;
  result.recognizedUsageRows++;
  addSchema(result, schema);
  result.totalInput += inputOther;
  result.totalOutput += output;
  result.totalCacheRead += cacheRead;
  result.totalCacheCreation += cacheCreation;
  result.contextTokens = inputOther + cacheRead + cacheCreation;

  if (typeof obj.model === 'string' && obj.model) result.model = obj.model;
  const ts = normalizeTime(obj.timestamp ?? obj.ts ?? obj.time ?? obj.at);
  if (ts) result.lastStepAt = ts;
  refreshDerived(result);
  return true;
}

function applyWireObject(result, obj) {
  if (!obj || typeof obj !== 'object') return;

  if (obj.type === 'usage.record' && applyUsage(result, obj, 'usage.record')) return;
  if (obj.type === 'step.end' && applyUsage(result, obj, 'step.end')) return;

  // Legacy KCO fixtures and older wire records.
  if (obj.type === 'config.update' && typeof obj.systemPrompt === 'string') {
    result.systemPromptChars = obj.systemPrompt.length;
    return;
  }

  if (obj.type === 'context.append_loop_event' && obj.event?.type === 'tool.result') {
    const ev = obj.event;
    const out = ev.result && typeof ev.result.output === 'string' ? ev.result.output : '';
    result.toolOutputs.push({
      toolCallId: ev.toolCallId || ev.tool_call_id || ev.result?.toolCallId || null,
      outputLength: out.length,
    });
    return;
  }

  if (typeof obj.model === 'string' && obj.model) result.model = obj.model;
}

function applyLine(result, line) {
  if (!line) return;
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  applyWireObject(result, obj);
}

// ── Session index authority ──────────────────────────────────────────────────

function readSessionIndex() {
  const file = join(getKimiHome(), 'session_index.jsonl');
  let text;
  try { text = readFileSync(file, 'utf-8'); } catch { return []; }

  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') rows.push(row);
    } catch { /* malformed index row: skip */ }
  }
  return rows;
}

function indexedWirePath(row) {
  if (!row || typeof row.sessionDir !== 'string' || !row.sessionDir) return null;
  const sessionDir = isAbsolute(row.sessionDir)
    ? row.sessionDir
    : join(getKimiHome(), row.sessionDir);
  return join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

function findExactSessionByScan(sessionId) {
  if (!sessionId) return null;
  const sessionsRoot = join(getKimiHome(), 'sessions');
  let workDirs;
  try {
    workDirs = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const wd of workDirs) {
    const candidate = join(sessionsRoot, wd.name, sessionId, 'agents', 'main', 'wire.jsonl');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a main-agent wire transcript.
 *
 * - With a sessionId: resolve only that exact session (index first, exact scan
 *   second). Never borrow another session as a "recent" fallback.
 * - Without a sessionId: choose the last indexed row whose workDir exactly
 *   equals cwd. This path exists for reporting commands that lack hook stdin.
 */
export function findWireFile(sessionId, cwd) {
  try {
    const rows = readSessionIndex();

    if (sessionId) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]?.sessionId !== sessionId) continue;
        const candidate = indexedWirePath(rows[i]);
        if (candidate && existsSync(candidate)) return candidate;
      }
      return findExactSessionByScan(sessionId);
    }

    if (!cwd) return null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.workDir !== cwd) continue;
      const candidate = indexedWirePath(rows[i]);
      if (candidate && existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Wire parsing ─────────────────────────────────────────────────────────────

/** Pure parser used by tests and diagnostics. */
export function parseWireText(text) {
  const result = emptyParsed();
  for (const line of String(text || '').split('\n')) applyLine(result, line);
  return refreshDerived(result);
}

function readRangeBuffer(file, start, length) {
  if (!(length > 0)) return Buffer.alloc(0);
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Decode only newline-terminated records. Keeping the trailing bytes as a
 * Buffer avoids corrupting a multi-byte UTF-8 code point when Kimi is caught
 * mid-append.
 */
function consumeJsonlBytes(result, bytes, priorTrailing = Buffer.alloc(0)) {
  const combined = priorTrailing.length
    ? Buffer.concat([priorTrailing, bytes])
    : bytes;

  let start = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] !== 0x0a) continue;
    const line = combined.subarray(start, i).toString('utf8');
    applyLine(result, line);
    start = i + 1;
  }
  return combined.subarray(start);
}

function fullParseFile(wirePath, st) {
  const parsed = emptyParsed();
  const bytes = readRangeBuffer(wirePath, 0, st.size);
  const trailing = consumeJsonlBytes(parsed, bytes);
  refreshDerived(parsed);
  return {
    ino: st.ino,
    mtimeMs: st.mtimeMs,
    size: st.size,
    parsed,
    trailing,
  };
}

function readWireParsed(wirePath) {
  try {
    const st = statSync(wirePath);
    const cached = _parseCache.get(wirePath);

    if (cached && cached.ino === st.ino && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return cached.parsed;
    }

    if (cached && cached.ino === st.ino && st.size > cached.size) {
      const appended = readRangeBuffer(wirePath, cached.size, st.size - cached.size);
      cached.trailing = consumeJsonlBytes(cached.parsed, appended, cached.trailing);
      cached.size = st.size;
      cached.mtimeMs = st.mtimeMs;
      refreshDerived(cached.parsed);
      return cached.parsed;
    }

    // Truncation, replacement, or same-size rewrite: rebuild from byte zero.
    const next = fullParseFile(wirePath, st);
    _parseCache.set(wirePath, next);
    if (_parseCache.size > 32) {
      const firstKey = _parseCache.keys().next().value;
      _parseCache.delete(firstKey);
    }
    return next.parsed;
  } catch {
    return null;
  }
}

// ── Public usage API ─────────────────────────────────────────────────────────

const EMPTY_USAGE = Object.freeze({
  contextTokens: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheCreation: 0,
  totalInputSide: 0,
  cacheHitRate: 0,
  steps: 0,
  recognizedUsageRows: 0,
  wireSchemas: [],
  model: null,
  systemPromptChars: 0,
  lastStepAt: null,
});

export function getSessionUsage(sessionId, cwd) {
  const wirePath = findWireFile(sessionId, cwd);
  if (!wirePath) return { ...EMPTY_USAGE, wireSchemas: [] };
  const parsed = readWireParsed(wirePath);
  if (!parsed) return { ...EMPTY_USAGE, wireSchemas: [] };
  const { toolOutputs, ...usage } = parsed;
  return { ...usage, wireSchemas: [...usage.wireSchemas] };
}

export function getRecentToolOutputs(sessionId, cwd, limit = 10) {
  const wirePath = findWireFile(sessionId, cwd);
  if (!wirePath) return [];
  const parsed = readWireParsed(wirePath);
  if (!parsed) return [];
  return parsed.toolOutputs.slice(-limit);
}

export function clearWireCache() {
  _parseCache.clear();
}
