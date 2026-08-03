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
- The **reading-side** host predicate — the "is this host installed *and* can this runtime read its conversation store" question that drives session discovery, the status tree, and the auto-enable discovery toggles. That predicate belongs to the per-source transcript-reading specs. This spec owns the **MCP-registration** predicate for each host, which is a distinct question asked only for this purpose, and it owns the deliberate divergence between the two (see *Presence versus readability*).
- The cross-source "winning dist path" resolution mechanism; this spec only consumes its result.
- The git-exclude file format/mechanism; this spec only contributes entries to it.

## Data Contracts

### Supported hosts and their registries

The supported hosts are the rows of the table below. Each carries a scope that determines where its config lives and when it is written, and each carries its own MCP-registration predicate — the question asked to decide whether that host gets an entry at all:

| Host | Scope | Config path | Entry envelope | MCP detection predicate |
|---|---|---|---|---|
| Claude Code | repo | `<worktree>/.mcp.json` | key `mcpServers`; entry `{ command, args }`, written by a custom merge that preserves every other server and every other top-level property | the Claude integration toggle is not explicitly disabled — **no filesystem probe at all** |
| Cursor | repo | `<worktree>/.cursor/mcp.json` | key `mcpServers`; entry `{ command, args }` | Cursor's global editor state store (`<Cursor user-data dir>/User/globalStorage/state.vscdb`) exists and is a regular file — no embedded-database runtime gate |
| Gemini | global | `~/.gemini/settings.json` | key `mcpServers`; entry `{ command, args }` | `~/.gemini` exists and is a directory |
| Codex | global | `~/.codex/config.toml` | TOML table `mcp_servers` (underscore, not camel-case); keys `command` and `args` | `~/.codex` exists and is a directory |
| OpenCode | global | `~/.config/opencode/opencode.json` | key `mcp`; entry `{ type: "local", command: [command, …args], enabled: true }` — one **combined** command array, not a split command/args pair | OpenCode's store (`$XDG_DATA_HOME/opencode/opencode.db`, else `~/.local/share/opencode/opencode.db`) exists and is a regular file — no embedded-database runtime gate |
| GitHub Copilot CLI | global | `~/.copilot/mcp-config.json` | key `mcpServers`; entry `{ command, args }` | `~/.copilot/session-store.db` exists and is a regular file — no embedded-database runtime gate |
| VS Code Copilot Chat | global | `<stock-editor user-data dir>/User/mcp.json` — the **stock** editor flavor only | key `servers`; entry `{ type: "stdio", command, args }` | either `<stock-editor user-data dir>/User/globalStorage/github.copilot-chat` or `~/.copilot/session-state` exists and is a directory |
| Cline (editor extension) | global, **one file per editor flavor** | `<flavor user-data dir>/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`, for **each** supported flavor that hosts the extension | key `mcpServers`; entry `{ command, args }` | that settings file is accessible under at least one supported flavor |
| Devin CLI | global | `~/.config/devin/config.json` — on **every** platform | key `mcpServers`; entry `{ command, args, transport: "stdio" }` — a `transport` field no other host uses | Devin's CLI data directory (`$XDG_DATA_HOME/devin/cli`, else `~/.local/share/devin/cli`; `%APPDATA%\devin\cli` on Windows) exists as a directory, **or** the `sessions.db` inside it is a regular file — no embedded-database runtime gate |
| Antigravity | global | `~/.gemini/config/mcp_config.json` | key `mcpServers`; entry `{ command, args }` — **no** `type` and **no** `transport` field; stdio is inferred from the presence of `command` | any of the three variant roots `~/.gemini/antigravity`, `~/.gemini/antigravity-ide`, `~/.gemini/antigravity-cli` exists, **or** any of them has a `*.db` file under its `conversations/` subdirectory — no embedded-database runtime gate |

The supported editor flavors, for both the Copilot Chat and Cline rows, are the stock editor, its Insiders channel, Cursor, VSCodium, and Windsurf. Copilot Chat's global file is confined to the **stock** flavor; Cline's spans **all** of them.

