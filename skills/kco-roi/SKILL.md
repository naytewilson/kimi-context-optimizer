---
name: kco-roi
description: Calculate monthly token savings and ROI from using the context optimizer
whenToUse: When the user runs /kco-roi or asks how much the plugin is saving them per month
---

# ROI Calculator

Calculate and display the return on investment from using Kimi Context Optimizer.

Parse $ARGUMENTS for sessions per day (default: 5).

Run:
```bash
node ${KIMI_SKILL_DIR}/../../src/roi.js $ARGUMENTS
```

Present the ROI report to the user. Highlight:
1. Monthly and yearly **token** savings — KCO is subscription-honest: tokens and % of window are the primary metric
2. Dollar savings — shown only when the user has configured `pricePerMillionInput`/`pricePerMillionOutput` in `~/.kimi-context-optimizer/config.json`
3. Team-level savings if they work in a team
4. If data comes from real sessions, note how many sessions were analyzed

If the user has no session data yet, explain that the estimate uses industry averages (35% waste) and will become more accurate as they use KCO.
