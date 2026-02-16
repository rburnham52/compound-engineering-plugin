---
title: "feat: Fix Devin converter content transformations"
type: feat
status: completed
date: 2026-02-19
deepened: 2026-02-19
---

# Fix Devin Converter Content Transformations

## Enhancement Summary

**Deepened on:** 2026-02-19
**Sections enhanced:** 5
**Review agents used:** TypeScript Reviewer, Architecture Strategist, Pattern Recognition Specialist, Code Simplicity Reviewer, Security Sentinel

### Key Improvements
1. **Simplified two-pass to lightweight pre-scan** — Replace `rawPlaybooks` intermediate structure with a lightweight name-scanning pass (~50 LOC saved)
2. **Security hardening for macro map** — Use `Object.create(null)` to prevent prototype pollution in playbook name lookups
3. **Cross-reference safety** — Only rewrite known playbook names, preserve original text for unknown names instead of blind underscore fallback
4. **Consolidated helpers** — Merge `toDevinTitle()` and `toDevinKnowledgeTitle()` into a single function, extract `[CE]` prefix as constant
5. **Regex consistency** — Standardize all patterns to use `gi` flag (case-insensitive + global)

### New Considerations Discovered
- Cross-reference fallback (`name.replace(/-/g, '_')`) can silently produce broken `@` references for names that don't correspond to real playbooks
- The `rawPlaybooks` intermediate array duplicates much of `DevinPlaybook` — a lightweight pre-scan that only collects names is simpler
- Prototype pollution risk if playbook names collide with `Object.prototype` properties (e.g., `constructor`, `toString`)
- Bold markdown patterns like `**AskUserQuestion tool**` need dedicated handling separate from plain-text patterns

## Overview

Improve the Claude-to-Devin converter to eliminate four categories of terminology leaks that confuse Devin during playbook execution: skill references, Claude Code tool names, incorrect cross-reference syntax, and macro naming constraints. This also introduces the `[CE] type:name` title convention and macro field support.

## Problem Statement

The converter (`src/converters/claude-to-devin.ts`) produces 50+ playbooks and 19 knowledge entries, but the content contains ~66+ references to Claude Code-specific concepts that Devin cannot understand:

- **~30 "skill" references** — Devin has no "skills" concept; it has knowledge entries
- **~36 Claude tool references** — `AskUserQuestion`, `$ARGUMENTS`, `EnterPlanMode` are meaningless to Devin
- **Incorrect cross-references** — "the security-sentinel playbook" instead of `@security_sentinel`
- **No macro support** — playbooks can't be invoked as slash commands
- **Wrong title format** — uses `toTitleCase()` instead of `[CE] type:name`

## Proposed Solution

Extend the existing `transformContentForDevin()` function with new transformation rules, refactor the conversion pipeline to two-pass (build macro map first, then transform content), and update title/macro generation.

## Technical Approach

### Architecture: Lightweight Pre-Scan + Transform

The current converter is single-pass — it converts each agent/command independently. The new cross-reference feature requires knowing ALL playbook names before transforming ANY content. Rather than a heavyweight two-pass architecture with intermediate structures, use a **lightweight pre-scan** that collects only names:

```
Pre-scan: Collect all component names, build playbookRefMap
  ├── Scan agent names → { "security-sentinel": "security_sentinel" }
  ├── Scan command names → { "deepen-plan": "deepen_plan" }
  └── Scan workflow names → { "brainstorm": "workflow_brainstorm" }

Convert: Single pass with map available
  ├── convertAgentToPlaybook(agent, playbookRefMap)
  ├── convertCommandToPlaybook(command, playbookRefMap)
  └── convertSkillToKnowledge(skill)
```

### Research Insights (Architecture)

**Why pre-scan over two-pass:**
- The original plan's `rawPlaybooks` intermediate array (~50 LOC) duplicates most of `DevinPlaybook` just to defer content transformation
- A pre-scan that only collects names and builds the macro map is ~15 LOC
- Each conversion function can then call `transformContentForDevin()` directly with the map
- This preserves the existing single-pass converter pattern used by other converters in the codebase, reducing divergence

