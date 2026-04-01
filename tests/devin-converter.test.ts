import { describe, expect, test } from "bun:test"
import { convertClaudeToDevin, formatPlaybook, transformContentForDevin } from "../src/converters/claude-to-devin"
import type { ClaudePlugin } from "../src/types/claude"

const fixturePlugin: ClaudePlugin = {
  root: "/tmp/plugin",
  manifest: { name: "fixture", version: "1.0.0" },
  agents: [
    {
      name: "Security Reviewer",
      description: "Security-focused code review agent",
      capabilities: ["Threat modeling", "OWASP compliance"],
      model: "claude-sonnet-4-20250514",
      body: "Focus on vulnerabilities.\n\n1. Check for SQL injection\n2. Check for XSS",
      sourcePath: "/tmp/plugin/agents/security-reviewer.md",
    },
  ],
  commands: [
    {
      name: "workflows:plan",
      description: "Planning command",
      argumentHint: "[FOCUS]",
      model: "inherit",
      allowedTools: ["Read"],
      body: "Plan the work.\n\n1. Read the feature\n2. Write the plan",
      sourcePath: "/tmp/plugin/commands/workflows/plan.md",
    },
  ],
  skills: [
    {
      name: "dhh-rails-style",
      description: "Writing Ruby on Rails code in DHH's distinctive style",
      sourceDir: "/tmp/plugin/skills/dhh-rails-style",
      skillPath: "/tmp/plugin/skills/dhh-rails-style/SKILL.md",
    },
  ],
  hooks: undefined,
  mcpServers: {
    context7: { type: "http", url: "https://mcp.context7.com/mcp" },
  },
}

const defaultOptions = {
  agentMode: "subagent" as const,
  inferTemperature: false,
  permissions: "none" as const,
}

