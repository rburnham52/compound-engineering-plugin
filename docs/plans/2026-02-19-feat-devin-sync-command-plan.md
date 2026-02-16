---
title: "feat: Add sync devin CLI command"
type: feat
status: completed
date: 2026-02-19
depends_on: 2026-02-19-feat-devin-converter-content-fixes-plan.md
---

# Add Sync Devin CLI Command

## Overview

Add a `sync devin` subcommand to the existing CLI that reads local `.devin/` output files (produced by `convert --to devin`) and pushes playbooks and knowledge entries to Devin's REST API. Handles initial bulk import (~70 entries) and ongoing incremental sync with create, update, and interactive delete.

## Problem Statement

The converter produces 50+ playbooks and 19 knowledge entries as local files in `.devin/`. But Devin does NOT auto-discover these files from a git repo. Each playbook and knowledge entry must be created individually through the web UI or API. This makes initial setup painful (~70 manual entries) and ongoing sync error-prone.

## Proposed Solution

Extend the existing `sync` command to support a `devin` target that:
1. Reads local `.devin/playbooks/**/*.devin.md` and `.devin/knowledge/*.json`
2. Constructs `[CE] type:name` titles from directory + filename
3. Fetches remote state from Devin API, filtered to `[CE]`-prefixed entries
4. Diffs local vs remote to compute create/update/delete operations
5. Executes changes sequentially with rate-limit backoff
6. Supports `--dry-run`, category filters, and interactive delete confirmation

## Technical Approach

### Architecture: Sync Pipeline

```
1. Validate inputs (API key, .devin/ exists, local files parse)
2. Read local state → LocalEntry[]
3. Fetch remote state (paginated) → RemoteEntry[]
4. Filter remote to [CE] prefix
5. Apply category/name filters
6. Diff local vs remote → SyncPlan { creates, updates, deletes, unchanged }
7. Display plan (always, even without --dry-run)
8. Execute plan (unless --dry-run)
   - Creates (POST)
   - Updates (PUT)
   - Deletes (with confirmation, DELETE)
9. Print summary
```

### Where It Lives

Add `"devin"` to the existing `sync` command's valid targets in `src/commands/sync.ts`. The existing sync reads from `~/.claude/` and writes to local filesystems. The Devin target diverges: it reads from `.devin/` and pushes to a REST API. Route to a separate `src/sync/devin.ts` module when `target === "devin"`.

This keeps a single `sync` entry point while isolating the fundamentally different Devin implementation.

### Implementation Phases

#### Phase 1: Types and API Client

**New file:** `src/sync/devin.ts`
**Modified file:** `src/types/devin.ts`

**1a. Add API types to `src/types/devin.ts`**

```typescript
// Devin API response types (from GET endpoints)
export type DevinApiPlaybook = {
  playbook_id: string
  title: string
  body: string
  macro: string | null
}

export type DevinApiKnowledgeEntry = {
  note_id: string
  name: string
  body: string
  trigger_description: string
  parent_folder_id: string | null
  pinned_repo: string | null
}

// Sync-specific types
export type LocalPlaybookEntry = {
  name: string
  title: string          // [CE] type:name
  body: string           // Full .devin.md content
  category: "agent" | "command" | "workflow"
  macro: string | null   // For commands/workflows only
  filePath: string       // For error messages
}

export type LocalKnowledgeEntry = {
  name: string
  title: string          // [CE] knowledge:name
  body: string
  triggerDescription: string
  filePath: string
}

export type SyncAction = "create" | "update" | "delete" | "unchanged"

export type SyncEntry = {
  title: string
  action: SyncAction
  localBody?: string
  remoteId?: string
  category: "playbook" | "knowledge"
}

export type SyncPlan = {
  creates: SyncEntry[]
  updates: SyncEntry[]
  deletes: SyncEntry[]
  unchanged: SyncEntry[]
}

export type SyncResult = {
  created: number
  updated: number
  deleted: number
  unchanged: number
  errors: string[]
}

export type SyncDevinOptions = {
  apiKey: string
  dryRun: boolean
  dir: string
  noDelete: boolean
  autoConfirm: boolean
  agents: boolean
  commands: boolean
  workflows: boolean
  knowledge: boolean
  only: string[]
  pinRepo?: string
}
```

