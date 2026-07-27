# 248. IntelliJ Git-Operation Queue (Retired)

## Topic Statement

This topic previously described a native per-commit git-operation queue owned by the IDE plugin: a post-commit hook that ran inside the plugin's own runtime and enqueued one file per git event, a detached drain worker that processed those files in creation order under a per-repo lock, a per-run cap, a stale-entry prune, a chain-spawned successor, and a dispatch table routing each operation kind to a consolidation / one-to-one-migration / full-pipeline handler. That queue no longer exists on this surface. The plugin installs no hook of its own and runs no queue: every git event is captured by the command-line surface's own hooks and drained by its own queue worker.

## Scope

**In scope:**
- Recording that the IDE-native queue — enqueue, one-file-per-operation layout, creation-order drain, lock acquisition and periodic lock refresh, per-run cap, stale prune, per-entry delete-regardless-of-outcome, once-per-drain wiki step, lock release, chain-spawn, and kind-based dispatch — has been removed from the plugin entirely.
- The supersession relationship: the queue that captures IDE commits is now the cross-surface command-line queue, reached through the git hooks the plugin's install step delegates to.

**Out of scope:**
- The surviving cross-surface queue — its entry format, drain order, per-run cap, lock protocol, chain-spawn, and dispatch table — owned by the queue-worker, queue-entry-format, and worker-chain-spawn specs (34, 35, 37).
- The per-commit summarization pipeline the "commit" arm of that queue runs — owned by the CLI-side summarization specs.
- The plugin's install step that writes no hooks and delegates to the full command-line enable — spec 128.
- Detection of which git hooks are present — spec 271.

## Data Contracts

There is no live data contract for this topic. The plugin defines no queue directory, no queue-entry shape, no stale threshold, no per-run cap, and no dispatch table. The queue directory under the per-project state directory is still written and drained — but only by the command-line surface, against its own contract (spec 35).

## Behavior

### Current reality

The plugin's install step creates the per-project state directory and then delegates the whole hook set to the command-line surface's full enable. The resulting `post-commit`, `post-rewrite`, `prepare-commit-msg`, `post-merge`, and `pre-push` hooks are the command-line surface's own dispatcher scripts, byte-identical to those installed by the other surfaces. A commit made from the IDE therefore fires exactly the same hook, writes exactly the same queue entry, and is drained by exactly the same worker as a commit made from a terminal. The only thing the IDE contributes to that path is a one-shot marker recording that the commit originated from this surface — and even that marker is written through the command-line surface rather than by the plugin directly.

Nothing in the plugin enqueues, drains, locks, refreshes a lock, prunes, caps a run, chain-spawns a successor, or dispatches by operation kind.

### Retired behaviors

The following behaviors this topic used to describe are **no longer present**:

- The in-plugin post-commit hook, its rebase bail-out, its kind/source/branch/created-at capture, and its detached worker spawn.
- The backward-compat alias by which a stray single-commit worker invocation from an older installed hook drained the queue instead.
- The drain worker's own lock acquisition, its ~60-second lock refresh during long model calls, its twenty-operation per-run cap, its twenty-four-hour stale prune, and its per-entry delete-regardless-of-outcome loop.
- The once-per-drain wiki ingest-and-render appended in the drain's `finally`, the drain-completed telemetry event, and the post-release successor chain-spawn.
- The kind → handler dispatch table, including the plugin-side `rebase-pick` / `rebase-squash` arms that its own producers never reached.

## State Transitions

None. This topic has no live surface.

## Notable Behavior

- **The divergent stale threshold is gone with the code.** This topic previously flagged a twenty-four-hour prune against the command-line surface's seven days as an accidental divergence. With the IDE queue removed there is one prune rule, the command-line surface's, and the divergence no longer exists.
- **The double-processed amend is gone with the code.** The plugin no longer enqueues an amend operation alongside its own synchronous post-rewrite handling, because it runs neither. One amend now takes one path.
- **Rebase is no longer a special case on this surface.** The plugin's post-commit hook used to bail out for the whole duration of a rebase, leaving rebase entirely to a separate synchronous hook. The command-line hooks it now installs handle rebase through the same queue as everything else.
- **The queue directory is still watched by the plugin, even though the plugin no longer writes to it.** The IDE's own file watcher observes the per-project state directory so a drain performed by the command-line worker refreshes the tool window (specs 125 and 289).

## Shared Behavior

- **Git Operation Queue Worker (34), Queue Entry Format (35), Worker Chain Spawn (37)** — own the surviving cross-surface queue that now captures IDE commits too.
- **IntelliJ Delegated Hook Installation (128)** — owns the install step that installs the command-line hooks instead of the plugin's own.
- **IntelliJ Pre-Push Sync Catch-Up (271)** — owns what remains of the plugin's hook awareness: marker-based detection only.
- **IntelliJ Post-Commit Summarization Pipeline (254)** — the retired per-commit pipeline this queue's "commit" arm used to dispatch.
