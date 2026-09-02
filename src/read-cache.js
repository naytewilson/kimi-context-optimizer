#!/usr/bin/env node

/**
 * Read Cache v2.1 — Smart Context-Aware Blocking (KCO — Kimi Code port)
 *
 * PreToolUse hook that prevents redundant file reads while giving the AI
 * enough navigational context to work effectively.
 *
 * Staleness is evidence-driven in quota mode: file modification, compaction,
 * process/agent isolation, or substantial context displacement can allow a
 * reread. Wall-clock age alone is disabled by default because elapsed time does
 * not remove an unchanged file from the model context. Users can opt back in
 * with readCacheTimeStalenessMs or KCO_STALE_TIME_MS.
 */

import { basename, extname, join } from 'path';
import { statSync } from 'fs';
import {
  READ_CACHE_DIR,
  estimateTokens, formatTokens, loadJSON, saveJSON, ensureDataDirs,
  loadConfig, getEffectiveBudget, getFileLines, shouldSkipFile,
} from './utils.js';
import { block, advise, isMainModule, runHook, resolvePayloadPath } from './hook-io.js';
import { isContextIgnored } from './contextignore.js';
import { parseFileStructure, formatDigest } from './file-digest.js';

ensureDataDirs();

// ── Adaptive staleness configuration ─────────────────────────────────────────

const STALE_TOKEN_RATIO = 0.10;
const STALE_FILES_FRACTION_BASE = 8;
const LEGACY_STALE_TIME_MS = 10 * 60 * 1000;

/** Pure wall-clock policy, exported for tests. */
export function isReadCacheTimeStale({
  readAtMs,
  nowMs = Date.now(),
  quotaMode = true,
  readCacheTimeStalenessMs = 0,
} = {}) {
  if (!(readAtMs > 0) || !(nowMs >= readAtMs)) return false;
  const configured = Number(readCacheTimeStalenessMs);
  const threshold = configured > 0
    ? configured
    : (quotaMode === false ? LEGACY_STALE_TIME_MS : 0);
  return threshold > 0 && (nowMs - readAtMs) >= threshold;
}

let _thresholdCache = null;
function getStaleThresholds() {
  if (_thresholdCache) return _thresholdCache;
  const config = loadConfig();
  const budget = getEffectiveBudget(config);
  const tokens = Math.max(10_000, Math.min(200_000, Math.round(budget * STALE_TOKEN_RATIO)));
  const files = Math.max(6, Math.min(40, Math.round(STALE_FILES_FRACTION_BASE * (budget / 200_000))));
  const quotaMode = config.quotaMode !== false;
  const envTime = parseInt(process.env.KCO_STALE_TIME_MS || '', 10);
  const configuredTime = Number(config.readCacheTimeStalenessMs || 0);
  const timeMs = envTime > 0
    ? envTime
    : (configuredTime > 0 ? configuredTime : (quotaMode ? 0 : LEGACY_STALE_TIME_MS));
  _thresholdCache = { tokens, files, timeMs, budget, quotaMode };
  return _thresholdCache;
}

// ── Cache I/O ─────────────────────────────────────────────────────────────────

function loadCache(sessionId) {
  const file = join(READ_CACHE_DIR, `${sessionId}.json`);
  return loadJSON(file) || { files: {}, totalTokensSaved: 0, blockedReads: 0 };
}

function saveCache(sessionId, cache) {
  saveJSON(join(READ_CACHE_DIR, `${sessionId}.json`), cache);
}

// ── Range coverage ────────────────────────────────────────────────────────────

function isRangeCovered(ranges, offset, end) {
  if (!ranges || ranges.length === 0) return false;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      last[1] = Math.max(last[1], sorted[i][1]);
    } else {
      merged.push(sorted[i]);
    }
  }
  for (const [s, e] of merged) {
    if (s <= offset && e >= end) return true;
  }
  return false;
}

// ── Staleness detection ───────────────────────────────────────────────────────

