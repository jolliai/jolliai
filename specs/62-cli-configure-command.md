# 62. `jolli configure` — Manage configuration values

## Topic Statement

The `jolli configure` command sets, removes, lists, and displays per-user configuration values, with type coercion and per-key validation applied at save time.

## Scope

This spec covers the user-facing behavior of `jolli configure`: invocation forms, the set of valid keys, the type coercion rules per key, the per-key validation rules, the masking applied to sensitive values when displaying, and the exit code policy. It does not cover the on-disk format of the config file (an internal detail).

## Data Contracts (output)

The command always writes to stdout in a multi-line, two-space-indented, label-aligned format:

- **`--list-keys`** prints a header `Available config keys:` followed by one line per key in the form `<key padded to 20> (<type padded to 9>) <description>`, then two trailing usage lines for `--set` and `--remove`.
- **`--set` / `--remove`** prints exactly one line on success: `Config updated: <absolute path of config file>`. On failure, the error line is printed to stderr and no other output is produced.
- **No flags** prints a header `Jolli Memory Configuration`, the separator, a `Location: <absolute path>` line, then one line per stored key in the form `<key padded to 20> <displayed value>`. When the config is empty, a single line `(empty — no configuration set)` appears instead of the per-key lines.

## Behavior

### Invocation forms

- `jolli configure` — display the current configuration with sensitive values masked.
- `jolli configure --set <key=value>` — set a single key. Repeatable: multiple `--set` flags in one invocation are all applied as a single atomic update.
- `jolli configure --remove <key>` — clear a single key. Repeatable, and may be combined with `--set` in the same invocation.
- `jolli configure --list-keys` — list every recognized key with its type and description, then return without touching the config.

### Valid keys

Exactly the following keys are accepted by `--set` / `--remove` / `--list-keys`. Any other key is rejected.

| Key | Type | Notes |
|-----|------|-------|
| `apiKey` | string (sensitive) | Anthropic API key. |
| `model` | string | LLM model name. |
| `maxTokens` | number | Token budget for LLM calls. Must be a positive integer. |
| `jolliApiKey` | string (sensitive) | Jolli Space API key (`sk-jol-…`). |
| `authToken` | string (sensitive) | OAuth token from browser login. |
| `codexEnabled` | boolean | Enable Codex session discovery. |
| `geminiEnabled` | boolean | Enable Gemini session tracking. |
| `claudeEnabled` | boolean | Enable Claude Code session tracking. |
| `openCodeEnabled` | boolean | Enable OpenCode session discovery. |
| `cursorEnabled` | boolean | Enable Cursor session discovery — Composer IDE and cursor-agent CLI (one shared toggle). |
| `copilotEnabled` | boolean | Enable Copilot CLI session discovery. |
| `clineEnabled` | boolean | Enable Cline session discovery — VS Code extension and CLI (one shared toggle). |
| `devinEnabled` | boolean | Enable Devin CLI session discovery. |
| `antigravityEnabled` | boolean | Enable Antigravity session discovery. |
| `kimiEnabled` | boolean | Enable Kimi Code CLI session discovery. |
| `mcpPlatformToolsEnabled` | boolean | Register backend-defined Jolli-platform tools in the MCP server. On by default (like the other `*Enabled` keys); set `false` to opt out. |
| `globalInstructions` | enum | Machine-global skill-preference block switch. One of `enabled`, `disabled`. Setting it has an immediate side effect beyond `config.json` (see "Immediate side effect: `globalInstructions`" below). |
| `logLevel` | enum | One of `debug`, `info`, `warn`, `error`. |
| `excludePatterns` | string array | Glob patterns, comma-separated on input. |
| `localFolder` | string | Absolute path to the Memory Bank folder (per-machine). |
| `aiProvider` | enum | AI summary provider. One of `anthropic`, `jolli`, `local-agent`. |
| `localAgentTool` | enum | Which local agent CLI to drive when `aiProvider=local-agent`. One of `claude-code`, `codex`, `cursor-agent`, `opencode`, `kimi`. |
| `localAgentPath` | string | Explicit path to the local agent binary, overriding search-path discovery. |
| `syncTranscripts` | boolean | Include raw AI conversation transcripts in cloud sync. |
| `syncPollIntervalSec` | number | Sync poll interval in seconds. Must be a positive integer clamped to the range `5400`–`86400` (90 min floor, 24h ceiling). |
| `syncOnPush` | boolean | Auto-sync pushed commits' memory to Jolli Space on every git push. |
| `backupFolder` | string | Absolute path of the directory snapshots are written to. Heavily validated at save time, and the only key whose validation has a filesystem side effect (see below). **Undocumented by `--list-keys`.** |
| `backupRetentionDays` | number | How many days of snapshots to keep. Must be an integer of at least one — zero is refused outright, because it reads as "no backups" rather than as a retention policy. **Undocumented by `--list-keys`.** |
| `slack.workspaceUrl` | string | A dotted pseudo-key, not a top-level configuration field (see "Dotted pseudo-keys" below). Fallback base address used to reconstruct a Slack thread's shareable link when none was pasted into the conversation. |

