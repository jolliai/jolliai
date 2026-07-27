# 231. Jolli Space Push Article Assembly

## Topic Statement

Turn one commit summary — and, across a branch, its recurring plans, notes, and external references — into deduplicated summary/plan/note/reference articles for the push loop: push a summary's plans, notes, then references first, weave their published URLs back into the summary's rendered body, push the summary (carrying any prior document id so a re-push updates in place instead of duplicating), write the returned ids back into local storage, and best-effort delete any documents that have been orphaned — all while ensuring an attachment that recurs across many commits is pushed exactly once, "owned" by the commit holding its latest revision, and while only ever re-sending a document id to the same backend origin it was minted on.

## Scope

**In scope:**

- The per-summary push order (plans → notes → references → summary), and the URL-weaving that links a summary's rendered body to its published plan/note/reference articles.
- Assembly of a standalone **reference** article (docType `reference`): its title (source label + display title joined by a middle dot) and its synthesized body (link/source header + escaped field table + the archived reference body read back from the orphan-branch snapshot).
- Update-in-place: carrying a prior document id on a re-push so the server updates rather than creates.
- The **env-key document-id reuse gate**: a stored id is re-sent as an update target only when the article URL it was minted with points at the current push's backend origin; otherwise it is dropped and the server mints a fresh document. Every propagated/seed id therefore travels with its minting URL.
- The write-back of returned document ids/URLs into the stored summary, and into its plan/note/reference references.
- The **post-push child-race guard**: after a successful summary push, re-checking whether the commit became a child (squash/amend raced the network push) and, if so, best-effort deleting the just-published article instead of force-writing a zombie root entry.
- **`unresolvedOrphanHashes` resolution at push time**: promoting since-appeared document ids into the orphan-cleanup set, retaining still-in-flight hashes, discarding the rest — and stripping this bookkeeping field from the serialized summary.
- Best-effort orphan cleanup after a successful push, and why it can never fail the push.
- Cross-commit attachment ownership: latest-revision-per-name/id dedup, owner-commit assignment, and seed-document-id (+ minting-URL) propagation (including the rule that an older/losing revision may only *fill in* a missing seed).
- The summary-JSON sidecar: which fields are stripped before serializing, the byte cap, and the silent markdown-only fallback above the cap.
- The push markdown variant (references included, relevance shown, "Topic(s)" headings) and the negative fact that the PR-body builders are not used here.

**Out of scope (boundaries):**

- The on-disk shape of a stored summary and the mechanics of writing one back (covered by the storage specs).
- Enumerating the `base..HEAD` commit hashes and loading their summaries (predates this range; covered by the branch-summary/PR-description specs).
- The HTTP wire shape of an individual push or delete (covered by **Summary Push to Jolli Space**).
- Token/cost computation on a summary (covered by the token-accounting spec).
- The top-level push control flow, space resolution, and result mapping (covered by **CLI Space Push / Spaces / Bind Commands**).

## Data Contracts

### Attachment reference (plan / note / reference)

Each summary carries lists of plan references, note references, and external references. Relevant fields:

| Field                 | On        | Meaning                                                                                                      |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| slug                  | plan      | Identity of the plan; may end in an archived-commit suffix (a hyphen + 8 hex chars).                          |
| id                    | note      | Exact identity of the note.                                                                                   |
| archived key          | reference | Exact per-commit array-entry pointer, of the form `<source>:<nativeId>-<shortHash>`. Used to weave the published URL into the one commit entry that actually pushed. |
| base identity         | reference | The stable, per-commit-independent identity `<source>:<nativeId>` — the same ticket on many commits shares this. Used for cross-commit dedup (a *different* identity than the archived key). |
| last-updated time     | all       | Recency used to pick the winner revision (compared as a string, newest wins). Plans/notes use their last-updated time; references use their referenced-at time. |
| published document id | all       | Server id from a prior push; its presence drives update-in-place and cross-commit seeding.                    |
| published URL         | all       | Article URL from a prior push, woven into the summary body. Its origin is also the backend the published id belongs to (see the reuse gate). |
| title / content       | all       | Display title and body. A plan's body is read from storage; a note's may be inline or read from storage; a reference has **no on-disk working file** — its body is synthesized (see Reference article assembly). |

