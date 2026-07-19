# Kimi Code hook payloads — verified by live capture (CLI v0.27.0)

Captured 2026-07-18 via `hooks/capture-payload.mjs` + headless `kimi -p` sessions.
Raw log: `hooks/payloads.jsonl`.

## Base fields (every event)

`{ hook_event_name, session_id, cwd }` — `session_id` looks like
`session_<uuid>`; the wire transcript lives at
`~/.kimi-code/sessions/wd_<hash>/<session_id>/agents/main/wire.jsonl`.
Note: `cwd` is fully resolved (`/private/tmp/...` on macOS).

## Per-event extras (observed)

| Event | Extra fields | Notes |
|---|---|---|
| `SessionStart` | `source: "startup"` | matcher values: `startup` / `resume` |
| `UserPromptSubmit` | `prompt` — **array of content parts**, not a string | take `prompt[0].text` (fall back to string join); stdout of the hook is injected into context as `<hook_result hook_event="UserPromptSubmit">…</hook_result>` — VERIFIED the model sees it |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_call_id` | Read input uses **`path`** (not `file_path`), also `offset`/`limit`; Bash uses `command`. Blocking: `console.error(reason); process.exit(2)` — VERIFIED, model receives the reason as the tool error |
| `PostToolUse` | same + **`tool_output`** (full result string) | direct ground truth for output size — no stat guessing needed |
| `PostToolUseFailure` | same + `error: { code, message, retryable }` | fires on blocked/failed calls; blocked-by-hook shows `code:"internal"` with our reason in `message` |
| `SessionEnd` | `reason: "exit"` | |

Not captured but documented: `PreCompact`/`PostCompact` (matcher `manual`/`auto`),
`SubagentStart`/`SubagentStop` (matcher = subagent name), `Stop`, `Notification`.

## Protocol summary for the port

- **Block**: stderr reason + `exit(2)` (blockable events only: PreToolUse, Stop, UserPromptSubmit).
- **Advise**: stdout + `exit(0)` — appended to context (verified for UserPromptSubmit; treat as best-effort elsewhere, keep a notices ledger as fallback).
- Fail-open: non-zero≠2, timeout, crash → allowed. Hooks must never crash the session.
- Plugin hooks run with cwd = plugin root and env `KIMI_PLUGIN_ROOT` — `node ./src/x.js` works.
  Consequence: a relative `tool_input.path` (e.g. `app.js`) resolves against the PLUGIN root,
  not the session project — always pass it through `resolvePayloadPath(payload, p)` (hook-io.js),
  which anchors relatives at the payload's `cwd`. Found the hard way: read-cache never blocked
  relative re-reads until this was fixed.

## wire.jsonl (ground truth, verified)

Records of interest in `~/.kimi-code/sessions/wd_*/<session_id>/agents/*/wire.jsonl`:

- `{"type":"step.end", ... "usage":{"inputOther":N,"output":N,"inputCacheRead":N,"inputCacheCreation":N}}` — per-step real usage; last record's input sum = current context size.
- `{"type":"context.append_loop_event","event":{"type":"tool.result", ... "result":{"output":"…"}}}` — full tool outputs.
- `{"type":"config.update","systemPrompt":"…"}` — exact system-prompt size (overhead audit).
- `{"type":"model", "model":…, "usage":…, "usageScope":…}` — model identity records.
