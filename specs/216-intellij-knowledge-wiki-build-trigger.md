# 216. IntelliJ Knowledge-Wiki Build Trigger

## Topic Statement

The IDE plugin exposes exactly one knowledge-wiki build: a manual all-repos sweep behind a toolbar button in the Memory Bank browser panel. The button gates on credential presence, wraps a single delegated build call to the command-line surface in a non-cancellable background task, reports an aggregate toast, and forces a recursive refresh of the IDE's virtual file view so the freshly written wiki appears in the tree. The IDE performs no ingest of its own, runs no automatic post-commit build, and holds no build lock.

## Scope

**In scope:**
- The toolbar button: its always-enabled state, its credential precondition and message, its background-task wrapper and fixed progress text, the single delegated build call, the result toast text, the error toast, and the post-build filesystem refresh of the IDE's virtual file view.
- What the IDE sends into the delegated call and which fields of the returned aggregate it reads.
- Recording that the automatic post-commit ingest, the IDE-side sweep unit, the IDE-side concurrency guard, and the skip-on-busy outcome are gone.

**Out of scope (boundaries):**
- Everything the build actually does — Memory Bank repo discovery, per-repo storage construction, the ingest pipeline (batching, route/reconcile model calls, per-topic failure isolation, the high-water mark, processed-source marking, outcome codes), the orphan-page purge, the visible-wiki render, per-repo failure isolation, and whatever locking it uses — is owned by the command-line surface (specs 152, 156, 158, 160 and the vault-write-lock spec). The IDE observes only the aggregate it returns.
- The credential resolution chain and its precedence — spec 10. This spec treats credential presence as a single boolean precondition.
- The in-process LLM seam that survives on this surface for three summary-viewer actions — spec 217. It is **not** used by the wiki build.
- The Memory Bank browser panel that hosts the button (tree building, reset-migration action, refresh behavior) — spec 193.

## Data Contracts

### What the IDE sends

A single request carrying two fields:
- **The Memory Bank folder root** — the configured Memory Bank folder path, falling back to a fixed default parent when unset. This is the one path the IDE still computes locally.
- **The whole loaded configuration record**, serialized verbatim. The IDE does not assemble a narrowed LLM-configuration bundle; it hands over the entire configuration and lets the command-line side pick what it needs.

The call is issued against the resolved main repository root, falling back to the current project's base path.

### What the IDE reads back

From the returned aggregate the IDE reads exactly three things:
- **Total ingested** — the number of sources folded, summed across repos.
- **Failed count** — the number of repos that reported an error.
- **Repo count** — the length of the per-repo result list.

Each defaults to zero (an empty repo list) when absent. Per-repo names, per-repo batch counts, and per-repo error messages are present in the payload but never surfaced.

**There is no skip flag.** The aggregate no longer carries one, and the IDE branch that used to react to it has been removed.

### Credential precondition

A single boolean, true when any one of three is present: a configured direct provider (Anthropic) API key, a configured platform (jolli) API key, or the provider-API-key environment variable. False only when all three are absent. It is the same predicate the rest of the IDE uses to decide whether summary generation is possible, so this button and the cold-start / backfill surfaces agree.

Note that the predicate does **not** recognize a local-agent subscription: a user configured for a local agent and holding no keys is told to configure a key even though the command-line surface could drive the build.

## Behavior

### Toolbar button — the delegated all-repos build

The Memory Bank browser panel hosts an icon button. Clicking it:

1. **Loads the configuration.**
2. **Credential precondition.** If no credential is present, shows an information notification — "Building the knowledge wiki needs an API key. Open Settings → AI Summary to sign in or configure a key, then try again." — and returns. No work is started. The message points at the **AI Summary** settings tab, which is where all three credentials are entered.
3. **Resolves the Memory Bank folder root** from the configured folder path, falling back to a fixed default parent when unset.
4. **Spawns a non-cancellable background task** titled "Jolli Memory: Building knowledge wiki…". Everything below runs off the UI thread. Inside the task:
   1. Sets the progress text to a fixed "Compiling Memory Bank…". There is no per-repo progress callback and no per-folder progress text — the IDE cannot see individual repos being processed, because the whole sweep is one call.
   2. **Issues one delegated build call** carrying the folder root and the whole configuration record, and waits for it.
   3. **Success outcome.** Shows an information notification "Knowledge wiki updated: \<N\> source(s) across \<M\> repo(s)\<failed-note\>." where `<failed-note>` is " (\<K\> failed)" when one or more repos failed, and absent otherwise.
   4. **Refreshes the IDE virtual file view** rooted at the Memory Bank folder, recursively, on the UI thread — because the build wrote files through plain filesystem calls that the IDE's virtual file layer would not otherwise observe, so the freshly generated visible wiki appears in the panel's tree.
   5. **Failure outcome.** Any thrown exception is caught, logged at warn level, and surfaced as an error notification "Knowledge wiki build failed: \<message\>." The task does not rethrow.