### Document-id reuse gate (env key)

A stored server-assigned document id (summary/plan/note/reference) is sent to the backend as an update target **only** when the id was minted against the same backend origin as the current push. The decision compares the URL-origin "env key" derived from the stored document's recorded article URL against the env key derived from the current push's resolved base URL:

- Match → the id is re-sent (update-in-place).
- Mismatch → the id (and its URL) are dropped, so the backend mints a fresh document rather than overwriting a **different** backend's article (e.g. a local-dev id must never update a production document).
- No stored URL → treated as legacy / never-pushed (nothing to conflict with); reuse is allowed, preserving the pre-tagging always-reuse behavior.
- Unparseable stored URL → treated as env-agnostic; reuse is allowed rather than throwing.

The env key is the lowercased origin (scheme + host + non-default port) of the URL — deliberately origin-only, not org/tenant, because the id namespaces are per-backend. Because the gate needs the minting URL, **every propagated or seeded document id travels together with the URL it was minted with** (plan/note reduction inheritance, cross-commit seed propagation, and the woven-back write-back all carry the pair).

### Owned-attachment assignment (output of cross-commit dedup)

- A map from owner-commit hash → the plans that commit owns.
- A map from owner-commit hash → the notes that commit owns.
- A map from owner-commit hash → the references that commit owns.
- Seed-document-id maps (plan base-key → id; note id → id; reference base-identity → id) for callers that want to pre-seed resolution. In this push path these are not consumed — the seed id (with its minting URL) is already applied onto the owned references.

### Summary-JSON sidecar

- A serialized structured copy of the (URL-enriched) summary, sent alongside the summary's markdown.
- Byte cap: **1,572,864 bytes (~1.5 MiB)**. Above the cap the sidecar is omitted and the summary is pushed markdown-only. (The server rejects a sidecar above 2 MiB; the cap keeps well under, leaving headroom for the markdown in the same body.)
- Four top-level fields are stripped before serializing (see Summary-JSON sidecar assembly): the summary's own published document id and URL, the orphaned-document-id list, and the `unresolvedOrphanHashes` bookkeeping list.

## Behavior

### Push one summary

1. Resolve the current push's backend env key up front (no network I/O). Every document id sent below is gated against it by the reuse gate.
2. Determine the plans, notes, and references to push: either the caller-selected owned attachments, or — when none are supplied — the summary's own plans reduced by the per-summary latest-per-name rule, all of its notes, and all of its references. (The branch push loop always supplies the owned, cross-commit-deduped attachments explicitly.)
3. **Push plans first, then notes, then references.** For each:
   - Obtain its body: a plan's body is read from storage; a note's body is its inline content or, absent that, read from storage; a reference's body is synthesized (see Reference article assembly). A plan/note whose content can't be read is logged and skipped.
   - Push it as its own document — docType `plan` / `note` / `reference` — carrying its prior document id **only when the reuse gate permits** (id present *and* env-key match).
   - A single attachment whose push fails with a *transient* error is logged and skipped — it does not abort the summary. Two failures are **fatal and propagate**: binding-required and client-outdated.
   - Record each successful push's published article URL (see Article URL resolution) and its returned document id. Plan results are keyed by slug, note results by id, reference results by archived key.
