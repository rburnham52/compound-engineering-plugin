# Devin Converter Content Transformation Fixes — Brainstorm

**Date:** 2026-02-19
**Status:** Ready for planning
**Prerequisite for:** [Devin Sync Command](./2026-02-19-devin-sync-command-brainstorm.md)

---

## What We're Building

Improvements to the `transformContentForDevin()` function in the Claude-to-Devin converter that fix terminology leaks — Claude Code-specific concepts (skills, tools, modes) that survive conversion and confuse Devin during playbook execution.

### The Problem

The converter already handles some transformations (path rewriting, agent references, XML tag stripping), but four categories of issues leak through:

1. **"Skills" terminology** — Devin has no concept of "skills." It has "knowledge entries" and "playbooks." References like "Load the brainstorming skill" cause Devin to search for files that don't exist.

2. **Claude Code tool names** — References to `AskUserQuestion`, `Task tool`, `EnterPlanMode`, `$ARGUMENTS`, and similar tools mean nothing to Devin. There are 36 such references across 19 converted playbooks.

3. **Playbook cross-references** — Devin uses `@playbook_name` to invoke other playbooks within a playbook body. The converter currently uses incorrect reference syntax. All playbook references must use `@macro_name` format.

4. **Macro naming constraints** — Devin macros cannot contain `-` (hyphens). All macros must use `_` (underscores). Current converter doesn't handle this.

### Impact

When Devin encounters these references in playbook instructions, it:
- Tries to navigate to `.devin/skills/` directories that don't exist
- Attempts to invoke "skills" as if they were playbooks or commands
- Fails to resolve cross-playbook references due to wrong syntax
- Fails silently or asks the user for clarification
- Breaks the workflow flow

---

## Why This Approach

Fix at the source (converter) rather than post-processing or manual cleanup because:

1. **One-time fix** — add transformation rules once, all future conversions are clean
2. **Consistent** — every playbook and knowledge entry gets the same treatment
3. **Testable** — unit tests verify each transformation rule
4. **Existing pattern** — `transformContentForDevin()` already handles similar rewrites (paths, agent refs, XML tags)

---

## Key Decisions

### 1. Skill terminology rewrites

| Pattern | Replacement | Example |
|---------|-------------|---------|
| `Load the X skill` | `Refer to the [CE] X knowledge entry` | "Load the brainstorming skill" → "Refer to the [CE] brainstorming knowledge entry" |
| `the X skill` | `the [CE] X knowledge entry` | "See the brainstorming skill" → "See the [CE] brainstorming knowledge entry" |
| `X skill` (standalone) | `[CE] X knowledge entry` | "brainstorming skill for details" → "[CE] brainstorming knowledge entry for details" |
| `SKILL.md` path refs | Knowledge entry reference | "Read skills/brainstorming/SKILL.md" → "Refer to the [CE] brainstorming knowledge entry" |
| `.devin/skills/` paths | Removed or replaced | "Check .devin/skills/**/SKILL.md" → "Check available knowledge entries" |
| `Invoke the X skill` | `Refer to the [CE] X knowledge entry` | Direct invocation → knowledge reference |

### 2. Claude Code tool rewrites

| Pattern | Replacement | Rationale |
|---------|-------------|-----------|
| `AskUserQuestion tool` / `Use AskUserQuestion` | `Ask the user` | Devin can ask users directly |
| `Task tool` / `Task agent()` | Already handled → "Run the X playbook" | Existing transform, verify coverage |
| `EnterPlanMode` | Remove entirely | No equivalent in Devin |
| `ExitPlanMode` | Remove entirely | No equivalent in Devin |
| `$ARGUMENTS` | `the user-provided input` | Devin reads from "What's Needed From User" |
| `Skill tool` | `the knowledge entry` | Skills are knowledge in Devin |
| `TodoWrite tool` | `Track progress` | Generic action |
| `Read tool` / `Grep tool` / `Glob tool` | Keep as-is | Devin has file access tools too |

### 3. Preserve file-access tool references

References to `Read`, `Grep`, `Glob`, `Write`, `Edit` tools should be left as-is — Devin has equivalent file access capabilities and understands these actions contextually.

### 4. Use `[CE]` prefix in knowledge references

When rewriting skill references to knowledge entry references, use the `[CE]` prefix to match the sync command's namespacing convention. This ensures Devin can find the correct knowledge entry by name.

