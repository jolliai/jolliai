# 128. IntelliJ Delegated Hook Installation

## Topic Statement

The JVM IDE surface installs no hooks of its own: it performs four small native preparations inside the IDE process, copies the command-line runtime it bundles into a stable per-user directory, and then asks that runtime — over the long-lived host bridge, not as a fresh child process — to perform the entire install or teardown, naming explicitly which directory the machine-global runtime registry should be pointed at.

## Scope

**In scope:**

- The install sequence's remaining native steps: the per-project state directory, the ignore-file guard and the two opt-outs it honours, the legacy agent-hook-entry sweep across two host settings files and its worktree scoping, and the read-only legacy git-hook body scan.
- Delegation of the whole hook set to the command-line surface's **full** enable, and of teardown to its full disable — as **bridge actions on a long-lived server**, with a one-shot child process only as the fallback.
- The request each direction sends, including the two install flags that are **mutually exclusive** and the explicitly-injected runtime directory that keeps the registry off the IDE's version-scoped copy.
- The bundled runtime copy: what is copied, where, the fingerprint cache that can now skip it, the completeness condition that gates that skip, the lock that serialises it, and the write ordering the cache depends on.
- The **two independent stamps** in that directory and the opposite lifetimes they carry.
- The bounded wait on a delegated run, which now really bounds it.
- The per-run install log.
- The refusal outcome a disabled repository produces, and how this surface reports it.

**Out of scope (boundaries):**

- What the delegated enable actually does — hook bodies, dispatch-script indirection, per-source runtime selection, skills, and host registration — owned by the install-orchestration and registry topics.
- The five-outcome result type of the delegated run, its shared warning copy, the version-gated narrowed catch-up, and the stale-registration self-heal trigger — spec 249.
- Marker-based detection of which git hooks are present — spec 271.
- The runtime this surface spawns and the hard gate in front of it — spec 284.
- The bridge transport itself: the long-lived server, its binding to a project, and the freshness check it performs against one of the stamps below — spec 288.
- Which lifecycle event decides *when* install, uninstall, or the catch-up runs — spec 124.
- The enable/disable **gestures** and their surrounding UI lifecycle — spec 332.

## Data Contracts

### Bundled runtime artifact

The plugin package embeds the command-line surface's build output — its bundled entry file plus every per-hook and per-worker entry script, but not the editor-extension bundle — inside its own installation tree. That tree is **version-scoped by the IDE**: it disappears on a plugin uninstall and moves on an IDE major upgrade.

The copy target is a fixed per-user directory beside the product's other machine-global state, chosen precisely because it survives both events. Every bundled script is copied there, overwriting.

### Two stamps, two lifetimes

The destination directory holds **two** independent stamp files, and confusing them is easy because both encode a version:

| Stamp | Means | Written | Cleared |
| --- | --- | --- | --- |
| **Enabled stamp** | "the delegated enable ran green for this plugin version" | Only after a delegated **install** reports a real success | On any failure or thrown error of a delegated install |
| **Extract stamp** | "the files on disk match the bundle we last saw" | Last write inside the copy lock, after every script has landed | Never explicitly; superseded when the fingerprint changes |

The enabled stamp is the one a live bridge connection re-reads on every call to decide whether its connected process is stale, which is why it is published atomically — written to a sibling temporary file and moved into place, falling back to a non-atomic replacing move only where the filesystem refuses an atomic one. A reader that caught an in-place truncate would read an empty version, judge its connection stale, and tear down every call already in flight.

The extract stamp deliberately **survives a disable**, while the enabled stamp does not. That asymmetry is what lets a disable-then-enable cycle skip the file copy entirely while still re-running the delegated enable.

### Extraction fingerprint

The extract stamp holds a fingerprint composed of the plugin version **and the newest modification time across every bundled script**.

The plugin version alone is too coarse: during development the version string is unchanged across rebuilds while every copied script gets a fresh modification time, so a version-keyed cache would serve the previous build forever. Content hashing was rejected as a full read on a hot path, and file size was rejected because it misses a pure reformat. The known cost is a volume with second-granularity modification times: two rebuilds inside the same second produce the same fingerprint and the second is skipped. Deleting the stamp, or touching any bundled script, forces a re-copy.

### Legacy archive marker

A single substring identifies any hook entry or hook body written by the retired archive-based install. It is used only for **recognition** — to delete legacy agent-hook entries, and to log legacy git-hook bodies. It is never written.

### Install log

A single per-user log file, **overwritten on every run**, so it always describes the most recent attempt and nothing earlier. It is written on both the success and the exception path, so a failed install still leaves a log.

