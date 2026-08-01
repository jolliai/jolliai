# 188 — Commit Exclusion Selection Store

## Topic Statement

A sticky per-project JSON file that holds two independent layers for the next pipeline run: the user's manual EXCLUDE set (the five kinds of items the user unchecked, one of which is optional on disk), which the queue worker reads read-only; and an AI-relevance layer (the relevance ranker's FULL per-item ranking — every ranked item's tier, reason, and the AI's exclude decision — plus a change fingerprint), which both the pre-commit review panel and the post-commit queue worker write.

## Scope

In scope:

- The on-disk location of the file relative to a project root.
- The five kinds of user exclusions the file holds: ongoing conversations, plans, notes, references, and skills — the last of which is optional on both the persisted shape and the read result, because it postdates the others.
- The shape of an entry within each kind, including the composite key used for conversation entries, the composite key used for reference entries, and the composite key used for skill entries.
- The second layer: the AI per-item ranking list (each entry: kind, key, tier, reason, the AI's original exclude decision, and an optional user "dismissed" veto flag — no score) and the change fingerprint, both optional and written only when non-empty/present.
- The effective-exclude derivation (`excluded AND NOT dismissed`) exposed over an AI entry.
- The version stamp staying fixed for forward compatibility, and why the new fields are added as optional keys rather than by bumping the version.
- The transparent migration from the older schema to the current one.
- The read API for the user layer: returning four sets, the missing-file branch, the malformed-file branch, the unknown-version branch, the per-field defensive coercion, and the warning surface for non-missing read failures.
- The read API for the AI layer: returning the per-item ranking list plus the optional fingerprint, and its defensive coercion (including dropping a legacy per-entry score and other legacy keys).
- The user-layer write APIs: single-key and bulk-key, each parameterized by kind and by an add-or-remove direction.
- The AI-layer write APIs: write the whole per-item ranking (list + fingerprint), veto one AI exclusion (the "dismiss" mechanism, which sets a flag — it does not remove the entry), and clear the AI layer.
- The atomic write protocol: write to a uniquely named temp sibling, rename into place, clean up the temp sibling if the rename fails.
- The in-process serialization queue keyed per project root, and the cross-process file lock that now wraps every write.
- The recovery contract: a failed write in the chain does not poison subsequent writes against a healthy project root.
- The unlink helper that deletes the file from disk, including its tolerance for the missing-file case and its warn-and-swallow behavior on other unlink errors.
- The sticky semantics of the user layer: no pipeline outcome, no git event, no editor lifecycle event modifies it.
- The contract with the queue worker: it reads the user EXCLUDE set read-only, and after consuming the AI ranking for a commit it WRITES (clears) the AI layer.

Out of scope (boundaries — referenced, not duplicated):

- The relevance ranker that produces the AI per-item ranking and the change fingerprint — the algorithm, the LLM call, the tier model, and the fail-open contract (see [258 — AI Context-Relevance Filtering] — separate spec). This store only persists and serves the ranker's output.
- The pre-commit review panel that calls the ranker and writes the AI layer, and its overlay UI (see [247 — VS Code Working-Memory Review Panel]).
- The list-level "hide this conversation row permanently" store, which is a separate sticky list of per-session entries with its own file (see [189 — Hidden Conversations Store] — separate spec).
- The conversation overlay sidecar that records per-entry edits/deletes inside a single transcript, distinct from the panel-level skip recorded here (see [183 — Conversation Overlay Store]).
- The cursor advancement decision for an excluded conversation. This **reversed** since the earlier version of this spec: the queue worker now reads **every** session (including excluded ones) so every cursor advances to the commit boundary, then drops the excluded ones at a single downstream filter. This spec only contributes the exclusion set; the read/advance/drop behavior is the worker's (see the consumer section and [36 — Summary Attribution by Transcript Cutoff]).
- The mechanism by which the queue worker associates a non-excluded plan/note/reference with the new commit (archive path).
- The leave-out (skip-only) treatment the worker gives an excluded plan/note/reference — this spec summarizes it in the consumer section because it defines what "excluded" means end-to-end, but the registry and filesystem are separate stores owned elsewhere. (There is **no** discard pass: an earlier build deleted the excluded artifact rows and backing files; that was removed. See the consumer section.)
- The "by transcript cutoff" attribution rule for summaries, which must account for this exclusion pass when deciding what is in scope (see [36 — Summary Attribution by Transcript Cutoff]).
- The per-turn token breakdown whose per-session totals the worker drops for excluded conversations to keep the branch token bar honest (see [243 — Token Usage Extraction and Cost Estimation]).
- The UI surface (sidebar checkbox, section Select-All / Deselect-All button, row rendering) that emits the add/remove calls — only the contract at the API boundary is in scope here.
- The plans-and-notes registry whose entries the exclusion keys refer to.

## Data Contracts

### File location

A single JSON file lives at a fixed relative path under the project root:

```
<projectRoot>/<state-dir>/commit-selection.json
```

The state directory is the project-local jollimemory state directory (the same one that holds session metadata, cursors, the queue, and other per-project files). The file is gitignored by convention.

The file is per-project. Two project roots have two independent files and two independent serialization chains.

### Persisted shape

The file is a JSON object with the four required user-exclude arrays plus a version stamp, and three optional fields:

- A version stamp: a fixed integer constant. The current value is the second version of the schema. It **stays fixed** even though the skill and AI-layer fields were added (see "Schema versions").
- An array of conversation exclusion keys (strings).
- An array of plan exclusion keys (strings).
- An array of note exclusion keys (strings).
- An array of reference exclusion keys (strings).
- **Optional** — an array of skill exclusion keys (strings). Absent in files written before skills became a selectable artifact kind, and written only when non-empty (see "Skill key shape").
- **Optional** — an array of AI per-item ranking entries (see "AI relevance entry"). Written only when non-empty; omitted otherwise.
- **Optional** — a change-fingerprint string (see "Change fingerprint"). Written only when present.

Each user-exclude array is the serialized form of a set. Order is not significant. The file is written with tab indentation.

### AI relevance entry

The AI layer is **one list carrying the whole ranking** — every ranked item, kept AND excluded alike — not a bare exclude list. One list (rather than a separate exclude list + verdict list) removes the alignment/lifecycle drift the earlier two-list shape suffered from, and it is what lets the worker's fingerprint-reuse path rebuild both the effective exclude set and the kept items' tier/reason without re-running the LLM.

Each entry has:

- **kind**: one of the five exclusion kinds. In practice the ranker produces only plan/note/reference — see the unreachable-kind note below.
- **key**: the item key for that kind — a plan slug, a note identifier, or a `<source>:<nativeId>` reference key. Same key space as the corresponding user-exclude array.
- **tier**: one of `high` / `mid` / `low`, the ranker's categorical relevance band for the item.
- **reason**: the one-line explanation the ranker attached.
- **excluded**: boolean — the AI's ORIGINAL soft-exclude judgment. Written once by the ranking and **never rewritten** (a dismiss must not erase what the AI concluded).
- **dismissed** (optional): boolean — the user's veto of that exclusion (the panel/sidebar "Include" / "+" action). Only meaningful when `excluded` is true. Absent means false; persisted only when true.

The **effective exclude decision** for an entry is `excluded AND NOT dismissed`. A dismissed entry therefore remains in the list carrying its original tier + reason, but is no longer effectively excluded — so "the AI suggested excluding this but the user kept it" stays reconstructable, and a kept-after-dismiss item still shows its original verdict.

There is deliberately **no score** field. The ranker's numeric score is uncalibrated display noise; the categorical tier is the surfaced signal. An entry read from an older file that still carries a `score` (or any other extra key) has it dropped on read (see "Defensive read coercion").

### Change fingerprint

An opaque string that keys the AI per-item ranking to the exact change it was computed against. It is produced by the relevance layer (see [258]) from the sorted changed-file set only. Its role here is a coordination token: the panel writes it alongside the AI list, and the worker reuses the list only when its own recomputed fingerprint matches. This store treats it as an opaque value — it neither computes nor interprets it.

### Conversation key shape

A conversation entry is a string of the form `<source>:<sessionId>`, where:

- `<source>` is the producer identifier (the same enum that the rest of the system uses to tag a transcript by its agent of origin).
- `<sessionId>` is the producer-assigned session identifier.

The colon is reserved across the product: no source identifier contains a colon, so the key is unambiguously splittable for debugging.

A composite key is required (rather than the session identifier alone) because two different producers can mint the same session identifier independently; without the prefix, excluding one would silently exclude the other.

### Reference key shape

A reference entry is a string of the form `<source>:<nativeId>`, where:

- `<source>` is the integration source (the same enum that tags reference rows in the panel).
- `<nativeId>` is the integration-native identifier of the row.

The composite shape is identical to the reference map key used by the plans-and-notes registry, which is intentional: a single key flows between the panel, this store, and the registry without translation.

### Skill key shape

A skill entry is a string of the form `<source>:<skill>`, where `<source>` is the producer that ran the skill and `<skill>` is that producer's own skill identifier. This is the same working-area map key the skill registry uses, and the same key the amend merge and the tree-level accumulation derive — deliberately, so an exclusion, a merge and an aggregate cannot disagree about which rows are the same skill.

Note it is **not** the archive key: that carries a per-commit hash suffix and would make an exclusion apply to one commit's snapshot rather than to the skill.

The kind is optional throughout: it is absent on the persisted shape when nothing has been excluded, absent on the returned read result when the file carried no such field, and its absence means "nothing excluded" rather than "unknown".

### Plan key and note key shapes

A plan entry is a plan slug string. A note entry is a note identifier string. Both are opaque to this store — it does not interpret them, normalize them, or validate them against the registry. A "stale" key whose underlying row no longer exists is tolerated and round-trips cleanly.

### Schema versions

The store recognises two version stamps:

- Version one: the original schema, with conversations, plans, and notes only.
- Version two: adds references.

A read against a version-one file transparently fills the references set as empty. The next write upgrades the on-disk version stamp to two and writes the references array (empty if no references were excluded between the read and the write). Any version stamp that is neither one nor two causes the read to return an empty result and to log a warning; the file is left untouched on disk.

The skill array and the AI-layer fields (per-item ranking list, change fingerprint) were all added **without** bumping the version stamp, on purpose. Bumping to a third version would make an older reader — which hard-rejects unknown versions and returns an empty set — silently **discard the user's manual excludes**. Keeping the stamp at two and adding the new fields as optional extra keys means an older reader still reads the four arrays it recognises and simply ignores the rest: true forward compatibility. The new fields are written only when non-empty, so for a user who never touches the AI-relevance feature the file shape is byte-for-byte the pre-feature shape.

Legacy keys from earlier in-development builds of this feature — `userIncluded`, `aiSuggestedExclude`, `aiRelevanceResults` — are intentionally **not** read and are dropped on the next write. The dismiss model sets a flag on the AI ranking entry directly (see below), so there is no separate persistent "include" layer to carry. This file is a short-lived local relay (cleared by the worker after each commit), so the sole cost of dropping an unrecognized legacy shape is one fingerprint miss → one fallback re-rank.

### Returned shape

The read API returns a structure with four always-present read-only sets plus one optional one:

- The set of excluded conversation keys.
- The set of excluded plan keys.
- The set of excluded note keys.
- The set of excluded reference keys.
- **Optional** — the set of excluded skill keys. Present only when the file carried the field at all; an absent field yields an absent set rather than an empty one, and every consumer reads that as "nothing excluded" (the squash path, for example, substitutes an empty set).

When the file is missing or unreadable, the four required sets are empty and the skill set is absent.

### AI-layer returned shape

The AI-layer read API returns a structure with:

- The AI per-item ranking list (possibly empty) — an ordered list of {kind, key, tier, reason, excluded, optional dismissed} entries.
- The change fingerprint, present only when the file carried one.

When the file is missing, unreadable, or carries no AI layer, the list is empty and the fingerprint is absent.

### Defensive read coercion

For each of the four required user-exclude fields the reader requires an array of strings. If a field is present but not an array, that field's set is empty. If a field is present as an array containing some non-string elements, only the string elements are kept; the rest are silently dropped. This applies field-by-field — corruption of one field does not invalidate the others. The optional skill field is coerced the same way **only when it is present at all**: an absent field stays absent through the read rather than degrading to an empty set, which is what preserves the "written before skills existed" distinction.

The AI per-item ranking array is coerced entry-by-entry: an element is kept only when it is an object whose `kind` is one of the five recognized kinds (the four required ones plus skills), whose `tier` is one of `high`/`mid`/`low`, whose `key` and `reason` are both strings, and whose `excluded` is a boolean. Any other element (null, non-object, wrong-typed or missing field) is silently dropped. Only `kind`/`key`/`tier`/`reason`/`excluded` are extracted, plus `dismissed` when it is exactly `true`; any extra field (e.g. a legacy `score`) is discarded. The change fingerprint is kept only when it is a string.

## Behavior

### Read

1. Compute the file path from the project root.
2. Read the file as UTF-8 text.
   - If the read fails because the file does not exist, return four empty sets without logging.
   - If the read fails for any other reason, log a warning identifying the operation and the error message, then return four empty sets.
3. Parse the text as JSON.
   - If parsing throws, log a warning identifying the operation and the error message, then return four empty sets.
4. Inspect the version stamp:
   - If the stamp is the current version or the legacy version, proceed.
   - Otherwise, log a warning naming the unexpected version value, return four empty sets, and leave the file alone.
5. For each of the four user-exclude fields, coerce the value into an array of strings as described above, then wrap it in a fresh set.
6. Return the four sets.

The AI-layer read runs the same underlying raw read (steps 1–4), then projects out the AI per-item ranking list and the optional fingerprint instead of the four sets. The two reads are independent projections of one on-disk shape.

### Write a single key

1. Enter the per-project serialization chain.
2. Inside the chain, perform a read using the read protocol above; the result is the current state (empty if the file was missing/malformed/unknown-version).
3. Clone the four sets into mutable sets.
4. Look up the target set by kind.
5. If the direction is "exclude", add the key to the set; if "un-exclude", delete the key from the set. Both operations are idempotent: adding a key already present is a no-op, deleting a key that is absent is a no-op.
6. Write the four sets atomically (see the atomic-write protocol).

### Write a batch of keys

1. Enter the per-project serialization chain.
2. Inside the chain, read the current state.
3. Clone into mutable sets.
4. Look up the target set by kind.
5. If the direction is "exclude", add every key in the input list; if "un-exclude", delete every key in the input list. The input list is allowed to contain duplicates and keys that are already (absent / present).
6. Write the four sets atomically.

The batch path is a single read-modify-write — it is not a sequence of single-key calls. This ensures that a multi-key Select-All / Deselect-All click lands as one transition on disk.

Every write path preserves the other layers: a user-exclude write leaves the AI layer untouched, and every AI-layer write leaves the four user sets untouched. Each write re-reads the full shape, mutates only its own layer, and re-serializes the whole.

### Write the AI per-item ranking

Called by the pre-commit review panel after it ranks (see [258]):

1. Enter the per-project serialization chain (which now also takes the cross-process lock — see "Serialization chain").
2. Read the current shape.
3. Replace the AI per-item ranking list with the supplied list (every ranked item's tier + reason + exclude decision), and set the change fingerprint to the supplied value (or clear it when none is supplied).
4. Write atomically. An empty list with no fingerprint clears the layer.

### Veto one AI exclusion (dismiss)

The whole "user overrides the AI" mechanism. There is no separate persistent include layer — the user's veto is a flag on the ranking entry itself:

1. Enter the serialization chain.
2. Read the current shape.
3. **Set `dismissed: true`** on the single entry whose (kind, key) matches the argument; leave that entry's `excluded`, tier, and reason intact, leave every other entry unchanged, and leave the change fingerprint in place (so the worker's fingerprint-based reuse still holds — the dismissed item lands as a kept item carrying its original verdict). The entry is **not removed** — the AI's original judgment is never erased. Idempotent.
4. Write atomically.

A dismiss is therefore a per-change override: it survives until the next re-rank writes a fresh list, not across a re-rank.

### Clear the AI layer

Called by the queue worker after it has consumed the ranking for a commit:

1. Enter the serialization chain.
2. Read the current shape.
3. Empty the AI per-item ranking list and clear the change fingerprint; keep the four user sets.
4. Write atomically.

Clearing after consume prevents a later commit over the **same** file set from silently reusing a now-stale fingerprint / exclude decision.

### Atomic write protocol

1. Ensure the state directory exists (create recursively if necessary).
2. Build the persisted payload from the sets, materializing them in this order: version stamp, conversations, plans, notes, references, then — **only when non-empty** — skills, then the optional AI-layer fields. Each set becomes an array; order within an array is the set's iteration order (insertion order in practice).

   The serializer rebuilds the shape field by field rather than spreading the read result, so any field it does not name explicitly is dropped on the next write even though it round-tripped through the reader. Skills are carried explicitly for that reason, and are omitted when empty so a user who never excludes a skill keeps a byte-identical file — the same rule the AI-layer fields follow.
3. Serialize the payload as JSON with tab indentation.
4. Choose a temp file path: the final path with a suffix that combines the writer's process identifier and a millisecond timestamp. This makes the temp path unique across processes within a millisecond and unique across milliseconds within a process.
5. Write the JSON to the temp file.
6. Rename the temp file over the final path.
7. If the rename throws, attempt to unlink the temp file (best-effort; if the unlink itself throws, swallow that secondary error). Then propagate the rename error to the caller.

The temp-file cleanup branch exists because the rename can fail on some platforms (most commonly Windows, when an antivirus, a file watcher, or another reader is touching the destination) with errors such as a "permission denied" or "resource busy" condition. Without cleanup the temp file would accumulate one orphan per failed write because each carries a unique timestamp suffix. The cleanup never masks the original rename error: the caller sees the rename error, never a "cleanup failed" wrapper.

### Serialization chain and cross-process lock

Writes are serialized on **two** levels: an in-process chain per project root, and a cross-process file lock taken inside each chained operation.

The in-process chain: for each project root the store maintains a chain of pending operations. Calling any write API appends the work to that project's chain. The chain has these properties:

- Operations on the same project root run strictly serially, one after the next, regardless of how they were submitted.
- Operations on different project roots run independently of each other.
- If an operation in the chain throws, the chain's bookkeeping swallows the throw for the purpose of advancing the chain pointer. The throw still propagates to the caller that submitted that operation; subsequent submitters start from a healthy state.
- The chain does not commit-or-rollback the read-modify-write cycle: an operation that fails during write leaves the on-disk state at whatever the rename did or did not accomplish. The next operation starts by re-reading from disk, so a partial failure does not poison the in-memory view.

The chain exists because the UI typically dispatches the write calls as fire-and-forget (`void apply…`) in response to rapid checkbox clicks. Two concurrent unlocked read-modify-write calls would (a) both observe the same pre-state and silently lose one update, and (b) both build a temp filename combining the same process identifier and the same millisecond, colliding on disk so that the second rename fails with a "no such file" condition.

The cross-process lock: each chained operation additionally runs under a worktree-scoped, PID-tagged file lock dedicated to this file. This is the fix for a genuine cross-process race that the in-process chain alone cannot cover — two **separate processes** now write this file: the pre-commit review panel (which persists the AI ranking) and the post-commit queue worker (which clears the AI layer after consuming it). Without the lock they could lose-update each other. Properties:

- **Worktree-scoped** — the lock lives next to the file it guards, so two git worktrees (each with their own file) never contend.
- **Best-effort** — if the lock cannot be acquired within a short budget, the operation still runs (a slow holder must never permanently block a selection change); the atomic temp+rename write keeps the file from ever being observed half-written even in that degraded case.
- **Must not be nested** — it wraps the leaf read-modify-write only.

### Delete the file

1. Attempt to unlink the file at the computed path.
2. If the unlink fails because the file does not exist, return without logging.
3. If the unlink fails for any other reason, log a warning identifying the operation and the error message, then return.

This helper is exposed for tests and manual operator use. It is not invoked by the pipeline. Deleting the file is equivalent to "un-exclude everything, across every kind" — including the optional skills set, which a reader counting only the required kinds would miss.

### Consumption by the queue worker

When the queue worker is preparing to run a pipeline for a commit, an amend, a squash, or a rebase-pick / rebase-squash, it reads the **user EXCLUDE set** read-only and uses the four returned sets to shape the run. The user layer is invariant across the entire pipeline execution, regardless of op type or outcome; the worker never mutates it. (The worker *does* write, at commit time, to a *different* store — the plans/notes/references registry and the orphan branch — but only to *associate the CHECKED items*; it never deletes an excluded row. That is not a write to the exclusion file.)

The worker's relationship to the **AI layer** is different and now includes a write:

- It reads the AI per-item ranking list + fingerprint. On a fingerprint match it reuses the persisted list (skipping a recompute); on a mismatch (or no panel run) it recomputes the ranking itself (see [258]).
- After consuming the ranking for that commit it **clears** the AI layer (empties the list, drops the fingerprint) via the clear operation, under the same cross-process lock. This is a real write to this file — the earlier invariant that the worker "only reads, never writes" this file is **false** for the AI layer. The clear prevents a later commit over the same file set from reusing a now-stale decision. It is best-effort: a clear failure never breaks summary generation.

The specific consumer behaviors are:

- A conversation key in the exclusions does **not** stop the transcript from being read. The worker reads **all** sessions — including excluded ones — so their cursors advance to the commit boundary (the excluded conversation is *consumed*, leaving the working area). It then drops the excluded sessions at a **single downstream filter**, from *both* the entry stream (so those turns never enter the summary body or entry counts) *and* the per-session token map (so their tokens are not re-added to the stored branch token total). This is a deliberate reversal of the previous "skip the read, never advance the cursor" behavior — a conversation exclusion is a **one-time discard**.
- A plan key in the exclusions causes that plan to be dropped from the plans-block formatter input **and** from the archive-side registry scan, so it is neither summarized nor associated with this commit. Its uncommitted registry row and backing file are left **intact**, so it reappears on the panel for re-check on the next commit.
- A note key behaves identically: dropped from the notes-block input and the archive-side scan; its row and backing file are left intact.
- A reference key causes the reference's markdown not to be read into the prompt block and the reference not to be associated with this commit; its row and backing markdown are left intact.
- A skill key causes that skill not to be archived onto this commit: the exclusion set is passed **into** the archival step rather than applied to its result, because archiving both guards the working-area row and emits parallel-ref bytes — a post-filter would leave the excluded skill's content archived while merely hiding it from the summary. The row is not deleted, so the skill reappears for re-check next time. Skills are never in the prompt block to begin with (they are track-only metadata), so there is no prompt-side arm to this exclusion.

So the model is **mixed**: an excluded **conversation** is a one-time discard (consumed at its cursor, dropped downstream, never reappears), while an excluded **plan / note / reference** is a **sticky leave-out** — skip this commit only, never delete, reappears for re-check next time. The plan/note/reference treatment is now **identical** to how an AI soft-exclude is treated, and identical to the AI layer's own skip-only handling (see [258]).

A key in the exclusions whose corresponding row no longer exists in the system (a "ghost" key) has no effect; the exclusion is silently inert and is preserved on disk.

### Leave-out (skip-only) for plans / notes / references

At commit time, both user hard-excludes and AI soft-excludes of a plan/note/reference are applied **before** the association step (association has side effects — a registry archive entry plus an orphan-branch store — so a post-filter on the returned refs would still leave an excluded item archived on disk). The exclusion is a pure skip:

- The excluded item is filtered out of both the prompt-block input (LLM input only) and the separate archive-side registry scan, so it is neither summarized nor associated.
- Its registry row keeps `commitHash === null` and its backing file stays on disk, so the working-area detector surfaces it again on the next refresh. "Leave out of this memory" is a one-commit skip, not a delete.

There is deliberately **no discard pass**. An earlier build ran one — it deleted the excluded plan/note/reference's uncommitted registry row (and, for notes/references, product-owned backing files) so the item did not reappear. That was **removed**: leave-out now preserves the item so the user can re-check it later, matching how the AI soft-exclude has always been treated. Conversations remain the sole one-time discard.

The worker's only write to `commit-selection.json` itself is the AI-layer clear described above — the user EXCLUDE set remains read-only from the worker's view. (The worker does mutate the plans/notes/references registry and orphan branch when it *associates* the CHECKED items, but that is a different store and touches no excluded row.)

## State Transitions

The file has the following states:

- **Absent.** No file on disk. The read returns four empty sets. The first write transitions the file to "present at the current version" by way of the atomic-write protocol.
- **Present at the current version.** Read returns the four sets as stored. Writes round-trip cleanly.
- **Present at the legacy version.** Read returns three of the four sets as stored, plus an empty references set. The next write transitions the file to "present at the current version" with the references array materialized (possibly still empty).
- **Present at an unrecognized version.** Read returns four empty sets and emits a warning. Writes will overwrite the file with a current-version payload computed from "empty current state plus the requested change".
- **Present but malformed JSON.** Read returns four empty sets and emits a warning. Writes will overwrite the file with a current-version payload computed from "empty current state plus the requested change".
- **Present but a directory at the file path.** Read returns four empty sets and emits a warning. Writes will fail at the rename step (the destination is not a regular file); the failure propagates to the caller, the temp file is cleaned up, and the chain remains healthy for the next call.

The lifecycle of an individual key inside the file:

- **Absent.** A future exclusion add will insert it. A future un-exclude is a no-op.
- **Present.** Stays present across an arbitrary number of pipeline runs, regardless of outcome. Persists across editor restarts. A future un-exclude removes it. The key is removed only by an explicit un-exclude call from the UI (or by the operator-facing delete-file helper, which removes all keys at once).

The AI layer has a different, non-sticky lifecycle:

- **Absent.** No AI fields on disk (the pre-feature shape). The AI read returns an empty list and no fingerprint.
- **Written by the panel.** A pre-commit ranking writes the full per-item list + fingerprint. A dismiss sets `dismissed: true` on one entry (the entry stays; fingerprint retained). A re-rank overwrites the whole list + fingerprint.
- **Cleared by the worker.** After a commit consumes the ranking, the worker empties the list and drops the fingerprint, returning the layer to Absent. Unlike a user-exclude key, an AI entry is therefore **consumed per commit**, not sticky.

## Notable Behavior

- **The exclusion FILE is sticky, and (for plans/notes/references) so is the excluded ITEM.** The `commit-selection.json` file itself has no concept of "this commit consumed the exclusion" — a key stays until an explicit un-exclude. And the *effect* on an excluded plan/note/reference is also sticky: it is skipped from this commit but its row + backing file are left intact, so it reappears for re-check next time. The one exception is a conversation, which is consumed at its cursor on the first commit and does not survive. (An earlier build discarded excluded plans/notes/references too, via a now-removed discard pass — that is no longer true.)
- **The worker is read-only on the user layer but WRITES the AI layer.** The queue worker never mutates the four user-exclude arrays. But it **does** write `commit-selection.json` in one specific way: after consuming the AI ranking for a commit it clears the AI per-item ranking list + fingerprint. So the blanket "the worker only reads this file, never writes it" invariant no longer holds — it is true only of the user layer. (The worker also writes the plans/notes/references registry when it *associates* the checked items — a different store — but it deletes no excluded row.)
- **Two layers, one file, forward-compatible.** The user EXCLUDE set (four arrays, version 2) and the AI per-item ranking layer (optional list + fingerprint) coexist in one JSON object at a fixed version stamp. The version was deliberately **not** bumped: a bump would make an older reader reject the file and discard the user's manual excludes. The AI fields are optional and written only when non-empty, so a user who never touches the feature sees the unchanged pre-feature file shape.
- **Dismiss sets a flag; it does not remove.** There is no persistent "user include" layer. Vetoing one AI soft-exclude sets `dismissed: true` on that entry (keeping its `excluded`/tier/reason and the fingerprint so the worker's reuse still holds and the item lands as a kept item with its original verdict), which is a per-change override — it survives until the next re-rank, not across it. Legacy `userIncluded` / `aiSuggestedExclude` / `aiRelevanceResults` keys are ignored on read and dropped on the next write.
- **Excluded conversation IS read and DOES advance its cursor (reversed).** The earlier behavior skipped the read and left the cursor un-advanced so the unchecked row stayed visible. The current behavior reads every session (excluded included) so cursors advance to the commit boundary, then drops the excluded ones at one downstream filter — from both the entry stream and the per-session token map. The excluded conversation is consumed and leaves the working area; its tokens are excluded from the branch token total.
- **Plan / note exclusion is skip-only; the row is kept (reverted).** An in-development build deleted the excluded plan/note's uncommitted row (and, for a note, its product-owned backing file) via a discard pass. That was **removed**. The current behavior filters both the prompt block and the archive-side scan but leaves the row (`commitHash === null`) and backing file intact, so the item *stays on the panel for the next commit*. This is the original behavior restored.
- **Reference exclusion mirrors plan/note exclusion.** An excluded reference is dropped from the prompt-block read loop and the archive-side association, but its registry row and backing markdown are left intact — skip-only, same as plans/notes. It reappears for re-check on the next commit.
- **The branch-scoping removal that shipped alongside these changes is IntelliJ-only.** No CLI/VS Code behavior changed for that half; the CLI exclusion store's per-project (not per-branch) scope is unchanged.
- **The skills kind is DECLARED but no live writer ever emits it into the AI layer.** `skills` is a full member of the exclusion-kind enumeration and is accepted by the AI-ranking coercion, so a ranking entry carrying it would round-trip cleanly. Nothing produces one: the only writer of the AI layer maps the ranker's verdicts to `plans` / `notes` / `references` and has no fourth arm, and the ranker itself only ever builds items of those three kinds. Skills are never fed to the ranker at all — they are track-only metadata about *how* the work happened, with no relevance verdict to have. Treat the enumeration member as declared-but-unreachable on the AI layer; the **user** layer's skills array, by contrast, is written and read for real. (Notable; the asymmetry between the two layers is the point.)
- **Skill exclusion is optional in a way the other four are not.** The other four arrays are always materialized on write and always yield a set on read. The skills array is written only when non-empty and read back as *absent* when the file lacks it — so a file written before skills existed is indistinguishable from one whose user has excluded nothing, and both are correct. Consumers substitute an empty set at the use site. This is what keeps the on-disk file byte-identical for users who never touch the feature, matching the AI layer's rule. (Notable; intentional.)
- **Defensive coercion is per-field.** A file with one corrupted field (non-array, or array of non-strings) still surfaces the valid keys in the other three fields. This is a deliberate weakening of "all-or-nothing" parsing so a partially-damaged file is recoverable on the next write.
- **Loud-but-safe on unknown version.** An unknown version stamp emits a warning and returns empty rather than throwing. This protects the user from being unable to make further selections after a downgrade, at the cost of silently masking the on-disk content until the next write overwrites it.
- **Locking is now cross-process (reversed).** The earlier design serialized writes in-process only and accepted a possible cross-process lost update, on the theory that only one surface mutates selections at a time. That is no longer true: the pre-commit panel and the post-commit worker are separate processes that both write this file (the panel persists the AI ranking; the worker clears it after consume). Every write therefore now runs under a worktree-scoped, PID-tagged cross-process file lock in addition to the in-process chain. The lock is best-effort (a slow holder never permanently blocks a selection change) and the atomic temp+rename keeps the file from ever being observed half-written even when the lock is skipped.
- **Temp file naming combines pid and ms.** The temp filename suffix uses both the writer's process id and the current millisecond. This is sufficient to avoid collisions across processes; within a single process the in-process serialization chain is what prevents collisions within a millisecond.
- **Failed-write recovery is per-project.** A failed write in project A's chain does not affect the chain bookkeeping for project B, nor does it block subsequent writes to project A. The chain's bookkeeping promise is double-caught (success and failure both fold to undefined), so it cannot wedge.
- **Delete helper is for tools, not for the pipeline.** No production path calls the delete helper. It exists for tests and for manual operator intervention ("clear all my exclusions").

## Shared Behavior

- The conversation key format (`<source>:<sessionId>`) is the same string format used throughout the product to uniquely identify a transcript across producers; see [183 — Conversation Overlay Store] for the same composite shape applied to per-entry edits.
- The reference key format (`<source>:<nativeId>`) is identical to the map key used by the plans-and-notes registry to address a reference row; both stores accept the same string without translation.
- Unchecking a plan/note/reference is a **sticky leave-out** (skip this commit, keep the item), not a delete — the registry row and backing file survive (see [189 — Hidden Conversations Store] for the separate list-level conversation hide, which removes a row from the panel without deleting the underlying artifact). Unchecking a conversation is the only one-time discard.
- The "by transcript cutoff" attribution rule for summaries must observe this store's exclusion pass when computing which transcript entries belong to which commit; every session (excluded included) is read so cursors advance, and excluded turns are dropped downstream; see [36 — Summary Attribution by Transcript Cutoff].
- The per-session token totals dropped for excluded conversations keep the branch token bar consistent with the summary body; see [243 — Token Usage Extraction and Cost Estimation].
- The AI per-item ranking list and change fingerprint stored here are produced by the relevance ranker; the tier model, the LLM call, the fingerprint derivation, and the two orchestrators (rank-and-produce vs. reconstruct-from-persisted-ranking) live in [258 — AI Context-Relevance Filtering]. The pre-commit surface that writes them and renders the overlay is [247 — VS Code Working-Memory Review Panel].
