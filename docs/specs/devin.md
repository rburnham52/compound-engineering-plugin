# Devin Spec

Last verified: 2026-04-01

## Primary sources

```
https://docs.devin.ai/product-guides/creating-playbooks
https://docs.devin.ai/product-guides/using-playbooks
https://docs.devin.ai/onboard-devin/knowledge-onboarding
https://docs.devin.ai/onboard-devin/agents-md
https://docs.devin.ai/api-reference/overview
https://docs.devin.ai/product-guides/advanced-mode
```

## Playbooks (`.devin.md`)

- Playbooks are reusable prompt templates for recurring tasks. They can be created in the web app, uploaded as `.devin.md` files, or created via `POST /v1/playbooks` API.
- The playbook data model is: `title` (string, required), `body` (string, required), `macro` (string or null, optional for slash command binding).
- **Title convention:** `[CE] <category>:<name>` — e.g. `[CE] workflow:plan`, `[CE] agent:security-reviewer`, `[CE] knowledge:brainstorming`.
- **Macro convention:** `!ce_<name>` for workflows and commands (e.g. `!ce_plan`). Agent playbooks have `macro: null`.
- The body uses convention-based markdown sections that Devin recognizes. No rigid schema is enforced.

### Recognized sections

| Section | Purpose | Format |
|---|---|---|
| **Overview** | Goal and expected outcome | 1-3 sentences |
| **Procedure** | Step-by-step instructions | Numbered list, one action per line, imperative voice. Supports nested sub-bullets. Should be MECE (Mutually Exclusive, Collectively Exhaustive). |
| **Specifications** | Postconditions / expected end state | Bullet list |
| **Advice** | Tips and corrections to default behavior | Bullet list |
| **Forbidden Actions** | Explicit prohibitions | Bullet list |
| **What's Needed From User** | Required inputs before starting | Bullet list |

### Procedure guidelines

- One action per line, written imperatively (Write, Navigate, Run, etc.)
- Include action verbs at the start of each step
- Define execution order like code control flow
- Support nested sub-bullets for step-specific advice
- Avoid unnecessary specificity that hinders problem-solving

### Activation methods

1. Create in web app via "Create a new Playbook" button
2. Drag-and-drop `.devin.md` file when starting a session
3. Select from Team or Community playbook libraries
4. Attach to scheduled sessions
5. Create via `POST /v1/playbooks` API
6. Bind to slash command via `macro` field

## Knowledge entries

- Knowledge is contextual reference material surfaced automatically during sessions based on triggers.
- API request body: `{ name, body, trigger }` — **`trigger` not `trigger_description`** (v1 used `trigger_description`; v3 uses `trigger`).
- Response includes `note_id` (string) as the stable identifier for update/delete operations.
- Local storage format: `.devin/knowledge/<name>.json` with fields `{ title, body, trigger_description }` (note: local JSON uses `trigger_description`; sync converts this to `trigger` for the API).

### Trigger design

- Trigger specificity is critical for effective retrieval. Name the specific file, repo, or task type.
- Bad: "general coding advice" -- too broad, poor retrieval
- Good: "When writing database migrations for PostgreSQL" -- specific, targeted
- Good: "When working on authentication code in the users-api repository" -- repo-pinned

### Pinning behavior

- **Unpinned:** Activates only when trigger matches the current context
- **Repo-pinned:** Activates whenever Devin works in that specific repository
- **Pinned to all repos:** Loads in every session

### Content guidelines

- Keep to a single topic per entry
- Include specific file paths, commands, or code patterns
- Split complex topics across multiple entries rather than one large entry
- Body should be focused and concise

### Auto-generated knowledge

Devin automatically creates knowledge from: README files, `AGENTS.md`, `.rules`, `.mdc`, `.cursorrules`, `.windsurf`, and `CLAUDE.md` files found in connected repositories.

## Custom slash commands

- Five built-in commands: `/plan`, `/review`, `/test`, `/think-hard`, `/implement`
- Enterprise teams can create custom commands through Organization Settings (admin-only)
- The binding mechanism is the `macro` field on playbook or knowledge API objects
- Setting `macro` to a command string (e.g., `"review"`) binds it as `/review`
- The converter emits macros as `!ce_<name>` (e.g. `!ce_plan`, `!ce_work`), which Devin renders as `/ce_plan` etc.
- Agent playbooks always have `macro: null` — they are invoked by referencing the playbook, not a slash command.

## MCP servers