function checkStaleness(cache, filePath) {
  const entry = cache.files[filePath];
  if (!entry || !entry.readAtMs) return { stale: false, reason: '' };

  const { tokens: tokTh, files: fileTh, timeMs, quotaMode } = getStaleThresholds();
  const readTime = entry.readAtMs;
  let newerFiles = 0;
  let newerTokens = 0;

  for (const [path, other] of Object.entries(cache.files)) {
    if (path === filePath) continue;
    if ((other.readAtMs || 0) > readTime) {
      newerFiles++;
      newerTokens += other.tokens || 0;
    }
  }

  if (newerTokens >= tokTh) {
    return {
      stale: true,
      reason: `${formatTokens(newerTokens)} tokens of other files loaded since last read`
    };
  }

  if (newerFiles >= fileTh) {
    return {
      stale: true,
      reason: `${newerFiles} other files loaded since last read`
    };
  }

  if (isReadCacheTimeStale({
    readAtMs: readTime,
    nowMs: Date.now(),
    quotaMode,
    readCacheTimeStalenessMs: timeMs,
  })) {
    const mins = Math.round((Date.now() - readTime) / 60_000);
    return {
      stale: true,
      reason: `${mins} min since last read (time expiry explicitly enabled)`
    };
  }

  return { stale: false, reason: '' };
}

export const _staleConfig = getStaleThresholds;

// ── Big-file first-read nudge ─────────────────────────────────────────────────

export function shouldNudgeBigFile({ entry, hasOffset, hasLimit, lines, threshold, enabled }) {
  if (!enabled) return false;
  if (entry) return false;
  if (hasOffset || hasLimit) return false;
  if (!lines || lines < threshold) return false;
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMtime(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return null; }
}

function trimPpids(ppids, max = 20) {
  const unique = [...new Set(ppids)];
  return unique.slice(-max);
}

function allow(sessionId, cache, filePath, mtime, offset, end, ext, ppid, logMsg) {
  const tokens = estimateTokens(end - offset, ext);
  const existing = cache.files[filePath];
  cache.files[filePath] = {
    mtime,
    lines: end - offset,
    tokens,
    readAt: new Date().toISOString(),
    readAtMs: Date.now(),
    ranges: [[offset, end]],
    ppids: trimPpids(existing ? [...(existing.ppids || []), ppid] : [ppid])
  };
  saveCache(sessionId, cache);
  if (logMsg) advise(logMsg);
  return 'allowed';
}

// ── Build digest block message ────────────────────────────────────────────────

