---
name: kco-budget
description: Configure token budget limits, auto-compact settings, optional token pricing, and view current budget status (window-aware — reads the active model's context size from config.toml)
whenToUse: When the user runs /kco-budget or asks to set/check the token budget, context limit, auto-compact threshold, or token pricing
---

# Context Budget Manager

Manage the token budget for Kimi Code sessions. Window-aware: the effective
budget is capped by the active model's context window, read live from
`~/.kimi-code/config.toml` (`max_context_size`, e.g. 1M on k3, 256K default).
`KCO_CONTEXT_WINDOW` overrides the window from any source.

Parse $ARGUMENTS:

## `status` (or no arguments)
Show current budget config + auto-compact settings:
```bash
cat ~/.kimi-context-optimizer/config.json 2>/dev/null
echo "---"
cat ~/.kimi-context-optimizer/budget-config.json 2>/dev/null
```
If no config exists, show defaults (200K working budget, warn at 50/70/85/95%,
auto-compact at 90%).

## `set <tokens>`
Update the budget limit. Parse the token count (`200K`, `1M`, `500000` all OK).
Update `~/.kimi-context-optimizer/config.json`:
```json
{
  "budgetTokens": <parsed_number>,
  "warnAt": [50, 70, 85, 95],
  "autoCompactAt": 90
}
```
If `budgetTokens` exceeds the active model's context window (from config.toml),
warn the user — the effective budget is capped to the window anyway.

## Model & pricing

Kimi Code's active model and its context window come from
`~/.kimi-code/config.toml` — there is nothing to set here for window size. The
`model` field in config.json is informational only.

Dollar figures are opt-in (KCO is subscription-honest: without pricing it shows
tokens + % of window only). To enable cost display, set real USD prices in
`~/.kimi-context-optimizer/config.json`:
```json
{
  "pricePerMillionInput": 2.0,
  "pricePerMillionOutput": 8.0
}
```

## `auto <on|off>`
Toggle auto-compact recommendations at thresholds (80% / 90%). Update
`~/.kimi-context-optimizer/budget-config.json`:
- `auto on` → `autoCompactEnabled: true`
- `auto off` → `autoCompactEnabled: false`

Defaults if file missing:
```json
{
  "autoCompactEnabled": true,
  "autoCompactThreshold": 80,
  "criticalThreshold": 90
}
```

## How usage is measured

The budget monitor reads **real per-step context size from wire.jsonl** (the
session wire transcript), not estimates — including `inputCacheRead` /
`inputCacheCreation`, so cache economics are real. Estimates are only a
fallback and self-calibrate against the wire data over time.
