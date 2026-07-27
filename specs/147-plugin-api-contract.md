# 147. Plugin API Contract

## Topic Statement

The published boundary between the host CLI and an externally-installed plugin package, defining what the plugin must export, what the host hands it at registration time, what mutations the plugin is allowed to make to the host's command surface, and what guarantees the host makes about the lifecycle of that call.

## Scope

**In scope:**

- The static manifest fields a candidate plugin package must declare for the host to recognize it as a plugin.
- The runtime entry point a plugin module must export, including its expected signature (synchronous or promise-returning).
- The runtime context object the host passes to that entry point — every field exposed, its meaning, and the stability promise of that shape.
- The set of mutations the plugin may perform on the host's command surface through that context (registering new top-level commands, marking them hidden, declaring aliases).
- The set of mutations that are deliberately not policed (touching the host's pre-existing commands), and the trust model that justifies leaving them un-policed.
- The collision rules when a plugin registers a command whose primary name or alias is already occupied.
- The host's failure-handling guarantee: that any error thrown by, or originating from, a plugin must never tear down the host.
- The host-provided utility surface re-exported to plugins for parsing the product's tenant-bound auth token without re-implementing it.
- Versioning of the contract itself — what changes are additive (non-breaking) versus what changes break plugins.
- The fallback experience the host promises to provide for a known-but-not-installed plugin (visible commands plus an install hint), and the parallel between that and a real plugin's registration.
- Lifecycle ordering: when in the host's startup the plugin's entry point runs relative to built-in command registration and command-line parsing.
- Performance contract: how cheap the entry point must be, given that it runs on every invocation.
- Help-section provenance tagging: the host tags commands a known plugin registers so the help formatter buckets them under the right product section regardless of the command's chosen name.

**Out of scope (boundaries):**

- Discovery, allow-listing, peer-range matching, scope-directory walking, monkey-patching mechanics, on-disk caching of resolver state — that is the plugin loader's responsibility and lives in its own spec.
- The exact set of known plugins, the products they implement, and the command surface each one provides — that is the plugins' own concern; this spec only commits to "stubs render in help, real registrations replace the stubs".
- The format and parsing of the tenant-bound auth token (what fields it carries, how the tenant URL is recovered); this spec only says the host re-exports the helpers and what the helpers' contractual return shape is when called.
- The allow-listed origins for the tenant URL — saved at credential-save time; plugins call the parser and trust the result, optionally narrowing further with their own boundary check.
- The mechanism by which the user installs or removes a plugin (package managers, marketplaces, scoped global directories) and the install hint's exact text — only that an install hint exists per known plugin.
- The minimum-version "outdated plugin" failure surfaced when the server rejects a request — handled by the wire-protocol error mapping, not by this contract.
- The credential store the helpers read from at the host — this spec does not require plugins to read credentials a particular way; if they do, they go through the host's published surface.
- The LLM client routing — plugins that need an LLM call use their own dependencies or the host's published wire surface; this contract does not name an LLM client field.
- Internal logger formatting, log levels, log destinations — this spec only commits to "the plugin receives a logger and its lines flow through the host's pipeline".
- The help formatter's exact section ordering — this spec only commits to "a known plugin's commands are tagged with its declared section, and untagged commands fall through to a generic section".

## Data Contracts

### Plugin Package Manifest (static, on disk)

| Property | Required? | Meaning |
| --- | --- | --- |
| Stable plugin identifier | Required | An opaque random string the plugin embeds in its own package manifest. The host's allow-listing uses this string, not the package name. A plugin whose identifier is unknown to the host is silently not loaded. Identifier values are intentionally not derived from package names so that rebrands and rename migrations of the plugin do not require a host release. |
| Host-version peer range | Optional | A semver range expressed against the host CLI. When present, the host loads the plugin only if the host's own version satisfies the range. An absent peer range means "compatible with any host". A host version that itself fails to parse as semver is treated as not satisfying any present range — a conservative default that refuses to load peer-constrained plugins against an unverifiable host. |
| Module entry path | Optional | A path inside the plugin package that resolves to the module the host will dynamically import. When absent, a documented default applies. The resolved path is required to stay inside the plugin's own directory; an entry that escapes upward is rejected. |
| Package name | Required (for display only) | Used only in diagnostic strings (warnings, install hints, the plugin's scoped logger namespace). Never used to decide whether to load the plugin. |
| Package version | Optional (for display only) | Surfaced in diagnostics; not load-gating. |

The plugin manifest may carry any other fields it wants; the host reads only the four above.

### Plugin Module Exports (runtime, imported by host)

| Export | Required? | Shape |
| --- | --- | --- |
| Named registration entry | Required | A function taking exactly one argument (the runtime context, defined below) and returning either nothing or a promise that resolves to nothing. The host awaits the return value before proceeding to parse command-line arguments. A throwing or rejecting entry causes the plugin to be skipped with a warning; the rest of the host's startup continues. |

A module that omits the registration entry, or whose registration entry is not callable, is skipped with a warning. No other exports are read.

### Runtime Context Object (handed from host to plugin)

| Field | Stability | Meaning |
| --- | --- | --- |
| Root command program | Stable | The host's top-level command-parser instance. The plugin uses this to register its top-level commands, attach descriptions, set per-command flags (notably the "hide this command from help" flag), and add aliases. The instance is the same one the host's built-ins were already registered on; the plugin sees them as siblings. |
| Host CLI version | Stable | A string identifying the host's own product version at runtime. The plugin may use it to gate features it implements differently against different hosts. |
| Scoped logger | Stable | A logger pre-namespaced to the plugin's package name. Lines the plugin writes through this logger flow through the host's normal log pipeline (level filtering, file destination, console redirection rules — all owned by the host). The plugin must not reach for the host's logger module directly. |

The context object's shape is a stability boundary:

- **Adding** a new optional field is non-breaking — plugins that ignore it continue to work.
- **Removing or renaming** an existing field is breaking — it requires a major-version bump of the host, and plugins re-pin their peer range at that point.

The context is constructed fresh per plugin per invocation. The host hands each plugin a distinct logger instance scoped to that plugin's name.

### Host-Provided Utility Surface (importable from the host's published package)

The host re-exports a small set of pure functions and type definitions from its published API so plugins can consume them as named imports without depending on internal modules.

| Surface | Shape | Behavior |
| --- | --- | --- |
| Tenant-URL parser | Function from auth-token string to "metadata object or null" | Decodes the tenant URL from a Jolli-format auth token. Returns null for any input it cannot decode. Never throws. The returned URL has already passed the host's save-time origin allow-listing; plugins with a narrower or wider trust boundary may run an additional check before using it. |
| Base-URL parser | Function from auth-token string to "parsed URL parts object or null" | Same null-on-failure contract; never throws. |
| Metadata-shape and parsed-URL-shape types | Type-only exports | Provided alongside the parsers so plugin authors get static checking against the same shapes the host uses internally. |

These are the only host functions promised to be importable by plugins under this contract. The host's other internal modules are not part of the published surface and may move freely.

### Per-Command "Hidden" Flag

The plugin may mark any command it registers as hidden from the host's primary help output. The host's help formatter honors this flag through the same generic mechanism it honors it for any of its own internal commands. The command is still callable by name; it just does not appear in help listings.

### Per-Command Provenance Tag (set by host, not by plugin)

When a known plugin successfully registers commands, the host privately tags each command the plugin added with a "help section" identifier drawn from the host's registry entry for that plugin. The host's help formatter then groups commands by this tag, not by command name. The tag is invisible to the plugin (the plugin does not set it); the contract for the plugin is simply "you do not need to worry about which help section your commands land under — the host bins them by provenance".

## Behavior

### Discovery (boundary — owned by the plugin loader)

The host has, at some earlier moment in its startup, identified zero or more plugin candidates on disk, validated their static manifest fields, and confirmed that their host-version peer range (if present) is satisfied. From this point onward in the contract, each surviving candidate is loaded.

### Per-Plugin Load

For each surviving candidate, in deterministic order:

1. The host dynamically imports the plugin module from its declared entry path.
   - Failure to import (missing file, syntax error, unresolved dependency): warning emitted, candidate skipped, host continues to the next candidate.
2. The host inspects the imported module for the named registration entry.
   - Missing or non-callable: warning emitted, candidate skipped, host continues.
3. The host snapshots the current top-level command namespace — every primary name and every alias of every command already on the program. This snapshot is the basis for collision detection during the upcoming registration call. The snapshot is private to the plugin's call; it is rebuilt fresh for the next plugin.
4. The host constructs the runtime context object for this plugin (root program, host version string, plugin-scoped logger).
5. The host installs collision-tolerant interceptors on the root program's "register new top-level command" and "attach an existing command" entry points, and on the "add alias" entry points of every command the plugin creates through them. The interceptors transform collisions from "fatal throw" into "record, skip the offending name, return a chainable stand-in" so a plugin that collides on one command still gets its remaining commands registered. The interception scope is narrow — see Notable Behavior.
6. The host awaits the plugin's registration entry, passing the context object as the only argument.
   - Successful return: collected collision names (if any) are emitted as a warning to both the host's general log and the plugin's scoped logger, and the plugin is recorded as loaded.
   - Throw or promise rejection: warning emitted (including the error message), the plugin is recorded as not loaded. Commands the plugin had already registered before throwing are left in place; the host does not attempt to roll them back.
7. The host removes the collision-tolerant interceptors before the next plugin loads.
8. The host privately walks the commands the plugin added during this call and tags each one with the help-section identifier registered for this plugin (if any).

The host never invokes the same plugin's registration entry twice in one invocation. Plugins may assume "register is called exactly once per CLI invocation".

### Stub Fallback (for known-but-absent or known-but-rejected plugins)

After all real plugins have loaded, the host walks its registry of known plugins. For every known plugin not in the loaded set, the host invokes the registry's fallback hook (if present), which registers stand-in commands matching what the real plugin would have provided. Each stand-in:

- Carries the same provenance tag the real plugin would have received, so it groups under the same help section.
- Prints a multi-line install hint on the standard error stream and exits non-zero when invoked, so scripts that depended on the real command fail loudly rather than silently no-op. **One carve-out exists and is deliberate:** where the real command's caller is a machine consumer that parses the command's standard output as JSON, a stand-in may instead emit a machine-readable "needs input" object on standard **output** and exit **zero**, so the consumer sees "the plugin must be installed" as a normal branch of its own parse rather than as a crash. A stand-in may therefore be asymmetric across its own subcommands — one subcommand taking the JSON/exit-zero shape while its siblings take the prose/exit-non-zero shape. Consumers are expected to detect absence by whichever of the two shapes the surface they call actually uses; the asymmetry is part of the contract, not drift.
- Tolerates unknown flags and positional arguments on its own command line, so a user typing the full invocation they would have typed against the real plugin reaches the install hint instead of a parser error.
- Tolerates name collisions identically to a real plugin: a stand-in whose name is already occupied is skipped, and the rest of the stand-in batch still registers.
- A throwing stand-in registration is caught and warned, identical to a throwing real-plugin registration; the host continues.

A known plugin that omits the fallback hook is silently absent when not installed; the user sees nothing for it in help. This is a deliberate per-plugin choice carried in the registry, not a contract surface for the plugin itself.

### Command-line Parsing

After plugin loading and stub fallback registration have both completed, the host proceeds to parse the user's command line against the now-fully-populated program. The plugin's registered commands are eligible to match exactly as if they were built-ins.

### Action Invocation

When the user runs a plugin-registered command, the action handler the plugin attached during registration runs in the host's process. The host does not wrap or proxy the handler. The plugin's handler is responsible for everything the command does, including its exit code (via the process's exit-code property, since the host does not interpret the handler's return value as a status).

## State Transitions

### Plugin Lifecycle (single host invocation)

```
candidate-on-disk
   │  (peer range satisfied, entry resolves, module imported)
   ▼
registration-entry-present
   │  (host snapshots namespace, builds context, installs interceptors)
   ▼
registering          ←─── (entry runs; may add commands, set aliases, mark hidden)
   │
   ├──► throw / reject  ──► not-loaded
   │                            │
   │                            ▼
   │                       (host warns; partially-registered commands remain)
   │
   └──► return / resolve ──► loaded
                                │
                                ▼
                          (host tags newly-added commands with help section,
                           emits any collected collision warnings)
```

After this lifecycle completes for every candidate, the host walks the known-plugin registry once more and registers stand-ins for every known plugin whose state is not `loaded` and which carries a fallback hook. The host then parses argv and dispatches.

There is no teardown step. The host's lifecycle ends when the process exits; the plugin gets no notification.

### Contract Versioning

The host carries its own product version, exposed to the plugin as part of the runtime context. The plugin declares an optional peer range against the host. Compatible changes to this contract:

- **Adding** an optional field to the runtime context, or an optional export the host reads from the plugin: non-breaking. Existing plugins keep working; new plugins may opt to read the new field.
- **Removing or renaming** a field of the runtime context, or changing the registration entry's expected signature: breaking. The host bumps a major version. Plugins re-pin their peer range to include the new major.

A plugin that uses the broad `>=` lower-bound form of its peer range (rather than the caret form) keeps satisfying future minor and patch bumps of the host without re-publishing; the loader's range check enforces only the lower bound. A breaking change crosses a major version and is therefore visible to the plugin's lower bound.

## Notable Behavior

- **Single dispatch shape.** Every plugin gets the same single named entry function. There is no "manifest of capabilities", no event-bus subscription, no permissions descriptor. Whatever the plugin wants to do, it does inside its registration call by mutating the context's command program. (Notable: a deliberately minimal contract.)
- **Registration runs on every CLI invocation, including help and version queries.** Commands must already be registered for the parser to recognize them. Plugins must keep their registration entry cheap — no file I/O, no subprocesses, no network. Heavy work belongs in the action handlers the plugin attaches, where it only runs when the user actually runs the command. (Notable: defines the performance contract.)
- **Plugins are co-maintainers of the host's command namespace, not sandboxed code.** The host intercepts only the four entry points that would otherwise throw a fatal "duplicate name" error during the plugin's registration call: registering a new top-level command, attaching an existing command, and the two alias-setting entry points on a command the plugin created. The host deliberately does **not** intercept reads or mutations through the program's existing command array — a plugin can attach sub-subcommands under a built-in, replace a built-in's action, or add aliases to a built-in already on the program. The trust model is that an allow-listed plugin lives inside the same package-installation boundary as the host and is treated as a co-maintainer of the namespace, not as untrusted code. The collision interceptors are an ergonomics gate, not a privilege boundary. (Notable; intentional.)
- **A plugin must not bring its own copy of the command-parsing library.** The plugin uses the program instance passed in the context. A plugin that imports its own bundled copy gets a separate command-parser type whose prototypes do not match the host's, breaking the parser's instance checks. (Notable: a real failure mode this contract is designed to prevent.)
- **No host capability is implicitly granted besides what is in the context object.** There is no global "host services" registry the plugin can reach into. If a plugin needs to read or write something the host owns (auth tokens, on-disk state, the LLM wire surface), it does so through the host's published surface (notably the re-exported parsers) or through its own dependencies. (Notable: the surface area of the contract is exactly the context object plus the named re-exports.)
- **The re-exported parsers exist precisely because the alternative is per-plugin reimplementation.** Token parsing is non-trivial enough that re-implementing it per plugin would risk drift in security-sensitive ways. The host commits to keeping the parsers' names and shapes stable. (Notable: rationale.)
- **A plugin's `register` is called exactly once per host invocation.** The host never replays it, retries it, or runs it concurrently with itself. Plugins may treat the call as a one-shot setup. The host loads plugins serially, not in parallel. (Notable: defines re-entrancy and concurrency for the contract.)
- **A throw or rejection from a plugin's `register` is non-fatal to the host.** The host emits a warning, records the plugin as not-loaded, and continues. Commands the plugin had already added before throwing are left in place — there is no rollback. The host then proceeds to register stand-ins for that plugin's known-registry entry (if any), which is collision-tolerant against whatever the plugin partially registered. (Notable: defensive; intentional.)
- **A plugin that throws after partial registration produces a hybrid state.** The user sees whatever subset of the plugin's commands made it onto the program, plus stand-ins for the rest if the plugin is in the known registry. This is judged less bad than fully unregistering the partial commands (which would require tracking ownership) or refusing to register stand-ins (which would leave the user with no install hint to recover). (Notable; consequence of the no-rollback choice.)
- **Name and alias collisions on new commands are silently absorbed into a warning.** A plugin that tries to register a command whose primary name or any alias collides with a name or alias already on the program (built-in or earlier plugin) has the colliding command silently dropped from the program, and the collision is recorded for a single warning emitted after the plugin's `register` returns. Chained calls on the dropped command (description, alias, action) still return a chainable stand-in so the rest of the plugin's setup code does not crash mid-statement. (Notable: ergonomics-driven.)
- **Collisions are reported back through both the host's general log and the plugin's scoped logger.** This gives the plugin author a single grep against their own logger namespace to find their own diagnostics, in addition to the user-facing host warning. (Notable.)
- **The same `register` invocation cannot self-collide.** Names a plugin registers during its own call are added to the occupied set immediately, so a plugin registering both `foo` and a `bar` aliased as `foo` will have the alias rejected, not the primary registration. (Notable: ordering matters within a single `register` call.)
- **Help-section grouping is by provenance, not by command name.** A plugin registering a generically-named command (e.g. a name another plugin's section also happens to use) will not be mis-bucketed: the host tags each command with the plugin's declared section after `register` returns. A command that has no registered section (third-party plugin not in the host's registry) falls through to a generic "other" section. (Notable: deliberate, addresses a real misclassification risk.)
- **Hidden-command marking goes through the same flag the host uses for its own internal commands.** Plugin authors do not need to know the internal property name — they pass a public option to the command-parser library. The host probes the resulting flag through multiple property names so a future rename of the parser library's internal field does not silently un-hide plugin commands that opted out of help. (Notable; defensive.)
- **A peer-range mismatch is a load-time refusal, not a runtime check.** The host evaluates the peer range once during discovery and either loads or skips. A plugin whose peer range admitted a host that later behaves incompatibly has no second chance — the contract's compatibility guarantee is rooted in the peer range. (Notable.)
- **Unparseable host versions fail any present peer range.** A host running a development build whose version string does not parse as semver will not load any plugin that declared a peer range. Plugins with no peer range still load. The rationale: refusing to gamble that a malformed-version host satisfies a constraint the host cannot prove. (Notable; conservative.)
- **The host never claims a plugin is "working" merely because it was discovered and peer-compatible.** Discovery success and peer-range success are necessary but not sufficient: a broken module body, an import failure, or a throwing `register` still produces a "not loaded" outcome. Any diagnostic surface that reports "this plugin is present" must not be read as "this plugin is functioning". (Notable; carefully scoped.)
- **The host loads each known plugin from at most one location per invocation.** If the same plugin identifier is installed in multiple places reachable to the host, the first wins; the others are silently ignored. Two packages claiming the same identifier within the same scope at the same location are an authoring mistake the host warns about; the lexicographically-first one wins. (Notable; the loader spec covers the path resolution itself, but the contract guarantees "loaded once per identifier per invocation".)
- **Stand-in commands for a known-but-missing plugin are not a sandbox.** They are a UX backstop only: they reserve names in help, print install hints when invoked, and fail loudly. A user invoking a stand-in does not get any of the real plugin's behavior — even read-only behavior. (Notable: scoping the stub-fallback promise.)
- **The plugin's logger namespace is derived from the plugin's package name.** Plugin authors can `grep plugin:<name>` in the host's debug log to find their own diagnostics. The host does not promise any particular log-level filtering for plugin lines; whatever the host's pipeline does for its own modules applies. (Notable.)
- **The host's published utility re-exports are kept available even when the host's bundler would normally tree-shake them.** A plugin importing the parsers from the host's published entry must always succeed. This is a maintained guarantee, not a side effect of how the host happens to bundle today. (Notable: defines the durability of the import contract.)

## Shared Behavior

- The discovery walk, allow-listing by stable identifier, peer-range evaluation, scope-directory scan, monkey-patching of the command-parser's name-registration entry points, deterministic ordering when the same identifier is present in multiple locations, and the on-disk cache of the package manager's global root are defined by the **Plugin Loader** spec. This contract assumes those mechanics have already produced the "load this plugin" decision and concerns itself only with what happens from the dynamic import onward.
- The format and decoding of the Jolli-format auth token whose tenant URL the re-exported parser returns is defined by the **Jolli API Key Format and Parsing** spec. This contract only commits to "the parser is re-exported and returns null on undecodable input".
- The save-time origin allow-listing the host applies to tenant URLs (so the parser's return is known-acceptable to the host) is defined by the **Auth Credential Storage** spec.
- The "outdated plugin" failure surfaced when the backend rejects a request from a too-old product version is defined by the **Plugin Outdated Flow** spec; that is a wire-protocol mapping, distinct from this contract's host-side load-time peer check.
- The help formatter's section ordering and the inventory of which built-ins and which stand-ins land where is defined by the **CLI Help Output Grouping** spec; this contract only commits to "the host tags by provenance, you do not pick the section".
- The three currently-known plugins and the command surfaces each one provides are documented in their respective product specs; this contract neither names them nor enumerates their commands. The host's promise here is shape-only: "stand-ins exist for missing known plugins; real registrations replace stand-ins when present".