### 5. Naming convention: `[CE] type:name` for titles

All Devin entries use a structured naming convention with type prefix:

| Component | Title Format | Macro Format | Body Reference |
|-----------|-------------|-------------|----------------|
| Agent | `[CE] agent:security-sentinel` | _(none)_ | `@security_sentinel` |
| Workflow | `[CE] workflow:plan` | `workflow_plan` | `@workflow_plan` |
| Command | `[CE] command:deepen-plan` | `deepen_plan` | `@deepen_plan` |
| Knowledge | `[CE] knowledge:brainstorming` | _(none)_ | Refer to `[CE] knowledge:brainstorming` |

Rules:
- **Titles** get `[CE]` prefix + category type + colon + name
- **Macros** only for commands and workflows — NO prefix, hyphens replaced by underscores
- **Agents** do NOT get macros — they are invoked via `@name` references, not slash commands
- **Body references** to other playbooks use `@macro_name` format (where macro = name with underscores)

### 6. Playbook cross-references use `@macro_name`

Within playbook bodies, references to other playbooks must use Devin's `@` invocation syntax:

```
Before: "Run the security-sentinel playbook"
After:  "Run @security_sentinel"

Before: "the workflows-plan playbook"
After:  "@workflow_plan"
```

The converter must:
1. Know the macro name for each converted playbook
2. Rewrite "Run the X playbook" → "Run @macro_name"
3. Rewrite inline playbook references to `@macro_name`

### 7. Macros use underscores, not hyphens

Devin's macro field does not support `-` characters. All macros must replace hyphens with underscores:

```
security-sentinel  →  security_sentinel
deepen-plan        →  deepen_plan
```

This applies to:
- The `macro` field in `POST /v1/playbooks` API calls (commands and workflows only)
- All `@reference` names within playbook bodies

### 8. Filename prefix stripping: `workflows-` → `workflow:`

Files in the `playbooks/workflows/` directory have filenames like `workflows-brainstorm.devin.md`. The `workflows-` prefix must be stripped and replaced with the `workflow:` type:

```
Filename: workflows-brainstorm.devin.md
Title:    [CE] workflow:brainstorm
Macro:    workflow_brainstorm
Body ref: @workflow_brainstorm
```

Rule: if the file is in the `workflows/` subdirectory, strip the `workflows-` filename prefix, use `workflow` as the type (singular, no `s`), and derive the name from the remainder.

---

## Transformation Rules (Implementation Spec)

```typescript
// In transformContentForDevin():

// --- Skill terminology ---

// "Load the X skill" → "Refer to the [CE] X knowledge entry"
result = result.replace(
  /[Ll]oad the [`"]?(\w[\w-]*)[\`"]? skill/g,
  'Refer to the [CE] $1 knowledge entry'
);

// "Invoke the X skill" → "Refer to the [CE] X knowledge entry"
result = result.replace(
  /[Ii]nvoke the [`"]?(\w[\w-]*)[\`"]? skill/g,
  'Refer to the [CE] $1 knowledge entry'
);

// "the X skill" → "the [CE] X knowledge entry"
result = result.replace(
  /the [`"]?(\w[\w-]*)[\`"]? skill(?!\s*(?:directory|file|path))/g,
  'the [CE] $1 knowledge entry'
);

// "SKILL.md" path references
result = result.replace(
  /(?:\.devin\/)?skills\/[\w-]+\/SKILL\.md/g,
  'the corresponding knowledge entry'
);

// ".devin/skills/**" glob patterns
result = result.replace(
  /~?\.devin\/skills\/\*\*\/SKILL\.md/g,
  'available knowledge entries'
);

// --- Claude Code tools ---

// AskUserQuestion
result = result.replace(
  /(?:Use |the )?AskUserQuestion(?: tool)?/gi,
  'Ask the user'
);

// EnterPlanMode / ExitPlanMode (remove lines containing these)
result = result.replace(
  /.*(?:EnterPlanMode|ExitPlanMode).*\n?/g,
  ''
);

// $ARGUMENTS
result = result.replace(
  /\$ARGUMENTS/g,
  'the user-provided input'
);

// Skill tool
result = result.replace(
  /(?:the )?Skill tool/gi,
  'the knowledge entry'
);

