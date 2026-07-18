---
name: kco-shield
description: Show ContextShield status and waste protection stats; suggest or apply .contextignore rules from historical waste
whenToUse: When the user runs /kco-shield, asks about waste protection, or wants to block files from being read via .contextignore
---

# ContextShield Status

Show the user the current ContextShield protection status and historical waste prevention stats.

## Subcommands

If the user asked for suggestions (`/kco-shield suggest`) or to apply them
(`/kco-shield apply`), run instead:

```bash
node ${KIMI_SKILL_DIR}/../../src/context-shield.js suggest   # preview .contextignore candidates
node ${KIMI_SKILL_DIR}/../../src/context-shield.js apply     # append them to ./.contextignore
```

`suggest` lists files wasted in 3+ sessions as ready-to-use `.contextignore`
patterns with per-session token savings. `apply` appends them (deduped against
existing rules) so those reads are blocked permanently. Show the output as-is.

## Status report (default)

Run the following command to get pattern data:

```bash
node ${KIMI_SKILL_DIR}/../../src/tracker.js patterns
```

From the patterns data, present:

1. **ContextShield Status**: Active (it runs as a PreToolUse hook on every Read)
2. **Protected Files**: List files with 3+ waste sessions — these trigger warnings before Read
3. **Tokens Saved**: Estimate based on waste history (files that would have been read without shield)
4. **Co-occurrence Groups**: Files that are usually edited together

Format as a clean status report. If no pattern data exists yet, tell the user:
"ContextShield is warming up! It learns from your usage patterns and will start giving you smart suggestions after a few sessions."

End the report with:
```
ContextShield runs automatically on every Read. No configuration needed.
```
