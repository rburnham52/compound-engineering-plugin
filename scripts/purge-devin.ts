export {}

const DEVIN_API_BASE = "https://api.devin.ai"
const API_KEY = process.env.DEVIN_API_KEY!
const ORG_ID = process.env.DEVIN_ORG_ID!
const CE_PREFIX = "[CE]"

if (!API_KEY || !ORG_ID) {
  console.error("DEVIN_API_KEY and DEVIN_ORG_ID must be set")
  process.exit(1)
}

async function devinFetch(path: string, method = "GET", body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` }
  if (body) headers["Content-Type"] = "application/json"
  const res = await fetch(`${DEVIN_API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`${method} ${path}: ${res.status} ${text}`)
  }
  return res
}

async function fetchAllPages<T>(basePath: string): Promise<T[]> {
  const results: T[] = []
  let cursor: string | undefined
  do {
    const url = cursor ? `${basePath}?cursor=${encodeURIComponent(cursor)}` : basePath
    const page: any = await (await devinFetch(url)).json()
    results.push(...page.items)
    cursor = page.has_more ? page.cursor : undefined
  } while (cursor)
  return results
}

// Fetch and delete all CE playbooks
const playbooks: any[] = await fetchAllPages(`/v3beta1/organizations/${ORG_ID}/playbooks`)
const cePlaybooks = playbooks.filter((p) => p.title?.startsWith(CE_PREFIX))
console.log(`Found ${cePlaybooks.length} CE playbooks`)
for (const p of cePlaybooks) {
  console.log(`  DELETE playbook: ${p.title}`)
  await devinFetch(`/v3beta1/organizations/${ORG_ID}/playbooks/${p.playbook_id}`, "DELETE")
}

// Fetch and delete all CE knowledge entries
const notes: any[] = await fetchAllPages(`/v3/organizations/${ORG_ID}/knowledge/notes`)
const ceNotes = notes.filter((n) => n.name?.startsWith(CE_PREFIX))
console.log(`Found ${ceNotes.length} CE knowledge entries`)
for (const n of ceNotes) {
  console.log(`  DELETE knowledge: ${n.name}`)
  await devinFetch(`/v3/organizations/${ORG_ID}/knowledge/notes/${n.note_id}`, "DELETE")
}

console.log("Done. All CE entries removed.")
