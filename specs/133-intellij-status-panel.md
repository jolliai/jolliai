# IntelliJ STATUS Panel

## Topic Statement

The STATUS panel of the JolliMemory tool window — a single panel that, once a status snapshot exists, renders a row-list of one row per status field (hooks installed, active session count, stored memory count, optional Jolli site host, and one row per detected AI agent integration), each row carrying an icon (OK / WARN / ERROR / pulse / book / globe), a label, a gray description, and a multi-line tooltip; before a snapshot exists it shows a single "Initializing..." label; and it rebuilds itself from scratch on every project-status change.

## Scope

**In scope:**
- The two render states the panel rebuilds itself between: no-snapshot (single "Initializing..." label) and snapshot-present (status-row list).
- The enabled-mode rows: hooks, MCP & Skills, sessions, stored memories, optional Jolli site, and one optional row per detected agent (Claude, Codex, Gemini, OpenCode, Cursor, Copilot).
- The "MCP & Skills" row: a fixed row (always shown when a snapshot exists) inserted between the Hooks row and the Sessions row, with three states (OK "active", WARN "Node.js not found", WARN "setup incomplete") computed from the snapshot's Node-available and integrations-active booleans.
- The description-color-by-severity rule in the row renderer: WARN descriptions render amber, ERROR descriptions render red, everything else renders the normal gray; the clickable-link blue is applied only when the row carries no severity color.
- The four-state integration row rule (per detected agent: enabled-with-hook-OK, enabled-no-hook-needed-OK, enabled-with-hook-missing-WARN, disabled-WARN).
- The separate "scan unavailable" WARN rows the panel emits for OpenCode, Cursor, and Copilot when a scan error is reported.
- The hooks row's compact summary (`5 Git + 2 Claude + 1 Gemini` style) and the multi-line tooltip detailing each hook family.
- The "stored memories" row's `<branch-count> / <total-count>` rendering, where the branch count is computed by walking the current branch's not-in-main commits and intersecting with the summary index (commit aliases included).
- The Jolli site row that appears only when a Jolli API key is saved and parses successfully — showing the host stripped of `https://` / `http://`, with a tenant-mention tooltip.
- The icon set (`OK`, `ERROR`, `WARN`, `PULSE`, `BOOK`, `GLOBE`) and the white-tint behavior when a row is selected.
- Refresh triggers: the project's status listener fires after every install / uninstall / hook event; the panel re-renders on every fire.
- The double-click and hand-cursor affordances for rows that carry an `onClick` callback (the data model supports it; the implemented row set has no rows that supply one — but the affordance plumbing is part of the contract).

**Out of scope:**
- The disabled-vs-enabled presentation of the *tool window* — when the project is disabled the tool window swaps the whole STATUS panel in as a full-content card, and the enable call-to-action lives in the onboarding view and the Settings dialog, not in this panel (separate specs). This panel renders no "Enable Jolli Memory" button and no marketing copy.
- The full Settings dialog (separate spec), which owns the API-key / model / install toggle controls.
- The tool-window frame's view switch, breadcrumb, title-bar actions, and the full-pane Status toggle that shows / hides this panel (separate spec).
- The OAuth / sign-in flow (separate spec) — the STATUS panel surfaces no sign-in button or sign-in row.
- The plumbing that produces the status snapshot (which hooks are installed, session count, summary count, branch summaries, per-agent detection / scan-error fields) — owned by the install/status core.

## Data Contracts

### Two render states

| State          | Trigger              | Body                                                  |
| -------------- | -------------------- | ----------------------------------------------------- |
| No snapshot    | `status == null`     | A single "Initializing..." label.                     |
| Snapshot       | `status != null`     | Scrollable row-list (see Row set below).              |

The panel does **not** branch on `status.enabled`. Whenever a snapshot exists it builds the full row list; rows whose underlying state is "not installed" / `0` simply render in their not-installed / zero form.

### Enabled-mode row set

Every render with a snapshot rebuilds the list model from scratch in this fixed order:

| # | Label                | Icon   | Description                                                          | Tooltip lines |
| - | -------------------- | ------ | -------------------------------------------------------------------- | ------------- |
| 1 | `Hooks`              | OK if git hook installed; ERROR otherwise | `5 Git + 2 Claude + 1 Gemini` (only the parts whose hooks are installed are joined; if none, `none installed`) | Three lines: Git hooks status (post-commit, post-rewrite, prepare-commit-msg, post-merge, pre-push), Claude Code hooks (Stop, SessionStart), Gemini hook (AfterAgent). |
| 2 | `MCP & Skills`       | OK / WARN (see MCP row rule) | `active` / `Node.js not found` / `setup incomplete` | Explains what the MCP tools + `/jolli-recall` / `/jolli-search` skills are, or why they are unavailable (Node missing vs setup incomplete), always noting memory generation is unaffected. |
| 3 | `Sessions`           | PULSE  | `<active-session-count>` (numeric)                                   | `<n> active Claude/Gemini session(s)`. |
| 4 | `Stored Memories`    | BOOK   | `<branch-count> / <total-count>`                                     | `<branch-count> on current branch, <total-count> total across all branches`. |
| 5 | `Jolli Site` (optional) | GLOBE | Host extracted from the saved Jolli API key (with `https://` / `http://` prefix stripped) | `Resolved from Jolli API Key (tenant: <tenant>)`. Row is omitted when no API key is saved or when it fails to parse. |
| 6 | `Claude Integration` (optional) | per the four-state table | per the four-state table | per the four-state table |
| 7 | `Codex Integration` (optional)  | per the four-state table | per the four-state table | per the four-state table |
| 8 | `Gemini Integration` (optional) | per the four-state table | per the four-state table | per the four-state table |
| 9 | `OpenCode Integration` (optional) | per the four-state table, or WARN when a scan error is reported | per the four-state table, or `unavailable — <kind>` | per the four-state table, or scan-error detail |
| 10 | `Cursor Integration` (optional) | per the four-state table, or WARN when a scan error is reported | per the four-state table, or `unavailable — <kind>` | per the four-state table, or scan-error detail |
| 11 | `Copilot Integration` (optional) | per the four-state table | per the four-state table, with a CLI/Chat detection mark in the tooltip | per the four-state table |

### MCP & Skills row rule

The row is **always present** when a snapshot exists (it is not gated on any detection flag). Its state comes from two snapshot booleans — Node-available and integrations-active:

| Node available | Integrations active | Icon | Description | Tooltip theme |
| -------------- | ------------------- | ---- | ----------- | ------------- |
| true | true | OK | `active` | MCP tools + the `/jolli-recall` and `/jolli-search` skills are active. |
| false | — | WARN | `Node.js not found` | Lists what is unavailable (MCP tools, `/jolli-recall`, `/jolli-search`); claims memory generation is unaffected "(native Java hooks)"; install Node and reopen. |
| true | false | WARN | `setup incomplete` | Node present but the bundled tool failed to enable or was not found; points at the install-debug log and to reopen the project. |

Detection of each integration is **snapshot-only**. Every per-agent detection flag is read straight from the status snapshot, and a **null flag renders nothing** — it is treated as "not detected", so the row is omitted entirely. There is no installer probe, no filesystem fallback, and no agent for which the panel does its own detection:

- **Claude** — the snapshot's Claude-detected flag. No longer "the exception": every agent now behaves this way.
- **Codex** — the snapshot's Codex-detected flag.
- **Gemini** — the snapshot's Gemini-detected flag.
- **OpenCode** — the snapshot's OpenCode-detected flag.
- **Cursor** — the snapshot's Cursor-detected flag. Note this is the Cursor **IDE** (Composer) flag only; the panel has no field for the Cursor command-line agent, so a Cursor-CLI-only user gets no row.
- **Copilot** — covers both the Copilot CLI and VS Code Copilot Chat under a single row and a single config toggle. Either surface's snapshot flag is enough to render the row. The tooltip carries a per-surface `CLI: ✓/✗, Chat: ✓/✗` mark.

The practical consequence: until the first status snapshot has populated these fields, **no integration rows render at all**. Previously the panel could fill that gap with its own probes; now the row list simply lacks integration rows until the snapshot arrives.

### Scan-error WARN rows