**1b. Create Devin API client**

Use Bun's built-in `fetch()` — no external dependencies (consistent with the zero-dependency pattern in the codebase).

```typescript
// src/sync/devin.ts

const DEVIN_API_BASE = "https://api.devin.ai/v1"

async function devinFetch<T>(
  path: string,
  apiKey: string,
  options?: { method?: string; body?: unknown }
): Promise<T> {
  const { method = "GET", body } = options ?? {}
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  }
  if (body) headers["Content-Type"] = "application/json"

  const res = await fetch(`${DEVIN_API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 429) {
    throw new RateLimitError(res)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new DevinApiError(method, path, res.status, text)
  }

  if (method === "DELETE") return undefined as T
  return res.json() as Promise<T>
}
```

**1c. Rate limiting with exponential backoff**

```typescript
async function devinFetchWithRetry<T>(
  path: string,
  apiKey: string,
  options?: { method?: string; body?: unknown },
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await devinFetch<T>(path, apiKey, options)
    } catch (err) {
      if (err instanceof RateLimitError && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000  // 1s, 2s, 4s
        console.log(`  Rate limited, retrying in ${delay / 1000}s...`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw new Error("Unreachable")
}

class RateLimitError extends Error {
  constructor(public response: Response) {
    super("Rate limited (429)")
  }
}

class DevinApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public responseBody: string
  ) {
    super(`Devin API ${method} ${path}: ${status} ${responseBody.slice(0, 200)}`)
  }
}
```

#### Phase 2: Local State Reader

**File:** `src/sync/devin.ts`

Read the `.devin/` directory and construct typed local entries with `[CE]` titles.

```typescript
import { walkFiles, readText, readJson, pathExists } from "../utils/files"
import path from "path"

const CE_PREFIX = "[CE]"

async function readLocalState(
  devinDir: string,
  options: SyncDevinOptions
): Promise<{ playbooks: LocalPlaybookEntry[]; knowledge: LocalKnowledgeEntry[] }> {
  if (!await pathExists(devinDir)) {
    throw new Error(
      `No .devin/ directory found at ${devinDir}. Run 'convert --to devin' first.`
    )
  }

  const playbooks: LocalPlaybookEntry[] = []
  const knowledge: LocalKnowledgeEntry[] = []

  // Read playbooks from each category subdirectory
  const categories = [
    { dir: "agents", category: "agent" as const, filter: options.agents },
    { dir: "commands", category: "command" as const, filter: options.commands },
    { dir: "workflows", category: "workflow" as const, filter: options.workflows },
  ]

  // Determine if any category filter is active
  const anyFilterActive = options.agents || options.commands || options.workflows || options.knowledge

  for (const { dir, category, filter } of categories) {
    // Skip if category filter is active but this category is not selected
    if (anyFilterActive && !filter && !options.knowledge) continue
    if (anyFilterActive && !filter) continue

    const playbookDir = path.join(devinDir, "playbooks", dir)
    if (!await pathExists(playbookDir)) continue

    const files = await walkFiles(playbookDir)
    for (const filePath of files) {
      if (!filePath.endsWith(".devin.md")) continue

      const filename = path.basename(filePath, ".devin.md")
      let name = filename

      // Strip workflows- prefix for workflow category
      if (category === "workflow") {
        name = name.replace(/^workflows-/, "")
      }

      // Apply --only filter
      if (options.only.length > 0 && !options.only.includes(name)) continue

      const body = await readText(filePath)
      const title = `${CE_PREFIX} ${category}:${name}`
      const macro = category === "agent"
        ? null
        : category === "workflow"
          ? `workflow_${name.replace(/-/g, "_")}`
          : name.replace(/-/g, "_")

      playbooks.push({ name, title, body: body.trim(), category, macro, filePath })
    }
  }

  // Read knowledge entries
  if (!anyFilterActive || options.knowledge) {
    const knowledgeDir = path.join(devinDir, "knowledge")
    if (await pathExists(knowledgeDir)) {
      const files = await walkFiles(knowledgeDir)
      for (const filePath of files) {
        if (!filePath.endsWith(".json")) continue

        const name = path.basename(filePath, ".json")
        if (options.only.length > 0 && !options.only.includes(name)) continue

        const json = await readJson<{
          title: string
          body: string
          trigger_description: string
        }>(filePath)

        // Validate required fields
        if (!json.body || !json.trigger_description) {
          throw new Error(`Invalid knowledge file ${filePath}: missing body or trigger_description`)
        }

        const title = `${CE_PREFIX} knowledge:${name}`
        knowledge.push({
          name,
          title,
          body: json.body,
          triggerDescription: json.trigger_description,
          filePath,
        })
      }
    }
  }

  return { playbooks, knowledge }
}
```

#### Phase 3: Remote State Fetcher

Fetch all existing entries from the Devin API, handling pagination.

```typescript
async function fetchRemotePlaybooks(
  apiKey: string
): Promise<DevinApiPlaybook[]> {
  // Fetch all pages — API may paginate
  const all: DevinApiPlaybook[] = []
  let url = "/v1/playbooks"

  // Simple approach: fetch until we get fewer results than expected
  // Adjust based on actual API pagination behavior
  const response = await devinFetchWithRetry<{
    playbooks: DevinApiPlaybook[]
  }>(url, apiKey)

  all.push(...response.playbooks)
  return all
}