**Naming:**
- Rename `playbookMacroMap` → `playbookRefMap` — the map resolves cross-references, not just macros (agents don't have macros but DO get `@` references)

### Implementation Phases

#### Phase 1: Type and Title Changes

**Files:** `src/types/devin.ts`, `src/converters/claude-to-devin.ts`

**1a. Add `macro` field to `DevinPlaybook` type**

```typescript
// src/types/devin.ts
export type DevinPlaybook = {
  name: string
  content: string
  category: "agent" | "command" | "workflow"
  macro?: string  // NEW: slash command binding (commands/workflows only)
}
```

**1b. Add `toDevinTitle()` function**

Replace `toTitleCase()` usage with a single unified function that generates `[CE] type:name` titles for all component types:

```typescript
// src/converters/claude-to-devin.ts
const CE_PREFIX = '[CE]'

type DevinCategory = "agent" | "command" | "workflow" | "knowledge"

function toDevinTitle(name: string, category: DevinCategory): string {
  return `${CE_PREFIX} ${category}:${name}`
}
```

This replaces both `toTitleCase()` (which becomes dead code — delete it) and avoids the need for a separate `toDevinKnowledgeTitle()`. Knowledge entries use `toDevinTitle(name, "knowledge")`.

**1c. Add `toMacroName()` function**

```typescript
function toMacroName(name: string): string {
  return name.replace(/-/g, '_')
}
```

**1d. Update `convertAgentToPlaybook()`**

```diff
- const title = agent.description
-   ? toTitleCase(agent.name)
-   : agent.name
+ const title = toDevinTitle(name, "agent")
```

No macro for agents.

**1e. Update `convertCommandToPlaybook()`**

```diff
- const title = command.description
-   ? toTitleCase(command.name)
-   : command.name
+ const category = command.name.startsWith("workflows:") ? "workflow" : "command"
+ const title = toDevinTitle(name, category)
+ const macro = toMacroName(name)
```

Return macro in the playbook object.

**1f. Handle `workflows-` prefix stripping**

In `convertCommandToPlaybook()`, when generating the name for workflow commands:

```typescript
// workflows:brainstorm → brainstorm (strip namespace prefix for the name)
// The normalizeName() already converts "workflows:brainstorm" to "workflows-brainstorm"
// We need to strip the "workflows-" prefix for workflow names
let normalizedName = normalizeName(command.name)
if (command.name.startsWith("workflows:")) {
  normalizedName = normalizedName.replace(/^workflows-/, '')
}
```

This produces:
- Filename: `brainstorm.devin.md` (in `playbooks/workflows/` directory)
- Title: `[CE] workflow:brainstorm`
- Macro: `workflow_brainstorm` (category prefix added to macro for workflows)

For workflow macros, prefix with `workflow_`:
```typescript
const macro = category === "workflow"
  ? `workflow_${toMacroName(normalizedName)}`
  : toMacroName(normalizedName)
```

**1g. Update knowledge entry title**

```diff
// convertSkillToKnowledge()
- title: skill.name,
+ title: toDevinTitle(normalizeName(skill.name), "knowledge"),
```

**1h. Update writer to include macro**

In `writeDevinBundle()`, include macro in the playbook output:

```diff
// src/targets/devin.ts - for knowledge entries, add knowledge title
await writeJson(path.join(paths.knowledgeDir, `${entry.name}.json`), {
  title: entry.title,
  body: entry.body,
  trigger_description: entry.triggerDescription,
})
```

Note: The `macro` field is metadata for the Devin API, not for the local `.devin.md` file. The writer writes `.devin.md` files (which are just markdown), not API payloads. The macro will be used by the sync command (future work) when uploading to the API. For now, store the macro on the `DevinPlaybook` object so it's available for the sync command later.

#### Phase 2: Content Transformation Rules

**File:** `src/converters/claude-to-devin.ts`

Add new transformations to `transformContentForDevin()`. The function signature changes to accept the ref map:

```typescript
export function transformContentForDevin(
  body: string,
  playbookRefMap?: Record<string, string>
): string
```

### Research Insights (Content Transforms)

**Regex consistency:** Standardize ALL regex patterns to use the `gi` flag (global + case-insensitive). The original plan mixed `g`, `gi`, and no flags across patterns. Consistency prevents bugs where a capitalized variant (e.g., `THE brainstorming SKILL`) slips through.

**Transform ordering matters:** The transforms must run in this order:
1. Existing transforms (Task agent calls, path rewriting, @agent refs, slash commands, XML tag stripping)
2. Skill terminology rewrites
3. Claude Code tool rewrites
4. Playbook cross-references (LAST — these consume "the X playbook" text that earlier transforms may produce)

**2a. Skill terminology rewrites** (add after existing XML tag stripping)

```typescript
// "Load/Invoke the X skill" → "Refer to the [CE] knowledge:X knowledge entry"
result = result.replace(
  /(?:Load|Invoke) the [`"]?([\w][\w-]*)[\`"]? skill/gi,
  (_match, name) => `Refer to the [CE] knowledge:${name} knowledge entry`
)

