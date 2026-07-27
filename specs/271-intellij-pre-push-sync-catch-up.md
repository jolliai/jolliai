# 271. IntelliJ Pre-Push Sync Catch-Up

## Topic Statement

The IntelliJ plugin's read/trigger side of a pre-push memory-sync feature whose engine lives only in the Node CLI (no Kotlin port). Three concerns: (1) marker-based **detection** of whether the git hooks are present — the plugin installs none of them itself, so `pre-push` is no longer distinctive in any way; (2) a read-only view of the CLI's pending-push queue file used purely for conservative, never-gating bookkeeping; and (3) a best-effort "drain the pending pushes" trigger that spawns the Node worker, guarded by a cheap file-existence pre-check, invoked from two lifecycle moments so commits left un-synced by a prior push get retried.

## Scope

**In scope:**

- The marker-based git-hook presence detection the plugin retains: which markers it looks for, that all five must be present for the "all git hooks installed" answer, and the composite check that adds the agent hook.
- The read-only pending-push queue reader: the file it reads, what it returns, and the conservative contract that its output **never** gates retention.
- The pending-push drain trigger: its cheap pre-check, the Node worker it spawns, the wait-or-detach option, its never-throw contract, and every place it is invoked.

**Out of scope (boundaries):**

- The pre-push sync **engine** itself — the pending-push queue's on-disk format, the pre-push hook's own logic and script guards, the worker's push-to-Space mechanics, the compensation/rollback on a failed push, and the shared dispatcher — all live in the Node CLI and are owned by the CLI-side pre-push specs (the pre-push hook, the pre-push worker, and the pending-push store). There is **no** Kotlin port of any of it.
- The Space-sync engine — it has no Kotlin port and no IntelliJ trigger at all. **The same is now true of the Memory Bank / vault-sync engine**, which was ported to Kotlin and has since been removed: the IntelliJ surface drives a round through a single bridge call and owns none of the engine (spec 219).
- The per-push resolution of unresolved-orphan hashes that *consumes* the pending-push reader inside the two push pipelines — see **IntelliJ Share-to-Jolli Core** (252) and **IntelliJ Push Orchestration** (263).
- The overall hook-install/uninstall flow and worktree resolution — owned by **IntelliJ Delegated Hook Installation** (128); this spec covers only the presence *detection* that remains in the plugin.
- The project-service startup sequence and the settings sign-in flow that invoke the drain — owned by **IntelliJ Project Service Lifecycle** (124) and **IntelliJ Settings Surface** (135); this spec covers only the drain call they make.
- The bundled-CLI extraction, Node resolution, and MCP/skills enablement the same integrations bridge also performs — owned by the CLI-integrations spec; referenced here only where the drain reuses that bridge's Node-resolution and extracted-dist location.

## Data Contracts

### Git hook presence detection (all the plugin retains)

The plugin **installs no hook scripts at all**. Its install step delegates the whole hook set to the command-line surface's full enable (spec 128), which writes five git hooks — `post-commit`, `post-rewrite`, `prepare-commit-msg`, `post-merge`, `pre-push` — plus the AI-agent hooks, all as dispatcher scripts run under the resolved Node runtime. `pre-push` is therefore no longer distinctive: every hook on this surface reaches the Node CLI through the same dispatcher, and none of them runs inside the IDE's own runtime.

What survives in the plugin is a marker-based read:

- A per-hook presence test: read the hook file under the resolved git directory and answer whether it contains that hook's marker.
- The markers are the section-opening lines `# >>> JolliMemory <name> hook >>>` for each of the five names. These are **byte-identical** to the markers the command-line surface writes, which is what lets the delegated enable replace a legacy body **in place** rather than appending a second section beside it.
- An "all git hooks installed" answer requiring **all five** markers to be present.
- A composite "all hooks installed" answer that additionally requires the Claude agent hook when the caller says Claude is required. This composite has no shipped caller — nothing gates on it.

Detection is read-only: nothing in this path writes, rewrites, or deletes a hook file.

Note that the presence answer these checks produce is **not** what gates the plugin's auto-install. That gate reads the command-line surface's status snapshot, whose "enabled" field is computed from **four** of the five sections — `pre-push` is excluded from it — so a repository with every hook but `pre-push` and a repository with all five both report enabled.

### Pending-push queue reader (read-only)

A read-only view of the CLI's pending-push queue file, at the per-project path `.jolli/jollimemory/push-pending.json`. It returns the set of queued commit hashes:

| Situation | Return |
| --- | --- |
| File absent | Empty set. |
| File present and parseable | The set of commit-hash keys under the JSON object's `entries` map (or empty set if there is no `entries` object). |
| File present but unparseable | `null`. |

