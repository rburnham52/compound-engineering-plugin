import { readFileSync } from "fs"
import { parseFrontmatter } from "../utils/frontmatter"
import type { ClaudeAgent, ClaudeCommand, ClaudeMcpServer, ClaudePlugin, ClaudeSkill } from "../types/claude"
import type { DevinBundle, DevinKnowledgeEntry, DevinPlaybook, DevinPlaybookSections } from "../types/devin"
import type { ClaudeToOpenCodeOptions } from "./claude-to-opencode"
import { CE_PREFIX, toDevinTitle, toMacroName } from "../utils/devin-conventions"

export type ClaudeToDevinOptions = ClaudeToOpenCodeOptions

const TRIGGER_MAX_LENGTH = 500

export function convertClaudeToDevin(
  plugin: ClaudePlugin,
  _options: ClaudeToDevinOptions,
): DevinBundle {
  const usedPlaybookNames = new Set<string>()
  const usedKnowledgeNames = new Set<string>()

  // Pre-scan: build ref map from all component names so cross-references
  // can be resolved during content transformation.
  const playbookRefMap: Record<string, PlaybookRef> = Object.create(null)

  for (const agent of plugin.agents) {
    const name = normalizeName(agent.name)
    // Agents have no macro — they are invoked via propose_sessions
    playbookRefMap[name] = { title: toDevinTitle(name, "agent"), category: "agent" }
  }
  for (const command of plugin.commands) {
    const fullName = normalizeName(command.name)
    const isWorkflow = command.name.startsWith("workflows:")
    const name = isWorkflow ? fullName.replace(/^workflows-/, "") : fullName
    const category = isWorkflow ? "workflow" : "command" as const
    const macro = isWorkflow ? `workflow_${toMacroName(name)}` : toMacroName(name)
    playbookRefMap[name] = { title: toDevinTitle(name, category), category, macro }
    if (isWorkflow) playbookRefMap[fullName] = { title: toDevinTitle(name, "workflow"), category: "workflow", macro }
  }
  // Skills with ce: or workflows: prefix are workflow commands — add to refMap
  // Other skills become knowledge entries — also add so /skill-name refs resolve
  for (const skill of plugin.skills) {
    if (isWorkflowSkill(skill.name)) {
      const name = workflowSkillName(skill.name)
      const macro = `ce_${toMacroName(name)}`
      const ref: PlaybookRef = { title: toDevinTitle(name, "workflow"), category: "workflow", macro }
      playbookRefMap[name] = ref
      // Also register the namespaced alias (e.g. "ce-plan") so step 4a output
      // "the ce-plan playbook" resolves correctly in step 9
      const namespacedAlias = normalizeName(skill.name) // ce:plan → "ce-plan"
      if (namespacedAlias !== name) playbookRefMap[namespacedAlias] = ref
    } else {
      const name = normalizeName(skill.name)
      playbookRefMap[name] = { title: toDevinTitle(name, "knowledge"), category: "knowledge" as const }
    }
  }

  // Convert: single pass with ref map available
  const playbooks: DevinPlaybook[] = []

  for (const agent of plugin.agents) {
    playbooks.push(convertAgentToPlaybook(agent, usedPlaybookNames, playbookRefMap))
  }

  for (const command of plugin.commands) {
    playbooks.push(convertCommandToPlaybook(command, usedPlaybookNames, playbookRefMap))
  }

  // Skills with ce:/workflows: prefix → workflow playbooks; rest → knowledge entries
  const knowledgeEntries: DevinKnowledgeEntry[] = []
  for (const skill of plugin.skills) {
    if (isWorkflowSkill(skill.name)) {
      playbooks.push(convertSkillToPlaybook(skill, usedPlaybookNames, playbookRefMap))
    } else {
      knowledgeEntries.push(convertSkillToKnowledge(skill, usedKnowledgeNames, playbookRefMap))
    }
  }

  // Generate MCP setup instructions
  let mcpSetupInstructions: string | undefined
  if (plugin.mcpServers && Object.keys(plugin.mcpServers).length > 0) {
    mcpSetupInstructions = generateMcpSetupInstructions(plugin.mcpServers)
    console.warn(
      "Warning: Devin MCP servers are configured via the web UI (Settings > MCP Marketplace), not files. See .devin/mcp-setup-instructions.md for setup details.",
    )
  }

  // Warn about hooks
  if (plugin.hooks && Object.keys(plugin.hooks.hooks).length > 0) {
    console.warn("Warning: Devin does not support file-based hooks. Hooks were skipped during conversion.")
  }

  return { playbooks, knowledgeEntries, mcpSetupInstructions }
}