- Devin supports MCP (Model Context Protocol) with stdio, SSE, and HTTP transports
- Configuration is done via the web UI: Settings > MCP Marketplace
- Pre-built integrations available for Sentry, Datadog, PostgreSQL, Linear, Slack, Figma, etc.
- Custom MCP servers can be added via "Add Your Own" option in the marketplace
- Most integrations require OAuth credentials, API keys, or connection strings
- Service accounts recommended over personal accounts for org-wide sharing
- There is no file-based MCP configuration (unlike Claude Code `.mcp.json` or Gemini `settings.json`)

## AGENTS.md

- Devin auto-discovers `AGENTS.md` files in project root and reads them before coding
- Follows the open standard at https://agents.md/
- Recommended content: setup commands, code style guidelines, testing requirements, directory structure, development workflow
- Hierarchical: AGENTS.md files in subdirectories override parent files

## Session tools

Devin has three primary tools during sessions:
1. **Shell/Terminal** -- full command-line access
2. **IDE (VSCode)** -- interactive code editing with jump-to-definition
3. **Browser** -- interactive browser for testing and web tasks

## API (v1/v2/v3)

### v1 (Org-Scoped)

Base: `https://api.devin.ai/v1/*`
Auth: Personal or Service API keys (`Authorization: Bearer <key>`)

Key endpoints:
- `POST /v1/sessions` -- Create session (prompt, playbook_id, knowledge_ids, tags, max_acu_limit)
- `POST /v1/sessions/{id}/message` -- Send message to active session
- `GET /v1/sessions/{id}` -- Get session details

### v2 (Enterprise)

Base: `https://api.devin.ai/v2/enterprise/*`
Auth: Enterprise admin API keys only

### v3 (RBAC)

Base: `https://api.devin.ai/v3beta1/` (playbooks) and `https://api.devin.ai/v3/` (knowledge)
Auth: Full role-based access control with service user authentication

Playbook endpoints (org-scoped):
- `GET /v3beta1/organizations/{orgId}/playbooks` -- List playbooks (paginated, `cursor`/`has_more`)
- `POST /v3beta1/organizations/{orgId}/playbooks` -- Create playbook (`{ title, body, macro }`)
- `PUT /v3beta1/organizations/{orgId}/playbooks/{playbookId}` -- Update playbook (`{ title, body, macro }`)
- `DELETE /v3beta1/organizations/{orgId}/playbooks/{playbookId}` -- Delete playbook
- `macro` is `null` for agent playbooks; `!ce_<name>` for workflows and commands
- Response includes `playbook_id` as stable identifier
- Category is encoded in the `title` prefix: `[CE] agent:name`, `[CE] workflow:name`, `[CE] command:name`, `[CE] knowledge:name`
- Sync identifies CE-owned entries by the `[CE]` title prefix

Knowledge endpoints (org-scoped):
- `GET /v3/organizations/{orgId}/knowledge/notes` -- List notes (paginated, same `cursor`/`has_more` shape)
- `POST /v3/organizations/{orgId}/knowledge/notes` -- Create note (`{ name, body, trigger }`)
- `PUT /v3/organizations/{orgId}/knowledge/notes/{noteId}` -- Update note (`{ name, body, trigger }`)
- `DELETE /v3/organizations/{orgId}/knowledge/notes/{noteId}` -- Delete note
- **`trigger`** (not `trigger_description`) is the field name in v3 API requests/responses
- Response includes `note_id` as stable identifier

## Scheduled sessions

- Recurring or one-time automated sessions
- Configuration: name, schedule type (cron or one-time), agent selection, prompt, playbook attachment
- Playbooks attached to schedules apply on every run
- Statuses: Active, Paused, Error
- Email notifications: always, on failure, or never

## Advanced Mode

Enterprise/Team feature with five capabilities:
1. **Analyze Sessions** -- review existing sessions for patterns
2. **Create Playbooks** -- convert successful sessions into playbooks
3. **Improve Playbooks** -- refine playbooks from session feedback
4. **Start Batch Sessions** -- create multiple sessions at once with optional shared playbook
5. **Manage Knowledge** -- deduplicate and organize knowledge entries

## Local file layout (converter output)

The `convert --to devin` command writes:

```
.devin/
  playbooks/
    agents/<name>.devin.md       # [CE] agent:name playbooks
    workflows/<name>.devin.md    # [CE] workflow:name playbooks (from ce:/workflows: skills)
    commands/<name>.devin.md     # [CE] command:name playbooks (other commands)
  knowledge/<name>.json          # knowledge entries ({ title, body, trigger_description })
  mcp-setup-instructions.md      # generated if plugin has MCP servers
```

## Config file locations

- No local config directory convention (unlike `.claude/`, `.gemini/`, `.cursor/`)
- All configuration is via web UI and API
- AGENTS.md is the primary file-based configuration mechanism
- Playbooks can be stored as `.devin.md` files anywhere (attached at session start)
