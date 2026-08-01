# 263. IntelliJ Push Orchestration

## Topic Statement

A new, UI-free pipeline in the IntelliJ plugin that pushes one commit summary plus its plans **and notes** to a Jolli Space, weaves the published attachment URLs back into the article, and cleans up orphaned docs — and, for a multi-commit share subject, dedupes recurring plans/notes to their latest revision so each maps to exactly one Space doc. It exists solely to back the live branch/commit share feature (261/262). It is a **second, independent** push implementation alongside the pre-existing per-memory push (252) — the two are not unified, and that is the single most important fact about this spec.

## Scope

**In scope:**

- The single-summary push primitive: attachment selection, per-attachment failure collection, URL weaving, the summary push, delayed unresolved-orphan-hash resolution, and orphan-doc cleanup.
- Strict vs. best-effort attachment handling and where the strict mode is actually turned on.
- The binding-required resolution: resolve via an injected callback and retry exactly once.
- Cross-commit dedup: latest revision per plan base-slug / note id across the share subject, seed doc id carry-forward, and owner-commit assignment.
- Building the live content reference (covered branch collection / commit-doc list) from the dedup output — the shape this feeds to **IntelliJ Branch Share Store** (261).
- The relationship to, and divergence from, the pre-existing per-memory push (252).

**Out of scope (boundaries):**

- The share overlay's state machine, lazy mint triggers, and tier flips that call into this pipeline — see **IntelliJ Live Branch Share** (262).
- The persisted share record and its keying — see **IntelliJ Branch Share Store** (261).
- The single-document push/delete HTTP call itself (endpoint, headers, status mapping) — shared verbatim by both push implementations; documented here only insofar as this pipeline calls it.
- The pre-existing per-memory push's own sequencing, callers, and error-recovery UI — see **IntelliJ Share-to-Jolli Core** (252); referenced only to establish that it is a separate, disjoint implementation.
- The binding-chooser dialog UI itself — injected here as a callback.

## Data Contracts

### Single-summary push result

Pushing one summary returns renderable data only (no IDE UI calls): the pushed doc ids (summary doc id + URL, and per-plan/per-note `{ slug/id, title, doc id, url }`), the summary after URL-rewrite + persist + orphan-cleanup (the caller adopts this as current), the collected per-attachment failures, whether it was an update (the summary already had an article URL) vs. a first push, and the count of attachments successfully pushed.

Each published article URL has the shape `<base>/articles?doc=<docId>`.

### Attachment selection

The caller either passes an explicit `{ plans, notes }` set — the live-share dedup path does this, handing each summary only the attachments it owns after cross-commit dedup, with doc ids already resolved so the push updates the one Space doc in place — or omits it, in which case the summary's own attachments are used: plans collapsed to the latest snapshot per base name (the same de-dup helper used for cross-commit dedup, applied to a single summary's own plan list), plus all of the summary's notes.

### Injected dependencies

The push context injects the site base URL, bearer, repo URL, workspace root, and callbacks for persisting a summary, reading a plan body, reading a note body, opening the binding chooser, and — added for the delayed-orphan resolution step — **reading a summary by its original commit hash** (default: a no-op returning nothing). The workspace root is passed so the resolution step can locate the pending-push queue file (271).

### Binding outcome

The injected binding callback reports one of: bound, another-chooser-already-open, cancelled, or failed. The orchestrator raises a typed binding error carrying that outcome so the caller can choose messaging (open the chooser again, tell the user another one is already open, etc.).

### Live content reference (built here, stored by 261)

- **Commit subject** → a commit-doc list: the pushed summary doc ids + the flat set of attachment doc ids the single commit references.
- **Branch subject** → a branch collection: a branch relative-path identity + a `covered` list of `{ commit hash, summary doc id, attachment doc ids }`, one per commit in `base..HEAD`.

## Behavior

### Push one summary + attachments

