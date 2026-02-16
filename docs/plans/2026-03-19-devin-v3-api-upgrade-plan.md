# Devin V3 API Upgrade — Implementation Plan

Brainstorm: `docs/brainstorms/2026-03-19-devin-v3-api-upgrade-brainstorm.md`

## Context

Replace all V1 API calls in `src/sync/devin.ts` with V3 org-scoped endpoints. Add `orgId` as a
required parameter. Auth changes from legacy personal key to service user `cog_` key.

**Minimum plan: Enterprise** (knowledge endpoints require `ManageAccountKnowledge`).

---

## Step 1 — Update types (`src/types/devin.ts`)

### 1a. Add `DevinClient` type

Encapsulate credentials into a client struct to avoid threading `apiKey` + `orgId` through every
function signature. This reduces parameter noise and makes future auth changes a single-site edit.

```ts
export type DevinClient = {
  apiKey: string
  orgId: string
}
```

### 1b. Update `SyncDevinOptions` — remove `orgId` (now on client)

`orgId` belongs to the client, not the options bag. Keep options as runtime behaviour flags only:

```ts
export type SyncDevinOptions = {
  dryRun: boolean
  dir: string
  noDelete: boolean
  autoConfirm: boolean
  only: string[]
}
```

### 1c. Update `DevinApiPlaybook` for V3 response shape

```ts
export type DevinApiPlaybook = {
  playbook_id: string
  title: string
  body: string
  macro: string | null
  access_type: "enterprise" | "org"
  org_id: string
}
```

`DevinApiKnowledgeEntry` — keep as-is; confirm field names against live API during implementation
and update if V3 response differs from V1 (`note_id`, `body`, `trigger_description`).

### 1d. Add V3 paginated list response type

```ts
export type DevinV3Page<T> = {
  items: T[]
  has_more: boolean
  cursor?: string
}
```

---

## Step 2 — Rewrite `src/sync/devin.ts`

### 2a. `cog_` key validation — first, before any network call

Validate key format immediately in `syncToDevin`, before any API traffic:

```ts
if (!client.apiKey.startsWith("cog_")) {
  throw new Error(
    "Devin V3 requires a service user key (starts with cog_). " +
    "Generate one at Organization Settings > Service Users in the Devin web app."
  )
}
```

> **Security note:** This fires before the validation fetch, preventing a network call with a
> known-invalid key. No key material is logged — only the prefix is inspected.

### 2b. Path builder helpers

```ts
const DEVIN_API_BASE = "https://api.devin.ai"

function playbooksPath(orgId: string, id?: string): string {
  return id
    ? `/v3beta1/organizations/${orgId}/playbooks/${id}`
    : `/v3beta1/organizations/${orgId}/playbooks`
}

function knowledgePath(orgId: string, id?: string): string {
  return id
    ? `/v3/organizations/${orgId}/knowledge/notes/${id}`
    : `/v3/organizations/${orgId}/knowledge/notes`
}
```

### 2c. Consolidate duplicate retry logic

Currently `devinFetchJson` and `devinMutate` each contain identical retry/backoff loops — a
maintenance hazard. Consolidate into a single `devinRequest<T>` helper:

```ts
async function devinRequest<T>(
  client: DevinClient,
  apiPath: string,
  options?: { method?: string; body?: unknown; json?: boolean },
  maxRetries = 3,
): Promise<T | void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await devinFetch(apiPath, client.apiKey, options)
      return options?.json !== false ? ((await res.json()) as T) : undefined
    } catch (err) {
      if (err instanceof DevinApiError && err.status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500
        console.log(`  Rate limited, retrying in ${Math.round(delay / 1000)}s...`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
}
```

Replace `devinFetchJson` and `devinMutate` call sites with `devinRequest`.

### 2d. Cursor-based pagination for list endpoints

V3 list responses use cursor pagination (`has_more` + `cursor`). Fetch all pages before diffing:

```ts
async function fetchAllPages<T>(
  client: DevinClient,
  basePath: string,
): Promise<T[]> {
  const results: T[] = []
  let cursor: string | undefined

  do {
    const url = cursor ? `${basePath}?cursor=${encodeURIComponent(cursor)}` : basePath
    const page = await devinRequest<DevinV3Page<T>>(client, url, { json: true })
    if (!page) break
    results.push(...page.items)
    cursor = page.has_more ? page.cursor : undefined
  } while (cursor)

  return results
}
```

Use in `fetchRemotePlaybooks` and `fetchRemoteKnowledge`:

```ts
async function fetchRemotePlaybooks(client: DevinClient): Promise<DevinApiPlaybook[]> {
  return fetchAllPages<DevinApiPlaybook>(client, playbooksPath(client.orgId))
}

async function fetchRemoteKnowledge(client: DevinClient): Promise<DevinApiKnowledgeEntry[]> {
  return fetchAllPages<DevinApiKnowledgeEntry>(client, knowledgePath(client.orgId))
}
```

### 2e. Update `executeSyncPlan` — swap `apiKey` for `client`

Replace `apiKey: string` param with `client: DevinClient`. Update all CRUD call sites to use
path helpers:

