#!/usr/bin/env node

/**
 * Notice ledger + pending-delivery queue.
 *
 * The ledger counts MODEL-VISIBLE advisory text, not intentions to speak.
 * Observation hooks may queue text for a later UserPromptSubmit phase, but a
 * queued notice costs zero context tokens until it is actually flushed.
 *
 * KCO_NOTICE_MODE is intentionally process-local:
 *   immediate (default) — print + charge delivered overhead
 *   queue               — queue for next model-visible prompt phase, charge later
 *   silent              — suppress entirely, charge nothing
 */

import { join } from 'path';
import {
  NOTICES_DIR, loadJSON, saveJSON, ensureDataDirs, estimateTokensFromString,
  acquireFileLock,
} from './utils.js';

export const DEFAULT_NOTICE_CAP = 4;
const MAX_PENDING_NOTICES = 16;

export function emptyLedger() {
  return { count: 0, tokensInjected: 0, kinds: {} };
}

export function shouldEmit(ledger, { kind, priority = 'normal', cap = DEFAULT_NOTICE_CAP } = {}) {
  if (priority === 'critical') return true;
  if (!kind) return false;
  if (ledger.kinds[kind]) return false;
  if (ledger.count >= cap) return false;
  return true;
}

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

function lockName(sessionId) {
  return `notices-${String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

export function loadLedger(sessionId) {
  return loadJSON(ledgerFile(sessionId)) || emptyLedger();
}

export function saveLedger(sessionId, ledger) {
  ensureDataDirs();
  saveJSON(ledgerFile(sessionId), ledger);
}

function loadPending(sessionId) {
  const pending = loadJSON(pendingFile(sessionId));
  return pending && Array.isArray(pending.items) ? pending.items : [];
}

export function queueNotice(
  sessionId,
  { kind, text, priority = 'normal', cap = DEFAULT_NOTICE_CAP } = {},
) {
  if (!sessionId || !text) return false;
  ensureDataDirs();
  const release = acquireFileLock(lockName(sessionId));
  try {
    const ledger = loadLedger(sessionId);
    const items = loadPending(sessionId);

    if (priority !== 'critical') {
      if (!kind || ledger.kinds[kind] || items.some((item) => item && item.kind === kind)) return false;
      const pendingNormal = items.filter((item) => item && item.priority !== 'critical').length;
      if (ledger.count + pendingNormal >= cap) return false;
    }

    items.push({ kind, text, priority, queuedAt: new Date().toISOString() });
    if (items.length > MAX_PENDING_NOTICES) items.splice(0, items.length - MAX_PENDING_NOTICES);
    saveJSON(pendingFile(sessionId), { items });
    return true;
  } finally {
    release();
  }
}

export function flushPendingNotices(sessionId) {
  if (!sessionId) return '';
  ensureDataDirs();
  const release = acquireFileLock(lockName(sessionId));
  try {
    const items = loadPending(sessionId);
    if (!items.length) return '';

    saveJSON(pendingFile(sessionId), { items: [] });

    let ledger = loadLedger(sessionId);
    const delivered = [];
    for (const item of items) {
      if (!item || !item.text) continue;
      if (!shouldEmit(ledger, item)) continue;
      delivered.push(item.text);
      ledger = recordEmit(ledger, item);
    }
    if (delivered.length) saveLedger(sessionId, ledger);
    return delivered.join('\n');
  } finally {
    release();
  }
}

export function emitNotice(
  sessionId,
  { kind, text, priority = 'normal', cap = DEFAULT_NOTICE_CAP },
  printFn = console.log,
) {
  if (!sessionId || !text) return false;

  const mode = process.env.KCO_NOTICE_MODE || 'immediate';
  if (mode === 'silent') return false;
  if (mode === 'queue') {
    return queueNotice(sessionId, { kind, text, priority, cap });
  }

  const release = acquireFileLock(lockName(sessionId));
  try {
    const ledger = loadLedger(sessionId);
    if (!shouldEmit(ledger, { kind, priority, cap })) return false;
    printFn(text);
    saveLedger(sessionId, recordEmit(ledger, { kind, text }));
    return true;
  } finally {
    release();
  }
}
