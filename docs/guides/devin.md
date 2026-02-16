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
| Workflows (ce: skills) | Playbooks (`.devin.md`) | Overview/Procedure sections, `!ce_name` macro |
| Skills | Knowledge entries (`.json`) | Title, body, trigger description |
| MCP servers | Setup instructions | `.devin/mcp-setup-instructions.md` |
| Hooks | Skipped | Warning emitted (Devin has no file-based hooks) |

### Content transformations

The converter automatically rewrites Claude Code-specific references for Devin:

- `Task compound-engineering:category:agent-name(args)` → `Use propose_sessions to start a child session with the [CE] agent:name playbook, passing: args`
- `CLAUDE.md` → `AGENTS.md`
- Slash commands like `/ce:plan` or `/workflows:plan` → `the [CE] workflow:plan playbook`
- Slash commands like `/deepen-plan` (knowledge skills) → `the [CE] knowledge:deepen-plan knowledge entry`
- Claude XML tags (`<thinking>`, `<examples>`, etc.) are stripped
- `AskUserQuestion` → `Ask the user`
- `$ARGUMENTS` / `#$ARGUMENTS` → `the user-provided input`
- `Task agent(args)` cross-references → `Use propose_sessions to start a child session with the [CE] agent:name playbook`
- Claude Code-only concepts (`ultrathink`, `LFG/SLFG`, `disable-model-invocation`) are removed
- File paths like `app/services/foo.rb:42` inside code examples are preserved (not treated as slash commands)

### Naming convention

All entries use a `[CE] type:name` title prefix:

| Type | Title Example | Macro |
|------|--------------|-------|
| Agent | `[CE] agent:security-sentinel` | _(none)_ |
| Command | `[CE] command:deepen-plan` | `!ce_deepen_plan` |
| Workflow | `[CE] workflow:brainstorm` | `!ce_brainstorm` |
| Knowledge | `[CE] knowledge:dhh-rails-style` | _(none)_ |

Workflow macros mirror the plugin's `/ce:name` command convention — `!ce_plan` corresponds to `/ce:plan`, `!ce_work` to `/ce:work`, etc.

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
5. Diffs local vs remote by title to compute creates, updates, deletes, and unchanged
6. Content comparison normalizes CRLF line endings and trailing whitespace to avoid false updates
7. Executes changes sequentially with exponential backoff on rate limits (429s)

## MCP Server Setup

MCP servers cannot be synced via the API — Devin configures them through the web UI. After converting, check `.devin/mcp-setup-instructions.md` for setup instructions, then configure each server manually in Devin Settings > MCP Marketplace.

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
