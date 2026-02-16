# Devin Converter: Content Transformation Fixes — Implementation Plan

**Brainstorm:** `docs/brainstorms/2026-03-19-devin-converter-fixes-brainstorm.md`
**File:** `src/converters/claude-to-devin.ts`

## Overview

Fix 7 transformation issues in `transformContentForDevin` so converted playbooks
produce valid Devin-native content. After fixing, re-run `convert --to devin` and
`sync --target devin` to update the live Devin entries.

## Implementation Steps

### Step 1: Fix cross-playbook references (propose_sessions)

In `transformContentForDevin`, the current Step 9 rewrites `"the X playbook"` to
`@macro_name`. Replace this with `propose_sessions` instructions:

**Transform 1a — Task agent calls (Step 1):**
```
Task agent-name(args)
→ Use propose_sessions to start a child session with the [CE] agent:agent-name playbook, passing: args
```

**Transform 1b — Step 9 cross-references (final pass):**
- `Run the X playbook with: args` → `Use propose_sessions to start a child session with the [CE] type:X playbook, passing: args`
- `the X playbook` (standalone) → `the [CE] type:X playbook`

The `playbookRefMap` currently maps name → macro. Extend it to also carry the
`category` so the output can include the correct `[CE] agent:` / `[CE] command:`
prefix. Or use the existing title (`[CE] agent:security-sentinel`) by storing the
full title in the ref map instead of the macro.

### Step 2: Fix bare slash command references

Current Step 4 handles `/namespace:command` but misses bare `/command-name`.
Add a new transform (after Step 4) to catch bare `/command-name` patterns:

```ts
// Bare slash command refs: /deepen-plan → the [CE] command:deepen-plan playbook
result = result.replace(/\/([\w-]+)\b/g, (_match, name: string) => {
  const normalized = normalizeName(name)
  const macro = playbookRefMap?.[normalized]
  if (!macro) return _match
  return `the [CE] command:${normalized} playbook`
})
```
Use `playbookRefMap` to only transform known command names, leaving unknown ones alone.

### Step 3: Fix `#$ARGUMENTS`

Current pattern only catches `$ARGUMENTS`. Extend to also strip the `#` prefix:

```ts
result = result.replace(/#?\$ARGUMENTS/g, "the user-provided input")
```

### Step 4: Fix missed `AskUserQuestion tool` variants

Audit the existing regex. The current two patterns:
```ts
/\*\*(?:Use the |the )?AskUserQuestion(?: tool)?\*\*/gi  // bold
/(?:Use the |the )?AskUserQuestion(?: tool)?/gi          // plain
```
These should cover all variants. Add a test case to verify edge cases like
`"AskUserQuestion tool"` (quoted context) and `AskUserQuestion tool` with no
preceding article.

### Step 5: Rewrite `CLAUDE.md` references

Add a transform:
```ts
result = result.replace(/\bCLAUDE\.md\b/g, "AGENTS.md")
```

### Step 6: Remove `.claude/` → `.devin/` path rewrite

Delete the two lines:
```ts
.replace(/~\/\.claude\//g, "~/.devin/")
.replace(/\.claude\//g, ".devin/")
```
Leave `.claude/` references as-is — they're Claude Code-specific and have no
Devin runtime equivalent.

### Step 7: Strip desktop shell commands

Add a transform to neutralize `open <path>` macOS commands in playbook text:
```ts
// "open docs/plans/..." → "review docs/plans/..."
result = result.replace(/\bopen (docs\/[\w./-]+)/g, "review $1")
```

## playbookRefMap Extension (for Step 1)

To emit `[CE] agent:X` / `[CE] command:X` correctly in propose_sessions output,
change the ref map value from bare macro name to an object with `{ title, category }`:

```ts
type PlaybookRef = { title: string; category: "agent" | "command" | "workflow" }
const playbookRefMap: Record<string, PlaybookRef> = Object.create(null)

for (const agent of plugin.agents) {
  const name = normalizeName(agent.name)
  playbookRefMap[name] = { title: toDevinTitle(name, "agent"), category: "agent" }
}
for (const command of plugin.commands) {
  // ... existing normalization ...
  playbookRefMap[name] = { title: toDevinTitle(name, category), category }
}
```

Then update all call sites of `playbookRefMap` in `transformContentForDevin` to
use `.title` / `.category` instead of the bare string.

## Tests to Update

File: `tests/converter-devin.test.ts` (create if not exists)

- Task agent call → propose_sessions output
- `@agent-name` standalone → `the [CE] agent:X playbook`
- `/workflows:plan` → `the [CE] workflow:workflows-plan playbook`
- `/deepen-plan` (bare) → `the [CE] command:deepen-plan playbook`
- `#$ARGUMENTS` → `the user-provided input`
- `CLAUDE.md` → `AGENTS.md`
- `.claude/` path — not rewritten
- `open docs/plans/foo.md` → `review docs/plans/foo.md`

## Post-Implementation

1. Run `bun test` — all tests pass
2. Re-run `bun run src/index.ts convert --to devin ./plugins/compound-engineering`
3. Re-run `bun run src/index.ts sync --target devin --dry-run` — confirm updates detected
4. Run `sync --target devin --yes` to push corrected content to Devin

## Implementation Order

1. Step 6 (remove path rewrite) — simplest, no new logic
2. Step 5 (CLAUDE.md → AGENTS.md) — one-liner
3. Step 3 (fix #$ARGUMENTS) — one-liner
4. Step 7 (open → review) — one-liner
5. Step 2 (bare slash commands) — small addition
6. Step 1 (propose_sessions + refMap extension) — largest change
7. Step 4 (audit AskUserQuestion) — add test coverage

## Progress

- [ ] Step 6: Remove `.claude/` path rewrite
- [ ] Step 5: CLAUDE.md → AGENTS.md
- [ ] Step 3: Fix `#$ARGUMENTS`
- [ ] Step 7: Strip desktop commands
- [ ] Step 2: Bare slash command refs
- [ ] Step 1: propose_sessions + refMap extension
- [ ] Step 4: Audit AskUserQuestion + add tests
- [ ] Re-convert and re-sync
