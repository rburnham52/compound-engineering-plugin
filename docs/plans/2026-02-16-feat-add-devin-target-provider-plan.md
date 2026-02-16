---
title: Add Devin as a Target Provider
type: feat
status: completed
date: 2026-02-16
deepened: 2026-02-16
---

# Add Devin as a Target Provider

## Enhancement Summary

**Deepened on:** 2026-02-16
**Research agents used:** best-practices-researcher (x2), kieran-typescript-reviewer, architecture-strategist, code-simplicity-reviewer

### Key Improvements

1. **Dropped heuristic section extraction** — All 3 reviewers independently agreed this was the plan's primary risk. Replaced with simple structural mapping: `description` → Overview, full `body` → Procedure, `capabilities` → Specifications. This eliminates the most complex and fragile function (`extractPlaybookSections`) and removes the main risk item.

2. **Unified command output: all commands become playbooks** — Simplicity reviewer identified that dual command classification (playbooks vs slash-command JSON) adds 3 types/functions for minimal benefit. All 22 commands now convert to playbooks. This removes `classifyCommand()`, `convertToSlashCommand()`, `DevinSlashCommand` type, and the `slash-commands/` output directory.

3. **Added `DevinPlaybookSections` intermediate type** — TypeScript reviewer identified that converting directly from Claude agent body to formatted `.devin.md` string is error-prone. An intermediate record type (`{ overview, procedure, specifications, advice, forbiddenActions, neededFromUser }`) makes each section independently testable.

4. **Addressed `ClaudeSkill` body loading gap** — Both TypeScript and architecture reviewers flagged that `ClaudeSkill` in `src/types/claude.ts` has no `body` field. The parser needs to be extended to read `SKILL.md` content into a `body` field, or the converter must read skill files at conversion time.

5. **MCP servers emit setup instructions file** — Instead of only `console.warn`, the writer also creates `.devin/mcp-setup-instructions.md` documenting which MCP servers need manual configuration in Devin's web UI.

### New Considerations Discovered

- Knowledge entry triggers must be highly specific (name the technology, environment, and context) for reliable Devin retrieval
- Devin's Procedure section is the primary execution driver — write one imperative action per numbered step
- Advice section should be opinionated and persona-driven, not generic guidelines
- Forbidden Actions should be short (5-10 items) with brief rationale per item
- Content transform rules for slash command references and `${CLAUDE_PLUGIN_ROOT}` need explicit regex patterns documented

### Net Simplification

- **Functions:** 9 planned → 5 needed (~44% reduction)
- **Types:** 4 → 3 (dropped `DevinSlashCommand`, added `DevinPlaybookSections`)
- **Output directories:** 3 → 2 (dropped `slash-commands/`)
- **Primary risk eliminated:** Heuristic section extraction was assessed as Medium likelihood / High impact — now removed entirely

---

## Overview

Add `devin` as a seventh target provider in the converter CLI, alongside `opencode`, `codex`, `droid`, `cursor`, `pi`, and `gemini`. This enables `--to devin` for both `convert` and `install` commands, converting Claude Code plugins into Devin-compatible format: playbooks (`.devin.md`), knowledge entry JSON files, and custom slash command definitions.

