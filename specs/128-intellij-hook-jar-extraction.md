# 128. IntelliJ Delegated Hook Installation

## Topic Statement

The IntelliJ surface installs no hooks of its own. Its install step performs four small native preparations inside the IDE process — creating the per-project state directory, guarding the ignore file, sweeping legacy agent-hook entries out of two host settings files, and logging (never touching) any legacy git-hook bodies it finds — and then hands the entire hook set to the bundled command-line surface's full enable, which writes all five git hooks, the AI-agent hooks, the skills, and the MCP registration. The runtime the plugin bundles for this is a set of plain script files copied out of the plugin into a per-user directory under a file lock, stamped with a version only on success. This surface ships **no archive and no entry point of its own**: nothing in the plugin can be executed as a standalone program, and the archive a previous version used to install is deliberately left on disk rather than deleted.

## Scope

**In scope:**
- The install sequence's remaining native steps: per-project state-directory creation; the ignore-file guard and the two opt-outs it honours; the legacy agent-hook-entry sweep across two host settings files and its worktree scoping; the read-only legacy git-hook scan that only logs.
- Delegation of the whole hook set to the command-line surface's **full** enable, and of uninstall to its disable.
- The per-run install log: where it goes and the fact that it is overwritten rather than appended.
- The bundled runtime artifact: what is bundled, where it is copied, that the copy overwrites unconditionally, that it is serialised by a lock so two projects cannot interleave, and that it runs on both enable and disable.
- The version stamp: what it records, that it is written only on a successful delegated run and deleted on any failure, and that it must be published atomically because a live reader consumes it.
- The grounded consequence that the delegated run's stated timeout can never fire.

**Out of scope (boundaries):**
- What the delegated enable actually does — hook-script generation, dispatch-script indirection, per-source version selection, skills, and MCP host registration — owned by the CLI-side install specs and, for the version-gated integrations-only catch-up and the four-outcome result type, by **IntelliJ MCP and Skills Integration** (249).
- Marker-based detection of which git hooks are present — spec 271.
- The Node runtime the delegated run needs, and the hard gate in front of it — spec 284.
- The per-project service lifecycle that decides *when* to install — spec 124.
- The long-lived bridge connection that also reads the version stamp — spec 288.

## Data Contracts

### Bundled runtime artifact

