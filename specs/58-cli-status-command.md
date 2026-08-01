# 58. `jolli status` — Installation status report

## Topic Statement

The `jolli status` command reports, for the current project, which hooks are installed, how many sessions are recorded, how many memories are stored, and whether credentials are configured, in either a human-readable or a machine-readable format.

## Scope

This spec covers the user-facing behavior of `jolli status`: the two output formats, what is reported, the per-AI-agent state model, and the exit code policy. It does not cover how the underlying installer collects this information (that is a separate, internal concern).

## Data Contracts (output)

### Human-readable format (default)

A multi-line report written to stdout. Lines are aligned with two-space leading indentation and a label-colon-value layout. The report contains, in order:

1. A header line with the product name and CLI version (e.g. `Jolli Memory Status (v1.2.3)`).
2. A horizontal-rule separator.
3. **Hooks** — the installed hook families joined with ` + `, e.g. `5 Git + 2 Claude + 1 Gemini`, or `none installed` when no family is present. The Git count reads `5` when the pre-push section is installed and `4` when it is not — but whether the Git family is reported as installed at all is decided by a check over only four of the five sections (see "The Git family's count and its health check disagree" below).
4. **Hook runtime** — the source and version that wrote the active hooks (e.g. `cli@1.2.3`), printed only if a hook source has been recorded.
5. **Data migration** — a one-line descriptor of the schema-migration state, printed unconditionally. It is deliberately binary: `Up to date (v5)` when the migration has completed, and `Not migrated — run jolli migrate` for **every** other state (in progress, failed, never started). Finer sub-states are not surfaced, because nothing short of "completed" is actionable in a different way. The same wording is used by the desktop editor's hooks tooltip.
6. **Jolli Account** — `Signed in` or `Not signed in`.
7. **Jolli API Key** — `Configured` or `Not configured`.
8. **Jolli Space** — the repo's Space-binding state, printed unconditionally (even "not connected" / "unknown"). See "The Jolli Space: row" below.
9. **Outbound push** — printed **only** when outbound push is off for this repo; absent otherwise. See "The Outbound push: row" below.
10. **AI Provider** — the provider the *next* commit would actually generate with, printed unconditionally. See "The AI Provider: row" below.
11. **Anthropic Key** — `Configured` or `Not configured` (the env variable counts). Printed **only** when the configured provider is explicitly the Anthropic one; omitted for every other provider and when no provider is set. See "The AI Provider: row" below for why the two rows are coupled.
12. **Sessions** — total active session count across all AI agents.
13. **Per-agent breakdown** — one row per AI agent that was *detected* on this machine (see state model below). Undetected agents are omitted entirely to keep the output terse. The list is, in order: Claude, Codex, Gemini, OpenCode, Cursor, Devin, Copilot, Cline, Antigravity. Undetected agents are omitted.
14. **Merged-row sub-lines** — three rows are each a merged dual-variant row that, when detected, renders an additional indented sub-line beneath itself showing whether its two variants are each present (`✓`/`✗`): Cursor (`↳ IDE: …, CLI: …`), Copilot (`↳ CLI: …, Chat: …`), and Cline (`↳ CLI: …, VS Code: …`). If a variant's scan failed, a further indented line reports that variant's failure kind and message without masking the other variant's working count.
15. **Stored memories** — count of summaries on the orphan branch.
16. **Memory Bank** — where folder-layer memory writes will actually land, or the blocker stopping them, printed unconditionally. The row prints only the *text* of the shared Memory-Bank display record; the record's severity is discarded here, so this row carries no icon and no colour. The state model, the three arms, and every string verbatim are owned by spec 300 — this spec adds only the row's position and unconditionality.
17. **Jolli Site** / **Last signed-in site** — the host portion of the **persisted Jolli site URL** (with `http://` / `https://` scheme stripped), printed only when that URL is stored at all. The label is switched by whether an on-disk credential (an on-disk OAuth token or a Jolli API key) backs it: `Jolli Site:` when one does, `Last signed-in site:` when none does. The URL is **not** derived from the stored Jolli API key.
18. **Orphan branch** — the orphan-branch name used for summary storage.