Devin CLI's config path is fixed to the one `~/.config` convention on **every** platform, while its *detection* follows the platform application-data convention — a Roaming path on Windows. The asymmetry is deliberate rather than an oversight: Devin's per-OS *data* directory was verified against a real install on each OS, but whether its *config* directory also moves on Windows was not, and the same path convention is reused for other hosts, so a wrong guess would propagate beyond Devin. The worst case of the current choice is bounded and silent — on a Windows machine where Devin reads its config elsewhere, registration writes one file Devin never reads. Nothing is lost or corrupted, no error surfaces, and no other host is affected.

Registration **creates the config file when it is absent** for every host except Cline, and creates any missing parent directories for every host except Claude Code (whose parent is the worktree root, which necessarily already exists) and Cline. Cline is the exception because it only ever visits flavors whose settings file already exists — which is also what stops an empty settings file being conjured under a flavor that does not host the extension.

The Cline CLI (the standalone `cline` terminal tool, under `~/.cline`) is deliberately **not** an MCP host — it ships no MCP config file; only the editor extension does.

Cursor is likewise represented only by its IDE: the Cursor MCP predicate keys on the IDE's editor state store, and the terminal `cursor-agent` tool (which keeps its own data under `~/.cursor/`) is never consulted. A machine with only the terminal tool and no IDE therefore gets no Cursor MCP entry, even though its sessions are still discovered and summarized.

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

- **Repo-scoped registration** runs as a per-worktree step of the install pipeline, after the per-worktree skill update and git-exclude update. It runs **before** the Claude-enabled hook gate, so a user who has disabled Claude integration still gets repo-scoped MCP registered for other detected repo hosts (e.g. Cursor). Each repo host is gated on its own MCP predicate from the table above; Claude's mirrors the Claude-enabled config flag rather than probing the filesystem.
- **Global-scoped registration** runs **once** per install (not per worktree), after the worktree loop completes, gated only on each global host's own MCP predicate. Writing it once avoids rewriting the same machine-wide file on every worktree iteration.
- **Removal** runs as a per-worktree step of the uninstall pipeline, after Claude and Gemini hook removal in the same per-worktree loop. It removes the entry from **repo-scoped hosts only**, treating every repo host as if detected (so an uninstall cleans up a host registered by a previous install even if not detected now). Removal is unconditional with respect to the Claude-enabled flag. Global-scoped hosts are deliberately **never** removed.

### Presence versus readability

The predicate that decides whether a host gets an MCP entry asks whether the host is **present on this machine**. It deliberately does *not* ask whether the running runtime can **read** that host's conversation store. Registration only writes a config file — it never opens a transcript, a session index, or an embedded database — so a runtime's inability to read a store is irrelevant to whether the entry should be written.

The hosts that are *read* through an embedded database — Cursor, OpenCode, GitHub Copilot CLI, Devin CLI, and Antigravity — need a built-in runtime module the product's editor-extension runtime may not have. For each of them the reading-side predicate is a conjunction — the store exists **and** this runtime supports the embedded-database module — while the MCP predicate drops the second half. The observable consequence: on such a runtime, session discovery and the status tree report every one of them as absent, while MCP registration still writes an entry for each one it finds on disk. Reporting a host absent for reading therefore says nothing about whether it was registered.

For the most recently added hosts (Cline, Devin CLI, Antigravity) the presence artifact was additionally chosen to be one the host writes at **first activation**, never one it writes only after first use:

- Cline's presence signal is its MCP settings file, which the extension seeds (as an empty server map) when it first activates. Its *reading* signal is the task-history file, which is written lazily on the first history save. Keying MCP off task history silently skipped a freshly installed, never-used Cline.
- Devin CLI's presence signal accepts its data **directory**, which exists from its first run, not only the session database inside it, which appears once a conversation is stored.
- Antigravity's presence signal accepts a bare variant root, not only a per-conversation database under `conversations/` — its databases are per conversation, so keying on them meant "has the user chatted at least once".

The reason first-activation artifacts matter is that registration is not self-healing. It runs only as part of a **full** install pass — a user-initiated enable, the editor extension's first-run or upgrade-triggered re-enable, or the IDE plugin's integrations run. The routine automatic path, the per-session bootstrap, runs the reduced repository-hooks-only mode, which forces every host probe to "absent" and registers nothing. So under the most natural ordering — install the host, enable the product, *then* start using the host — a use-gated presence signal missed MCP entirely and was not repaired until the next full install pass.