```ts
// Create playbook
await devinRequest(client, playbooksPath(client.orgId), {
  method: "POST", body: { title, body, macro }, json: false,
})

// Update playbook
await devinRequest(client, playbooksPath(client.orgId, remoteId), {
  method: "PUT", body: { title, body, macro }, json: false,
})

// Delete playbook
await devinRequest(client, playbooksPath(client.orgId, remoteId), {
  method: "DELETE", json: false,
})

// Knowledge follows same pattern with knowledgePath(...)
```

### 2f. Update `syncToDevin` signature

```ts
export async function syncToDevin(
  devinDir: string,
  client: DevinClient,
  options: SyncDevinOptions,
): Promise<void>
```

The API key validation fetch (currently `/v1/playbooks`) becomes a lightweight V3 call —
use `GET playbooksPath(client.orgId)` with a page size of 1 to validate credentials cheaply.

---

## Step 3 — Update `src/commands/sync.ts`

> **Note:** The rebase already wired Devin as an early-exit branch in `sync.ts`. The existing
> call site still uses the old V1 signature: `syncToDevin(resolvedDir, apiKey, {...})`. This
> step updates it to use `DevinClient` and adds `--org-id`.

### 3a. Add `orgId` arg

```ts
orgId: {
  type: "string",
  alias: "org-id",
  description: "Devin organization ID (or DEVIN_ORG_ID env var)",
},
```

### 3b. Resolve credentials and construct client

Replace the existing Devin branch in `run()` with:

```ts
const apiKey = args.apiKey || process.env.DEVIN_API_KEY
if (!apiKey) {
  throw new Error("Devin API key required. Use --api-key or set DEVIN_API_KEY env var.")
}
if (args.apiKey) {
  console.warn("Warning: Passing API keys via CLI args exposes them in shell history. Prefer DEVIN_API_KEY env var.")
}

const orgId = args.orgId || process.env.DEVIN_ORG_ID
if (!orgId) {
  throw new Error("Devin org ID required. Use --org-id or set DEVIN_ORG_ID env var.")
}

const client: DevinClient = { apiKey, orgId }
await syncToDevin(resolvedDir, client, {
  dryRun: args.dryRun,
  dir: resolvedDir,
  noDelete: args.noDelete,
  autoConfirm: args.yes,
  only: args.only ? args.only.split(",").map((s: string) => s.trim()) : [],
})
```

> `orgId` is not a secret but still prefer env var (`DEVIN_ORG_ID`) for CI consistency.

---

## Step 4 — Update tests (`tests/sync-devin.test.ts`)

`computeSyncPlan` is pure — its tests don't require URL changes. Required updates:

- **`makeRemotePlaybook` factory:** add `access_type: "org"` and `org_id: "test-org"` defaults
  to satisfy updated `DevinApiPlaybook` type.
- **`cog_` validation test:** export a small testable helper or test via the thrown error in
  `syncToDevin`. Example:

```ts
test("throws on non-cog_ key", async () => {
  await expect(
    syncToDevin("/fake/dir", { apiKey: "legacy-key", orgId: "org-1" }, defaultOpts)
  ).rejects.toThrow("service user key")
})
```

Note: `syncToDevin` will throw before any filesystem/network access due to the early key check.

---

## Step 5 — Docs (no manual version bump)

Per `docs/solutions/plugin-versioning-requirements.md` (updated upstream): **do not manually
bump versions or cut release sections**. Release automation (release-please) owns versioning.
Contributors must not touch `plugin.json`, `marketplace.json`, or `CHANGELOG.md` release sections.

Instead, update only substantive docs:

- **`README.md`** — update Devin Sync section:
  - Replace legacy key (`apk_user_xxx`) setup with service user steps (`cog_` prefix)
  - Add `DEVIN_ORG_ID` env var to the example
  - Note Enterprise plan requirement
  - Update example command: `DEVIN_API_KEY=cog_xxx DEVIN_ORG_ID=org_xxx bunx ... sync --target devin`
- **`docs/guides/devin.md`** — update the Quick Start and Prerequisites:
  - Prerequisites: change "Devin API key (Settings > API Keys)" to service user key
  - Quick Start: update env var example from `apk_user_xxx` to `cog_xxx`, add `DEVIN_ORG_ID`
  - Add note about Enterprise plan requirement
- **`bun run release:validate`** — run after changes to verify no inventory counts broke

---

## Implementation Order

1. `src/types/devin.ts` — `DevinClient`, updated `SyncDevinOptions`, `DevinApiPlaybook`, `DevinV3Page`
2. `src/sync/devin.ts` — path helpers, `devinRequest`, `fetchAllPages`, updated signatures, `cog_` check
3. `src/commands/sync.ts` — `--org-id` arg, construct `DevinClient`, pass to `syncToDevin`
4. `tests/sync-devin.test.ts` — update factories, add `cog_` validation test
5. `README.md` + `docs/guides/devin.md` — update for V3 auth, `DEVIN_ORG_ID`, Enterprise requirement

Run `bun test` after step 4.