**`--list-keys` documents a strict subset of what `--set` accepts.** The two backup keys above are accepted, coerced and validated exactly like any other key, and appear in neither the listing nor its usage lines — so the only way to discover them is to already know their names. The listing also orders its entries differently from the accept-list, so the two are not a reordering of each other. (The listing is a static help table; the accept-list is what actually gates a write.)

Several fields the configuration carries are deliberately **not** in the accept-list and are rejected as unknown keys, including the tenant site (written only as a side effect of setting a Jolli API key — see below), the compile-exclusion list, the storage mode, the commit sign-off flag, the auto-sync flag, the install identifier, and every telemetry field. Three of those — the compile-exclusion list, the sign-off flag and the auto-sync flag — are editable from the desktop-editor settings surface, so the two surfaces are not subsets of one another in either direction.

### Dotted pseudo-keys

Every valid key above is a top-level configuration field, with one exception: `slack.workspaceUrl` is a **dotted pseudo-key**. It does not correspond to a top-level field on the stored configuration; instead, its value is nested one level down. Handling this shape costs three deviations from the plain-key path, all applied only to this one key:

- **List/validate as a single unit.** The key is still accepted or rejected as a whole by `--list-keys`, `--set`, and `--remove` exactly like any other key — the caller never types a nested path with more than one dot, and the command never exposes the nested field's sibling(s) as separately settable keys.
- **Read-modify-write before persisting.** Because the underlying persistence merges only at the top level, a bare "set the nested container to a fresh object holding just this field" would silently drop any other nested field already stored alongside it. Before the batch is persisted, the current configuration is read back and its existing nested container (if any) is spread into a new object together with the new value, so unrelated sibling fields survive.
- **Removal clears the whole pseudo-key's value, not necessarily the container.** `--remove slack.workspaceUrl` clears the nested field the same way `--set` would set it to absent, going through the same read-modify-write step.

Nothing else about invocation, batching, atomicity, or exit codes differs for a dotted pseudo-key versus a plain one.

### Type coercion (input → stored value)

The `value` portion of `--set key=value` is a single string from the command line. Coercion is applied per key:

- **`maxTokens`** — parsed as a finite integer greater than zero. Strict parsing rejects non-numeric suffixes (e.g. `8192abc` is rejected, not silently truncated to `8192`). Failure: `maxTokens must be a positive integer (got: <raw>)`.
- **`syncPollIntervalSec`** — parsed as a finite integer greater than zero, then clamped to the range `5400`–`86400`. A value below `5400` fails with `syncPollIntervalSec must be at least 5400 (90 min) to avoid excessive sync push frequency (got: <raw>)`; a value above `86400` fails with `syncPollIntervalSec must be at most 86400 (24h) (got: <raw>)`; a non-integer fails with `syncPollIntervalSec must be a positive integer (got: <raw>)`.
- **`backupRetentionDays`** — parsed the same strict way, then required to be an integer of at least one. Failure: `backupRetentionDays must be an integer >= 1 (0 is refused — it reads as 'no backups') (got: <raw>)`.
- **Boolean keys** (`codexEnabled`, `geminiEnabled`, `claudeEnabled`, `openCodeEnabled`, `cursorEnabled`, `copilotEnabled`, `clineEnabled`, `devinEnabled`, `antigravityEnabled`, `kimiEnabled`, `mcpPlatformToolsEnabled`, `syncTranscripts`, `syncOnPush`) — case-insensitive. `true`, `1`, `yes` → `true`; `false`, `0`, `no` → `false`. Anything else is rejected: `<key> must be true/false (got: <raw>)`.
- **`logLevel`** — must be exactly one of `debug`, `info`, `warn`, `error`. Failure: `logLevel must be one of: debug, info, warn, error (got: <raw>)`.
- **`aiProvider`** — must be exactly one of `anthropic`, `jolli`, `local-agent`. Failure: `aiProvider must be one of: anthropic, jolli, local-agent (got: <raw>)`.
- **`localAgentTool`** — must be exactly one of `claude-code`, `codex`, `cursor-agent`, `opencode`, `kimi`. Failure: `localAgentTool must be one of: claude-code, codex, cursor-agent, opencode, kimi (got: <raw>)`. The accepted set and the order it is listed in are **derived from the single agent-tool registry** that also supplies each tool's display name and sign-in hint, so this key's accepted values cannot drift from the tools the setup picker offers (spec 57) or the ones the runtime can actually drive (spec 280). Adding a tool to that registry widens this key with no edit here.
- **`globalInstructions`** — must be exactly one of `enabled`, `disabled`. Failure: `globalInstructions must be one of: enabled, disabled (got: <raw>)`.
- **`excludePatterns`** — split on `,`, each part trimmed, empty parts dropped. Stored as a string array.
- **String keys** (`apiKey`, `model`, `jolliApiKey`, `authToken`, `localFolder`, `localAgentPath`) — stored as-is. The `=` sign that delimits key and value is matched on the **first** occurrence, so values containing `=` (e.g. base64-padded tokens) are preserved verbatim.
- **`slack.workspaceUrl`** — parsed as a URL; see "Per-key validation" below, since for this key validation and coercion are the same step (the value that comes out of a successful parse is not the raw input but a normalized form).

