import { describe, expect, test } from "bun:test"
import { computeSyncPlan, syncToDevin } from "../src/sync/devin"
import type {
  DevinApiPlaybook,
  DevinApiKnowledgeEntry,
  LocalPlaybookEntry,
  LocalKnowledgeEntry,
} from "../src/types/devin"

// --- Helper factories ---

function makeLocalPlaybook(overrides: Partial<LocalPlaybookEntry> = {}): LocalPlaybookEntry {
  return {
    kind: "playbook",
    name: "test-agent",
    title: "[CE] agent:test-agent",
    body: "# [CE] agent:test-agent\n\nTest body.",
    category: "agent",
    macro: null,
    ...overrides,
  }
}

function makeLocalKnowledge(overrides: Partial<LocalKnowledgeEntry> = {}): LocalKnowledgeEntry {
  return {
    kind: "knowledge",
    name: "test-knowledge",
    title: "[CE] knowledge:test-knowledge",
    body: "Test knowledge body.",
    triggerDescription: "When working with test-knowledge",
    ...overrides,
  }
}

function makeRemotePlaybook(overrides: Partial<DevinApiPlaybook> = {}): DevinApiPlaybook {
  return {
    playbook_id: "pb-1",
    title: "[CE] agent:test-agent",
    body: "# [CE] agent:test-agent\n\nTest body.",
    macro: null,
    access_type: "org",
    org_id: "test-org",
    ...overrides,
  }
}

function makeRemoteKnowledge(overrides: Partial<DevinApiKnowledgeEntry> = {}): DevinApiKnowledgeEntry {
  return {
    note_id: "kn-1",
    name: "[CE] knowledge:test-knowledge",
    body: "Test knowledge body.",
    trigger_description: "When working with test-knowledge",
    parent_folder_id: null,
    pinned_repo: null,
    ...overrides,
  }
}

const defaultOptions = { noDelete: false }
const defaultSyncOptions = {
  dryRun: false,
  dir: "/fake/dir",
  noDelete: false,
  autoConfirm: false,
  only: [],
}

// --- syncToDevin validation tests ---

describe("syncToDevin", () => {
  test("throws on non-cog_ key before any network call", async () => {
    await expect(
      syncToDevin("/fake/dir", { apiKey: "legacy-key", orgId: "org-1" }, defaultSyncOptions)
    ).rejects.toThrow("service user key")
  })

  test("throws with apk_ key prefix", async () => {
    await expect(
      syncToDevin("/fake/dir", { apiKey: "apk_user_abc123", orgId: "org-1" }, defaultSyncOptions)
    ).rejects.toThrow("cog_")
  })
})

// --- computeSyncPlan tests ---