OpenCode, Cursor, and Copilot each have a separate "scan unavailable" path. For **OpenCode and Cursor**, the panel emits a WARN row **only when that agent's saved enabled flag is on** and the snapshot reports a scan error; the WARN row (description `unavailable — <kind>`, tooltip `<agent> DB scan failed (<kind>): <message>`) replaces the agent's normal four-state row for that render. For **Copilot**, the CLI and Chat scan errors each emit their own standalone WARN row (`Copilot Integration` / `Copilot Chat`) in addition to the combined integration row — and these two Copilot rows are **not** gated on the Copilot enabled flag: a reported Copilot / Chat scan error surfaces a WARN row even when Copilot integration is disabled in config. (Surprising; asymmetric with the OpenCode/Cursor gating.)

### Four-state integration row

For each detected integration whose enabled flag is on and which has no scan error:

| Saved enabled flag | Hook status        | Icon | Description                  | Tooltip                                                |
| ------------------ | ------------------ | ---- | ---------------------------- | ------------------------------------------------------ |
| `false`            | n/a                | WARN | `detected but disabled`      | `<agent> detected but … is disabled in config`         |
| `true`             | hook not required (Codex / OpenCode / Cursor / Copilot) | OK | `detected & enabled` | `<agent> … found — … is enabled` |
| `true`             | hook required, not installed | WARN | `hook not installed`     | `<agent> detected but hook is not installed`           |
| `true`             | hook required, installed   | OK | `hook installed`             | `<agent> hooks installed (...) — session tracking is enabled` |

The "hook not required" branch applies to Codex, OpenCode, Cursor, and Copilot; Claude and Gemini always require their hooks.

### Stored-memories branch count rule

The branch count is **not** taken from the status snapshot. The panel computes it on every render:

1. Read the list of commit hashes that are on the current branch and not in `main` (worktree-aware; native in-process git invocation).
2. Pass the list through the summary store's have-a-memory filter, which checks each hash against the index map (including commit aliases — same tree-hash matches across rebases / cherry-picks). **This filter is a delegated round-trip to the command-line surface**, so it is recomputed across a process boundary on every single render.
3. The count of survivors is the branch-count.

The total-count comes verbatim from the status snapshot.

### Icon palette

Six logical icons, each backed by a fixed asset:

| Logical | Use                                                     |
| ------- | ------------------------------------------------------- |
| `OK`    | Green check.                                            |
| `ERROR` | Red X.                                                  |
| `WARN`  | Yellow warning.                                         |
| `PULSE` | Pulse / heartbeat (used for sessions).                  |
| `BOOK`  | Book (used for stored memories).                        |
| `GLOBE` | Globe (used for the Jolli site host).                   |

When a row is selected the icon is rendered with all non-transparent pixels replaced by white (cached per-icon). This is what makes the icon legible against the IDE's selection background.

### Per-row layout

The row renderer composes:

| Position | Element                                                                 |
| -------- | ----------------------------------------------------------------------- |
| Far left | Logical icon (white-tinted when selected).                              |
| Inset    | 8 pixels.                                                               |
| Middle   | Label (default foreground; selection foreground when selected).         |
| Right of label | Description prefixed with two spaces; selection foreground when selected. When not selected, the color is chosen by severity: a WARN row's description is amber, an ERROR row's is red, and any other row's is the normal gray. A row that carries an `onClick` callback paints the description link blue (`0x4A90D9`) **only when it has no severity color** (severity wins over the clickability affordance). |
| Tooltip  | Multi-line; lines join with `\n`.                                       |

### Click and cursor affordances

The list registers two mouse handlers:

- A double-click handler that, when the click lands on a row whose data carries a non-null `onClick`, invokes the callback.
- A motion handler that switches the cursor to a hand pointer over rows whose data carries a non-null `onClick`, and back to the default cursor everywhere else.

In the implemented row set, no row supplies an `onClick` — but the data model and handler plumbing are part of the contract because they make per-row link affordances cheap to add.

## Behavior

### Construction

On panel construction:

1. The panel registers two mouse listeners on the list (the double-click `onClick` dispatcher and the cursor-motion handler).
2. It registers the project-status listener to call `refreshUI()` on every fire.
3. It runs `refreshUI()` once synchronously.

### `refreshUI`

The full render runs on the UI thread:

1. Remove all components.
2. Read the project status snapshot.
3. If the snapshot is null, add a single "Initializing..." label and return.
4. Otherwise:
   - Resolve the project's main repo root (so worktrees share config with the main repo).
   - Load the global config for the per-agent enabled flags and the saved Jolli API key.
   - Compute the branch-count of summaries.
   - Clear and rebuild the list model in the order of the row set.
   - Add the scrollable list to the panel.
5. Revalidate and repaint.

### Status-listener-driven refresh

Every project-status change (install completed, hook fired, sign-in changed, etc.) fires the listener; the panel re-renders via `refreshUI()`.

### Disposal

On disposal the panel removes its status listener.

## State Transitions

```
[panel constructed]
  add list mouse listeners
  add status listener
  refreshUI()

[refreshUI]
  removeAll()
  status = service.getStatus()
  if status == null:
    add "Initializing..." label
    return
  config = loadGlobalConfig()
  branchCount = countBranchSummaries()
  listModel.clear()
  add row: Hooks          // "5 Git + 2 Claude + 1 Gemini"
  add row: MCP & Skills   // (nodeAvailable, integrationsActive) → OK/WARN
  add row: Sessions
  add row: Stored Memories
  if config.jolliApiKey parses → add row: Jolli Site
  if snapshot.claudeDetected == true → add Claude integration row (4-state)
  if snapshot.codexDetected == true → add Codex integration row (4-state)
  if snapshot.geminiDetected == true → add Gemini integration row (4-state)
  if snapshot.openCodeDetected == true → add OpenCode row (4-state, or scan-error WARN)
  if snapshot.cursorDetected == true → add Cursor row (4-state, or scan-error WARN)
  if copilot CLI or Chat scan error → add standalone WARN row(s)
  if snapshot.copilotCli == true || snapshot.copilotChat == true → add combined Copilot row (4-state)
  // a null detection flag adds nothing — there is no probe fallback
  add scrollable list to panel
  revalidate; repaint

[status listener fires (any reason)]
  UI: refreshUI()

[user double-clicks a row]
  if row.onClick != null → row.onClick.invoke()

[panel disposed]
  remove status listener
```

## Notable Behavior

