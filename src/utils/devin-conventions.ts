/** Prefix for all Compound Engineering entries in Devin */
export const CE_PREFIX = "[CE]"

/** Build a Devin title like "[CE] agent:security-sentinel" */
export function toDevinTitle(name: string, category: string): string {
  return `${CE_PREFIX} ${category}:${name}`
}

/** Convert a hyphenated name to Devin macro format: "deepen-plan" → "deepen_plan" */
export function toMacroName(name: string): string {
  return name.replace(/-/g, "_")
}