async function fetchRemoteKnowledge(
  apiKey: string
): Promise<DevinApiKnowledgeEntry[]> {
  const response = await devinFetchWithRetry<{
    knowledge_items: DevinApiKnowledgeEntry[]
  }>("/v1/knowledge", apiKey)

  return response.knowledge_items
}

function filterCEEntries<T extends { title?: string; name?: string }>(
  entries: T[]
): T[] {
  return entries.filter(e => {
    const label = e.title ?? e.name ?? ""
    return label.startsWith(CE_PREFIX)
  })
}
```

**Note on pagination:** The initial implementation fetches a single page. If the API paginates, this must be extended with cursor-based fetching. Add a TODO comment and test with the actual API to confirm pagination behavior before the first production sync.

#### Phase 4: Diff Algorithm

Compare local vs remote to produce a sync plan.

```typescript
function computeSyncPlan(
  localPlaybooks: LocalPlaybookEntry[],
  localKnowledge: LocalKnowledgeEntry[],
  remotePlaybooks: DevinApiPlaybook[],
  remoteKnowledge: DevinApiKnowledgeEntry[],
  options: SyncDevinOptions
): SyncPlan {
  const plan: SyncPlan = { creates: [], updates: [], deletes: [], unchanged: [] }

  // Index remote entries by title for O(1) lookup
  const remotePlaybooksByTitle = Object.create(null) as Record<string, DevinApiPlaybook>
  for (const rp of remotePlaybooks) {
    remotePlaybooksByTitle[rp.title] = rp
  }

  const remoteKnowledgeByName = Object.create(null) as Record<string, DevinApiKnowledgeEntry>
  for (const rk of remoteKnowledge) {
    remoteKnowledgeByName[rk.name] = rk
  }

  // Track which remote entries have a local match
  const matchedRemotePlaybookTitles = new Set<string>()
  const matchedRemoteKnowledgeNames = new Set<string>()

  // Diff playbooks
  for (const local of localPlaybooks) {
    const remote = remotePlaybooksByTitle[local.title]
    if (!remote) {
      plan.creates.push({
        title: local.title,
        action: "create",
        localBody: local.body,
        category: "playbook",
      })
    } else {
      matchedRemotePlaybookTitles.add(local.title)
      // Compare content — normalize trailing whitespace
      if (local.body.trim() === remote.body.trim()) {
        plan.unchanged.push({
          title: local.title,
          action: "unchanged",
          remoteId: remote.playbook_id,
          category: "playbook",
        })
      } else {
        plan.updates.push({
          title: local.title,
          action: "update",
          localBody: local.body,
          remoteId: remote.playbook_id,
          category: "playbook",
        })
      }
    }
  }

  // Diff knowledge
  for (const local of localKnowledge) {
    const remote = remoteKnowledgeByName[local.title]
    if (!remote) {
      plan.creates.push({
        title: local.title,
        action: "create",
        localBody: local.body,
        category: "knowledge",
      })
    } else {
      matchedRemoteKnowledgeNames.add(local.title)
      if (local.body.trim() === remote.body.trim()) {
        plan.unchanged.push({
          title: local.title,
          action: "unchanged",
          remoteId: remote.note_id,
          category: "knowledge",
        })
      } else {
        plan.updates.push({
          title: local.title,
          action: "update",
          localBody: local.body,
          remoteId: remote.note_id,
          category: "knowledge",
        })
      }
    }
  }

  // Find orphans (remote [CE] entries with no local match)
  if (!options.noDelete) {
    for (const rp of remotePlaybooks) {
      if (!matchedRemotePlaybookTitles.has(rp.title)) {
        // Respect category filters for orphan detection
        const anyFilterActive = options.agents || options.commands || options.workflows || options.knowledge
        if (anyFilterActive) {
          // Only report orphans for active categories
          const category = extractCategoryFromTitle(rp.title)
          if (category === "agent" && !options.agents) continue
          if (category === "command" && !options.commands) continue
          if (category === "workflow" && !options.workflows) continue
        }
        plan.deletes.push({
          title: rp.title,
          action: "delete",
          remoteId: rp.playbook_id,
          category: "playbook",
        })
      }
    }

    for (const rk of remoteKnowledge) {
      if (!matchedRemoteKnowledgeNames.has(rk.name)) {
        if ((options.agents || options.commands || options.workflows) && !options.knowledge) continue
        plan.deletes.push({
          title: rk.name,
          action: "delete",
          remoteId: rk.note_id,
          category: "knowledge",
        })
      }
    }
  }

  return plan
}

