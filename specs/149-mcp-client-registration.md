# 149 — MCP Client Registration

## Topic Statement

During hook install or removal, the product writes (or removes) its own well-known server entry in the MCP server registry of every detected MCP-capable AI host, so that a host launched against this repository can spawn the product's MCP server. Hosts are split into repo-scoped (config inside the worktree, written and removed per worktree) and global-scoped (one machine-wide config shared by every repo, written once and never removed on a single-repo uninstall).

## Scope

**In scope**

- Adding a single, well-known server entry — named `jollimemory` — to each detected host's MCP registry.
- The set of supported hosts, each host's scope (repo vs global), the registry file each host uses, and the per-host entry key and entry shape.
- The shape, command, and arguments of the registry entry, and how they differ between POSIX and Windows hosts.
- Preserving any other server entries and any other top-level content the user has placed in the same registry file.
- Treating an unparseable existing registry file as off-limits (no overwrite).
- Removing only the product's own entry from repo-scoped hosts on uninstall, leaving global-scoped hosts untouched.
- Excluding repo-scoped registry files from the host repository's git working tree (recorded in the per-worktree git exclude list); global-scoped configs contribute no exclude entry because they live outside the repo.
- Per-worktree application of repo-scoped registration; once-per-install application of global-scoped registration.
- Non-fatal, per-host error isolation: a single host's registration or removal failure must not abort the surrounding install/uninstall pipeline or block the other hosts.

**Boundaries (out of scope)**

- The orchestration that invokes registration as one of many install steps — see the hook-installation-orchestration spec.
- The other per-worktree install steps that run in the same loop (Claude Code stop/session hooks, skill files) — see the Claude-Code-hook-installation spec and the skill installer.
- The user-facing enable command that may indirectly trigger installation — see the CLI enable command spec.
- The contents and runtime behavior of the MCP server itself once it has been spawned (its tool surface, transport, lifecycle) — see spec 148 (MCP server tool surface).
- The host-detection mechanism (how the product decides a given host is installed) — this spec consumes the detection result.
- The cross-source "winning dist path" resolution mechanism; this spec only consumes its result.
- The git-exclude file format/mechanism; this spec only contributes entries to it.

## Data Contracts

### Supported hosts and their registries

Ten hosts are supported. Each carries a scope that determines where its config lives and when it is written:

| Host | Scope | Registry file | Top-level key | Entry shape |
|---|---|---|---|---|
| Claude Code | repo | `.mcp.json` at the worktree root | `mcpServers` | `{ command, args }` (custom merge that preserves other servers) |
| Cursor | repo | `.cursor/mcp.json` at the worktree root | `mcpServers` | `{ command, args }` |
| Gemini CLI | global | user-global Gemini settings file | `mcpServers` | `{ command, args }` |
| Codex | global | user-global Codex TOML config | `mcp_servers` (TOML table, underscore) | `command` + `args` |
| OpenCode | global | user-global OpenCode config | `mcp` | `{ type: "local", command: [command, …args], enabled: true }` (single combined command array) |
| GitHub Copilot CLI | global | user-global Copilot config | `mcpServers` | `{ command, args }` |
| VS Code Copilot Chat | global | a file under the VS Code user-data directory | `servers` | `{ type: "stdio", command, args }` |
| Cline (VS Code extension) | global | `settings/cline_mcp_settings.json` under the extension's globalStorage, written once per VS Code flavor that hosts the extension | `mcpServers` | `{ command, args }` |
| Devin CLI | global | user-global Devin config (`~/.config/devin/config.json`, the `user` scope of `devin mcp add`) | `mcpServers` | `{ command, args, transport: "stdio" }` |
| Antigravity | global | user-global Antigravity MCP config (`~/.gemini/config/mcp_config.json`) | `mcpServers` | `{ command, args }` (stdio is inferred from the presence of `command`; no transport/type field) |