// "the X skill" (not followed by directory/file/path)
result = result.replace(
  /the [`"]?([\w][\w-]*)[\`"]? skill(?!\s*(?:directory|file|path))/gi,
  (_match, name) => `the [CE] knowledge:${name} knowledge entry`
)

// SKILL.md path references
result = result.replace(
  /(?:\.devin\/)?skills\/([\w-]+)\/SKILL\.md/g,
  (_match, name) => `the [CE] knowledge:${name} knowledge entry`
)

// .devin/skills/**/*.md glob patterns
result = result.replace(
  /~?\.devin\/skills\/\*\*\/SKILL\.md/g,
  'available knowledge entries'
)
```

**2b. Claude Code tool rewrites**

```typescript
// AskUserQuestion → "Ask the user" (handles both plain and **bold** markdown)
result = result.replace(
  /(\*\*)?(?:Use the |the )?AskUserQuestion(?: tool)?(\*\*)?/gi,
  (_match, openBold, closeBold) =>
    openBold && closeBold ? '**Ask the user**' : 'Ask the user'
)

// EnterPlanMode / ExitPlanMode — remove only the reference, not the full line
// (SpecFlow identified that full-line removal can destroy multi-content lines)
result = result.replace(
  /(?:Use )?(?:the )?(?:EnterPlanMode|ExitPlanMode)(?: tool)?/gi,
  ''
)

// $ARGUMENTS → "the user-provided input"
result = result.replace(
  /\$ARGUMENTS/g,
  'the user-provided input'
)

// Skill tool → "the knowledge entry"
result = result.replace(
  /(?:the )?Skill tool/gi,
  'the knowledge entry'
)

// TodoWrite tool → "Track progress"
result = result.replace(
  /(?:Use the |the )?TodoWrite(?: tool)?/gi,
  'Track progress'
)
```

**2c. Playbook cross-references** (only if `playbookRefMap` is provided)

```typescript
if (playbookRefMap) {
  // Combined: "Run the X playbook" and "the X playbook" → "@macro"
  result = result.replace(
    /(?:Run )?the ([\w-]+) playbook/gi,
    (_match, name) => {
      const macro = playbookRefMap[name]
      if (!macro) return _match  // preserve original text for unknown names
      return _match.toLowerCase().startsWith('run')
        ? `Run @${macro}`
        : `@${macro}`
    }
  )
}
```

### Research Insights (Cross-References)

**Critical safety fix:** The original plan used `playbookRefMap[name] || name.replace(/-/g, '_')` as a fallback. This silently produces broken `@` references for text that happens to match the pattern but isn't an actual playbook name (e.g., "the error-handling playbook" in prose that predates conversion). **Only rewrite names that exist in the map.** Unknown names should preserve the original text.

**Combine patterns:** The "Run the X playbook" and "the X playbook" patterns can be merged into a single regex with an optional `Run ` prefix, reducing duplication and ensuring both patterns use the same safety logic.

**Case sensitivity:** Add `gi` flag — playbook references may appear at start of sentences (`The security-sentinel playbook...`).

**Ordering note:** These cross-reference rewrites MUST run AFTER the existing Task agent() and @agent transforms (which already produce "the X playbook" text), so the cross-reference pass converts those intermediate results to the final `@macro` format.

#### Phase 3: Pre-Scan + Single-Pass Conversion

**File:** `src/converters/claude-to-devin.ts`

Refactor `convertClaudeToDevin()` with a lightweight pre-scan followed by the existing conversion functions:

```typescript
export function convertClaudeToDevin(
  plugin: ClaudePlugin,
  _options: ClaudeToDevinOptions
): DevinBundle {
  const usedPlaybookNames = new Set<string>()
  const usedKnowledgeNames = new Set<string>()

  // === PRE-SCAN: Build ref map from all component names ===
  const playbookRefMap: Record<string, string> = Object.create(null)

  for (const agent of plugin.agents) {
    const name = normalizeName(agent.name)
    playbookRefMap[name] = toMacroName(name)
  }
  for (const command of plugin.commands) {
    let name = normalizeName(command.name)
    const isWorkflow = command.name.startsWith("workflows:")
    if (isWorkflow) name = name.replace(/^workflows-/, '')
    playbookRefMap[name] = isWorkflow
      ? `workflow_${toMacroName(name)}`
      : toMacroName(name)
  }

  // === CONVERT: Single pass with ref map available ===
  const playbooks: DevinPlaybook[] = [
    ...plugin.agents.map(agent =>
      convertAgentToPlaybook(agent, usedPlaybookNames, playbookRefMap)
    ),
    ...plugin.commands.map(command =>
      convertCommandToPlaybook(command, usedPlaybookNames, playbookRefMap)
    ),
  ]

  // Convert skills to knowledge entries
  const knowledgeEntries = plugin.skills.map(skill =>
    convertSkillToKnowledge(skill, usedKnowledgeNames)
  )

  // MCP and hooks handling (unchanged)
  let mcpSetupInstructions: string | undefined
  if (plugin.mcpServers?.length) {
    mcpSetupInstructions = generateMcpSetupInstructions(plugin.mcpServers)
    console.warn("...")
  }
  if (plugin.hooks?.length) {
    console.warn("...")
  }

  return { playbooks, knowledgeEntries, mcpSetupInstructions }
}
```

### Research Insights (Pipeline Architecture)

**Why this is simpler than the original two-pass plan:**
- The original plan introduced a `rawPlaybooks` intermediate array with 6 fields, duplicating most of `DevinPlaybook`, just to defer content transformation
- The pre-scan approach adds ~15 LOC to collect names upfront, then passes the map into the existing conversion functions
- Each conversion function calls `transformContentForDevin(body, playbookRefMap)` internally — no separate "Pass 2" loop needed
- Estimated ~50 LOC savings vs the original intermediate-array approach

**`Object.create(null)` for the ref map:**
- A plain `{}` has inherited `Object.prototype` properties (`constructor`, `toString`, `valueOf`)
- If a playbook were ever named `constructor` or `__proto__`, the lookup would return a function instead of `undefined`
- `Object.create(null)` creates a truly empty map — safe for arbitrary playbook names

**Mutation avoidance:**
- The original plan mutated `pb.sections.procedure` inside a `.map()` callback, which is a code smell
- The pre-scan approach avoids this: each conversion function transforms content internally and returns a clean `DevinPlaybook`

#### Phase 4: Update Tests

**File:** `tests/devin-converter.test.ts`

**4a. New test cases for `transformContentForDevin()`**

```typescript
describe("skill terminology rewrites", () => {
  test("rewrites 'Load the X skill'", () => {
    const input = 'Load the brainstorming skill for question techniques'
    const result = transformContentForDevin(input)
    expect(result).toContain('[CE] knowledge:brainstorming knowledge entry')
    expect(result).not.toContain('skill')
  })

  test("rewrites 'the X skill' in context", () => {
    const input = 'See the document-review skill for details'
    const result = transformContentForDevin(input)
    expect(result).toContain('[CE] knowledge:document-review knowledge entry')
  })

  test("does NOT rewrite 'skill' in prose context", () => {
    const input = 'This is a skill-intensive task'
    const result = transformContentForDevin(input)
    expect(result).toBe('This is a skill-intensive task')
  })

  test("rewrites SKILL.md path references", () => {
    const input = 'Read .devin/skills/brainstorming/SKILL.md'
    const result = transformContentForDevin(input)
    expect(result).toContain('[CE] knowledge:brainstorming knowledge entry')
    expect(result).not.toContain('SKILL.md')
  })

  test("rewrites .devin/skills/** glob patterns", () => {
    const input = 'Check ~/.devin/skills/**/SKILL.md'
    const result = transformContentForDevin(input)
    expect(result).toBe('Check available knowledge entries')
  })
})

describe("Claude Code tool rewrites", () => {
  test("rewrites AskUserQuestion", () => {
    const input = 'Use the AskUserQuestion tool to ask'
    const result = transformContentForDevin(input)
    expect(result).toBe('Ask the user to ask')
  })

  test("removes EnterPlanMode reference", () => {
    const input = 'Use EnterPlanMode to start planning'
    const result = transformContentForDevin(input)
    expect(result).not.toContain('EnterPlanMode')
  })

  test("rewrites $ARGUMENTS", () => {
    const input = 'Process $ARGUMENTS from the user'
    const result = transformContentForDevin(input)
    expect(result).toBe('Process the user-provided input from the user')
  })

  test("rewrites TodoWrite", () => {
    const input = 'Use the TodoWrite tool to track tasks'
    const result = transformContentForDevin(input)
    expect(result).toContain('Track progress')
  })

  test("preserves file-access tools", () => {
    const input = 'Use Read tool to read files, Grep tool to search'
    const result = transformContentForDevin(input)
    expect(result).toBe('Use Read tool to read files, Grep tool to search')
  })
})

describe("playbook cross-references", () => {
  const macroMap = {
    'security-sentinel': 'security_sentinel',
    'brainstorm': 'workflow_brainstorm',
    'deepen-plan': 'deepen_plan',
  }

  test("rewrites 'Run the X playbook' to '@macro'", () => {
    const input = 'Run the security-sentinel playbook with: code review'
    const result = transformContentForDevin(input, macroMap)
    expect(result).toBe('Run @security_sentinel with: code review')
  })

  test("rewrites 'the X playbook' to '@macro'", () => {
    const input = 'refer to the deepen-plan playbook'
    const result = transformContentForDevin(input, macroMap)
    expect(result).toBe('refer to @deepen_plan')
  })

  test("preserves original text for unknown playbook names", () => {
    const input = 'Run the unknown-agent playbook'
    const result = transformContentForDevin(input, macroMap)
    expect(result).toBe('Run the unknown-agent playbook')
  })

  test("skips cross-ref rewrite when no map provided", () => {
    const input = 'Run the security-sentinel playbook'
    const result = transformContentForDevin(input)
    expect(result).toContain('the security-sentinel playbook')
  })
})
```

**4b. Update existing tests for title format**

```typescript
test("agent title uses [CE] type:name format", () => {
  const bundle = convertClaudeToDevin(pluginWithAgent, options)
  expect(bundle.playbooks[0].content).toContain("# [CE] agent:")
})

test("command title uses [CE] type:name format", () => {
  const bundle = convertClaudeToDevin(pluginWithCommand, options)
  expect(bundle.playbooks[0].content).toContain("# [CE] command:")
})

test("workflow title uses [CE] type:name format", () => {
  const bundle = convertClaudeToDevin(pluginWithWorkflow, options)
  expect(bundle.playbooks[0].content).toContain("# [CE] workflow:")
})

test("workflow command name has workflows- prefix stripped", () => {
  const bundle = convertClaudeToDevin(pluginWithWorkflow, options)
  expect(bundle.playbooks[0].name).not.toContain("workflows-")
})
```

**4c. Test macro generation**

```typescript
test("command playbooks have macro field", () => {
  const bundle = convertClaudeToDevin(pluginWithCommand, options)
  expect(bundle.playbooks[0].macro).toBeDefined()
  expect(bundle.playbooks[0].macro).not.toContain("-")
})

test("agent playbooks have no macro", () => {
  const bundle = convertClaudeToDevin(pluginWithAgent, options)
  expect(bundle.playbooks[0].macro).toBeUndefined()
})

test("workflow macro has workflow_ prefix", () => {
  const bundle = convertClaudeToDevin(pluginWithWorkflow, options)
  expect(bundle.playbooks[0].macro).toMatch(/^workflow_/)
})
```

**4d. Test knowledge entry title format**

```typescript
test("knowledge entry title uses [CE] knowledge:name format", () => {
  const bundle = convertClaudeToDevin(pluginWithSkill, options)
  expect(bundle.knowledgeEntries[0].title).toMatch(/^\[CE\] knowledge:/)
})
```

#### Phase 5: Regenerate Output

After all code changes are implemented and tests pass:

```bash
bun run src/index.ts convert --to devin ./plugins/compound-engineering
```

Verify the regenerated `.devin/` directory:
- [ ] All playbook titles use `[CE] type:name` format
- [ ] No "skill" references remain in playbook bodies
- [ ] No `AskUserQuestion`, `$ARGUMENTS`, `EnterPlanMode` references remain
- [ ] Cross-references use `@macro_name` syntax
- [ ] Workflow playbooks have `workflow_` prefixed macros
- [ ] Knowledge entry titles use `[CE] knowledge:name`

## Acceptance Criteria

### Functional Requirements

- [ ] `transformContentForDevin()` rewrites all skill terminology (Load/Invoke/the X skill)
- [ ] `transformContentForDevin()` rewrites Claude Code tools (AskUserQuestion, $ARGUMENTS, EnterPlanMode, TodoWrite)
- [ ] `transformContentForDevin()` preserves file-access tool references (Read, Grep, Glob)
- [ ] `transformContentForDevin()` rewrites playbook cross-references to `@macro_name` when macro map provided
- [ ] `transformContentForDevin()` preserves original text for unknown playbook names (no blind fallback)
- [ ] Agent playbooks have titles like `[CE] agent:security-sentinel`
- [ ] Command playbooks have titles like `[CE] command:deepen-plan`
- [ ] Workflow playbooks have titles like `[CE] workflow:brainstorm` (prefix stripped)
- [ ] Knowledge entries have titles like `[CE] knowledge:brainstorming`
- [ ] Command/workflow playbooks have `macro` field with underscores (e.g., `deepen_plan`, `workflow_brainstorm`)
- [ ] Agent playbooks have no `macro` field
- [ ] `DevinPlaybook` type includes optional `macro` field
- [ ] Conversion pipeline uses two-pass architecture (build map, then transform)
- [ ] "skill" in prose context (e.g., "skill-intensive") is NOT rewritten
- [ ] Running converter twice produces same output (idempotent)

### Quality Gates

- [ ] All existing tests still pass (no regressions)
- [ ] New tests for each transformation rule
- [ ] New tests for title format, macro generation, cross-references
- [ ] Regenerated `.devin/` output verified clean

## Dependencies & Risks

### Dependencies
- None — this is a self-contained change to the converter

### Risks
- **Regex ordering** — transformations must run in correct order (existing transforms first, then skill/tool rewrites, then cross-references last). Document this ordering in a code comment.
- **False positives** — "skill" in prose context could be rewritten; mitigated by targeting specific patterns (`the X skill`, `Load the X skill`)
- **Playbook name collisions** — if an agent and command share a name, the ref map will have the last one; mitigated by existing `uniqueName()` deduplication
- **Prototype pollution** — mitigated by using `Object.create(null)` for the ref map
- **Cross-reference false positives** — mitigated by only rewriting names that exist in the ref map (no fallback for unknown names)

### Research Insights (Risks)

**Regex case-sensitivity audit:** Three different conventions were used in the original plan:
1. Some patterns used `g` only (case-sensitive)
2. Some used `gi` (case-insensitive)
3. Some had no flags

Standardize on `gi` for all text-matching patterns. Only keep `g` (case-sensitive) for patterns that match exact technical syntax like `$ARGUMENTS` or file paths.

**Workflow prefix stripping fragility:** The `normalizedName.replace(/^workflows-/, '')` relies on `normalizeName()` converting `:` to `-`. If `normalizeName()` changes behavior, this breaks silently. Add a test that verifies `normalizeName("workflows:brainstorm")` returns `"workflows-brainstorm"` to protect this coupling.

## References & Research

### Internal References
- Brainstorm: `docs/brainstorms/2026-02-19-devin-converter-content-fixes-brainstorm.md`
- Converter: `src/converters/claude-to-devin.ts` (lines 183-216 for transforms, 52-100 for conversion functions)
- Types: `src/types/devin.ts` (lines 1-27)
- Writer: `src/targets/devin.ts` (lines 1-50)
- Tests: `tests/devin-converter.test.ts` (485 lines)
- Devin spec: `docs/specs/devin.md`

### Devin API Reference
- Playbook data model: `{ title, body, macro? }` — macro binds as slash command
- Knowledge data model: `{ name, body, trigger_description }` — name used for matching
- Devin uses `@playbook_name` for cross-playbook invocation within bodies
- Macros cannot contain hyphens (`-`), must use underscores (`_`)
