# 295. VS Code Sidebar Status Tree

## Topic Statement

The row set the sidebar's STATUS tab renders: three degenerate render states (migrating, loading, disabled-shows-nothing) and, when Jolli Memory is enabled, a flat list of live rows — hooks, sessions, the resolved AI summary provider, credential/account rows, one row per detected AI integration, an update warning, and a trailing worker-busy row — where each dual-variant integration always shows its merged row and pushes an *additional* standalone warning row for every channel whose scan failed.

## Scope

**In scope:**

- The four render states and what each emits.
- The row shape: label, description, icon (with its color semantics), optional tooltip, optional click action.
- The fixed rows and their order: Hooks, Sessions, AI Summary Provider, the conditional vendor-key warning, the account block (account / site / product-key warning), the integration rows, the conditional update warning, and the conditional worker-busy row.
- The exact description and tooltip text of each fixed row, including the multi-line hooks tooltip.
- The four-state per-integration row model (omitted when undetected; disabled; enabled without a hook concept; hook missing; hook installed) and its session-count suffixes.
- The two different scan-failure shapes: single-channel integrations, whose warning row **replaces** the healthy row; and merged dual-variant integrations, whose per-channel warning rows are **added** to an always-rendered merged row.
- The exact labels, descriptions, and tooltip shapes of the six per-channel warning rows.
- Which rows are clickable and what they invoke.
- The refresh model (full rebuild on every snapshot change).

**Out of scope:**

- The single status-bar entry at the bottom of the window, its sync-state visuals, and its ownership latch — a different surface entirely, owned by **VS Code Status Bar Items** (116).
- How the underlying status snapshot is collected (detection probes, hook-file reads, session scans) — an installer concern.
- Which sidebar tab is showing, and the tab-switch persistence — owned by **VS Code Sidebar Tab State** (102).
- The webview DOM, the tree-item serialization, and the host↔webview message plumbing — owned by **VS Code Sidebar Webview Message Protocol** (101).
- The disabled panel (the Enable Jolli Memory button and its copy) that the webview shows when this tree returns nothing.
- The Settings panel and the sign-in flow the clickable rows open.

## Data Contracts

### Render states

| Snapshot condition | Rendered rows |
| --- | --- |
| Migration in progress | Exactly one row: label `Migrating memories...`, no description, spinner icon. |
| No status snapshot yet | Exactly one row: label `Loading...`, no description, spinner icon. |
| Snapshot present, Jolli Memory **not** enabled | **No rows at all** (an empty list). The webview replaces the tree with its disabled panel. |
| Snapshot present, enabled | The full row set below. |

When the full row set is rendered and the worker-busy flag is set, one extra row is appended **after everything else**: label `AI summary in progress…`, no description, spinner icon.

### Row shape and icon semantics

Every row carries a label, a description (rendered as dimmed trailing text), an icon, an optional tooltip, and an optional click action. Rows are flat — nothing is collapsible or nested.

| Icon | Meaning |
| --- | --- |
| Green check | Healthy / installed / configured. |
| Red cross | A required piece is missing. |
| Yellow warning | Needs attention (disabled, unconfigured, scan failure, outdated). |
| Green pulse | The sessions counter. |
| Green globe | The resolved Jolli site. |
| Spinner | In progress (migrating, loading, worker busy). |

### Fixed rows, in order

**1. Hooks.** Description is the installed hook families joined with ` + ` — the git family as `<n> Git` (where `<n>` is 5 when the pre-push section is installed and 4 otherwise), `2 Claude`, `1 Gemini` — or `none installed` when no family is present. The icon is a green check when the git family is healthy and a red cross otherwise; the agent hook families do not affect the icon.

The count and the icon read **different** section sets. Five sections make up the git family (post-commit, post-rewrite, prepare-commit-msg, post-merge, pre-push); the count is over all five, but the health flag driving the icon requires only **four** of them — pre-push is excluded. So a repository with all five and a repository missing only pre-push are both green, differing only in whether the description reads `5 Git` or `4 Git`; while a repository that has pre-push but is missing one of the other four is red and emits no git part in the description at all.

The tooltip is a multi-line block, in this order:

- `Git hooks: <n> installed (post-commit, post-rewrite, prepare-commit-msg, post-merge[, pre-push])`, or `Git hooks: not installed (…)` with the same parenthesized list. The `pre-push` entry appears in the list only when that hook is installed.
- `Claude Code hooks: 2 installed (Stop, SessionStart)` or `Claude Code hooks: not installed (Stop, SessionStart)`.
- `Gemini hook: installed (AfterAgent)` or `Gemini hook: not installed (AfterAgent)`.
- `Hook runtime: <source>[@<version>]` — present only when a hook source has been recorded; the version suffix is omitted when the recorded version is unknown.
- `Data migration: <state>` — the same data-migration descriptor `jolli status` prints.

**2. Sessions.** Description is the total active session count as a bare number. Pulse icon. Tooltip `<n> active session(s) across all integrations`, with singular/plural agreement on "session".

**3. AI Summary Provider.** Description is one of `Anthropic`, `Anthropic (env)`, `Jolli`, `Local agent - <tool>` (green check in each case), or `not configured — click to set` (warning). Tooltips, respectively: "AI summaries are generated via the Anthropic API key from your config.", "AI summaries are generated via the ANTHROPIC_API_KEY environment variable.", "AI summaries are routed through the Jolli backend proxy.", "AI summaries are generated by a local agent CLI using its own login (no Anthropic/Jolli key needed)." The unconfigured state has three sub-messages so the user can tell which gap they are looking at: provider set to the proxy but no product key on file, provider set to the vendor but no vendor key configured, or no provider chosen at all. Clicking the row opens Settings.