The plugin bundles a directory of plain script files (the command-line surface's build output, minus the editor-extension bundle) inside its own installation tree. The install-time copy target is a fixed per-user directory:

- Source: a `cli-dist/` directory inside the plugin's installation tree.
- Destination: `<user-home>/.jolli/jollimemory/dist-intellij/`.

Every `*.js` file in the source is copied, overwriting whatever is at the destination. There is no per-file version comparison and no skip-if-unchanged shortcut. The packaging step that produces the bundle fails the build outright when the command-line build output it copies from is missing, so a plugin distribution never ships without it.

### Extraction lock

The copy is serialised by an operating-system file lock on a sentinel file (`.extract.lock`) in the destination directory, so two projects (or a project and a settings action) opening at once cannot interleave partial copies.

### Version stamp

A `.version` file in the destination directory holds the plugin version that last completed a successful delegated run. It is written **only** when the delegated process exits zero, and deleted on a non-zero exit and on a thrown exception — so its presence means "this plugin version's integrations completed," never merely "an attempt was made."

The stamp is published atomically: it is written to a temporary sibling and moved into place with an atomic move, falling back to a non-atomic replacing move only where the filesystem refuses an atomic one. Atomicity is required because a live reader consumes the stamp on every bridge call (spec 288): a reader that observed the empty window of an in-place truncate would judge its connection stale and tear down every in-flight call.

### Legacy archive marker

A single substring (`jollimemory-hooks`) identifies any hook entry or hook body written by the retired archive-based install. It is used only for **recognition** — to delete legacy agent-hook entries, and to log legacy git-hook bodies. It is never written.

### Install log

`<user-home>/.jolli/logs/jollimemory-install-debug.log`, **overwritten on every run** — the file always describes the most recent attempt and nothing earlier. It is written on both the success and the exception path, so a failed install still leaves a log.

## Behavior

### Install sequence

1. **Create the per-project state directory.** The `.jolli/jollimemory` directory under the project directory is created (recursively) so later steps and the delegated run have somewhere to write.
2. **Ignore-file guard.** The project's ignore file is checked for an entry covering the state directory. Each existing line is normalised by stripping a leading comment marker and then a leading negation marker, and compared against both the trailing-slash and bare forms of `.jolli`. Because the normalisation strips both markers, **a negation line and a commented-out line each count as an existing entry** and suppress the write — a user who has deliberately negated or commented out the ignore entry is not overridden. Only when no line matches under that normalisation is the entry added.
3. **Legacy agent-hook-entry sweep.** Two host settings files under the **current worktree** — the Claude host's local settings file and the Gemini host's settings file — are rewritten to remove any hook entry whose serialised form contains the legacy archive marker. The affected event array is removed once it becomes empty, and the enclosing hooks object is removed once *it* becomes empty; the file is rewritten pretty-printed. This sweep runs **before** the delegated enable, and again **before** the delegated disable. It is scoped to the current worktree, not to the main repository root — so a legacy entry written into a sibling worktree's settings is not swept by this project's install.
4. **Read-only legacy git-hook scan.** The five git-hook files under the resolved git directory's hooks directory are scanned for the legacy archive marker and any hit is **logged only**. Nothing is modified, renamed, or backed up: the delegated enable replaces a legacy body in place, because the marker pair delimiting the plugin's hook section is byte-identical to the one the command-line surface writes. The git directory is resolved worktree-aware — a `.git` directory is itself, while a `.git` pointer file is followed to the main repository's git directory.
5. **Copy the bundled runtime** into the per-user destination under the extraction lock (see Data Contracts).
6. **Delegate the full enable.** The bundled entry is invoked as the command-line surface's `enable` with the non-interactive flag and a source tag identifying this surface, with the project directory as the working directory. This is what installs all five git hooks, the AI-agent hooks, the skills, and the MCP registration.
7. **Stamp or clear.** On a zero exit the version stamp is written; on a non-zero exit or a thrown exception it is deleted.
8. **Write the install log**, overwriting the previous run's file. This happens on both the success and the exception path.

### Uninstall

Uninstall runs the same legacy agent-hook-entry sweep, copies the bundled runtime again, and then delegates to the command-line surface's `disable`. The runtime copy on the disable path is unconditional and identical to the one on the enable path — the whole bundle is re-copied on every enable *and* every disable.

### The delegated run's timeout is inert

Both the delegated enable and the delegated disable read the child's standard output to completion with a blocking full-stream read, and **only then** wait on the process with a sixty-second cap. The blocking read returns only when the child closes its output stream — normally at exit. **The sixty-second cap can therefore never fire:** a child that hangs while holding its output stream open blocks the calling thread indefinitely, with no timeout and no force-kill. (The two other one-shot spawns this surface makes — AI generation and the Memory Bank migration — redirect output to a file instead, and their timeouts do apply.)

### What is no longer done

- No archive is located, copied, or resolved: there is no bundled archive, no per-user archive destination, no in-plugin-tree search, no depth-limited walk, and no development-build fallback for one.
- No separate runtime executable is resolved: nothing reads a Java home, checks for a Java binary, or falls back to a bare interpreter token, because no hook the plugin installs invokes one.
- No diagnostic search log is written: the per-user archive-search transcript file is gone. The only file this topic writes is the install log.
- There is no absent / stale / current state machine over an installed archive, because there is no installed archive to be in one of those states.
- **Nothing in the plugin is executable on its own.** There is no program entry point in the plugin's sources and no executable manifest in its build, so the installed hooks cannot call back into the plugin even in principle — they run the copied scripts under the resolved Node runtime.
- **The archive a previous version installed is deliberately left on disk.** The per-user archive from a pre-delegation install is neither deleted nor rewritten by this surface; it is simply orphaned. Removing it was explicitly declined.

## State Transitions

### Version stamp

```
[absent]                     → delegated run exits 0        → [present, current plugin version]
[present, any version]       → delegated run exits non-zero → [absent]
[present, any version]       → delegated run throws         → [absent]
[present, older version]     → next enable exits 0          → [present, current plugin version]
[present, older version]     → observed by a live bridge connection → connection respawned (spec 288)
```

### Bundled runtime destination

```
[absent or any prior contents] → every enable AND every disable → [overwritten with the current plugin's bundle]
```

There is no "up to date, skip the copy" transition.

## Notable Behavior

- **The plugin ships no archive and no entry point.** Every hook it installs is a script dispatcher run under Node. This is a complete inversion of the previous posture, in which the plugin's own runtime executed the hooks and Node was optional.
- **The retired archive is intentionally abandoned rather than cleaned up.** An upgrading user is left with a dead archive in their home directory. It is harmless because no installed hook references it any more, and deleting a file the plugin no longer controls was judged riskier than leaving it.
- **The delegated run's stated sixty-second cap is unreachable.** The output stream is drained to completion before the wait begins, so the wait always finds an already-exited process — or never gets to run at all. This is the single most consequential property of the delegation: a wedged child hangs the calling thread with no upper bound.
- **The whole runtime bundle is re-copied on disable, not just on enable.** Disabling a project therefore refreshes the same per-user directory that enabling does.
- **The ignore-file guard treats a commented-out entry as an entry.** Stripping the comment marker before comparison means `# .jolli/` suppresses the write exactly as a live `.jolli/` line would. This is deliberate: it lets a user opt out of the guard by commenting rather than by deleting.
- **The legacy agent sweep is worktree-scoped while the delegated enable is not uniformly so.** The sweep looks only under the current worktree's host settings files, matching where the plugin's own agent-hook detection looks; the delegated enable installs git hooks once against the repository and agent hooks per worktree.
- **The legacy git-hook scan is deliberately read-only.** Because the plugin's marker pair and the command-line surface's are identical, the delegated enable replaces a legacy body in place. A native rewrite would only risk corrupting a file the delegated run is about to own, so the scan exists purely to leave a trail in the install log.
- **The install log is a single-attempt artifact.** Because it is overwritten, a support request that arrives after the user retried an install has no record of the original failure.
- **The version stamp is a success record, not an attempt record.** Its deletion on failure is what lets the next project open re-run the delegated enable without a stale "already done" reading.

## Shared Behavior

- **IntelliJ MCP and Skills Integration (249)** — owns the delegated run's four-outcome result type, the shared warning copy, the version-gated integrations-only catch-up (and the extra stale-MCP trigger for it), and the disable asymmetry. This spec owns only the install sequence's native steps, the artifact copy, and the stamp.
- **IntelliJ Node.js Runtime Detection and Hard Gate (284)** — produces the runtime every step here spawns; nothing in this sequence runs without it.
- **IntelliJ CLI Daemon Connection (288)** — reads the version stamp on every bridge call and respawns its connection when it changes, which is why the stamp is published atomically.
- **IntelliJ Project Service Lifecycle (124)** — decides when install, uninstall, and the catch-up run; this spec defines what they do.
- **IntelliJ Pre-Push Sync Catch-Up (271)** — owns the marker-based detection of which git hooks are present, all that remains of the plugin's own hook awareness.
- **The CLI-side install specs** — own the hooks, dispatch scripts, skills, and MCP registration the delegated enable actually writes; this surface's contribution is byte-identical to every other surface's.
- **IntelliJ Native Git CLI Wrapper (126)** — supplies the worktree-aware repository-root resolution the install sequence consumes, and the interactive-shell path resolution the spawned processes inherit.
