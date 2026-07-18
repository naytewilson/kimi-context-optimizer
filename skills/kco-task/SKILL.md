---
name: kco-task
description: Organize work by task and track tokens/cost per task — start a task, list tasks, or mark the active one done. Pairs with /kco-pack to load minimal context per task.
whenToUse: When the user runs /kco-task or wants per-task token attribution — start/switch/list/complete named units of work
---

# Tasks — per-task context & cost

A task is a named unit of work. While a task is active, the tokens the session
spends are attributed to it, so the Control Center (`/kco`) can show cost **per
task**, not just per session. This is how the optimizer helps you *distribute
work by task* while keeping token spend visible and low.

## Commands

Parse the user's argument and run the matching command (working directory scopes
the tasks to the current project):

**Start / switch task** (also closes the previous active task):
```bash
node ${KIMI_SKILL_DIR}/../../src/tasks.js add "<task name>"
```
After starting, suggest packing the minimal context for it:
`/kco-pack "<task name>"`.

**List tasks** (newest first, with per-task tokens + $):
```bash
node ${KIMI_SKILL_DIR}/../../src/tasks.js list
```

**Complete the active task**:
```bash
node ${KIMI_SKILL_DIR}/../../src/tasks.js done
```

## Flow to recommend

1. `/kco-task add "implement X"` — start the task
2. `/kco-pack "implement X"` — load only the files that task needs
3. work…
4. `/kco` — see budget, savings, and this task's cost
5. `/kco-task done` — freeze the task's token/$ total

Only one task is active per project at a time; starting a new one finalizes the
previous task's cost automatically.
