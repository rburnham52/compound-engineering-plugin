# Converter Exclusion: `exclude-from` Frontmatter Field

**Date:** 2026-04-01
**Status:** Ready for planning

## What We're Building

A mechanism for plugin authors to mark individual skills or agents as excluded from specific conversion targets, using an `exclude-from` frontmatter field. The converter skips excluded entries; the sync command treats absence as deletion (removing previously-synced entries from the target platform).

## Why This Approach

The `orchestrating-swarms` skill (and `claude-permissions-optimizer`) are deeply Claude Code-specific — they document Claude Code internals (TeammateTool, spawn backends, iTerm2 setup, session history analysis). Converting them produces noisy, misleading output. The right answer is to not include them at all rather than attempt best-effort cleanup.

A blocklist frontmatter field (`exclude-from`) fits the existing pattern: skills already use frontmatter for `disable-model-invocation`, `model`, `argument-hint`, etc. It's co-located with the content, version-controlled, and requires no separate config file.

## Key Decisions

- **Frontmatter field:** `exclude-from: [devin]` or `exclude-from: [devin, codex]`
- **Default behaviour:** Skills work everywhere unless explicitly excluded (opt-out, not opt-in)
- **Sync behaviour:** Excluded entries are absent from converter output → sync treats absence as deletion if previously synced (this already works via the title-based diff in `sync`)
- **Scope:** Applies to skills, agents, and commands equally
- **No config file:** Per-file frontmatter only; no `.converter-ignore` at this stage (YAGNI)

## Implementation Scope

1. **Parser** — `ClaudeSkill`, `ClaudeAgent`, `ClaudeCommand` types get optional `excludeFrom?: string[]` field. Parser reads `exclude-from` frontmatter array.
2. **Converters** — Each converter filters its input lists before processing: `plugin.skills.filter(s => !s.excludeFrom?.includes("devin"))`. Should be applied in the main `convertClaudeToDevin` function, not in each individual converter helper.
3. **Immediate use** — Add `exclude-from: [devin]` to `orchestrating-swarms/SKILL.md` and `claude-permissions-optimizer/SKILL.md` frontmatter.
4. **Tests** — Unit test that excluded skills are absent from converter output.

## Out of Scope

- `platforms` allowlist (we chose blocklist; this can be added later)
- CLI `--exclude` flag (YAGNI; frontmatter is sufficient)
- Bulk config file / glob patterns

## Open Questions

_None — all resolved._

## Resolved Questions

- **Why not `platforms: [claude-code]` allowlist?** Blocklist is simpler: skills work everywhere by default, author only opts out of specific targets. Allowlist requires updating every new target manually.
- **Does sync delete excluded entries?** Yes — sync already diffs by title. Excluded entries are absent from convert output, so if previously synced they appear as deletions. No extra sync logic needed.
- **Is this Devin-specific?** No — `exclude-from` works for any target (devin, codex, gemini, etc.) since the filter is applied per-converter.