describe("convertClaudeToDevin", () => {
  // --- Agent conversion tests ---

  test("converts agents to playbooks with Overview from description", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "security-reviewer")
    expect(playbook).toBeDefined()
    expect(playbook!.content).toContain("## Overview")
    expect(playbook!.content).toContain("Security-focused code review agent")
  })

  test("agent body becomes Procedure section", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "security-reviewer")
    expect(playbook!.content).toContain("## Procedure")
    expect(playbook!.content).toContain("Focus on vulnerabilities.")
    expect(playbook!.content).toContain("1. Check for SQL injection")
  })

  test("agent capabilities become Specifications section", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "security-reviewer")
    expect(playbook!.content).toContain("## Specifications")
    expect(playbook!.content).toContain("- Threat modeling")
    expect(playbook!.content).toContain("- OWASP compliance")
  })

  test("agent with no capabilities omits Specifications section", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [{ name: "simple-agent", description: "Simple", body: "Do things.", sourcePath: "/tmp/a.md" }],
      commands: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks[0].content).not.toContain("## Specifications")
  })

  test("agent <examples> XML blocks stripped from body", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [
        {
          name: "example-agent",
          description: "Agent with examples",
          body: "Do things.\n\n<examples>\nExample 1\n</examples>\n\nMore content.",
          sourcePath: "/tmp/a.md",
        },
      ],
      commands: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks[0].content).not.toContain("<examples>")
    expect(bundle.playbooks[0].content).not.toContain("</examples>")
    expect(bundle.playbooks[0].content).toContain("More content.")
  })

  test("agent model field silently dropped", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "security-reviewer")
    // model value should not appear (note: "model" may appear in body like "Threat modeling")
    expect(playbook!.content).not.toContain("claude-sonnet-4-20250514")
  })

  test("agent with empty body gets default body", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [{ name: "Empty Agent", description: "Empty", body: "", sourcePath: "/tmp/a.md" }],
      commands: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks[0].content).toContain("Instructions converted from the Empty Agent agent.")
  })

  test("agent with empty description gets default description", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [{ name: "my-agent", body: "Do things.", sourcePath: "/tmp/a.md" }],
      commands: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks[0].content).toContain("Converted from the my-agent agent.")
  })

  test("agent playbook has category 'agent'", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "security-reviewer")
    expect(playbook!.category).toBe("agent")
  })

  // --- Title format tests ---

  test("agent title uses [CE] agent:name format", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "security-reviewer")
    expect(playbook!.content).toContain("# [CE] agent:security-reviewer")
  })

  test("command title uses [CE] command:name format", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      commands: [{ name: "changelog", description: "Generate changelog", body: "Do it.", sourcePath: "/tmp/c.md" }],
      agents: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks[0].content).toContain("# [CE] command:changelog")
  })

  test("workflow title uses [CE] workflow:name format", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "plan")
    expect(playbook!.content).toContain("# [CE] workflow:plan")
  })

  test("knowledge entry title uses [CE] knowledge:name format", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    expect(bundle.knowledgeEntries[0].title).toBe("[CE] knowledge:dhh-rails-style")
  })

  // --- Macro generation tests ---

  test("command playbooks have macro field with underscores", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      commands: [{ name: "deepen-plan", description: "Deepen a plan", body: "Do it.", sourcePath: "/tmp/c.md" }],
      agents: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks[0].macro).toBe("deepen_plan")
    expect(bundle.playbooks[0].macro).not.toContain("-")
  })

  test("agent playbooks have no macro", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "security-reviewer")
    expect(playbook!.macro).toBeUndefined()
  })

  test("workflow macro has workflow_ prefix", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "plan")
    expect(playbook!.macro).toBe("workflow_plan")
  })

  // --- Workflow prefix stripping ---

  test("workflow command name has workflows- prefix stripped", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "plan")
    expect(playbook).toBeDefined()
    expect(playbook!.name).not.toContain("workflows-")
  })

  // --- Command conversion tests ---

  test("command converts to playbook with Procedure section", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "plan")
    expect(playbook).toBeDefined()
    expect(playbook!.content).toContain("## Procedure")
    expect(playbook!.content).toContain("Plan the work.")
  })

  test("command with argumentHint gets What's Needed From User section", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "plan")
    expect(playbook!.content).toContain("## What's Needed From User")
    expect(playbook!.content).toContain("[FOCUS]")
  })

  test("command allowedTools silently dropped", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "plan")
    // allowedTools field should not appear (note: "Read" may appear in body content)
    expect(playbook!.content).not.toContain("allowedTools")
  })

  test("command disableModelInvocation silently dropped", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      commands: [
        { name: "lfg", description: "Launch full pipeline", disableModelInvocation: true, body: "Run all.", sourcePath: "/tmp/c.md" },
      ],
      agents: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks).toHaveLength(1)
    expect(bundle.playbooks[0].content).not.toContain("disableModelInvocation")
  })

  test("workflow command gets category 'workflow'", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const playbook = bundle.playbooks.find((p) => p.name === "plan")
    expect(playbook!.category).toBe("workflow")
  })

  test("non-workflow command gets category 'command'", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      commands: [{ name: "changelog", description: "Generate changelog", body: "Do it.", sourcePath: "/tmp/c.md" }],
      agents: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks[0].category).toBe("command")
  })

  test("all commands become playbooks (no slash-command classification)", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      commands: [
        { name: "simple", description: "Short", body: "Do it.", sourcePath: "/tmp/c.md" },
        { name: "complex", description: "Long", body: "Step 1.\nStep 2.\nStep 3.\nStep 4.\nStep 5.", sourcePath: "/tmp/c2.md" },
      ],
      agents: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks).toHaveLength(2)
    // Both should be playbooks, not slash commands
    expect(bundle.playbooks[0].content).toContain("## Overview")
    expect(bundle.playbooks[1].content).toContain("## Overview")
  })

  // --- Skill conversion tests ---

  test("skills convert to knowledge entries (with fallback body)", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    expect(bundle.knowledgeEntries).toHaveLength(1)
    const entry = bundle.knowledgeEntries[0]
    expect(entry.name).toBe("dhh-rails-style")
    expect(entry.title).toBe("[CE] knowledge:dhh-rails-style")
  })

  test("skill description becomes triggerDescription with When prefix", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    const entry = bundle.knowledgeEntries[0]
    expect(entry.triggerDescription).toStartWith("When ")
    expect(entry.triggerDescription).toContain("Ruby on Rails")
  })

  test("skill with empty description gets default trigger", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      skills: [{ name: "my-skill", sourceDir: "/tmp/s", skillPath: "/tmp/s/SKILL.md" }],
      agents: [],
      commands: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.knowledgeEntries[0].triggerDescription).toBe("When working with my-skill")
  })

  test("skill triggerDescription already starting with When is not doubled", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      skills: [{ name: "test", description: "When writing Ruby code", sourceDir: "/tmp/s", skillPath: "/tmp/s/SKILL.md" }],
      agents: [],
      commands: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.knowledgeEntries[0].triggerDescription).toBe("When writing Ruby code")
    expect(bundle.knowledgeEntries[0].triggerDescription).not.toStartWith("When When")
  })

  test("long triggerDescription is truncated", () => {
    const longDesc = "a".repeat(600)
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      skills: [{ name: "long-skill", description: longDesc, sourceDir: "/tmp/s", skillPath: "/tmp/s/SKILL.md" }],
      agents: [],
      commands: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.knowledgeEntries[0].triggerDescription.length).toBeLessThanOrEqual(500)
    expect(bundle.knowledgeEntries[0].triggerDescription).toEndWith("...")
  })

  // --- MCP handling tests ---

  test("MCP servers generate setup instructions", () => {
    const bundle = convertClaudeToDevin(fixturePlugin, defaultOptions)

    expect(bundle.mcpSetupInstructions).toBeDefined()
    expect(bundle.mcpSetupInstructions).toContain("context7")
    expect(bundle.mcpSetupInstructions).toContain("https://mcp.context7.com/mcp")
  })

  test("MCP servers emit console.warn", () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)

    convertClaudeToDevin(fixturePlugin, defaultOptions)

    console.warn = originalWarn
    expect(warnings.some((w) => w.includes("Devin MCP servers"))).toBe(true)
  })

  // --- Hooks handling ---

  test("hooks emit console.warn", () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)

    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      hooks: { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo test" }] }] } },
      agents: [],
      commands: [],
      skills: [],
    }

    convertClaudeToDevin(plugin, defaultOptions)

    console.warn = originalWarn
    expect(warnings.some((w) => w.includes("hooks"))).toBe(true)
  })

  // --- Edge cases ---

  test("plugin with zero agents produces empty playbooks from agents", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks).toHaveLength(0)
  })

  test("plugin with only skills works correctly", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks).toHaveLength(0)
    expect(bundle.knowledgeEntries).toHaveLength(1)
  })

  test("agent name colliding with another agent gets deduplicated", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [
        { name: "reviewer", description: "First", body: "First body.", sourcePath: "/tmp/a1.md" },
        { name: "Reviewer", description: "Second", body: "Second body.", sourcePath: "/tmp/a2.md" },
      ],
      commands: [],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    const names = bundle.playbooks.map((p) => p.name)
    expect(names).toContain("reviewer")
    expect(names).toContain("reviewer-2")
  })
})

