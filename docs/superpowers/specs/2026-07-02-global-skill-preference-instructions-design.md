# Auto-write global skill-preference instructions on `jolli enable` (cross-host)

**Date:** 2026-07-02
**Status:** Design — awaiting review

## Problem

`jolli enable` already installs the `jolli-pr`, `jolli-search`, and `jolli-recall`
skills into every worktree (`SkillInstaller`, into `.claude/skills/` and
`.agents/skills/`). But an installed skill is only *available* — whether a host
LLM actually reaches for it when the user says "create a PR" / "search for…" /
"recall…" is left to the model's own judgment. Users want Jolli's skills to be
the **default** choice for those three actions, not a coin-flip.

Expressing "prefer these skills by default" is a standing instruction, and Jolli
writes no instruction file today.

## Goal

On `jolli enable`, automatically write a standing rule — into each detected
host's **global** instruction file — telling the agent to prefer the three Jolli
skills by default for their respective actions.

Non-goals:
- No manual CLI entry point (`--sync-instructions` etc.) — enable-time only.
- No project-root instruction files — global home-dir files only.
- No IntelliJ equivalent in this iteration.

## Decisions (locked with user)

| Question | Decision |
|----------|----------|
| Where does the rule live? | **Global home-dir instruction files** — one write per host, applies to all of the user's projects. |
| Which hosts? | **Cross-host**: Claude (`~/.claude/CLAUDE.md`), Gemini (`~/.gemini/GEMINI.md`), Codex (`~/.codex/AGENTS.md`). |
| Uninstall behavior? | **Keep the block.** A single-repo `jolli uninstall` must not delete a machine-global rule other repos rely on — mirrors the MCP global-scope policy (`removeRepoMcpHosts` deliberately leaves global entries). |
| Block content language? | **English** — repo is going open-source; all SKILL.md / comments are English. |
| Manual refresh/clear entry point? | **No** (YAGNI) — enable-time auto-write only. |

### Accepted limitation

A **global** `AGENTS.md` is only read by Codex (`~/.codex/AGENTS.md`).
Cursor / OpenCode / Copilot read `AGENTS.md` at the *project root*, not from the
home dir, so they are **not** covered by this iteration. Effective cross-host
reach = Claude + Gemini + Codex. (Full AGENTS-standard reach would require
project-root files, which the user declined.)

## Open verification item (planning phase)

Per `integrating-external-systems`: the exact global instruction-file path for
each host must be confirmed against the real tool before implementation — a
wrong path is a silent no-op. Highest-risk item: whether Codex's global merge
file is `~/.codex/AGENTS.md` or the historical `~/.codex/instructions.md`.
`~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md` are the documented conventions
but should be spot-confirmed too.

## Design

### New module: `cli/src/install/GlobalInstructionsInstaller.ts`

Mirrors [`GitExclude.ts`](../../../cli/src/install/GitExclude.ts) — same
managed-block upsert shape, same fail-soft posture, same pure-function core for
unit testing. Differences: targets are per-host global markdown files, markers
are Markdown HTML comments, and the module iterates over a target list.

**Targets.**

```ts
interface InstructionTarget {
    readonly host: "claude" | "gemini" | "codex";
    readonly path: string; // absolute, under homedir()
}
```

Resolved from `homedir()`:
- `claude` → `~/.claude/CLAUDE.md`
- `gemini` → `~/.gemini/GEMINI.md`
- `codex`  → `~/.codex/AGENTS.md` (pending verification above)

The **same** host-agnostic block is written to every target (the rules name the
skills, which exist under the same names on all hosts).

**Marker block** (identical text per target):

```
<!-- >>> jolli memory instructions >>> -->
## Jolli Memory

When Jolli Memory is enabled in a repository, prefer its skills by default:

- **Creating a pull request** → use the `jolli-pr` skill (its description comes
  from Jolli Memory's recorded commit history), unless the user explicitly asks
  for another method.
- **Searching prior work, decisions, or related commits** → use the
  `jolli-search` skill.
- **Recalling or resuming prior context on a branch** → use the `jolli-recall`
  skill.

If a skill is not available (Jolli Memory is not enabled in that repository),
fall back to normal behavior.
<!-- <<< jolli memory instructions <<< -->
```

