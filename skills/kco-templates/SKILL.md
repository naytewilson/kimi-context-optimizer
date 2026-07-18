---
name: kco-templates
description: Manage context templates for common task types
whenToUse: When the user runs /kco-templates or wants to save/reuse a named set of files to preload for recurring task types
---

# Context Templates

Context templates are pre-defined sets of files to read for common task types, saving time and tokens by loading only what's needed.

Templates are stored in `~/.kimi-context-optimizer/templates/`.

Parse $ARGUMENTS:

## `list` (or no arguments)
Show all available templates:
```bash
ls ~/.kimi-context-optimizer/templates/*.json 2>/dev/null
```
For each template, show its name, description, and file list.

## `create <name>`
Help the user create a new template. Ask them:
1. What type of task is this for? (e.g., "bug-fix", "new-feature", "refactor", "review")
2. Which files/patterns should be pre-loaded?

Also suggest files based on historical tracking data:
```bash
node ${KIMI_SKILL_DIR}/../../src/tracker.js suggest "$(pwd)"
```

Save the template as `~/.kimi-context-optimizer/templates/<name>.json` with format:
```json
{
  "name": "template-name",
  "description": "What this template is for",
  "files": ["relative/path/to/file1", "relative/path/to/file2"],
  "patterns": ["**/*.config.*", "src/core/**"],
  "preCommands": ["git status", "git log --oneline -5"]
}
```

## `apply <name>`
Read the template and execute:
1. Run any `preCommands`
2. Read the listed files
3. Search for the listed patterns using Glob

This gives Kimi exactly the right context for the task type.

## `delete <name>`
Delete the template file and confirm.
