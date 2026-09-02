#!/usr/bin/env node

/**
 * Read Cache v2.2 — quota-aware redundant-read blocking.
 *
 * Savings accounting is deliberately conservative:
 *   - a blocked read's counterfactual token volume is ESTIMATED from the actual
 *     requested characters on disk, never from average line length alone;
 *   - every model-visible block reason is counted as KCO overhead;
 *   - replay amplification is NOT multiplied into claimed savings;
 *   - current and legacy Kimi tool/payload names are normalized centrally.
 */

import { basename, extname, join } from 'path';
import { statSync } from 'fs';
import {
  READ_CACHE_DIR,
  estimateTokens, formatTokens, loadJSON, saveJSON, ensureDataDirs,
  loadConfig, getEffectiveBudget, getFileLines, shouldSkipFile,
  getCalibrationFactor,
} from './utils.js';
import {
  block, isMainModule, runHook, resolvePayloadPath,
  canonicalToolName, getToolPath, getReadRange,
} from './hook-io.js';
import { isContextIgnored } from './contextignore.js';
import { parseFileStructure, formatDigest } from './file-digest.js';
import {
  estimateReadRangeTokens, estimateVisibleTextTokens,
} from './savings-accounting.js';

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

function normalizeCache(cache) {
  const c = cache || {};
  c.files ||= {};
  c.totalTokensSaved = Number.isFinite(c.totalTokensSaved) ? c.totalTokensSaved : 0; // legacy alias
  c.grossAvoidedReadTokensEstimated = Number.isFinite(c.grossAvoidedReadTokensEstimated)
    ? c.grossAvoidedReadTokensEstimated
    : c.totalTokensSaved;
  c.blockOverheadTokensEstimated = Number.isFinite(c.blockOverheadTokensEstimated)
    ? c.blockOverheadTokensEstimated
    : 0;
  c.blockedReads = Number.isFinite(c.blockedReads) ? c.blockedReads : 0;
  return c;
}

function loadCache(sessionId) {
  const file = join(READ_CACHE_DIR, `${sessionId}.json`);
  return normalizeCache(loadJSON(file));
}

function saveCache(sessionId, cache) {
  saveJSON(join(READ_CACHE_DIR, `${sessionId}.json`), normalizeCache(cache));
}

// ── Range coverage ────────────────────────────────────────────────────────────

function isRangeCovered(ranges, offset, end) {
  if (!ranges || ranges.length === 0) return false;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else merged.push(sorted[i]);
  }
  return merged.some(([s, e]) => s <= offset && e >= end);
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
    return { stale: true, reason: `${formatTokens(newerTokens)} tokens of other files loaded since last read` };
  }
  if (newerFiles >= fileTh) {
    return { stale: true, reason: `${newerFiles} other files loaded since last read` };
  }
  if (isReadCacheTimeStale({
    readAtMs: readTime,
    nowMs: Date.now(),
    quotaMode,
    readCacheTimeStalenessMs: timeMs,
  })) {
    const mins = Math.round((Date.now() - readTime) / 60_000);
    return { stale: true, reason: `${mins} min since last read (time expiry explicitly enabled)` };
  }
  return { stale: false, reason: '' };
}

export const _staleConfig = getStaleThresholds;

// ── Big-file first-read nudge ─────────────────────────────────────────────────

export function shouldNudgeBigFile({ entry, hasOffset, hasLimit, lines, threshold, enabled }) {
  if (!enabled || entry || hasOffset || hasLimit) return false;
  return !!lines && lines >= threshold;
}

