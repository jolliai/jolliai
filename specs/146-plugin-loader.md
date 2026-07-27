# 146. Plugin Loader

## Topic Statement

The command-line tool discovers, validates, and dynamically loads optional plugin packages once at startup so each plugin can register additional top-level commands against the same parser the built-in commands use, with a stub-fallback so a missing plugin still appears in help and prints an install hint when invoked.

## Scope

**In scope:**

- The decision of which scope-prefixed packages to consider on disk.
- The ordered set of directory roots searched per invocation.
- The package-manifest field that gates whether a candidate is a plugin at all.
- The stable registry that allow-lists plugins by opaque identifier.
- The validation that gates whether a discovered plugin is actually loaded (host-version range satisfaction, manifest-shape checks, entry-path-containment check, file-existence check, dynamic-import success, entry-export shape).
- The contract the loader hands to a plugin during registration (parser handle, host-version string, scoped logger).
- The collision-tolerance behavior that lets a plugin keep registering commands when one of its commands or aliases overlaps an already-registered name/alias.
- The "missing-plugin stub" fallback that synthesizes placeholder commands for any known plugin not actually loaded.
- The three-state diagnostic snapshot the loader produces for every known plugin (absent / installed-but-version-incompatible / discovered-and-version-compatible).
- The opt-out and warning-suppression environment switches, plus the build-identity short-circuit that makes one specific pre-bundled embedding behave as if the opt-out switch were always set.
- The on-disk cache of the global package-manager install root.
- The behavior under concurrent invocations.

**Out of scope (boundaries):**

- How the host learns which version of itself it is (treated as an opaque already-resolved string handed to the loader). Build-time version injection is covered elsewhere.
- The build-time bundling of the command-line tool inside other products (editor extensions, IDE plugins). Those embeddings do not invoke this loader at all; only the standalone command-line entry point does. The pre-bundled embedding for the specific third-party AI-assistant's plugin ecosystem is the EXCEPTION — it reuses the same entry point and therefore does reach this loader's shared discovery routine, defeating discovery via the explicit build-identity check rather than by never calling in.
- The site-generation, space-sync, and any other plugin-resident command set. Those flows are described by their own specs; this spec documents only the loader-to-plugin handoff (the parser handle, the host version, and the logger), not what the plugin does with them.
- The "plugin outdated" server-side gating flow (HTTP 426 mapping). See **Plugin Outdated Flow**.
- The "newer version available on the registry" update-notice computation and the cache it reads. This spec documents only that the loader's diagnostic snapshot is reused by the version-check on the same invocation; the registry-comparison logic itself is separate.
- Per-source dist-path version selection and the npm-postinstall refresh of the dist-path file are unrelated discovery mechanisms used by the hook installer, not by this loader. See **Per-Source Dist-Path Version Selection** and **Npm Postinstall Dist-Path Refresh**.
- The help-formatter that consumes the per-command group tags this loader applies. The loader's contract is only that it tags the commands a known plugin registered; how those tags are rendered into help sections is a separate formatter concern.
- The doctor-command's surfacing of the loader's diagnostic snapshot.

## Data Contracts

### Known-plugin registry entry

A static, in-source list. Each entry describes a single known plugin and carries:

- A stable, opaque random identifier string (the value the plugin must declare in its own manifest to be eligible for loading). Names can change as the plugin ecosystem evolves; the identifier is the binding key precisely because it does not, and because the open-source host code does not need to reference any specific commercial-product name.
- A human-readable package name, used only in diagnostic messages and in the install hint. It is **not** used for matching against on-disk packages.
- A one-line install hint (a shell command string) that the host prints when the plugin's stub action runs.
- An optional help-section group tag. When present, every command the plugin registers during its own registration call is tagged with this group so the help formatter buckets them by provenance rather than by name. Plugins without a tag fall through to a generic "Other commands" section.
- An optional stub-registration callback. When the plugin is not loaded, this callback is invoked to register placeholder commands so the plugin's commands still appear in help. Plugins without a callback are silently absent from help when missing.

