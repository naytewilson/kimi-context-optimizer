---
name: kco-agentsmd
description: Analyze AGENTS.md files for token bloat and suggest optimizations
whenToUse: When the user runs /kco-agentsmd or asks to trim/optimize/audit their AGENTS.md instructions file
---

# AGENTS.md Analyzer

Analyze AGENTS.md files in the current project for token bloat and optimization opportunities.

Run the analyzer:

```bash
node ${KIMI_SKILL_DIR}/../../src/agentsmd-analyzer.js "${CWD}"
```

Present the output to the user. The analyzer checks for:
- **Overall size** — files over 2K tokens get flagged
- **Large sections** — sections over 1K tokens
- **Duplicate lines** — repeated content
- **Verbose patterns** — "please make sure to", "it is important that", etc.
- **Long code blocks** — examples over 20 lines
- **Excessive whitespace** — empty lines eating tokens

For each issue found, explain the savings potential and suggest a concrete fix.

If the user wants to apply fixes, help them edit the AGENTS.md directly using the Edit tool.
