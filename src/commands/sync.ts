import { defineCommand } from "citty"
import path from "path"
import type { DevinClient } from "../types/devin"
import { loadClaudeHome } from "../parsers/claude-home"
import {
  getDefaultSyncRegistryContext,
  getSyncTarget,
  isSyncTargetName,
  syncTargetNames,
  type SyncTargetName,
} from "../sync/registry"
import { expandHome } from "../utils/resolve-home"
import { hasPotentialSecrets } from "../utils/secrets"
import { detectInstalledTools } from "../utils/detect-tools"

const validTargets = [...syncTargetNames, "all", "devin"] as const
type SyncTarget = SyncTargetName | "all" | "devin"

function isValidTarget(value: string): value is SyncTarget {
  return value === "all" || value === "devin" || isSyncTargetName(value)
}

export default defineCommand({
  meta: {
    name: "sync",
    description: "Sync Claude Code config (~/.claude/) to supported provider configs and skills, or Devin",
  },
  args: {
    target: {
      type: "string",
      default: "all",
      description: `Target: ${syncTargetNames.join(" | ")} | devin | all (default: all)`,
    },
    claudeHome: {
      type: "string",
      alias: "claude-home",
      description: "Path to Claude home (default: ~/.claude)",
    },
    // Devin-specific args
    apiKey: {
      type: "string",
      alias: "api-key",
      description: "Devin API key (or DEVIN_API_KEY env var)",
    },
    dryRun: {
      type: "boolean",
      alias: "dry-run",
      default: false,
      description: "Preview changes without executing (devin only)",
    },
    dir: {
      type: "string",
      default: ".devin",
      description: "Path to .devin/ directory (devin only)",
    },
    noDelete: {
      type: "boolean",
      alias: "no-delete",
      default: false,
      description: "Skip orphan deletion (devin only)",
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Auto-confirm deletions (devin only)",
    },
    only: {
      type: "string",
      description: "Sync specific entries, comma-separated (devin only)",
    },
    uninstall: {
      type: "boolean",
      default: false,
      description: "Remove all [CE] entries from Devin (devin only)",
    },
    orgId: {
      type: "string",
      alias: "org-id",
      description: "Devin organization ID (or DEVIN_ORG_ID env var, devin only)",
    },
  },
  async run({ args }) {
    if (!isValidTarget(args.target)) {
      throw new Error(`Unknown target: ${args.target}. Use one of: ${validTargets.join(", ")}`)
    }

    // Devin sync is API-based, not filesystem-based — route separately
    if (args.target === "devin") {
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
      const resolvedDir = path.resolve(args.dir)
      if (!resolvedDir.startsWith(process.cwd())) {
        throw new Error("--dir must be within the project directory")
      }
      if (args.uninstall) {
        const { uninstallFromDevin } = await import("../sync/devin")
        await uninstallFromDevin(client, { dryRun: args.dryRun, autoConfirm: args.yes })
        return
      }
      const { syncToDevin } = await import("../sync/devin")
      await syncToDevin(resolvedDir, client, {
        dryRun: args.dryRun,
        dir: resolvedDir,
        noDelete: args.noDelete,
        autoConfirm: args.yes,
        only: args.only ? args.only.split(",").map((s: string) => s.trim()) : [],
      })
      return
    }

    const { home, cwd } = getDefaultSyncRegistryContext()
    const claudeHome = expandHome(args.claudeHome ?? path.join(home, ".claude"))
    const config = await loadClaudeHome(claudeHome)

    // Warn about potential secrets in MCP env vars
    if (hasPotentialSecrets(config.mcpServers)) {
      console.warn(
        "⚠️  Warning: MCP servers contain env vars that may include secrets (API keys, tokens).\n" +
        "   These will be copied to the target config. Review before sharing the config file.",
      )
    }

    if (args.target === "all") {
      const detected = await detectInstalledTools()
      const activeTargets = detected.filter((t) => t.detected).map((t) => t.name)

      if (activeTargets.length === 0) {
        console.log("No AI coding tools detected.")
        return
      }

      console.log(`Syncing to ${activeTargets.length} detected tool(s)...`)
      for (const tool of detected) {
        console.log(`  ${tool.detected ? "✓" : "✗"} ${tool.name} — ${tool.reason}`)
      }

      for (const name of activeTargets) {
        const target = getSyncTarget(name as SyncTargetName)
        const outputRoot = target.resolveOutputRoot(home, cwd)
        await target.sync(config, outputRoot)
        console.log(`✓ Synced to ${name}: ${outputRoot}`)
      }
      return
    }

    console.log(
      `Syncing ${config.skills.length} skills, ${config.commands?.length ?? 0} commands, ${Object.keys(config.mcpServers).length} MCP servers...`,
    )

    const target = getSyncTarget(args.target as SyncTargetName)
    const outputRoot = target.resolveOutputRoot(home, cwd)
    await target.sync(config, outputRoot)
    console.log(`✓ Synced to ${args.target}: ${outputRoot}`)
  },
})
