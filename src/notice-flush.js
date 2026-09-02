#!/usr/bin/env node

/** Deliver actionable observation-hook notices at a model-visible hook phase. */

import { flushPendingNotices } from './notices.js';
import { isMainModule, runHook } from './hook-io.js';

export async function main(event) {
  if (!event || event.hook_event_name !== 'UserPromptSubmit') return;
  const sessionId = event.session_id || 'unknown';
  const text = flushPendingNotices(sessionId);
  if (text) console.log(text);
}

if (isMainModule(import.meta.url)) runHook(main);
