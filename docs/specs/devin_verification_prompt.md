# Devin Converter Output Verification Prompt

## Overview

Verify that Claude Code plugin content was correctly transformed into Devin-compatible playbooks and knowledge entries by the automated converter.

## Procedure

You are a QA reviewer for converted Devin playbooks. You will be given:
1. A converted playbook or knowledge entry (the output to verify)
2. The conversion rules below

For each converted file, perform a **line-by-line audit** against every rule. Report issues in a structured table. Do not fix anything — only identify and classify issues.

### Step 1: Check all transformation rules were applied

Scan the entire document for violations of each rule. Every rule must be checked — do not skip any.

**Rule 1 — Task agent invocations**
- FAIL pattern: `Task compound-engineering:` or `Task <category>:<agent-name>(` 
- PASS pattern: `Use propose_sessions to start a child session with the [CE] agent:<name> playbook, passing: <args>`
- Search regex: `Task\s+\S+\(`

**Rule 2 — CLAUDE.md references**
- FAIL pattern: `CLAUDE.md`
- PASS pattern: `AGENTS.md`
- Search regex: `CLAUDE\.md`

**Rule 3 — Slash commands (workflow/command type)**
- FAIL pattern: `/ce:<name>`, `/workflows:<name>`, or any bare `/ce_*` slash syntax
- PASS pattern: `` Run `!ce_<name>` `` (inline macro invocation) — or with args: `` Run `!ce_<name>` with: <args> ``
- Agent-type targets (no macro): `Use propose_sessions to start a child session with the [CE] agent:<name> playbook`
- Search regex: `/ce:|/workflows:|/commands:`

**Rule 4 — Slash commands (knowledge/skill type)**
- FAIL pattern: `/deepen-plan`, `/document-review`, or any skill-type slash command
- PASS pattern: `the [CE] knowledge:<name> knowledge entry`
- IMPORTANT: The suffix must be "knowledge entry" not "playbook" for knowledge-type items
- Search regex: `/[a-z]+-[a-z]+` (exclude file paths like `app/services/foo.rb:42`)
- Also check: Any reference saying `[CE] knowledge:<name> playbook` is WRONG — should say `knowledge entry`

**Rule 5 — Claude XML tags stripped**
- FAIL pattern: `<thinking>`, `<examples>`, `<antThinking>`, `<result>`, `<artifacts>`
- PASS: No Claude-specific XML tags present
- Search regex: `<thinking>|<examples>|<antThinking>|<result>|<artifacts>`

**Rule 6 — AskUserQuestion removed**
- FAIL pattern: `AskUserQuestion` (in any form: `AskUserQuestion tool`, `the AskUserQuestion tool`, etc.)
- PASS pattern: `Ask the user`
- Search regex: `AskUserQuestion`

**Rule 7 — $ARGUMENTS removed**
- FAIL pattern: `$ARGUMENTS` or `#$ARGUMENTS`
- PASS pattern: `the user-provided input`
- Search regex: `\$ARGUMENTS`

**Rule 8 — Cross-playbook references**
- FAIL pattern: `Task <agent>(args)` as inline cross-reference
- FAIL pattern: `the ce-plan playbook`, `the ce-work playbook` — unresolved namespaced alias
- PASS pattern for workflow/command: `` Run `!ce_<name>` `` or `` Run `!ce_<name>` with: <args> ``
- PASS pattern for agents: `Use propose_sessions to start a child session with the [CE] agent:<name> playbook`
- Search regex: `^-?\s*Task\s+|the ce-[a-z]+ playbook`

**Rule 9 — Claude Code-only concepts removed**
- FAIL patterns (any of these): `ultrathink`, `LFG`, `SLFG`, `disable-model-invocation`, `Claude Code`, `run in background` with `&`, `start on remote`
- PASS: None of these present
- Search regex: `ultrathink|LFG|SLFG|disable-model-invocation|Claude Code|&\s*$|on remote`

**Rule 10 — File paths preserved (not mangled)**
- CHECK: File path examples like `app/services/foo.rb:42` must remain intact
- FAIL pattern: `app/servicesthe`, `example_service-rb-42`, or any path where `/`, `.rb`, `.py`, `:` were replaced
- Search regex: `app/[a-z]+the\s|_service-rb-|\.rb-\d+|/servicesthe`

### Step 2: Check naming conventions

Verify the title follows the `[CE] type:name` convention:

