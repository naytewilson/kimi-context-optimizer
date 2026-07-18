---
name: kco-git
description: Show git-aware context suggestions for the current working directory
whenToUse: When the user runs /kco-git or asks which files to read based on current git changes/branch state
---

# Git-Aware Context Suggestions

Analyze the current git state and suggest which files Kimi should read for the current task.

Run:
```bash
node ${KIMI_SKILL_DIR}/../../src/git-context.js
```

Present the results:
1. **Current branch** and modified files
2. **Suggested files** based on git diff (modified + related test files + configs)
3. **Historical patterns** — files that were frequently useful in this project
4. Ask the user if they want to load any of the suggested files

Do NOT auto-read files. Only suggest and let the user decide.