function extractCategoryFromTitle(title: string): string | null {
  const match = title.match(/^\[CE\] (\w+):/)
  return match?.[1] ?? null
}
```

#### Phase 5: Plan Executor

Execute the sync plan by calling the Devin API.

```typescript
async function executeSyncPlan(
  plan: SyncPlan,
  localPlaybooks: LocalPlaybookEntry[],
  localKnowledge: LocalKnowledgeEntry[],
  apiKey: string,
  options: SyncDevinOptions
): Promise<SyncResult> {
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, unchanged: plan.unchanged.length, errors: [] }

  // Index local entries by title for body lookup
  const localByTitle = Object.create(null) as Record<string, LocalPlaybookEntry | LocalKnowledgeEntry>
  for (const lp of localPlaybooks) localByTitle[lp.title] = lp
  for (const lk of localKnowledge) localByTitle[lk.title] = lk

  // Creates
  for (const entry of plan.creates) {
    const local = localByTitle[entry.title]
    if (!local) continue

    console.log(`  \x1b[32m+ CREATE\x1b[0m  ${entry.title}`)

    if (entry.category === "playbook") {
      const pb = local as LocalPlaybookEntry
      await devinFetchWithRetry("/v1/playbooks", apiKey, {
        method: "POST",
        body: { title: pb.title, body: pb.body, macro: pb.macro },
      })
    } else {
      const ke = local as LocalKnowledgeEntry
      await devinFetchWithRetry("/v1/knowledge", apiKey, {
        method: "POST",
        body: {
          name: ke.title,
          body: ke.body,
          trigger_description: ke.triggerDescription,
          ...(options.pinRepo ? { pinned_repo: options.pinRepo } : {}),
        },
      })
    }
    result.created++
  }

  // Updates
  for (const entry of plan.updates) {
    const local = localByTitle[entry.title]
    if (!local || !entry.remoteId) continue

    console.log(`  \x1b[33m~ UPDATE\x1b[0m  ${entry.title}`)

    if (entry.category === "playbook") {
      const pb = local as LocalPlaybookEntry
      await devinFetchWithRetry(`/v1/playbooks/${entry.remoteId}`, apiKey, {
        method: "PUT",
        body: { title: pb.title, body: pb.body, macro: pb.macro },
      })
    } else {
      const ke = local as LocalKnowledgeEntry
      await devinFetchWithRetry(`/v1/knowledge/${entry.remoteId}`, apiKey, {
        method: "PUT",
        body: {
          name: ke.title,
          body: ke.body,
          trigger_description: ke.triggerDescription,
          ...(options.pinRepo ? { pinned_repo: options.pinRepo } : {}),
        },
      })
    }
    result.updated++
  }

  // Deletes (with confirmation)
  for (const entry of plan.deletes) {
    if (!entry.remoteId) continue

    let confirmed = options.autoConfirm
    if (!confirmed) {
      // Interactive confirmation using stdin
      confirmed = await promptYesNo(`  Delete ${entry.title}?`)
    }

    if (confirmed) {
      console.log(`  \x1b[31m- DELETE\x1b[0m  ${entry.title}`)
      const endpoint = entry.category === "playbook"
        ? `/v1/playbooks/${entry.remoteId}`
        : `/v1/knowledge/${entry.remoteId}`
      await devinFetchWithRetry(endpoint, apiKey, { method: "DELETE" })
      result.deleted++
    } else {
      console.log(`  \x1b[2m. SKIP\x1b[0m    ${entry.title} (delete declined)`)
    }
  }

  return result
}