The Cline CLI (`~/.cline`) is deliberately **not** an MCP host — it ships no MCP config file; only the Cline VS Code extension does. Cline's registry lives per VS Code flavor (Code, Cursor, VSCodium, …), and the extension may be installed under more than one, so registration writes every flavor's settings file that hosts the extension (and removal clears every flavor's).

The well-known server name / key is `jollimemory` in every registry. Other entries under the host's server map, and all other top-level properties of the document, are opaque to this topic and must round-trip untouched.

### The product's spawn descriptor (command + args)

The core spawn descriptor is computed once per registration and depends on the host operating system:

- **POSIX hosts (macOS, Linux, etc.):** `command` is the absolute path of the machine-global dispatch script that resolves and execs the active product distribution; the argument list is the single literal token that selects the MCP-server subcommand.
- **Windows hosts, when an active distribution can be located:** `command` is the literal `node` (relied upon to be on `PATH` because the product's other hooks already require it); the arguments are the absolute path of the active distribution's main entry script, followed by the literal MCP-server subcommand token.
- **Windows hosts, when no active distribution can yet be located:** falls back to the POSIX shape (dispatch-script path + subcommand token), even though that descriptor will fail to spawn on Windows. The rationale is to avoid writing a known-broken `node` invocation with no script path; the next install/enable run rewrites a working descriptor once an active distribution is registered. (On the normal install path this branch is effectively unreachable, because the dist-path entry is written and verified before any MCP registration runs.)

Each host then adapts this `{ command, args }` pair into its own entry shape per the table above (e.g. OpenCode folds command and args into one array and adds a type/enabled wrapper; Codex emits TOML; Copilot Chat adds a `type: "stdio"` field).

### Git-exclude contribution

Each repo-scoped host contributes a single fixed pattern — its registry filename, anchored to the worktree root (`/.mcp.json` for Claude, `/.cursor/mcp.json` for Cursor) — to the worktree's git-exclude list, alongside the product's skill paths. Global-scoped hosts contribute nothing, because their configs live outside the repository. The repo-scoped registry files are treated as machine-local because their descriptors encode absolute paths from the writing host.

## Behavior

### Trigger points

- **Repo-scoped registration** runs as a per-worktree step of the install pipeline, after the per-worktree skill update and git-exclude update. It runs **before** the Claude-enabled hook gate, so a user who has disabled Claude integration still gets repo-scoped MCP registered for other detected repo hosts (e.g. Cursor). Each repo host is gated on its own detection; Claude's "detected" state mirrors the Claude-enabled config flag.
- **Global-scoped registration** runs **once** per install (not per worktree), after the worktree loop completes, gated only on each global host's detection. Writing it once avoids rewriting the same machine-wide file on every worktree iteration.
- **Removal** runs as a per-worktree step of the uninstall pipeline, after Claude and Gemini hook removal in the same per-worktree loop. It removes the entry from **repo-scoped hosts only**, treating every repo host as if detected (so an uninstall cleans up a host registered by a previous install even if not detected now). Removal is unconditional with respect to the Claude-enabled flag. Global-scoped hosts are deliberately **never** removed.

### Registration into a JSON registry (per host)

1. Compute the registry path for the host.
2. Attempt to read and JSON-parse the file:
   - If reading fails with a "file not found" error: treat as an empty document and proceed.
   - If reading or parsing fails for **any other reason** (permission denied, partial write, mid-edit syntax error, etc.): log a warning naming the path, do **not** write anything, and return successfully. Re-registration on the next install/enable recovers once the file is valid.
   - Otherwise: use the parsed document.
3. Take the existing server map under the host's top-level key if present; otherwise start an empty map.
4. Construct the product's spawn descriptor according to the host platform (resolving the Windows entry-script path via the winning-dist-path selector when needed), then adapt it into the host's entry shape.
5. Set the `jollimemory` key in the server map to the new entry, replacing any previous value. Re-registration is a refresh, not a duplication.
6. Construct the next document by preserving the parsed document and replacing its server-map field with the updated map. Other top-level properties are preserved.
7. Serialize as pretty-printed JSON (two-space indent, trailing newline) and write the file with a single full-file write.

The Codex TOML host follows the same read-preserve-replace-write discipline against a hand-written TOML document instead of JSON.

### Removal from a registry (per repo-scoped host)

1. Compute the registry path.
2. Attempt to read and parse the file. If either step fails for **any** reason (including "file not found"): return silently — there is nothing to remove.
3. If the parsed document has no server map under the host's key, or the map has no `jollimemory` key: return without writing.
4. Delete the `jollimemory` key from the map.
5. Serialize and write the resulting document with a single full-file write. Other server entries and other top-level properties are preserved.

### Per-host error isolation

Both registration and removal iterate their host list with per-host isolation: a failure in one host is logged as a warning naming the host and the worktree (or the global pass) and is swallowed so the remaining hosts — and the surrounding install/uninstall pipeline — continue. This means a read-only or otherwise unwritable registry file for one host cannot block registration of the others, nor can it block removal of the shared git hooks (which would otherwise leak and keep firing after the user believed they had uninstalled).

### Git-exclude contribution

Independently of read/write success above, the install pipeline records each detected repo-scoped host's registry filename (anchored to the worktree root) in the worktree's git-exclude list during the same per-worktree iteration that performs registration. The exclude set is the union of the active registrars' contributed patterns. Uninstall does **not** remove these exclude entries — leftover ignore patterns are harmless when no matching file exists, and conservative cleanup avoids touching neighboring user-managed exclude entries.

### Working-directory binding

No registered command is worktree-bound. The descriptor instructs the MCP host to spawn either the machine-global dispatch script (POSIX) or `node` against a machine-global distribution entry script (Windows). The product determines the working repository at MCP-server runtime from the MCP host's own current working directory at spawn time, not from anything encoded in the descriptor.

### Cross-platform notes

- The MCP host is assumed to spawn the registered `command` directly, with no shell interpretation. On POSIX the dispatch script's shebang and executable bit are load-bearing for direct spawn; on Windows an extensionless POSIX-style dispatch script is unspawnable, which is the entire reason the Windows branch substitutes `node` against the resolved entry script.
- On Windows the descriptor embeds an **absolute** distribution path that is invalidated by a future version bump; correctness relies on re-registration running on the next install/enable to rewrite the path. The POSIX descriptor stays valid across version bumps because the dispatch script resolves the active distribution at every spawn.
- The Windows-with-no-resolvable-distribution descriptor is written knowing it will fail to spawn; it exists only to defer correctness to the next install/enable run.

## State Transitions

For each registry, the `jollimemory` entry has three observable states:

- **Absent** — no `jollimemory` key (registry file may or may not exist).
- **Registered (POSIX shape)** — present with dispatch-script command.
- **Registered (Windows shape)** — present with `node` command and absolute entry-script argument.

Transitions:

| From | Event | To | Notes |
|---|---|---|---|
| Absent | install/enable on POSIX, host detected | Registered (POSIX shape) | creates file if missing |
| Absent | install/enable on Windows, host detected, distribution resolvable | Registered (Windows shape) | creates file if missing |
| Absent | install/enable on Windows, host detected, distribution not resolvable | Registered (POSIX shape, broken on Windows) | rewritten on next install/enable |
| Registered (any shape) | install/enable on same platform with same active distribution | Registered (same shape, identical content) | idempotent refresh |
| Registered (POSIX shape) | install/enable on Windows with resolvable distribution | Registered (Windows shape) | shape switch |
| Registered (Windows shape) | install/enable on Windows with newer distribution | Registered (Windows shape, updated absolute path) | absolute path refresh |
| Registered (any shape), repo-scoped host | uninstall | Absent | other server entries preserved |
| Registered (any shape), global-scoped host | uninstall | Registered (unchanged) | global hosts are never removed on uninstall |
| Registered (any shape) | install/enable while registry file is malformed | unchanged | registration skipped for that host, warning logged |
| Registered (any shape) | uninstall while registry file is malformed or unreadable | unchanged | removal silently no-ops |
| Absent (no file) | uninstall | Absent (no file) | silent no-op |
| Registered (any shape) | install/enable while host no longer detected | unchanged | registration skipped for an undetected host |

## Notable Behavior

- **Registration is multi-host, split by scope.** Repo-scoped hosts (Claude, Cursor) are written per worktree; global-scoped hosts (Gemini, Codex, OpenCode, Copilot CLI, Copilot Chat, Cline, Devin, Antigravity) are written once per install. The split exists because a global config is shared by every repo on the machine. (Notable.)
- **Global-scoped hosts are never removed on a single-repo uninstall.** Their `jollimemory` entry is machine-wide, so removing it would break MCP for every other repo still using Jolli. A stale global entry is harmless (idempotently refreshed on the next install) and far preferable to cross-repo breakage. Only repo-scoped hosts are cleaned up. This same removal path is the one invoked by the machine-wide uninstall command's current-repo item — see the CLI machine-wide uninstall spec — so a full machine-wide uninstall still never removes a global host's entry. (Surprising; intentional.)
- **Each host is gated on its own detection** (Claude's detection mirrors the Claude-enabled flag), so registration is skipped for hosts the user has not installed. Repo-scoped registration runs before the Claude-enabled hook gate, so a Cursor user with Claude disabled still gets MCP registered. (Notable.)
- **Malformed registry is never overwritten.** A parse failure on an existing file is treated fundamentally differently from a missing file: writing a fresh empty document would silently drop every other MCP server the user configured by hand, so the behavior is to log and leave the file untouched, deferring recovery to the user fixing it. (Notable.)
- **Removal silently no-ops on read failure.** Unlike registration, removal does not warn on parse or read errors — it cannot lose user content because it only ever deletes one well-known key, and the worst case is a leftover stale entry. (Notable.)
- **Re-registration replaces, never duplicates.** Because the entry lives under a single fixed key, repeated install runs always produce a single entry whose contents are refreshed in place. (Notable.)
- **The repo-scoped registry files must not be committed.** They contain machine-local absolute paths, so the install pipeline contributes their filenames to the worktree's git-exclude list. Uninstall leaves those exclude entries behind, intentionally — they are inert when the file is absent. (Notable.)
- **Per-host error isolation is non-fatal at the orchestration boundary.** A read-only or unwritable registry for one host yields a logged warning but never blocks the other hosts or the surrounding install/uninstall — in particular it cannot prevent removal of the shared repository-level git hooks. (Notable.)
- **Hosts differ in their per-entry envelope.** OpenCode requires a `type: "local"` wrapper and a single combined command array (split command/args is rejected by its loader); Codex uses an underscore table key in TOML; Copilot Chat adds a `type: "stdio"` field; Devin adds a `transport: "stdio"` field; Antigravity needs neither (it infers stdio from the presence of `command`). The well-known `jollimemory` key and the underlying command/args are the same across all hosts; only the per-host envelope differs, so a shape correct for one host is a silent no-op if written to another. (Notable.)
- **Windows fallback writes a knowingly-broken descriptor.** When no active distribution is yet registered on a Windows host, the POSIX-shaped descriptor written cannot spawn; it exists purely to defer correctness to the next install/enable run. (Surprising; intentional.)
- **Writes are full-file overwrites, not appends or patches.** No backup file and no temp-file-then-rename atomicity is used. A crash mid-write can leave a truncated registry file, which the next install treats as malformed and leaves alone — the user must repair it by hand. (Notable.)
- **The JVM IDE plugin is a consumer of this mechanism, not a reimplementation of it.** The plugin runs its own native git hooks and generates memory without Node, so it installs **no** Node hooks — but MCP and the skills are inherently Node programs, so the plugin drives the bundled command-line tool's "enable integrations-only" as a subprocess (dispatch scripts + dist-paths + MCP registration + skills, **no** hooks) rather than writing any registry file itself. It runs that subprocess in the project directory, so the repo-scoped hosts land in the project root exactly as for a CLI-driven install; the global-scoped hosts land in their machine-wide files. Consequently, any future change to registration behavior applies to the plugin with **no plugin-side change**. This corrects the earlier assumption that the JVM plugin registers no MCP. (Notable.)
- **The JVM plugin's integrations run is gated and self-healing.** It re-runs the enable subprocess when the plugin version changes (a version stamp is written only after a confirmed success, so a failed or interrupted run is retried) and, additionally, when the repo-scoped registry has gone stale in a way the version gate cannot see — specifically a Windows-shape entry whose baked absolute distribution path no longer exists on disk (e.g. the distribution that won selection at registration time was later removed). When Node is absent the whole integrations step is a clean no-op with a user-facing warning; memory generation keeps working via the native hooks. Teardown drives the tool's "disable integrations-only" as a best-effort subprocess. (Notable.)

## Shared Behavior

- **Worktree enumeration** is provided by the host repository's git worktree listing and is shared with every other per-worktree install/uninstall step. See the hook-installation-orchestration spec.
- **Machine-global config directory resolution** and the **dispatch-script filename** are shared with the hook entry-script pipeline.
- **"Winning dist path" selection** (highest-version available distribution across all registered sources) is shared with the runtime hook dispatcher. The Windows branch consumes the same selector to bake an absolute entry-script path into the descriptor.
- **Per-worktree git-exclude maintenance** is shared with the skill installer; repo-scoped hosts contribute their registry-filename patterns to the same exclude-block update call.
- **Non-fatal-per-step orchestration policy** (warn, log, continue) is shared with several other install steps. This topic adheres to it on both register and remove, with the addition of per-host isolation within the registration step itself.
- **The product's MCP-server runtime** that the registered descriptor invokes is documented separately — see spec 148 (MCP server tool surface).
- **The JVM IDE plugin** consumes this registration mechanism through a subprocess to the bundled command-line tool's integrations-only enable/disable (not a Kotlin port), so it inherits this spec's host set, scopes, entry shapes, and per-host isolation without a separate implementation. The subprocess requires a Node runtime at enable time; the plugin's own memory generation does not.
