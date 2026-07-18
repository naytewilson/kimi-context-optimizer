---
name: kco-export
description: Export context report as Markdown or HTML
whenToUse: When the user runs /kco-export or asks to export/share their token usage report as a file
---

# Export Context Report

Export the context optimizer report in the specified format.

Parse $ARGUMENTS for the format (default: md).

Run:
```bash
node ${KIMI_SKILL_DIR}/../../src/export.js $ARGUMENTS
```

Show the user the path to the exported file. If HTML, mention they can open it in a browser for a visual dashboard with charts and color-coded metrics.
