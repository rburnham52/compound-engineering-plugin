# Devin Sync Command — Brainstorm

**Date:** 2026-02-19
**Status:** Ready for planning
**Depends on:** [Devin Converter Content Fixes](./2026-02-19-devin-converter-content-fixes-brainstorm.md) (fix terminology leaks before syncing)

---

## What We're Building

A `sync devin` CLI subcommand that reads the local `.devin/` output directory (produced by the existing `convert --to devin` command) and pushes playbooks and knowledge entries to Devin's REST API. It handles initial bulk import and ongoing sync — creating, updating, and (with confirmation) deleting entries to keep Devin in lockstep with the local plugin.

### The Problem

The converter already produces 50+ playbooks and 19 knowledge entries as local files in `.devin/`. But Devin does **not** auto-discover these files from a git repo. Each playbook and knowledge entry must be created individually through the web UI or API. This makes initial setup painful (~70 manual entries) and ongoing sync error-prone.

### The Solution

A single CLI command that:

```bash
bun run src/index.ts sync devin --api-key <key>
# or with env var:
DEVIN_API_KEY=apk_user_xxx bun run src/index.ts sync devin
```

---

## Why This Approach

We chose a **sync subcommand within the existing CLI** over a standalone script or CI action because:

1. **Natural fit** — the converter CLI already handles `convert --to devin`. Adding `sync devin` keeps the workflow in one tool
2. **Reuses infrastructure** — file reading, Devin type definitions, and directory conventions are already established
3. **CI-ready later** — a CLI command is trivially wrappable in a GitHub Action if we want full automation in the future

We rejected:
- **Standalone script** — duplicates file-reading logic, adds another entry point to maintain
- **CI-only** — too opinionated; not everyone wants auto-sync on push

---

## Key Decisions

### 1. Two-step workflow (convert then sync)

The sync command reads from an existing `.devin/` directory. Users run `convert --to devin` first, then `sync devin`. This keeps concerns separated:
- Convert = transform formats
- Sync = push to API

### 2. `[CE]` prefix convention for namespacing

All synced entries use the `[CE] type:name` naming convention:
- Agent playbook: `[CE] agent:security-sentinel`
- Workflow playbook: `[CE] workflow:plan`
- Command playbook: `[CE] command:deepen-plan`
- Knowledge entry: `[CE] knowledge:brainstorming`

Macros (slash commands) only for commands and workflows, NO prefix, underscores instead of hyphens:
- `workflow_plan`, `deepen_plan`, `workflow_brainstorm`
- Agents do NOT get macros

This prevents collisions with manually-created Devin entries and makes synced entries easily filterable. The sync command **only** touches entries with the `[CE]` prefix — it will never modify or delete entries created manually.

### 3. Match by prefix + name for idempotency

On each sync:
1. Fetch all existing playbooks and knowledge from Devin API
2. Filter to `[CE]`-prefixed entries (these are "ours")
3. Compare against local `.devin/` files by name
4. Create new, update changed, prompt to delete orphans

### 4. Interactive delete with `--dry-run` support

- **Orphaned entries** (exist in Devin with `[CE]` prefix but no matching local file): prompt the user for confirmation before deleting
- **`--dry-run` flag**: shows a summary of what would be created/updated/deleted without making any API calls

### 5. Auth via CLI flag with env var fallback

```
--api-key <key>     # Explicit flag (highest priority)
DEVIN_API_KEY       # Environment variable fallback
```

Uses Devin v1 API with Bearer token auth. API keys are obtained from Devin Settings > API Keys.

### 6. Selective sync by category

Users can filter what gets synced:

```bash
# Sync only agents
bun run src/index.ts sync devin --agents

# Sync agents and knowledge only
bun run src/index.ts sync devin --agents --knowledge

# Sync specific entries
bun run src/index.ts sync devin --only security-sentinel,brainstorming
```

Categories: `--agents`, `--commands`, `--workflows`, `--knowledge`. Without flags, syncs everything.

### 7. Auto-set macros for command and workflow playbooks

Command and workflow playbooks automatically get a `macro` field set, making them available as slash commands in Devin:

- Workflow: `[CE] workflow:brainstorm` → macro: `workflow_brainstorm`
- Command: `[CE] command:deepen-plan` → macro: `deepen_plan`

Agent playbooks do NOT get macros — they're invoked via `@name` references within other playbooks.

### 8. Folders + pinned_repo for knowledge organization

Knowledge entries are organized into Devin folders by category:
- `[CE] Knowledge` folder — for all knowledge entries (converted from skills)

The sync command creates folders on first run if they don't exist. Entries are assigned to their folder via `parent_folder_id`.