export type PlaybookRef = {
  title: string
  category: "agent" | "workflow" | "command" | "knowledge"
  macro?: string
}

function convertAgentToPlaybook(
  agent: ClaudeAgent,
  usedNames: Set<string>,
  playbookRefMap: Record<string, PlaybookRef>,
): DevinPlaybook {
  const name = uniqueName(normalizeName(agent.name), usedNames)

  let body = agent.body.trim()
  body = transformContentForDevin(body, playbookRefMap)

  const sections: DevinPlaybookSections = {
    overview: agent.description ?? `Converted from the ${agent.name} agent.`,
    procedure: body || `Instructions converted from the ${agent.name} agent.`,
  }

  if (agent.capabilities && agent.capabilities.length > 0) {
    sections.specifications = agent.capabilities.map((c) => `- ${c}`).join("\n")
  }

  const title = toDevinTitle(name, "agent")
  const content = formatPlaybook(title, sections)
  return { name, content, category: "agent" }
}

function convertCommandToPlaybook(
  command: ClaudeCommand,
  usedNames: Set<string>,
  playbookRefMap: Record<string, PlaybookRef>,
): DevinPlaybook {
  const category = command.name.startsWith("workflows:") ? "workflow" : "command" as const

  let normalizedName = normalizeName(command.name)
  if (category === "workflow") {
    normalizedName = normalizedName.replace(/^workflows-/, "")
  }
  const name = uniqueName(normalizedName, usedNames)

  const body = transformContentForDevin(command.body.trim(), playbookRefMap)

  const sections: DevinPlaybookSections = {
    overview: command.description ?? `Converted from the ${command.name} command.`,
    procedure: body || `Instructions converted from the ${command.name} command.`,
  }

  if (command.argumentHint) {
    sections.neededFromUser = `Provide: ${command.argumentHint}`
  }

  const title = toDevinTitle(name, category)
  const macro = category === "workflow"
    ? `workflow_${toMacroName(name)}`
    : toMacroName(name)

  const content = formatPlaybook(title, sections)
  return { name, content, category, macro }
}

function convertSkillToKnowledge(
  skill: ClaudeSkill,
  usedNames: Set<string>,
  playbookRefMap: Record<string, PlaybookRef>,
): DevinKnowledgeEntry {
  const name = uniqueName(normalizeName(skill.name), usedNames)

  // Read skill body from SKILL.md file
  let body = ""
  try {
    const raw = readFileSync(skill.skillPath, "utf-8")
    const parsed = parseFrontmatter(raw)
    body = transformContentForDevin(parsed.body.trim(), playbookRefMap)
  } catch {
    body = `Knowledge converted from the ${skill.name} skill.`
    console.warn(`Warning: Could not read skill file at ${skill.skillPath}. Using default body.`)
  }

  if (!body) {
    body = `Knowledge converted from the ${skill.name} skill.`
  }

  // Generate trigger description
  let triggerDescription = skill.description ?? `When working with ${skill.name}`
  if (!triggerDescription.toLowerCase().startsWith("when ")) {
    triggerDescription = `When ${triggerDescription.charAt(0).toLowerCase()}${triggerDescription.slice(1)}`
  }
  if (triggerDescription.length > TRIGGER_MAX_LENGTH) {
    triggerDescription = triggerDescription.slice(0, TRIGGER_MAX_LENGTH - 3).trimEnd() + "..."
  }

  const title = toDevinTitle(name, "knowledge")

  return { name, title, body, triggerDescription }
}

function isWorkflowSkill(skillName: string): boolean {
  return skillName.startsWith("ce:") || skillName.startsWith("workflows:")
}

function workflowSkillName(skillName: string): string {
  // "ce:plan" → "plan", "workflows:plan" → "plan"
  const name = normalizeName(skillName)
  return name.replace(/^ce-/, "").replace(/^workflows-/, "")
}

