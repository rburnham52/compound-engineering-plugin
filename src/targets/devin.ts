import path from "path"
import { ensureDir, writeJson, writeText } from "../utils/files"
import type { DevinBundle } from "../types/devin"

export async function writeDevinBundle(outputRoot: string, bundle: DevinBundle): Promise<void> {
  const paths = resolveDevinPaths(outputRoot)
  await ensureDir(paths.devinDir)

  // Write playbooks by category
  if (bundle.playbooks.length > 0) {
    for (const playbook of bundle.playbooks) {
      const categoryDir = path.join(paths.playbooksDir, playbook.category === "workflow" ? "workflows" : playbook.category === "agent" ? "agents" : "commands")
      await writeText(path.join(categoryDir, `${playbook.name}.devin.md`), playbook.content + "\n")
    }
  }

  // Write knowledge entries as JSON
  if (bundle.knowledgeEntries.length > 0) {
    for (const entry of bundle.knowledgeEntries) {
      await writeJson(path.join(paths.knowledgeDir, `${entry.name}.json`), {
        title: entry.title,
        body: entry.body,
        trigger_description: entry.triggerDescription,
      })
    }
  }

  // Write MCP setup instructions
  if (bundle.mcpSetupInstructions) {
    await writeText(path.join(paths.devinDir, "mcp-setup-instructions.md"), bundle.mcpSetupInstructions + "\n")
  }
}

function resolveDevinPaths(outputRoot: string) {
  const base = path.basename(outputRoot)
  // If already pointing at .devin, write directly into it
  if (base === ".devin") {
    return {
      devinDir: outputRoot,
      playbooksDir: path.join(outputRoot, "playbooks"),
      knowledgeDir: path.join(outputRoot, "knowledge"),
    }
  }
  // Otherwise nest under .devin
  return {
    devinDir: path.join(outputRoot, ".devin"),
    playbooksDir: path.join(outputRoot, ".devin", "playbooks"),
    knowledgeDir: path.join(outputRoot, ".devin", "knowledge"),
  }
}