**Conservative contract:** a `null` (unparseable) result means "the reader cannot say what's pending" and callers treat it as *possibly pending*. Critically, **this reader never gates retention of anything** — the two push pipelines that consult it (252, 263) always retain an unresolved hash regardless of what the reader reports; they read it *only* to log how many retained hashes look in-flight versus abandoned. See Notable Behavior.

This reader mirrors the CLI queue file's shape but is a separate, minimal read-only implementation; it never writes, unlinks, or locks the file.

### Pending-push drain trigger

A best-effort routine that spawns the bundled Node pre-push worker to drain `push-pending.json` to the Jolli Space. Inputs: the project directory, and a `waitForCompletion` flag (default false).

- **Cheap pre-check:** returns immediately when `.jolli/jollimemory/push-pending.json` is absent **or** zero-length. Because the CLI's pending-push store unlinks the file when it becomes empty, mere existence (with content) means there is at least one entry worth trying. This keeps the common case — an ordinary commit with nothing pending — from ever paying a Node spawn.
- **Node + worker resolution:** resolves a `node` executable via the shared integrations bridge (login-shell PATH resolution); returns if Node is absent. Locates `PrePushWorker.js` in the plugin's extracted-CLI dist directory (`~/.jolli/jollimemory/dist-intellij/`); returns if it isn't there.
- **Spawn:** runs `node <PrePushWorker.js> --cwd <projectDir>` with the project directory as the working directory, discarding the worker's stdout/stderr.
- **Wait vs. detach:** when `waitForCompletion` is true, blocks on the worker for a bounded timeout (and force-kills it on timeout); otherwise returns immediately, leaving the worker running detached. The parameter is still supported, but **no shipped call site passes true** — every live caller detaches, so the waiting branch is unreachable in production.
- **Never throws:** a missing worker, absent Node, non-git directory, or an offline network simply leaves the pending entries for the next trigger. The worker itself self-no-ops when the user isn't signed in.

## Behavior

### Getting the pre-push hook installed

The plugin does not write it. Its install step performs a few native preparations and then invokes the bundled command-line surface's full enable, which installs all five git hooks (including `pre-push`) and the AI-agent hooks as dispatcher scripts. The result is byte-identical to what the command-line and editor-extension surfaces install, including the hook's own runtime guards — so IntelliJ gets the same per-push behavior without any surface-specific script. See spec 128 for the install sequence and spec 268 for the installed hook's own logic.

### Detecting that it is installed

Presence is answered by reading the hook file and looking for its marker section, per the contract above. Because the markers match the command-line surface's exactly, a legacy hook body written by an older version of this plugin is recognized as the same section and replaced in place by the delegated enable rather than duplicated.

### Reading the pending queue (never gating)

When a push pipeline finishes a summary push and needs to resolve the memory's unresolved-orphan hashes, it consults the reader for the current pending set — but only to classify each *retained* (still-unresolved) hash as "still in-flight" (present in the pending set) versus "abandoned" (absent), for a log line. The retain/drop decision is made entirely by re-reading each hash's stored summary for a server doc id; the pending set is never consulted for that decision. A `null` from the reader is treated as "unknown," which suppresses the in-flight tally without changing what is retained.

### Draining pending pushes

1. Cheap pre-check: if there is no non-empty pending-push file, return immediately (the hot path for a normal commit).
2. Resolve Node; return if absent.
3. Locate the extracted `PrePushWorker.js`; return if absent.
4. Spawn the worker against the project directory, discarding its output.
5. If asked to wait, block (bounded) until it exits, force-killing on timeout; otherwise leave it running detached.
6. Never propagate a failure — any error is logged and swallowed; pending entries survive for the next trigger.

### Where the drain is invoked

Two call sites, both fire-and-forget:

- **Plugin startup** — the project-service initialize sequence dispatches the drain **fire-and-forget, off the EDT**, before marking the service initialized (see 124). This retries commits left pending by a push made in a previous session (e.g. an offline push, or a push that raced ahead of summary generation) without blocking init.
- **Post-sign-in on the IDE-native settings page** — the sign-in success callback dispatches the drain **fire-and-forget, off the EDT** (see 135). This drains commits left pending by pushes made while signed out. Notably, only the IDE-native settings page's sign-in button gained this step; the gear-icon settings dialog's sign-in buttons did not.

There is **no post-commit call site on this surface any more.** The plugin's own queue-drain worker — which used to invoke this drain and wait for it after regenerating summaries — no longer exists (spec 248). Post-commit-time draining is now performed by the command-line queue worker's own "trigger push for new summaries" step, which runs in the same process that generated the summary and needs no IDE involvement.

## State Transitions

