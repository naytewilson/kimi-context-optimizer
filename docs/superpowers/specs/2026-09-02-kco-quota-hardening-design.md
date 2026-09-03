# KCO Quota Hardening Design

**Date:** 2026-09-02

## Goal

Make KCO trustworthy against current Kimi Code CLI behavior and optimize for useful work per membership credit, not merely raw context-window occupancy.

## Source truth

- Fork baseline: `naytewilson/kimi-context-optimizer` at `547210f21e5f18f88ae5633c7c94144ff704a4b2`.
- Current Kimi Code CLI docs (2026-09-02) specify `$KIMI_CODE_HOME` (default `~/.kimi-code`), `session_index.jsonl`, `sessions/<workDirKey>/<sessionId>/agents/main/wire.jsonl`, snake_case hook payload fields, and observation-only `PostToolUse`.
- Current Kimi Code wire usage observed by ecosystem consumers uses `usage.record` rows with `usage.inputOther`, `usage.inputCacheRead`, `usage.inputCacheCreation`, and `usage.output`.

## Design

### 1. Exact session authority

`findWireFile(sessionId, cwd)` must use `session_index.jsonl` as the first authority. A non-empty `sessionId` must never silently fall back to another session. If an exact indexed path is unavailable, a bounded exact directory scan may look for that same `sessionId`; otherwise return `null`.

When `sessionId` is absent (CLI/reporting commands), resolve the most recent indexed session whose `workDir` exactly matches the requested cwd. Do not select an arbitrary recently modified transcript from another working directory.

### 2. Current + legacy wire compatibility

The parser accepts both:

- current `usage.record` + camelCase usage fields; and
- legacy `step.end` usage rows.

It records recognized usage-row count and schema kinds so diagnostics can distinguish ground truth from estimation fallback. Unknown rows remain fail-open.

### 3. Incremental append-only parsing

Hot-path reads keep a per-wire cache containing byte offset, trailing partial line, file identity/size, and accumulated parse state. When the file only grows, parse only appended bytes. If it shrinks or is replaced, reparse from byte zero. The public `parseWireText()` remains deterministic for unit tests.

### 4. Quota-aware control

Expose real cumulative input-side usage and a replay-amplification metric:

`replayAmplification = (inputOther + cacheRead + cacheCreation) / max(inputOther + cacheCreation, 1)`

This is an operational signal, not a claim about Moonshot's internal credit formula. Budget logic may recommend compaction earlier than the static context threshold when all are true:

- current context is substantial (>= 80K tokens),
- at least 8 recognized model-usage steps exist, and
- replay amplification is >= 3.0.

The recommendation is rate-limited through KCO's existing notice ledger. Static 200K working-budget thresholds remain as a backstop.

### 5. Read-cache staleness

In quota mode, wall-clock time alone does not make an unchanged file stale. Re-read decisions continue to honor file modification, compaction, agent/process isolation, and token/file displacement. An opt-in `readCacheTimeStalenessMs` config value restores time-based expiry when desired.

### 6. Live-contract diagnostics

`/kco-doctor` must verify that the current data root/session layout is reachable and that at least one recent transcript contains recognized usage rows. If transcripts exist but no supported usage schema is recognized, report a visible failure/warning rather than silently presenting estimates as ground truth.

### 7. Hook semantics

Observation-only hooks remain silent unless Kimi explicitly consumes their output. Actionable budget notices are queued in KCO state and flushed through `UserPromptSubmit`, whose returned text is documented to be appended to model context. Blocking read-cache messages remain on `PreToolUse`, which supports blocking.

## Non-goals

- No authentication changes, account sharing, quota bypass, client spoofing, or provider protocol manipulation.
- No replacement of the official Kimi client.
- No broad refactor of KCO reporting/UI.
- No claim that cache reads are free or that the amplification metric equals Kimi credits.

## Verification

1. Existing test suite remains green.
2. New unit tests cover exact session-index resolution, no cross-session fallback, current `usage.record`, legacy compatibility, incremental append behavior, replay-amplification calculation, quota-mode read staleness, and queued-notice delivery.
3. GitHub Actions runs `npm test` on Node 18, 20, and 22 for pull requests and pushes to the hardening branch.
4. Final review compares the branch to `main` and records the exact head SHA and CI result.

## Remaining local-only gate

A real Kimi Code installation is required only for the final live smoke test of hook payloads and transcript shape. Cloud verification can prove repository behavior and compatibility against documented/fixture contracts, but cannot prove the user's installed runtime emits them.