The production registry contains exactly three entries: one commercial proprietary "space" plugin (with a "space" help group), one "site"-generation plugin (with a "site" help group), and one "workflow"-running plugin (with a "workflow" help group). All three register stubs when missing.

### Discoverable plugin on disk

A discoverable plugin is a directory inside a known scope directory whose manifest:

- Parses as a JSON object (not array, not null, not a primitive).
- Carries a string field naming the opaque plugin identifier. The field's presence-and-string-shape is the gate that says "this package considers itself a plugin"; missing, non-string, or unknown-identifier packages are silently ignored at discovery.
- Optionally declares a host-version range under its peer-dependency section, against the package name of the host command-line tool.
- Optionally declares an entry-file path (relative). When absent, the loader uses a default path of `./dist/Plugin.js` (a relative path under a `dist` directory, named `Plugin.js`).

### Plugin context (the contract the loader hands to a plugin)

When a plugin's registration callback runs, it receives exactly three fields:

- The root parser instance, on which the plugin attaches new top-level commands.
- The host version string (the same value the loader used to validate the peer-range).
- A scoped logger whose lines flow through the host's normal logging pipeline.

The plugin's registration callback may return synchronously or via a promise; the loader awaits the promise before returning.

The plugin's registration callback must export a symbol named `register` as a named export from the entry file. A default export is not accepted; an entry whose `register` is not a function is rejected.

### Plugin diagnostic snapshot

A list returned alongside the loaded set. The list contains exactly one entry per known-plugin-registry entry, in registry order, with three possible states:

- **absent** — not found on disk (or discovery was opted out via the environment switch). No installed-version or peer-range is reported.
- **installed-but-incompatible** — found on disk; the manifest declared a host-version range and the host version does not satisfy it. The installed version (when readable) and the declared peer range are reported.
- **discovered-and-compatible** — found on disk; either no peer-range was declared, or the host version satisfies the declared range. The installed version (when readable) and the peer range (when present) are reported. This state explicitly does NOT mean "the plugin's code loaded successfully" — a plugin whose entry import or registration callback throws is still discovered-and-compatible by this probe; the loader rejects it separately at load time and warns. Consumers of the diagnostic must not present this state as "working".

### Persisted state — the global install-root cache

A single file under the host's machine-global config directory, named `global-root`. Holds the resolved path of the package manager's global install root as a plain string. Its modification time is the freshness signal. TTL is six hours.

### Environment switches

- An environment variable that, when set to the literal value `1`, short-circuits all discovery: no roots are walked, no packages are read, no plugin registration runs, the loaded set is empty, and the diagnostic snapshot reports every known plugin as absent.
- A separate environment variable that, when set to the literal value `1`, suppresses every user-facing warning the loader would emit. Suppression still records the would-be warning under the debug log level under a `[silenced]` marker. The skipped-or-rejected behavior itself is unchanged; only the warning is muted.
- A third, non-environment-variable trigger with the identical effect: when the running bundle's build identity self-reports as the pre-bundled embedding for a third-party AI-assistant's plugin ecosystem, discovery is unconditionally treated as opted out (checked before the env switch, same empty output). This exists because that embedding bundles the identical discovery code but is a fixed, closed command surface for its host product; leaving discovery live would scan the installing machine's global package root and could try to load the same optional extensions the standalone tool discovers, producing peer-mismatch and version-upgrade noise for extensions that embedding never uses.

## Behavior

### Entry

The loader is invoked exactly once per command-line invocation, after the host has registered every built-in command and before the parser processes the user's arguments. The host hands the loader the parser instance and the host version string and receives back a loaded-identifier set and the diagnostic snapshot. The host then invokes the stub-fallback pass against the loaded-identifier set, then a (separate) version-mismatch check against the diagnostic snapshot, then begins parsing the user's arguments.

The split between "discover and load" and "register missing stubs" is deliberate: the stubs are part of the help output's contract regardless of whether discovery ran. Test scaffolds that mock the load pass to a no-op still get stubs through the second call.