async function promptYesNo(message: string): Promise<boolean> {
  process.stdout.write(`${message} (y/N) `)
  // Read a line from stdin
  const reader = process.stdin[Symbol.asyncIterator]()
  const { value } = await reader.next()
  const line = typeof value === "string" ? value : new TextDecoder().decode(value)
  return line.trim().toLowerCase() === "y"
}
```

#### Phase 6: CLI Integration

**Modified file:** `src/commands/sync.ts`

Add `"devin"` to valid targets and route to the new sync function.

```typescript
// In src/commands/sync.ts — add to existing validTargets
const validTargets = ["opencode", "codex", "pi", "droid", "cursor", "devin"]

// Add Devin-specific args (only relevant when target === "devin")
args: {
  target: { type: "positional", required: true, description: "Target format" },
  claudeHome: { type: "string", alias: "claude-home", description: "..." },
  // Devin-specific
  apiKey: { type: "string", alias: "api-key", description: "Devin API key (or DEVIN_API_KEY env)" },
  dryRun: { type: "boolean", alias: "dry-run", default: false, description: "Preview changes" },
  dir: { type: "string", default: ".devin", description: "Path to .devin/ directory" },
  noDelete: { type: "boolean", alias: "no-delete", default: false, description: "Skip orphan deletion" },
  yes: { type: "boolean", default: false, description: "Auto-confirm deletions" },
  agents: { type: "boolean", default: false, description: "Only sync agents" },
  commands: { type: "boolean", default: false, description: "Only sync commands" },
  workflows: { type: "boolean", default: false, description: "Only sync workflows" },
  knowledge: { type: "boolean", default: false, description: "Only sync knowledge" },
  only: { type: "string", description: "Sync specific entries (comma-separated)" },
  pinRepo: { type: "string", alias: "pin-repo", description: "Pin knowledge to a repo" },
}