Additionally, knowledge entries support `pinned_repo` — when specified (via `--pin-repo <repo>` flag), knowledge auto-loads in sessions for that repository.

---

## Sync Algorithm

```
1. Read local .devin/ directory
   - .devin/playbooks/**/*.devin.md → playbook candidates
   - .devin/knowledge/*.json → knowledge candidates

2. Fetch remote state from Devin API
   - GET /v1/playbooks → all existing playbooks
   - GET /v1/knowledge → all existing knowledge entries

3. Filter remote to [CE]-prefixed entries only

4. Diff local vs remote:
   - NEW: local file exists, no matching [CE] remote entry → CREATE
   - CHANGED: local file exists, matching [CE] remote entry, content differs → UPDATE
   - ORPHAN: [CE] remote entry exists, no matching local file → prompt DELETE
   - UNCHANGED: content matches → skip

5. Execute changes (unless --dry-run):
   - POST /v1/playbooks for new playbooks
   - PUT /v1/playbooks/{id} for changed playbooks
   - POST /v1/knowledge for new knowledge entries
   - PUT /v1/knowledge/{id} for changed knowledge entries
   - DELETE (with confirmation) for orphans

6. Print summary:
   - Created: X playbooks, Y knowledge entries
   - Updated: X playbooks, Y knowledge entries
   - Deleted: X playbooks, Y knowledge entries
   - Unchanged: X playbooks, Y knowledge entries
```

---

## API Details

### Devin REST API (v1)

**Base URL:** `https://api.devin.ai/v1`
**Auth:** `Authorization: Bearer <API_KEY>`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List playbooks | `GET /v1/playbooks` | — |
| Create playbook | `POST /v1/playbooks` | `{ title, body, macro? }` |
| Update playbook | `PUT /v1/playbooks/{playbook_id}` | `{ title, body, macro? }` |
| Delete playbook | `DELETE /v1/playbooks/{playbook_id}` | — |
| List knowledge | `GET /v1/knowledge` | — |
| Create knowledge | `POST /v1/knowledge` | `{ name, body, trigger_description }` |
| Update knowledge | `PUT /v1/knowledge/{note_id}` | `{ name, body, trigger_description }` |
| Delete knowledge | `DELETE /v1/knowledge/{note_id}` | — |

**Rate limiting:** 429 responses possible. Implement exponential backoff.

**No bulk/batch endpoint** — must loop individual calls.

---

## File-to-API Mapping

### Playbooks

Local file: `.devin/playbooks/agents/security-sentinel.devin.md`

```json
{
  "title": "[CE] agent:security-sentinel",
  "body": "<full .devin.md content>"
}
```

_(No macro — agents are invoked via `@security_sentinel` references, not slash commands)_

Local file: `.devin/playbooks/workflows/workflows-brainstorm.devin.md`

```json
{
  "title": "[CE] workflow:brainstorm",
  "body": "<full .devin.md content>",
  "macro": "workflow_brainstorm"
}
```

- Title: `[CE] type:name` from directory (type) + filename (name)
- Macro: filename with hyphens → underscores, no prefix
- Body: entire `.devin.md` file content (with cross-references already transformed)

### Knowledge Entries

Local file: `.devin/knowledge/brainstorming.json`

```json
{
  "name": "[CE] knowledge:brainstorming",
  "body": "<from json.body>",
  "trigger_description": "<from json.trigger_description>"
}
```

