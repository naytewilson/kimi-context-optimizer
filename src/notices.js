#!/usr/bin/env node

/**
 * Notice ledger + pending-delivery queue.
 *
 * KCO budgets its own advisory output so the optimizer cannot become a context
 * pollutant. Current Kimi Code documents PostToolUse as observation-only while
 * UserPromptSubmit can append returned text to model context, so actionable
 * PostToolUse notices are queued and delivered on the next user prompt.
 */

import { join } from 'path';
import { NOTICES_DIR, loadJSON, saveJSON, ensureDataDirs, estimateTokensFromString } from './utils.js';

export const DEFAULT_NOTICE_CAP = 4;
const MAX_PENDING_NOTICES = 16;

export function emptyLedger() {
  return { count: 0, tokensInjected: 0, kinds: {} };
}

/** Decide whether a notice may be emitted/queued, given the current ledger. */
export function shouldEmit(ledger, { kind, priority = 'normal', cap = DEFAULT_NOTICE_CAP } = {}) {
  if (priority === 'critical') return true;
  if (!kind) return false;
  if (ledger.kinds[kind]) return false;
  if (ledger.count >= cap) return false;
  return true;
}

/** Record one advisory against KCO's own context budget. */
export function recordEmit(ledger, { kind, text = '' }) {
  return {
    count: ledger.count + 1,
    tokensInjected: ledger.tokensInjected + estimateTokensFromString(text),
    kinds: { ...ledger.kinds, [kind]: (ledger.kinds[kind] || 0) + 1 },
  };
}

function ledgerFile(sessionId) {
  return join(NOTICES_DIR, `${sessionId}.json`);
}

function pendingFile(sessionId) {
  return join(NOTICES_DIR, `${sessionId}.pending.json`);
}

export function loadLedger(sessionId) {
  return loadJSON(ledgerFile(sessionId)) || emptyLedger();
}

export function saveLedger(sessionId, ledger) {
  ensureDataDirs();
  saveJSON(ledgerFile(sessionId), ledger);
}

/**
 * Queue an actionable advisory for delivery by the UserPromptSubmit hook.
 * The noise ledger is charged at queue time so duplicate observation events do
 * not create an unbounded pending backlog.
 */
export function queueNotice(
  sessionId,
  { kind, text, priority = 'normal', cap = DEFAULT_NOTICE_CAP } = {},
) {
  if (!sessionId || !text) return false;
  const ledger = loadLedger(sessionId);
  if (!shouldEmit(ledger, { kind, priority, cap })) return false;

  ensureDataDirs();
  const pending = loadJSON(pendingFile(sessionId)) || { items: [] };
  const items = Array.isArray(pending.items) ? pending.items : [];
  items.push({ kind, text, priority, queuedAt: new Date().toISOString() });
  if (items.length > MAX_PENDING_NOTICES) items.splice(0, items.length - MAX_PENDING_NOTICES);
  saveJSON(pendingFile(sessionId), { items });
  saveLedger(sessionId, recordEmit(ledger, { kind, text }));
  return true;
}

/** Return queued text exactly once. Empty queue => empty string. */
export function flushPendingNotices(sessionId) {
  if (!sessionId) return '';
  const pending = loadJSON(pendingFile(sessionId));
  const items = pending && Array.isArray(pending.items) ? pending.items : [];
  if (!items.length) return '';
  // Clear before returning. If a later hook fails, repeating stale directives is
  // less safe than requiring a fresh observation to enqueue another one.
  saveJSON(pendingFile(sessionId), { items: [] });
  return items.map((item) => item && item.text).filter(Boolean).join('\n');
}

/**
 * Immediate advisory for hook phases where stdout is intentionally consumed.
 * PostToolUse callers that need model-visible delivery should use queueNotice().
 */
export function emitNotice(
  sessionId,
  { kind, text, priority = 'normal', cap = DEFAULT_NOTICE_CAP },
  printFn = console.log,
) {
  if (!sessionId || !text) return false;
  const ledger = loadLedger(sessionId);
  if (!shouldEmit(ledger, { kind, priority, cap })) return false;
  printFn(text);
  saveLedger(sessionId, recordEmit(ledger, { kind, text }));
  return true;
}