### Per-key validation

Validation runs **after** coercion and **before** writing to disk, with one exception noted below. A failed validation prevents the entire `--set` / `--remove` batch from being persisted (the update is atomic) and exits with code `1`.

- **`jolliApiKey`** — the value (after coercion) is parsed and rejected if the embedded tenant URL is outside the Jolli origin allowlist or if the shape is unrecognized. The same validation runs at save time everywhere a Jolli API key can be stored, so `configure --set jolliApiKey=…` and the OAuth callback share one rejection rule. This key also has a **second write** — see "Setting a Jolli API key also writes the tenant site" below.
- **`backupFolder`** — the most heavily validated key, and the only one whose validation *touches the filesystem*. The value is rejected when it is not absolute, when it contains a parent-directory segment, when it falls under the product's own machine-global directory or the live database's directory, when it lies **inside the Memory Bank folder**, when it lies **inside any git worktree** (a working-tree clean would delete the snapshots), and finally when the directory is not writable. That last check is a real write probe, and it is placed **last on purpose** so a value rejected by any earlier rule leaves nothing behind on disk. Each failure carries its own message; the worktree one names the reason explicitly.
- **`slack.workspaceUrl`** — this key's validation is folded into its coercion step rather than running as a separate pass, but the effect is the same "reject before persisting" guarantee:
  1. The raw value must parse as a URL at all; a value that fails to parse is rejected.
  2. The parsed URL's scheme must be exactly `https:`.
  3. The parsed URL's host must be `slack.com` or a dot-subdomain of `slack.com` (a suffix-boundary check, the same shape of rule used by the Jolli-API-key origin allowlist — see the shared-behavior note below).
  4. Either failure produces the identical error message: `slack.workspaceUrl must be an https://<workspace>.slack.com URL (got: <raw>)`.
  5. On success, the value actually persisted is **not** the raw input — it is the **normalized origin**: scheme plus host only, with no trailing slash and no path. This matters because the persisted value is later concatenated with a channel id and timestamp to reconstruct a thread link (see spec 256); normalizing away any trailing slash or stray path at save time guarantees that reconstruction can never produce a doubled slash or an unexpected path prefix.
- Other keys are not subject to per-key validation beyond their coercion rules.

### Argument parsing failures

- `--set foo` (no `=`) → `Error: --set expects key=value, got: foo`. Exit `1`.
- `--set unknownKey=value` or `--remove unknownKey` → `Error: unknown config key: <key>` followed by a `Valid keys: <list>` line. Exit `1`.
- A failure on any one `--set` or `--remove` aborts the whole batch; nothing is persisted.

### Display behavior (no flags)

When run without flags, the command prints the current configuration. Sensitive keys are masked as follows when their value is a string:

- Length ≤ 10 characters → displayed as `***`.
- Length > 10 characters → displayed as `<first 6 chars>…<last 4 chars>` (with a Unicode ellipsis between the prefix and suffix).

Non-sensitive keys are displayed verbatim, with arrays joined as `, `-separated lists.