function isTargetedRead(toolInput = {}) {
  const currentOffset = Number.isFinite(toolInput.line_offset) && toolInput.line_offset !== 1 && toolInput.line_offset !== 0;
  const legacyOffset = Number.isFinite(toolInput.offset) && toolInput.offset !== 0;
  const currentLimit = Number.isFinite(toolInput.n_lines) && toolInput.n_lines < 1000;
  const legacyLimit = Number.isFinite(toolInput.limit) && toolInput.limit < 1000;
  return {
    hasOffset: currentOffset || legacyOffset,
    hasLimit: currentLimit || legacyLimit,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMtime(filePath) {
  try { return statSync(filePath).mtimeMs; } catch { return null; }
}

function trimPpids(ppids, max = 20) {
  return [...new Set(ppids)].slice(-max);
}

function estimateRange(filePath, offset, end) {
  return estimateReadRangeTokens(filePath, {
    offset,
    limit: Math.max(0, end - offset),
    calibrationFactor: getCalibrationFactor(),
  }).tokensEstimated;
}

function accountBlockOverhead(cache, reason) {
  cache.blockOverheadTokensEstimated += estimateVisibleTextTokens(reason, getCalibrationFactor());
}

function allow(sessionId, cache, filePath, mtime, offset, end, ppid) {
  const tokens = estimateRange(filePath, offset, end);
  const existing = cache.files[filePath];
  cache.files[filePath] = {
    mtime,
    lines: end - offset,
    tokens,
    readAt: new Date().toISOString(),
    readAtMs: Date.now(),
    ranges: [[offset, end]],
    ppids: trimPpids(existing ? [...(existing.ppids || []), ppid] : [ppid]),
  };
  saveCache(sessionId, cache);
  return 'allowed';
}

function buildBlockMessage(filePath, entry, wasPartialRequest, currentSyntax) {
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
    suggestion = currentSyntax
      ? `\n→ ReadFile line_offset=${mid.line}, n_lines=50 for ${mid.label}`
      : `\n→ Read offset=${mid.line - 1}, limit=50 for ${mid.label}`;
  }
  const partialHint = wasPartialRequest ? ' This section is already loaded.' : '';
  return (
    `⛔ [read-cache] Already loaded ${name} this session ` +
    `(${entry.lines} lines, ~${formatTokens(entry.tokens)} estimated tokens).` +
    `${partialHint} File unchanged.\n${digest}${suggestion}`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(event) {
  if (!event || !event.hook_event_name) return;

  if (event.hook_event_name === 'PreCompact' || event.hook_event_name === 'PostCompact') {
    const sessionId = event.session_id || 'unknown';
    const cache = loadCache(sessionId);
    if (Object.keys(cache.files).length > 0) {
      cache.files = {};
      saveCache(sessionId, cache);
    }
    // Silent by design: compaction already happened; narrating it spends more context.
    return;
  }

  const canonical = canonicalToolName(event.tool_name || '');
  if (event.hook_event_name === 'PostToolUse' && (canonical === 'Edit' || canonical === 'Write')) {
    const filePath = resolvePayloadPath(event, getToolPath(event.tool_input || {}));
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

  if (event.hook_event_name !== 'PreToolUse' || canonical !== 'Read') return;

  const toolInput = event.tool_input || {};
  const filePath = resolvePayloadPath(event, getToolPath(toolInput));
  const sessionId = event.session_id || 'unknown';
  const ppid = process.ppid;
  if (!filePath || filePath.startsWith('/dev/') || filePath.startsWith('/proc/')) return;

  const cache = loadCache(sessionId);

  const ignoreResult = isContextIgnored(filePath);
  if (ignoreResult.ignored) {
    const reason = `🚫 [contextignore] ${basename(filePath)} matches "${ignoreResult.pattern}". Use Grep, or remove the rule to read it.`;
    accountBlockOverhead(cache, reason);
    cache.policyBlocks = (cache.policyBlocks || 0) + 1;
    saveCache(sessionId, cache);
    block(reason);
  }

  const totalLines = getFileLines(filePath);
  const { offset, limit, end } = getReadRange(toolInput, totalLines);
  const ext = extname(filePath);
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
    const targeted = isTargetedRead(toolInput);
    const mappable = enabled && !targeted.hasOffset && !targeted.hasLimit && !shouldSkipFile(filePath);
    const lines = mappable ? totalLines : 0;

    if (shouldNudgeBigFile({
      entry,
      hasOffset: targeted.hasOffset,
      hasLimit: targeted.hasLimit,
      lines,
      threshold,
      enabled,
    })) {
      const mtime = getMtime(filePath);
      cache.files[filePath] = {
        mtime,
        lines,
        tokens: estimateRange(filePath, 0, lines),
        readAt: new Date().toISOString(),
        readAtMs: Date.now(),
        ranges: [],
        ppids: [ppid],
        nudged: true,
      };
      cache.bigFileNudges = (cache.bigFileNudges || 0) + 1;

      let digest = '';
      try { digest = formatDigest(parseFileStructure(filePath), lines); } catch { /* best effort */ }
      const reason =
        `🗺️ [read-cache] ${basename(filePath)} is ${lines} lines. ` +
        `Use the map to request only the needed range; repeat the full read if it is genuinely required.\n${digest}`;
      accountBlockOverhead(cache, reason);
      saveCache(sessionId, cache);
      block(reason);
    }

    allow(sessionId, cache, filePath, getMtime(filePath), offset, end, ppid);
    return;
  }

  const currentMtime = getMtime(filePath);
  if (currentMtime === null) return;

  if (currentMtime !== entry.mtime) {
    allow(sessionId, cache, filePath, currentMtime, offset, end, ppid);
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
    entry.tokens += estimateRange(filePath, offset, end);
    entry.readAt = new Date().toISOString();
    entry.readAtMs = Date.now();
    saveCache(sessionId, cache);
    return;
  }

  const staleness = checkStaleness(cache, filePath);
  if (staleness.stale) {
    allow(sessionId, cache, filePath, currentMtime, offset, end, ppid);
    return;
  }

  // Counterfactual direct-input estimate for the blocked result. The result was
  // never tokenized by Kimi, so this can only be ESTIMATED. We intentionally do
  // not multiply by replay amplification.
  const grossAvoided = estimateRange(filePath, offset, end);
  const wasPartialRequest = isTargetedRead(toolInput).hasOffset || isTargetedRead(toolInput).hasLimit;
  const reason = buildBlockMessage(filePath, entry, wasPartialRequest, event.tool_name === 'ReadFile');
  const blockOverhead = estimateVisibleTextTokens(reason, getCalibrationFactor());

  cache.totalTokensSaved += grossAvoided; // legacy field, still an estimate
  cache.grossAvoidedReadTokensEstimated += grossAvoided;
  cache.blockOverheadTokensEstimated += blockOverhead;
  cache.blockedReads += 1;
  cache.lastBlockedRead = {
    at: new Date().toISOString(),
    grossAvoidedTokensEstimated: grossAvoided,
    blockOverheadTokensEstimated: blockOverhead,
    offset,
    limit,
    file: filePath,
  };
  saveCache(sessionId, cache);
  block(reason);
}

if (isMainModule(import.meta.url)) runHook(main);

export { loadCache, saveCache, main };