describe("transformContentForDevin", () => {
  test("strips .claude/ paths (no Devin equivalent)", () => {
    const result = transformContentForDevin("Read .claude/settings.json for config.")
    expect(result).not.toContain(".claude/settings.json")
  })

  test("strips ~/.claude/ paths (no Devin equivalent)", () => {
    const result = transformContentForDevin("Check ~/.claude/config for settings.")
    expect(result).not.toContain("~/.claude/config")
  })

  test("transforms Task agent(args) to playbook reference", () => {
    const input = `Run these:

- Task repo-research-analyst(feature_description)
- Task learnings-researcher(feature_description)

Task best-practices-researcher(topic)`

    const result = transformContentForDevin(input)
    expect(result).toContain("Run the repo-research-analyst playbook with: feature_description")
    expect(result).toContain("Run the learnings-researcher playbook with: feature_description")
    expect(result).toContain("Run the best-practices-researcher playbook with: topic")
    expect(result).not.toContain("Task repo-research-analyst")
  })

  test("transforms @agent references to playbook references", () => {
    const result = transformContentForDevin("Ask @security-sentinel for a review.")
    expect(result).toContain("the security-sentinel playbook")
    expect(result).not.toContain("@security-sentinel")
  })

  test("transforms slash command references to playbook references", () => {
    const result = transformContentForDevin("Run /workflows:plan to create a plan.")
    expect(result).toContain("the workflows-plan playbook")
    expect(result).not.toContain("/workflows:plan")
  })

  test("removes ${CLAUDE_PLUGIN_ROOT} references", () => {
    const result = transformContentForDevin("Read ${CLAUDE_PLUGIN_ROOT}/agents/test.md")
    expect(result).toContain("./agents/test.md")
    expect(result).not.toContain("CLAUDE_PLUGIN_ROOT")
  })

  test("strips Claude Code XML tags", () => {
    const result = transformContentForDevin("<thinking>Think about it.</thinking>\nDo the thing.\n<examples>Example</examples>")
    expect(result).not.toContain("<thinking>")
    expect(result).not.toContain("</thinking>")
    expect(result).not.toContain("<examples>")
    expect(result).toContain("Do the thing.")
  })

  // --- Skill terminology rewrites ---

  test("rewrites 'Load the X skill'", () => {
    const result = transformContentForDevin("Load the brainstorming skill for question techniques")
    expect(result).toContain("[CE] knowledge:brainstorming knowledge entry")
    expect(result).not.toContain("skill")
  })

  test("rewrites 'Invoke the X skill'", () => {
    const result = transformContentForDevin("Invoke the document-review skill now")
    expect(result).toContain("[CE] knowledge:document-review knowledge entry")
  })

  test("rewrites 'the X skill' in context", () => {
    const result = transformContentForDevin("See the document-review skill for details")
    expect(result).toContain("[CE] knowledge:document-review knowledge entry")
  })

  test("does NOT rewrite 'skill' in prose context", () => {
    const result = transformContentForDevin("This is a skill-intensive task")
    expect(result).toBe("This is a skill-intensive task")
  })

  test("rewrites SKILL.md path references", () => {
    const result = transformContentForDevin("Read .devin/skills/brainstorming/SKILL.md")
    expect(result).toContain("[CE] knowledge:brainstorming knowledge entry")
    expect(result).not.toContain("SKILL.md")
  })

  test("rewrites skills/ path without .devin/ prefix", () => {
    const result = transformContentForDevin("Read skills/brainstorming/SKILL.md")
    expect(result).toContain("[CE] knowledge:brainstorming knowledge entry")
  })

  test("rewrites .devin/skills/** glob patterns", () => {
    const result = transformContentForDevin("Check ~/.devin/skills/**/SKILL.md")
    expect(result).toBe("Check available knowledge entries")
  })

  // --- Claude Code tool rewrites ---

  test("rewrites AskUserQuestion plain text", () => {
    const result = transformContentForDevin("Use the AskUserQuestion tool to ask")
    expect(result).toBe("Ask the user to ask")
  })

  test("rewrites **AskUserQuestion tool** bold markdown", () => {
    const result = transformContentForDevin("Use the **AskUserQuestion tool** to ask")
    expect(result).toBe("Use the **Ask the user** to ask")
  })

  test("removes EnterPlanMode reference", () => {
    const result = transformContentForDevin("Use EnterPlanMode to start planning")
    expect(result).not.toContain("EnterPlanMode")
    expect(result).toContain("to start planning")
  })

  test("removes ExitPlanMode reference", () => {
    const result = transformContentForDevin("Call ExitPlanMode when done")
    expect(result).not.toContain("ExitPlanMode")
  })

  test("rewrites $ARGUMENTS", () => {
    const result = transformContentForDevin("Process $ARGUMENTS from the user")
    expect(result).toBe("Process the user-provided input from the user")
  })

  test("rewrites Skill tool", () => {
    const result = transformContentForDevin("Use the Skill tool to load")
    expect(result).toContain("the knowledge entry")
  })

  test("rewrites TodoWrite", () => {
    const result = transformContentForDevin("Use the TodoWrite tool to track tasks")
    expect(result).toContain("Track progress")
  })

  test("preserves file-access tools", () => {
    const result = transformContentForDevin("Use Read tool to read files, Grep tool to search")
    expect(result).toBe("Use Read tool to read files, Grep tool to search")
  })

  // --- Playbook cross-references ---

  test("rewrites 'Run the X playbook with: args' to propose_sessions with ref map", () => {
    const refMap = { "security-sentinel": { title: "[CE] agent:security-sentinel", category: "agent" as const } }
    const result = transformContentForDevin("Run the security-sentinel playbook with: code review", refMap)
    expect(result).toContain("propose_sessions")
    expect(result).toContain("[CE] agent:security-sentinel")
    expect(result).toContain("code review")
  })

  test("rewrites 'the X playbook' to titled ref with ref map", () => {
    const refMap = { "deepen-plan": { title: "[CE] workflow:deepen-plan", category: "workflow" as const } }
    const result = transformContentForDevin("refer to the deepen-plan playbook", refMap)
    expect(result).toContain("[CE] workflow:deepen-plan")
  })

  test("knowledge refs emit 'knowledge entry' not 'playbook'", () => {
    const refMap = { "deepen-plan": { title: "[CE] knowledge:deepen-plan", category: "knowledge" as const } }
    const result = transformContentForDevin("refer to the deepen-plan playbook", refMap)
    expect(result).toContain("[CE] knowledge:deepen-plan knowledge entry")
    expect(result).not.toContain("playbook")
  })

  test("preserves original text for unknown playbook names", () => {
    const refMap = { "security-sentinel": { title: "[CE] agent:security-sentinel", category: "agent" as const } }
    const result = transformContentForDevin("Run the unknown-agent playbook", refMap)
    expect(result).toBe("Run the unknown-agent playbook")
  })

  test("skips cross-ref rewrite when no map provided", () => {
    const result = transformContentForDevin("Run the security-sentinel playbook")
    expect(result).toContain("the security-sentinel playbook")
  })

  test("cross-ref is case-insensitive", () => {
    const refMap = { "security-sentinel": { title: "[CE] agent:security-sentinel", category: "agent" as const } }
    const result = transformContentForDevin("The security-sentinel playbook handles reviews", refMap)
    expect(result).toContain("[CE] agent:security-sentinel")
  })

  // --- Transform ordering integration test ---

  test("full chain: @agent-ref → 'the X playbook' → titled ref", () => {
    const refMap = { "security-sentinel": { title: "[CE] agent:security-sentinel", category: "agent" as const } }
    // @agent ref gets transformed to "the X playbook" by step 3, then to titled ref by step 9
    const result = transformContentForDevin("Ask @security-sentinel for a review.", refMap)
    expect(result).toContain("[CE] agent:security-sentinel")
  })

  test("full chain: /workflows:plan → 'the workflows-plan playbook' → titled ref", () => {
    const refMap = { "workflows-plan": { title: "[CE] workflow:plan", category: "workflow" as const } }
    const result = transformContentForDevin("Run /workflows:plan to start planning.", refMap)
    expect(result).toContain("[CE] workflow:plan")
    expect(result).not.toContain("the workflows-plan playbook")
  })

  // --- Additional coverage: case sensitivity, multiple occurrences ---

  test("skill rewrite is case-insensitive", () => {
    const result = transformContentForDevin("LOAD THE brainstorming SKILL")
    expect(result).toContain("[CE] knowledge:brainstorming")
  })

  test("rewrites multiple skill references in one line", () => {
    const input = "Load the brainstorming skill and then the document-review skill"
    const result = transformContentForDevin(input)
    expect(result).toContain("[CE] knowledge:brainstorming")
    expect(result).toContain("[CE] knowledge:document-review")
  })

  test("does not rewrite 'the X skill directory'", () => {
    const result = transformContentForDevin("Check the brainstorming skill directory for files")
    expect(result).toBe("Check the brainstorming skill directory for files")
  })

  // --- normalizeName coupling: workflows:X must produce workflows-X for prefix stripping ---

  test("workflows:brainstorm command produces playbook named 'brainstorm'", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [],
      commands: [{ name: "workflows:brainstorm", description: "Brainstorm", body: "Do it.", sourcePath: "/tmp/c.md" }],
      skills: [],
    }

    const bundle = convertClaudeToDevin(plugin, defaultOptions)

    expect(bundle.playbooks[0].name).toBe("brainstorm")
    expect(bundle.playbooks[0].macro).toBe("workflow_brainstorm")
  })

  // --- Idempotency test ---

  test("running transform twice produces same output", () => {
    const refMap = { "brainstorm": { title: "[CE] workflow:brainstorm", category: "workflow" as const } }
    const input = "Load the brainstorming skill and Run the brainstorm playbook"
    const first = transformContentForDevin(input, refMap)
    const second = transformContentForDevin(first, refMap)
    expect(second).toBe(first)
  })

  // -----------------------------------------------------------------------
  // FALSE POSITIVE GUARDS — things that must NOT be transformed
  // -----------------------------------------------------------------------

  describe("open command — false positive guards", () => {
    test("does NOT mangle 'agent-browser open https://...' CLI command", () => {
      const result = transformContentForDevin("Run: agent-browser open https://example.com")
      expect(result).toContain("agent-browser open https://example.com")
      expect(result).not.toContain("present https")
      expect(result).not.toContain("present http")
    })

    test("does NOT mangle 'agent-browser open http://localhost:PORT'", () => {
      const result = transformContentForDevin("agent-browser open http://localhost:${PORT}")
      expect(result).toContain("agent-browser open http://localhost:${PORT}")
    })

    test("does NOT mangle 'open PR' adjective usage", () => {
      const result = transformContentForDevin("Check for an open PR before pushing.")
      expect(result).toContain("open PR")
      expect(result).not.toContain("present PR")
    })

    test("does NOT mangle 'open pull request' adjective usage", () => {
      const result = transformContentForDevin("If an open pull request exists, update it.")
      expect(result).toContain("open pull request")
      expect(result).not.toContain("present pull")
    })

    test("does NOT mangle 'open issues' adjective usage", () => {
      const result = transformContentForDevin("List all open issues in the repository.")
      expect(result).toContain("open issues")
      expect(result).not.toContain("present issues")
    })

    test("does NOT mangle 'No open or recently closed issues'", () => {
      const result = transformContentForDevin("No open or recently closed issues found.")
      expect(result).toContain("No open or recently closed issues")
    })

    test("does NOT mangle https:// URLs (protocol slashes)", () => {
      const result = transformContentForDevin("Visit https://github.com/example/repo")
      expect(result).not.toContain("present https")
      expect(result).toContain("https://github.com")
    })

    test("DOES rewrite 'Run `open ./docs/plan.md`' local path desktop command", () => {
      const result = transformContentForDevin("Run `open ./docs/plan.md` to view the file")
      expect(result).toContain("present ./docs/plan.md to the user")
      expect(result).not.toContain("Run `open ./docs/plan.md`")
    })

    test("DOES rewrite 'xdg-open ./output.html'", () => {
      const result = transformContentForDevin("Run xdg-open ./output.html to preview")
      expect(result).toContain("present ./output.html to the user")
    })
  })

  // -----------------------------------------------------------------------
  // CLAUDE.md dedup edge cases
  // -----------------------------------------------------------------------

  describe("CLAUDE.md → AGENTS.md dedup", () => {
    test("collapses 'CLAUDE.md, AGENTS.md' to single AGENTS.md", () => {
      const result = transformContentForDevin("Read CLAUDE.md, AGENTS.md for conventions.")
      expect(result).toContain("AGENTS.md")
      expect(result).not.toMatch(/AGENTS\.md.*AGENTS\.md/)
    })

    test("collapses 'AGENTS.md, CLAUDE.md' (reversed order) to single AGENTS.md", () => {
      const result = transformContentForDevin("(AGENTS.md, CLAUDE.md, or similar)")
      expect(result).not.toMatch(/AGENTS\.md.*AGENTS\.md/)
    })

    test("collapses 'CLAUDE.md and AGENTS.md' to single AGENTS.md", () => {
      const result = transformContentForDevin("Check CLAUDE.md and AGENTS.md for config.")
      expect(result).not.toMatch(/AGENTS\.md.*AGENTS\.md/)
    })

    test("collapses already-doubled 'AGENTS.md, AGENTS.md' (prior bad convert)", () => {
      const result = transformContentForDevin("See AGENTS.md, AGENTS.md for details.")
      expect(result).not.toMatch(/AGENTS\.md, AGENTS\.md/)
    })
  })

  // -----------------------------------------------------------------------
  // SKILL PRONOUN GUARDS — must not produce knowledge:this / knowledge:the
  // -----------------------------------------------------------------------

  describe("skill pronoun guards", () => {
    test("does NOT produce 'knowledge:this' from 'Refer to this skill'", () => {
      const result = transformContentForDevin("Refer to this skill directly from bash.")
      expect(result).not.toContain("knowledge:this")
    })

    test("does NOT produce 'knowledge:the' from 'Load the skill'", () => {
      const result = transformContentForDevin("Load the skill and apply it.")
      expect(result).not.toContain("knowledge:the")
    })

    test("does NOT produce 'knowledge:a' from 'Run a skill'", () => {
      const result = transformContentForDevin("Run a skill if available.")
      expect(result).not.toContain("knowledge:a")
    })

    test("does NOT produce 'knowledge:your' from 'Use your skill'", () => {
      const result = transformContentForDevin("Use your skill to complete the task.")
      expect(result).not.toContain("knowledge:your")
    })

    test("DOES rewrite named skill 'Run git-worktree skill'", () => {
      const result = transformContentForDevin("Run git-worktree skill to manage branches.")
      expect(result).toContain("[CE] knowledge:git-worktree knowledge entry")
    })
  })

  // -----------------------------------------------------------------------
  // compound-engineering:category:name PROSE REFS
  // -----------------------------------------------------------------------

  describe("compound-engineering namespace prose refs", () => {
    test("converts 'compound-engineering:workflow:pr-comment-resolver' to [CE] agent ref", () => {
      const result = transformContentForDevin("Spawn a compound-engineering:workflow:pr-comment-resolver agent for each thread.")
      expect(result).toContain("[CE] agent:pr-comment-resolver")
      expect(result).not.toContain("compound-engineering:workflow:pr-comment-resolver")
    })

    test("converts 'compound-engineering:research:best-practices-researcher'", () => {
      const result = transformContentForDevin("Use compound-engineering:research:best-practices-researcher for context.")
      expect(result).toContain("[CE] agent:best-practices-researcher")
    })

    test("converts multiple compound-engineering refs in same line", () => {
      const result = transformContentForDevin(
        "Spawn compound-engineering:document-review:coherence-reviewer and compound-engineering:document-review:feasibility-reviewer"
      )
      expect(result).toContain("[CE] agent:coherence-reviewer")
      expect(result).toContain("[CE] agent:feasibility-reviewer")
      expect(result).not.toContain("compound-engineering:")
    })
  })

  // -----------------------------------------------------------------------
  // CLAUDE CODE PLATFORM HINTS
  // -----------------------------------------------------------------------

  describe("Claude Code platform hints", () => {
    test("strips inline platform hint '(e.g., Ask the user in Claude Code, ...)'", () => {
      const result = transformContentForDevin(
        "Ask the user (e.g., Ask the user in Claude Code, request_user_input in Codex, ask_user in Gemini) for the value."
      )
      expect(result).not.toContain("in Claude Code")
      expect(result).not.toContain("request_user_input in Codex")
      expect(result).not.toContain("ask_user in Gemini")
    })

    test("strips 'in Claude Code' fragment from prose", () => {
      const result = transformContentForDevin("Use the blocking question tool in Claude Code to ask.")
      expect(result).not.toContain("in Claude Code")
    })

    test("strips 'for Claude Code' fragment", () => {
      const result = transformContentForDevin("This feature is only available for Claude Code.")
      expect(result).not.toContain("for Claude Code")
    })

    test("does NOT strip unrelated text containing 'Claude'", () => {
      // 'Claude' alone (not 'Claude Code') should be preserved
      const result = transformContentForDevin("Claude is an AI assistant made by Anthropic.")
      expect(result).toContain("Claude is an AI assistant")
    })
  })

  // -----------------------------------------------------------------------
  // CLAUDE CODE ENV VARS
  // -----------------------------------------------------------------------

  describe("Claude Code environment variables", () => {
    test("strips entire lines containing CLAUDE_CODE_TEAM_NAME", () => {
      const input = "Set up env:\n- CLAUDE_CODE_TEAM_NAME=myteam\n- PORT=3000"
      const result = transformContentForDevin(input)
      expect(result).not.toContain("CLAUDE_CODE_TEAM_NAME")
      expect(result).toContain("PORT=3000")
    })

    test("strips entire lines containing CLAUDE_CODE_AGENT_ID", () => {
      const result = transformContentForDevin("export CLAUDE_CODE_AGENT_ID=abc123")
      expect(result).not.toContain("CLAUDE_CODE_AGENT_ID")
    })

    test("strips entire lines containing CLAUDE_CODE_SESSION_*", () => {
      const result = transformContentForDevin("Read CLAUDE_CODE_SESSION_ID from env")
      expect(result).not.toContain("CLAUDE_CODE_SESSION_ID")
    })
  })

  // -----------------------------------------------------------------------
  // CLAUDE CODE TOOL REFS IN PROSE
  // -----------------------------------------------------------------------

  describe("Claude Code tool refs in prose", () => {
    test("strips TaskCreate from prose", () => {
      const result = transformContentForDevin("Use TaskCreate to log progress in Claude Code.")
      expect(result).not.toContain("TaskCreate")
    })

    test("strips TaskList from prose", () => {
      const result = transformContentForDevin("Call TaskList to see pending items.")
      expect(result).not.toContain("TaskList")
    })

    test("strips TeammateTool from prose", () => {
      const result = transformContentForDevin("Use TeammateTool to spawn agents.")
      expect(result).not.toContain("TeammateTool")
    })

    test("strips Teammate from prose", () => {
      const result = transformContentForDevin("Use Teammate({ operation: 'spawnTeam' }) to start.")
      expect(result).not.toContain("Teammate")
    })
  })

  // -----------------------------------------------------------------------
  // .claude/ PATH STRIPPING
  // -----------------------------------------------------------------------

  describe(".claude/ path stripping", () => {
    test("strips .claude/settings.json", () => {
      const result = transformContentForDevin("Check .claude/settings.json for hooks.")
      expect(result).not.toContain(".claude/settings.json")
    })

    test("strips ~/.claude/plugins/installed_plugins.json", () => {
      const result = transformContentForDevin("Read ~/.claude/plugins/installed_plugins.json")
      expect(result).not.toContain("~/.claude/plugins")
    })

    test("strips ~/.claude/teams/ paths", () => {
      const result = transformContentForDevin("Team state is stored in ~/.claude/teams/myteam")
      expect(result).not.toContain("~/.claude/teams/")
    })
  })

  // -----------------------------------------------------------------------
  // ce-X SLASH COMMAND RESOLUTION VIA REFMAP (4a → 9 chain)
  // -----------------------------------------------------------------------

  describe("ce: slash command resolution via refMap", () => {
    test("/ce:plan resolves to [CE] workflow:plan playbook via refMap", () => {
      const refMap = {
        "ce-plan": { title: "[CE] workflow:plan", category: "workflow" as const },
      }
      const result = transformContentForDevin("Run /ce:plan to create a plan.", refMap)
      expect(result).toContain("[CE] workflow:plan")
      expect(result).not.toContain("/ce:plan")
    })

    test("/ce:review resolves to [CE] workflow:review playbook via refMap", () => {
      const refMap = {
        "ce-review": { title: "[CE] workflow:review", category: "workflow" as const },
      }
      const result = transformContentForDevin("After work, run /ce:review to verify.", refMap)
      expect(result).toContain("[CE] workflow:review")
    })
  })

  // -----------------------------------------------------------------------
  // RULE INTERACTION / ORDERING HAZARDS
  // -----------------------------------------------------------------------

  describe("rule interaction and ordering hazards", () => {
    test("skill rewrite followed by cross-ref does not double-wrap", () => {
      // step 7 turns 'Load the brainstorming skill' → '[CE] knowledge:brainstorming knowledge entry'
      // step 9 must not then try to match 'brainstorming' inside that as a playbook
      const refMap = { "brainstorming": { title: "[CE] workflow:brainstorm", category: "workflow" as const } }
      const result = transformContentForDevin("Load the brainstorming skill for guidance.", refMap)
      expect(result).toContain("[CE] knowledge:brainstorming knowledge entry")
      expect(result).not.toContain("[CE] workflow:brainstorm")
    })

    test("CLAUDE.md dedup runs before AGENTS.md cross-ref rewrite", () => {
      // If dedup runs after, AGENTS.md,AGENTS.md would persist
      const result = transformContentForDevin("Check CLAUDE.md, AGENTS.md, or similar conventions.")
      expect(result).not.toMatch(/AGENTS\.md.*AGENTS\.md/)
    })

    test("open rewrite does not corrupt 'Run `open ./plan.md`' inside a larger sentence", () => {
      const result = transformContentForDevin(
        "After planning, Run `open ./docs/plans/my-plan.md` to review it."
      )
      expect(result).toContain("present ./docs/plans/my-plan.md to the user")
      expect(result).not.toContain("Run `open ./docs/plans/my-plan.md`")
    })

    test("compound-engineering ref transform runs before TaskCreate strip, no partial match", () => {
      const result = transformContentForDevin(
        "Use compound-engineering:workflow:pr-comment-resolver with TaskCreate to track."
      )
      expect(result).toContain("[CE] agent:pr-comment-resolver")
      expect(result).not.toContain("TaskCreate")
    })

    test("'the the' artifact cleanup fires after substitution chains", () => {
      // skill rewrite: 'the brainstorming skill' → 'the [CE] knowledge:brainstorming knowledge entry'
      // if something upstream prepended 'the', we'd get 'the the [CE]...'
      const result = transformContentForDevin("Refer to the brainstorming skill.")
      expect(result).not.toContain("the the")
    })
  })
})