### Machine-readable format (`--json`)

A single JSON object on one line followed by a newline. The object is the status snapshot exactly as produced by the installer, with no additional formatting or transformation. This format is consumed by the VS Code extension.

The snapshot carries the effective **Memory Bank state** as a **required**, structured field — the same record the human-readable `Memory Bank:` row renders to text. Consumers read the discriminated record (its arm tag plus the arm's own fields), never the rendered string. It is deliberately mandatory rather than optional, unlike the neighbouring migration-state field whose absence means "pending": "absent" must not be readable as one of the Memory-Bank states. The arms and their fields are owned by spec 300.

When `--json` is supplied, **only** the JSON line is printed; none of the human-readable lines are emitted.

## Behavior

### Invocation forms

- `jolli status` — print the human-readable report.
- `jolli status --json` — print the raw status object as a single JSON line.
- `jolli status --cwd <dir>` — operate against `<dir>` instead of the auto-resolved git repository root.
- `jolli status --refresh` — bypass the local Space-binding cache and re-check against the server for this run.

### Per-agent state model

Each detected AI agent is rendered with one of five state strings:

1. **`unavailable — <kind>`** — the agent's session store was found but could not be read (e.g. corrupt database, permission denied, schema mismatch). The `<kind>` is a short machine-style identifier of the failure category. Used by every agent that reads its data from a database or other structured store: OpenCode, Devin, and Antigravity (single-store agents), plus Cursor, Copilot, and Cline (the merged dual-variant rows, which reach this state only when **both** of their stores fail — see below).
2. **`detected but disabled`** — the agent is present on the machine, but has been switched off in the Jolli config (`<agent>Enabled: false`).
3. **`hook not installed`** — the agent is detected and enabled, but its hook entry is absent from the agent's settings file. Applies only to agents that have a hook (Claude, Gemini).
4. **`hook installed`** or **`hook installed (<n> session[s])`** — the agent is detected, enabled, and its hook is present. The session count, if non-zero, is appended in parentheses with proper singular/plural agreement.
5. **`detected & enabled`** or **`detected & enabled (<n> session[s])`** — the agent has no hook concept (Codex, OpenCode, Cursor, Devin, Copilot, Cline, Antigravity — they are discovered passively). The session count is appended when non-zero.

State precedence: scan-error wins, then disabled, then hook-status / passive-status with session count. Per-agent rows are printed only for agents whose `detected` flag is true.

### The Git family's count and its health check disagree

Five git hook sections make up the Git family: post-commit, post-rewrite, prepare-commit-msg, post-merge, and pre-push. Two different rules read them:

| Rule | Reads | Effect on the Hooks line |
| --- | --- | --- |
| Git-family health | Exactly **four** sections — post-commit, post-rewrite, prepare-commit-msg, post-merge, all four required. **pre-push is excluded.** | Decides whether a `<n> Git` part appears at all. When it fails, no Git part is emitted (and the line reads `none installed` if no agent hook family is present either). |
| Displayed count | **All five**, as a count. | Renders `5 Git` when pre-push is installed, `4 Git` when it is not. |

The consequence: a repository with all five sections and a repository missing only pre-push **both** report the Git family as installed. They differ only in the number printed — `5 Git` versus `4 Git`. Neither reads as unhealthy, and nothing on this line flags the missing pre-push section as a problem; the reader has to know that `4 Git` means "pre-push absent" rather than "one section broken".

Conversely, a repository that has pre-push but is missing any one of the other four emits **no** Git part at all, even though four of five sections are on disk.

### Merged dual-variant rows

Exactly **three** rows in the breakdown each represent two separately scanned channels of one product, merged into a single row under one shared per-product enable toggle:

| Row | The two channels | Presence sub-line | Channel whose kind is shown when both fail |
| --- | --- | --- | --- |
| **Cursor** | Composer IDE, cursor-agent CLI | `↳ IDE: ✓/✗, CLI: ✓/✗` | IDE |
| **Copilot** | CLI, Chat | `↳ CLI: ✓/✗, Chat: ✓/✗` | CLI |
| **Cline** | CLI, VS Code extension | `↳ CLI: ✓/✗, VS Code: ✓/✗` | VS Code |

Each merged row is printed when **either** of its two channels is detected, and its presence sub-line is printed unconditionally beneath it. The session count shown on the row is the arithmetic sum of both channels' counts.

**Masking rule.** All three rows apply the identical aggregation: the healthy reading wins unless **both** channels failed. A single channel's failure is demoted to a non-masking sub-line and never changes the main row.

| One channel's scan | The other channel's scan | Main row | Failure sub-lines printed |
| --- | --- | --- | --- |
| ok | ok | `detected & enabled (<sum> sessions)` | none |
| failed | ok | `detected & enabled (<sum> sessions)` — unchanged | one, for the failed channel |
| ok | failed | `detected & enabled (<sum> sessions)` — unchanged | one, for the failed channel |
| failed | failed | `unavailable — <kind>`, using the kind from the channel named in the table above | two, one per channel |

A failure sub-line reads `↳ <channel> scan failed (<kind>): <message>` and is printed for **every** failed channel, independent of whether the main row reads "unavailable". The session count on the main row is always the plain sum of both channels and is never reduced because one channel failed — the surviving channel's sessions are reported as-is.

### The Jolli Space: row

Resolved **cache-first**: a fresh healthy entry in the local Space-binding cache (7-day TTL, keyed by canonical repo URL + tenant origin) renders the row with **zero network I/O**.

On a cache miss, or when `--refresh` is passed, one best-effort front-door round-trip — the same call the guided front door makes, so `status` and bare `jolli` never disagree about bound-ness — both renders the row and updates the cache: a healthy bound result writes it; unbound / no-spaces / degraded clears it; a network or auth failure leaves it untouched.

No request is made without a `jolliApiKey`, and **none** is made in `--json` mode (the JSON payload has no Space-binding field).

Rendered values:

| State | Rendered value |
| ----- | --------------- |
| Bound, healthy | `Bound to Space "<name>"` |
| Bound, no view access (`spaceName` null) | `Bound — no access to the Space (memories won't sync; <fix>)` |
| Bound, read-only (`canPush` false) | `Bound to Space "<name>" — read-only (memories won't sync; <fix>)` |
| Unbound, ≥1 bindable Space | `Not bound — <n> Space(s) available (run jolli to bind)` |
| Unbound, no Spaces | `Not bound — no Spaces available to you` |
| Unbound, no Spaces, **allowlist-restricted** | `Not bound — this repo isn't registered in any Space (ask an administrator to add it)` |
| No key configured | `Not connected — run jolli auth login` |
| Key rejected by server | `Not connected — key rejected (run jolli auth login)` |
| Client too old | `Unknown — client outdated, update the CLI` |
| Server unreachable | `Unknown — Jolli not reachable (offline?)` |

`<fix>` is `run jolli to rebind` when the server attached a non-empty bindable pool, else `ask for access`. `canPush: null` renders as healthy.

The last two rows split the same server answer on one flag. The **restricted** wording is reserved for the server's genuine no-spaces answer carrying the allowlist flag — the same admin-action-required condition the push path reports when it refuses a repo that is not registered — so it points at an administrator rather than at creating a Space. An `unbound` answer that arrived with an *empty* list is contract drift (the server is supposed to answer no-spaces in that case); it is folded into the no-spaces arm with the flag forced off, so a folded-in answer can never claim to be allowlist-restricted and can never point the user at a bind offering zero choices.

### The Outbound push: row (conditional)

A row printed **only when outbound push is off for this repo** (spec 310) — a repo that is syncing normally prints nothing here. Suppressing the row in the healthy case is the point: a silently non-syncing repo is exactly what the setting has to make visible, and a row that is always present would be read past.

Two distinct wordings, for two conditions that must not be conflated:

| Condition | Rendered value |
| ----- | --------------- |
| The user turned push off for this repo | `Outbound push:    Disabled for this repo (memory recorded locally)` |
| The push-control store could not be read (fail-closed) | `Outbound push:    Blocked — setting unreadable (<error>)` |

The split is deliberate and the reasoning is worth keeping: attributing a fail-closed read of a corrupt store to the user is wrong twice over — they chose nothing, and the condition is not per-repo at all — and it hides the one file that would fix it, which is why the second wording names the read failure instead. The row prints immediately after the `Jolli Space:` row and before `AI Provider:`. The store, the gate, and the control surfaces behind it are owned by spec 310.

### The AI Provider: row

An unconditional row, printed immediately after the Space-binding row. Its value is resolved by the **same credential-precedence resolution the LLM dispatcher itself uses** to pick a provider for a call, so the row can never name a provider the next commit would not actually use.

Exactly five values are possible:

| Rendered value | Condition |
| --- | --- |
| `Anthropic` | The Anthropic key stored in the config is what would be used. |
| `Anthropic (env)` | No stored Anthropic key, but the `ANTHROPIC_API_KEY` environment variable is set and is what would be used. |
| `Jolli` | The stored Jolli API key routed through the Jolli proxy is what would be used. |
| `Local agent - <tool>` | The provider is explicitly the local-agent one. `<tool>` is the display name of the configured agent tool, defaulting to Claude Code's display name when the tool setting is absent, and degrading to a generic label for a tool identifier this build does not recognize. |
| `Not configured` | The resolution yielded nothing. |

`Not configured` covers **two** distinct states, deliberately collapsed into one string: nothing is configured at all, **and** a provider is explicitly pinned but its required credential is absent (the Anthropic provider with neither a stored key nor the environment variable; the Jolli provider with no Jolli API key). The local-agent provider can never render `Not configured` — it is selected on the strength of the provider setting alone, with no credential and no executable probe at this surface.

**The `Anthropic Key:` row is coupled to this one.** It prints only when the provider is explicitly the Anthropic one — the sole provider that consumes an Anthropic key. Before that gate existed the row printed unconditionally, so a healthy Jolli-proxy or local-agent user saw `Anthropic Key: Not configured` in an otherwise clean report and read their install as broken.

### `--cwd` resolution

The project directory is auto-resolved to the enclosing git repository root when `--cwd` is omitted. The Jolli config and session counts are loaded from the *global* config directory regardless of `--cwd` — `--cwd` only scopes the per-project state (hooks, queue, orphan branch).

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | The status report was produced. This is the only successful outcome and applies regardless of whether hooks are installed, credentials are configured, or session counts are zero. |
| Non-zero | Argument parsing failed (e.g. unknown flag). Reported by the CLI argument parser, not by the status command itself. |

`jolli status` is intentionally a read-only, never-failing query: it reports problems instead of signalling them via exit code. Use `jolli doctor` for an exit-code-driven health check.

## Notable Behavior

- **Quiet by default for absent agents**: the breakdown shows nothing for an AI agent that is not installed on the machine. Users are not nagged about agents they don't use.
- **The Git count is not a health indicator, and `4 Git` is not a warning.** The count is over all five sections while the family's health check covers only four of them, so `4 Git` is a fully healthy install that simply has no pre-push section, and it is indistinguishable at a glance from a five-section install that lost one. A missing pre-push section is therefore invisible as a *problem* on this line — the number is the only signal, and it is not marked. (Surprising.)
- **A single broken channel never masks its healthy sibling — now true for all three merged rows.** Until recently only Cursor behaved this way. Copilot reported the entire row as `unavailable` whenever its CLI store failed, hiding a perfectly healthy Chat channel and its session count; Cline was worse still — either channel's failure both masked the sibling *and* silently discarded the other channel's failure, so the Cline row printed no failure sub-line at all. Both now follow the Cursor rule, and Cline gained its two per-channel failure sub-lines. (Surprising; intentional.)
- **A both-channels-failed row reports only one kind.** The main row shows a single failure kind (Cursor's IDE, Copilot's CLI, Cline's VS Code channel); the other channel's kind is visible only on its own sub-line. (Notable.)
- **Auth-token check honors the env variable**: the "Signed in" vs "Not signed in" line uses the same token-loading path as `jolli auth status`, so setting `JOLLI_AUTH_TOKEN` makes the user appear signed in.
- **Anthropic key check honors the env variable — in the one case where the row prints at all**: when the provider is explicitly Anthropic, `ANTHROPIC_API_KEY` set in the environment counts the same as a key written to the config file. Under any other provider the row is absent, so the environment variable has no visible effect on this report even when it is set.
- **The provider row and the vendor-key row are deliberately coupled.** `AI Provider:` is unconditional and `Anthropic Key:` is gated on it, so the report never asserts a credential state for a key the active provider would not consult. The consequence to know: a user who has an Anthropic key stored but has pinned the Jolli or local-agent provider sees no Anthropic row at all — the report describes what *will be used*, not everything that is stored. (Notable; intentional.)
- **Jolli Site row is conditional**: it is omitted when no site URL has been persisted, since there is nothing to print. When it does print, its label distinguishes a live tenant from a merely remembered one — an environment-injected auth token carries no tenant of its own, so pairing it with a stale stored site URL would otherwise render "Signed in" beside an unrelated tenant.
- **The Memory Bank row is read-only by construction.** Its active arm resolves the per-repository folder through a peek path rather than the claiming path, so *asking where the Memory Bank is* can never be what brings that folder into existence. Running `jolli status` in a directory that has never had a folder claimed leaves the disk untouched. (Notable; the full rationale and the wording table are spec 300's.)
- **The `--json` payload is unfiltered**: it includes fields that the human-readable view never shows (e.g. the per-source session breakdown raw counts, scan-error objects). The VS Code extension reads it directly and renders its own panel.
- **The Space-binding cache is shared with the guided front door**: a binding confirmed via bare `jolli` or a push renders `status`'s row with no network call, and vice versa; only a degraded state is never cached.
- **`--json` mode makes no Space-binding call at all** — the JSON payload has no Space-binding field, so there is nothing to resolve or cache in that mode.
- **`--json` mode also emits no onboarding-funnel snapshot.** The human-readable path emits an `onboarding_progressed` snapshot (spec 312) from the status object it has already computed, so the periodic funnel signal for an active user costs no extra work. But the emit sits *after* the `--json` early return, so the machine-readable mode — the one the editor surfaces call — is silent. This is the same shape as the Space-binding omission above: `--json` is not "the human report plus JSON", it is a separate, earlier exit that skips everything downstream of the snapshot. Those surfaces emit the snapshot themselves from their own status refresh, so the funnel is not blind there; it is simply not this command that reports it. (Notable.)

## Shared Behavior

- The `--cwd <dir>` flag is shared with most other `jolli` sub-commands. When omitted, the project directory is auto-resolved to the enclosing git repository root.
- The version string in the header is the same `VERSION` constant used by `jolli --version`.
- The per-agent state strings here intentionally match the labels used by the VS Code extension's sidebar STATUS tree (295) so users see the same wording in both surfaces. The merged-row masking rule is likewise identical across the three surfaces that render it: this command, that tree, and the MCP `status` tool (148).
- The `Memory Bank:` row's state model, its three arms, the shared wording table with every string verbatim, its three severity levels (of which this surface uses none), and the identical required field in the `--json` snapshot are all owned by spec 300. This spec owns only the row's position in the report and the fact that it is unconditional. The same table also drives the desktop editor's Memory Bank settings line, which is why the two surfaces cannot disagree about whether folder writes are landing.
- The credential-precedence resolution behind the `AI Provider:` row is the same resolution the LLM dispatcher applies per call (spec 10), and the same one the doctor's Config probe reports (spec 59) — the three surfaces share it so none of them can name a provider the others would not.
- The per-repo outbound-push opt-out behind the `Outbound push:` row — its store, its fail-closed read, its gate, and the other surfaces that control it — is owned by spec 310. This spec owns only the row's two wordings, its position, and its conditionality.
- The onboarding-funnel snapshot this command emits — its state tuple, dedup ledger, heartbeat, and consent gate — is owned by spec 312. This spec owns only that the human-readable path emits it from the already-computed status, and that `--json` returns before it.
- The MCP `status` tool reports the same per-agent rows in structured form. Because its flat per-integration descriptor carries the merged reading, a single-channel failure — which this command shows as a sub-line — travels there in a separate per-channel scan-error list; see 148.
