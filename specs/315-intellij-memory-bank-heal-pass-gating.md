# 315. IntelliJ Memory Bank Heal Pass Gating

## Topic Statement

Before the IntelliJ Memory Bank tree reads a repository's manifest, it runs a **visible-Markdown heal** for that repository — regenerating any `<branch>/<slug>-<hash8>.md` that vanished from disk while its canonical `.jolli/summaries/<hash>.json` is still there — so a manifest row whose rendered file was deleted does not silently disappear from the tree. The heal itself is not implemented in Kotlin: [`FolderHealer`](../intellij/src/main/kotlin/ai/jolli/jollimemory/core/FolderHealer.kt) is a decision-free adapter that marshals `{kbRoot}` into the CLI's `folder-heal-visible-markdown` IDE-bridge action and unmarshals a `{healed, skipped, failed, droppedIds, error}` record, converting any thrown failure into that same record with `error` set. What this spec owns is the **gating** around that call: because heal is a bridge round-trip that writes disk, `KBExplorerPanel` throttles it with two per-repository sets keyed by absolute `kbRoot` — a clean-repo cache that suppresses heal indefinitely once a pass reports nothing to do, and a 30-second failure cooldown that stops a dead daemon from costing one bridge timeout per repository per rebuild. Both sets are cleared wholesale, and only by two signals; the tree's own cache reload deliberately clears neither.

## Scope

**In scope:**
- The `Result` record, its `isClean()` predicate, and the request shape sent over the bridge.
- The adapter's error policy, threading requirement, and the deliberate omission of the orphan-dropping flag.
- Where in the tree build the heal fires, and the exact order of the two gates.
- The clean-repo cache and the failure-cooldown map: their keys, their lifetimes, and every site that clears them.
- Which repository states heal on every rebuild, which heal once, and which never heal.
- The correction this spec makes to spec 193's scope.

**Out of scope:**
- The heal algorithm itself — what counts as missing, how a summary JSON is re-rendered into Markdown, and the `dropOrphanedManifestEntries` semantics at the storage seam (owned by specs 02 and 03).
- The `jolli heal-folder` command surface (owned by spec 190) and the cutover routing state its manifest-drop precondition is decided from (owned by spec 344).
- The IDE-bridge transport, daemon lifecycle, and one-shot spawn fallback (owned by specs 287 and 288).
- The manifest and index reads that follow the heal in the same loop (owned by spec 314).
- The tree's node model, badges, expansion, search, and timeline grouping (owned by spec 193).
- The repo-scope filter that decides *which* repositories the loop iterates (owned by spec 316).

## Data Contracts

### `FolderHealer.Result`

```kotlin
data class Result(
    val healed: Int = 0,
    val skipped: Int = 0,
    val failed: Int = 0,
    val droppedIds: List<String> = emptyList(),
    val error: String? = null,
)
```

A Kotlin mirror of the CLI's `HealResult` (`cli/src/core/StorageProvider.ts`), kept as a record so the counts survive the JSON round-trip as numbers. Every field defaults, so a bridge reply missing a field decodes rather than throwing. A Gson `null` result is coerced to `Result()`.

`isClean()` is `healed == 0 && failed == 0 && error == null` — deliberately **not** a test on `skipped`. A pass that skipped a hundred already-present files is clean; a pass that regenerated one file is not, and neither is a pass that could not regenerate one.

### The request

`{"kbRoot": "<absolute path>"}`, plus `"dropOrphanedManifestEntries": true` **only** when the caller explicitly opts in. The sidebar never does — `healVisibleMarkdown(repo.kbRoot)` takes the `dropOrphans = false` default, and the adapter omits the property entirely rather than sending `false`.

The `projectDir` argument on the bridge call is `CliIntegrations.resolveDefaultCwd()` and exists only to route to a daemon instance; the heal's scope comes entirely from `kbRoot` in the request body.

### What the bridge does with it

`folder-heal-visible-markdown` (`cli/src/commands/IdeBridgeCommand.ts:1962-1981`) constructs a `MetadataManager` over `<kbRoot>/.jolli` and a **`FolderStorage`** over `kbRoot` — the folder backend directly, not the dual-write composite — then returns `storage.healMissingVisibleMarkdown({ dropOrphanedManifestEntries: dropOrphans })`.

### Gating state

Two per-panel collections in `KBExplorerPanel`, both keyed by `repo.kbRoot.toString()` (an **absolute** path, so a repository relocated by a migration into `<repo>-2/` is a new key and cannot inherit a stale verdict):