## Behavior

### Install sequence

1. **Create the per-project state directory** (recursively) so later steps and the delegated run have somewhere to write.
2. **Ignore-file guard.** The project's ignore file is checked for an entry covering the state directory. Each existing line is normalised by stripping a leading comment marker and then a leading negation marker, and compared against both the trailing-slash and bare forms. Because the normalisation strips both markers, **a negation line and a commented-out line each count as an existing entry** and suppress the write — a user who deliberately negated or commented out the entry is not overridden.
3. **Legacy agent-hook-entry sweep.** Two host settings files under the **current worktree** are rewritten to remove any hook entry whose serialised form carries the legacy archive marker. The affected event array is removed once it becomes empty, and the enclosing container once *it* becomes empty. This runs before the delegated enable, and again before the delegated disable. It is scoped to the current worktree, not to the main repository root, so a legacy entry in a sibling worktree's settings is not swept by this project's install.
4. **Read-only legacy git-hook body scan.** The five git-hook files under the resolved shared hooks directory are scanned for the legacy marker and any hit is **logged only**. Nothing is modified, renamed, or backed up: the delegated enable replaces a legacy body in place, because the marker pair delimiting the product's hook section is byte-identical to the one the command-line surface writes. The hooks directory is resolved worktree-aware, so the same set of files is scanned whichever worktree opened the project.
5. **Refresh the bundled runtime copy** in the per-user destination (see below).
6. **Delegate the full enable** as a bridge action, with the project directory as the working directory.
7. **Stamp, clear, or neither** — see the three outcomes below.
8. **Write the install log**, overwriting the previous run's file. This happens on both the success and the exception path.

### Refreshing the bundled runtime copy

The copy is no longer unconditional. It runs in two stages:

**Fast path (no lock).** Enumerate the bundled scripts, compute the fingerprint, and return immediately when **both** of the following hold:

- every bundled script is present in the destination, and
- the extract stamp's contents equal the current fingerprint.

The completeness half is not redundant with the stamp. The stamp being written last inside the lock rules out a copy that never finished; it says nothing about a script **deleted after** the stamp landed — an external cleanup, a virus scanner's quarantine. A stamp-only check would then skip forever at that plugin version, leaving a runtime the shared dispatcher cannot serve and that the registry's own completeness gate would refuse to register. An empty enumeration of the bundle is treated as **not complete**, so a bundle that could not be listed falls through to the copy rather than certifying an empty destination. The fast path's stamp read is wrapped defensively: a sharing violation from a concurrent writer falls through to the locked branch rather than escaping.

**Locked path.** Take an operating-system file lock on a sentinel file in the destination, then **re-enumerate and re-check the same two conditions** — the process just waited on may have completed the copy — and skip if they now hold. Otherwise copy every bundled script over the destination, and write the extract stamp **last**. The lock exists because two projects opening at once share the one destination and an overwriting copy is not atomic: an interleaved write can leave a partially-written entry that then breaks the very process that ran the copy.

The copy runs on both the enable and the disable path, since both go through the same runner.

### The delegated run

Both directions are **bridge actions**, preferring a long-lived server bound to the project and falling back to a one-shot child process when none is bound or the call fails locally. Before either, the surface resolves the runtime executable and refreshes the bundled copy, so it can still answer the two specific "cannot even start" outcomes rather than a generic failure.

**Every install request carries an explicit runtime directory**, set inside the shared runner rather than by its callers so neither can forget it. Without it the registry writer defaults to *the directory of the bundle executing the install* — which was correct by construction while the delegation was a child process launched from the extracted copy, and is wrong now that the same code runs inside a server the surface launches preferentially from its own **version-scoped** installation tree. The registry would then point at a directory that dies on plugin uninstall or IDE major upgrade. Getting it wrong is invisible: the shared hook dispatcher exits silently by design so it never blocks source control, so the only symptom is capture quietly stopping. Naming the stable copy explicitly is also what keeps the registry entry and the enabled stamp describing the same directory.

The receiving side validates that directory: it must be absolute and must exist, both rejected loudly rather than passed through, because the value is written into the registry and later used to execute a script on the blocking source-control path.

**The enable request carries exactly one of two mutually exclusive flags.** An explicit user action sends *clear-the-opt-out-on-success*; an automatic path sends *respect-the-opt-out*. Sending both would ask the runtime to honour the durable opt-out and then erase it — contradictory on its face, and in the reachable case (a stale cached verdict let an automatic install run against a disabled repository) it also wrote a no-op value into the profile file that the surface's own file watcher is watching, burning a refresh for nothing.

