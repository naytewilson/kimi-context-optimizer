/**
 * Hook protocol helpers for Kimi Code hooks (KCO port).
 *
 * Kimi Code hook protocol (verified by live capture — see docs/hook-payloads.md):
 *   - Payload arrives as JSON on stdin: { hook_event_name, session_id, cwd,
 *     tool_name, tool_input, tool_call_id, tool_output, prompt, source, reason, error }.
 *     Read tool input uses `path` (NOT `file_path`); `prompt` in UserPromptSubmit
 *     is an ARRAY of content parts, not a string.
 *   - Block (PreToolUse / Stop / UserPromptSubmit only): reason to STDERR + exit 2.
 *     The model receives the reason as the tool error.
 *   - Advise: text to STDOUT + exit 0 — injected into context as a
 *     `<hook_result hook_event="...">…</hook_result>` block (verified for
 *     UserPromptSubmit; best-effort elsewhere).
 *   - Fail-open: a hook must never crash the session. Any uncaught error,
 *     non-zero≠2 exit, or timeout lets the action through. runHook() enforces this.
 *
 * Pure ESM, zero dependencies.
 */

import { isMainModule } from './utils.js';

// ── stdin ────────────────────────────────────────────────────────────────────

/**
 * Read the hook payload from stdin and parse it as JSON.
 * Returns {} when there is no input, the input is malformed, or the 25s
 * safety timeout fires (resolving with whatever arrived so far — hooks must
 * fail open, never hang the session).
 */
export function readPayload() {
  return new Promise((resolve) => {
    // Not a TTY check: if stdin is already ended (no piped input) resolve fast.
    let raw = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, 25_000);
    timer.unref?.();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    process.stdin.resume();
    // Some environments deliver nothing and no 'end' — the timer covers that.
  });
}

// ── Responses ────────────────────────────────────────────────────────────────

/**
 * Block the current action: reason on stderr, exit code 2.
 * Only valid for blockable events (PreToolUse, Stop, UserPromptSubmit).
 */
export function block(reason) {
  console.error(reason);
  process.exit(2);
}

/**
 * Emit advisory text on stdout. The caller then exits 0 — Kimi injects the
 * stdout into context as a <hook_result> block (verified for UserPromptSubmit,
 * best-effort elsewhere).
 */
export function advise(text) {
  process.stdout.write(String(text) + '\n');
}

// ── Payload accessors ────────────────────────────────────────────────────────

/**
 * Extract the user's prompt text from a UserPromptSubmit payload.
 * Kimi sends `prompt` as an array of content parts — take part[0].text,
 * falling back to joining all text parts, then to a plain string.
 */
export function getPromptText(payload) {
  const p = payload && payload.prompt;
  if (!p) return '';
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) {
    const texts = p
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean);
    return texts.join('\n');
  }
  return '';
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Re-exported so hook modules can import the whole protocol surface from one
// place. Semantics: true only when the module is the process entry point
// (`node src/foo.js`), false when imported (e.g. by tests — importing a hook
// module must NOT start reading stdin or the test process hangs).
export { isMainModule };

/**
 * Run a hook main function with fail-open semantics: any throw is swallowed
 * and the process exits 0, so a broken hook can never crash the session.
 *
 * Usage in hook modules:
 *   if (isMainModule(import.meta.url)) runHook(main);
 * where main(payload) is the hook body.
 */
export async function runHook(main) {
  try {
    const payload = await readPayload();
    await main(payload);
    process.exit(0);
  } catch {
    process.exit(0);
  }
}
