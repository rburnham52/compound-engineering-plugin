# Devin Target: Convert & Sync Guide

Convert Claude Code plugins into Devin playbooks and knowledge entries, then sync them to the Devin API.

## Prerequisites

- [Bun](https://bun.sh/) installed
- A Devin service user key (`cog_` prefix) — create one at Organization Settings > Service Users
- Your Devin organization ID — visible in the URL when logged in (e.g. `https://app.devin.ai/org/<org_id>`)
- **Enterprise plan required** — knowledge operations (`GET/POST/PUT/DELETE`) need the `ManageAccountKnowledge` permission which is Enterprise-only. Playbook operations need `ManageOrgPlaybooks` (all plans).

## Quick Start

```bash
# 1. Convert the plugin to Devin format
bunx @every-env/compound-plugin install compound-engineering --to devin

# 2. Sync to Devin's API
DEVIN_API_KEY=cog_xxx DEVIN_ORG_ID=org_xxx bunx @every-env/compound-plugin sync --target devin
```

## Step 1: Convert

The `convert` (or `install`) command transforms Claude Code plugins into Devin-compatible files:

```bash
# From a local plugin directory
bun run src/index.ts convert --to devin ./plugins/compound-engineering

# Or install from the marketplace
bunx @every-env/compound-plugin install compound-engineering --to devin
```

This produces a `.devin/` directory:

```
.devin/
├── playbooks/
│   ├── agents/           # One .devin.md per agent
│   ├── commands/          # One .devin.md per command
│   └── workflows/         # One .devin.md per workflow
├── knowledge/             # One .json per skill
└── mcp-setup-instructions.md   # MCP server setup guide (if applicable)
```

### What gets converted

| Claude Code | Devin | Format |
|-------------|-------|--------|
| Agents | Playbooks (`.devin.md`) | Overview/Procedure/Specifications sections |
| Commands | Playbooks (`.devin.md`) | Overview/Procedure sections |
| Workflows (ce: skills) | Playbooks (`.devin.md`) | Overview/Procedure sections, `!ce-name` macro |
| Skills | Knowledge entries (`.json`) | Title, body, trigger, `!ce-name` macro |
| MCP servers | Setup instructions | `.devin/mcp-setup-instructions.md` |
| Hooks | Skipped | Warning emitted (Devin has no file-based hooks) |

### Content transformations

The converter automatically rewrites Claude Code-specific references for Devin:

**Agent invocations**
- `Task compound-engineering:category:agent-name(args)` → `Use propose_sessions to start a child session with the [CE] agent:name playbook, passing: args`
- `Task agent(args)` cross-references → `Use propose_sessions to start a child session with the [CE] agent:name playbook`
- `Task tool` prose (e.g. "use the Task tool to launch agents") → `Use propose_sessions to start child sessions`

**Slash commands and skill invocations**
- `/ce:plan`, `/workflows:plan` → `` Run `!ce-plan` `` (macro invocation)
- `` `ce:review mode:autofix` `` (bare backtick invocation) → `` Run `!ce-review` with: mode:autofix ``
- `/deepen-plan` (knowledge-type skill) → `the [CE] knowledge:deepen-plan knowledge entry`
- `Skill("compound-engineering:document-review", "mode:headless ...")` → `the [CE] knowledge:document-review knowledge entry`
- `skill: git-worktree` (YAML-style invocation) → `Refer to the [CE] knowledge:git-worktree knowledge entry`

**Claude Code API and tool names**
- `CLAUDE.md` → `AGENTS.md`
- `AskUserQuestion` → `Ask the user`
- `$ARGUMENTS` / `#$ARGUMENTS` → `the user-provided input`
- `EnterPlanMode` / `ExitPlanMode` → removed
- `TodoWrite` → `Track progress`
- `Skill tool` → `the knowledge entry`
- `Claude Code's Bash` → `agent shell tools`

**Platform-specific content stripping**
- Claude XML tags (`<thinking>`, `<examples>`, etc.) stripped
- Lines containing `/model` slash command stripped (no equivalent in Devin)
- Platform-comparison bullet items (`- Claude Code: ...`) stripped; other platform bullets preserved
- Table rows with `Claude Code plugins` as first column stripped
- Claude Code-only concepts (`ultrathink`, `LFG/SLFG`, `disable-model-invocation`) stripped
- `~/.claude/` and `.claude/` directory references stripped
- `${CLAUDE_PLUGIN_ROOT}` → `.`

**Preserved**
- File paths like `app/services/foo.rb:42` inside code examples (not treated as slash commands)
- Platform-neutral content (`[e.g., Claude Code, Codex, Copilot]` in templates)

### Excluding entries from conversion

Add `exclude-from: [devin]` to any skill, agent, or command frontmatter to prevent it from being converted or synced to Devin:

```markdown
---
name: my-skill
description: ...
exclude-from: [devin]
---
```

Use this for content that is intrinsically Claude Code-specific and cannot be meaningfully translated (e.g. `orchestrating-swarms`, `agent-native-architecture`, `claude-permissions-optimizer`). If an excluded entry was previously synced, the next `sync` run will delete it from Devin automatically.

### Naming convention

All entries use a `[CE] type:name` title prefix:

| Type | Title Example | Macro |
|------|--------------|-------|
| Agent | `[CE] agent:security-sentinel` | _(none)_ |
| Command | `[CE] command:deepen-plan` | `!deepen-plan` |
| Workflow | `[CE] workflow:brainstorm` | `!ce-brainstorm` |
| Knowledge | `[CE] knowledge:dhh-rails-style` | `!ce-dhh-rails-style` |

All macros use **hyphens only** — both playbooks and knowledge entries follow the same rule (Devin's knowledge API does not allow underscores). The `!` prefix is required for both types.

Workflow macros use a `ce-` prefix mirroring the plugin's `/ce:name` command convention — `!ce-plan` invokes `/ce:plan`, `!ce-work` invokes `/ce:work`, etc. Knowledge macros follow the same `ce-` prefix pattern.

The `[CE]` prefix ensures synced entries never collide with manually-created Devin content. The sync command only touches `[CE]`-prefixed entries.

## Step 2: Sync

The `sync` command pushes local `.devin/` files to Devin's REST API. It computes a diff (create/update/delete) against what's already in Devin and applies changes.

### Authentication

Devin V3 uses service user keys (`cog_` prefix) and requires an organization ID. Set both via environment variables (recommended):

```bash
export DEVIN_API_KEY=cog_xxx
export DEVIN_ORG_ID=org_xxx
```

Create a service user at Organization Settings > Service Users in the Devin web app. Grant it:
- `ManageOrgPlaybooks` — for playbook sync (all plans)
- `ManageAccountKnowledge` — for knowledge sync (**Enterprise plan required**)

Or pass credentials directly (not recommended — exposes them in shell history):

```bash
bun run src/index.ts sync --target devin --api-key cog_xxx --org-id org_xxx
```

### Preview changes first

Always start with `--dry-run` to see what would change:

```bash
bun run src/index.ts sync --target devin --dry-run
```

Example output:

```
Syncing to Devin API (DRY RUN)...

Validating API key...

Reading local .devin/ directory...
  Found 50 playbooks, 19 knowledge entries

Fetching remote state from Devin...
  Found 45 [CE] playbooks, 15 [CE] knowledge entries

Changes:
  CREATE  5
    + [CE] agent:new-agent-1
    + [CE] agent:new-agent-2
  UPDATE  3
    ~ [CE] agent:security-sentinel
  DELETE  2
    - [CE] agent:removed-agent
  SKIP    42 (unchanged)

Run without --dry-run to apply changes.
```

### Apply changes

```bash
bun run src/index.ts sync --target devin
```

### Delete handling

Orphaned entries (exist in Devin with `[CE]` prefix but no matching local file) require explicit confirmation:

```bash
# Show what would be deleted, but don't delete
bun run src/index.ts sync --target devin

# Auto-confirm all deletions
bun run src/index.ts sync --target devin --yes

# Skip deletion entirely
bun run src/index.ts sync --target devin --no-delete
```

### Filter what gets synced

Sync specific entries by name:

```bash
bun run src/index.ts sync --target devin --only security-sentinel,brainstorming
```

### Specify a different `.devin/` directory

```bash
bun run src/index.ts sync --target devin --dir path/to/.devin
```

## CLI Reference

### `sync --target devin` options

| Flag | Default | Description |
|------|---------|-------------|
| `--api-key <key>` | `DEVIN_API_KEY` env | Service user key (`cog_` prefix) |
| `--org-id <id>` | `DEVIN_ORG_ID` env | Devin organization ID |
| `--dry-run` | `false` | Preview changes without executing |
| `--dir <path>` | `.devin` | Path to `.devin/` directory |
| `--no-delete` | `false` | Skip orphan deletion entirely |
| `--yes` | `false` | Auto-confirm deletions |
| `--only <names>` | _(all)_ | Comma-separated entry names to sync |

## Typical Workflow

```bash
# 1. Make changes to your Claude Code plugin
vim plugins/compound-engineering/agents/my-new-agent.md

# 2. Re-convert to Devin format
bun run src/index.ts convert --to devin ./plugins/compound-engineering

# 3. Preview the sync diff
bun run src/index.ts sync --target devin --dry-run

# 4. Apply changes
bun run src/index.ts sync --target devin --yes
```

## How the sync algorithm works

1. Reads local `.devin/playbooks/**/*.devin.md` and `.devin/knowledge/*.json`
2. Constructs `[CE] type:name` titles from directory structure + filenames
3. Fetches all playbooks and knowledge from the Devin API
4. Filters remote entries to `[CE]`-prefixed ones (ignores manually-created content)
5. Looks up a folder named `Compound Engineering` in the knowledge folders API (optional — used when creating new entries)
6. Diffs local vs remote by title to compute creates, updates, deletes, and unchanged
7. Content comparison normalizes CRLF line endings and trailing whitespace to avoid false updates
8. Executes changes sequentially with exponential backoff on rate limits (429s)

> **Folder grouping:** The sync detects a `Compound Engineering` folder if it exists and logs its ID, but the Devin API currently ignores `folder_id` on create/update requests — folder assignment is UI-only. You can manually drag entries into the folder in the Devin knowledge UI. The sync code passes `folder_id` on all knowledge writes so it will work automatically if Devin adds API support.

## MCP Server Setup

MCP servers cannot be synced via the API — Devin configures them through the web UI. After converting, check `.devin/mcp-setup-instructions.md` for setup instructions, then configure each server manually in Devin Settings > MCP Marketplace.

## Verifying converter output

After syncing, you can ask Devin to self-verify the synced content against the verification prompt at [`docs/specs/devin_verification_prompt.md`](../specs/devin_verification_prompt.md).

The prompt instructs Devin to list its own playbooks and knowledge entries, audit each one against 10 transformation rules, and report any issues in a structured table.

Typical workflow:

```bash
# 1. Convert
bun run src/index.ts convert --to devin ./plugins/compound-engineering

# 2. Sync to Devin
DEVIN_API_KEY=cog_xxx DEVIN_ORG_ID=org_xxx bun run src/index.ts sync --target devin --yes

# 3. Open a Devin session, attach docs/specs/devin_verification_prompt.md, and send:
#    "Please verify latest Compound Engineering update with <file>"
#    Devin will list playbooks + knowledge entries and audit each one.

# 4. Fix any reported converter issues, then re-convert, re-sync, and re-verify
```

## Troubleshooting

**"Devin API key required"**
Set `DEVIN_API_KEY` environment variable or pass `--api-key`.

**"Devin org ID required"**
Set `DEVIN_ORG_ID` environment variable or pass `--org-id`. Find your org ID in the Devin web app URL.

**"Devin V3 requires a service user key (starts with cog\_)"**
You are using a legacy API key. Create a service user key at Organization Settings > Service Users.

**"Invalid Devin API key"**
Check your service user key at Organization Settings > Service Users.

**"Devin API access denied"**
Ensure the service user has both `ManageOrgPlaybooks` and `ManageAccountKnowledge` permissions. The latter requires an Enterprise plan.

**"No .devin/ directory found"**
Run `convert --to devin` first to generate the local files.

**"--dir must be within the project directory"**
The `--dir` path must be relative to or within the current working directory.

**Every sync shows updates for unchanged content**
This usually means the API normalizes content differently. File an issue if you see this — the sync already normalizes CRLF and trailing whitespace.