function buildBlockMessage(filePath, entry, wasPartialRequest) {
  const name = basename(filePath);
  let landmarks, digest;
  try {
    landmarks = parseFileStructure(filePath);
    digest = formatDigest(landmarks, entry.lines);
  } catch {
    landmarks = [];
    digest = '';
  }

  let suggestion = '';
  if (landmarks.length > 1) {
    const mid = landmarks[Math.floor(landmarks.length / 2)];
    suggestion = `\n→ Example: Read with offset=${mid.line - 1}, limit=50 to see ${mid.label}`;
  }

  const partialHint = wasPartialRequest ? ' This section is already loaded.' : '';
  return (
    `⛔ [read-cache] Already loaded ${name} this session ` +
    `(${entry.lines} lines, ~${formatTokens(entry.tokens)} tokens).` +
    `${partialHint} File unchanged.\n${digest}${suggestion}`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(event) {
  if (!event || !event.hook_event_name) return;

  if (event.hook_event_name === 'PreCompact') {
    const sessionId = event.session_id || 'unknown';
    const cache = loadCache(sessionId);
    const fileCount = Object.keys(cache.files).length;
    if (fileCount > 0) {
      cache.files = {};
      saveCache(sessionId, cache);
      advise(`[read-cache] Context compacted — ${fileCount} file(s) cleared from cache. Fresh reads welcome!`);
    }
    return;
  }

  if (event.hook_event_name === 'PostCompact') {
    const sessionId = event.session_id || 'unknown';
    const cache = loadCache(sessionId);
    const fileCount = Object.keys(cache.files).length;
    if (fileCount > 0) {
      cache.files = {};
      saveCache(sessionId, cache);
    }
    advise(`[read-cache] Compaction finished — cache cleared (${fileCount} file(s)). Fresh reads welcome!`);
    return;
  }

  if (event.hook_event_name === 'PostToolUse' && (event.tool_name === 'Edit' || event.tool_name === 'Write')) {
    const filePath = resolvePayloadPath(event, (event.tool_input || {}).path);
    if (filePath) {
      const sessionId = event.session_id || 'unknown';
      const cache = loadCache(sessionId);
      if (cache.files[filePath]) {
        delete cache.files[filePath];
        saveCache(sessionId, cache);
      }
    }
    return;
  }

  if (event.hook_event_name !== 'PreToolUse') return;
  if ((event.tool_name || '') !== 'Read') return;

  const toolInput = event.tool_input || {};
  const filePath = resolvePayloadPath(event, toolInput.path);
  const sessionId = event.session_id || 'unknown';
  const ppid = process.ppid;

  if (!filePath || filePath.startsWith('/dev/') || filePath.startsWith('/proc/')) return;

  const ignoreResult = isContextIgnored(filePath);
  if (ignoreResult.ignored) {
    const reason = `🚫 [contextignore] ${basename(filePath)} matches pattern "${ignoreResult.pattern}" in .contextignore. ` +
      `Use Grep to search inside, or remove the pattern from .contextignore to allow reading.`;
    block(reason);
  }

  const offset = toolInput.offset || 0;
  let limit = toolInput.limit || 1000;
  if (!toolInput.limit) {
    const actualLines = getFileLines(filePath);
    if (actualLines > 0) limit = Math.max(1, Math.min(limit, actualLines - offset));
  }
  const end = offset + limit;
  const ext = extname(filePath);
  const cache = loadCache(sessionId);
  const entry = cache.files[filePath];
  if (entry) {
    entry.ranges ||= [];
    entry.lines ||= 0;
    entry.tokens ||= 0;
  }

  if (!entry) {
    const cfg = loadConfig();
    const enabled = cfg.bigFileDigest !== false;
    const threshold = cfg.bigFileThreshold || 1500;
    const mappable = enabled && !toolInput.offset && !toolInput.limit && !shouldSkipFile(filePath);
    const lines = mappable ? getFileLines(filePath) : 0;

    if (shouldNudgeBigFile({
      entry, hasOffset: !!toolInput.offset, hasLimit: !!toolInput.limit, lines, threshold, enabled,
    })) {
      const mtime = getMtime(filePath);
      cache.files[filePath] = {
        mtime, lines, tokens: estimateTokens(lines, ext),
        readAt: new Date().toISOString(), readAtMs: Date.now(),
        ranges: [], ppids: [ppid], nudged: true,
      };
      cache.bigFileNudges = (cache.bigFileNudges || 0) + 1;
      saveCache(sessionId, cache);

      let digest = '';
      try { digest = formatDigest(parseFileStructure(filePath), lines); } catch { /* best-effort */ }
      const reason =
        `🗺️ [read-cache] ${basename(filePath)} is ${lines} lines (~${formatTokens(estimateTokens(lines, ext))} tokens). ` +
        `Here's its map — Read with offset/limit for the section you need, or Read it again to load the whole file.\n${digest}`;
      block(reason);
    }

    allow(sessionId, cache, filePath, getMtime(filePath), offset, end, ext, ppid);
    return;
  }

  const currentMtime = getMtime(filePath);
  if (currentMtime === null) return;

  if (currentMtime !== entry.mtime) {
    allow(sessionId, cache, filePath, currentMtime, offset, end, ext, ppid,
      `[read-cache] ${basename(filePath)} changed on disk — cache refreshed.`);
    return;
  }

  if (!(entry.ppids || []).includes(ppid)) {
    entry.ppids = trimPpids([...(entry.ppids || []), ppid]);
    entry.readAt = new Date().toISOString();
    entry.readAtMs = Date.now();
    saveCache(sessionId, cache);
    return;
  }

  if (!isRangeCovered(entry.ranges, offset, end)) {
    entry.ranges.push([offset, end]);
    entry.ppids = trimPpids([...(entry.ppids || []), ppid]);
    entry.lines += limit;
    entry.tokens += estimateTokens(limit, ext);
    entry.readAt = new Date().toISOString();
    entry.readAtMs = Date.now();
    saveCache(sessionId, cache);
    return;
  }

  const staleness = checkStaleness(cache, filePath);
  if (staleness.stale) {
    allow(sessionId, cache, filePath, currentMtime, offset, end, ext, ppid,
      `[read-cache] Re-read allowed: ${basename(filePath)} context is stale (${staleness.reason}).`);
    return;
  }

  const wouldReload = Math.min(estimateTokens(limit, ext), entry.tokens || estimateTokens(limit, ext));
  cache.totalTokensSaved += wouldReload;
  cache.blockedReads += 1;
  saveCache(sessionId, cache);

  const wasPartialRequest = !!(toolInput.offset || toolInput.limit);
  const reason = buildBlockMessage(filePath, entry, wasPartialRequest);
  block(reason);
}

if (isMainModule(import.meta.url)) runHook(main);

export { loadCache, saveCache, main };