| Type | Title format | Macro format |
|------|-------------|--------------|
| Agent | `[CE] agent:<name>` | _(none)_ |
| Command | `[CE] command:<name>` | `!ce_<name>` |
| Workflow | `[CE] workflow:<name>` | `!ce_<name>` |
| Knowledge | `[CE] knowledge:<name>` | _(none)_ |

- Verify the title prefix matches the entry type
- For workflows and commands, verify a macro is set (this is metadata, not in the body)

### Step 3: Check for Devin-incompatible patterns

These are issues the converter should catch but may miss:

| Pattern | Issue | Fix |
|---------|-------|-----|
| `open <filepath>` or `xdg-open <filepath>` | Desktop command — Devin has no desktop | Remove or replace with "Present the file to the user" |
| `review <filepath>` as a command | Not a Devin command | Replace with "Present the file contents to the user for review" |
| `Load <name> skill` | Devin skills are repo-level, not loadable by name from playbooks | Replace with `the [CE] knowledge:<name> knowledge entry` if it's a knowledge entry |
| `Run the X playbook with: args` (workflow/command) without macro | Should use inline macro invocation | Replace with `` Run `!ce_<name>` with: args `` for workflow/command playbooks; use `propose_sessions` only for agent-type playbooks |
| `the ce-plan playbook` or `the ce-work playbook` (unresolved namespaced ref) | Converter failed to resolve refMap alias | Should be `` Run `!ce_plan` `` etc. — indicates a converter bug |
| `.claude/` directory paths | Claude Code convention | Replace with `.devin/` if referring to converter output, or remove if referring to runtime config |
| Option numbering gaps (e.g., 1,2,3,5,7) | Artifact of removing Claude Code options | Renumber sequentially |
| Circular fallbacks (e.g., "If AGENTS.md absent, fall back to AGENTS.md") | Logic error from bad find/replace | Fix the fallback target |
| `&` at end of shell commands for background execution | Claude Code background execution pattern | Remove — Devin manages its own execution |

### Step 4: Check structural completeness

For playbooks, verify these Devin-recognized sections are present and well-formed:

- [ ] **Overview** — 1-3 sentences describing goal and expected outcome
- [ ] **Procedure** — Numbered steps, one action per line, imperative voice
- [ ] **Specifications** (if applicable) — Postconditions / expected end state
- [ ] **Forbidden Actions** (if applicable) — Explicit prohibitions

For knowledge entries, verify:
- [ ] `name` follows `[CE] knowledge:<name>` convention
- [ ] `trigger` is specific enough for effective retrieval (not generic like "general coding advice")
- [ ] `body` is focused on a single topic

### Step 5: Cross-reference validation

Check that all playbook/knowledge references point to entries that actually exist:

1. List every `[CE] agent:*`, `[CE] workflow:*`, `[CE] command:*`, and `[CE] knowledge:*` reference in the document
2. For each reference, verify the target exists in the org's playbook/knowledge inventory
3. Flag any references to entries that don't exist

## Output Format

Report findings as:

```markdown
## Verification Report: [playbook/knowledge title]

### Summary
- Rules checked: 10/10
- Rules passed: X/10
- Issues found: N

### Issues

| # | Line | Rule | Severity | Found | Expected |
|---|------|------|----------|-------|----------|
| 1 | 42 | Rule 4 | ERROR | `the [CE] knowledge:deepen-plan playbook` | `the [CE] knowledge:deepen-plan knowledge entry` |
| 2 | 105 | Rule 9 | ERROR | `Run ... & to start in background` | Remove entirely |
| 3 | — | Structural | WARN | Option numbering: 1,2,3,5,7 | Sequential: 1,2,3,4,5 |

### Severity guide
- **ERROR**: Violates a conversion rule — will cause incorrect behavior or confusion
- **WARN**: Structural or cosmetic issue — won't break functionality but should be fixed
- **INFO**: Minor style inconsistency — optional fix

### Cross-references
| Reference | Type | Exists? |
|-----------|------|---------|
| [CE] agent:repo-research-analyst | playbook | YES |
| [CE] knowledge:document-review | knowledge | YES |

### Rules passed
- Rule 1: Task invocations - PASS
- Rule 2: CLAUDE.md references - PASS
- ...
```

## Specifications

- Check EVERY line of the document — do not sample or skip sections
- Report exact line numbers for each issue
- Do not fix issues — only identify and classify them
- If a line could violate multiple rules, report each violation separately
- File paths inside code blocks (```...```) and markdown code examples should still be checked
- A clean report (0 issues) is a valid outcome — do not invent issues