The sensitive set is `apiKey`, `jolliApiKey`, `authToken`. Other secret-shaped strings (e.g. `model` if it accidentally contained one) are not masked.

### Combined operations

A single invocation may combine `--set` and `--remove` flags freely. They are merged into one update record and persisted atomically: removed keys become absent in the resulting config, set keys take their new values, and any unrelated existing keys are left alone.

### Immediate side effect: `globalInstructions`

Setting or removing `globalInstructions` is the one config key whose update has a side effect **outside** `config.json`, applied **synchronously before the `Config updated:` line is printed**. After the batch is persisted, if the update touched `globalInstructions` (by `--set` or by `--remove`), the machine-global skill-preference sync runs immediately (see spec 242):

- `--set globalInstructions=enabled` → the skill-preference block is written into every detected/enabled AI host's global instruction file (`~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md`, `~/.codex/AGENTS.md`) right away.
- `--set globalInstructions=disabled` → any existing block is removed from those files right away.
- `--remove globalInstructions` → the field is cleared to undecided; the sync still runs but resolves to a no-op (nothing written or removed), since undecided never touches the block.

This is the CLI-side opt-in surface for the block, mirroring the VS Code Settings toggle. The block is written only because the user explicitly set this key here — it is never written by a bare `jolli enable`, which only *applies* an already-persisted decision. The block content, target files, and host gating are spec 241; the tri-state switch semantics are spec 242.

### Setting a Jolli API key also writes the tenant site

`jolliApiKey` is the one key whose successful `--set` writes **two** fields. The key's own payload encodes the tenant address it belongs to; that address is decoded, checked against the same origin allowlist, stripped of any trailing separator, and persisted alongside the key as the tenant site.

This is required rather than a convenience: requests route on the address carried *inside* the key, while several read-only surfaces — including this command's own display, the status report and the guided front door — deliberately never decode a key, and report the separately-stored site instead. A surface that persisted one without the other would split the product in half silently, with the drift invisible on exactly the surfaces that would have shown it.

Three details are load-bearing:

- The site is written **only when the same invocation actually persists a key**. `--set jolliApiKey=<new> --remove jolliApiKey` in one invocation removes the key and, correctly, does **not** leave the removed key's tenant site behind.
- A key that cannot be decoded, or that decodes to an address outside the allowlist, contributes **no** site — the previously stored one is left alone rather than being cleared.
- The tenant site is **not itself a settable key**, so there is no "an explicit set wins over the derived value" rule to get wrong. Making it settable would require adding one.

### Coupling between `localAgentTool` and `localAgentPath`

These two keys are not independent at save time, and this command is one of several writers subject to the rule rather than its owner (spec 308 owns it). The shared write path applies one invariant on every configuration write, whoever performs it:

- An update that **changes the effective value of `localAgentTool`** and does **not** itself supply `localAgentPath` also **clears** any stored `localAgentPath`, because that path names one specific tool's binary and records no owner.
- Supplying **both keys in the same update** keeps the incoming path — that is how a tool and its explicit binary are configured together. On this command, that means `--set localAgentTool=… --set localAgentPath=…` in one invocation (the flags are repeatable and merged into a single atomic update) preserves the path, whereas setting the tool alone discards it.
- Re-writing the **same** tool value never discards a path, so an idempotent write is safe.
- Key **presence** is what counts, not whether a value is defined. `--remove localAgentTool` is therefore a *change* to the tool key (back to the default) and will clear a stored path if the previous tool was not already the default; `--remove localAgentPath` on its own touches nothing else.

The practical consequence for this command: after `--set localAgentTool=…` alone, a subsequent `jolli configure` display will show no `localAgentPath`, even though the user never removed it.

### Configuration scope

The configuration is global to the user, not per-project. There is no `--cwd` flag on `configure`. The path printed by `Config updated:` and `Location:` is the global config file inside the user's home Jolli directory.

## Exit Codes

| Code | Condition |
|------|-----------|
| `0`  | Configuration was displayed, listed, set, or removed successfully. |
| `1`  | A `--set` argument lacked `=`, **or** an unknown key was passed to `--set`/`--remove`, **or** a value failed coercion (e.g. non-positive integer for `maxTokens`), **or** the `jolliApiKey` value failed origin-allowlist validation, **or** the `backupFolder` value failed any of its location or writability rules, **or** the `slack.workspaceUrl` value failed URL-shape/host validation. |