// In run(), route to devin sync
if (target === "devin") {
  const { syncToDevin } = await import("../sync/devin")
  const apiKey = args.apiKey || process.env.DEVIN_API_KEY
  if (!apiKey) {
    console.error("Error: Devin API key required. Use --api-key or set DEVIN_API_KEY env var.")
    process.exit(1)
  }
  await syncToDevin(args.dir, apiKey, {
    dryRun: args.dryRun,
    noDelete: args.noDelete,
    autoConfirm: args.yes,
    agents: args.agents,
    commands: args.commands,
    workflows: args.workflows,
    knowledge: args.knowledge,
    only: args.only ? args.only.split(",").map(s => s.trim()) : [],
    pinRepo: args.pinRepo,
  })
  return
}
```

#### Phase 7: Main Sync Orchestrator

**File:** `src/sync/devin.ts`

The top-level function that ties everything together.

```typescript
export async function syncToDevin(
  devinDir: string,
  apiKey: string,
  options: SyncDevinOptions
): Promise<void> {
  console.log(options.dryRun
    ? "Syncing to Devin API (DRY RUN)..."
    : "Syncing to Devin API..."
  )

  // 1. Validate API key with a lightweight call
  console.log("\nValidating API key...")
  try {
    await devinFetchWithRetry<unknown>("/v1/playbooks", apiKey)
  } catch (err) {
    if (err instanceof DevinApiError && err.status === 401) {
      throw new Error("Invalid Devin API key. Check your key at Devin Settings > API Keys.")
    }
    throw err
  }

  // 2. Read local state
  console.log("\nReading local .devin/ directory...")
  const local = await readLocalState(devinDir, options)
  console.log(`  Found ${local.playbooks.length} playbooks, ${local.knowledge.length} knowledge entries`)

  // 3. Fetch remote state
  console.log("\nFetching remote state from Devin...")
  const remotePlaybooks = filterCEEntries(await fetchRemotePlaybooks(apiKey))
  const remoteKnowledge = filterCEEntries(await fetchRemoteKnowledge(apiKey))
  console.log(`  Found ${remotePlaybooks.length} [CE] playbooks, ${remoteKnowledge.length} [CE] knowledge entries`)

  // 4. Compute diff
  const plan = computeSyncPlan(
    local.playbooks, local.knowledge,
    remotePlaybooks, remoteKnowledge,
    options
  )

  // 5. Display plan
  console.log("\nChanges:")
  if (plan.creates.length) {
    console.log(`  CREATE  ${plan.creates.length}: ${plan.creates.map(e => e.title).join(", ")}`)
  }
  if (plan.updates.length) {
    console.log(`  UPDATE  ${plan.updates.length}: ${plan.updates.map(e => e.title).join(", ")}`)
  }
  if (plan.deletes.length) {
    console.log(`  DELETE? ${plan.deletes.length}: ${plan.deletes.map(e => e.title).join(", ")}`)
  }
  if (plan.unchanged.length) {
    console.log(`  SKIP    ${plan.unchanged.length} (unchanged)`)
  }

  const totalChanges = plan.creates.length + plan.updates.length + plan.deletes.length
  if (totalChanges === 0) {
    console.log("\nEverything is up to date.")
    return
  }

  // 6. Execute (unless dry-run)
  if (options.dryRun) {
    console.log("\nRun without --dry-run to apply changes.")
    return
  }

  console.log("\nExecuting...")
  const result = await executeSyncPlan(
    plan, local.playbooks, local.knowledge, apiKey, options
  )

  // 7. Print summary
  console.log("\nSync complete:")
  console.log(`  Created:   ${result.created}`)
  console.log(`  Updated:   ${result.updated}`)
  console.log(`  Deleted:   ${result.deleted}`)
  console.log(`  Unchanged: ${result.unchanged}`)
}
```

#### Phase 8: Tests

**New file:** `tests/sync-devin.test.ts`

Following the codebase pattern: `bun:test`, manual fetch mocking, temp directories.

**8a. Test infrastructure — mock fetch**

```typescript
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { syncToDevin } from "../src/sync/devin"
import fs from "fs/promises"
import os from "os"
import path from "path"

function createMockFetch(
  remotePlaybooks: DevinApiPlaybook[] = [],
  remoteKnowledge: DevinApiKnowledgeEntry[] = []
) {
  const calls: { url: string; method: string; body?: unknown }[] = []

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, method, body })

    if (url.includes("/v1/playbooks") && method === "GET") {
      return new Response(JSON.stringify({ playbooks: remotePlaybooks }))
    }
    if (url.includes("/v1/knowledge") && method === "GET") {
      return new Response(JSON.stringify({ knowledge_items: remoteKnowledge }))
    }
    if (method === "POST" || method === "PUT") {
      return new Response(JSON.stringify({ id: "new-id" }))
    }
    if (method === "DELETE") {
      return new Response("", { status: 204 })
    }
    return new Response("", { status: 404 })
  }

  return { mockFetch, calls }
}