// TodoWrite tool
result = result.replace(
  /(?:Use |the )?TodoWrite(?: tool)?/gi,
  'Track progress'
);

// --- Naming convention ---

// Playbook titles: [CE] type:name
// Applied during playbook creation, not content transformation
// Agent: [CE] agent:security-sentinel
// Workflow: [CE] workflow:plan
// Command: [CE] command:deepen-plan
// Knowledge: [CE] knowledge:brainstorming

// Macros: replace hyphens with underscores, no prefix
// security-sentinel → security_sentinel
// workflows:brainstorm → workflow_brainstorm
macro = name.replace(/-/g, '_');

// --- Playbook cross-references ---

// "Run the X playbook" → "Run @macro_name"
// Requires a lookup map from playbook names to their macro names
// Built during conversion phase, applied during content transformation
const playbookMacroMap: Record<string, string> = {
  'security-sentinel': 'security_sentinel',
  'workflows-plan': 'workflow_plan',
  // ... built from all converted playbooks
};

// "Run the X playbook" → "Run @macro"
result = result.replace(
  /[Rr]un the ([\w-]+) playbook/g,
  (_, name) => `Run @${playbookMacroMap[name] || name.replace(/-/g, '_')}`
);

// "the X playbook" → "@macro"
result = result.replace(
  /the ([\w-]+) playbook/g,
  (_, name) => `@${playbookMacroMap[name] || name.replace(/-/g, '_')}`
);
```

---

## Affected Files

Based on grep analysis, **19 playbook files** contain Claude Code terminology:

### Skill references (~30 occurrences):
- `workflows-brainstorm.devin.md` — 4 skill references
- `workflows-plan.devin.md` — 1 skill reference
- `workflows-compound.devin.md` — 2 skill references
- `best-practices-researcher.devin.md` — 15+ skill/SKILL.md references
- `agent-native-audit.devin.md` — 2 skill references
- `create-agent-skill.devin.md` — 3 skill references

### Claude tool references (36 occurrences across 19 files):
- `AskUserQuestion` — workflow playbooks
- `$ARGUMENTS` — command playbooks
- `EnterPlanMode`/`ExitPlanMode` — plan workflow
- `Task tool` — various (mostly already handled)
- `TodoWrite` — work workflow

---

## Edge Cases

1. **"skill" in prose context** — "This is a skill-intensive task" should NOT be rewritten. The regex patterns target specific Claude Code patterns (`the X skill`, `Load the X skill`) not generic uses of the word.
2. **Nested references** — "Load the brainstorming skill for the document-review skill" — each match is independent, both get rewritten.
3. **Already-rewritten content** — Running the converter twice shouldn't double-rewrite. The `[CE]` prefix in replacements prevents re-matching.
4. **Skill names with hyphens** — `dhh-rails-style`, `agent-native-architecture` — the `[\w-]*` pattern handles these.

---

## Open Questions

_None — all questions resolved during brainstorm._

---

## Resolved Questions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Fix in converter or post-process? | Converter | One-time fix, consistent, testable |
| Rewrite skill refs? | Yes, all patterns | Devin has no "skills" concept |
| Rewrite Claude tools? | Yes, all tools | AskUserQuestion, EnterPlanMode, $ARGUMENTS etc. mean nothing to Devin |
| Keep file-access tools? | Yes | Read/Grep/Glob are universal concepts Devin understands |
| Use [CE] prefix in rewrites? | Yes | Matches sync command naming convention |
| Scope? | Separate from sync command | Independent improvement, prerequisite for sync |
| Title format? | `[CE] type:name` | Clear namespacing with category for filtering |
| Macro format? | `name_with_underscores` (no prefix) | Devin macros can't have hyphens; no prefix keeps slash commands clean |
| Cross-playbook refs? | `@macro_name` | Devin's native invocation syntax for playbooks |
| Playbook ref syntax? | `@` not `!` | Devin uses `@` for playbook invocation |
| Agents get macros? | No | Agents are invoked via @name refs, not slash commands. Only commands and workflows get macros. |
| `workflows-` prefix? | Strip to `workflow:` | Singular type prefix, strip redundant filename prefix |

---

## Next Steps

1. Run `/workflows:plan` to implement the transformation rules
2. After shipping, re-run `convert --to devin` to regenerate clean `.devin/` files
3. Then proceed with the sync command brainstorm/plan
