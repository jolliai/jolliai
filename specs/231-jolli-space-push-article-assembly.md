# 231. Jolli Space Push Article Assembly

## Topic Statement

Turn one commit summary — and, across a branch, its recurring context artifacts — into deduplicated summary + per-artifact articles for the push loop: push a summary's context attachments first (in registry order), weave their published URLs back into the summary's rendered body, push the summary (carrying any prior document id so a re-push updates in place instead of duplicating), write the returned ids back into local storage, and best-effort delete any documents that have been orphaned — all while ensuring an attachment that recurs across many commits is pushed exactly once, "owned" by the commit holding its latest revision, and while only ever re-sending a document id to the same backend origin it was minted on.

**The push path is table-driven.** Which *kinds* of context artifact exist — and their identity, dedup, recency and document-state fields — is declared once per kind in a **context-kind definition**; the push loop, URL write-back, ownership plumbing, the editor-extension push path and the (currently caller-less) batch-attachment assembler are all generic over the definition registry. Plans, notes, external references and skills are the registered kinds, in that order, and they are configuration rather than four code paths. Adding a kind is a definition plus one registration entry, with no change to any behavior described below.

## Scope

**In scope:**

- The **context-kind definition contract**: which properties a kind declares, which are data vs behavior, and the defaults an omitted property falls back to.
- The per-summary push order (every registered kind's attachments in registry order → summary), and the URL-weaving that links a summary's rendered body to its published attachment articles.
- Assembly of a standalone **reference** article (docType `reference`): its title (source label + display title joined by a middle dot) and its synthesized body (link/source header + escaped field table + the archived reference body read back from the orphan-branch snapshot).
- Assembly of the **skill** article (docType `skill`): the aggregation of a commit's whole skill set into ONE article, its title, its synthesized body, and the fact that its published id/URL land on the commit rather than on any item.
- The **document-type refusal** contract: how a server that does not have a docType enabled is reported, and why it short-circuits one kind rather than one item or the whole push.
- Update-in-place: carrying a prior document id on a re-push so the server updates rather than creates.
- The **env-key document-id reuse gate**: a stored id is re-sent as an update target only when the article URL it was minted with points at the current push's backend origin; otherwise it is dropped and the server mints a fresh document. Every propagated/seed id therefore travels with its minting URL.
- The write-back of returned document ids/URLs into the stored summary, and into its plan/note/reference references.
- The **post-push child-race guard**: after a successful summary push, re-checking whether the commit became a child (squash/amend raced the network push) and, if so, best-effort deleting the just-published article instead of force-writing a zombie root entry.
- **`unresolvedOrphanHashes` resolution at push time**: promoting since-appeared document ids into the orphan-cleanup set, retaining still-in-flight hashes, discarding the rest — and stripping this bookkeeping field from the serialized summary.
- Best-effort orphan cleanup after a successful push, and why it can never fail the push.
- Cross-commit attachment ownership: latest-revision-per-name/id dedup, owner-commit assignment, and seed-document-id (+ minting-URL) propagation (including the rule that an older/losing revision may only *fill in* a missing seed).
- The summary-JSON sidecar: which fields are stripped before serializing, the byte cap, and the silent markdown-only fallback above the cap.
- The push markdown variant (references included, relevance shown, "Topic(s)" headings) and the negative fact that the PR-body builders are not used here.
- The **batch-attachment assembly shape** — what a per-commit attachment set and its URL placeholders would look like — recorded as a shape, with the negative fact that no production caller builds one.

**Out of scope (boundaries):**

- The one-way adoption of a previously-shipped model's per-(skill, commit) article ids into the commit-level one, which runs at the head of this push and whose result this push persists — covered by **Legacy Skill-Article Migration**; referenced here only as a step.
- The on-disk shape of a stored summary and the mechanics of writing one back (covered by the storage specs).
- Enumerating the `base..HEAD` commit hashes and loading their summaries (predates this range; covered by the branch-summary/PR-description specs).
- The HTTP wire shape of an individual push or delete (covered by **Summary Push to Jolli Space**).
- Token/cost computation on a summary (covered by the token-accounting spec).
- The top-level push control flow, space resolution, and result mapping (covered by **CLI Space Push / Spaces / Bind Commands**).

## Data Contracts

### Context-kind definition

One entry per kind of pushable context artifact. Identity and field names are **data** so a kind declares rather than implements them (and so a registry can validate them); only title and body are behavior, because a body must be read out of storage and a title must be escaped.

| Property | Kind of value | Meaning |
| --- | --- | --- |
| document type | data | The wire `docType` tag, and the registry key. Must be unique. |
| summary field | data | Name of the `CommitSummary` array holding these items. |
| entry key field | data | Per-commit entry identity — the field a published URL is woven back onto. |
| base key spec | data | Cross-commit dedup identity: a list of fields joined by `:`, optionally with a trailing archive stamp stripped. |
| recency field | data | Field whose value picks the winner revision, **compared as a string**. |
| **document-state scope** | data, optional | `item` (the default) — one article per item, so the published id/URL live on each item. `summary` — ONE article per commit, so they live on the **summary**. A summary-scoped kind is what the aggregate property below produces, and it is validated: **it must override both field names**, because the uniform defaults are the *memory article's own* id/URL fields and inheriting them would overwrite the memory's published identity with its attachment's. |
| document id / URL field names | data, optional | Where a published id/URL is stored, on whichever carrier the scope names. **Omitted → the uniform `jolliDocId` / `jolliDocUrl` names**, which only an item-scoped kind may take. A legacy kind overrides them with its historical per-kind names so existing stored summaries need no migration. |
| title | behavior | The article title; the definition is responsible for sanitizing it for a document title. |
| body | behavior | The article body. Returning "no body" means **skip this item** — never an error. |
| per-summary reduction | behavior, optional | Collapses items within one summary before pushing (only plans need it, for same-named archived snapshots). **Applied only when the caller supplies no selection**, and additionally applied to the copy the summary markdown is rendered from — because for a plan the collapse is a statement about which items *exist* for that commit. |
| **aggregate** | behavior, optional | Collapses the items ONE commit is about to push into fewer (today: into one), whichever path selected them. Deliberately **not** the reduction above, and the two differences are both load-bearing: an aggregate runs on **both** the caller-selection and own-items branches (the branch-push path always supplies a selection, so skipping it there would keep publishing one article per item), and it is **never** applied to the rendered-markdown copy (every underlying item still exists and the summary's Context section still summarises all of them, so folding it into the rendered copy would delete rows from the memory itself). The items it returns must carry the entry-key and document-state identity the engine reads off them. |
| recency tiebreak | behavior, optional | Deterministic order when two revisions share a recency value (only plans need it). |
| links-in-markdown | data, optional | Defaults to true. False suppresses batch placeholder minting for the kind (see Batch-attachment assembly). |
| best-effort-push | data, optional | Defaults to false. Marks a kind as auto-extracted context rather than user-attached content, which changes failure handling in the editor extension (see Attachment failure handling). The CLI path logs-and-skips everything, so it never reads this. |
| batch client-key prefix | data, optional | **Defaults to the document type.** Prefix of the per-item batch client key (`<prefix>-<index>`) and the payload of the URL placeholder token — so it is a declared value, not a derived one, and one legacy kind pins its historical prefix rather than adopting its docType. Must be unique across kinds: the index restarts per kind, so a shared prefix would emit the same key twice in one request. |

**Validation at first use.** The registry is validated lazily and throws rather than silently pushing nothing: an empty or duplicate document type, an empty field / entry-key / recency name, an empty base-key field list, an explicitly-empty client-key prefix, a duplicate resolved client-key prefix, or a summary-scoped kind missing either document-state field name. A *wrong-but-non-empty* name cannot be caught this way — a definition is data, and an absent field reads as the empty string — so those names are instead checked against the kind's own item type where the definition is written.

### The registered kinds

Registration order is the order attachments are pushed within one summary, and it is user-visible:

| Order | Document type | Entry key (URL write-back) | Cross-commit base key | Recency | Document state | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `plan` | plan slug | slug with the trailing archive stamp stripped | last-updated time | item-scoped, historical per-kind field names | The only kind with a per-summary reduction **and** a recency tiebreak. |
| 2 | `note` | note id | the exact id, **no** archive-stamp strip | last-updated time | item-scoped, historical per-kind field names | The only kind whose body may come from the item itself. |
| 3 | `reference` | per-commit archived key | stable `<source>:<nativeId>` | referenced-at time | item-scoped, historical per-kind field names | Best-effort. Pins its historical client-key prefix. |
| 4 | `skill` | the aggregate's own commit-level key | equal to the entry key | last-used time | **summary-scoped** | Best-effort. Declares an aggregate, and suppresses in-markdown links. Appended last because it describes *how* the work happened rather than what it was about — the same ordering every Context surface uses. |

A filesystem scan would remove even the registration entry, but the editor-extension and plugin bundles inline this source with a bundler that has no glob-import, so a static list is the floor for the dependency to be visible at all.

### Attachment item fields (as declared by the registered kinds)

Each summary carries lists of plan references, note references, external references, and skill records. Relevant fields:

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

**Keyed by document type, one entry per REGISTERED kind** — never a fixed set of named fields. Each entry carries:

- a map from owner-commit hash → the items of that kind the commit owns pushing, and
- a map from base key → a known document id, for callers that want to pre-seed a cross-commit resolution map. In this push path the seed map is not consumed: the seed id (with its minting URL) has already been applied onto the owned items themselves.

A per-commit **selection** is derived from it by taking, for every document type, that commit's owned list or an explicit empty array.

**The three named maps (`ownedPlans` / `ownedNotes` / `ownedReferences`) and the named `{plans, notes, references?}` selection survive only as test-compat adapters** over the keyed form, and are expanded by walking the registry so that a kind the named shape cannot express becomes an *explicit* "push none" rather than an absent key. That expansion also asserts every legacy document type is still registered — a kind renaming its document type would otherwise leave the adapters emitting a key no kind matches, and the keys are strings, so nothing type-checks it. The reverse direction is deliberately not an error: a kind absent from the legacy list expands to "push none", which is the only safe default (falling back to the summary's own items would double-publish a kind that dedupes across commits). **No surface may spell its own `plan`/`note`/`reference` list** — a per-surface copy is precisely what made the branch-share path silently skip the skill kind, because a named selection is a COMPLETE answer.

### Summary-JSON sidecar

- A serialized structured copy of the (URL-enriched) summary, sent alongside the summary's markdown.
- Byte cap: **1,572,864 bytes (~1.5 MiB)**. Above the cap the sidecar is omitted and the summary is pushed markdown-only. (The server rejects a sidecar above 2 MiB; the cap keeps well under, leaving headroom for the markdown in the same body.)
- Top-level fields stripped before serializing (see Summary-JSON sidecar assembly): the summary's own published document id and URL, **the commit-level skill article's id and URL**, the orphaned-document-id list, and the unresolved-orphan-hash bookkeeping list.

## Behavior

### Push one summary

0. **Adopt any legacy per-skill article ids** into the commit-level one, before anything reads the summary's skill records. Idempotent, and persisted by this function's own write-back like every other field it updates. Defined by **Legacy Skill-Article Migration**.
1. Resolve the current push's backend env key up front (no network I/O). Every document id sent below is gated against it by the reuse gate.
2. Determine the items to push **per registered kind**: either the caller-supplied selection, or — when none is supplied — the summary's own items for that kind, passed through the kind's per-summary reduction if it declares one. Then, on **either** branch, apply the kind's aggregate if it declares one and the selected list is non-empty. (The branch push loop always supplies the owned, cross-commit-deduped attachments explicitly, which is exactly why the aggregate must not be skipped on the selection branch.)

   **The selection is tri-state, and the distinction is load-bearing.** No selection at all means "push the summary's own items". A selection that is present but names no items for a kind means "push **none** of that kind" — not "fall back to the summary's own". Inverting this either silently pushes nothing or pushes an un-deduped duplicate set.
3. **Push every kind's attachments, in registry order.** For each item:
   - Obtain its body from the kind's body behavior: a plan's body is read from storage; a note's body is its inline content or, absent that, read from storage; a reference's body is synthesized (see Reference article assembly). An item whose body is absent or empty is logged and skipped.
   - Push it as its own document, tagged with the kind's document type, carrying its prior document id **only when the reuse gate permits** (id present *and* env-key match). The prior id/URL are read from whichever carrier the kind's document-state scope names — the item for an item-scoped kind, **the summary itself** for a summary-scoped one.
   - Re-read the per-repo outbound opt-out **immediately before every send**, so a mid-run opt-out stops the remaining uploads rather than only the next run.
   - Record each successful push's published article URL (see Article URL resolution), its returned document id, its entry key, and its base key.
   - Failure handling: see Attachment failure handling.
4. **Weave published URLs into the summary body.** Merge each kind's published URLs into a working copy of the summary, matched by that kind's **entry key** — the exact per-commit array entry, so an item recurring across commits only updates the entry that actually pushed. A kind absent from the published set, or whose array the summary does not carry at all, is left untouched, so an unchanged summary is returned by identity.

   **A summary-scoped kind is woven onto the summary's own fields instead**: its article covers the commit, so there is no entry that owns it. The **first** published document for such a kind is taken (its aggregate produced exactly one), which keeps that assumption visible rather than silently letting a later one win.

   The copy is first passed through every kind's per-summary reduction — only the reduced set was uploaded and the rendered body must list the same set — but **not** through any kind's aggregate, so the rendered Context section still describes every underlying item.
5. Render the push markdown from the enriched copy, and serialize the summary-JSON sidecar from the *same* enriched copy.
6. **Push the summary** with: title, rendered markdown, commit hash, a document-type discriminator of "summary", the branch, the prior summary document id **only when the reuse gate permits** (update-in-place), the canonical repo URL, the flat per-branch relative path, and the sidecar when present.
7. Compute the summary's article URL (see Article URL resolution).
8. **Post-push child-race guard.** Re-read the commit's current index entry. If the commit has since become a *child* (a squash/amend merged it into another root while this push was on the network), then force-writing it back as a root would create a zombie index entry duplicating the merged root's content. Instead: best-effort delete the just-published article (a failed delete is logged, not surfaced) and return the summary and its URL **without** any write-back. The merged root remains the sole authority for the commit's memory.
9. **Write back** into the stored summary (force-write): the article URL and document id, plus every kind's published ids/URLs merged into the summary's *own* item lists (and, for a summary-scoped kind, onto the summary's own fields). The weave is applied to the summary's own items rather than to the reduced copy, so an unpushed same-named plan snapshot keeps its place in stored history.
10. **Resolve `unresolvedOrphanHashes`** (only when the summary has any; see below), persisting an updated summary when the resolution changed anything.
11. **Orphan cleanup (best-effort).** Delete any documents the summary records as orphaned (see below). This runs after the summary is already pushed and stored, so any failure here is caught and logged and must never surface as a failed push.
12. Return the persisted summary and its article URL.

### Article URL resolution

The browsable article URL for any pushed document (summary, plan, note, reference) prefers the server-returned URL over a synthesized alias:

- Server returned an **absolute** URL (has an `http(s)://` scheme) → used verbatim.
- Server returned a **relative** URL → prefixed with the display base URL (the site base URL with trailing slashes stripped; a leading slash is added if the relative value lacks one).
- Server returned **no** URL → fall back to the alias `<displayBase>/articles?doc=<docId>`.

This is the canonical article-path resolution shared by the summary, plan, note, and reference push results, and by the summary write-back. (Historically the URL was always the `?doc=<id>` alias; the server-URL preference supersedes that.)

### Attachment failure handling

Three tiers, deliberately distinct:

1. **Per-item skip.** A transient failure (network, 5xx, an unreadable body) is logged and the item is skipped; the summary push proceeds. In the editor extension a user-attached kind's failure is additionally *collected*, and the strict branch-share path turns collected failures into a fatal share error — the user chose to attach it, so shipping silently without it would misrepresent the share. A **best-effort** kind's failure never joins that collection: it is auto-extracted context, so one item the server rejects must not abort a share the user never attached it to.
2. **Per-kind short-circuit (document type not enabled).** When the server reports that a document type is not enabled in its supported-type configuration, **every remaining item of that same kind would fail identically**. The kind is therefore short-circuited **for the rest of that summary's push**, with **one** actionable log line naming the type; other kinds keep pushing and the summary still publishes. Per-item logging here would emit a dozen copies of one configuration problem, reading like transient failures.

   The scope is one summary, not the whole run: a branch push re-attempts the refused kind on the next summary and so logs once per summary rather than once per branch. That is deliberate — the refusal is a per-request answer, and the alternative (a run-scoped refused-docType set threaded through the push seam) buys a quieter log at the cost of a summary never re-attempting a kind the server started accepting mid-run.
3. **Whole-push abort.** Binding-required and every repo-wide refusal (client-outdated, push-disabled, permission-denied) propagate and abort the attachment loop.

**"Best effort" means "does not abort the push", not "is hidden from the user".** The editor extension reports skipped attachments back to its caller on a channel separate from failures, and a caller the *user* triggered must surface them: a manual push that publishes fewer articles than the memory has context for, while reporting plain success, misstates what happened. The tiers of interruption are proportional — a hard failure is a modal (skipped items fold into its detail, since the user is already being interrupted), skipped-only is a non-blocking warning, and a background pass (share reconcile, which re-enters the push on every modal open) reports to the log only.

**The report is per KIND, not per item.** Both routes into it are kind-wide conditions — a docType the server has not enabled, or N items of one kind failing for the same reason — and the report is rendered into a notification. One entry per item made the well-behaved server (which names the refusal in machine-readable form) the *silent* case while a server returning a generic error produced a notification a dozen titles long. The log keeps every title; the report keeps the count.

**The document-type refusal must NOT be classified as a repo-wide refusal.** The permission-denied class *is* one, so reusing it — the natural-looking choice, since the repo-allowlist refusal is reported with the same status and machine-tag shape — would make a single missing configuration row abort every attachment and fail the summary push, i.e. stop the repo publishing anything at all. It also must not burn a retry budget or mark the commit failed: the summary itself pushes fine.

### Reference article assembly

A reference is pushed as a standalone `reference` article. Unlike a plan or note, it has no on-disk working file (the local reference markdown is deleted at commit time; the orphan-branch snapshot is the system of record), so both its title and body are synthesized.

**Title.** The human source label (e.g. `Linear`, `GitHub`) joined to the reference's unified display title by a **middle dot** (` · `). A middle dot — not a colon — is used deliberately: the title sanitizer strips a colon (colons are forbidden in document titles), so a colon separator would vanish. The dot also scopes the generated slug into a per-source namespace, so a reference never collides with a plan/note/summary sharing the same base title. The display title itself leads with the native id (`<nativeId> — <title>`) only for the issue trackers (Linear, Jira, GitHub); every other source shows the title alone.

**Body.** Synthesized as a header followed by the archived body:
1. A **link row** — a markdown bullet linking to the reference's external URL — but only when the reference carries a URL (some sources, e.g. Slack without a permalink, have none; the row is omitted rather than emitting a dead link).
2. A **source row** — a bullet naming the originating tool.
3. A **field/value table** (only when the reference has fields) — a two-column markdown table of the reference's source-specific fields. Each cell is escaped for table-safety in order: backslash → doubled, pipe → escaped, newline (CR/LF) → space. The order matters: escaping backslashes first prevents a trailing backslash from turning the escaped `\|` back into a live cell separator.
4. The **archived reference body** — the stored source content (issue/PR/page body) read back from the orphan-branch snapshot, appended below the header with its leading/trailing blank lines trimmed. When the snapshot is missing or unparseable, the article is header-only; a missing body is never a failed push.

### Skill article assembly

A commit's whole skill set is pushed as **ONE** `skill` article, and this is the only kind that publishes one article for many items.

**Why one.** Every local surface already shows a commit's skills as one artifact — the Memory Bank writes a single per-commit skills file, and the summary's Context section renders one unlinked "Skills used" row. Publishing one article per skill meant a commit whose Context listed a single skill arrived at the backend as several documents; the decomposition was never a product decision, it fell out of the engine being one-document-per-item.

**The aggregate item.** Before pushing, the commit's skill records are collapsed into one synthetic item:

- The records are first ordered **ascending by archive key**, so the body's detail list and the pushed content are byte-stable across runs.
- The first ordered record supplies the carrier fields, **with its legacy per-item document id and URL dropped rather than spread through** — this kind is summary-scoped, so an id riding on the synthetic item would be a second, stale answer to "which article is this?" that a future reader could act on.
- The synthetic item's entry key is the **commit-level** key `skills--<hash8>`, derived from the commit hash — matching the Memory Bank file name for the same data, so one commit's skills are not named two ways. Deriving it from the commit rather than from a representative record is what makes it stable no matter how the skill set changes between pushes: a fold that collapses three records into one, or a skill entered after the first push, leaves it untouched.
- The synthetic item carries the ordered record set for the body, and is **never stored** — it exists only between selection and the push call.

**The published id/URL belong to the COMMIT.** The kind is summary-scoped and overrides both document-state field names (the uniform defaults are the memory article's own fields, and inheriting them would overwrite it). Parking a commit-level id on a representative record is not a harmless shortcut, which is why this is a scope rather than a convention: the record would then travel through the skill kind's own per-record merge rules — which inherit, displace and register-for-deletion an id under rules written for per-item articles. A squash whose root and child had each been pushed ended up with two records carrying ids from two *different* aggregate articles: the push reused whichever sorted first, retitling another commit's article in place, and the other became an orphan no cleanup path could see.

**Its base key equals its entry key**, so the article belongs to one commit and is never shared with another. That per-commit identity is deliberate: a plan or a reference is one artifact revised over time, so collapsing revisions is right, but a skill record is a **measurement of one commit's work** and two commits' measurements are different facts. A shared document could only ever report the cumulative total, which permanently disagreed with the per-commit figures every editor surface renders. Its recency field is consulted only for the single case where the same key appears on two summaries — a consolidated root carries its children's hoisted records *and* keeps the children, so one record can be met from both ends.

**Title.** `Skills used — <hash8>`, sanitized for a document title. It is deliberately the same wording as the heading of the Memory Bank's per-commit skills file: the pushed article and that file are the same document, so they must not be findable under two different names. The `hash8` is what keeps the articles apart in a flat per-branch folder — every commit contributes exactly one, so without it a branch would show indistinguishable "Skills used" siblings. **It comes from the commit hash, not from any archive key's stamp**: the two diverge after a consolidation (a record is re-anchored onto the new root while its stored file keeps its original name), and the commit a reader is holding is the one the editor surfaces title the record with. There is no host or skill-id segment; both existed only to keep one-article-per-skill titles unique, and the host now lives in the body instead.

**Body.**

1. The **token table**, rendered by the same shared renderer every other skill surface uses — so the em-dash-not-zero rule, the estimate marker, the inferred footnote and the heaviest-first ordering cannot drift between surfaces, and the pushed table stays byte-identical to the one the editor panel renders for the same commit. The invocation count is the table's own column.
2. A **skill-details list** below the table, one bullet per record: skill id, host label, plugin (when present and non-empty), and the entry paths (when any). It is ordered **by skill id**, not by weight — this list is looked up by name, and a stable order keeps a re-push from producing a spurious diff. It sits below the table because it is identity, not measurement.

**Every figure comes from the commit records; this is the one kind whose body reads no storage.** A record carries exactly that commit's increment, which is precisely what a per-commit article should report — so there is nothing to reconcile against an archived snapshot and no orphan-branch read on the push path at all. The body function is still asynchronous because the contract is.

**No markdown link.** The summary's Context section renders all skills as a single unlinked aggregate row, so there is no site in the body for a skill URL — the kind therefore declares links-in-markdown false and mints no batch placeholder. The published skill URL reaches consumers through the structured sidecar and the stored summary instead.

### Legacy per-skill article ids

An earlier shipped model published one `skill` article per (skill, commit) and recorded each id on the skill record itself. Those ids are neither ignored nor discarded: at the head of every push they are folded into the commit-level id — the newest adopted as the commit's article, the rest queued into the same orphaned-id cleanup list this push drains — so N per-skill articles become one aggregate in a single push with no leak. The rules are owned by **Legacy Skill-Article Migration**; what matters here is only that the step runs first and that its result is persisted by this push's own write-back.

The per-record fold that banks a superseded id, and the newest-child-wins hoist of the commit-level id across a consolidation, are owned by **Summary Tree Structure** and **Squash Consolidation Summary**. This push path sees only their output: an orphaned-id list that may already be populated when the push begins.

### Per-summary latest-per-name reduction

Within one summary, collapse plans that share a base name (the slug with its trailing archived-commit suffix stripped) to a single latest snapshot, preserving newest-first order. Because same-named plans share an identical server push identity (same title, branch, path, commit — the slug is not sent), the published document id is the only thing that tells the server to update rather than create. So when an older already-pushed snapshot carries a document id but the latest snapshot lacks one, the latest **inherits** that id/URL — otherwise the re-push would create a duplicate, which the server rejects.

### Cross-commit attachment ownership

Across all summaries in the push range, decide — **for every registered kind**, per that kind's base key — exactly one winner revision and which commit owns pushing it:

1. **Winner = latest revision** by the kind's recency field (compared as a string; newest wins; first-seen kept on a tie unless the kind declares a tiebreak). The dedup identity is whatever the kind's base key spec says, which is why the registered kinds differ without the algorithm differing:
   - **Plans** — base name (slug with its trailing archived-commit suffix stripped), recency = last-updated time, tiebroken on slug for determinism.
   - **Notes** — exact id (**no** archive-suffix strip, unlike the merge layer's note base key: a note id is already unique, so stripping would merge two distinct notes whose ids differ only by a trailing stamp), recency = last-updated time.
   - **References** — the **stable base identity `<source>:<nativeId>`**, *not* the per-commit archived key. So the same ticket referenced on many commits collapses to **one** Space article. Recency = referenced-at time.
   - **Skills** — the base key IS the entry key. The one kind that does **not** collapse across commits (see Skill article assembly for why a measurement is not a revision). Recency = last-used time, and it is only ever consulted for the single case where one archived key appears on two summaries: a consolidated root carries its children's hoisted records and also keeps the children, so the same record is met from both ends.

     **This pass runs over the summary's OWN items, before any aggregate.** So for the skill kind the base keys it computes are individual records' archive keys, not the commit-level aggregate key the push actually publishes under.

   The winner's owner is the commit that carries it.
2. **Seed document id propagation.** The winner should push to the *one* existing article for that plan/note/reference, so it carries a "seed" document id **plus the URL that id was minted with**:
   - The winner's own document id (and its URL) is authoritative; it is used when present.
   - A revision that *loses* (an older one) may only **fill in a missing seed** — it may **never overwrite** the winner's own id. Overwriting would push the latest content to an older article and orphan (leak) the winner's real article. The minting URL always tracks whichever revision actually supplied the id, so the downstream reuse gate can tell which backend the seed belongs to.
3. Each winner is assigned to its owner commit with its seed id/URL applied onto the reference, so an attachment recurring across commits is pushed once (as that commit's owned attachment) instead of once per commit.

The plan winner comparator is the **same** used by the per-summary reduction, so the two dedup paths never disagree on which snapshot is "latest" — a disagreement would push one slug but weave the URL against another, dropping the plan's link.

**Seed propagation reads the stored id off the ITEM, unconditionally — including for a summary-scoped kind, whose items never carry one.** The ownership pass is the one place that reads a document id directly from an item rather than through the scope-aware accessor, so a summary-scoped kind's seed map is always empty and its winners are handed to the push with no seed applied. Update-in-place still works, because the push itself reads that kind's prior id from the summary; the consequence is confined to callers that consume the seed map to pre-populate a cross-commit resolution — for a summary-scoped kind they get nothing to pre-populate.

### Summary-JSON sidecar assembly

1. Take the URL-enriched summary copy.
2. **Strip churn-only client fields** before serializing: the summary's own published document id and URL; **the commit-level skill article's id and URL**; the orphaned-document-id list; and the unresolved-orphan-hash list. The first two pairs change every push, and the last two are cleanup bookkeeping rather than commit content. The skill pair has a second reason to go: the skill article is pushed *before* the summary in the same run, so by serialization time this push's freshly-minted id/URL have already been woven onto the summary — leaving them in would put this push's own publish state into the sidecar and make the same commit's structured copy differ per backend, since the ids are per-backend. Stripping also keeps the sidecar's top-level bytes identical across re-pushes of unchanged content, so the server's upsert can no-op. (Per-item published ids nested inside the attachment lists are left intact and may still churn.)
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

### Batch-attachment assembly (a shape, not a live wire contract)

**The batch endpoint this described was removed, and nothing in the product assembles a batch today.** Its payload cap sat well above a typical gateway's body limit, and the resulting rejection was indistinguishable from an ordinary transient failure: it burned every retry and then aged out silently, so a user simply saw memories never arrive. Every push now goes one document at a time, one request group per commit. The assembler below still exists and still walks the registry, and the per-kind title / body / document-id-reuse rules it exercises are the same ones the single-document path relies on — so what follows is recorded as an **assembly shape**, not as something a server currently receives.

Assembling one commit's attachments across every kind produces three things:

- **The attachments**, in registry order, each carrying a client key `<prefix>-<index>` with the index restarting per kind, the kind's document type, its title and body, the branch-relative path, and the prior document id **only when the reuse gate permits**. Unreadable or empty bodies are skipped exactly as on the individual path.
- **A key map** from client key back to `(document type, entry key)`, for a post-push URL write-back.
- **URL placeholders** per document type, for weaving into the copy the markdown and sidecar are built from.

A placeholder is minted **only for kinds whose links-in-markdown is true**: it exists solely to mark where an attachment's final URL goes in the summary body, and the token format is a byte-for-byte lockstep contract with a server-side substituter. Minting one for a kind the body never links would send a token the server has no rule for, risking the literal token string being persisted into the stored article — strictly worse than the absent URL it would replace. A skipped item's placeholder is never minted, so the woven copy keeps whatever URL state that item already had.

Placeholders are woven **URL-only**: an attachment's document-id fields inside the structured sidecar stay numeric or absent, because a placeholder string there would break the sidecar schema. For a summary-scoped kind the URL-only weave likewise sets the summary's URL field and leaves its id field absent rather than writing the placeholder string into it.

Because the client key crosses the wire, the prefix is a **declared** property of the kind rather than its document type read out sideways — one kind pins its historical prefix for exactly this reason, and the registry rejects two kinds that would resolve to the same one.

## Notable Behavior

- **Attachments are pushed before the summary so their URLs can be woven in.** The summary body links to already-published attachment articles; reversing the order would leave dangling links. (Notable.)
- **The set of attachment kinds is data, not code.** Identity, dedup, recency and document-state field names are declared per kind and interpreted by one generic engine, so plans/notes/references are configuration of the same algorithm rather than three parallel implementations — and the editor extension consumes the same registry instead of carrying its own copy. (Notable; central.)
- **An omitted document-id/URL field name means the uniform names.** That is what lets a *new* item-scoped kind declare almost nothing while legacy kinds keep their historical per-kind field names with zero data migration. (Notable.)
- **A summary-scoped kind must override BOTH field names, and the registry throws otherwise.** The uniform defaults are the memory article's own id/URL fields, so a summary-scoped kind that inherited them would overwrite the memory's published identity with its attachment's. (Surprising; safety-relevant.)
- **The aggregate and the per-summary reduction look interchangeable and are not.** A reduction runs only on a summary's own items and is *also* applied to the rendered-markdown copy, because it states which items exist for that commit. An aggregate runs on the caller-selection branch too — the branch-push path always selects, so skipping it there would keep publishing one article per item — and is *never* applied to the rendered copy, because every underlying item still exists and folding it would delete rows from the memory itself. (Surprising; both halves have a failure mode.)
- **A reference is pushed as a standalone attachment kind (docType `reference`).** It has no on-disk working file, so its title and body are synthesized and its body is read back from the orphan-branch snapshot. (Notable.)
- **A document-type refusal short-circuits one KIND — not one item, and not the whole push.** Classifying it as a repo-wide refusal (which the same-shaped repo-allowlist refusal is) would let one missing server configuration row stop the repo publishing anything. (Surprising; safety-relevant.)
- **The batch endpoint is gone, and its assembler has no production caller.** Every push is one document at a time. The batch assembler still compiles, still walks the registry, and is still what pins the per-kind title / body / id-reuse rules the single-document path depends on — so it must be read as an assembly shape, never as a description of what a server receives. (Surprising; easy to mistake for a live path.)
- **Reference cross-commit dedup uses a different identity than plans/notes.** References dedup on the stable base identity `<source>:<nativeId>` (not the per-commit archived key), so the same ticket on many commits collapses to one Space article — yet the woven-back URL is matched by the per-commit archived key so only the entry that actually pushed gets the link. (Surprising.)
- **Skill is the one kind that publishes ONE article for many items, and the only one that does not dedup across commits.** A branch publishes exactly one skill article per commit that recorded any skill usage — not one per (skill, commit), and not one shared across the branch. The per-commit scope is deliberate: a shared document could only report cumulative totals, which permanently contradicted the per-commit figures every editor surface shows. (Surprising; two independent choices that read as one.)
- **The aggregate's identity comes from the COMMIT, never from a representative item.** Borrowing a record's archive key would make the article's identity depend on which skills the commit happened to hold, so a fold or a newly-entered skill would silently move it. (Surprising; safety-relevant.)
- **A commit-level id parked on a representative item is not a harmless shortcut.** It then travels through that kind's per-item merge rules, which inherit, displace and register-for-deletion an id under rules written for per-item articles — producing, in a real consolidation, two records holding ids from two different aggregate articles, one of which was retitled in place and the other stranded where no cleanup path could see it. The document-state scope exists to make that unrepresentable. (Surprising; safety-critical.)
- **Update-in-place hinges on carrying the prior document id.** The slug is never sent, so same-named documents are indistinguishable to the server except by the id the client supplies — the id is the sole update-vs-create signal. (Surprising; central.)
- **A stored id is only ever re-sent to the backend it was minted on.** The reuse gate compares the id's minting-URL origin against the current push's backend origin; a mismatch drops the id so the server mints a fresh document rather than overwriting a different backend's article. This is why every propagated/seed id travels with its minting URL. (Surprising; safety-relevant.)
- **A losing revision may only fill a *missing* seed, never overwrite the winner's id.** Overwriting would push the latest content to a stale article and orphan the winner's real one. (Surprising; safety-critical.)
- **The ownership pass reads a stored id off the item even for a summary-scoped kind, which never carries one — so such a kind's seed map is always empty.** It is the one place that bypasses the scope-aware accessor. Update-in-place is unaffected (the push reads that kind's id from the summary), but a caller that pre-populates a cross-commit resolution from the seed map gets nothing for it. (Surprising; a real gap with a bounded blast radius.)
- **The legacy-shape adoption runs before anything reads the summary's skill records, and is persisted by this push's own write-back.** There is no separate migration pass, so a memory that is never pushed is never migrated. (Notable.)
- **A summary that becomes a child mid-push has its freshly-published article deleted.** If a squash/amend merges the commit into another root while the summary push is on the network, force-writing it back as a root would create a zombie index entry; instead the just-published article is best-effort deleted and no write-back happens. (Surprising; race-hardening.)
- **The winner comparator is shared between the per-summary and cross-commit plan-dedup paths on purpose.** A divergence would push one snapshot while weaving the URL of another. (Notable.)
- **Recency is compared as a string, newest-first.** This is deliberate — it avoids a parse-to-number-on-malformed-date pitfall and stays deterministic. (Notable.)
- **Orphan cleanup can never fail the push.** The summary and its id are already pushed and stored before cleanup runs; a cleanup or bookkeeping failure is logged, not surfaced. Failed deletions are retried on the next push. (Notable.)
- **Unresolved orphan hashes are resolved against the live push-pending queue.** A hash whose summary since gained a document id is promoted to cleanup; a hash still in the queue is retained as in-flight; a hash in neither is discarded. If the queue can't be read, every hash is conservatively retained so a crashed worker's article can still be cleaned up later. (Notable.)
- **The sidecar is dropped silently above ~1.5 MiB.** An oversized structured sidecar must never fail the markdown push, so it is simply omitted. (Notable.)
- **Stripping churn fields from the sidecar lets an unchanged re-push no-op server-side.** The per-push document id/URL (both the memory's and the skill article's) and the cleanup bookkeeping are removed so the sidecar's top-level bytes stay identical for unchanged content. The skill pair additionally *must* go: it is minted earlier in the same run and already woven onto the summary by serialization time, so leaving it in would bake this push's own publish state — which is per-backend — into the structured copy. (Notable.)
- **Attachment content failures are best-effort; binding-required and client-outdated are fatal.** A single unreadable or transiently-failing plan/note is skipped; a binding or upgrade problem aborts the whole push so the caller can drive the binding / upgrade flow. (Notable.)

## Shared Behavior

- The on-disk summary shape and the write-back mechanics are defined by the storage specs.
- The one-way adoption of legacy per-(skill, commit) article ids that runs at the head of this push is defined by **Legacy Skill-Article Migration**.
- The per-record fold that banks a superseded skill-article id, and the accumulation rules around it, are defined by **Summary Tree Structure**; the newest-child-wins hoist of the commit-level skill-article id across a consolidation is defined by **Squash Consolidation Summary**. Both reach this path only as an already-populated orphaned-id list.
- The HTTP request/response of an individual push or delete is defined by **Summary Push to Jolli Space**.
- The top-level branch push control flow, space resolution, and result rendering are defined by **CLI Space Push / Spaces / Bind Commands**.
- The canonical repo URL and the flat per-branch relative path are defined by **Canonical Repo URL and Name Derivation**.
- Token/cost accounting on a summary is defined by the token-accounting spec.