async function createTempDevinDir() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-sync-test-"))
  const devinDir = path.join(tempRoot, ".devin")
  await fs.mkdir(path.join(devinDir, "playbooks", "agents"), { recursive: true })
  await fs.mkdir(path.join(devinDir, "playbooks", "commands"), { recursive: true })
  await fs.mkdir(path.join(devinDir, "playbooks", "workflows"), { recursive: true })
  await fs.mkdir(path.join(devinDir, "knowledge"), { recursive: true })
  return { tempRoot, devinDir }
}
```

**8b. Test cases**

```typescript
describe("syncToDevin", () => {
  // Test: first-time sync creates all entries
  test("creates all entries on first sync", async () => { ... })

  // Test: incremental sync detects unchanged
  test("skips unchanged entries", async () => { ... })

  // Test: detects changed content and updates
  test("updates entries with changed body", async () => { ... })

  // Test: detects orphans for deletion
  test("identifies orphaned remote entries", async () => { ... })

  // Test: dry-run makes no API mutations
  test("dry-run does not call POST/PUT/DELETE", async () => { ... })

  // Test: category filters scope the sync
  test("--agents only syncs agent playbooks", async () => { ... })

  // Test: --only filter scopes to named entries
  test("--only filters to specific entries", async () => { ... })

  // Test: --no-delete skips orphan detection
  test("--no-delete omits delete entries from plan", async () => { ... })

  // Test: rate limiting retries on 429
  test("retries on 429 with exponential backoff", async () => { ... })

  // Test: aborts on API error
  test("aborts on non-429 API error", async () => { ... })

  // Test: missing .devin/ directory produces clear error
  test("errors when .devin/ directory does not exist", async () => { ... })

  // Test: invalid API key detected early
  test("validates API key before starting sync", async () => { ... })
})

describe("readLocalState", () => {
  // Test: reads all file types
  test("reads agents, commands, workflows, and knowledge", async () => { ... })

  // Test: constructs correct [CE] titles
  test("produces [CE] type:name titles", async () => { ... })

  // Test: strips workflows- prefix
  test("strips workflows- prefix for workflow names", async () => { ... })

  // Test: assigns macros only to commands/workflows
  test("agents have null macro", async () => { ... })
  test("commands have underscore macro", async () => { ... })
  test("workflows have workflow_ prefixed macro", async () => { ... })
})

