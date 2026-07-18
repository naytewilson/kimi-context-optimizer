---
name: kco-digest
description: Show weekly/daily efficiency digest with score and trends
whenToUse: When the user runs /kco-digest or asks for their context efficiency score, weekly summary, or usage trends
---

# Context Efficiency Digest

Generate and display an efficiency digest for the specified time period.

Parse $ARGUMENTS for the number of days (default: 7).

Run:
```bash
node ${KIMI_SKILL_DIR}/../../src/digest.js $ARGUMENTS
```

Present the digest to the user. Highlight:
1. Their efficiency grade (S/A/B/C/D/F) and what it means
2. Which score components are weakest and how to improve them
3. Token savings opportunities
4. Trend over time — is efficiency improving or declining?

If grade is C or below, provide 3 specific actionable tips.
If grade is A or above, congratulate them and suggest advanced techniques.
