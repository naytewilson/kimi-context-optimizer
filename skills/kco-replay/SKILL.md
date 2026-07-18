---
name: kco-replay
description: Show recent session summaries for quick context recovery
whenToUse: When the user runs /kco-replay or asks what happened in recent sessions, to recover context after a break
---

# Session Replay

Show the user summaries of their recent sessions so they can quickly recover context.

Parse $ARGUMENTS for the number of sessions to show (default: 5).

Run:
```bash
node ${KIMI_SKILL_DIR}/../../src/replay.js $ARGUMENTS
```

Present the output to the user. It shows recent session summaries including:
1. When the session happened and how long it lasted
2. Which files were edited
3. Token usage and waste percentage

If no summaries exist yet, tell the user:
"No session summaries yet. They're generated automatically at the end of each session — just keep working!"