1. Determine the plans/notes to push (caller-chosen, or the summary's own latest-per-name plans + all notes).
2. **Push plans, then notes.** Read each plan's body from the orphan branch (by slug); a snippet-format note carries its body inline, any other note format is read from the orphan branch by id. An empty/unreadable body is skipped; in **strict** mode it is instead recorded as a per-attachment failure. A single attachment failure is **collected, not thrown**, so one bad plan/note does not abort the rest or the summary — except an error in the fatal set (below), which still propagates immediately (these are repo-wide, not per-attachment). Each successful attachment push yields its doc's URL + id (an existing doc id is sent when re-pushing, so the server updates in place).
3. **Weave** the published attachment URLs into the summary's markdown, deduping same-named plan snapshots first (only the latest was uploaded) so the article's plan/note references link the actually-published docs.
4. **Push the summary doc** (with its existing doc id when re-pushing, for an in-place update), and emit a push-completion telemetry event tagged only as a summary push (no created-flag, no plan-count bucket — contrast the per-memory push's telemetry, which carries both; see Notable Behavior).
5. Persist the new article URL + doc id, and the woven attachment URLs/ids, onto the summary locally.
6. **Resolve delayed unresolved-orphan hashes.** If the summary carries unresolved-orphan hashes (child commit hashes folded in by a consolidation whose own server doc ids weren't yet known), re-read each hash's currently stored summary via the injected read-summary callback; promote a hash whose fresh summary now has a doc id into the orphaned-doc set, and **retain unconditionally** any hash that can't be positively resolved. The pending-push queue reader (271) is consulted **only** to log an in-flight-vs-abandoned count of the retained hashes — it never gates the retain/drop decision. When anything changed, persist the resolved summary and let cleanup run on it. This is a **hand-duplicated copy** of the resolution step in the per-memory push (252) — see Notable Behavior.
7. **Clean up orphaned docs** best-effort, operating on the post-resolution summary: delete each previously-recorded orphan id; clear only the ids that actually deleted from the summary's orphan list, keep the failed ones for the next push to retry. A cleanup failure is logged and **never** surfaces as a failed push (the summary is already pushed and stored).

### The fatal set (`isFatalPushError`)

`JolliPushOrchestrator.isFatalPushError` (`intellij/src/main/kotlin/ai/jolli/jollimemory/services/JolliPushOrchestrator.kt:64-74`) is **no longer** the "binding-required / plugin-outdated" pair. It is now five types:

- `BindingRequiredError` — fatal *here* because the loops cannot run the chooser; the caller resolves it.
- `PluginOutdatedError` — HTTP 426.
- **`PermissionDeniedError`** — the server's allowlist / ownership refusal.
- **`PushDisabledError`** — the user's own per-repo outbound opt-out (spec 310), including the form the CLI raises mid-call and the IDE bridge remaps back by error name.
- **`PushGateUnavailableError`** — the fail-closed verdict when the opt-out could not be evaluated at all. Not reachable from inside the attachment loops today (the gate that raises it runs at the entry points), but listed deliberately: if the opt-out cannot be evaluated for this repo it cannot be evaluated for the next attachment either, so a future in-loop gate call must not silently degrade into a per-attachment failure.

The last four are all properties of the **repo + credential**, not of the document: continuing would fire N doomed requests and report one repo-wide condition as N per-item failures. `isFatalPushError` is `internal` specifically so the set is unit-testable — both loops reach it only through a static `JolliApiClient.pushToJolli` call, which cannot be faked without the mockk object-stubbing that `scripts/check-global-state.sh` bans in new tests. This is a **hand-maintained Kotlin mirror** of the CLI's shared set; see spec 327 for the canonical membership and the second, differently-scoped Kotlin classifier.

### Binding-required retry

If the summary push fails with binding-required and this attempt was not already a retry, invoke the injected binding callback for the repo URL. On a bound outcome, retry the **entire** push **exactly once** (a second binding-required after a successful bind propagates rather than looping again). On any other outcome, raise the typed binding error with that outcome. Any non-binding error propagates unchanged.

### Cross-commit dedup (multi-commit subject)

Across the share subject's summaries, processed **oldest → newest**:

- For each plan (keyed by its base name with any archived commit-hash suffix stripped) and each note (keyed by its id), track a running "winner": whichever snapshot has the latest `updatedAt` seen so far for that key becomes (or stays) the winner, remembering which commit owns it.
- Alongside the winner, track a running **seed doc id** for that key: whenever a snapshot (winner or not) carries its own already-assigned doc id and that id differs from what's currently tracked, the tracked seed doc id updates to it. This is how a doc id surfaced by *any* commit's prior push — not only the reigning winner's own commit — reaches the winner, so the eventual push updates the one existing Space doc in place instead of creating a duplicate. In the common case (a plan/note pushed once, under one commit, and never independently re-pushed elsewhere) this behaves exactly as "a losing older revision only fills in a seed the winner lacked, never overriding the winner's own id" — but the check that drives the update is an inequality test, not an absence test, so it is not literally restricted to the missing-seed case; a later-processed snapshot with its own differing doc id can still update the tracked seed even after a doc id was already recorded for that key. This edge only bites when two snapshots of the same plan/note base ever independently held different non-null doc ids, which does not happen in the ordinary single-push-per-name flow.
- Each winner (with its seed doc id folded in, when present) is handed to its owner commit's push call as that commit's owned attachment — so a base name/note id is uploaded exactly once across the whole subject, under exactly one commit.

This dedup is used **only** by this feature (the live share). It has no other caller.

### Push loop + covered construction

Push each summary oldest→newest with only its owned attachments (from the dedup step), in **strict** attachment mode — the only caller in the codebase that turns strict mode on. Accumulate a subject-wide map from base-slug/note-id to attachment doc id, seeded with whatever seed doc ids the dedup pass already resolved, so a doc pushed "under" one commit is still resolvable when a different commit's summary references the same plan/note. Then, for each summary, resolve its attachment doc ids from that shared map to build its `covered` entry (commit subject: build a fixed commit-doc list instead). Because strict mode is on, **any** attachment failure anywhere in the loop aborts the whole live-share push with a typed error — the share must never end up pointing at stale or missing doc ids.

## Notable Behavior

- **IntelliJ now has two independent, non-unified push implementations.** This orchestrator (used *only* by the live-branch-share feature; pushes plans **and** notes; strict-attachment mode available; separate orphan-cleanup pass; separate, narrower telemetry payload) and the pre-existing per-memory push (**IntelliJ Share-to-Jolli Core**, 252 — used by the single-memory Share button and the Create-PR batch; pushes plans **only**, never notes; always best-effort on attachments; its own separate orphan-cleanup pass; its own separate, richer telemetry payload carrying a created-flag and a bucketed plan count). They share the same underlying single-document push/delete HTTP call and the same markdown builder, but duplicate the sequencing, the orphan-cleanup loop, the telemetry call, **and the delayed unresolved-orphan-hash resolution step** independently — a fix or behavior change made in one is not automatically reflected in the other. (The orphan-resolution step in particular is a byte-for-byte hand-copy across the two implementations: this orchestrator resolves via its injected read-summary callback while the per-memory push reads through its storage handle, but the retention logic and the non-gating pending-push read are otherwise identical duplicates.) This is a direct contrast with the VS Code push pipeline (236), whose explicit, verified guarantee is "one push path, never two." IntelliJ has no such guarantee: a subject pushed via the live share and again via the ordinary Share button goes through genuinely different code, with only the wire format and markdown output in common. (Notable — the most significant finding in this spec.)
- **Notes are pushed here but not by the per-memory push.** The per-memory push (252) only ever pushes plans; this orchestrator pushes both plans and notes for every summary it touches. A memory with notes therefore only gets those notes published to the Space via the live-share path, never via the plain Share button.
- **Per-attachment failures are collected, not thrown** (outside strict mode) — a single bad plan/note doesn't abort the rest or the summary; only the fatal set aborts immediately. (Notable.)
- **The fatal set is repo-wide, and wider than binding + plugin.** `isFatalPushError` also covers `PermissionDeniedError`, `PushDisabledError` and `PushGateUnavailableError` — a server refusal, the user's outbound opt-out, and the "couldn't evaluate the opt-out" verdict all abort the whole loop rather than being counted per attachment. It is a hand-maintained Kotlin mirror of the CLI's shared `PushRefusal` set (spec 327), so adding a repo-wide type there does **not** update it automatically. (Notable; a lockstep obligation.)
- **Strict mode exists specifically for the live share.** The standalone attachment-selection default (no caller-supplied selection) is non-strict — an unreadable attachment is silently skipped — but the live-share dedup path always calls in with an explicit selection **and** strict mode on, so a failure there is never silently swallowed; it must abort rather than let the share page point at a stale seeded doc id. (Notable; intentional.)
- **A losing revision's own doc id can still move the tracked seed, not just fill a gap.** The dedup's seed-carry step is driven by "does this differ from what's tracked," not "is nothing tracked yet" — see Cross-Commit Dedup above. In the ordinary flow (a plan/note pushed once, from one commit) this distinction never surfaces; it would only matter if the same base name/note id had independently acquired two different doc ids across commits, which the normal push sequencing does not produce. (Notable; a subtlety in the port worth knowing if the dedup's output ever looks surprising.)
- **Orphan cleanup is best-effort and self-healing**, exactly mirroring the per-memory push's own cleanup: only successfully-deleted ids are cleared; failed ones are retried on the next push; a cleanup failure never fails the push itself. Each push implementation runs its **own separate copy** of this cleanup logic — see the first bullet above. (Notable.)
- **Binding-required retries exactly once**, then propagates a raw second binding-required unchanged — there is no batch-level path in this orchestrator that would instead demote it to a collected failure (unlike the VS Code whole-branch push's documented gap in 236); every caller here is per-summary, so a raw second binding-required simply aborts the subject's whole live-share push.

## Removed/deleted surfaces (confirmed absent)

Consistent with the overlay living inside the summary detail webview (262) and this orchestrator having no other UI of its own, three UI surfaces that would otherwise compete with or duplicate this feature are confirmed **absent** from the current codebase — no file, no reference, nothing partially wired:

- A native Swing share dialog. (One stale doc-comment elsewhere in the plugin still names such a dialog as if it existed; the class itself is gone. Treat that comment as leftover, not as evidence of a live surface.)
- A standalone JCEF share-dialog window separate from the summary detail webview.
- A social-share-message composer.

## State Transitions

The single-summary push is a leaf operation: it either returns a result, raises an error from the fatal set (which the caller — the share overlay, 262 — surfaces as an error state, except `PushDisabledError` on the reconcile path, which 262 swallows), or — for binding-required on the first attempt — resolves a binding and retries once. The live-share's multi-commit push iterates this leaf oldest→newest, and (being strict) aborts the whole subject on the first attachment failure or fatal error.

## Shared Behavior

- **Single-document push/delete HTTP call** — endpoint, headers, body shape, and status-code mapping are shared verbatim with the pre-existing per-memory push (252); this pipeline is separate multi-doc orchestration layered on top of the same call.
- **Markdown builder** — the same summary/plan/note markdown construction used by clipboard export, save-to-file, the folder export, and the per-memory push (252) is reused here too (see 252's update note on the shared "Task usage" line).
- **Binding-required flow and chooser** — the same repo-binding chooser surface the ordinary push uses; injected here as a callback.
- **Live-share record shapes** the covered reference is stored into — **IntelliJ Branch Share Store** (261); the mint/reconcile triggers that call into this pipeline are **IntelliJ Live Branch Share** (262).
- **IntelliJ Share-to-Jolli Core** (252) — the other, disjoint push implementation; see Notable Behavior above for exactly how the two differ. Its unresolved-orphan resolution step is the sibling of the hand-duplicated one here.
- **Pending-push queue reader** — the read-only `push-pending.json` view consulted (never gating) by the resolution step is owned by **IntelliJ Pre-Push Sync Catch-Up** (271).
- **Repo-Wide Push-Refusal Classification** (327) — the canonical set `isFatalPushError` mirrors, and the second Kotlin classifier (`CreatePrPanel.repoWideStopReason`, spec 251) that covers the same conditions with a different membership.
- **Per-Repo Outbound-Push Control** (310) — the opt-out that raises `PushDisabledError` / `PushGateUnavailableError`, and the `outbound-push-allowed` bridge gate that raises them ahead of these loops.
- **VS Code Push Orchestration** (236) — the VS Code analog this pipeline is ported from; its "one push path, never two" guarantee is explicitly **not** true on IntelliJ (see Notable Behavior).