- **The panel rebuilds itself top-down on every refresh.** There is no in-place row mutation. The list model is cleared and refilled and the panel `removeAll()`s its components before re-adding the list.
- **The panel has no disabled mode and no inline enable button.** It renders the status row list whenever a snapshot exists, regardless of the enabled flag. When the project is disabled, the tool-window frame surfaces this panel as a full-content card; the enable call-to-action lives in the onboarding view and the Settings dialog (separate specs). Spec-130-era marketing copy and the `Enable Jolli Memory` / `Enabling...` / `Disabling...` toggle button are gone.
- **The hooks row's icon hinges on the git-hook flag alone.** If git hooks are installed but Claude or Gemini hooks are not, the icon is still OK — the description and tooltip carry the missing-hook detail. The integration rows are where missing-hook surfaces as WARN.
- **The hooks row's description is a "+"-joined list of installed hook families.** When all three families are installed it reads `5 Git + 2 Claude + 1 Gemini`; when only Git is installed it reads `5 Git`; when none it reads `none installed`. The numbers are part of the literal string, not a count.
- **The Hooks health icon ignores the push-time hook, so a repository missing it still renders healthy.** The git-hook flag the snapshot supplies is computed from every installed git hook *except* the push-time one, which is deliberately excluded from it. The row's description and tooltip both say "5", but the OK/ERROR decision does not consider that hook. A repository with every git hook installed and a repository missing only the push-time hook therefore render identically: OK, `5 Git`.
- **The branch-count for stored memories is computed by walking commits, not from the status snapshot.** This is what lets the row reflect the count for the currently checked-out branch even when the snapshot is stale.
- **Commit aliases are honored.** A commit's tree hash matching a previous commit's stored memory (after rebase, cherry-pick, or amend that ports the same patch) counts toward the branch-count. The aliasing logic is owned by the summary store; the panel only sees the count.
- **The Jolli site row reads from the global config, not from the runtime auth service.** A signed-out user with a manually-saved API key still sees the row. Conversely, a signed-in user whose account-managed API key has not yet been written to the config sees no row.
- **Codex / OpenCode / Cursor / Copilot are the hookless integrations.** Their detection happens on the command-line side and arrives in the snapshot; the four-state rule's "hook not required" branch is the only path that produces an OK row without a hook. Copilot's CLI and Chat surfaces share one row and one config toggle, with a per-surface mark in the tooltip.
- **Per-agent detection is snapshot-only; a null flag renders nothing.** The panel performs no detection of its own — no installer probe, no filesystem check, no fallback. Every agent, Claude included, is read straight from the snapshot, and a null flag is treated as "not detected" so the row is omitted. Claude is no longer "the exception"; every agent behaves the same. The practical effect is that before the first snapshot populates these fields, the row list has no integration rows at all.
- **The panel has no row for several integrations the command-line surface actually reports.** The status snapshot as this panel consumes it carries no fields for Cline, the Cline command-line variant, Devin, Antigravity, or the Cursor command-line agent — even though the command-line surface detects and reports all of them. Those integrations therefore **never** get a Status row here, at any state, and no scan-error row either. Cline visibility is entirely absent from this surface.
- **This surface's Cursor coverage is narrower than the others'.** The single `Cursor Integration` row reflects only the Cursor IDE (Composer) detection. A user running the Cursor command-line agent sees no Cursor row unless the IDE is also detected — a narrowing that does not exist on the command-line or VS Code surfaces, or in the MCP status tool.
- **This panel has no AI-provider row and no vendor-key row at all.** It reports hooks, MCP & Skills, sessions, stored memories, the optional site host, and the per-agent rows — and nothing about which provider will generate the next summary or whether that provider's credential resolves. So the parity fix that made the provider report name the *selected* provider (and that stopped the vendor-key warning from appearing under a provider that never consumes a vendor key) landed on the command-line status report, on the other editor's status tree, and in the structured AI-host status response — but not here, because there was no row on this surface to correct. A user driving the local-agent provider from this IDE sees no confirmation of it anywhere in this panel. (Notable; observable gap.)
- **The "Node.js not found" tooltip still claims memory generation survives because of "native Java hooks".** That parenthetical is stale: the installed hooks execute under the resolved Node runtime, so a machine with no Node has no memory generation at all — not merely no MCP tools. The tooltip text is the observable contract and it currently overstates what still works.
- **Scan errors surface as their own WARN rows.** OpenCode, Cursor, and Copilot emit a separate `unavailable — <kind>` row when their session-DB scan fails, distinct from the four-state row.
- **Selected rows white-tint their icons via a cached image transform.** The transform replaces every non-transparent pixel with white while preserving alpha; the result is cached per logical icon. This is what makes the icons legible against the IDE selection background.
- **The MCP & Skills row is always shown, unlike the agent rows.** It is not gated on a detection flag — it renders on every snapshot so a missing or unenabled Node runtime is a durable, hover-explained status rather than only a transient balloon. Its two WARN states are distinguished by whether Node is missing entirely versus present-but-not-set-up.
- **Description color now encodes severity, not just clickability.** A non-healthy status reads by color (amber WARN / red ERROR), and severity color takes precedence over the clickable-link blue. The colors are theme-aware (darker on a light theme, brighter on a dark theme).

## Shared Behavior

- **Project status snapshot** — drives the whole panel; every refresh re-reads it.
- **Project status listener** — the panel registers and removes one listener; every fire triggers `refreshUI()`.
- **Saved global config** — read on every snapshot-present refresh for the per-agent enabled flags and the saved Jolli API key.
- **Summary store's have-a-memory filter** — used to compute the branch-count for stored memories; a delegated round-trip on every render.
- **Jolli API key parser** — used to extract the host and tenant for the Jolli site row.
- **Installation-status core** — owns every per-agent detection flag and every scan-error record this panel renders, including the fields this panel has no row for. The panel is a pure renderer of that snapshot; it contributes no detection of its own.
- **Tool-window frame** — owns the view switch, breadcrumb, title-bar actions, the full-pane Status toggle that shows / hides this panel, and the auto-show-when-disabled rule (separate spec).
- **Onboarding view / Settings dialog** — own the enable call-to-action and credential entry that this panel deliberately does not render (separate specs).
