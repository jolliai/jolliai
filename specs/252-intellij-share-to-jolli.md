# IntelliJ Share-to-Jolli Core

## Topic Statement

The reusable, UI-free core in the JVM IDE plugin that shares one committed memory — its plans and the summary itself — to the Jolli backend, persists the resulting server identifiers back onto the local memory, and cleans up documents left orphaned by earlier pushes. It is the single implementation of "share this memory" behind both the single-memory Share button in a memory's summary viewer and the Create-PR view's one-click multi-memory share.

## Scope

**In scope:**

- The ordered client-side sequence of a single memory share: push each plan that has content, fold the returned plan article URLs/ids back into the memory, build the summary markdown, push the summary, persist the updated memory, resolve any delayed unresolved-orphan hashes into deletable doc ids, best-effort delete orphaned documents, emit a telemetry event.
- The result value the core returns to its caller.
- The synchronous, off-UI-thread execution contract.
- The typed error categories the core lets propagate uncaught (binding-required, plugin-outdated, unauthorized) and how they differ from generic failures.
- How the two callers orchestrate around the core: the single-memory Share button and the Create-PR batch.

**Out of scope (boundaries):**

- The push/list-spaces/create-binding/delete **wire protocol** — endpoint, method, headers, body shape, response shape, tenant and org header derivation — owned by the summary-push spec and its siblings (binding-required-flow, plugin-outdated-flow, tenant-resolution).
- The binding-chooser dialog and re-authentication UI — owned by the callers and the binding-chooser-dialog spec.
- Constructing the bearer credential and resolving the base URL from the API key — owned by the auth / API-key / tenant specs; the core receives an already-resolved base URL and bearer.
- The summary/plan **markdown rendering** and the on-disk memory shape — owned by the storage and rendering specs.
- The Create-PR view's own submit flow and cross-panel synchronization — owned by the Create-PR-view spec.
- **A second, sibling push implementation now exists** for the live branch/commit share feature — see **IntelliJ Push Orchestration** (263). It is a separate, disjoint implementation (also pushes notes, not just plans) that this core does not call and is not called by; see Notable Behavior below so a reader doesn't assume this spec covers every push path on IntelliJ.
- The CLI now carries **its own** implementation of the live branch/commit share wire protocol, reachable only through a hidden CLI bridge action family (see 234). **No JVM code path uses it**: this core, the live-share controller, and the plugin's HTTP client all still call the backend directly. Nothing about the JVM plugin's share or push behavior routes through the CLI, and the CLI implementation has no live caller anywhere in this repository.

## Data Contracts

### Inputs

The core is called with:

| Input | Meaning |
| --- | --- |
| Storage handle | The local memory store, used to read plan content, and to persist the updated memory back. |
| Summary | The committed memory to share (carries its commit hash, branch, plans, any previously assigned server doc id, any orphaned-doc ids, and any **unresolved-orphan hashes** — commit hashes whose child summaries were folded into this memory but whose own server doc ids weren't yet known at fold time). |
| Working directory | The repo root, used to derive the canonical repo URL and branch slug. |
| Bearer credential | The Jolli API key. |
| Resolved base URL | The Jolli site base URL, already resolved by the caller. |

### Result

On success the core returns:

| Field | Meaning |
| --- | --- |
| Updated summary | The persisted memory, now carrying the summary's shared-article URL and server doc id, the plans' shared-article URLs and doc ids, and orphaned-doc ids reduced to only those that failed to delete. |
| Created flag | True when the server inserted a new summary document, false when it updated an existing one. |
| Plan count | How many plans were pushed in this call. |

### Error propagation

The core performs **no** UI and swallows only orphaned-doc delete failures. The typed rejections raised by the leaf push RPC propagate **uncaught** to the caller so the caller owns the recovery decision:

- **Binding required** — carries the repo URL the server wants bound.
- **Plugin outdated.**
- **Unauthorized** (credential rejected).

Any other exception (network, malformed response, unexpected error) also propagates.

## Behavior

### Ordered share sequence

1. Normalize the base URL (drop a trailing separator). Derive the canonical repo URL and the branch slug from the working directory / summary branch.
2. **Push plans.** For each plan on the memory: read its markdown from storage; skip it if missing or blank; otherwise push it as a plan-type document, passing the plan's previously assigned server doc id (so a re-push updates rather than duplicates). Record the returned `{ plan slug, article URL, server doc id }`. The article URL is composed client-side from the base URL and the returned doc id.
3. **Fold plan results back.** Rewrite the memory's plan list so each pushed plan carries its new article URL and doc id, matched by slug. Plans that were skipped keep their prior values.
4. **Build summary markdown** from the memory (with the folded-in plan URLs, so the pushed summary links to the freshly created plan documents). This markdown includes a "Task usage" line (tree-aggregated exact token count + exact Sonnet-rate cost, with an optional per-segment input/output/cached split, omitted entirely when the aggregate is zero) — the same markdown builder backs clipboard copy, "Save as Markdown File", and the Memory Bank folder export, so all four surfaces (clipboard, save-to-file, folder export, and this push) carry the identical line. The Create-PR description markdown is built by a **separate** builder that has no such line — a PR body never carries token/cost figures.
5. **Push the summary** as a summary-type document, passing the memory's previously assigned server doc id (re-push updates in place).
6. **Persist.** Compose the article URL for the summary from the base URL and returned doc id; store the memory back with its new summary URL/doc id and the updated plan list (forced write).
7. **Resolve delayed unresolved-orphan hashes** (see below) — persist the resolved memory (forced write) before cleanup runs.
8. **Clean up orphaned documents** (see below), operating on the memory produced by the resolution step.
9. **Emit telemetry:** a `memory_pushed`-style event tagged as a summary push, carrying the created flag and a bucketed plan count.
10. Return the result (with the cleaned memory as the updated summary).

### Resolving delayed unresolved-orphan hashes

When a child memory is folded into a consolidated parent (squash/rebase/merge/amend), the child's own server doc id may not yet be known — so instead of an orphaned-doc id, the parent records the child's **commit hash** in an unresolved-orphan list, to be promoted to a deletable doc id once the child's summary carries one. On each share, before cleanup:

1. If the memory has no unresolved-orphan hashes, skip this step entirely.
2. Read the current pending-push queue (see **IntelliJ Pre-Push Sync Catch-Up**, 271) — but **only** to log a diagnostic count; it does not affect any decision below.
3. For each unresolved-orphan hash, re-read that hash's currently stored summary. If it now exists for that exact hash **and** carries a server doc id, promote that doc id into the orphaned-doc set. Otherwise **retain the hash unconditionally** — regardless of whether the pending queue lists it. The pending-queue read only classifies retained hashes as "still in-flight" (present in the queue) vs. "abandoned" (absent) for the log line.
4. If nothing was resolved and every hash was retained, leave the memory unchanged and return it.
5. Otherwise rewrite the memory with the newly resolved doc ids appended to its orphaned-doc set (de-duplicated) and its unresolved-orphan list reduced to the retained hashes (cleared when empty), and persist it (forced write). This persisted memory is what cleanup then operates on.

**Why retention is unconditional:** a hash that cannot be positively resolved to a doc id is always kept. Dropping an unresolved hash merely because it isn't in the pending-push queue would be unsafe — a worker that succeeded on the network but crashed before writing the doc id back would have left an orphaned server article whose only local trace is this hash. See 271 for the full rationale and the reader's non-gating contract.

### Orphaned-document cleanup

The memory may carry ids of server documents left orphaned by an earlier push (e.g. a plan that was later removed, or a summary migrated by squash/rebase). If present and non-empty:

1. Best-effort delete each orphaned doc id; a delete failure is logged and the id is retained.
2. Persist the memory again with the orphaned-id set reduced to only the ids that failed to delete (or cleared when all succeeded).
3. Return the cleaned memory.

When there are no orphaned ids, cleanup is a no-op and the memory produced by the resolution step (step 7) is returned unchanged.

### Threading contract

The core runs **synchronously** end to end — every push and delete is a blocking call. Callers must invoke it off the UI thread. It never touches the UI, opens dialogs, or shows messages; all of that is the caller's responsibility.

## Callers

### Single-memory Share button (summary viewer)

The Share button in a memory's summary viewer resolves the base URL and bearer, posts an in-flight state to its webview, and — on a background thread within a trace scope — calls the core for the one current memory. On success it re-renders, shows a toast (mentioning the plan count when non-zero), and notifies the memory-state channel so the other surfaces update. On the typed errors it drives the recovery UI itself:

- **Binding required** → open the binding-chooser dialog and, on selection, retry the push once (a second binding-required after retry is surfaced as a hard error).
- **Unauthorized** → offer to re-authenticate (mint a fresh key) and retry once.
- **Plugin outdated** → show an update-required message.
- Generic failure → show an error dialog.

### Create-PR batch (Create-PR view)

The Create-PR view loops the core over every included memory, newest-first. It resolves a binding-required verdict **at most once per submit** (via the binding-chooser dialog), stops the batch on unauthorized / plugin-outdated / binding-refusal, counts shared vs failed memories, and returns an honest human-readable partial-success suffix. Its full submit orchestration is owned by the Create-PR-view spec.

## State Transitions

A single core invocation is a straight-line sequence, not a state machine: it either

- returns a result (summary and plans pushed, memory persisted, orphans cleaned, telemetry emitted), or
- throws one of the typed rejections (binding-required / plugin-outdated / unauthorized) or a generic exception, at the point of the failing push — with any already-completed plan pushes having already happened server-side and (if the failure is on the summary push) the plan URLs **not** yet folded into a persisted memory.

The retry/binding/re-auth state machine lives entirely in the callers.

## Notable Behavior

- **One core, two entry points.** The exact same share logic backs the single-memory Share button and the Create-PR view's batch, so their server-side effect is identical per memory. (Notable.)
- **Plans are pushed before the summary, and their URLs are folded into the pushed summary.** The summary markdown links to the freshly created plan documents because the plan pushes complete first and their returned URLs are merged into the memory before the summary markdown is built. (Notable.)
- **Re-push updates in place via stored doc ids.** Both plan and summary pushes pass any previously assigned server doc id, so re-sharing a memory updates the existing documents rather than creating duplicates. (Notable.)
- **Orphan cleanup is best-effort and self-healing.** A failed delete keeps the id in the orphaned set so a later share retries it; only successfully deleted ids are dropped. (Notable.)
- **The core is UI-free and synchronous by design.** It exists precisely so the two callers can share the sequencing while each keeps its own threading, dialogs, and toasts. Typed errors propagate uncaught so the caller decides between a chooser, a re-auth prompt, an update message, or a counted failure. (Notable.)
- **A failure mid-sequence can leave server state ahead of local state.** If plans push successfully but the summary push then fails, those plan documents exist server-side while the local memory has not yet been persisted with their URLs; the next successful share reconciles this (re-push by doc id + orphan cleanup). (Subtle.)
- **This is not the only push implementation on IntelliJ.** A second, independent pipeline exists for the live branch/commit share feature (263) — different code, pushes notes as well as plans, and keeps its own separate orphan-cleanup and telemetry. The two share only the underlying single-document HTTP call and the markdown builder. Don't assume a fix here also applies there, or vice versa. (Notable.)
- **The JVM plugin still owns its own HTTP path; the CLI's new share client is not in the picture.** A CLI-side implementation of the live-share wire protocol now exists behind a hidden bridge action family, but no JVM caller invokes it — every share and push this plugin performs still goes out through the plugin's own client. A reader looking for "where does IntelliJ share from" should not be misled into the CLI. (Notable.)
- **Unresolved-orphan hashes are resolved on every share, retained conservatively.** A consolidated memory can record child commit hashes whose server doc ids weren't yet known; each share re-reads those children and promotes any that now have a doc id into the deletable-orphan set, but keeps every hash it can't positively resolve — never dropping one just because it's absent from the pending-push queue (271). The pending-push reader is consulted only to log an in-flight-vs-abandoned tally; it is now a dependency of this pipeline but never gates the retain/drop decision. (Notable.)
- **The pushed markdown carries a "Task usage" line; the PR body does not.** The same markdown builder that composes this push's summary content also backs clipboard copy, "Save as Markdown File", and the folder export — all of them show the tree-aggregated exact token count and exact cost, omitted only when it's zero. The Create-PR description is rendered by a different builder entirely and never shows this line. (Notable.)

## Shared Behavior

- **Summary/plan/note push RPC** — endpoint, headers, body (including the document-type discriminator and the summary-JSON sidecar), response shape, status-code mapping, and the delete endpoint are defined by the summary-push spec.
- **Binding-required-flow** — the binding-required verdict and its downstream chooser/retry are defined by the binding-required-flow and binding-chooser-dialog specs.
- **Plugin-outdated-flow** — the plugin-outdated verdict and message are defined by the plugin-outdated-flow spec.
- **Tenant-resolution** — deriving the origin and tenant/org headers from the base URL and key is defined by the tenant-resolution and API-key specs.
- **Storage** — reading plan content and persisting the updated memory go through the storage provider.
- **Summary/plan markdown rendering** — the content bodies pushed are produced by the shared markdown builders.
- **Memory-state publish/subscribe** — the cross-panel channel the callers notify after a successful share (commits-panel / Create-PR-view / summary-viewer specs).
- **IntelliJ Push Orchestration** (263) — the separate, disjoint push implementation behind the live branch/commit share feature (262); shares the wire call and markdown builder with this core but nothing else. It hand-duplicates its own copy of the unresolved-orphan resolution step described above.
- **Pending-push queue reader** — the read-only view of `push-pending.json` consulted (never gating) by the resolution step is owned by **IntelliJ Pre-Push Sync Catch-Up** (271).