4. **Weave published URLs into the summary body.** Merge the plan URLs (matched by slug), note URLs (matched by id), and reference URLs (matched by archived key) into a working copy of the summary, so the rendered "plans & notes" section links to the published articles. For weaving, the summary's plans are again reduced by the per-summary latest-per-name rule (only the latest snapshot was uploaded).
5. Render the push markdown from the enriched copy, and serialize the summary-JSON sidecar from the *same* enriched copy.
6. **Push the summary** with: title, rendered markdown, commit hash, a document-type discriminator of "summary", the branch, the prior summary document id **only when the reuse gate permits** (update-in-place), the canonical repo URL, the flat per-branch relative path, and the sidecar when present.
7. Compute the summary's article URL (see Article URL resolution).
8. **Post-push child-race guard.** Re-read the commit's current index entry. If the commit has since become a *child* (a squash/amend merged it into another root while this push was on the network), then force-writing it back as a root would create a zombie index entry duplicating the merged root's content. Instead: best-effort delete the just-published article (a failed delete is logged, not surfaced) and return the summary and its URL **without** any write-back. The merged root remains the sole authority for the commit's memory.
9. **Write back** into the stored summary (force-write): the article URL and document id, plus the published plan/note/reference document ids/URLs merged into the summary's *own* plan/note/reference reference lists.
10. **Resolve `unresolvedOrphanHashes`** (only when the summary has any; see below), persisting an updated summary when the resolution changed anything.
11. **Orphan cleanup (best-effort).** Delete any documents the summary records as orphaned (see below). This runs after the summary is already pushed and stored, so any failure here is caught and logged and must never surface as a failed push.
12. Return the persisted summary and its article URL.

### Article URL resolution

The browsable article URL for any pushed document (summary, plan, note, reference) prefers the server-returned URL over a synthesized alias:

- Server returned an **absolute** URL (has an `http(s)://` scheme) → used verbatim.
- Server returned a **relative** URL → prefixed with the display base URL (the site base URL with trailing slashes stripped; a leading slash is added if the relative value lacks one).
- Server returned **no** URL → fall back to the alias `<displayBase>/articles?doc=<docId>`.

This is the canonical article-path resolution shared by the summary, plan, note, and reference push results, and by the summary write-back. (Historically the URL was always the `?doc=<id>` alias; the server-URL preference supersedes that.)

### Reference article assembly

A reference is pushed as a standalone `reference` article. Unlike a plan or note, it has no on-disk working file (the local reference markdown is deleted at commit time; the orphan-branch snapshot is the system of record), so both its title and body are synthesized.

**Title.** The human source label (e.g. `Linear`, `GitHub`) joined to the reference's unified display title by a **middle dot** (` · `). A middle dot — not a colon — is used deliberately: the title sanitizer strips a colon (colons are forbidden in document titles), so a colon separator would vanish. The dot also scopes the generated slug into a per-source namespace, so a reference never collides with a plan/note/summary sharing the same base title. The display title itself leads with the native id (`<nativeId> — <title>`) only for the issue trackers (Linear, Jira, GitHub); every other source shows the title alone.

**Body.** Synthesized as a header followed by the archived body:
1. A **link row** — a markdown bullet linking to the reference's external URL — but only when the reference carries a URL (some sources, e.g. Slack without a permalink, have none; the row is omitted rather than emitting a dead link).
2. A **source row** — a bullet naming the originating tool.
3. A **field/value table** (only when the reference has fields) — a two-column markdown table of the reference's source-specific fields. Each cell is escaped for table-safety in order: backslash → doubled, pipe → escaped, newline (CR/LF) → space. The order matters: escaping backslashes first prevents a trailing backslash from turning the escaped `\|` back into a live cell separator.
4. The **archived reference body** — the stored source content (issue/PR/page body) read back from the orphan-branch snapshot, appended below the header with its leading/trailing blank lines trimmed. When the snapshot is missing or unparseable, the article is header-only; a missing body is never a failed push.

### Per-summary latest-per-name reduction

Within one summary, collapse plans that share a base name (the slug with its trailing archived-commit suffix stripped) to a single latest snapshot, preserving newest-first order. Because same-named plans share an identical server push identity (same title, branch, path, commit — the slug is not sent), the published document id is the only thing that tells the server to update rather than create. So when an older already-pushed snapshot carries a document id but the latest snapshot lacks one, the latest **inherits** that id/URL — otherwise the re-push would create a duplicate, which the server rejects.

### Cross-commit attachment ownership

Across all summaries in the push range, decide, per plan base-name, per note id, and per reference base-identity, exactly one winner revision and which commit owns pushing it:

1. **Winner = latest revision** by last-updated time (compared as a string; newest wins; first-seen kept on a tie). The dedup **identities differ by kind**:
   - **Plans** — keyed by base name (slug with its trailing archived-commit suffix stripped), tiebroken on slug for determinism.
   - **Notes** — keyed by exact id (no tiebreak needed).
   - **References** — keyed by the **stable base identity `<source>:<nativeId>`**, *not* the per-commit archived key. So the same ticket referenced on many commits collapses to **one** Space article. Recency uses the reference's referenced-at time (string compare; newest wins; first-seen on a tie).

   The winner's owner is the commit that carries it.