### Opt-out short-circuit

Two conditions produce the identical short-circuit, checked before anything else — the build-identity check and the opt-out environment switch; either being true returns immediately with an empty loaded set and a diagnostic snapshot reporting every known-registry entry as absent. No directory walk, no manifest read, no dynamic import happens.

### Resolving the roots to scan

The loader builds an ordered list of directory roots, where earlier entries take precedence on duplicate identifiers.

1. **Upward walk from the current working directory.** Starting from the working directory and walking upward one parent at a time, every step's child directory named `node_modules` (the conventional package-manager dependency directory) is appended (if it exists and is not already in the list). The walk is bounded by:

   - The nearest ancestor of the working directory that contains a `.git` directory entry (treated as the project root). This preserves the monorepo case where a plugin is hoisted to the workspace root.
   - When no such ancestor exists, the user's home directory is used as the boundary.
   - When the working directory itself is outside the boundary (e.g. a system-temp path while the boundary is the user's home), the local walk is skipped entirely and only the global root (below) is consulted. This is a deliberate security gate: a tool invoked from a world-writable directory must not pick up a hoisted package some other user dropped into an ancestor `node_modules`.

   The walk does not climb to the filesystem root.

2. **Self-install root.** The directory tree the running host code physically lives under is walked upward to the nearest enclosing `node_modules` directory. When that walk yields a path that exists on disk and is not already in the list, it is appended. This is what makes a globally-installed host find its co-installed plugins (the sibling-of-the-host layout) without depending on the package manager subprocess.

3. **Global install root.** Looked up via the cache described below. When the resolved path exists on disk and is not already in the list, it is appended.

A `null` or non-existent global root is silently skipped; a working command-line tool with no plugin discoverable in either the local or self-install root simply has no plugin commands attached.

### Discovery walk

For each resolved root, then for each known scope directory (just one in production), the loader:

1. Checks the scope directory exists. If not, skips it silently.
2. Reads its entries with file-type information. If the read throws (a file at the path, permission denied, race condition), the entire scope is silently skipped — a single broken root does not block discovery elsewhere.
3. Sorts the entries by byte-order comparison (not locale-sensitive). The deterministic order ensures that two packages declaring the same identifier in the same scope+root resolve to the same winner regardless of which filesystem hosts the directory and which locale is configured.
4. For each entry:
   - Accepts directories and symbolic links; rejects regular files, sockets, and anything else without a stat call.
   - Checks that a manifest file exists at the entry's `package.json` path. If not, skips silently.
   - Reads the manifest, parses it as JSON. If parsing throws (corrupt manifest), or the parse yields something that isn't an object (`null`, an array, a primitive), records a debug-level breadcrumb naming the scope, entry, and parse-error message, then skips. Critically, no user-facing warning is emitted here, because the loader has not yet decided whether this is even a plugin candidate — at this point the entry is just an arbitrary scope-sharing package, and a warning for every malformed manifest in the scope would be noise.
   - Reads the manifest's plugin-identifier field. If absent or not a string, skips silently. If present but the value is not on the in-effect allow-list (derived from the known-plugins registry), skips silently.
   - When the entry is a symbolic link and resolves to a path outside every walked root, records a debug-level breadcrumb noting the indirection. The plugin is still loaded — a user with the write privilege to drop a symbolic link under the scope already has the privilege to drop a real package, so blanket refusal would also break editable workflows.
   - When the same scope+root already holds another entry with the same plugin identifier (the rename-mid-migration case where both old and new package names are installed), the entry is skipped and a user-facing warning is emitted naming both the loser's directory name, the winner's directory name, the conflicting identifier, and the root. The lexicographically first one wins (the sort above guarantees a stable winner).
   - When the same plugin identifier has already been claimed in an earlier root (normal hoisting — a project-local copy shadowing the global copy), the entry is skipped silently, without a warning.
   - Otherwise, the entry is recorded as a discovered plugin (full directory path, full package name, plugin identifier, and the parsed manifest).

A non-readable scope directory and a non-readable parent directory are both silently skipped; they do not abort the rest of the discovery walk.

### Per-plugin load

For each discovered plugin, in the order discovery produced:

1. **Host-version range satisfaction.** The manifest's peer-dependency entry for the host package name is read. When absent, the plugin is treated as universally compatible. When present, the host version string is checked against the declared range using standard semantic-version range grammar (caret, tilde, comparator, disjunction, wildcard). The check explicitly allows pre-release host versions to match non-pre-release ranges, so a host running a release-candidate build is not spuriously rejected by a range like `^1.1.0`. A host version that itself does not parse as a semantic version (`dev`, `unknown`, corrupt) fails any declared range — the loader will not load a peer-constrained plugin against a host whose version cannot be verified. An unparseable range fails the check (returns false without throwing). On failure, a warning is emitted identifying the plugin, the declared range, and the host version, and the plugin is not loaded.

2. **Entry-path validation.** The manifest's entry-file field is read. When absent, defaults to `./dist/Plugin.js`. When present but not a string, a warning is emitted and the plugin is not loaded. The entry path is resolved against the plugin's directory; when it resolves to a path outside the plugin's directory (e.g. a `../../../etc/passwd`-style absolute or escaping relative path), a warning is emitted and the plugin is not loaded.

3. **Entry-file existence.** When the resolved entry file does not exist, a warning is emitted naming the entry path the manifest declared, and the plugin is not loaded. A race-condition window exists between this existence check and the import below; the loader accepts it because anyone who can write to the plugin directory already controls what gets executed.

4. **Dynamic import.** The entry file is imported as an ESM module. On any thrown error (syntax error, runtime error at module top level, missing peer dependency from within the plugin), a warning is emitted naming the plugin and the error message, and the plugin is not loaded. Errors that are not Error instances (`throw "boom"`, `throw null`) are coerced to string form so the operator still sees the diagnostic.

5. **Entry-export shape.** The imported module's `register` field is checked. When not a function, a warning is emitted and the plugin is not loaded.

6. **Pre-snapshot of the parser namespace.** Before invoking the registration callback, the loader snapshots two things:
   - The set of occupied names — both every existing command's primary name and every alias of every existing command. Both are captured because the parser library treats the primary-and-alias space as a single flat namespace and rejects a new command/alias that collides with either.
   - The set of currently-registered command objects (by identity). This is the "before" set used after the registration call to identify exactly which commands the plugin added.

7. **Patching the parser for collision tolerance.** The loader installs interceptors on the parser instance for the duration of the registration call:
   - The `command` method. When the leading name token of a request collides with an occupied name, the conflict is recorded (added to a per-call blocked-names set), and a throwaway command object is returned so the plugin's chained calls (e.g. `.description(…).alias(…).action(…)`) do not crash. The throwaway is never attached to the parser. The throwaway also has its alias methods patched, but with independent empty name-sets so any aliases chained onto the throwaway do not leak into the real namespace. When the underlying parser call returns the parent (not a fresh command — the "executable subcommand" form of the call), the alias patches are not installed on the parent, because the restore step only restores the two method patches and installing alias patches on the parent would leak past the registration call.
   - The `addCommand` method. When the request's primary name or any of its declared aliases collides with an occupied name, all collisions are recorded, the request is rejected, and the parser instance is returned for chaining. Otherwise the call proceeds and the new name and aliases extend the occupied set.
   - The `alias` and `aliases` methods on the command object returned by `command`. On a collision, the alias is recorded as blocked and the request is dropped; the command itself remains attached and chained calls continue to see the same command instance. The no-argument getter forms of these methods are passed through unchanged.
   - Every successful registration extends the occupied-names set, so a same-call follow-up that would collide with a name or alias the same plugin just claimed is also rejected.

8. **Registration call.** The plugin's `register` callback is invoked with the plugin context. The loader awaits the call. If the call throws (synchronously or via a rejected promise), a warning is emitted naming the plugin and the error, the plugin is not added to the loaded set, but any commands the call managed to attach before throwing are left in place — the stub-fallback pass that follows is itself collision-tolerant, so a partial registration plus a stub for the rest is a coherent state.

9. **Restore.** The patches installed in step 7 are removed, restoring the parser's original method bindings. The restore distinguishes between methods that the loader had to assign as own-properties (delete them) and methods that were already own-properties before patching (re-assign the original) so a future nested invocation cannot lose an outer layer's wrapping.

10. **Help-group tagging.** When the known-registry entry for this plugin's identifier declares a help group, every command in the parser that was not in the "before" set captured in step 6 is tagged with that group. Commands the plugin added but that were rejected by the collision interceptors (and therefore never attached) are not present in the parser, so they are not tagged.

11. **Conflict-warning emission.** When the blocked-names set is non-empty after the registration call, a warning is emitted naming the plugin and listing every blocked name. The same message is also written through the plugin's own scoped logger so the diagnostic appears under the plugin-scoped namespace in the debug log (giving plugin authors a single search-key for their own diagnostics).

12. **Outer safety net.** The entire per-plugin load is wrapped in a top-level try/catch so an unanticipated throw (a non-string entry that escaped the type check, a buggy filesystem implementation) cannot escape and tear down the host. The outer catch emits a warning naming the plugin and the error, then continues to the next plugin.

A plugin returns true (added to the loaded set) only when steps 1-5 passed and the registration call ran to completion without throwing.

### Stub-fallback pass

After the load pass completes, the loader iterates the known-plugins registry in order. For every entry:

- Whose identifier is present in the loaded set: skip.
- Whose registry entry declares no stub-registration callback: skip silently (the plugin's commands simply do not appear anywhere).
- Otherwise: invoke the stub-registration callback. The call is wrapped in try/catch; a throw is caught, a warning is emitted naming the package and the error, and the loop continues. A throwing stub never tears down the host.

Each stub-registration callback (defined per known plugin in the registry):

- Snapshots the occupied-names set the same way the loader does (primary names and aliases of every existing command).
- For each of its predetermined stub-command specifications (a hard-coded list of name+description pairs that mirror the real plugin's command surface), if the stub name is occupied, skips. Otherwise attaches a new command that:
  - Carries a description suffix indicating the missing plugin is required.
  - Declares a single variadic argument that accepts arbitrary tokens.
  - Allows arbitrary unknown options (so the parser does not reject a user-typed flag the real plugin would have accepted).
  - When invoked, writes a multi-line install-hint message to the standard error stream — naming the command, the missing plugin's package, the install command, and a "re-run" reminder — and exits with a non-zero status code so calling scripts fail loudly.
- Tags every successfully-attached stub command with the help group the registry entry declares.

One shipping stub deviates from the "list of name+description pairs, each its own top-level command" shape: the "workflow"-plugin stub registers a **single** top-level command whose subcommands (`local-run` / `runs` / `run-status`) are forwarded as a variadic argument (with arbitrary unknown options allowed) rather than declared as separate stub-command specifications. Its action branches on the forwarded subcommand: the `local-run` branch writes a machine-readable `{ type: "workflow_cli_required", installHint }` JSON object to the standard **output** stream and exits **zero** (a "needs input" state the local-run recipe parses, not an error), while every other subcommand — or none — follows the standard multi-line stderr install-hint plus non-zero exit.

### Diagnostic snapshot

The diagnostic snapshot is computed from the same single discovery walk the load pass used (no second discovery). For each known-plugin-registry entry, in registry order:

- When the opt-out switch is active or when no discovery entry matches the registry entry's identifier: state is **absent**, no installed-version, no peer-range.
- When a discovery entry matches: the installed version is taken from the manifest's `version` field (when a string; otherwise undefined); the peer-range is taken from the manifest's host-package peer-dependency entry (when present); state is **discovered-and-compatible** when the host version satisfies the range (or no range was declared) by exactly the same check the load pass uses, otherwise **installed-but-incompatible**.

The version-mismatch check that runs immediately after the loader consumes the snapshot directly (skipping a second discovery walk) so the startup hot path discovers plugins exactly once per invocation. The doctor command invokes the inspection path on its own (without the load pass) to render the per-plugin status rows.

### Warning routing

Every warning emitted by the loader is suppressed when the warnings-suppression environment switch is set to `1`. Suppression replaces the user-facing emission with a debug-level entry tagged `[silenced]`. The skip-or-reject behavior itself is identical with or without suppression.

### Logging streams

Loader warnings and debug breadcrumbs flow through the host's logging pipeline. The default for the command-line tool routes informational and debug levels away from the user's terminal (they still go to the rotating debug log file). Warnings and errors go to the standard error stream so they remain visible even when the user is piping the standard output stream.

## State Transitions

The loader holds no cross-invocation state beyond the global install-root cache file. Per-invocation, the load pass advances a single per-pass state for each known plugin:

1. **Not yet considered** — nothing has examined the registry entry.
2. **Discovered** — a matching package was found on disk and its manifest was parsed.
3. **Rejected** — discovered but failed validation (peer-range, manifest shape, entry path, entry existence, import failure, missing `register` export, throwing `register` call).
4. **Loaded** — discovered, validated, registration call completed.
5. **Stubbed** — never reached "Loaded" and the registry entry declares a stub callback that ran successfully.
6. **Absent** — never discovered (and no stub fallback ran, either because none is declared or because it threw).

The loaded-identifier set returned to the caller contains exactly the identifiers in state 4.

The global install-root cache file transitions: when a stat shows a modification time within the TTL, the file's contents (trimmed) are returned without spawning the package manager; an empty cache file is ignored. On miss, expiry, or stat failure, the package manager is queried with a timeout; on success, the cache is rewritten (the parent directory is created if needed; a write failure is logged at debug level and otherwise ignored). When the package manager invocation fails or times out, the loader proceeds without a global root.

## Notable Behavior

- **The plugin identifier — not the package name — is the load gate.** Discovery is keyed by an opaque random string the plugin declares in its own manifest. Package names are intentionally not used for matching: names can be renamed (and at least one of the production plugins has been renamed in its lifetime), and binding the host code to a specific name would also leak the name (and any commercial-product hint it carries) into the open-source host codebase. The package name is used only for diagnostic text and for the install hint. (Notable.)

- **The known-plugins allow-list is the host's contract.** Only plugins whose declared identifier appears in the in-source registry are eligible to load. There is no "auto-discovery of any package that declares the field"; the host has to know about a plugin before that plugin can register commands. (Notable.)

- **A discovered-but-rejected plugin still gets its stub.** The loader's return set is precisely the set of identifiers whose registration call ran to completion; any plugin that was discovered on disk but failed the peer-range check, had a malformed entry, failed to import, or whose `register` callback threw is excluded from the set so the stub-fallback pass installs the placeholder commands. A user with a broken plugin install still sees the plugin's commands in help and gets the install hint — the plugin does not silently vanish. (Notable.)

- **A plugin whose `register` callback throws partway through keeps the commands it had already attached.** The throw rejects the plugin (it does not enter the loaded set), but the stub-fallback pass is collision-tolerant and only fills in stub commands whose names are not already attached. The result is a hybrid: the commands the plugin managed to attach before throwing are live, and the rest are stubs. (Notable.)

- **The collision interceptors only cover the parser-method paths that throw on duplicates.** Specifically: attaching a brand-new top-level command and its aliases. Anything else a plugin reaches for (attaching a sub-command under an existing built-in, replacing a built-in's action handler, adding an alias to an already-registered built-in) is not intercepted. Plugins on the allow-list live inside the same trust boundary as the host code and are treated as co-maintainers of the parser namespace, not as a sandbox. The interception is purely an ergonomics gate that stops a colliding new command from tearing down the rest of the plugin's registration. (Notable.)

- **Pre-release host versions match non-pre-release ranges.** A host built as a release-candidate (e.g. `1.5.0-rc.1`) matches a plugin's `^1.0.0` peer-range. This is a deliberate accommodation for release-candidate testing — the strict semantic-version rule that pre-releases never satisfy non-pre-release ranges would otherwise block every plugin during release candidates. (Notable.)

- **An unparseable host version fails every declared peer-range.** When the host version string itself cannot be parsed as a semantic version (`dev` builds, corrupt build-time injection), any plugin that declared a peer-range is rejected. A plugin that did not declare a peer-range is still loaded — `dev` builds are the path used for local iteration, and a plugin without a peer-range has explicitly opted out of host-version gating. (Notable; conservative default.)

- **A symbolic link resolving outside the walked roots is loaded with a debug breadcrumb, not refused.** The reasoning is that the privilege required to drop a symbolic link under the trust scope is the same as the privilege required to drop a real package, so a blanket refusal would also break editable development workflows. (Notable.)

- **A second-package-in-the-same-scope-with-the-same-identifier is the only same-scope duplicate that warns.** The lexicographically first wins; the rest are skipped with a user-facing warning naming both packages, the conflicting identifier, and the root. A second package in a different root with the same identifier (normal hoisting) is skipped silently — no warning, because that is the normal "project copy shadows global copy" case. (Notable.)

- **The walk is bounded by `.git` (or by the user's home directory) — never by the filesystem root.** A command-line invocation from a world-writable temporary directory whose path is outside the user's home does not walk any local `node_modules` at all; only the global install root is consulted. This is an explicit security boundary against pickup of hoisted packages from ancestor directories the invoking user does not control. (Notable; defensive.)

- **The self-install root makes global-plugin discovery independent of the package manager subprocess.** A globally-installed host lives under the same `node_modules` directory as its globally-installed plugins, so walking up from the host code's own on-disk location to the enclosing `node_modules` finds the plugin directly. This bypass is critical on platforms where the package manager subprocess routinely fails (subprocess timeout on a cold shell, a path environment stripped by the launching IDE, a version-manager pointing the cache at a different runtime's install root). The cwd walk cannot reach the global directory on its own, so before the self-install root was added, the global plugin was only reachable through the fragile subprocess. (Notable.)

- **The discovery walk is deduplicated across all the roots.** The first root in priority order to surface a given plugin identifier wins; later roots with the same identifier are skipped silently. The result is "project copy shadows global copy" hoisting semantics. (Notable.)

- **Warnings can be silenced without changing the loader's decisions.** The warning-suppression switch reroutes every warning to a debug-level entry tagged `[silenced]`; the underlying skip-or-reject behavior is unchanged. Use case: scripts that pipe the standard-error stream and must not see plugin warnings inline. (Notable.)

- **The full opt-out switch is symmetric across the load path and the diagnostic path.** When set, the loader returns an empty loaded set AND a diagnostic snapshot reporting every known plugin as absent. The diagnostic could not otherwise honor "every plugin is absent" against an actually-installed plugin on disk; this symmetry guarantees the diagnostic view never disagrees with what the loader would do. (Notable.)

- **The diagnostic's discovered-and-compatible state is not "the plugin loads successfully" — only "discovery and the peer-range check both pass".** A plugin with a broken entry file, a failed dynamic import, or a throwing `register` callback is still discovered-and-compatible by this probe; the loader rejects it separately at load time and warns. The doctor row text deliberately reads "installed, compatible" (not "working") to avoid overstating what the inspection actually verified. (Notable.)

- **The loader runs exactly once per command-line invocation.** A plugin's `register` callback is invoked even when the user is running `--help` or `--version`, because commands must be attached before the parser can produce help or report unrecognized arguments. Plugins are therefore expected to keep their registration callback cheap (no file I/O, no subprocess, no network) and defer real work to the action handlers attached to the commands they register. (Notable.)

- **The loader does not cross trust boundaries.** Plugin code runs in the same process as the host and shares its parser instance, its working directory, its environment, and the user's credentials. There is no sandbox. The trust boundary is the on-disk file-system permissions on the plugin's directory — anyone with write access to the directory already controls what executes. The known-plugin allow-list is what restricts which packages on disk are considered at all. (Notable; explicit security model.)

- **The loader uses no locking.** Two concurrent command-line invocations against the same project both walk discovery, both load any installed plugin, and both register their own copy of every plugin command on their own parser instance. There is no shared parser state. The global install-root cache file is the only shared on-disk artifact, and concurrent writes are last-writer-wins (a brief race window of seconds at worst, and the cache holds a low-churn directory path so reads converge). (Notable.)

- **The opt-out switch is consulted as part of the shared discovery routine.** It applies symmetrically to the load path and the diagnostic path; a defensive cleanup of the environment variable is performed in the loader's tests because a leaked value would otherwise pass every "skipped because of opt-out" assertion without actually exercising the loader. (Notable; the production caller does not unset it.)

- **Stub commands forward arbitrary arguments and unknown options to their action.** A user typing `<missing-command> arg --some-flag` sees the install hint instead of an "unrecognized option" parser error. The variadic positional and the unknown-option permission together cover both shapes. The stub's action exits with a non-zero status so scripts that depended on the real command fail loudly rather than silently no-op. (Notable.)

- **One specific embedding explicitly opts out rather than relying on emergent absence.** Every other product embedding that bundles this loader's code simply never finds a candidate package alongside it; this one runs on a general-purpose installing machine where the same optional extensions could plausibly be present, so it carries an explicit build-identity check forcing the same outcome as full opt-out. (Notable.)

- **There is no auto-install path.** A missing plugin always exits via the stub's printed hint; the host never spawns a package-manager install. The rationale is that global installs need user consent for privileged operations and the canonical install command varies by package manager (and by environment-specific wrappers); the host prints the package-manager-agnostic name and the suggested install command and lets the user adapt. (Notable.)

- **The same loader is not used by the host's embeddings.** The editor and IDE products that bundle the command-line tool inside their own packages do not invoke the loader — they bundle only the built-in commands they need and do not expose a parser for plugins to attach to. The loader is exclusively a feature of the standalone command-line entry point. The bundled host code happens to include the loader module in its bundle (because it imports the shared logic that the loader lives alongside), but in that environment the self-install root walk simply finds no candidate packages and the loader is a no-op. (Notable.)

## Shared Behavior

- **The host version string** is built into the host at build time. The same value is read by the loader (for peer-range validation), by the help formatter, and by the version-check that follows the loader. How that value is injected is described elsewhere.

- **The shared discovery walk** is consumed by both the load pass and the diagnostic-only inspection. The exact same root resolution, allow-list gating, deduplication, and peer-range check is reused so the diagnostic view can never disagree with what the load pass actually does.

- **The diagnostic snapshot** computed during the load pass is reused by the version-mismatch check that runs on the same invocation, avoiding a second discovery walk. The version-check itself (comparing the installed plugin version against the cached registry latest, and the spawn of a detached refresh process) is described separately.

- **The "plugin outdated" server-driven flow** (mapping an HTTP 426 from the backend to a typed user-facing error) is unrelated to the loader and is described by the **Plugin Outdated Flow** spec. The loader's "incompatible" state is a different signal — local peer-range violation, decided at startup without contacting any server.

- **Per-source dist-path version selection** (used by the hook installer to pick which built artifact to invoke) is an unrelated discovery mechanism keyed by surface (CLI / editor / IDE). See **Per-Source Dist-Path Version Selection** and **Npm Postinstall Dist-Path Refresh**.

- **The help-formatter** consumes the per-command group tags this loader applies, bucketing commands by provenance rather than by name. The formatter's bucketing rules are separate.

- **The doctor command** invokes the inspection path directly (without loading) to surface per-plugin "installed, compatible" / "installed, incompatible" rows alongside its other checks. See the CLI doctor diagnostics spec.

- **The plugin-provided command surfaces** (the actual "site", "space", and "workflow" command sets when their plugins are loaded) are described in the respective command specs. This spec covers only the loader-side handoff: the parser handle, the host-version string, the scoped logger, and the namespace into which the plugin attaches its own commands.