describe("formatPlaybook", () => {
  test("produces valid .devin.md with required sections", () => {
    const result = formatPlaybook("My Playbook", {
      overview: "Does things",
      procedure: "1. Step one\n2. Step two",
    })

    expect(result).toContain("# My Playbook")
    expect(result).toContain("## Overview")
    expect(result).toContain("Does things")
    expect(result).toContain("## Procedure")
    expect(result).toContain("1. Step one")
  })

  test("omits empty/undefined sections", () => {
    const result = formatPlaybook("Test", {
      overview: "Overview",
      procedure: "Procedure",
    })

    expect(result).not.toContain("## Specifications")
    expect(result).not.toContain("## Advice")
    expect(result).not.toContain("## Forbidden Actions")
    expect(result).not.toContain("## What's Needed From User")
  })

  test("includes all sections when provided", () => {
    const result = formatPlaybook("Full", {
      overview: "Overview text",
      procedure: "Procedure text",
      specifications: "Spec text",
      advice: "Advice text",
      forbiddenActions: "Forbidden text",
      neededFromUser: "Needed text",
    })

    expect(result).toContain("## Overview")
    expect(result).toContain("## Procedure")
    expect(result).toContain("## Specifications")
    expect(result).toContain("## Advice")
    expect(result).toContain("## Forbidden Actions")
    expect(result).toContain("## What's Needed From User")
  })
})