function convertSkillToPlaybook(
  skill: ClaudeSkill,
  usedNames: Set<string>,
  playbookRefMap: Record<string, PlaybookRef>,
): DevinPlaybook {
  const name = uniqueName(workflowSkillName(skill.name), usedNames)

  let body = ""
  try {
    const raw = readFileSync(skill.skillPath, "utf-8")
    const parsed = parseFrontmatter(raw)
    body = transformContentForDevin(parsed.body.trim(), playbookRefMap)
  } catch {
    body = `Instructions converted from the ${skill.name} skill.`
    console.warn(`Warning: Could not read skill file at ${skill.skillPath}. Using default body.`)
  }

  if (!body) {
    body = `Instructions converted from the ${skill.name} skill.`
  }

  const title = toDevinTitle(name, "workflow")
  const sections: DevinPlaybookSections = {
    overview: skill.description ?? `Converted from the ${skill.name} skill.`,
    procedure: body,
  }
  if (skill.argumentHint) {
    sections.neededFromUser = `Provide: ${skill.argumentHint}`
  }

  const macro = `ce_${toMacroName(name)}`
  const content = formatPlaybook(title, sections)
  return { name, content, category: "workflow", macro }
}

function generateMcpSetupInstructions(servers: Record<string, ClaudeMcpServer>): string {
  const lines: string[] = [
    "# MCP Server Setup Instructions",
    "",
    "The following MCP servers were configured in the Claude Code plugin.",
    "Devin MCP servers must be configured manually via the web UI (Settings > MCP Marketplace).",
    "",
  ]

  for (const [name, server] of Object.entries(servers)) {
    lines.push(`## ${name}`)
    lines.push("")
    if (server.type) lines.push(`- **Type:** ${server.type}`)
    if (server.command) {
      lines.push(`- **Command:** \`${server.command}\``)
      if (server.args && server.args.length > 0) {
        lines.push(`- **Args:** ${server.args.map((a) => `\`${a}\``).join(", ")}`)
      }
    }
    if (server.url) {
      lines.push(`- **URL:** ${server.url}`)
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`- **Environment variables:**`)
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`  - \`${key}\`: \`${value}\``)
      }
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`- **Headers:**`)
      for (const [key, value] of Object.entries(server.headers)) {
        lines.push(`  - \`${key}\`: \`${value}\``)
      }
    }
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * Transform Claude Code content to Devin-compatible content.
 *
 * Order matters — transforms run in this sequence:
 * 1. Task agent calls: Task agent-name(args) -> propose_sessions child session
 * 2. CLAUDE.md -> AGENTS.md
 * 3. Agent references: @agent-name -> the [CE] agent:name playbook
 * 4. Slash command references: /workflows:plan -> the [CE] workflow:plan playbook
 * 5. ${CLAUDE_PLUGIN_ROOT} -> .
 * 6. XML tag stripping
 * 7. Skill terminology rewrites (skill -> knowledge entry)
 * 8. Claude Code tool rewrites (AskUserQuestion, EnterPlanMode, $ARGUMENTS, etc.)
 * 9. Playbook cross-references (LAST) -> propose_sessions or titled reference
 */