**Upsert algorithm** (per target, identical strategy to `GitExclude.applyBlock`):
- Read existing file (`""` on ENOENT).
- Line-oriented scan for the **exact** marker lines (substring matches elsewhere
  in the file are ignored). If both markers present and ordered, replace the
  lines between them; otherwise append the block (with a `\n` separator when the
  file doesn't already end in one; the block alone if the file was empty).
- If `updated === existing`, skip the write (idempotent — no mtime churn, no
  version marker needed; changed rule text differs by content and rewrites).
- `mkdir(dirname, { recursive: true })` then `writeFile`.

**Failure posture.** Never throws. Any read/write error on a target is logged via
`createLogger("GlobalInstructionsInstaller")` and skipped; other targets still
proceed. A broken or read-only global file must not break `jolli enable`. (Same
contract as `updateGitExclude`.)

**Exported surface.**
- `installGlobalInstructions(hosts: { claude: boolean; gemini: boolean; codex: boolean }): Promise<void>`
  — writes each target whose host flag is `true`.
- `applyInstructionsBlock(existing: string, block: string): string` — pure,
  exported for unit tests (mirrors `applyBlock`).
- `renderInstructionsBlock(): string` — pure, returns the marker-wrapped block.

### Integration in `Installer.ts`

Call **once**, outside the per-worktree loop (all targets are global — same
placement rationale as `registerGlobalMcpHosts`), passing per-host enable/detect
flags that `install()` already computes:

```ts
await installGlobalInstructions({
    claude: config.claudeEnabled !== false,
    gemini: geminiDetectedOnce && config.geminiEnabled !== false,
    codex: codexDetectedOnce && config.codexEnabled !== false,
});
```

Per-host gating rationale: each global file is host-specific; writing
`~/.codex/AGENTS.md` on a machine without Codex would create a spurious file.
This mirrors the existing detection gating for the Codex/Gemini hooks.

`uninstall()` is **not** modified — the blocks are intentionally left in place.

### Testing (`GlobalInstructionsInstaller.test.ts`)

CLI enforces 97% coverage, so the new module needs full coverage:

- `renderInstructionsBlock` contains all three skill names and both markers.
- `applyInstructionsBlock`:
  - empty input → block alone.
  - user content, no markers → block appended, user content preserved, exactly
    one separating newline (no double newline when input already ends in `\n`).
  - existing block → content between markers replaced, surrounding content
    untouched.
  - running twice → no-op (second call returns input unchanged).
  - stray marker-like substring in prose → not treated as a marker (exact-line).
- `installGlobalInstructions` against a temp `HOME`:
  - all hosts enabled → three files created with the block, parent dirs created.
  - a host disabled → its file is **not** created.
  - idempotent second run → no content change.
  - one target read/write error → returns without throwing, other targets still
    written (fail-soft); defensive-only branches marked `/* v8 ignore */` per
    GitExclude precedent.

## Files touched

- **New:** `cli/src/install/GlobalInstructionsInstaller.ts`
- **New:** `cli/src/install/GlobalInstructionsInstaller.test.ts`
- **Edit:** `cli/src/install/Installer.ts` — one guarded call in `install()`.

## Intentionally unchanged

- `uninstall()` — global blocks preserved by design.
- Project-root instruction files — out of scope (global home-dir only).
- Cursor / OpenCode / Copilot — not reachable via a global `AGENTS.md`; out of
  scope this iteration (see Accepted limitation).
- IntelliJ plugin — out of scope.
- `SkillInstaller.ts` — skills already install; this feature is orthogonal.
- VS Code extension — calls the same bundled `install()`, so it inherits the
  behavior automatically; no extension-side change needed.
