import { describe, expect, test } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { writeDevinBundle } from "../src/targets/devin"
import type { DevinBundle } from "../src/types/devin"

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

describe("writeDevinBundle", () => {
  test("writes playbooks and knowledge files", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-test-"))
    const bundle: DevinBundle = {
      playbooks: [
        {
          name: "security-reviewer",
          content: "# Security Reviewer\n\n## Overview\n\nReview code.\n\n## Procedure\n\n1. Check things.",
          category: "agent",
        },
        {
          name: "deepen-plan",
          content: "# Deepen Plan\n\n## Overview\n\nEnhance plan.\n\n## Procedure\n\n1. Read plan.",
          category: "command",
        },
        {
          name: "brainstorm",
          content: "# Brainstorm\n\n## Overview\n\nExplore ideas.\n\n## Procedure\n\n1. Ask questions.",
          category: "workflow",
        },
      ],
      knowledgeEntries: [
        {
          name: "dhh-rails-style",
          title: "dhh-rails-style",
          body: "Write Rails code in DHH style.",
          triggerDescription: "When writing Ruby on Rails code",
        },
      ],
    }

    await writeDevinBundle(tempRoot, bundle)

    expect(await exists(path.join(tempRoot, ".devin", "playbooks", "agents", "security-reviewer.devin.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".devin", "playbooks", "commands", "deepen-plan.devin.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".devin", "playbooks", "workflows", "brainstorm.devin.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".devin", "knowledge", "dhh-rails-style.json"))).toBe(true)

    const agentContent = await fs.readFile(
      path.join(tempRoot, ".devin", "playbooks", "agents", "security-reviewer.devin.md"),
      "utf8",
    )
    expect(agentContent).toContain("Review code.")

    const knowledgeContent = JSON.parse(
      await fs.readFile(path.join(tempRoot, ".devin", "knowledge", "dhh-rails-style.json"), "utf8"),
    )
    expect(knowledgeContent.title).toBe("dhh-rails-style")
    expect(knowledgeContent.body).toContain("DHH style")
    expect(knowledgeContent.trigger_description).toBe("When writing Ruby on Rails code")
  })

  test("writes MCP setup instructions when present", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-mcp-"))
    const bundle: DevinBundle = {
      playbooks: [],
      knowledgeEntries: [],
      mcpSetupInstructions: "# MCP Server Setup\n\n## context7\n\n- **URL:** https://mcp.context7.com/mcp",
    }

    await writeDevinBundle(tempRoot, bundle)

    expect(await exists(path.join(tempRoot, ".devin", "mcp-setup-instructions.md"))).toBe(true)
    const content = await fs.readFile(path.join(tempRoot, ".devin", "mcp-setup-instructions.md"), "utf8")
    expect(content).toContain("context7")
    expect(content).toContain("https://mcp.context7.com/mcp")
  })

  test("does not write MCP setup instructions when absent", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-nomcp-"))
    const bundle: DevinBundle = {
      playbooks: [],
      knowledgeEntries: [],
    }

    await writeDevinBundle(tempRoot, bundle)

    expect(await exists(path.join(tempRoot, ".devin", "mcp-setup-instructions.md"))).toBe(false)
  })

  test("does not double-nest when output root is .devin", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-home-"))
    const devinRoot = path.join(tempRoot, ".devin")
    const bundle: DevinBundle = {
      playbooks: [
        { name: "reviewer", content: "Reviewer content", category: "agent" },
      ],
      knowledgeEntries: [
        { name: "skill-one", title: "skill-one", body: "Body.", triggerDescription: "When testing" },
      ],
    }

    await writeDevinBundle(devinRoot, bundle)

    expect(await exists(path.join(devinRoot, "playbooks", "agents", "reviewer.devin.md"))).toBe(true)
    expect(await exists(path.join(devinRoot, "knowledge", "skill-one.json"))).toBe(true)
    // Should NOT double-nest under .devin/.devin
    expect(await exists(path.join(devinRoot, ".devin"))).toBe(false)
  })

  test("handles empty bundles gracefully", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-empty-"))
    const bundle: DevinBundle = {
      playbooks: [],
      knowledgeEntries: [],
    }

    await writeDevinBundle(tempRoot, bundle)
    expect(await exists(tempRoot)).toBe(true)
  })

  test("agent playbooks written in playbooks/agents/", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-agents-"))
    const bundle: DevinBundle = {
      playbooks: [{ name: "test-agent", content: "Agent content", category: "agent" }],
      knowledgeEntries: [],
    }

    await writeDevinBundle(tempRoot, bundle)

    expect(await exists(path.join(tempRoot, ".devin", "playbooks", "agents", "test-agent.devin.md"))).toBe(true)
  })

  test("command playbooks written in playbooks/commands/", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-commands-"))
    const bundle: DevinBundle = {
      playbooks: [{ name: "test-cmd", content: "Command content", category: "command" }],
      knowledgeEntries: [],
    }

    await writeDevinBundle(tempRoot, bundle)

    expect(await exists(path.join(tempRoot, ".devin", "playbooks", "commands", "test-cmd.devin.md"))).toBe(true)
  })

  test("workflow playbooks written in playbooks/workflows/", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-workflows-"))
    const bundle: DevinBundle = {
      playbooks: [{ name: "brainstorm", content: "Workflow content", category: "workflow" }],
      knowledgeEntries: [],
    }

    await writeDevinBundle(tempRoot, bundle)

    expect(await exists(path.join(tempRoot, ".devin", "playbooks", "workflows", "brainstorm.devin.md"))).toBe(true)
  })

  test("knowledge entries written as JSON with correct schema", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devin-knowledge-"))
    const bundle: DevinBundle = {
      playbooks: [],
      knowledgeEntries: [
        {
          name: "test-skill",
          title: "Test Skill",
          body: "The skill body content.",
          triggerDescription: "When testing skills",
        },
      ],
    }

    await writeDevinBundle(tempRoot, bundle)

    const content = JSON.parse(
      await fs.readFile(path.join(tempRoot, ".devin", "knowledge", "test-skill.json"), "utf8"),
    )
    expect(content.title).toBe("Test Skill")
    expect(content.body).toBe("The skill body content.")
    expect(content.trigger_description).toBe("When testing skills")
    // Should use snake_case for API compatibility
    expect(content).not.toHaveProperty("triggerDescription")
  })
})
