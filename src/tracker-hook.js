#!/usr/bin/env node

/**
 * Production hook boundary for tracker.js.
 *
 * The tracker core retains its legacy CLI and test surface. This wrapper:
 *   1. normalizes current/recent Kimi payload generations;
 *   2. keeps high-frequency observation hooks silent so telemetry cannot spend
 *      the context it is measuring;
 *   3. leaves rare actionable failure advice model-visible and ledger-accounted.
 */

import { handleHookEvent } from './tracker.js';
import { isMainModule, normalizeHookPayload, runHook } from './hook-io.js';

const SILENT_NOTICE_EVENTS = new Set(['PostToolUse']);
const SILENT_STDOUT_EVENTS = new Set(['SessionStart']);

async function withSuppressedStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true);
  try {
    return await fn();
  } finally {
    process.stdout.write = original;
  }
}

export async function main(payload) {
  const event = normalizeHookPayload(payload);
  const previousMode = process.env.KCO_NOTICE_MODE;
  if (SILENT_NOTICE_EVENTS.has(event.hook_event_name)) {
    process.env.KCO_NOTICE_MODE = 'silent';
  }

  try {
    if (SILENT_STDOUT_EVENTS.has(event.hook_event_name)) {
      await withSuppressedStdout(() => handleHookEvent(event));
    } else {
      await handleHookEvent(event);
    }
  } finally {
    if (previousMode === undefined) delete process.env.KCO_NOTICE_MODE;
    else process.env.KCO_NOTICE_MODE = previousMode;
  }
}

if (isMainModule(import.meta.url)) runHook(main);