Devin ([docs.devin.ai](https://docs.devin.ai)) is Cognition's autonomous AI software engineer. It supports playbooks (`.devin.md` structured prompts), knowledge entries (trigger-based reference material), custom slash commands (Enterprise), MCP servers, and `AGENTS.md` context files -- making it a strong conversion target.

**Brainstorm:** `docs/brainstorms/2026-02-16-devin-plugin-conversion-brainstorm.md`

## Problem Statement

Teams using both Claude Code and Devin currently have no way to reuse their Claude Code plugin's agents, commands, and skills in Devin. The compound-engineering plugin has 29 agents, 22 commands, and 19 skills that represent significant domain knowledge (review protocols, workflow processes, design guidelines). Without conversion, this knowledge must be manually recreated as Devin playbooks and knowledge entries.

The converter CLI already supports 6 targets. Adding Devin as a 7th follows the proven architecture and keeps the single-source-of-truth principle.

## Component Mapping

| Claude Code | Devin Equivalent | Notes |
|---|---|---|
| `agents/*.md` | `.devin.md` playbook files | Agent persona goes in Advice section, protocol in Procedure section |
| `commands/*.md` | `.devin.md` playbook files | All commands become playbooks (no slash-command split) |
| `skills/*/SKILL.md` | Knowledge entry JSON files | For upload via `POST /v1/knowledge`; title/body/trigger_description |
| MCP servers | Setup instructions file + console warning | Write `.devin/mcp-setup-instructions.md` + `console.warn` |
| `hooks/` | N/A | Warn and skip (Devin has no file-based hooks) |
| `.claude/` paths | `.devin/` paths | Content rewriting |

### Key Design Decisions

**1. Agents become playbooks with simple structural mapping**

Each agent converts to a `.devin.md` file using direct field-to-section mapping (no heuristic content analysis):
- **Overview:** From agent `description`
- **Procedure:** From agent `body` (full content, preserving structure as-is)
- **Specifications:** From agent `capabilities` array (if present)

The `<examples>` XML blocks are stripped (Devin has no few-shot example mechanism). The `model` and `color` frontmatter fields are silently dropped.

> **Research Insight:** All 3 reviewers (TypeScript, Architecture, Simplicity) independently recommended against heuristic section extraction (scanning for "You are..." persona, "NEVER"/"DO NOT" forbidden patterns). The heuristics would be fragile across 29 diverse agents and produce unpredictable output. Simple structural mapping is reliable, testable, and still produces valid Devin playbooks — Devin treats all sections as optional, so a playbook with just Overview + Procedure works fine. Users can manually promote content into Advice/Forbidden Actions sections after reviewing the generated output.

**2. All commands become playbooks (no slash-command split)**

All 22 commands convert uniformly to `.devin.md` playbooks. There is no classification step or dual output format.

- **Regular commands** (12): `deepen-plan`, `lfg`, `slfg`, `feature-video`, `test-browser`, `test-xcode`, `reproduce-bug`, `resolve_todo_parallel`, `resolve_parallel`, `heal-skill`, `deploy-docs`, `triage`
- **Lightweight commands** (5): `changelog`, `report-bug`, `create-agent-skill`, `generate_command`, `agent-native-audit`
- **Workflow commands** (5): `brainstorm`, `plan`, `work`, `review`, `compound`

Commands with `disable-model-invocation: true` (like `lfg`) are still included. Devin playbooks are inherently model-invoked; the flag is silently dropped.

> **Research Insight:** Simplicity reviewer identified that dual output (playbooks vs slash-command JSON) added 3 extra components (`classifyCommand()`, `convertToSlashCommand()`, `DevinSlashCommand` type) for minimal user benefit. A "simple" command as a playbook still works perfectly — Devin just treats it as a short playbook. This eliminates the entire `slash-commands/` output directory and removes a classification decision that could misclassify edge cases.

**3. Skills become knowledge entry JSON files**

Each skill produces a JSON file with the Devin knowledge API schema:
```json
{
  "title": "Skill Name",
  "body": "Full SKILL.md content (after stripping frontmatter)",
  "trigger_description": "Generated from skill description field"
}
```

Skills with `scripts/` or `references/` directories: reference markdown content is inlined into the body. Scripts are skipped with a warning (knowledge entries are text-only).

> **Research Insight:** Knowledge entry triggers must be highly specific for reliable Devin retrieval. Rather than a vague trigger like "When working on code style", use "When writing Ruby on Rails code in a project using DHH conventions". The `triggerDescription` should name the specific technology, environment, or context. The converter should generate triggers from the skill `description` field but prepend "When " if not already present, to match Devin's expected trigger format.

**4. MCP servers emit a setup instructions file + console warning**

Unlike other targets where MCP config is a JSON file, Devin MCP servers are configured through the web UI (Settings > MCP Marketplace) or `AGENTS.md`. The converter:
1. Writes `.devin/mcp-setup-instructions.md` listing each MCP server with its name, URL, and type
2. Emits a `console.warn` pointing users to the instructions file

> **Research Insight:** Architecture reviewer recommended writing instructions to a file rather than only printing to console. Console warnings are ephemeral and easily missed, while a file persists and can be referenced during manual Devin setup.

**5. Skills pass-through is NOT applicable**

Unlike Gemini/Cursor where skills copy as-is (SKILL.md standard), Devin does not support SKILL.md files. Skills must be converted to knowledge entries. There is no pass-through path.

**6. `$ARGUMENTS` maps to "What's Needed From User" section**

Commands with `argument-hint` get a "What's Needed From User" section in their playbook.

### Devin Playbook Format (.devin.md)

```markdown
# Playbook Title

## Overview

Brief description of what this playbook does and when to use it.

## Procedure

1. Step one (imperative, one action per line)
2. Step two
   - Sub-detail for step two
3. Step three

## Specifications

- Expected end state 1
- Expected end state 2

## Advice

- Persona and behavioral guidance
- Tips for better results

## Forbidden Actions

- NEVER do X
- DO NOT do Y

## What's Needed From User

- Required input or context
```

### Knowledge Entry JSON Format

```json
{
  "title": "knowledge-entry-name",
  "body": "The full content of the knowledge entry...",
  "trigger_description": "When working on [specific context]"
}
```

### ~~Slash Command JSON Format~~ (Removed)

> Dropped per simplification: all commands become playbooks. No slash-command JSON output.

## Technical Approach

### Architecture

Follows the established 6-phase pattern used by all existing target providers:

```
Phase 1: Types         → src/types/devin.ts
Phase 2: Converter     → src/converters/claude-to-devin.ts
Phase 3: Writer        → src/targets/devin.ts
Phase 4: CLI wiring    → src/targets/index.ts, src/commands/convert.ts, src/commands/install.ts
Phase 5: Tests         → tests/devin-converter.test.ts, tests/devin-writer.test.ts
Phase 6: Docs          → docs/specs/devin.md, README.md update
```

### Implementation Phases

#### Phase 1: Types (`src/types/devin.ts`)

Define the TypeScript types for the Devin bundle:

```typescript
// Intermediate type for building playbook sections independently (testable)
export type DevinPlaybookSections = {
  overview: string
  procedure: string
  specifications?: string
  advice?: string
  forbiddenActions?: string
  neededFromUser?: string
}

export type DevinPlaybook = {
  name: string
  content: string // Full .devin.md content with sections
  category: "agent" | "command" | "workflow"
}

export type DevinKnowledgeEntry = {
  name: string
  title: string
  body: string
  triggerDescription: string
}

export type DevinBundle = {
  playbooks: DevinPlaybook[]              // From agents + ALL commands
  knowledgeEntries: DevinKnowledgeEntry[] // From skills
}
```

> **Research Insight (TypeScript reviewer):** The `DevinPlaybookSections` intermediate type makes each section independently testable and avoids string-in-string-out conversions that are hard to debug. The converter builds sections as a `DevinPlaybookSections` object, then `formatPlaybook()` assembles it into the final `.devin.md` string. This also makes it easy to add optional sections (Advice, Forbidden Actions) later without changing the core conversion logic.
>
> `DevinSlashCommand` type removed — all commands produce playbooks.

**Effort:** Small -- type definitions only.

#### Phase 2: Converter (`src/converters/claude-to-devin.ts`)

Core functions (5 total, down from 9 in original plan):

1. **`convertClaudeToDevin(plugin, options)`** -- main entry point
   - Convert each agent to a playbook via `convertAgentToPlaybook()`
   - Convert each command to a playbook via `convertCommandToPlaybook()`
   - Convert each skill to a knowledge entry via `convertSkillToKnowledge()`
   - Generate MCP setup instructions file content (if MCP servers present)
   - Emit `console.warn` for MCP servers (pointing to instructions file)
   - Emit `console.warn` for hooks (not supported)
   - Use shared `normalizeName()` for consistent kebab-case naming across all components

2. **`convertAgentToPlaybook(agent)`** -- agent -> `DevinPlaybookSections` -> `.devin.md`
   - Build `DevinPlaybookSections` via simple structural mapping:
     - `overview`: from agent `description`
     - `procedure`: from agent `body` (full content after stripping `<examples>` XML blocks and applying `transformContentForDevin()`)
     - `specifications`: from agent `capabilities` array (joined as bullet list), or omitted if empty
   - Silently drop `model`, `color` fields
   - Pass sections to `formatPlaybook()` to produce final `.devin.md` string

   > **Research Insight (Devin playbook best practices):** Procedure is the primary execution driver in Devin. One imperative action per numbered step. The full agent body maps well here — Devin will follow the protocol steps as written. Advice and Forbidden Actions sections are left empty by default; users can manually promote relevant content after reviewing generated output.

3. **`convertCommandToPlaybook(command)`** -- command -> `DevinPlaybookSections` -> `.devin.md`
   - Build `DevinPlaybookSections`:
     - `overview`: from `description`
     - `procedure`: from `body` with `transformContentForDevin()` applied
     - `neededFromUser`: from `argumentHint` (if present), prefixed with "Provide: "
   - Silently drop `allowedTools`, `disableModelInvocation`
   - Determine `category` from command name: commands starting with `workflows:` → `"workflow"`, all others → `"command"`
   - Pass sections to `formatPlaybook()`

4. **`convertSkillToKnowledge(skill)`** -- skill -> knowledge JSON
   - `title` from skill `name`
   - `body` from SKILL.md content (frontmatter stripped, apply `transformContentForDevin()`)
   - `triggerDescription`: from skill `description`, prepend "When " if not already present, truncate to 500 chars
   - Inline `references/*.md` content into body (append after main content)
   - Warn about `scripts/` directories that can't be included

   > **Note (ClaudeSkill body gap):** The `ClaudeSkill` type in `src/types/claude.ts` currently has `skillPath` but no `body` field. The converter must either: (a) read the SKILL.md file at conversion time using `skillPath`, or (b) extend the parser to populate a `body` field on `ClaudeSkill`. Option (a) is simpler and matches the "converter reads what it needs" pattern used by other converters. Check how Gemini handles this.

5. **`transformContentForDevin(body)`** -- content rewriting (shared by all converters above)
   - `Task agent-name(args)` → `Run the agent-name playbook with: args`
     - Regex: `/Task\s+([\w-]+)\s*\(([^)]*)\)/g`
   - `.claude/` → `.devin/`, `~/.claude/` → `~/.devin/`
     - Regex: `/(?:~\/)?\.claude\//g` → `.devin/` (with `~/` prefix preserved)
   - `@agent-name` references → `the agent-name playbook`
     - Regex: `/@([\w-]+)/g`
   - Slash command references (`/workflows:plan`) → `the workflows-plan playbook`
     - Regex: `/\/([\w-]+):([\w-]+)/g` → `the $1-$2 playbook`
   - Strip Claude Code XML tags (`<thinking>`, `<objective>`, `<process>`, `<examples>`, etc.)
     - Regex: `/<\/?(thinking|objective|process|examples|feature_description|plan_path)[^>]*>/g` → `""`
   - Remove `${CLAUDE_PLUGIN_ROOT}` variable references (replace with `.`)
     - Regex: `/\$\{CLAUDE_PLUGIN_ROOT\}/g` → `.`

**Helper functions:**

- **`formatPlaybook(title, sections: DevinPlaybookSections)`** -- assemble `.devin.md` content
  - Compose sections in canonical order: Overview, Procedure, Specifications, Advice, Forbidden Actions, What's Needed From User
  - Skip empty/undefined sections
  - Use markdown heading hierarchy (`# Title`, `## Section`)

- **`normalizeName(name)`** -- shared with Gemini converter (extract to `src/utils/normalize-name.ts` if not already shared)
  - Kebab-case, strip special characters, handle namespaced names (`workflows:plan` → `workflows-plan`)

**Effort:** Medium -- straightforward structural mapping, no heuristic parsing. The content transformation regexes are the most complex part but follow established patterns from the Gemini converter.

#### Phase 3: Writer (`src/targets/devin.ts`)

Output structure:

```
.devin/
├── playbooks/
│   ├── agents/
│   │   ├── kieran-rails-reviewer.devin.md
│   │   ├── security-sentinel.devin.md
│   │   └── ... (one per agent)
│   ├── commands/
│   │   ├── deepen-plan.devin.md
│   │   ├── lfg.devin.md
│   │   ├── changelog.devin.md
│   │   └── ... (one per command, including lightweight ones)
│   └── workflows/
│       ├── brainstorm.devin.md
│       ├── plan.devin.md
│       └── ... (one per workflow)
├── knowledge/
│   ├── brainstorming.json
│   ├── dhh-rails-style.json
│   └── ... (one per skill)
└── mcp-setup-instructions.md    (only if MCP servers present)
```

Core function: `writeDevinBundle(outputRoot, bundle)`

- `resolveDevinPaths(outputRoot)` -- detect if path already ends in `.devin` to avoid double-nesting (follow Gemini writer pattern)
- Write playbooks to `playbooks/{category}/{name}.devin.md`
- Write knowledge entries to `knowledge/{name}.json`
- Write MCP setup instructions to `mcp-setup-instructions.md` (if present in bundle)
- Use `writeText()` for `.devin.md` and `.md` files, `writeJson()` for JSON files

> Note: `slash-commands/` directory removed — all commands are now playbooks in `playbooks/commands/`.

**Effort:** Small -- follows established writer patterns.

#### Phase 4: CLI Wiring

**Modify `src/targets/index.ts`:**

```typescript
import { convertClaudeToDevin } from "../converters/claude-to-devin"
import { writeDevinBundle } from "./devin"
import type { DevinBundle } from "../types/devin"

// Add to targets:
devin: {
  name: "devin",
  implemented: true,
  convert: convertClaudeToDevin as TargetHandler<DevinBundle>["convert"],
  write: writeDevinBundle as TargetHandler<DevinBundle>["write"],
},
```

**Modify `src/commands/convert.ts`:**
- Update `--to` description: `"Target format (opencode | codex | droid | cursor | pi | gemini | devin)"`
- Add to `resolveTargetOutputRoot`: `if (targetName === "devin") return path.join(outputRoot, ".devin")`

**Modify `src/commands/install.ts`:**
- Same two changes as convert.ts

**Effort:** Small -- mechanical registration.

#### Phase 5: Tests

**Create `tests/devin-converter.test.ts`:**

Test cases (use inline `ClaudePlugin` fixtures following `tests/gemini-converter.test.ts` pattern):

Agent conversion:
- Agent converts to playbook with Overview from description
- Agent body becomes Procedure section (full content preserved)
- Agent capabilities become Specifications section (bullet list)
- Agent with no capabilities omits Specifications section
- Agent `<examples>` XML blocks stripped from body
- Agent `model` field silently dropped
- Agent `color` field silently dropped
- Agent with empty body gets default body
- Agent with empty description gets default description
- `DevinPlaybookSections` intermediate type is correctly populated

Command conversion:
- Command converts to playbook with Procedure section from body
- Command with `argumentHint` gets "What's Needed From User" section
- Command `allowedTools` silently dropped
- Command `disableModelInvocation` silently dropped
- Namespaced command preserves structure in filename (`workflows:plan` -> `workflows-plan`)
- Workflow command (`workflows:*`) gets category `"workflow"`
- Non-workflow command gets category `"command"`
- All commands become playbooks (no slash-command classification)

Skill conversion:
- Skill converts to knowledge JSON with title, body, triggerDescription
- Skill frontmatter stripped from body
- Skill description becomes triggerDescription with "When " prefix
- Skill with empty description gets default trigger
- Long triggerDescription truncated to 500 chars
- Skill body has content transformations applied

Content transformation:
- `.claude/` paths -> `.devin/`
- `~/.claude/` paths -> `~/.devin/`
- `Task agent(args)` -> natural language playbook reference
- `@agent-name` references -> playbook reference
- `<thinking>` and other XML tags stripped
- `${CLAUDE_PLUGIN_ROOT}` references removed

MCP handling:
- Plugin with MCP servers -> `console.warn` emitted + `mcpSetupInstructions` string populated
- MCP instructions contain server name, URL, and type

Edge cases:
- Plugin with zero agents produces empty playbooks array
- Plugin with only skills works correctly
- Plugin with hooks -> `console.warn` emitted
- Plugin with MCP servers -> instructions file written + `console.warn` emitted
- `formatPlaybook` omits empty/undefined sections
- `normalizeName` handles colons, spaces, and special characters

**Create `tests/devin-writer.test.ts`:**

Test cases (use temp directories following existing writer test patterns):
- Full bundle writes playbooks and knowledge directories
- Agent playbooks written as `.devin.md` files in `playbooks/agents/`
- Command playbooks written in `playbooks/commands/`
- Workflow playbooks written in `playbooks/workflows/`
- Knowledge entries written as `.json` files in `knowledge/`
- MCP setup instructions written to `mcp-setup-instructions.md` when present
- MCP setup instructions file NOT written when no MCP servers
- Output root already ending in `.devin` does NOT double-nest
- Empty bundle produces no output

**Effort:** Small-medium -- follows test patterns, no heuristic extraction tests needed.

#### Phase 6: Documentation

**Create `docs/specs/devin.md`:**

Document the Devin spec as reference, following existing `docs/specs/gemini.md` pattern:
- Playbook format (`.devin.md`) with section descriptions
- Knowledge entry format (API schema: title, body, trigger_description)
- Custom slash commands (Enterprise, macro field)
- MCP server configuration (web UI-based, not file-based)
- AGENTS.md support (auto-ingested as knowledge)
- Session tools (shell, IDE, browser)
- API endpoints (v1: sessions, playbooks, knowledge)
- Scheduled sessions and batch sessions
- Advanced Mode capabilities

**Update `README.md`:**

Add `devin` to the supported targets in the CLI usage section.

**Effort:** Small-medium -- research already done in brainstorm.

## Acceptance Criteria

### Functional Requirements

- [x] `bun run src/index.ts convert --to devin ./plugins/compound-engineering` produces valid Devin files
- [x] Agents convert to `.devin/playbooks/agents/{name}.devin.md` with Overview/Procedure sections (Specifications if capabilities present)
- [x] Agent `description` → Overview, full `body` → Procedure, `capabilities` → Specifications
- [x] Agent `<examples>` XML blocks stripped
- [x] Agent `model` and `color` fields silently dropped
- [x] All commands convert to `.devin/playbooks/commands/{name}.devin.md` (no slash-command split)
- [x] Workflow commands (`workflows:*`) convert to `.devin/playbooks/workflows/{name}.devin.md`
- [x] Commands with `argumentHint` include "What's Needed From User" section
- [x] Commands with `disableModelInvocation` are still included (flag dropped)
- [x] Commands with `allowedTools` have the field silently dropped
- [x] Skills convert to `.devin/knowledge/{name}.json` with title, body, triggerDescription
- [x] Skill YAML frontmatter stripped from knowledge body
- [ ] Skills with `references/` directories have reference content inlined
- [ ] Skills with `scripts/` directories emit a warning
- [x] Skill `triggerDescription` prepends "When " if not already present
- [x] MCP servers emit `console.warn` + write `.devin/mcp-setup-instructions.md`
- [x] Hooks emit `console.warn` (not supported)
- [x] Content transformation: `.claude/` paths -> `.devin/`
- [x] Content transformation: `~/.claude/` paths -> `~/.devin/`
- [x] Content transformation: `Task agent(args)` -> playbook reference
- [x] Content transformation: `@agent-name` -> playbook reference
- [x] Content transformation: Claude Code XML tags stripped
- [x] Namespaced commands use dash-separated filenames (`workflows:plan` -> `workflows-plan`)
- [x] Writer does not double-nest `.devin/.devin/`
- [x] All converter tests pass (`bun test`)
- [x] All existing tests still pass

### Non-Functional Requirements

- [x] Generated playbooks follow Devin's convention-based section ordering
- [x] Knowledge JSON files are valid JSON parseable by `JSON.parse()`
- [x] No new dependencies added (pure TypeScript)

### Quality Gates

- [x] Converter tests: 20+ test cases covering all component types and edge cases
- [x] Writer tests: 8+ test cases covering directory structure and file output
- [ ] `docs/specs/devin.md` spec document complete (deferred — not needed for v1)
- [x] `README.md` updated with `devin` target
- [x] `DevinPlaybookSections` intermediate type used in all converter functions

## What We're NOT Doing

- Not implementing API upload of knowledge entries (future enhancement -- adds auth complexity)
- Not adding Devin to the `sync` command (matches Gemini precedent -- sync not implemented for newer targets)
- Not converting hooks (Devin has no file-based hook system)
- Not writing MCP config files (Devin MCP is configured via web UI; we write setup instructions instead)
- Not implementing `--devinHome` CLI flag (not needed for v1)
- Not validating generated playbooks against Devin's runtime (no local Devin validation available)
- Not attempting AI-powered content rewriting (structural reformatting only, simple field-to-section mapping)
- Not extracting Advice or Forbidden Actions sections heuristically (users can manually curate after generation)
- Not classifying commands into playbooks vs slash-commands (all commands become playbooks)

## Complexity Assessment

This is a **small-medium change** (reduced from medium after simplification). The converter architecture is well-established with six existing targets, so this is mostly pattern-following. The key novelties are:

1. **Skills don't pass through** (different from Gemini/Cursor) -- must convert to knowledge JSON rather than copying SKILL.md directly.
2. **MCP setup instructions file** (new pattern) -- other targets write MCP config JSON; Devin gets a human-readable instructions file instead.
3. **Knowledge trigger generation** -- constructing meaningful `triggerDescription` values from skill descriptions requires some string processing.

The original plan's two biggest complexities — heuristic section extraction and dual command classification — have been eliminated by the deepening process.

> **Research Insight:** The TOML serializer complexity from Gemini is absent (Devin uses plain markdown). With heuristic extraction removed, this target is now simpler than the Gemini target. The main complexity is in `transformContentForDevin()` regex patterns, which follow established patterns from the Gemini converter.

## Dependencies & Prerequisites

- Existing converter CLI codebase (already in place)
- Devin API documentation at docs.devin.ai (already researched)
- No external dependencies needed

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ~~Section extraction produces poor-quality playbooks~~ | ~~Medium~~ | ~~High~~ | **Eliminated** — replaced with simple structural mapping |
| ~~Command classification misclassifies edge cases~~ | ~~Low~~ | ~~Low~~ | **Eliminated** — all commands become playbooks |
| Knowledge triggers too vague for Devin retrieval | Medium | Medium | Generate specific triggers with "When " prefix + technology context from description |
| `ClaudeSkill` has no `body` field in parser | Medium | Medium | Read SKILL.md at conversion time using `skillPath`; verify Gemini approach first |
| Devin changes playbook format | Low | Medium | Sections are convention-based markdown, unlikely to break |
| Knowledge entry body is too long for Devin API | Low | Medium | Truncate with warning if over 50KB |
| Content transform regex misses edge cases | Low | Low | Test against actual plugin files; regexes follow proven Gemini patterns |

## References

### Internal References

- Gemini converter (completed template): `docs/plans/2026-02-14-feat-add-gemini-cli-target-provider-plan.md`
- Cursor converter (reference): `docs/plans/2026-02-12-feat-add-cursor-cli-target-provider-plan.md`
- Claude Code spec: `docs/specs/claude-code.md`
- Target registry: `src/targets/index.ts`
- Gemini converter (code reference): `src/converters/claude-to-gemini.ts`
- Gemini writer (code reference): `src/targets/gemini.ts`
- Gemini types (code reference): `src/types/gemini.ts`
- Plugin types: `src/types/claude.ts`
- Brainstorm: `docs/brainstorms/2026-02-16-devin-plugin-conversion-brainstorm.md`

### External References

- Devin Documentation: https://docs.devin.ai
- Creating Playbooks: https://docs.devin.ai/product-guides/creating-playbooks
- Using Playbooks: https://docs.devin.ai/product-guides/using-playbooks
- Knowledge Onboarding: https://docs.devin.ai/onboard-devin/knowledge-onboarding
- AGENTS.md in Devin: https://docs.devin.ai/onboard-devin/agents-md
- Devin API - Create Session: https://docs.devin.ai/api-reference/v1/sessions/create-a-new-devin-session
- Devin API - Create Playbook: https://docs.devin.ai/api-reference/v1/playbooks/create-playbook
- Advanced Mode: https://docs.devin.ai/product-guides/advanced-mode
- Scheduled Sessions: https://docs.devin.ai/product-guides/scheduled-sessions