export function transformContentForDevin(body: string, playbookRefMap?: Record<string, PlaybookRef>): string {
  let result = body

  // 1. Transform Task agent calls (including namespaced: Task compound-engineering:category:name(args))
  const taskPattern = /^(\s*-?\s*)Task\s+([a-z][a-z0-9:_-]*)\(([^)]+)\)/gm
  result = result.replace(taskPattern, (_match, prefix: string, agentName: string, args: string) => {
    // Strip any namespace prefix (e.g. "compound-engineering:research:") — keep only the agent name
    const shortName = agentName.split(":").pop() ?? agentName
    const playbookName = normalizeName(shortName)
    return `${prefix}Run the ${playbookName} playbook with: ${args.trim()}`
  })

  // 2. Rewrite CLAUDE.md → AGENTS.md (avoid producing "AGENTS.md, AGENTS.md" duplicates)
  // First collapse existing "CLAUDE.md, AGENTS.md" or "AGENTS.md, CLAUDE.md" combos → just "AGENTS.md"
  result = result.replace(/\bCLAUDE\.md(?:\s*,\s*|\s+and\s+)AGENTS\.md\b/gi, "AGENTS.md")
  result = result.replace(/\bAGENTS\.md(?:\s*,\s*|\s+and\s+)CLAUDE\.md\b/gi, "AGENTS.md")
  // Then collapse any remaining "AGENTS.md, AGENTS.md" duplicates (from prior bad transforms or double-pass)
  result = result.replace(/\bAGENTS\.md(?:\s*,\s*|\s+or\s+|\s+and\s+)AGENTS\.md\b/gi, "AGENTS.md")
  result = result.replace(/\bCLAUDE\.md\b/g, "AGENTS.md")

  // 3. Transform @agent-name references
  const agentRefPattern = /@([a-z][a-z0-9-]*-(?:agent|reviewer|researcher|analyst|specialist|oracle|sentinel|guardian|strategist))/gi
  result = result.replace(agentRefPattern, (_match, agentName: string) => {
    return `the ${normalizeName(agentName)} playbook`
  })

  // 4. Transform slash command references
  // 4a-pre. Backtick-wrapped `/namespace:command args` as a unit → "the X playbook with args: Y"
  // Must run BEFORE bare /namespace:command and BEFORE $ARGUMENTS rewrite so args are preserved intact
  result = result.replace(/`\/([\w-]+):([\w-]+)([^`\n]*)`/g, (_match, namespace: string, command: string, rest: string) => {
    const name = `${normalizeName(namespace)}-${normalizeName(command)}`
    const args = rest.trim()
    if (args) return `the ${name} playbook with args: ${args}`
    return `the ${name} playbook`
  })
  // 4a. /namespace:command (bare, not in backticks) — only after whitespace/start/punctuation
  result = result.replace(/(?<=^|[\s(`'"\)])\/([\w-]+):([\w-]+)/gm, (_match, namespace: string, command: string) => {
    return `the ${normalizeName(namespace)}-${normalizeName(command)} playbook`
  })
  // 4b. Bare /command-name — same anchor, known names only
  if (playbookRefMap) {
    result = result.replace(/(?<=^|[\s(`'"\)])\/([\w-]+)\b/gm, (_match, name: string) => {
      const normalized = normalizeName(name)
      const ref = playbookRefMap[normalized]
      if (!ref) return _match
      if (ref.category === "knowledge") return `the ${ref.title} knowledge entry`
      return `the ${ref.title} playbook`
    })
  }

  // 5. Remove ${CLAUDE_PLUGIN_ROOT} variable references
  result = result.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, ".")

  // 6. Strip Claude Code XML tags
  result = result.replace(/<\/?(thinking|objective|process|examples?|example|commentary|feature_description|plan_path|essential_principles|intake|routing|quick_reference|reference_index|success_criteria|credits)[^>]*>/g, "")

  // 7. Skill terminology rewrites
  // .claude/skills/**/*.md glob patterns (before specific path rewrites)
  result = result.replace(
    /~?\/?\.(?:claude|devin|codex|agents)\/skills\/\*\*\/SKILL\.md/g,
    "available knowledge entries",
  )
  // .claude/skills/<name>/assets/... path references → knowledge entry
  result = result.replace(
    /(?:~\/)?(?:\.[\w]+\/)?skills\/([\w-]+)\/assets\/([\w./\-]+)/g,
    (_match, skillName: string) => `the ${CE_PREFIX} knowledge:${skillName} knowledge entry (assets)`,
  )
  // "Load/Invoke/Run `X` skill" or "Load/Invoke/Run X skill" → knowledge entry reference
  // Guard: skip pronouns/articles as the captured name (this, the, a, an, that, my, your)
  const SKIP_SKILL_NAMES = /^(?:this|that|the|a|an|my|your|its|their)$/i
  result = result.replace(
    /(?:Load|Invoke|Run) [`]?([\w][\w-]*)[`]? skill\b/gi,
    (_match, name: string) => SKIP_SKILL_NAMES.test(name) ? _match : `Refer to the ${CE_PREFIX} knowledge:${normalizeName(name)} knowledge entry`,
  )
  // "Load/Invoke the X skill" (without backticks)
  result = result.replace(
    /(?:Load|Invoke) the [`"]?([\w][\w-]*)[\`"]? skill\b/gi,
    (_match, name: string) => SKIP_SKILL_NAMES.test(name) ? _match : `Refer to the ${CE_PREFIX} knowledge:${normalizeName(name)} knowledge entry`,
  )
  // "the X skill" (not followed by directory/file/path) — skip pronouns/articles
  result = result.replace(
    /the [`"]?([\w][\w-]*)[\`"]? skill\b(?!\s*(?:directory|file|path))/gi,
    (_match, name: string) => SKIP_SKILL_NAMES.test(name) ? _match : `the ${CE_PREFIX} knowledge:${normalizeName(name)} knowledge entry`,
  )
  // SKILL.md path references
  result = result.replace(
    /(?:\.(?:claude|devin|codex|agents)\/)?skills\/([\w-]+)\/SKILL\.md/g,
    (_match, name: string) => `the ${CE_PREFIX} knowledge:${name} knowledge entry`,
  )

  // 8. Claude Code tool rewrites
  // **AskUserQuestion tool** (bold markdown variant — match first, more specific)
  result = result.replace(
    /\*\*(?:Use the |the )?AskUserQuestion(?: tool)?\*\*/gi,
    "**Ask the user**",
  )
  // AskUserQuestion (plain text)
  result = result.replace(
    /(?:Use the |the )?AskUserQuestion(?: tool)?/gi,
    "Ask the user",
  )
  // EnterPlanMode / ExitPlanMode — remove the reference, not the full line
  result = result.replace(
    /\s*(?:Use )?(?:the )?(?:EnterPlanMode|ExitPlanMode)(?: tool)?/gi,
    "",
  )
  // $ARGUMENTS / #$ARGUMENTS → "the user-provided input"
  result = result.replace(
    /#?\$ARGUMENTS/g,
    "the user-provided input",
  )
  // Desktop shell commands: xdg-open <file> → present to user
  // Only match actual file paths (start with . / ~ or contain a .) — not URLs, adjectives, or CLI subcommands
  result = result.replace(
    /\bxdg-open ([\w./~\-]+)/g,
    "present $1 to the user",
  )
  // "Run `open <path>`" — only when in backtick command context with a local path
  result = result.replace(
    /Run `open ([./~][\w./\-]+)`[^`\n]*/g,
    "present $1 to the user",
  )
  // Standalone `open <local-path>` on its own (starts with . / ~, not http/https/agent-browser context)
  // Must be preceded by start-of-line or whitespace, and path must start with . / or ~
  result = result.replace(
    /(?<=^|\s)`?open ([./~][\w./\-]+)`?(?:\s+(?:in|to|on|with)[^\n]*)?/gm,
    "present $1 to the user",
  )
  // review <filepath> as shell command → present file to user
  result = result.replace(
    /(?<=→\s*)(?:Run )?`?review (docs\/[\w./\-<>]+)`?/g,
    "present `$1` to the user for review",
  )
  // Claude Code-specific concepts — strip entire lines with no Devin equivalent
  result = result.replace(
    /^.*?(?:Begin implementing in Claude Code on the web|use `&` to run in background|LFG\/SLFG|ultrathink|disable-model-invocation|on remote.*?&|start work in background for Claude Code).*$/gim,
    "",
  )

  // Claude Code platform hints — strip inline hints like "(e.g., Ask the user in Claude Code, ...)"
  result = result.replace(
    /\([^)]*(?:in Claude Code|Claude Code web|request_user_input in Codex|ask_user in Gemini)[^)]*\)/gi,
    "",
  )
  // Standalone "in Claude Code" / "for Claude Code" fragments
  result = result.replace(
    /\b(?:in|for|on|with) Claude Code(?:'s)?(?:\s+(?:web|app|desktop|platform|extension))?/gi,
    "",
  )

  // compound-engineering:category:name prose references → [CE] agent:name
  // Matches: "compound-engineering:workflow:pr-comment-resolver", "compound-engineering:research:best-practices-researcher"
  result = result.replace(
    /compound-engineering:[a-z][a-z0-9-]*:([a-z][a-z0-9-]+)/gi,
    (_match, name: string) => `[CE] agent:${normalizeName(name)}`,
  )

  // ~/.claude/ and .claude/ directory references — remove (no equivalent in Devin)
  result = result.replace(
    /~?\/?(?:\.claude)\/[\w./\-]*/g,
    "",
  )

  // Claude Code environment variables — strip entire lines containing them
  result = result.replace(
    /^.*?CLAUDE_CODE_(?:TEAM|AGENT|SESSION|TASK)[_A-Z]*.*$/gim,
    "",
  )

  // Claude Code tool references in prose: TaskCreate, TaskList, TaskGet, TaskUpdate, Teammate
  result = result.replace(
    /\b(?:TaskCreate|TaskList|TaskGet|TaskUpdate|TeammateTool|Teammate)\b/g,
    "",
  )
  // Circular AGENTS.md fallback: "If AGENTS.md is absent, fall back to AGENTS.md" → remove
  result = result.replace(
    /If AGENTS\.md is absent[^.\n]*fall back to AGENTS\.md[^.\n]*/gi,
    "If AGENTS.md is absent, fall back to the project README",
  )
  // Skill tool → "the knowledge entry"
  result = result.replace(
    /(?:the )?Skill tool/gi,
    "the knowledge entry",
  )
  // TodoWrite tool → "Track progress"
  result = result.replace(
    /(?:Use the |the )?TodoWrite(?: tool)?/gi,
    "Track progress",
  )

  // 9. Playbook cross-references (LAST — consumes "the X playbook" text from earlier transforms)
  // Dispatch rules:
  //   - knowledge entries → "the [CE] knowledge:X knowledge entry"
  //   - workflow/command playbooks with macro → Run `!macro` (inline invocation)
  //   - agent playbooks (no macro) → propose_sessions child session
  if (playbookRefMap) {
    // 9a. Handle "the X playbook with args: Y" pattern (from backtick-wrapped slash commands)
    result = result.replace(
      /the ([\.\w-]+) playbook with args: ([^\n]+)/gi,
      (_match, name: string, args: string) => {
        const ref = playbookRefMap[name.toLowerCase()]
        if (!ref) return _match
        if (ref.macro) return `Run \`!${ref.macro}\` with: ${args.trim()}`
        return `Use propose_sessions to start a child session with the ${ref.title} playbook, passing: ${args.trim()}`
      },
    )
    // 9b. General "[Run/Use propose_sessions] the X playbook [with: args]" pattern
    result = result.replace(
      /(?:(Run|Use propose_sessions to start a child session with) )?the ([\.\w-]+) playbook(?: with: (.+))?/gi,
      (_match, run: string | undefined, name: string, args: string | undefined) => {
        const ref = playbookRefMap[name.toLowerCase()]
        if (!ref) return _match // preserve original text for unknown names
        if (ref.category === "knowledge") {
          return `the ${ref.title} knowledge entry`
        }
        if (ref.macro) {
          // Workflow/command: use inline macro invocation
          if (args) return `Run \`!${ref.macro}\` with: ${args}`
          return `Run \`!${ref.macro}\``
        }
        // Agent (no macro): use propose_sessions
        if (run || args) {
          return `Use propose_sessions to start a child session with the ${ref.title} playbook${args ? `, passing: ${args}` : ""}`
        }
        return `the ${ref.title} playbook`
      },
    )
  }

  // 10. Clean up artifacts from substitution chains
  result = result.replace(/\bthe the\b/gi, "the")
  // "run Run `!macro`" → "Run `!macro`" (GATE text 'run' + step 9 'Run')
  result = result.replace(/\brun (Run `!)/gi, "$1")

  // 11. Fix verb mismatches around knowledge entries
  // "Run `the [CE] knowledge:X knowledge entry`" → "Refer to the [CE] knowledge:X knowledge entry"
  result = result.replace(
    /\bRun `(the \[CE\] knowledge:[\w-]+ knowledge entry)`/g,
    "Refer to $1",
  )
  // "Call the [CE] knowledge:X knowledge entry command" → "Refer to the [CE] knowledge:X knowledge entry"
  result = result.replace(
    /\bCall (the \[CE\] knowledge:[\w-]+ knowledge entry)(?: command)?/g,
    "Refer to $1",
  )
  // "Run `present <path> to the user`" (garble from open→present rewrite inside backticks)
  result = result.replace(
    /\bRun `present ([\w./\-<>]+) to the user`/g,
    "present $1 to the user",
  )

  return result
}

export function formatPlaybook(title: string, sections: DevinPlaybookSections): string {
  const lines: string[] = [`# ${title}`, ""]

  lines.push("## Overview", "", sections.overview, "")

  lines.push("## Procedure", "", sections.procedure, "")

  if (sections.specifications) {
    lines.push("## Specifications", "", sections.specifications, "")
  }

  if (sections.advice) {
    lines.push("## Advice", "", sections.advice, "")
  }

  if (sections.forbiddenActions) {
    lines.push("## Forbidden Actions", "", sections.forbiddenActions, "")
  }

  if (sections.neededFromUser) {
    lines.push("## What's Needed From User", "", sections.neededFromUser, "")
  }

  return lines.join("\n").trimEnd()
}

function normalizeName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "item"
  const normalized = trimmed
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[:\s]+/g, "-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || "item"
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let index = 2
  while (used.has(`${base}-${index}`)) {
    index += 1
  }
  const name = `${base}-${index}`
  used.add(name)
  return name
}