**The disable request always asks for the full teardown**, with the front-door menu preserved and the durable opt-out persisted — never the narrowed integrations-only form, which would remove only the registrations and leave every hook installed.

### Three outcomes of a delegated install

The reply is classified in this order, and the order matters:

1. **Refused because the repository is manually disabled** — checked **first**, because it arrives carrying *success*. Nothing was written, so no success side effect may fire: in particular **no enabled stamp is written**, since stamping would tell the version gate that this plugin version is fully enabled and suppress every later catch-up. Equally it is not a failure. This surface reports it as an unsuccessful result carrying its own discriminator and its own message, and callers must keep it out of the error state the tool window paints in red.
2. **Success** — the enabled stamp is written now, after a confirmed success, so an interrupted or failed run is never mistaken for a completed one. A full enable is a superset of the narrowed one, so it stamps too.
3. **Anything else, including a thrown transport or local error** — the enabled stamp is **deleted**, so the next startup retries.

A delegated **disable** never touches the enabled stamp at all: a teardown does not invalidate the record of the last successful enable, and the next install re-stamps cleanly.

### The bounded wait now really bounds the run

A delegated install or disable carries a sixty-second budget, and it is enforced on both transports: the long-lived server's call has that wait budget, and the one-shot fallback waits on the child for that long and then **forcibly terminates it**. A server call that exhausts the budget is surfaced as a timeout rather than retried on the one-shot path, because the server is still running the action and a second process would start the same side-effectful operation again.

### Uninstall

Uninstall runs the same legacy agent-hook-entry sweep, refreshes the bundled runtime copy through the same cached path, and delegates the full disable. Its outcome is mapped to success or failure only — there is no refusal branch, because a disable never asks the runtime to respect the opt-out.

### What is no longer done

- **The delegation is no longer a fresh child process per operation.** It is a bridge action against a long-lived server, with the child process kept only as a fallback.
- No archive is located, copied, or resolved: there is no bundled archive, no per-user archive destination, no in-tree search, no depth-limited walk, and no development-build fallback for one.
- No separate runtime executable is resolved beyond the one the whole plugin already requires: nothing reads a JVM home or falls back to a bare interpreter token, because no hook this surface installs invokes one.
- **Nothing in the plugin is executable on its own.** There is no program entry point in its sources and no executable manifest in its build, so an installed hook cannot call back into the plugin even in principle.
- **The archive a previous version installed is deliberately left on disk.** It is neither deleted nor rewritten — simply orphaned. Removing it was explicitly declined, because other repositories may still carry legacy hook bodies pointing at it until they are re-enabled.

## State Transitions

### Enabled stamp

```
[absent]                → delegated install succeeds                → [present, current plugin version]
[present, any version]  → delegated install fails or throws         → [absent]
[present, any version]  → delegated install REFUSED (disabled repo) → [unchanged]
[present, any version]  → delegated disable                         → [unchanged]
[present, older version]→ observed by a live bridge connection      → connection respawned (spec 288)
```

### Extract stamp and the destination directory

```
[fingerprint matches AND every bundled script present] → refresh is a no-op
[fingerprint differs]                                  → copy every script, then stamp
[fingerprint matches, a script went missing]           → copy every script, then stamp
[bundle could not be enumerated]                       → treated as incomplete → copy branch
[disable]                                              → extract stamp survives; enabled stamp untouched
```

## Notable Behavior