- Name: `[CE] knowledge:` + JSON `title` field
- No macro (knowledge entries aren't slash commands)
- Body and trigger_description passed through from the JSON

---

## CLI Interface

```
Usage: converter sync devin [options]

Sync local .devin/ directory to Devin's API

Options:
  --api-key <key>       Devin API key (or set DEVIN_API_KEY env var)
  --dry-run             Preview changes without executing them
  --dir <path>          Path to .devin/ directory (default: ./.devin)
  --no-delete           Skip orphan deletion prompts entirely
  --yes                 Auto-confirm all delete prompts (non-interactive)
  --agents              Only sync agent playbooks
  --commands            Only sync command playbooks
  --workflows           Only sync workflow playbooks
  --knowledge           Only sync knowledge entries
  --only <names>        Sync specific entries by filename (comma-separated, e.g. security-sentinel,brainstorming)
  --pin-repo <repo>     Pin knowledge entries to a specific repo
```

### Example output (dry-run)

```
Syncing to Devin API (DRY RUN)...

Reading local .devin/ directory...
  Found 50 playbooks, 19 knowledge entries

Fetching remote state from Devin...
  Found 45 [CE] playbooks, 15 [CE] knowledge entries

Changes:
  CREATE  5 playbooks: [CE] agent:new-agent-1, [CE] agent:new-agent-2, ...
  UPDATE  3 playbooks: [CE] agent:security-sentinel (body changed), ...
  CREATE  4 knowledge: [CE] knowledge:new-skill-1, [CE] knowledge:new-skill-2, ...
  DELETE? 2 playbooks: [CE] agent:removed-agent (no local match)
  SKIP   42 playbooks, 15 knowledge (unchanged)

Run without --dry-run to apply changes.
```

---

## Behavioral Details

### Title Derivation

Playbook titles are derived from **directory (type) + filename (name)**, not from H1 headers in the body:

```
playbooks/agents/security-sentinel.devin.md       →  [CE] agent:security-sentinel
playbooks/workflows/workflows-brainstorm.devin.md  →  [CE] workflow:brainstorm
playbooks/commands/deepen-plan.devin.md            →  [CE] command:deepen-plan
knowledge/brainstorming.json                       →  [CE] knowledge:brainstorming
```

Rules:
- Type is derived from the parent directory (`agents/` → `agent:`, `workflows/` → `workflow:`, `commands/` → `command:`)
- For workflows, strip the `workflows-` filename prefix
- The H1 header inside the `.devin.md` file is left in the body as-is

### Rate Limiting

Reactive only — fire API calls sequentially as fast as possible. On 429 response, implement exponential backoff (1s, 2s, 4s) with max 3 retries. ~70 entries is small enough that proactive pacing adds unnecessary delay.

### Error Handling

Abort on first error. If any API call fails (after retries), stop the sync immediately and print what failed. Since sync is idempotent, the user fixes the issue and re-runs — already-synced entries will be detected as "unchanged" and skipped.

### Output Style

Colorized terminal output with status symbols:
- `✓ CREATE  [CE] agent:security-sentinel` (green)
- `~ UPDATE  [CE] knowledge:brainstorming` (yellow)
- `✗ DELETE  [CE] agent:removed-agent` (red)
- `· SKIP    [CE] workflow:plan` (dim)

---

## Edge Cases

1. **First run (empty Devin)** — all entries are CREATE. No orphans. Simple bulk import.
2. **Renamed entry** — old name becomes orphan (delete prompt), new name is created. User confirms delete.
3. **API rate limiting** — implement exponential backoff with max 3 retries per request.
4. **Large body content** — some skills have 8KB+ bodies. Devin API accepts these (no documented size limit).
5. **Network failure mid-sync** — partial state is fine since sync is idempotent. Re-run picks up where it left off.
6. **No .devin/ directory** — error with helpful message: "Run `convert --to devin` first."

---

## Open Questions

_None — all questions resolved during brainstorm._

---

## Resolved Questions

| Question | Decision | Rationale |
|----------|----------|-----------|
| Import, sync, or both? | Both | Both initial bulk import and ongoing sync are painful |
| Where to build it? | CLI sync subcommand | Natural fit with existing converter infrastructure |
| Delete policy? | Interactive confirmation | Safe by default, with `--yes` for automation |
| Auth method? | CLI flag + env var fallback | Most flexible, works locally and in CI |
| Combined or separate from convert? | Separate (sync reads .devin/) | Separation of concerns |
| Match strategy? | `[CE]` prefix convention | Avoids collisions, easy filtering, no state file needed |
| Dry-run? | Yes, `--dry-run` flag | Essential for safe syncing |
| Prefix? | `[CE]` | Short, recognizable, clean |
| Selective sync? | Category flags + `--only` | Users control scope without modifying .devin/ directory |
| Macros for slash commands? | Yes, for commands + workflows only | Agents do NOT get macros; invoked via @name references |
| Knowledge organization? | Folders + pinned_repo | Folders for categories, pinned_repo for auto-loading in relevant repos |
| Distribution? | CLI only | Keep sync in the converter; no separate package or skill needed |
| Title derivation? | Directory + filename | `[CE] type:name` from parent dir (type) + filename (name). No body parsing. |
| CLI knowledge flag? | `--knowledge` not `--skills` | Consistent with Devin terminology; avoids reintroducing "skills" confusion |
| Rate limiting? | Reactive (handle 429s) | Fire fast, back off on 429. ~70 entries is small enough. |
| Output style? | Colorized with symbols | Green/yellow/red with checkmarks. Rich terminal experience. |
| Error handling? | Abort on first error | Stop immediately on failure. User fixes and re-runs. Idempotent sync makes this safe. |

---

## Next Steps

Run `/workflows:plan` to design the implementation:
- Add `sync` subcommand to CLI
- Implement Devin API client (fetch-based, no SDK needed)
- Implement diff algorithm (local vs remote)
- Add interactive prompts for orphan deletion
- Add `--dry-run` mode
- Add rate limiting / backoff
- Write tests
