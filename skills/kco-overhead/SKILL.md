---
name: kco-overhead
description: Audit the fixed context overhead every session starts with — system prompt, plugins, skills, AGENTS.md — measured from the real wire transcript
whenToUse: When the user runs /kco-overhead or asks what their baseline/session-startup context cost is
---

# Session Baseline Overhead Audit

Measure how many tokens every session of this project pays BEFORE any work
happens — and where to cut.

Run:

```bash
node ${KIMI_SKILL_DIR}/../../src/overhead.js
```

The report shows:

1. **Baseline** — exact system-prompt size and first-turn context total, read
   from the session's wire transcript (real API usage counts, not estimates),
   as a % of the working budget.
2. **Cost per session** — what that baseline costs to write into the prompt
   cache each session (shown when pricing is configured).
3. **Itemization** — the locally measurable parts (project + global AGENTS.md,
   installed plugins and their skill listings, user skills) and the
   unattributed remainder (core system prompt and tool schemas, fixed by the CLI).
4. **Recommendations** — what to trim and how (e.g. `/kco-agentsmd`,
   uninstalling unused plugins, pruning skill descriptions).

Present the output to the user as-is (it is already formatted). If the report
says no wire transcript was found, explain that the audit needs at least one
completed exchange in a session for this project.

Key framing for the user: baseline overhead is paid in EVERY session, so a
one-time trim repays itself continuously — it is usually the highest-leverage
optimization available.
