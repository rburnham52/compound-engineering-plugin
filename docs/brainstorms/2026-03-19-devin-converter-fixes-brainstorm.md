---
date: 2026-03-19
topic: devin-converter-fixes
---

# Devin Converter: Content Transformation Fixes

## What We're Building

Fixes to `src/converters/claude-to-devin.ts` to produce correct Devin-native
playbook content. Devin's review of converted playbooks identified several
transformation rules that produce invalid or misleading output.

## Why This Approach

The converter does a single-pass content transformation on Claude Code content
before writing `.devin.md` playbook files. Fixing the transformer rules produces
correct output for all future `convert --to devin` runs, which then flows through
to correct synced content in Devin via `sync --target devin`.

## Issues to Fix

### 1. Wrong cross-playbook reference syntax

**Current:** `@macro_name` inline (e.g. `@security_sentinel`)
**Problem:** `@` in Devin refers to repo-level skills, not playbooks. Inline
`@macro_name` does not invoke another playbook.
**Fix:** Replace with `propose_sessions` instruction:
- `Task agent-name(args)` → `Use propose_sessions to start a child session with the [CE] agent:agent-name playbook, passing: args`
- `Run @macro with: args` (current step 9 output) → same pattern
- Standalone `@macro` references → `the [CE] type:name playbook`

### 2. Slash command references not fully transformed

**Current:** `/deepen-plan`, `/technical_review`, `/workflows:plan` → `the X playbook` (text only)
**Problem:** The existing rule handles `/namespace:command` but misses bare
`/command-name` references (no namespace). These remain as-is in output.
**Fix:** Add a transform for bare `/command-name` patterns that maps to
`the [CE] command:command-name playbook` using the playbookRefMap.

### 3. Residual `$ARGUMENTS` and `#$ARGUMENTS`

**Current:** `$ARGUMENTS` is replaced but `#$ARGUMENTS` (comment-style) is missed.
**Fix:** Broaden the pattern to also strip the `#` prefix variant.

### 4. Untransformed `AskUserQuestion tool` variants

**Current:** Some variants like `"AskUserQuestion tool"` (quoted or in different
case) are missed by the existing regex.
**Fix:** Audit and tighten the regex to catch all variants reliably.

### 5. `CLAUDE.md` references

**Current:** `CLAUDE.md` left as-is.
**Fix:** Rewrite `CLAUDE.md` → `AGENTS.md` (the Devin-compatible equivalent per
the repo's own convention).

### 6. Desktop/shell commands in playbook text

**Current:** `open docs/plans/...` type commands left as-is.
**Problem:** These are macOS/desktop commands that won't work in Devin's environment.
**Fix:** Strip or replace with `review docs/plans/...` (natural language instruction).

### 7. `.devin/` path convention

**Current:** `.claude/` → `.devin/` 
**Problem:** `.devin/` is not a standard Devin runtime convention. Devin uses
the platform (playbooks/knowledge), not repo directories.
**Fix:** Drop the path rewrite entirely, or replace with the platform equivalent
description: "the Devin platform configuration".

## Key Decisions

- **propose_sessions pattern** — Use explicit `propose_sessions` instructions for
  all agent/playbook delegation (matches Kiro's `use_subagent` pattern).
- **Natural language for unknowns** — If a referenced name isn't in the
  playbookRefMap, keep the original text rather than emitting a broken reference.
- **No `.devin/` path rewrite** — Remove the `.claude/` → `.devin/` rule since
  it produces a path that has no runtime meaning in Devin.
- **CLAUDE.md → AGENTS.md** — Use AGENTS.md as the Devin-compatible instruction
  file name.

## Resolved Questions

- **propose_sessions vs natural language**: Use propose_sessions (explicit Devin API
  reference mirrors how Kiro uses use_subagent).

## Resolved Questions (continued)

- **`.devin/` path rewrite**: `.claude/` paths appear in 24 source files (skills,
  agents). In Devin's runtime there is no file-based config directory — drop the
  rewrite entirely. Leave `.claude/` references as-is or replace with a generic
  description like "your Claude Code config".

## Next Steps

→ `/workflows-plan` for implementation details