Every failure path sets the exit code and returns rather than throwing, so no stack trace is ever printed and the generic fatal-error handler is not involved. Failures print only to standard error; nothing is written to standard output.

`--list-keys` short-circuits ahead of everything else, so it wins even when `--set` or `--remove` were passed in the same invocation — those are silently not applied.

## Notable Behavior

- **Save-time validation is the only line of defense.** A rejected value is never persisted; partial batches are not allowed.
- **The first `=` is the delimiter.** This is important for `--set authToken=eyJ…==`, where the value itself ends with `=` characters.
- **`--list-keys` does not read or write the config file.** It is a static help-style listing.
- **Removing a key writes the absence to disk.** Subsequent display omits the key entirely; subsequent `--remove` of the same key is a no-op.
- **The default boolean for *Enabled keys is "enabled".** A key that is absent from the config is treated as `true` by the rest of the system; setting it to `false` is the only way to opt out of an integration.
- **Display masking is recognizability-preserving.** The first 6 and last 4 characters are kept so a user can confirm at a glance which key is stored without exposing the full secret in screenshots or logs.
- **`globalInstructions` is the only key whose *successful set* has a filesystem side effect.** Every other key's set only mutates the configuration file; setting this one also writes to or removes from the AI hosts' global instruction files as part of the same command, synchronously, before the success line prints.
- **But `backupFolder` has a filesystem side effect during *validation*, and it is not transactional.** Its writability check creates the directory. Validation runs per `--set` entry, inside the loop, while the persist happens once at the end — so a `--set backupFolder=…` that passes, followed by a later `--set` that fails, leaves the created directory on disk with **nothing persisted**. That is the one residue the otherwise all-or-nothing batch can leave. (Surprising.)
- **Setting any key at all silently migrates one legacy field.** The read that precedes every write folds a retired sync flag onto its replacement and deletes the retired name from the in-memory object — and that same object is what gets written back. So an unrelated `--set` rewrites the file with the old name gone. (Notable.)
- **There is no way to read one key.** There is no `--get`; the bare form dumps the entire stored configuration, including keys `--set` cannot write.
- **Two stored shapes display unreadably.** The bare form stringifies any non-array value, so the nested container behind the dotted pseudo-key and the per-logger level overrides both render as an opaque object marker. `slack.workspaceUrl` is therefore settable but not readably displayable. (Surprising.)
- **Setting `localAgentTool` alone silently clears `localAgentPath`.** It is the one key whose update can remove a *different* key's value, and the removal is not reported in this command's one-line success output. Batching both keys in the same invocation is the way to keep the path — see the coupling section. This command is also the only surface that can *set* an explicit path at all; every other writer of the tool key either omits the path or clears it.

## Shared Behavior

- The Jolli-API-key validation rule (origin allowlist + recognized shape + HTTPS-only with suffix-boundary host check) is the same rule used everywhere a Jolli API key can be stored in the CLI, the VS Code extension, and the IntelliJ plugin. The paired tenant-site write is likewise required of every surface that persists a pasted key.
- `slack.workspaceUrl` is the one setting that was **dropped** from both IDE surfaces rather than moved: neither the desktop-editor settings panel nor the IntelliJ dialog carries a field for it, and both leave an already-stored value untouched when they save. This command is the only way to set it.
- The `slack.workspaceUrl` validation rule (HTTPS-only + suffix-boundary host check) mirrors the shape of the Jolli-API-key validation rule above, applied to the `slack.com` host family instead of the Jolli origin allowlist.
- The `localAgentTool` accepted set is the single agent-tool registry shared with the interactive provider setup picker (spec 57), the diagnostic command's credential label and sign-in hints (spec 59), and the runtime backend that actually drives the chosen tool (spec 280).
- The tool/path clearing invariant applied to this command's writes is owned by spec 308, which also lists the other writers subject to it; how a stored path is attributed to a tool at read time is spec 280. The diagnostic command's failure message names `--remove localAgentPath` as its remedy (spec 59).
- The set of valid keys is kept in lockstep with the configuration type used internally; adding a new field there requires adding it to this command's whitelist before users can set it.
- The path printed by `Config updated:` and `Location:` is the same global path printed by `jolli enable`'s skip-and-configure-later guidance.
- The persisted `slack.workspaceUrl` value is read back and used, as one of two link-resolution fallbacks, by the Slack thread-reference capture pipeline (spec 256), which reconstructs a thread's shareable link from this base address when no permalink was pasted into the conversation.