The local-agent description is the literal `Local agent`, a space-hyphen-space separator, and the display label the shared agent-tool registry gives the configured tool — so the row reads e.g. `Local agent - Cursor`. The registry's membership is owned elsewhere (spec 110); this row only looks a label up in it. When no tool identifier is stored the label defaults to the registry's first entry. A **stored identifier the registry does not recognize** (a newer build's value read back by an older one, or a hand-edited config) degrades to the generic label rather than throwing, which renders as the doubled `Local agent - Local agent`. The single generic tooltip above is used whichever tool is configured — it never names the tool.

**4. Anthropic API Key (conditional).** Rendered only when the chosen provider is **explicitly** the vendor-direct one **and** neither a configured vendor key nor the vendor environment variable resolves. Description `not configured — click to set`, warning icon, tooltip "Required for AI-powered commit summarization", click opens Settings.

For every other provider choice the row would contradict the green provider row printed directly above it in the same tree: the proxy and the local-agent providers do not consume a vendor key at all, and when no provider is chosen the provider row above already reports the gap — so a second vendor-specific nag there would wrongly imply the vendor is the only option.

**5. The account block.** Three mutually exclusive shapes:

- **Signed in** — `Jolli Account` / `connected`, green check, tooltip "Signed in to Jolli. Use the sign-out icon in the title bar to disconnect." Followed by the Jolli Site row when a site resolves. Followed, when no product API key is on file, by `Jolli API Key` / `not issued — pushes disabled`, warning icon, tooltip "Signed in, but no Jolli API Key was issued. Pushes to your Jolli Space are disabled. Sign out and sign in again, or set a key manually in Settings.", click opens Settings.
- **Not signed in but a product API key is on file** — only the Jolli Site row.
- **Neither** — `Jolli Account` / `not connected — click to sign in`, warning icon, tooltip "Sign in to push memories to your Jolli Space", click starts sign-in.

The **Jolli Site** row: label `Jolli Site`, description the site host with the scheme stripped, globe icon. Its origin is the API key's embedded site when a decodable key is on file, otherwise the persisted sign-in origin — so the row keeps showing the tenant in the "signed in but no key issued yet" state. The tooltip records which source was used: `Resolved from Jolli API Key (tenant: <tenant>)` or `Persisted sign-in origin (no decodable Jolli API Key on file)`. The row is omitted when neither source yields an origin.

**6. Integration rows** — in this order: Claude, Codex, Gemini, OpenCode, Cursor, Devin, Copilot, Cline, Antigravity, Kimi Code. Each product's per-channel warning rows (when it has any) come immediately before its own row. An integration that is not detected contributes no rows at all.

The last of these, Kimi Code, is the only integration with **no failure channel of any kind** — its sessions are plain files, so it has no scan-error row and can only ever render the disabled or the enabled state. It is also, uniquely among the recently-added integrations, not covered by any test of this tree.

**7. Update Available (conditional).** Rendered when a newer extension version is known to be managing hooks: description `a newer version is available`, warning icon, tooltip "A newer version of Jolli Memory is managing hooks. Please update the extension."

**8. Worker-busy row (conditional)** — as described under render states.

### The four-state integration row

| Condition | Description | Icon | Tooltip |
| --- | --- | --- | --- |
| Not detected | *(row omitted entirely)* | — | — |
| Detected, switched off in config | `detected but disabled` | Warning | The integration's disabled tooltip. |
| Detected, enabled, no hook concept | `detected & enabled` plus ` (<n> sessions)` when `<n>` > 0 | Check | The integration's enabled tooltip plus ` (<n> active sessions)` when `<n>` > 0. |
| Detected, enabled, hook concept but hook absent | `hook not installed` | Warning | The integration's hook-missing tooltip. |
| Detected, enabled, hook installed | `hook installed` plus ` (<n> sessions)` when `<n>` > 0 | Check | The integration's enabled tooltip plus ` (<n> active sessions)` when `<n>` > 0. |

Both suffixes agree singular/plural on "session". Only Claude and Gemini have a hook concept; every other integration is discovered passively and therefore renders the no-hook-concept states.

Enabled-state tooltips for the single-variant integrations, in row order: "Claude Code hooks installed (Stop, SessionStart) — session tracking is enabled", "Codex sessions directory found — session discovery is enabled", "Gemini AfterAgent hook installed — session tracking is enabled", "OpenCode sessions database found — session discovery is enabled", "Devin CLI session database found — session discovery is enabled", "Antigravity conversations found — session discovery is enabled", "Kimi Code sessions found — session discovery is enabled". Each has a matching "… detected but session discovery is disabled in config" (or "… session tracking is disabled in config") form, and Claude and Gemini additionally have a hook-missing form ("Claude Code detected but hooks are not installed", "Gemini detected but AfterAgent hook is not installed").

### Scan failure — single-channel integrations

OpenCode, Devin, and Antigravity each read from one store that can exist but be corrupt, locked, or schema-drifted. A scan failure **replaces** that integration's row with a single warning row:

| Label | Description | Tooltip |
| --- | --- | --- |
| `OpenCode Integration` | `unavailable — <kind>` | `OpenCode database scan failed (<kind>): <message>` |
| `Devin Integration` | `unavailable — <kind>` | `Devin database scan failed (<kind>): <message>` |
| `Antigravity Integration` | `unavailable — <kind>` | `Antigravity database scan failed (<kind>): <message>` |

### Scan failure — merged dual-variant integrations

Cursor (IDE + CLI), Copilot (CLI + Chat), and Cline (VS Code + CLI) each merge two independently scanned channels under one shared per-product enable toggle. For each of these:

- Every channel whose scan failed pushes its **own standalone warning row**. The two channels are independent — neither row is gated on the sibling channel's state, and neither replaces the other.
- The **merged row is always rendered afterwards**, using the four-state model above. A channel failure never suppresses it, so a broken channel can never hide the healthy channel's session count.

The six per-channel warning rows:

| Product | Channel | Row label | Description | Tooltip |
| --- | --- | --- | --- | --- |
| Cursor | IDE | `Cursor Integration` | `unavailable — <kind>` | `Cursor database scan failed (<kind>): <message>` |
| Cursor | CLI | `Cursor CLI` | `unavailable — <kind>` | `Cursor CLI scan failed (<kind>): <message>` |
| Copilot | CLI | `Copilot Integration` | `unavailable — <kind>` | `Copilot CLI database scan failed (<kind>): <message>` |
| Copilot | Chat | `Copilot Chat` | `unavailable — <kind>` | `Copilot Chat scan failed (<kind>): <message>` |
| Cline | VS Code | `Cline Integration` | `unavailable — <kind>` | `Cline VS Code scan failed (<kind>): <message>` |
| Cline | CLI | `Cline CLI` | `unavailable — <kind>` | `Cline CLI scan failed (<kind>): <message>` |

The merged rows themselves:

| Product | Detected when | Session count | Enabled tooltip |
| --- | --- | --- | --- |
| Cursor | Either channel is detected | Sum of the IDE and CLI session counts | `Cursor detected (IDE: <✓\|✗>, CLI: <✓\|✗>) — session discovery is enabled` |
| Copilot | Either channel is detected | Sum of the CLI and Chat session counts | `GitHub Copilot detected (CLI: <✓\|✗>, Chat: <✓\|✗>) — session discovery is enabled` |
| Cline | Either channel is detected | Sum of the CLI and VS Code session counts | `Cline detected (CLI: <✓\|✗>, VS Code: <✓\|✗>) — session discovery is enabled` |

Each also has a disabled form with the same channel-mark parenthetical followed by "but session discovery is disabled in config". The channel marks report per-channel *detection*, independent of whether that channel's scan then failed. The session count is the plain arithmetic sum of both channels and is unaffected by one channel failing.

## Behavior

### Refresh

The tree subscribes to the status snapshot. Every snapshot change fires a tree-data-change event and the entire row list is rebuilt from scratch — there is no incremental diffing, no per-row caching, and no partial update. The rebuild reads the snapshot's status, the current config, and the extension-outdated flag.

### Row assembly order

1. Emit the degenerate single-row state if migrating or if no snapshot has arrived; emit nothing at all if the snapshot says Jolli Memory is not enabled.
2. Otherwise push Hooks and Sessions.
3. Push the AI Summary Provider row.
4. Push the vendor-key warning row if the provider is explicitly the vendor-direct one and no vendor key resolves from either source.
5. Push the account block (account row, site row, product-key warning row) per the shape that matches the credential state.
6. Walk the integrations in order. For each merged dual-variant product, push each failed channel's warning row, then the merged row. For each single-channel product, push either its warning row or its normal row.
7. Push the update warning if the extension is outdated.
8. Push the worker-busy row if the worker-busy flag is set.

### Clickable rows

Four rows carry a click action: the AI Summary Provider row, the vendor-key warning row, and the product-key warning row all open Settings; the not-connected account row starts sign-in. Every other row is inert — clicking it does nothing.

## State Transitions

The tree has no state of its own; it is a pure projection of the current snapshot. The only transitions are between the four render states, each triggered by a snapshot change:

| From | Trigger | To |
| --- | --- | --- |
| Loading | First snapshot arrives, migration running | Migrating |
| Loading | First snapshot arrives, not enabled | Empty (webview shows the disabled panel) |
| Loading | First snapshot arrives, enabled | Full row set |
| Migrating | Migration finishes | Full row set (or Empty if not enabled) |
| Empty | User enables Jolli Memory | Full row set |
| Full row set | User disables Jolli Memory | Empty |
| Full row set | Any other snapshot change | Full row set, rebuilt from scratch |

## Notable Behavior

- **A failed channel no longer masks its healthy sibling.** The Cline case used to be a single either/or branch: any Cline scan error replaced the whole merged row with one warning row, so a broken VS Code-side scan hid the CLI-side session count entirely (and vice versa) — and only one of the two failures could ever be shown. Now each channel pushes its own warning row and the merged row is always rendered. Cursor and Copilot already worked this way; all three are now identical. (Surprising; intentional.)
- **Single-channel and dual-channel failures use deliberately different shapes.** With no sibling to mask, a single-channel product's warning row *substitutes* for its normal row (so it cannot read as a misleading "0 sessions"); a dual-variant product's warning rows are *added* to a row that still reports the surviving channel's sessions. (Notable.)
- **Two rows can carry the same label.** Cursor's IDE-channel failure and Cline's VS Code-channel failure both reuse the `<Product> Integration` label, so a failure on that channel yields two rows with identical labels — distinguished only by their descriptions and tooltips. The second channel of each pair gets its own distinct label. (Surprising.)
- **Disabled renders nothing, not an empty-state row.** The tree returns an empty list so the surrounding webview can own the entire disabled experience, including the Enable button. (Notable.)
- **The provider row stays visible even when nothing resolves.** It flips to a warning rather than disappearing, so a missing provider reads as a discoverable problem instead of a missing UI element. It is resolved through the same credential resolution the summary dispatcher uses, so the row's claim and the route the next commit actually takes cannot drift apart. (Notable.)
- **The vendor-key warning is gated on an explicit vendor-direct choice, not on the absence of a key.** It is rendered *only* for that one provider, and only when neither key source resolves. Every other choice — the proxy, the local agent, or no explicit provider at all — suppresses it, because otherwise the tree would contradict itself in place: a warning row demanding a key sits directly beneath a green provider row that just said summaries are routed elsewhere, and legacy configs with no provider chosen would get a vendor-specific nag on top of the provider row's own "not configured" report. (Surprising; intentional.)
- **The provider row is the only place the chosen local-agent tool is named.** The tool label is part of the row's description; the tooltip is a single generic sentence used whichever tool is configured. An unrecognized stored tool identifier degrades to the generic label instead of throwing, which reads as the doubled `Local agent - Local agent`. (Notable.)
- **An integration's row can vanish because of the runtime, not because of the machine.** Detection for every integration whose data lives in an embedded database is gated on the runtime having built-in database support; below the supported floor those detectors answer "not present", so the row is omitted rather than reporting a failure. Their configuration entries are still written, because registration and discovery are gated on different predicates. (Surprising — an omitted row can mean "not installed" *or* "this runtime cannot look".)
- **One integration can never show a failure state.** The most recently added one reads plain files, so it has no scan-error channel, no per-channel row, and no `unavailable` description. (Notable.)
- **The hooks icon tracks only the git family.** Missing agent hooks show up in the description and tooltip but leave the icon green, because the git hooks are what make memory capture work at all. (Notable.)
- **`4 Git` next to a green check is not a contradiction.** The count is over five sections but the icon's health flag is computed from only four of them, so a healthy install that has no pre-push section shows `4 Git` and stays green. The tooltip is the only place the pre-push section's absence is stated explicitly (it drops out of the parenthesized section list). (Surprising.)
- **The session count is worded differently in the description and the tooltip.** The description says `(3 sessions)`; the tooltip says `(3 active sessions)`. (Notable.)
- **The merged count is a plain arithmetic sum.** It is not reduced when one of the two channels failed to scan — the surviving channel's number is reported as-is, which is the whole point of not masking the merged row. (Notable.)
- **The worker-busy row is appended last**, after the update warning, so the transient "generating" state is always the bottom row. (Notable.)
- **The channel marks report detection, not health.** A channel can show `✓` in the merged row's tooltip while also having its own warning row above — detected, but its store could not be read. (Notable.)

## Shared Behavior

- **Row wording is shared with the CLI status report and the MCP status tool.** The four-state descriptions (`detected but disabled`, `detected & enabled`, `hook not installed`, `hook installed`, plus the session-count suffix) and the `unavailable — <kind>` failure state are deliberately identical to what `jolli status` prints (58) and what the MCP `status` tool returns (148), so users see the same language in every surface. The merged-row aggregation rule — healthy unless *both* channels fail, with each failure surfaced separately — is the same rule all three surfaces apply.
- **The data-migration descriptor** in the hooks tooltip is the same string `jolli status` prints for its data-migration line.
- **The resolved site** is computed the same way as the Settings panel's site label and the CLI status report's site row, including the fall back to the persisted sign-in origin when no decodable key is on file.
- **Credential resolution** for the provider row is the same resolution the LLM dispatcher performs at commit time. The **CLI status report's provider row** (58) renders from the same resolution and reuses this row's resolved-state descriptions verbatim, including the `Local agent - <tool>` form. The **MCP `status` tool** (148) reports the provider as a plain enumeration rather than a rendered label, and surfaces the tool through the same tool-label registry this row reads.
- **"Report the vendor key only under the vendor-direct provider"** is a rule all three surfaces now apply, each in its own shape: this tree suppresses the row entirely, the CLI status report omits its vendor-key line, and the MCP `status` tool omits its vendor-key field. This tree is additionally the only one of the three that also requires the key to be *missing* before it says anything — the other two report the line/field's value either way once the provider matches.
- **The local-agent tool-label registry** — the closed set of supported tool identifiers and their display labels — is shared with every surface that names the active tool, including the settings panel's agent-tool dropdown (110) and the pre-regeneration confirmation in the memory panel (109). This tree only looks a label up in it and never enumerates it, so a tool added there needs no change here.
- **The per-integration configuration toggles** the disabled state reads are the same ones the settings panel's AI Agents tab writes (110); the settings panel's at-least-one-must-remain-checked rule is what stops every row here reading as disabled at once.
- **The status snapshot** driving this tree is the same snapshot that drives the status-bar entry's enabled flag (116), the sidebar's empty-state copy, and the Settings integration toggles.
- **The status-bar entry** at the bottom of the window is a separate surface with its own visual model — see **VS Code Status Bar Items** (116), which explicitly excludes this tree.
