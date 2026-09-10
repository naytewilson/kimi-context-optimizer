# KCO Quota Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden KCO against current Kimi Code session/wire behavior and add quota-aware context control without replacing the official client.

**Architecture:** Keep KCO's existing zero-dependency ESM/plugin structure. Strengthen transcript authority and parsing in `wire-usage.js`, add pure quota signals to a focused module, make read-cache time expiry opt-in in quota mode, and deliver actionable observation-hook notices on the next `UserPromptSubmit`.

**Tech Stack:** Node.js >=18, ESM, `node:test`, Kimi Code plugin hooks, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-02-kco-quota-hardening-design.md`

## Global Constraints

- Keep zero runtime dependencies.
- Preserve existing KCO commands and data files where practical.
- Exact session IDs must never resolve to a different session.
- Treat replay amplification as an operational heuristic, not Moonshot billing truth.
- Existing tests must remain green.
- Current Kimi Code CLI documentation as of 2026-09-02 is the external compatibility authority.

---

### Task 1: CI baseline and current-wire contract tests

**Files:**
- Create: `.github/workflows/test.yml`
- Create: `tests/test-quota-hardening.js`

**Interfaces:**
- Consumes: existing `parseWireText`, `findWireFile`, `clearWireCache`.
- Produces: failing tests for exact indexed resolution, `usage.record`, incremental append, and cross-session refusal.

- [ ] **Step 1: Add GitHub Actions matrix** running `npm test` on Node 18, 20, and 22 for PRs and hardening-branch pushes.
- [ ] **Step 2: Add current Kimi `usage.record` fixture test** expecting real context/cumulative usage.
- [ ] **Step 3: Add `session_index.jsonl` exact-resolution tests**, including a deliberately newer unrelated session that must not be selected.
- [ ] **Step 4: Add append test** that grows a real temporary `wire.jsonl` and expects cumulative state to advance correctly.
- [ ] **Step 5: Open a draft PR and record the expected RED CI result** before production changes.

### Task 2: Exact session authority + current wire parser

**Files:**
- Modify: `src/wire-usage.js`
- Test: `tests/test-quota-hardening.js`

**Interfaces:**
- Produces: `findWireFile(sessionId, cwd)`, `parseWireText(text)`, `getSessionUsage(sessionId, cwd)`, `clearWireCache()` with current/legacy schema support.

- [ ] **Step 1: Parse `$KIMI_CODE_HOME/session_index.jsonl` defensively** and normalize `sessionDir` whether absolute or relative.
- [ ] **Step 2: For non-empty `sessionId`, resolve only that ID**, first from the index, then an exact directory scan; otherwise return `null`.
- [ ] **Step 3: For absent `sessionId`, select the newest indexed entry with exact `workDir === cwd`; no global recent-session fallback.
- [ ] **Step 4: Accept `usage.record` rows** and retain legacy `step.end` parsing.
- [ ] **Step 5: Add `recognizedUsageRows`, `wireSchemas`, and `totalInputSide` to usage output while preserving old fields.
- [ ] **Step 6: Run CI until the new authority/schema tests pass and old tests remain green.

### Task 3: Incremental wire reader

**Files:**
- Modify: `src/wire-usage.js`
- Test: `tests/test-quota-hardening.js`

**Interfaces:**
- Internal cache stores file size/mtime, byte offset, trailing partial line, and accumulated parse state.

- [ ] **Step 1: Extend tests to append a second usage row after the initial read.**
- [ ] **Step 2: Implement append-only parsing from the previous byte offset.**
- [ ] **Step 3: Reparse from zero if file size shrinks or cached state is invalid.**
- [ ] **Step 4: Preserve malformed/trailing-line tolerance.**
- [ ] **Step 5: Run full CI matrix green.

### Task 4: Quota signal + adaptive early compaction

**Files:**
- Create: `src/quota-controller.js`
- Modify: `src/budget.js`
- Test: `tests/test-quota-hardening.js`

**Interfaces:**
- `computeReplayAmplification(usage) -> number`
- `shouldRecommendQuotaCompact({ contextTokens, steps, replayAmplification, config }) -> { recommend, reason }`

- [ ] **Step 1: Write pure failing tests** for low-context, insufficient-step, low-amplification, and qualifying cases.
- [ ] **Step 2: Implement the pure controller** with defaults: 80K minimum context, 8 steps, 3.0 amplification.
- [ ] **Step 3: Integrate into budget monitoring** before static 80/90% thresholds and rate-limit through existing notice infrastructure.
- [ ] **Step 4: Label the notice as a quota-efficiency recommendation, never a billing fact.
- [ ] **Step 5: Run full CI matrix green.

### Task 5: Quota-mode read-cache staleness

**Files:**
- Modify: `src/read-cache.js`
- Modify: `src/utils.js`
- Test: `tests/test-quota-hardening.js`

**Interfaces:**
- Config: `quotaMode: true` default, `readCacheTimeStalenessMs: 0` default.

- [ ] **Step 1: Add a failing pure staleness test** showing time alone does not expire an unchanged cached file in quota mode.
- [ ] **Step 2: Make time-based expiry opt-in** via positive `readCacheTimeStalenessMs`.
- [ ] **Step 3: Preserve token/file displacement and file-mtime invalidation.
- [ ] **Step 4: Run full CI matrix green.

### Task 6: Observation-hook notice queue

**Files:**
- Modify: `src/notices.js`
- Modify: `src/budget.js`
- Modify: `kimi.plugin.json`
- Test: `tests/test-quota-hardening.js`

**Interfaces:**
- `queueNotice(sessionId, notice)` persists a bounded pending notice.
- `flushPendingNotices(sessionId)` returns queued text and clears it.
- `UserPromptSubmit` hook flushes pending actionable observations into context.

- [ ] **Step 1: Add failing queue/flush tests.**
- [ ] **Step 2: Queue actionable PostToolUse budget notices instead of relying on observation-hook stdout.**
- [ ] **Step 3: Add a `UserPromptSubmit` flush hook.**
- [ ] **Step 4: Keep `PreToolUse` read blocking unchanged.**
- [ ] **Step 5: Run full CI matrix green.

### Task 7: Live-contract doctor

**Files:**
- Modify: `src/doctor.js`
- Test: `tests/test-quota-hardening.js`

**Interfaces:**
- Doctor reports distinct states: no transcript, recognized current/legacy wire usage, or transcript present but unsupported usage schema.

- [ ] **Step 1: Add fixture tests for recognized and unsupported transcript states.**
- [ ] **Step 2: Integrate `recognizedUsageRows`/`wireSchemas` diagnostics.**
- [ ] **Step 3: Ensure unsupported schema is visible rather than silently described as ground truth.**
- [ ] **Step 4: Run full CI matrix green.

### Task 8: Final review and evidence

**Files:**
- Modify docs only if behavior differs from the design.

- [ ] **Step 1: Compare branch to `main` and review every changed file.**
- [ ] **Step 2: Verify no unrelated files changed.**
- [ ] **Step 3: Record final GitHub Actions job results and exact head SHA.**
- [ ] **Step 4: Leave PR draft if the live Kimi runtime smoke test is still outstanding; mark ready only when cloud-verifiable gates are green and explicitly note the local-only gate.**