| Field | Type | Meaning |
|---|---|---|
| `cleanRepos` | `ConcurrentHashMap.newKeySet<String>()` | Repositories whose last heal returned `isClean()`. Membership suppresses heal outright. |
| `healErrorAt` | `ConcurrentHashMap<String, Long>` | Epoch-millis of the last heal that returned a non-null `error`. |

`HEAL_ERROR_COOLDOWN_MS = 30_000L`.

## Behavior

### Where the heal fires

Inside `KBExplorerPanel.buildTree`'s per-repository loop, **before** the manifest and index are read (`KBExplorerPanel.kt:460-479`), for each repository the current repo-scope filter admits. The ordering is the whole point: the tree is built by walking each branch directory for `.md` files and cross-referencing the manifest, so a manifest row whose rendered file is gone is invisible unless heal has already put it back.

### The gate, in order

For each repository, with `repoKey = repo.kbRoot.toString()`:

1. If `repoKey` is in `cleanRepos` → **skip**. No bridge call.
2. Otherwise, if `healErrorAt[repoKey]` exists and `now - it < HEAL_ERROR_COOLDOWN_MS` → **skip**. No bridge call.
3. Otherwise call `FolderHealer.healVisibleMarkdown(repo.kbRoot)` and branch on the result:
   - `error != null` → log at WARN (`"healMissingVisibleMarkdown for <repoKey>: <error>"`) and stamp `healErrorAt[repoKey] = now`. The repository is **not** added to `cleanRepos`.
   - `error == null` → `healErrorAt.remove(repoKey)` unconditionally, then add to `cleanRepos` **only if** `isClean()`.

The tree render continues in every branch. A failed heal never aborts the build, never surfaces to the user, and leaves the tree rendering whatever is on disk.

### Invalidation

Both collections are cleared together, wholesale, at exactly two sites:

- The VFS bulk listener (`:325-333`), when a create / delete / move event lands under the Memory Bank parent — the precise class of change that can put the visible layer out of step with the manifest. It then triggers a background `refresh()`.
- `resetMigration()` (`:1093-1094`), after a forced re-migration has written fresh JSON and Markdown.

There is no per-repository invalidation and no time-based expiry on `cleanRepos`.

### Threading

Every heal invocation must run off the EDT: the bridge call can fall through to a cold Node spawn (roughly 500 ms) and the heal itself scans and writes disk. `buildTree` is reached only from pooled-thread paths — `load()` and `refresh()` are invoked via `executeOnPooledThread` at each of their call sites, and `setRepoFilter` dispatches its rebuild onto a pooled thread explicitly.

## State Transitions

Per repository, keyed by absolute `kbRoot`:

| From | Event | To | Notes |
|---|---|---|---|
| Unknown (in neither set) | Heal returns `isClean()` | In `cleanRepos` | No further bridge call until an invalidation. |
| Unknown | Heal returns `healed > 0` (no error) | Unknown | Any error stamp is cleared, but the repository is **not** cached clean — it heals again on the next rebuild. |
| Unknown | Heal returns `failed > 0`, `error == null` | Unknown | Same as above: not clean, error stamp cleared, heals again next rebuild — indefinitely. |
| Unknown | Heal returns `error != null` | Stamped in `healErrorAt` | WARN logged; skipped for 30 s. |
| Stamped, within 30 s | Rebuild | Stamped | Skipped, stamp untouched — the window is measured from the last *attempt*, and a skip is not an attempt. |
| Stamped, after 30 s | Rebuild | Re-attempt | Outcome per the rows above. |
| In `cleanRepos` | Rebuild | In `cleanRepos` | Skipped. |
| Any | VFS create/delete/move under the Memory Bank parent, or migration reset | Unknown | Both sets cleared for **every** repository, not just the affected one. |

## Notable Behavior