Cline is the one host where the MCP predicate is **narrower** than its reading predicate rather than looser. Reading treats "the editor extension or the standalone terminal tool" as Cline; MCP accepts only the editor extension, because the terminal tool ships no MCP config file and so is not an MCP host at all. Feeding the broader signal in would have selected Cline for registration and then written nothing.

### Registration into a JSON registry (per host)

1. Compute the registry path for the host.
2. Attempt to read and JSON-parse the file:
   - If reading fails with a "file not found" error: treat as an empty document and proceed.
   - If the file exists but is empty or whitespace-only: treat as an empty document and proceed. This is a fresh-start placeholder, not corruption — the stock editor ships an empty user-level MCP file by default, and there are no other servers in it to lose. (The Claude Code host, whose merge predates the shared JSON path, does **not** carry this tolerance: it classifies an empty file as unparseable and skips.)
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

### Scope of removal on uninstall

The removal pass iterates **only the repository-scoped hosts** — Claude Code and Cursor. No uninstall path, per-repo or machine-wide, iterates the global-scoped hosts. The set of entries an uninstall therefore deliberately abandons on the machine is **every** global host:

Gemini, Codex, OpenCode, GitHub Copilot CLI, VS Code Copilot Chat, Cline (every flavor's settings file), Devin CLI, and Antigravity.

Each of those global hosts nonetheless *carries* a removal implementation, and no reachable path invokes any of them — they exist as the symmetric half of each host's definition, not as live behavior. They are therefore also untested-by-use: Cline's, in particular, would clear **every** supported flavor's settings file, not only the flavors that actually host the extension, which is the opposite of the narrowing its registration side applies.

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
| Absent | install/enable on a runtime that cannot read the host's conversation store, host present on disk | Registered | the readability gate applies to reading, not to registration; the status tree meanwhile reports this host absent |
| Absent | install/enable while the host is installed but has never been used | Registered | the presence artifact for the newest hosts is one written at first activation, not first use |
| Registered (any shape) | install/enable while host no longer **present** | unchanged | registration is skipped for an absent host; the existing entry is not cleaned up |

## Notable Behavior

- **Registration is multi-host, split by scope.** Repo-scoped hosts (Claude, Cursor) are written per worktree; global-scoped hosts (Gemini, Codex, OpenCode, Copilot CLI, Copilot Chat, Cline, Devin, Antigravity) are written once per install. The split exists because a global config is shared by every repo on the machine. (Notable.)
- **Global-scoped hosts are never removed on a single-repo uninstall.** Their `jollimemory` entry is machine-wide, so removing it would break MCP for every other repo still using Jolli. A stale global entry is harmless (idempotently refreshed on the next install) and far preferable to cross-repo breakage. Only the repo-scoped hosts (Claude Code, Cursor) are cleaned up; **every** global host — Gemini, Codex, OpenCode, Copilot CLI, Copilot Chat, Cline, Devin CLI, Antigravity — keeps its entry. Each of them nonetheless carries a removal implementation that no reachable path invokes, so those code paths describe an intention rather than an observable behavior; Cline's would clear every flavor's file rather than only the hosted ones. This same removal path is the one invoked by the machine-wide uninstall command's current-repo item — see the CLI machine-wide uninstall spec — so a full machine-wide uninstall still never removes a global host's entry. (Surprising; intentional.)
- **Each host is gated on its own predicate, and that predicate asks presence, not readability** (Claude's mirrors the Claude-enabled flag and probes no file at all), so registration is skipped for hosts the user has not installed but is *not* skipped merely because the running runtime cannot read a host's conversation store. On a runtime lacking the embedded-database module, Cursor, OpenCode, Copilot CLI, Devin CLI, and Antigravity are all reported absent for reading while every one of them still gets an MCP entry. Cline inverts this in the one direction that is stricter: its MCP predicate accepts only the editor extension, whereas its reading predicate also accepts the standalone terminal tool, which is not an MCP host. Repo-scoped registration runs before the Claude-enabled hook gate, so a Cursor user with Claude disabled still gets MCP registered. (Surprising; intentional.)
- **The reduced repo-hooks-only install skips registration for every host except Codex, and only when the acting host is Codex.** That mode exists for the AI-host plugin bootstraps and otherwise writes no MCP config at all; this one entry is exempt because it is the *only* path by which MCP reaches a Codex-plugin user. A plugin-shipped MCP manifest cannot serve them: Codex does not expand its plugin-root variable inside an MCP entry, so the entry must give a relative command with a plugin-relative working directory, and every memory tool derives the repository it serves from its working directory — the resulting server answers for the plugin's own cache directory (successful but empty results, plus a placeholder Memory Bank repo named after the bundle's version directory). Nothing recovers the real workspace from inside such a launch: the host declares no roots capability, and a server-initiated request for roots returns empty; the environment the host passes MCP servers is a short allowlist with nothing session-scoped in it. A `config.toml` entry carries no working directory and is launched with the session's, which is the only correct one. Hence three linked facts: the Codex plugin ships no MCP manifest, the server **refuses to start** under a working directory inside a plugin cache rather than serve the wrong repository, and this exemption is Codex-only — the other seven global hosts are not registered by a Codex install, which has no business configuring them. The user-visible cost is that the first session after a plugin install has skills but no MCP tools, since registrations are read at session start; the skills' CLI fallback covers it. (Surprising; intentional.)
- **Cline is the only host with a *set* of registry files rather than a single one** — one per editor flavor that hosts the extension, because each flavor's extension storage is independent. Registration visits every hosting flavor without short-circuiting on the first. Contrast Copilot Chat, whose global file is confined to the **stock** flavor alone even though Cline's spans every supported flavor. (Notable.)
- **Malformed registry is never overwritten.** A parse failure on an existing file is treated fundamentally differently from a missing file: writing a fresh empty document would silently drop every other MCP server the user configured by hand, so the behavior is to log and leave the file untouched, deferring recovery to the user fixing it. (Notable.)
- **Removal silently no-ops on read failure.** Unlike registration, removal does not warn on parse or read errors — it cannot lose user content because it only ever deletes one well-known key, and the worst case is a leftover stale entry. (Notable.)
- **Re-registration replaces, never duplicates.** Because the entry lives under a single fixed key, repeated install runs always produce a single entry whose contents are refreshed in place. (Notable.)
- **The repo-scoped registry files must not be committed.** They contain machine-local absolute paths, so the install pipeline contributes their filenames to the worktree's git-exclude list. Uninstall leaves those exclude entries behind, intentionally — they are inert when the file is absent. (Notable.)
- **Per-host error isolation is non-fatal at the orchestration boundary.** A read-only or unwritable registry for one host yields a logged warning but never blocks the other hosts or the surrounding install/uninstall — in particular it cannot prevent removal of the shared repository-level git hooks. (Notable.)
- **Hosts differ in their per-entry envelope.** OpenCode requires a `type: "local"` wrapper and a single combined command array (split command/args is rejected by its loader); Codex uses an underscore table key in TOML; Copilot Chat adds a `type: "stdio"` field; Devin adds a `transport: "stdio"` field; Antigravity needs neither (it infers stdio from the presence of `command`). The well-known `jollimemory` key and the underlying command/args are the same across all hosts; only the per-host envelope differs, so a shape correct for one host is a silent no-op if written to another. (Notable.)
- **The per-host envelopes are not all verified to the same standard, and the difference is recorded deliberately.** Three tiers exist. *Live round-trip* — the host's own tooling was used to write an entry and read it back, so a wrong shape would have been rejected: OpenCode, GitHub Copilot CLI, Devin CLI. *Confirmed against a real install* — an actual on-disk file from a working install was observed, but not written and re-read through the host: Codex (also cross-checked against the vendor's published documentation) and Cline. *Read from bundled application source only, with no live round-trip*: Cursor, Gemini, VS Code Copilot Chat, and Antigravity (source plus the vendor's shipped documentation). Claude Code's file is the product's long-standing primary integration and carries no verification note of its own. The practical risk of the third tier is silent: a shape a host does not accept is ignored, so the failure mode is "the tool never appears in that host" rather than an error anywhere. (Notable.)
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
