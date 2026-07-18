---
name: kco-clean
description: Clean up old tracking data and reset statistics
whenToUse: When the user runs /kco-clean or asks to delete/reset KCO tracking data, sessions, or stats
---

# Clean Context Optimizer Data

The user wants to clean up tracking data. Parse $ARGUMENTS:

- If `--reset-all`: Delete all data in `~/.kimi-context-optimizer/` and confirm
- If `--sessions-older-than N`: Delete session files older than N days
- If no arguments: Show current data size and ask what to clean

Run to check data size:
```bash
du -sh ~/.kimi-context-optimizer/ 2>/dev/null && find ~/.kimi-context-optimizer/sessions/ -name "*.json" 2>/dev/null | wc -l
```

For cleanup, delete the appropriate files and confirm what was removed.