The pre-push hook and the drain are stateless triggers, not state machines. The observable progression of a single pending commit is:

1. A push enqueues the commit into `push-pending.json` (CLI engine, out of scope) — possibly while offline or before its summary exists.
2. Some later moment fires the drain (plugin startup or post-sign-in), or the command-line queue worker's own post-commit push trigger fires, or the next `git push` fires the pre-push hook directly.
3. The Node worker pushes the commit's memory to the Space and, on success, removes it from the queue; the store unlinks the file once empty.
4. If the worker can't run (no Node, no dispatcher, offline, signed out), the entry remains and step 2 recurs at the next opportunity.

## Notable Behavior

- **No IntelliJ hook uses the IDE's runtime any more, so `pre-push` is no longer an exception to anything.** All five git hooks and both agent hooks are the command-line surface's own dispatcher scripts, written by the delegated enable and run under Node. The plugin's contribution to the hook story is now exactly two things: marker-based presence detection, and the two drain triggers below. (Notable; this reverses the single most surprising fact this spec used to carry.)
- **The "all git hooks installed" answer gates nothing.** It requires all five markers, but no shipped caller consults it — and the check that *does* gate auto-install (the command-line status snapshot's enabled field) excludes `pre-push` from its computation. So a repository missing only `pre-push` reads as enabled and is never re-installed on that basis.
- **The installed hook's safety guards are still there, just not written here.** The delegated hook cannot abort a user's push (an executable-existence test, error swallowing, and previous-status capture/restore); those guards are the command-line hook's own and are owned by spec 268. This surface neither writes nor varies them.
- **The pending-push reader never gates retention.** It exists only to *log* an in-flight-vs-abandoned count. Dropping an unresolved hash merely because it isn't in `push-pending.json` would be unsafe: a worker that succeeded on the network but crashed before writing the doc id back would leave an orphaned Space article whose only local trace is that hash. So the pipelines always retain an unresolved hash and the reader's output changes only a log tally. A `null` (unparseable) result is treated conservatively as "unknown." (Notable; the reason the reader is deliberately non-authoritative.)
- **The drain's cheap pre-check keeps the common commit free.** The pending-push store unlinks its file when empty, so a normal commit with nothing pending returns from the drain before ever resolving Node or spawning a process. Node is spawned only when there is genuinely something to push. (Notable.)
- **The drain is exhaustively best-effort.** Every dependency it needs (Node on PATH, the extracted worker, a signed-in user, a reachable network) can be absent, and in each case it silently leaves the queue for the next trigger — it never throws, never blocks init, and never fails a commit or a sign-in over a sync it couldn't complete. (Notable.)
- **Neither remaining call site waits, so the wait branch is dead.** Both live triggers are fire-and-forget off the EDT. The one caller that ever passed the wait flag was the plugin's own post-commit drain worker, which no longer exists; the parameter and its bounded-wait-then-force-kill branch survive with no shipped caller. (Notable.)

## Shared Behavior

- **The pre-push sync engine** — the pending-push queue format, the pre-push hook logic, the worker's push mechanics, and the compensation on failure — is Node-only, shared verbatim with the CLI and VS Code, and owned by the CLI-side pre-push specs (pre-push hook, pre-push worker, pending-push store). IntelliJ reuses these through the shared dispatcher and the extracted worker; it does not re-implement them.
- **Node resolution and the extracted-CLI dist** — the login-shell PATH resolution for `node` and the `~/.jolli/jollimemory/dist-intellij/` extraction location are the same integrations bridge that enables MCP + skills (owned by the CLI-integrations spec); the drain reuses both.
- **Unresolved-orphan resolution that reads the pending queue** — **IntelliJ Share-to-Jolli Core** (252) and **IntelliJ Push Orchestration** (263) each consult the reader (never gating) during their orphan-resolution step.
- **Drain call sites** — **IntelliJ Project Service Lifecycle** (124) owns the startup dispatch; **IntelliJ Settings Surface** (135) owns the post-sign-in dispatch. Post-commit-time draining is the command-line queue worker's, not this surface's.
- **Hook installation** — **IntelliJ Delegated Hook Installation** (128) owns the install sequence that delegates all five git hooks and both agent hooks to the command-line surface's full enable, plus worktree-aware git-directory resolution. This spec covers only the presence detection left in the plugin.
- **The installed pre-push hook itself** — its script body, its guards, and the worker it dispatches into are the command-line surface's, owned by the git pre-push hook and worker spec (268) and the pending-push store and drain-engine specs (269, 270).
- **IntelliJ CLI-Delegated Sync Orchestration and UI** (219) — the Memory Bank sync engine is likewise Node-only now; the plugin drives a round through a single bridge call and owns no engine.