2. **Seed document id propagation.** The winner should push to the *one* existing article for that plan/note/reference, so it carries a "seed" document id **plus the URL that id was minted with**:
   - The winner's own document id (and its URL) is authoritative; it is used when present.
   - A revision that *loses* (an older one) may only **fill in a missing seed** — it may **never overwrite** the winner's own id. Overwriting would push the latest content to an older article and orphan (leak) the winner's real article. The minting URL always tracks whichever revision actually supplied the id, so the downstream reuse gate can tell which backend the seed belongs to.
3. Each winner is assigned to its owner commit with its seed id/URL applied onto the reference, so an attachment recurring across commits is pushed once (as that commit's owned attachment) instead of once per commit.

The plan winner comparator is the **same** used by the per-summary reduction, so the two dedup paths never disagree on which snapshot is "latest" — a disagreement would push one slug but weave the URL against another, dropping the plan's link.

### Summary-JSON sidecar assembly

1. Take the URL-enriched summary copy.
2. **Strip churn-only client fields** before serializing: the summary's own published document id and URL (they change every push), the orphaned-document-id list, and the `unresolvedOrphanHashes` list (both are cleanup bookkeeping, not commit content). Stripping them also keeps the sidecar's top-level bytes identical across re-pushes of unchanged content, so the server's upsert can no-op. (Per-plan/per-note/per-reference published ids nested inside the attachment lists are left intact and may still churn.)
3. Serialize to JSON. If the result exceeds the byte cap, log a warning and **omit** the sidecar (push markdown only). Otherwise attach it.

### `unresolvedOrphanHashes` resolution

Some commit hashes are recorded as *unresolved orphans* — at squash/merge time their summaries had no published document id yet (a background worker hadn't written one back), so there was no article id to schedule for cleanup. At push time, after the summary is stored, each such hash is resolved:

1. If the summary has no unresolved orphan hashes, skip this step entirely.
2. Read the shared push-pending queue once. (If that read fails, fall back to **conservative retention** — keep every unresolved hash — so a crashed worker's article can still be cleaned up on a later push.)
3. For each unresolved hash, re-read that hash's summary:
   - If it now carries a published document id **and its own commit hash matches the hash** (guarding against a tree-hash fallback resolving to the merged summary, whose id is the article this push just created), **promote** that id into the orphaned-document-id set for cleanup.
   - Else, if the pending-queue read failed, **retain** the hash (conservative).
   - Else, if the hash is still present in the pending queue, **retain** it (a worker is still in flight and may yet produce an id).
   - Else (absent from the queue and no id), **discard** it — it was never pushed or the worker finished without an id, so there is no article to clean up.
4. If anything changed (any id promoted, or any hash dropped), merge the promoted ids into the orphaned-document-id set (deduped), replace the unresolved-hash list with the retained hashes (or clear it), and persist the updated summary. This bookkeeping field is stripped from the serialized summary-JSON sidecar (see above).

### Orphan cleanup

1. Read the summary's list of orphaned document ids (documents whose local origin no longer exists — e.g. from a squash/rebase). If empty, do nothing.
2. Attempt to delete each in parallel.
3. Clear from the bookkeeping **only** the ids that were successfully deleted; keep the failures so the next push retries them.
4. Persist the updated bookkeeping. This whole step is best-effort and its failure is swallowed by the caller.

### Push markdown variant

The push markdown reuses the shared summary section builders but with choices distinct from the export/clipboard and PR markdown:

- **References are included** — pushed documents surface their extracted external references (issue/ticket/doc links).
- **Relevance is shown** — the plans-&-notes section renders the AI relevance picture (each kept row gains its tier + one-line reason; soft-excluded items are listed). This aligns the pushed Space article with every other summary surface (webview, clipboard, Memory Bank markdown); only PR bodies stay relevance-free. Rendering it here also keeps the CLI and editor-extension push paths from diverging from each other.
- The topic heading label is **"Topic"/"Topics"**, not the export path's "Summary/Summaries".

Structure mirrors the summary view: the commit-message heading, a properties table, a plans-&-notes section (with references and relevance), a quick recap, an end-to-end test guide, a source-commits list (only for squash/multi-record summaries), the numbered topics, and a footer.

**Negative fact:** the PR-body markdown builders are **not** used in this push path. The push markdown shares only the lower-level section builders with the PR path; it does not go through the PR-body assembly.

## Notable Behavior

- **Plans, notes, and references are pushed before the summary so their URLs can be woven in.** The summary body links to already-published attachment articles; reversing the order would leave dangling links. (Notable.)
- **A reference is pushed as a third standalone attachment kind (docType `reference`).** It has no on-disk working file, so its title and body are synthesized and its body is read back from the orphan-branch snapshot. (Notable.)
- **Reference cross-commit dedup uses a different identity than plans/notes.** References dedup on the stable base identity `<source>:<nativeId>` (not the per-commit archived key), so the same ticket on many commits collapses to one Space article — yet the woven-back URL is matched by the per-commit archived key so only the entry that actually pushed gets the link. (Surprising.)
- **Update-in-place hinges on carrying the prior document id.** The slug is never sent, so same-named documents are indistinguishable to the server except by the id the client supplies — the id is the sole update-vs-create signal. (Surprising; central.)
- **A stored id is only ever re-sent to the backend it was minted on.** The reuse gate compares the id's minting-URL origin against the current push's backend origin; a mismatch drops the id so the server mints a fresh document rather than overwriting a different backend's article. This is why every propagated/seed id travels with its minting URL. (Surprising; safety-relevant.)
- **A losing revision may only fill a *missing* seed, never overwrite the winner's id.** Overwriting would push the latest content to a stale article and orphan the winner's real one. (Surprising; safety-critical.)
- **A summary that becomes a child mid-push has its freshly-published article deleted.** If a squash/amend merges the commit into another root while the summary push is on the network, force-writing it back as a root would create a zombie index entry; instead the just-published article is best-effort deleted and no write-back happens. (Surprising; race-hardening.)
- **The winner comparator is shared between the per-summary and cross-commit plan-dedup paths on purpose.** A divergence would push one snapshot while weaving the URL of another. (Notable.)
- **Recency is compared as a string, newest-first.** This is deliberate — it avoids a parse-to-number-on-malformed-date pitfall and stays deterministic. (Notable.)
- **Orphan cleanup can never fail the push.** The summary and its id are already pushed and stored before cleanup runs; a cleanup or bookkeeping failure is logged, not surfaced. Failed deletions are retried on the next push. (Notable.)
- **Unresolved orphan hashes are resolved against the live push-pending queue.** A hash whose summary since gained a document id is promoted to cleanup; a hash still in the queue is retained as in-flight; a hash in neither is discarded. If the queue can't be read, every hash is conservatively retained so a crashed worker's article can still be cleaned up later. (Notable.)
- **The sidecar is dropped silently above ~1.5 MiB.** An oversized structured sidecar must never fail the markdown push, so it is simply omitted. (Notable.)
- **Stripping churn fields from the sidecar lets an unchanged re-push no-op server-side.** The per-push document id/URL and cleanup bookkeeping are removed so the sidecar's top-level bytes stay identical for unchanged content. (Notable.)
- **Attachment content failures are best-effort; binding-required and client-outdated are fatal.** A single unreadable or transiently-failing plan/note is skipped; a binding or upgrade problem aborts the whole push so the caller can drive the binding / upgrade flow. (Notable.)

## Shared Behavior

- The on-disk summary shape and the write-back mechanics are defined by the storage specs.
- The HTTP request/response of an individual push or delete is defined by **Summary Push to Jolli Space**.
- The top-level branch push control flow, space resolution, and result rendering are defined by **CLI Space Push / Spaces / Bind Commands**.
- The canonical repo URL and the flat per-branch relative path are defined by **Canonical Repo URL and Name Derivation**.
- Token/cost accounting on a summary is defined by the token-accounting spec.
