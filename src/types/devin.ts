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
  macro?: string // Slash command binding (commands/workflows only, used by sync)
}

export type DevinKnowledgeEntry = {
  name: string
  title: string
  body: string
  triggerDescription: string
  macro?: string // Knowledge macro (hyphens only, stored without ! prefix)
}

export type DevinBundle = {
  playbooks: DevinPlaybook[]
  knowledgeEntries: DevinKnowledgeEntry[]
  mcpSetupInstructions?: string // Markdown content for mcp-setup-instructions.md
}

// --- Devin API client ---

export type DevinClient = {
  apiKey: string
  orgId: string
}

// --- Devin API response types (from GET endpoints) ---

export type DevinApiPlaybook = {
  playbook_id: string
  title: string
  body: string
  macro: string | null
  access_type: "enterprise" | "org"
  org_id: string
}

export type DevinV3Page<T> = {
  items: T[]
  has_next_page: boolean
  end_cursor: string | null
}

export type DevinApiKnowledgeEntry = {
  note_id: string
  name: string
  body: string
  trigger: string
  macro: string | null
  folder_id: string | null
  folder_path: string
  pinned_repo: string | null
}

// --- Sync types ---

export type LocalPlaybookEntry = {
  kind: "playbook"
  name: string
  title: string // [CE] type:name
  body: string
  category: "agent" | "command" | "workflow"
  macro: string | null
}

export type LocalKnowledgeEntry = {
  kind: "knowledge"
  name: string
  title: string // [CE] knowledge:name
  body: string
  triggerDescription: string
  macro: string | null
}

export type LocalEntry = LocalPlaybookEntry | LocalKnowledgeEntry

export type SyncEntry = {
  title: string
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
}

export type SyncDevinOptions = {
  dryRun: boolean
  dir: string
  noDelete: boolean
  autoConfirm: boolean
  only: string[]
}