- **`reloadCache()` deliberately clears neither set.** Its docstring says so explicitly, and the two sites that *do* need heal re-armed clear them by hand immediately before calling `refresh()`. So the ordinary refresh chain — `resolveKBRoot` → `reconcile` → `reloadCache` → `rebuildCurrentView` — leaves a clean repository clean. The consequence is that the `GIT_REPO_CHANGE` listener (`:340-349`), which calls `refresh()` without clearing, does **not** by itself re-arm heal after a commit; the VFS event for the newly-written `.md` is what does. (Surprising; the two refresh triggers are not equivalent.)
- **A repository that heals successfully but never reaches clean re-heals on every single rebuild.** `cleanRepos` admits only `isClean()`, so a repository with one permanently un-regenerable file (`failed > 0`, `error == null`) clears its error stamp on every pass and is never cached — one bridge round-trip plus a full disk scan per tree rebuild, forever, with no log line after the first. The cooldown does not apply because the cooldown keys on `error`, and a per-file failure is not a bridge error. (Surprising; the throttle has a hole exactly where throttling would matter most.)
- **The clean cache has no expiry.** Once a repository is cached clean, the only ways back are a VFS event under the Memory Bank parent or a migration reset. A `.md` deleted by a process the VFS does not observe (a change outside the IDE's watched roots, or a refresh that never lands) stays missing from the tree for the life of the panel.
- **Only the TREE view heals.** `buildTimeline` (`:1275`) reads `KBDataCache` and never calls `FolderHealer`, and the Timeline's rows come from manifest entries rather than from the visible layer. A user who stays in Timeline view therefore never triggers a heal, and never observes one being needed — the missing-`.md` symptom is specific to the tree walk.
- **The sidebar must leave `dropOrphanedManifestEntries` false, and two independent things keep it false.** The flag drops manifest rows whose hidden JSON is also gone, which on a folder-only repository is data loss — the manifest is the last record there. The adapter's default is `false`, and the bridge handler additionally constructs `FolderStorage` **directly** rather than the dual-write composite, so the composite's seam default of `true` (spec 03) is never reached from this path. The `jolli heal-folder` CLI remains the only surface that opts in at all — and even it opts in **conditionally**, on the repository's cutover routing state rather than on any configuration value: only the pre-cutover state permits a drop, while a fenced or cut-over repository (and any repository whose routing state cannot be resolved) keeps every manifest row. See spec 344 for that state; the retired storage-mode configuration key decides nothing here.
- **A failed heal is invisible to the user.** `error` is logged at WARN and stamped; nothing reaches a notification, the status panel, or the tree. From the user's side, a Memory Bank whose daemon is dead and one whose visible layer is intact look identical — the tree simply keeps missing rows it cannot recover.
- **The cooldown protects a rebuild, not a session.** Thirty seconds is sized against the N-repositories-per-rebuild multiplication, not against a long outage: a Memory Bank with a dozen repositories and a dead daemon costs a dozen bridge timeouts, then goes quiet for 30 s, then costs a dozen more.
- **The adapter has no decisions of its own.** `FolderHealer` builds a request, calls the bridge, decodes the reply, and converts a throw into `Result(error = e.message ?: e.javaClass.simpleName)`. Every policy — when to call, whether to retry, what to cache — lives in the panel, which is why this spec's gating section is longer than its data contract.
- **Spec 193 states the opposite and is superseded here.** That spec lists the visible-layer heal as out of scope ("across the boundary; this panel only reads what is on disk") and, in its VS Code comparison, records the divergence as "VS Code runs heal as well as reconcile, this panel runs reconcile only". Neither is true of the current code: `buildTree` runs heal per repository before reading the manifest. This spec takes ownership of the heal pass and its gating; 193 keeps the tree.

## Shared Behavior

- **Folder-Based Summary Storage (02)** — owns `healMissingVisibleMarkdown` itself: what it considers missing, how it re-renders Markdown from summary JSON, and what it counts.
- **Dual-Write Summary Storage (03)** — owns the heal delegation at the composite seam (including its `dropOrphanedManifestEntries` default of true, which this path does not reach) and the dirty-marking on a thrown delegation.
- **CLI Heal-Folder Command (190)** — owns the terminal-invoked heal surface: the only caller that can opt into dropping manifest rows, and its operator-facing report.
- **Cutover Routing State Table (344)** — owns the routing state that CLI opt-in is decided from, and records that the former storage-mode configuration key is retired on the write side (read only to log that it is ignored).
- **CLI IDE-Bridge Command Surface (287)** — owns the `folder-heal-visible-markdown` action's registration and request validation.
- **IntelliJ CLI Daemon Connection (288)** — owns the transport, the daemon-versus-one-shot-spawn decision, and the latency this gating exists to ration.
- **IntelliJ Native Memory Bank Metadata Read (314)** — owns the manifest and index reads that immediately follow the heal in the same loop.
- **IntelliJ KB Explorer Panel (193)** — owns the tree this heal protects; its heal-related scope statements are corrected above.
- **IntelliJ Memory Bank Repo-Scope Filter (316)** — decides which repositories the healing loop iterates.
- **Memory Bank Migration Engine (215)** — owns the re-migration that `resetMigration()` drives before clearing both gating sets.
