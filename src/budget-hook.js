#!/usr/bin/env node

/**
 * Production hook boundary for budget.js.
 *
 * PostToolUse is observational. Its stdout is not allowed to narrate directly
 * into Kimi's next context: budget notices are queued, deduped, and charged to
 * KCO overhead only if a later UserPromptSubmit actually delivers them.
 */

import { main as budgetMain } from './budget.js';
import { isMainModule, normalizeHookPayload, runHook } from './hook-io.js';
import { getSessionUsage } from './wire-usage.js';
import { computeReplayAmplification, shouldRecommendQuotaCompact } from './quota-controller.js';
import { queueNotice } from './notices.js';
import { loadConfig } from './utils.js';

export async function main(payload) {
  const event = normalizeHookPayload(payload);
  const previousMode = process.env.KCO_NOTICE_MODE;
  process.env.KCO_NOTICE_MODE = 'queue';

  try {
    await budgetMain(event);

    if (event.hook_event_name !== 'PostToolUse') return;
    const sessionId = event.session_id || 'unknown';
    const usage = getSessionUsage(sessionId, event.cwd || process.cwd());
    if (!usage || !usage.contextTokens || !usage.steps) return;

    const replayAmplification = computeReplayAmplification(usage);
    const decision = shouldRecommendQuotaCompact({
      contextTokens: usage.contextTokens,
      steps: usage.steps,
      replayAmplification,
      config: loadConfig(),
    });
    if (!decision.recommend) return;

    queueNotice(sessionId, {
      kind: 'budget:quota-replay',
      text:
        `[context-budget] Quota-efficiency signal: ${decision.reason}. ` +
        `Consider /compact if the active task can be summarized cleanly. ` +
        `This is replay telemetry, not an estimate of Kimi subscription credits saved.`,
      priority: 'normal',
    });
  } finally {
    if (previousMode === undefined) delete process.env.KCO_NOTICE_MODE;
    else process.env.KCO_NOTICE_MODE = previousMode;
  }
}

if (isMainModule(import.meta.url)) runHook(main);
