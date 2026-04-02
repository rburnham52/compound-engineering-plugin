import path from "path"
import { walkFiles, readText, readJson, pathExists } from "../utils/files"
import { CE_PREFIX, toMacroName } from "../utils/devin-conventions"
import type {
  DevinApiPlaybook,
  DevinApiKnowledgeEntry,
  DevinClient,
  DevinV3Page,
  LocalPlaybookEntry,
  LocalKnowledgeEntry,
  LocalEntry,
  SyncEntry,
  SyncPlan,
  SyncResult,
  SyncDevinOptions,
} from "../types/devin"

// --- API Client ---

const DEVIN_API_BASE = "https://api.devin.ai"
const REQUEST_TIMEOUT_MS = 30_000

class DevinApiError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    public responseBody?: string,
  ) {
    super(
      responseBody
        ? `Devin API ${method} ${path}: ${status}\n${responseBody}`
        : `Devin API ${method} ${path}: ${status}`
    )
  }
}

async function devinFetch(
  apiPath: string,
  apiKey: string,
  options?: { method?: string; body?: unknown },
): Promise<Response> {
  const { method = "GET", body } = options ?? {}
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  }
  if (body) headers["Content-Type"] = "application/json"

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(`${DEVIN_API_BASE}${apiPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new DevinApiError(method, apiPath, res.status, body)
    }

    return res
  } finally {
    clearTimeout(timeout)
  }
}

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

async function fetchAllPages<T>(
  client: DevinClient,
  basePath: string,
): Promise<T[]> {
  const results: T[] = []
  let cursor: string | undefined

  do {
    const url = cursor ? `${basePath}?cursor=${encodeURIComponent(cursor)}` : basePath
    const page = await devinRequest<DevinV3Page<T>>(client, url)
    if (!page) break
    results.push(...page.items)
    cursor = page.has_next_page && page.end_cursor ? page.end_cursor : undefined
  } while (cursor)

  return results
}

function knowledgeFoldersPath(orgId: string): string {
  return `/v3/organizations/${orgId}/knowledge/folders`
}

type DevinKnowledgeFolder = { folder_id: string; name: string }
type DevinKnowledgeFoldersResponse = { folders: DevinKnowledgeFolder[] }

async function findCEFolderId(client: DevinClient): Promise<string | null> {
  const res = await devinRequest<DevinKnowledgeFoldersResponse>(client, knowledgeFoldersPath(client.orgId))
  if (!res) return null
  const folder = res.folders.find((f) => f.name === "Compound Engineering")
  return folder?.folder_id ?? null
}

// --- Local State Reader ---

async function readLocalState(
  devinDir: string,
  options: SyncDevinOptions,
): Promise<{ playbooks: LocalPlaybookEntry[]; knowledge: LocalKnowledgeEntry[] }> {
  if (!(await pathExists(devinDir))) {
    throw new Error(`No .devin/ directory found at ${devinDir}. Run 'convert --to devin' first.`)
  }

  const playbooks: LocalPlaybookEntry[] = []
  const knowledge: LocalKnowledgeEntry[] = []

  // Read playbooks from each category subdirectory
  const categories = [
    { dir: "agents", category: "agent" as const },
    { dir: "commands", category: "command" as const },
    { dir: "workflows", category: "workflow" as const },
  ]

  for (const { dir, category } of categories) {
    const playbookDir = path.join(devinDir, "playbooks", dir)
    if (!(await pathExists(playbookDir))) continue

    const files = await walkFiles(playbookDir)
    for (const filePath of files) {
      if (!filePath.endsWith(".devin.md")) continue

      const name = path.basename(filePath, ".devin.md")

      // Apply --only filter
      if (options.only.length > 0 && !options.only.includes(name)) continue

      const body = await readText(filePath)
      const title = `${CE_PREFIX} ${category}:${name}`
      const macro = category === "agent" ? null : `!ce-${toMacroName(name)}`

      playbooks.push({ kind: "playbook", name, title, body: body.trim(), category, macro })
    }
  }

  // Read knowledge entries
  const knowledgeDir = path.join(devinDir, "knowledge")
  if (await pathExists(knowledgeDir)) {
    const files = await walkFiles(knowledgeDir)
    for (const filePath of files) {
      if (!filePath.endsWith(".json")) continue

      const name = path.basename(filePath, ".json")
      if (options.only.length > 0 && !options.only.includes(name)) continue

      let json: { title: string; body: string; trigger_description: string; macro?: string }
      try {
        json = await readJson<{ title: string; body: string; trigger_description: string; macro?: string }>(filePath)
      } catch {
        throw new Error(`Failed to parse knowledge file ${filePath}`)
      }

      if (!json.body || !json.trigger_description) {
        throw new Error(`Invalid knowledge file ${filePath}: missing body or trigger_description`)
      }

      const title = `${CE_PREFIX} knowledge:${name}`
      knowledge.push({
        kind: "knowledge",
        name,
        title,
        body: json.body,
        triggerDescription: json.trigger_description,
        macro: json.macro ?? null,
      })
    }
  }

  return { playbooks, knowledge }
}

// --- Remote State Fetcher ---

async function fetchRemotePlaybooks(client: DevinClient): Promise<DevinApiPlaybook[]> {
  return fetchAllPages<DevinApiPlaybook>(client, playbooksPath(client.orgId))
}

async function fetchRemoteKnowledge(client: DevinClient): Promise<DevinApiKnowledgeEntry[]> {
  return fetchAllPages<DevinApiKnowledgeEntry>(client, knowledgePath(client.orgId))
}

async function resolveCEFolderId(client: DevinClient): Promise<string | null> {
  try {
    return await findCEFolderId(client)
  } catch {
    return null
  }
}

// --- Diff Algorithm ---

export function computeSyncPlan(
  localPlaybooks: LocalPlaybookEntry[],
  localKnowledge: LocalKnowledgeEntry[],
  remotePlaybooks: DevinApiPlaybook[],
  remoteKnowledge: DevinApiKnowledgeEntry[],
  options: Pick<SyncDevinOptions, "noDelete">,
  ceFolderId: string | null = null,
): SyncPlan {
  const plan: SyncPlan = { creates: [], updates: [], deletes: [], unchanged: [] }

  // Index remote entries by title for O(1) lookup
  const remotePlaybooksByTitle = Object.create(null) as Record<string, DevinApiPlaybook>
  for (const rp of remotePlaybooks) {
    remotePlaybooksByTitle[rp.title] = rp
  }

  const remoteKnowledgeByTitle = Object.create(null) as Record<string, DevinApiKnowledgeEntry>
  for (const rk of remoteKnowledge) {
    remoteKnowledgeByTitle[rk.name] = rk
  }

  // Track which remote entries have a local match
  const matchedRemotePlaybookTitles = new Set<string>()
  const matchedRemoteKnowledgeTitles = new Set<string>()

  // Diff playbooks
  for (const local of localPlaybooks) {
    const remote = remotePlaybooksByTitle[local.title]
    if (!remote) {
      plan.creates.push({ title: local.title, category: "playbook" })
    } else {
      matchedRemotePlaybookTitles.add(local.title)
      const bodyMatch = normalizeForComparison(local.body) === normalizeForComparison(remote.body)
      const macroMatch = (local.macro ?? null) === (remote.macro ?? null)
      if (bodyMatch && macroMatch) {
        plan.unchanged.push({ title: local.title, remoteId: remote.playbook_id, category: "playbook" })
      } else {
        plan.updates.push({ title: local.title, remoteId: remote.playbook_id, category: "playbook" })
      }
    }
  }

  // Diff knowledge
  for (const local of localKnowledge) {
    const remote = remoteKnowledgeByTitle[local.title]
    if (!remote) {
      plan.creates.push({ title: local.title, category: "knowledge" })
    } else {
      matchedRemoteKnowledgeTitles.add(local.title)
      const bodyMatch = normalizeForComparison(local.body) === normalizeForComparison(remote.body)
      const macroMatch = (local.macro ?? null) === (remote.macro ?? null)
      const folderMatch = ceFolderId === null || remote.folder_id === ceFolderId
      if (bodyMatch && macroMatch && folderMatch) {
        plan.unchanged.push({ title: local.title, remoteId: remote.note_id, category: "knowledge" })
      } else {
        plan.updates.push({ title: local.title, remoteId: remote.note_id, category: "knowledge" })
      }
    }
  }

  // Find orphans (remote [CE] entries with no local match)
  if (!options.noDelete) {
    for (const rp of remotePlaybooks) {
      if (!matchedRemotePlaybookTitles.has(rp.title)) {
        plan.deletes.push({ title: rp.title, remoteId: rp.playbook_id, category: "playbook" })
      }
    }
    for (const rk of remoteKnowledge) {
      if (!matchedRemoteKnowledgeTitles.has(rk.name)) {
        plan.deletes.push({ title: rk.name, remoteId: rk.note_id, category: "knowledge" })
      }
    }
  }

  return plan
}

function normalizeForComparison(s: string): string {
  return s.replace(/\r\n/g, "\n").trim()
}

// --- Plan Executor ---

async function executeSyncPlan(
  plan: SyncPlan,
  localEntries: Map<string, LocalEntry>,
  client: DevinClient,
  options: SyncDevinOptions,
  ceFolderId: string | null,
): Promise<SyncResult> {
  const result: SyncResult = { created: 0, updated: 0, deleted: 0, unchanged: plan.unchanged.length }

  // Creates
  for (const entry of plan.creates) {
    const local = localEntries.get(entry.title)
    if (!local) continue

    console.log(`  \x1b[32m+ CREATE\x1b[0m  ${entry.title}`)

    if (local.kind === "playbook") {
      await devinRequest(client, playbooksPath(client.orgId), {
        method: "POST",
        body: { title: local.title, body: local.body, macro: local.macro },
        json: false,
      })
    } else {
      await devinRequest(client, knowledgePath(client.orgId), {
        method: "POST",
        body: {
          name: local.title,
          body: local.body,
          trigger: local.triggerDescription,
          macro: local.macro ?? undefined,
          ...(ceFolderId ? { folder_id: ceFolderId } : {}),
        },
        json: false,
      })
    }
    result.created++
  }

  // Updates
  for (const entry of plan.updates) {
    const local = localEntries.get(entry.title)
    if (!local || !entry.remoteId) continue

    console.log(`  \x1b[33m~ UPDATE\x1b[0m  ${entry.title}`)

    if (local.kind === "playbook") {
      await devinRequest(client, playbooksPath(client.orgId, entry.remoteId), {
        method: "PUT",
        body: { title: local.title, body: local.body, macro: local.macro },
        json: false,
      })
    } else {
      await devinRequest(client, knowledgePath(client.orgId, entry.remoteId), {
        method: "PUT",
        body: {
          name: local.title,
          body: local.body,
          trigger: local.triggerDescription,
          macro: local.macro ?? undefined,
          ...(ceFolderId ? { folder_id: ceFolderId } : {}),
        },
        json: false,
      })
    }
    result.updated++
  }

  // Deletes (gated by --yes)
  if (plan.deletes.length > 0 && !options.autoConfirm) {
    console.log(`\n  ${plan.deletes.length} orphaned entries would be deleted.`)
    console.log("  Re-run with --yes to confirm deletions, or use --no-delete to skip.")
  } else {
    for (const entry of plan.deletes) {
      if (!entry.remoteId) continue
      console.log(`  \x1b[31m- DELETE\x1b[0m  ${entry.title}`)
      const endpoint =
        entry.category === "playbook"
          ? playbooksPath(client.orgId, entry.remoteId)
          : knowledgePath(client.orgId, entry.remoteId)
      await devinRequest(client, endpoint, { method: "DELETE", json: false })
      result.deleted++
    }
  }

  return result
}

// --- Main Orchestrator ---

export async function syncToDevin(
  devinDir: string,
  client: DevinClient,
  options: SyncDevinOptions,
): Promise<void> {
  // Validate key format before any network call
  if (!client.apiKey.startsWith("cog_")) {
    throw new Error(
      "Devin V3 requires a service user key (starts with cog_). " +
      "Generate one at Organization Settings > Service Users in the Devin web app."
    )
  }

  console.log(options.dryRun ? "Syncing to Devin API (DRY RUN)..." : "Syncing to Devin API...")

  // Validate credentials with a lightweight call
  console.log("\nValidating credentials...")
  try {
    await devinRequest<DevinV3Page<DevinApiPlaybook>>(
      client,
      `${playbooksPath(client.orgId)}?limit=1`,
    )
  } catch (err) {
    if (err instanceof DevinApiError && err.status === 401) {
      throw new Error("Invalid Devin API key. Check your service user key at Organization Settings > Service Users.")
    }
    if (err instanceof DevinApiError && err.status === 403) {
      throw new Error("Devin API access denied. Ensure the service user has ManageOrgPlaybooks and ManageAccountKnowledge permissions.")
    }
    throw err
  }

  // Read local state
  console.log("\nReading local .devin/ directory...")
  const local = await readLocalState(devinDir, options)
  console.log(`  Found ${local.playbooks.length} playbooks, ${local.knowledge.length} knowledge entries`)

  // Build local entry lookup map (discriminated union — no casts needed)
  const localEntries = new Map<string, LocalEntry>()
  for (const p of local.playbooks) localEntries.set(p.title, p)
  for (const k of local.knowledge) localEntries.set(k.title, k)

  // Fetch remote state (filtered to [CE] entries)
  console.log("\nFetching remote state from Devin...")
  const remotePlaybooks = (await fetchRemotePlaybooks(client)).filter((p) =>
    p.title.startsWith(CE_PREFIX),
  )
  const remoteKnowledge = (await fetchRemoteKnowledge(client)).filter((k) =>
    k.name.startsWith(CE_PREFIX),
  )
  console.log(
    `  Found ${remotePlaybooks.length} [CE] playbooks, ${remoteKnowledge.length} [CE] knowledge entries`,
  )

  // Resolve 'Compound Engineering' knowledge folder (optional — groups all CE knowledge in one folder)
  const ceFolderId = await resolveCEFolderId(client)
  if (ceFolderId) {
    console.log(`\n  Using 'Compound Engineering' knowledge folder: ${ceFolderId}`)
  } else if (local.knowledge.length > 0) {
    console.log("\n  Tip: Create a 'Compound Engineering' folder in the Devin knowledge UI to group CE entries automatically.")
  }

  // Compute diff
  const plan = computeSyncPlan(local.playbooks, local.knowledge, remotePlaybooks, remoteKnowledge, options, ceFolderId)

  // Display plan
  console.log("\nChanges:")
  if (plan.creates.length) {
    console.log(`  CREATE  ${plan.creates.length}`)
    for (const e of plan.creates) console.log(`    + ${e.title}`)
  }
  if (plan.updates.length) {
    console.log(`  UPDATE  ${plan.updates.length}`)
    for (const e of plan.updates) console.log(`    ~ ${e.title}`)
  }
  if (plan.deletes.length) {
    console.log(`  DELETE  ${plan.deletes.length}`)
    for (const e of plan.deletes) console.log(`    - ${e.title}`)
  }
  if (plan.unchanged.length) {
    console.log(`  SKIP    ${plan.unchanged.length} (unchanged)`)
  }

  const totalChanges = plan.creates.length + plan.updates.length + plan.deletes.length
  if (totalChanges === 0) {
    console.log("\nEverything is up to date.")
    return
  }

  // Execute (unless dry-run)
  if (options.dryRun) {
    console.log("\nRun without --dry-run to apply changes.")
    return
  }

  console.log("\nExecuting...")
  const result = await executeSyncPlan(plan, localEntries, client, options, ceFolderId)

  // Print summary
  console.log("\nSync complete:")
  console.log(`  Created:   ${result.created}`)
  console.log(`  Updated:   ${result.updated}`)
  console.log(`  Deleted:   ${result.deleted}`)
  console.log(`  Unchanged: ${result.unchanged}`)
}