- **The plugin ships no archive and no entry point.** Every hook it installs is a dispatcher script run under an external runtime. This is a complete inversion of the earlier posture, in which the plugin's own runtime executed the hooks.
- **The install now names the directory it wants registered, instead of letting the registry infer one.** The inference was right only while the delegation was a child process launched from the very directory being registered. Once the same code runs inside a server the surface prefers to launch from its own version-scoped installation tree, the inferred answer points at a directory that dies on the next plugin uninstall or IDE major upgrade — and because the shared hook dispatcher exits silently by design, the failure presents as capture quietly stopping rather than as an error. (Surprising; the bug this closes is invisible by construction.)
- **The two install flags are mutually exclusive and one of them is always sent.** *Respect the opt-out* belongs to automatic paths only; *clear it on success* belongs to explicit user actions only. Both together is self-contradictory, and it was reachable — a stale cached verdict was enough.
- **A refusal arrives as a success and must be classified before the success branch.** Treating it as an ordinary success wrote the enabled stamp, which made the version gate permanently satisfied for that plugin version so the later catch-up never ran again, and told the caller an install had landed. This surface therefore re-reports it as *unsuccessful* with its own discriminator — the opposite polarity from the runtime's own reply — precisely so no success side effect can fire, while separately requiring callers not to render it as an error. (Surprising; the same fact is spelled `success` on one side of the boundary and `not success` on the other, deliberately.)
- **The bounded wait is now real.** Both transports enforce it, and the one-shot fallback forcibly terminates a child that outlives it. The earlier arrangement drained the child's output stream to completion *before* starting the wait, so the cap could never fire and a wedged child hung the calling thread with no upper bound. That is no longer the case. (Notable; this reverses the single most consequential property the previous delegation had.)
- **A server call that times out is not retried on the fallback path.** The server is still running the action, so a second process would start the same side-effectful operation from scratch.
- **The runtime copy is now cached, and the cache key is deliberately not the plugin version.** It is the version plus the newest modification time across the bundled scripts, because during development the version does not move while every script's timestamp does. The residual gap — two rebuilds inside one second on a coarse-timestamp volume — is documented and accepted, and reachable only by a developer.
- **The cache's skip condition is two-part, and the second part is what makes it safe.** Write ordering (stamp last, inside the lock) only rules out a copy that never finished. A script deleted *after* the stamp landed needs the separate presence check, or the surface would skip the copy forever at that plugin version and leave a runtime the shared dispatcher cannot serve. The expected set is derived from the bundle itself rather than from a hand-kept list, so it cannot drift from what the registry's completeness gate demands.
- **The two stamps have opposite lifetimes on a disable.** The record of "the last enable ran green" is cleared by a failed install and left alone by a disable; the record of "the files match the bundle" survives everything until the bundle changes. That is what lets a disable-then-enable cycle skip the copy while still re-running the enable.
- **The whole runtime bundle is still refreshed on the disable path, not only on enable** — through the same cached routine, so in the common case it is now a few file stats rather than a copy.
- **The ignore-file guard treats a commented-out entry as an entry.** Stripping the comment marker before comparison means a commented line suppresses the write exactly as a live one would. This is deliberate: it lets a user opt out of the guard by commenting rather than by deleting.
- **The legacy agent sweep is worktree-scoped while the delegated enable is not uniformly so.** The sweep looks only under the current worktree's host settings files; the delegated enable installs git hooks once against the repository and agent hooks per worktree.
- **The legacy git-hook scan is deliberately read-only.** Because this surface's marker pair and the command-line surface's are identical, the delegated enable replaces a legacy body in place. A native rewrite would only risk corrupting a file the delegated run is about to own, so the scan exists purely to leave a trail in the install log.
- **The install log is a single-attempt artifact.** Because it is overwritten, a support request that arrives after the user retried an install has no record of the original failure.
- **The injected runtime directory is validated at the receiving end, not trusted.** It must be absolute and must exist. A relative path would resolve against whatever working directory a hook happened to run in, and a non-existent one would register a dead entry that fails silently on the blocking source-control path.

## Shared Behavior

- **IntelliJ MCP and Skills Integration (249)** — owns the delegated run's outcome set (including the refusal), the shared warning copy, the version-gated narrowed catch-up, the stale-registration self-heal trigger, and the enable/disable asymmetry. This spec owns the install sequence's native steps, the runtime copy and its cache, the stamps, and the request shape.
- **IntelliJ Enable / Disable Surface (332)** — owns which gesture calls install versus uninstall, the cached verdict those gestures flip, and the roll-back on failure.
- **The manual-disable opt-out (145)** — owns the durable flag both install flags refer to, and the rule that an automatic install must respect it while an explicit one clears it.
- **The zero-write contract (304)** — owns the reading that a refusal is a *success* discriminator on the runtime's side of the boundary, and the inventory of everything else a disabled repository refuses.
- **IntelliJ Node.js Runtime Detection and Hard Gate (284)** — produces the runtime every delegated step needs; nothing here runs without it.
- **IntelliJ CLI Daemon Connection (288)** — owns the long-lived server this delegation prefers, and reads the enabled stamp on every call to decide whether to respawn, which is why that stamp is published atomically.
- **IntelliJ Project Service Lifecycle (124)** — decides when install, uninstall, and the catch-up run; this spec defines what they do.
- **IntelliJ Pre-Push Sync Catch-Up (271)** — owns the marker-based detection of which git hooks are present, all that remains of this surface's own hook awareness.
- **The install-orchestration and runtime-registry topics** — own the hooks, dispatch scripts, skills, and registrations the delegated enable actually writes; this surface's contribution is byte-identical to every other surface's.