describe("computeSyncPlan", () => {
  test("all entries are creates when remote is empty", () => {
    const localPlaybooks = [makeLocalPlaybook()]
    const localKnowledge = [makeLocalKnowledge()]

    const plan = computeSyncPlan(localPlaybooks, localKnowledge, [], [], defaultOptions)

    expect(plan.creates).toHaveLength(2)
    expect(plan.updates).toHaveLength(0)
    expect(plan.deletes).toHaveLength(0)
    expect(plan.unchanged).toHaveLength(0)
    expect(plan.creates[0].title).toBe("[CE] agent:test-agent")
    expect(plan.creates[1].title).toBe("[CE] knowledge:test-knowledge")
  })

  test("matching entries are unchanged", () => {
    const localPlaybooks = [makeLocalPlaybook()]
    const remotePlaybooks = [makeRemotePlaybook()]

    const plan = computeSyncPlan(localPlaybooks, [], remotePlaybooks, [], defaultOptions)

    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(0)
    expect(plan.unchanged).toHaveLength(1)
    expect(plan.unchanged[0].remoteId).toBe("pb-1")
  })

  test("changed body triggers update", () => {
    const localPlaybooks = [makeLocalPlaybook({ body: "Updated body content." })]
    const remotePlaybooks = [makeRemotePlaybook({ body: "Original body content." })]

    const plan = computeSyncPlan(localPlaybooks, [], remotePlaybooks, [], defaultOptions)

    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].remoteId).toBe("pb-1")
    expect(plan.unchanged).toHaveLength(0)
  })

  test("trailing whitespace does not cause false updates", () => {
    const localPlaybooks = [makeLocalPlaybook({ body: "Same body.  \n" })]
    const remotePlaybooks = [makeRemotePlaybook({ body: "Same body.\n\n" })]

    const plan = computeSyncPlan(localPlaybooks, [], remotePlaybooks, [], defaultOptions)

    expect(plan.unchanged).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)
  })

  test("CRLF vs LF does not cause false updates", () => {
    const localPlaybooks = [makeLocalPlaybook({ body: "Line 1.\r\nLine 2." })]
    const remotePlaybooks = [makeRemotePlaybook({ body: "Line 1.\nLine 2." })]

    const plan = computeSyncPlan(localPlaybooks, [], remotePlaybooks, [], defaultOptions)

    expect(plan.unchanged).toHaveLength(1)
    expect(plan.updates).toHaveLength(0)
  })

  test("orphaned remote entries become deletes", () => {
    const remotePlaybooks = [makeRemotePlaybook({ playbook_id: "orphan-1", title: "[CE] agent:removed" })]
    const remoteKnowledge = [makeRemoteKnowledge({ note_id: "orphan-2", name: "[CE] knowledge:removed" })]

    const plan = computeSyncPlan([], [], remotePlaybooks, remoteKnowledge, defaultOptions)

    expect(plan.deletes).toHaveLength(2)
    expect(plan.deletes[0].remoteId).toBe("orphan-1")
    expect(plan.deletes[1].remoteId).toBe("orphan-2")
  })

  test("noDelete skips orphan detection", () => {
    const remotePlaybooks = [makeRemotePlaybook({ playbook_id: "orphan-1", title: "[CE] agent:removed" })]

    const plan = computeSyncPlan([], [], remotePlaybooks, [], { noDelete: true })

    expect(plan.deletes).toHaveLength(0)
  })

  test("knowledge matching uses title field", () => {
    const localKnowledge = [makeLocalKnowledge({ body: "Same content." })]
    const remoteKnowledge = [makeRemoteKnowledge({ name: "[CE] knowledge:test-knowledge", body: "Same content." })]

    const plan = computeSyncPlan([], localKnowledge, [], remoteKnowledge, defaultOptions)

    expect(plan.unchanged).toHaveLength(1)
  })

  test("knowledge content change triggers update", () => {
    const localKnowledge = [makeLocalKnowledge({ body: "New content." })]
    const remoteKnowledge = [makeRemoteKnowledge({ name: "[CE] knowledge:test-knowledge", body: "Old content." })]

    const plan = computeSyncPlan([], localKnowledge, [], remoteKnowledge, defaultOptions)

    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].remoteId).toBe("kn-1")
  })

  test("mixed creates, updates, unchanged, and deletes", () => {
    const localPlaybooks = [
      makeLocalPlaybook({ name: "existing", title: "[CE] agent:existing", body: "Updated." }),
      makeLocalPlaybook({ name: "new-agent", title: "[CE] agent:new-agent", body: "New agent." }),
      makeLocalPlaybook({ name: "same", title: "[CE] command:same", body: "Same.", category: "command", macro: "same" }),
    ]
    const remotePlaybooks = [
      makeRemotePlaybook({ playbook_id: "p1", title: "[CE] agent:existing", body: "Original." }),
      makeRemotePlaybook({ playbook_id: "p2", title: "[CE] command:same", body: "Same.", macro: "same" }),
      makeRemotePlaybook({ playbook_id: "p3", title: "[CE] agent:orphan" }),
    ]

    const plan = computeSyncPlan(localPlaybooks, [], remotePlaybooks, [], defaultOptions)

    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0].title).toBe("[CE] agent:new-agent")
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].title).toBe("[CE] agent:existing")
    expect(plan.unchanged).toHaveLength(1)
    expect(plan.unchanged[0].title).toBe("[CE] command:same")
    expect(plan.deletes).toHaveLength(1)
    expect(plan.deletes[0].title).toBe("[CE] agent:orphan")
  })

  test("multiple local playbooks with different categories", () => {
    const localPlaybooks = [
      makeLocalPlaybook({ name: "my-agent", title: "[CE] agent:my-agent", category: "agent", macro: null }),
      makeLocalPlaybook({ name: "my-cmd", title: "[CE] command:my-cmd", category: "command", macro: "my_cmd" }),
      makeLocalPlaybook({ name: "my-flow", title: "[CE] workflow:my-flow", category: "workflow", macro: "workflow_my_flow" }),
    ]

    const plan = computeSyncPlan(localPlaybooks, [], [], [], defaultOptions)

    expect(plan.creates).toHaveLength(3)
    expect(plan.creates.map((e) => e.title)).toEqual([
      "[CE] agent:my-agent",
      "[CE] command:my-cmd",
      "[CE] workflow:my-flow",
    ])
  })

  test("empty local and remote produces empty plan", () => {
    const plan = computeSyncPlan([], [], [], [], defaultOptions)

    expect(plan.creates).toHaveLength(0)
    expect(plan.updates).toHaveLength(0)
    expect(plan.deletes).toHaveLength(0)
    expect(plan.unchanged).toHaveLength(0)
  })
})