The button is always enabled and visible regardless of sign-in or auto-sync state.

### No automatic build

Nothing on the IDE side triggers a wiki build after a commit. There is no IDE-side git-operation queue, no drain worker, and therefore no end-of-drain ingest step, no wait-mode lock acquisition, no deleted-wiki recovery probe, and no non-fatal-error contract around an automatic path. Whether an automatic post-commit ingest happens at all is a property of the command-line surface's own worker, not of this surface.

### No IDE-side concurrency guard

The IDE holds no lock, no process-wide flag, and no per-folder guard around the build. Two clicks in quick succession issue two delegated calls; whatever serialisation exists is entirely inside the command-line surface. Because the aggregate no longer carries a skip flag, a collision has no distinct user-visible outcome on this surface — the second call either completes normally or throws, and the IDE reports the normal success or failure toast accordingly.

## State Transitions

### Build outcome

```
click
 │
 ├── no credential                  → info notification, no task, no work
 ├── task runs, call returns         → success toast (with "(K failed)" when K > 0), recursive VFS refresh
 └── task runs, call throws          → caught, warn log, error toast; no VFS refresh
```

## Notable Behavior

- **The build is one call, so the IDE has no visibility into it.** Progress is a single fixed line for the whole sweep, and the IDE cannot name the repo it is working on, report a partial result, or cancel. The task is explicitly non-cancellable, which matches that: there is nothing to cancel on this side.
- **The success toast counts repos and sources, not topics.** It reports the total sources folded and the number of repos swept, with a parenthetical failed count only when something failed. Per-repo names and error messages come back in the payload and are dropped.
- **A partially failed build still reports success.** The toast is an information notification whenever the call returns, even when every repo failed — the failed count appears only as a parenthetical. Only a thrown call produces an error notification.
- **The virtual-file refresh is mandatory and IDE-specific.** The wiki files are written by another process through plain filesystem APIs the IDE does not observe, so the panel forces a recursive refresh of the Memory Bank root. Skipping it would leave the tree showing stale or missing wiki files until an unrelated refresh happened. Note the refresh runs only on the success path — a failed build leaves the tree unrefreshed even if the build wrote some repos before failing.
- **The "already running — skipped" outcome is gone.** The IDE used to show "Another knowledge wiki build is already running for this Memory Bank folder — skipped." on a fail-fast lock collision. The aggregate no longer carries a skip flag and the branch has been removed, so that notification can never fire.
- **The credential gate is narrower than the build's actual capability.** The precondition recognizes only the two configured keys and the environment key. A local-agent subscription — which the settings dialog offers and the delegated build can use — is not recognized, so such a user is blocked at the button with a "needs an API key" message.
- **The button is always enabled.** There is no disabled state for a missing credential, a paused project, or an unresolved Memory Bank folder; each is discovered only after the click.
- **The Memory Bank folder root is the last locally-computed path in this flow.** The default-parent fallback is resolved in-process; every path derived from it is resolved on the command-line side.

## Shared Behavior

- Everything the build does — repo discovery, the ingest pipeline, the orphan-page purge, the visible-wiki render, per-repo failure isolation, and locking — is owned by the command-line surface (specs 152, 156, 158, 160 and the vault-write-lock spec).
- The credential resolution chain and provider precedence are owned by spec 10; this spec treats credential presence as one boolean.
- The Memory Bank browser panel that hosts the button, and its own delegated round-trips, are owned by spec 193.
- The in-process LLM seam that survives on this surface (spec 217) is not involved in the wiki build; it serves three summary-viewer actions only.
