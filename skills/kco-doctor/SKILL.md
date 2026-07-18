---
name: kco-doctor
description: Health check for the kimi-context-optimizer plugin install — verifies versions, hooks, data dir, config, and reports any issues
whenToUse: When the user runs /kco-doctor, reports the plugin isn't working, or asks to verify the KCO installation
---

# KCO Doctor

When the user runs `/kco-doctor` or reports the plugin "isn't working", run a quick health check.

## How to use

```bash
node ${KIMI_SKILL_DIR}/../../src/doctor.js
```

The doctor always exits 0 (fail-open) and prints PASS/WARN/FAIL per check.

## What it checks

- Plugin manifest `kimi.plugin.json` and `package.json` exist
- Versions are in sync
- Hooks are valid and all expected event types are registered
- All hook scripts present in `src/`
- Data directory `~/.kimi-context-optimizer/` is writable
- Patterns/stats files are parseable and reasonably sized
- User config has a sane budget for the active model's context window
- Node version meets the >=18 requirement

## Presentation

Translate the doctor output into plain language. If anything is `FAIL`, walk the user through the fix:
- versions out of sync → `npm run sync-version`
- stats/patterns files too big → `/kco-clean`
- budget > model window → `/kco-budget set <smaller>` (the window comes from `~/.kimi-code/config.toml`)
- node too old → upgrade Node

If everything is `PASS`, confirm the plugin is healthy (плагин в порядке) and stop.
