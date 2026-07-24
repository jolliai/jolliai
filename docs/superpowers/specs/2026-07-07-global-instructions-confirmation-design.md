# Confirm before writing global skill instructions — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorming), pending spec review

## Problem

`installGlobalInstructions()` ([GlobalInstructionsInstaller.ts](../../../cli/src/install/GlobalInstructionsInstaller.ts))
writes a Jolli "prefer these skills by default" managed block into **machine-global**
instruction files that users often hand-maintain:

- Claude Code → `~/.claude/CLAUDE.md`
- Gemini → `~/.gemini/GEMINI.md`
- Codex → `~/.codex/AGENTS.md`

Today it runs **unconditionally** inside `install()` ([Installer.ts:331](../../../cli/src/install/Installer.ts#L331)),
before the interactive `promptSetup()` step in `EnableCommand`. Every `jolli enable`
(and every VS Code auto-enable) silently touches these global files. Users want to be
asked before Jolli writes into their global AI instruction files.

## Goal

Do not write the global skill-instructions block until the user has explicitly
agreed, consistently across all surfaces (CLI, VS Code, IntelliJ). Remember the
decision so we only ask once per machine.

## Non-goals

- Removing an already-present block on refusal (refusal only stops future writes).
- Changing `uninstall` behavior (it still leaves the block in place, as today).
- Per-host confirmation (one combined decision covers all three host files).
- A dedicated IntelliJ confirmation UI (see Edge cases).

## Design

### 1. Data model — a persisted tri-state switch

Add one field to `JolliMemoryConfig` ([Types.ts](../../../cli/src/Types.ts)), stored in the
**global** config (`~/.jolli/jollimemory/config.json` via `getGlobalConfigDir()`), because
the target files are machine-global — one decision per machine:

```ts
globalInstructions?: "enabled" | "disabled"; // undefined = not yet decided
```

- `undefined` (undecided) — default; do **not** write.
- `"enabled"` — user agreed; write.
- `"disabled"` — user refused; never write.

### 2. `install()` core — read the switch + optional confirm callback

Replace the unconditional call at [Installer.ts:331](../../../cli/src/install/Installer.ts#L331)
with a gated step that reads the global switch:

- `enabled` → write (current `installGlobalInstructions(hosts)` logic unchanged).
- `disabled` → skip.
- `undecided`:
  - If the caller passed `confirmGlobalInstructions?: () => Promise<boolean>` (CLI
    interactive path only) → `await` it, persist the result to the global config as
    `"enabled"` / `"disabled"`, and write iff `true`.
  - Otherwise (VS Code / IntelliJ / `-y` / non-TTY — no callback) → skip, leaving the
    switch `undecided`.

Rationale: host-detection gating (claude/gemini/codex) already lives inside `install()`.
Keeping the write and its host gating as a single source of truth — and letting the
callback only *ask* — avoids duplicating that logic across callers.

`install()`'s options type gains the optional `confirmGlobalInstructions` callback. All
existing callers that omit it keep the safe default (skip when undecided).

### 3. CLI interactive path

Both the CLI prompt and the VS Code notification (§4) show the **same message body**.
It is defined once as a shared constant exported from `GlobalInstructionsInstaller`
(next to `renderInstructionsBlock`) and reused by both surfaces, so the wording can never
drift between them. Only the answer affordance differs — the CLI appends `[Y/n]`, VS Code
renders `[Add] [Not now] [Never]` buttons. The wording leads with the benefit — what the
user gains by saying yes — so the choice is motivated, not just a permission ask:

```
Let your AI assistants use Jolli's memory automatically? This adds a small
skill-preference block to your global instruction files (~/.claude/CLAUDE.md,
~/.gemini/GEMINI.md, ~/.codex/AGENTS.md) so your AI reaches for Jolli when you
create PRs, search past decisions, or recall a branch's history — no need to
ask each time.
```

In [EnableCommand.ts](../../../cli/src/commands/EnableCommand.ts), when
`isInteractive() && !options.yes`, pass a `confirmGlobalInstructions` callback that uses
the existing `promptText()` to show that shared message followed by `[Y/n]:`.

- Default answer: **Y** (Enter → write).
- The answer is persisted to the global config, so subsequent `jolli enable` runs never
  re-ask.
- `-y` / non-TTY → no callback passed → skip (stays undecided).

### 4. VS Code notification

On extension activation, when the project is enabled AND the global switch is
`undecided` AND it has not been dismissed **this session**, show an information
notification using the **same shared message body** as the CLI prompt (§3), with three
buttons:

> Let your AI assistants use Jolli's memory automatically? This adds a small
> skill-preference block to your global instruction files (`~/.claude/CLAUDE.md`,
> `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`) so your AI reaches for Jolli when you
> create PRs, search past decisions, or recall a branch's history — no need to ask
> each time.
> **[Add]** **[Not now]** **[Never]**

- **Add** → persist `"enabled"`, then idempotently re-run `install()` (which now reads
  `enabled` and writes).
- **Never** → persist `"disabled"`.
- **Not now / dismiss (X) / timeout** → leave `undecided`; set an in-memory
  session flag so this VS Code session does not re-prompt. A later VS Code restart may
  prompt once more.

The notification lives in the extension activation layer, not inside `install()` —
`enable()` / `autoInstallForWorktree()` ([JolliMemoryBridge.ts](../../../vscode/src/JolliMemoryBridge.ts))
stay non-interactive and simply skip the write while undecided.

## Edge cases & impact

- **IntelliJ** invokes `jolli enable --integrations-only` non-interactively → always
  skips the write (no confirmation surface). Consistent with the "don't write until
  confirmed" default; no dedicated IntelliJ UI in this change. IntelliJ users who also
  use the CLI or VS Code get the prompt there.
- **Existing users** whose block is already present with an `undecided` switch: the next
  `enable` no longer auto-refreshes that block until they confirm via CLI or the VS Code
  notification. Deliberate trade-off of "don't touch without asking." We never silently
  remove the existing block.
- **Refusal never deletes** an existing block — `"disabled"` only stops future writes.

## Testing

- CLI coverage floor is 97% statements / 96% branches / 97% functions / 97% lines.
- New `install()` branches (enabled / disabled / undecided × callback present/absent),
  the persistence of the callback result, and the global-config read/write path must be
  covered.
- CLI `EnableCommand` callback wiring (interactive vs `-y` / non-TTY) tested.
- VS Code notification logic (Add / Never / dismiss + session flag + idempotent re-run)
  tested.

## Unchanged

- `uninstall` still leaves the block in place.
- The managed-block upsert / adopt logic in `GlobalInstructionsInstaller` is untouched.
- The `parseJolliApiKey` three-implementation lockstep is unrelated to this change.
