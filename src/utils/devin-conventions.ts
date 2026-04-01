/** Prefix for all Compound Engineering entries in Devin */
export const CE_PREFIX = "[CE]"

/** Build a Devin title like "[CE] agent:security-sentinel" */
export function toDevinTitle(name: string, category: string): string {
  return `${CE_PREFIX} ${category}:${name}`
}

/** Convert a name to Devin macro format (hyphens only — both playbooks and knowledge use hyphens) */
export function toMacroName(name: string): string {
  return name
}

/** Convert a name to a CE-prefixed knowledge macro: "deepen-plan" → "ce-deepen-plan" */
export function toKnowledgeMacroName(name: string): string {
  return `ce-${name}`
}
