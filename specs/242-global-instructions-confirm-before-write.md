# 242 — Global-Instructions Tri-State Switch

## Topic Statement

A tri-state, machine-global switch gates whether the skill-preference block is written to each host's global instruction file. The block is **never** written on the user's behalf: it is written only after the user explicitly opts in, through one of a small set of explicit opt-in surfaces (the CLI configure command, the VS Code Settings toggle, and the IntelliJ Settings → AI Agents checkbox). The install/enable path merely *applies* whatever decision is already persisted — it never prompts and never persists a decision itself.

## Scope

**In scope.** The tri-state config field (`globalInstructions`) and its persisted values; the pure decision resolver that maps the persisted value → write / remove / do-nothing (it takes no callback and persists nothing); the shared sync operation that both applies the decision and provides host gating; the opt-in surfaces that set the switch (the VS Code Settings toggle, `jolli configure --set globalInstructions=…`, and the IntelliJ Settings → AI Agents checkbox); the benefit-led help/label copy; the settings checkbox ↔ tri-state mapping and its transition-triggered sync.

**Out of scope.** The block content, marker strings, target files, upsert/removal mechanics, and host gating rules — all spec 241. The rest of the install sequence — spec 44. The `jolli enable` command output — spec 57. The `jolli configure` command's key set, coercion, and validation — spec 62.

## Data Contracts

### Tri-state switch

A single persisted configuration field, `globalInstructions`, with three states:

- **enabled** — the block should be written.
- **disabled** — the block should not be written, and any previously-written block should be actively removed.
- **undecided** — the field is absent (unset). The default for a fresh install. Distinct from `disabled`: undecided leaves the block untouched (never writes, never removes), because the block was never written on the user's behalf and there is nothing to undo.

The field is stored in the machine-global configuration. The only valid explicit values are `enabled` and `disabled`; the CLI `configure` command validates against exactly that pair (spec 62). Absence is undecided.

### Shared help/label copy

A single benefit-led message string is the source of truth for the switch's user-facing description, so the wording never drifts. It is rendered as the VS Code Settings "Global Instructions" toggle helptext (the only surface that displays prose for this switch):

> Let your AI assistants use Jolli's memory automatically? This adds a small skill-preference block to your global instruction files (~/.claude/CLAUDE.md, ~/.gemini/GEMINI.md, ~/.codex/AGENTS.md) so your AI reaches for Jolli when you search past decisions or recall a branch's history — no need to ask each time.

The copy names only the two capabilities the block itself describes (search and recall). It carries no pull-request clause: PR authoring no longer routes through a skill the block could prefer (spec 211).

The VS Code extension imports this constant from the CLI (bundled at build time), so the wording lives next to the block it describes.

## Behavior

### Decision resolver (pure, single input)

The core resolver is a pure function of the persisted switch value alone. It takes **no** confirm callback and **never** persists anything — it only reports what should happen to the block:

| Persisted value | Outcome |
|-----------------|---------|
| `enabled` | write the block |
| `disabled` | do not write; **remove** any existing block |
| undecided (absent) | do nothing (neither write nor remove) |

Notes that fall out of the table:

- **`disabled` heals a stale block.** A user who previously ran while enabled and then switched to disabled has the leftover block removed on the next sync.
- **Undecided never removes.** The block was never written on the user's behalf, so there is nothing to undo. This is what makes undecided a genuine third state rather than "disabled by default."

### Shared sync operation

A single sync operation is the one place the block write/remove is triggered outside of a fresh full install. It:

1. Reads the current switch value from global config.
2. Runs the decision resolver.
3. If the decision says **write** → invokes the block writer (spec 241) with host gating: Claude is gated only on `claudeEnabled !== false` (no filesystem detector — its global file is written whenever Claude isn't explicitly disabled); Gemini and Codex are gated on both their install-detection AND their respective enabled flags (`geminiEnabled` / `codexEnabled` not `false`).
4. Else if the decision says **remove** → invokes the ungated block remover (spec 241), which erases the block from every host's file regardless of gating (a user who opts out must have it erased everywhere it might have been written).
5. On undecided → does nothing.

The sync accepts pre-computed host detection so the full install can pass detectors it already ran rather than re-running them; the other callers let it run detection itself.

**This operation never prompts and never persists the switch** — persistence is the responsibility of the two opt-in surfaces below, each of which persists first and then calls the sync.

### Opt-in surface 1 — `jolli configure --set globalInstructions=…`

Setting the switch via `jolli configure` persists the value and then **applies the change synchronously, before the command prints its "Config updated" line** (see spec 62 for the surrounding command behavior):

- `--set globalInstructions=enabled` → persists `enabled`, then writes the block into every detected/enabled host's global instruction file immediately.
- `--set globalInstructions=disabled` → persists `disabled`, then removes any existing block immediately.
- `--remove globalInstructions` → clears the field back to undecided. The sync still runs, but the resolver's undecided branch makes it a no-op (nothing written, nothing removed).

This is the CLI-side opt-in surface. The block is written only because the user explicitly set it here — never on a bare `jolli enable`.

### Opt-in surface 2 — VS Code Settings toggle

The settings panel renders the switch as a **binary checkbox** mapped to/from the tri-state:

- **Initial (tri-state → checkbox):** checked only when the switch is explicitly `enabled`. Both `undecided` and `disabled` render **unchecked**.
- **On save (checkbox → tri-state update), comparing the incoming checkbox against the value currently persisted on disk:**
  - checkbox **on** → set `enabled`.
  - checkbox **off** AND current persisted value was `enabled` → set `disabled`.
  - checkbox **off** AND current value was already undecided (or already disabled) → **omit the field entirely** from the update (do not write `disabled`, and do not write `undefined` — which the top-level merge would treat as a delete). Writing `disabled` here would clobber an undecided switch into a hard disabled, permanently converting a user who simply never touched this toggle into an opt-out.
- **After persisting**, the shared sync runs **only on an actual transition** — either enabling (checkbox on while the persisted value was not already `enabled`) or disabling (checkbox off while the persisted value was `enabled`). This is what turns a settings-panel *off* into an on-disk block *removal*, and a settings-panel *on* into a block *write*. No transition → the sync is skipped (so a settings save that never touched this toggle does no block I/O).

### Opt-in surface 3 — IntelliJ Settings → AI Agents checkbox

The IntelliJ plugin renders the switch as a binary checkbox on its Agents settings tab, mapped to/from the tri-state with the same rules as the VS Code toggle: checked only when the persisted value is explicitly `enabled`; on save, checkbox-on → persists `enabled`, checkbox-off → persists `disabled` only when the persisted value was `enabled`, checkbox-off while undecided/disabled persists nothing. A fresh decision is persisted before the block I/O.

One divergence from VS Code: after saving, IntelliJ runs the shared apply-only sync **unconditionally** (not only on a transition) — since the sync applies whatever is persisted idempotently (write on enabled, remove on disabled, no-op on undecided), the observable effect matches; it simply re-asserts the persisted decision on every settings save.

### Install / enable path (applies only)

The full install path and `jolli enable` call the shared sync with pre-computed host detection. Because the sync only applies the persisted decision:

- On a **fresh install** the switch is undecided → the sync is a no-op. The block is not written, and nothing is persisted. Enable never prompts for this.
- If the switch is already `enabled` (the user opted in earlier), the block is re-written idempotently on each enable.
- If the switch is `disabled`, any stale block is healed (removed) on each enable.

This runs in integrations-only mode too, since the block is an integration (skill preference), not a hook.

## State Transitions

- **undecided → enabled**: `jolli configure --set globalInstructions=enabled`, or the settings checkbox turned on. Persisted; block written on the same run.
- **enabled → disabled**: `jolli configure --set globalInstructions=disabled`, or the settings checkbox turned off (from a persisted `enabled`). Persisted; block removed.
- **disabled → enabled**: `configure --set …=enabled` or settings checkbox on. Persisted; block written.
- **any → undecided**: `jolli configure --remove globalInstructions`. Persisted absent; the sync it triggers is a no-op.
- **undecided → undecided**: any `jolli enable` / full install on a switch the user has never set; a settings save whose checkbox stayed off while the value was already undecided/disabled. Nothing persisted for this field, nothing written.

## Notable Behavior

- **There is no confirm prompt and no activation notification.** Earlier revisions of this feature showed a CLI `[Y/n]` confirm during `jolli enable` and a VS Code activation notification (Add / Not now / Never, with a session-dismiss flag). Both mechanisms have been removed. The switch is set only through the two explicit opt-in surfaces above; `jolli enable` and extension activation never surface a prompt for it.
- **The decision resolver is a pure single-input function.** It cannot itself change the persisted switch and cannot ask the user anything — separating "what should happen" (resolver) from "record the user's intent" (the two opt-in surfaces).
- **`configure --set` on this one key has an immediate side effect beyond writing `config.json`.** Unlike other config keys, setting `globalInstructions` writes to or removes from files outside the config directory (each host's global instruction file) as part of the same command, before the success line prints.
- **The checkbox-off-while-undecided omission** is the subtle rule that keeps a VS Code settings visit from accidentally converting an undecided switch into a hard opt-out.
- **IntelliJ applies this block through a native, Node-free implementation** (unlike the IntelliJ MCP/skill integrations, which shell out to the bundled CLI and require Node) — the block is upserted/removed by native IDE-plugin code on its own install/enable path and on settings save, with the confirm callback omitted so the install/enable path only applies the persisted decision and never prompts. The byte-for-byte block content, markers, target files, and host gating are identical to the CLI so a co-managed file never flip-flops.

## Shared Behavior

- The block itself — its markers, content, target files, and host-gating rules — is spec 241. This spec governs only *whether* the block write/remove fires and from which surface.
- The benefit-led copy constant is imported by the VS Code extension from the CLI (bundled at build time), so both packages render identical wording.
- The `globalInstructions` config key's coercion and validation (enabled/disabled only) live in spec 62; its place in the install step order is spec 44.