describe("computeSyncPlan", () => {
  // Test: all NEW when remote is empty
  test("all entries are creates when remote is empty", () => { ... })

  // Test: content comparison normalizes whitespace
  test("trailing whitespace does not cause false updates", () => { ... })

  // Test: orphan detection respects category filters
  test("orphan detection scoped to active category filter", () => { ... })
})
```

#### Phase 9: Update Existing Sync Command Validation

**File:** `src/commands/sync.ts`

Update the valid targets list and add the Devin route:

```diff
- const validTargets = ["opencode", "codex", "pi", "droid", "cursor"]
+ const validTargets = ["opencode", "codex", "pi", "droid", "cursor", "devin"]
```

## Acceptance Criteria

### Functional Requirements

- [ ] `sync devin --api-key <key>` creates all entries on first sync
- [ ] Subsequent syncs detect unchanged entries and skip them
- [ ] Changed content triggers UPDATE via PUT
- [ ] Orphaned [CE] entries prompt for deletion confirmation
- [ ] `--dry-run` shows plan without making API calls
- [ ] `--no-delete` skips orphan detection entirely
- [ ] `--yes` auto-confirms deletion without prompts
- [ ] `--agents` / `--commands` / `--workflows` / `--knowledge` filter by category
- [ ] `--only name1,name2` filters to specific entries
- [ ] `--pin-repo <repo>` sets `pinned_repo` on knowledge entries
- [ ] `DEVIN_API_KEY` env var works as fallback for `--api-key`
- [ ] Missing API key produces clear error message
- [ ] Missing .devin/ directory produces clear error with instructions
- [ ] Invalid API key detected before full sync starts
- [ ] 429 rate limits handled with exponential backoff (1s, 2s, 4s, max 3 retries)
- [ ] Non-429 API errors abort sync immediately
- [ ] Agent playbooks have no macro field
- [ ] Command playbooks have macro = `name_with_underscores`
- [ ] Workflow playbooks have macro = `workflow_name_with_underscores`
- [ ] Knowledge entries use `[CE] knowledge:name` for API `name` field
- [ ] Playbook titles use `[CE] type:name` format
- [ ] Orphan detection scoped to active category filters
- [ ] Colorized terminal output with status symbols

### Quality Gates

- [ ] All existing tests pass (no regressions)
- [ ] New tests for sync orchestrator, local reader, diff algorithm, API client
- [ ] Tests mock `fetch()` without external dependencies
- [ ] `sync devin --dry-run` tested end-to-end
- [ ] Error cases tested (missing dir, bad API key, rate limiting, network failure)

## Dependencies & Risks

### Dependencies
- **Converter content fixes** — must ship first (the `[CE] type:name` titles and macro fields depend on it)
- **Devin API v1** — endpoints for playbooks and knowledge CRUD

### Risks
- **API pagination** — If `GET /v1/playbooks` paginates, orphan detection will be incomplete. Mitigate: test with real API, implement cursor-based pagination if needed.
- **API response shape unknown** — The exact response fields for GET endpoints are not fully documented. Mitigate: validate with real API call before implementing.
- **Content comparison false positives** — If the API normalizes content differently than local files (e.g., strips trailing newlines), every sync will show false CHANGED entries. Mitigate: trim whitespace before comparison.
- **Concurrent sync conflicts** — Two developers syncing from different local states can delete each other's entries. Mitigate: document single-operator convention.
- **Large knowledge bodies** — Some entries exceed 8KB. Mitigate: Devin API has no documented size limit, but add warning for bodies > 50KB.

### Edge Cases

1. **First run (empty Devin)** — All entries are CREATE. No orphans. Simple bulk import.
2. **Renamed entry** — Old name becomes orphan (delete prompt), new name is created.
3. **Empty .devin/ directory** — Error with helpful message.
4. **Manually created [CE] entries** — If a user manually creates `[CE] agent:custom` in Devin web UI, sync treats it as an orphan. Mitigate: interactive delete prompt gives user a chance to decline.
5. **Partial sync after error** — Re-run picks up where it left off (idempotent).
6. **Stale knowledge JSON title** — Sync uses filename, not JSON `title` field, for the API `name`. The JSON `title` is ignored.
7. **mcp-setup-instructions.md** — Excluded from sync (informational file, not a playbook or knowledge entry).

## New Files

| File | Purpose |
|------|---------|
| `src/sync/devin.ts` | Core sync logic (API client, local reader, diff, executor) |
| `tests/sync-devin.test.ts` | Tests with mocked fetch |

## Modified Files

| File | Change |
|------|--------|
| `src/commands/sync.ts` | Add `"devin"` to valid targets, route to `syncToDevin()`, add Devin-specific CLI args |
| `src/types/devin.ts` | Add API response types (`DevinApiPlaybook`, `DevinApiKnowledgeEntry`) and sync types |

## References & Research

### Internal References
- Brainstorm: `docs/brainstorms/2026-02-19-devin-sync-command-brainstorm.md`
- Converter plan: `docs/plans/2026-02-19-feat-devin-converter-content-fixes-plan.md`
- Existing sync command: `src/commands/sync.ts`
- Existing sync targets: `src/sync/opencode.ts`, `src/sync/cursor.ts`, etc.
- CLI framework: citty (`defineCommand`, `runMain`)
- File utilities: `src/utils/files.ts` (`walkFiles`, `readText`, `readJson`, `pathExists`)
- Devin types: `src/types/devin.ts`
- Devin spec: `docs/specs/devin.md`

### Devin API Reference
- Base URL: `https://api.devin.ai/v1`
- Auth: `Authorization: Bearer <API_KEY>`
- Playbook CRUD: `POST/GET/PUT/DELETE /v1/playbooks`
- Knowledge CRUD: `POST/GET/PUT/DELETE /v1/knowledge`
- Playbook data model: `{ title, body, macro? }`
- Knowledge data model: `{ name, body, trigger_description, pinned_repo?, parent_folder_id? }`
- Rate limiting: 429 responses with exponential backoff
