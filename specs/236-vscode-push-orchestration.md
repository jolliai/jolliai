# 236. VS Code Push Orchestration

## Topic Statement

The UI-agnostic pipeline that pushes one commit summary plus caller-chosen plan/note/reference attachments to a Jolli Space — weaving the published attachment URLs back into the article, riding a size-capped structured sidecar, and cleaning up orphaned docs — and, for a multi-commit subject, dedupes recurring plans/notes/references to their latest revision so each maps to exactly one Space doc. It is the single push path shared by the per-summary "Share" button, the live branch/commit share, and the Create-PR "push memories" flow, so a subject is never pushed twice into duplicate articles.

## Scope

**In scope:**

- The single-summary push primitive: attachment selection (plans, notes, **references**), per-attachment failure collection, URL weaving, the structured sidecar and its byte cap, the summary push, and orphan-doc cleanup.
- Strict vs. best-effort attachment handling and why they differ by caller — including the special case that **reference** pushes are always best-effort even under strict mode.
- The doc-id reuse gate: a stored server-minted doc id is reused as an update target only when it was minted against the same backend origin as the current push.
- Server-preferred published-article URL resolution (prefer the server-returned url; fall back to the `?doc=` alias only when absent).
- The binding-required resolution: resolve via an injected callback and retry exactly once.
- Cross-commit dedup: latest revision per plan slug / note id across the subject, seed doc ids, and single-owner assignment.
- Building the live content reference (covered branch collection / commit-doc list) from the dedup output.
- The whole-branch "push memories as plain articles, no share link" path and its branch-mismatch guard.
- Per-(workspace, subject) serialization of overlapping push passes.
- The shared binding-resolver callback wiring (routed through by two of the three push call sites; the third hand-duplicates it).

**Out of scope (boundaries):**

- The single-document push/delete RPC (endpoint, headers, body, status mapping) — see **Summary Push to Jolli Space** (94).
- The `412`/binding-required flow internals and the chooser UI — see **Binding Required Flow** (95) and **VS Code Binding Chooser Webview** (117).
- The manual Share/Update button UI and its toasts/re-renders — see **VS Code Summary Webview Panel** (109).
- The share record shapes and persistence — see **Branch Share Store** (233).
- The Share popover state machine (lazy mint, tier flips, reconcile trigger) — see **VS Code Live Branch Share** (234).
- The Create-PR trigger, its panel, and its toasts — see **PR Creation and Update** (99); referenced only.
- A CLI-core port of the branch-memories push loop exists (231) — parity only, not re-authored here.

## Data Contracts

### Single-summary push result

Pushing one summary returns UI-renderable data only (no VS Code calls): the pushed doc ids (summary doc id + URL, and per-plan/per-note/per-reference `{ slug/id/key, title, doc id, url }`; a pushed reference additionally carries its stable cross-commit `<source>:<nativeId>` key so `covered` can resolve the shared article), the summary after URL-rewrite + persist + orphan-cleanup (the caller adopts this as current), the collected per-attachment failures (**plans + notes only** — reference failures are excluded, see below), whether it was an update (the summary already had an article URL) vs. a first push, and the count of attachments successfully pushed (**plans + notes + references**).

**Published article URL resolution.** Each published article URL is resolved from the push response, not hard-coded: prefer the server-returned `url` field — an absolute `http(s)://…` value is used verbatim; a relative value is prefixed with the display base (with exactly one `/` join). Only when the server returned **no** url does the client fall back to the `<base>/articles?doc=<docId>` alias. This applies uniformly to the summary doc and every plan/note/reference doc, so the stored/displayed URL matches the web app's canonical article path when the server provides one.

### Attachment selection

The caller either passes an explicit `{ plans, notes, references? }` set (the live share dedupes branch-wide and hands each summary only its owned attachments, with doc ids already resolved so the push updates the one Space doc in place), or omits it — in which case the summary's own attachments are used: plans collapsed to the latest snapshot per name, plus all notes, plus all of the summary's references. This is the standalone button's behavior. The `references` list is optional in the explicit form; omitting it pushes no references for that summary.

A **reference** attachment models an external ticket/page/thread captured on the commit. Its article body has no on-disk file: it is synthesized from the reference's captured value snapshot (reading the archived body from the orphan-branch snapshot when present, else a header-only body), pushed with `docType: "reference"`.

### Structured sidecar

A structured twin of the markdown article rides on the summary push so the share page can render it directly instead of regex-parsing the markdown. It is the enriched summary (attachment URLs woven in) **minus** the client push-state fields (the churning doc id/url and the orphan-cleanup bookkeeping), so a re-push of unchanged content is byte-identical and the server upsert can no-op. It is **byte-capped at ~1.5 MiB**; above that it is dropped (with a warning) and only the markdown is pushed — the markdown push must never fail on account of the sidecar.

### Doc-type discriminator

Every pushed document carries a `docType` discriminator with **four** values: `summary`, `plan`, `note`, `reference`. Under the flat per-branch storage layout this is the sole disambiguator the server uses to tag and route the doc.

### Doc-id reuse gate (per-document, env-keyed)

A stored server-minted numeric document id (for a summary, plan, note, or reference) is sent to the backend as an **update target** on a re-push **only when the id was minted against the same backend origin as the current push**. The decision compares two "env keys":

- the env key of the **current push** — the lowercased URL **origin** (scheme + host + port) of the resolved base URL, and
- the env key **recovered from the stored document's URL** — the origin of the article URL the id was minted with.

When they match, the stored id is sent so the one existing article updates in place. On a mismatch, the stored id (and its URL) are **dropped** so the backend mints a **fresh** document instead of overwriting a different backend's article — e.g. a `jolli-local.me` id must never update a `jolli.ai` doc. A **missing** stored URL is treated as legacy / never-pushed (reuse allowed); an **unparseable** one is treated as env-agnostic (reuse allowed) rather than throwing.

For this to work, **every propagated / seed doc id travels together with its minting URL** — the id alone is insufficient because the URL's origin *is* the env the gate tests. The env key is origin-only (deliberately not org/tenant): id namespaces are per-backend, and the server re-validates space/repo/owner on every push, so this gate is a cleanliness optimization (avoid a doomed cross-backend overwrite), never the correctness guard. This is the per-document, tenant-precise sibling of the branch-share store's backend-scoping (233), which is coarser (registrable-domain) because a share URL is tenant-free.

### Binding outcome

The injected binding callback reports one of: bound, another-chooser-already-open, cancelled, or failed. The orchestrator raises a typed binding error carrying that outcome so the caller can choose messaging.

### Live content reference (built here, stored by 233)

- **Commit subject** → a commit-doc list: the pushed summary doc ids + the flat set of attachment doc ids the single commit references (plans, notes, **and references** all fold into this one attachment-id set).
- **Branch subject** → a branch collection: a branch relative-path identity + a `covered` list of `{ commit hash, summary doc id, attachment doc ids }`, one per commit in `base..HEAD`. Each commit's attachment-id set is resolved from the branch-wide maps for plans (by base slug), notes (by id), and references (by the stable `<source>:<nativeId>` key), so a doc pushed under one commit is still linkable from another commit that references it.

## Behavior

### Push one summary + attachments

1. Determine the plans/notes/references to push (caller-chosen, or the summary's own latest-per-name plans + all notes + all references).
2. **Push plans, then notes, then references.** Read each body: a plan by slug, a note by id (a snippet note carries its body inline), a reference from its orphan-branch snapshot (else a header-only body). For each attachment, the stored doc id is sent as an update target **only when the doc-id reuse gate passes** (its minting URL's origin matches the current push env — see the gate contract above); otherwise it is omitted so the server mints a fresh doc.
   - **Plans and notes:** an empty/unreadable body is skipped; in **strict** mode it is recorded as a per-attachment failure instead. A single transient push failure is **collected, not thrown**. Fatal binding-required / plugin-outdated errors propagate.
   - **References are always best-effort, even under strict mode.** A reference's transient push failure is **logged and skipped**, and is deliberately **not** added to the per-attachment failures list — so the strict live-share path (which turns that list into a fatal abort) can never be aborted by one bad reference. (Fatal binding-required / plugin-outdated errors still propagate.) Rationale: references are auto-extracted context, not user-attached content, and the CLI push path likewise just logs+skips a rejected reference, so keeping them non-fatal keeps the two paths in step (e.g. against a backend that doesn't yet accept `docType: "reference"`).
   - Each successful push yields the doc's URL + id (resolved via the server-preferred URL resolution above).
3. **Weave** the published attachment URLs into the summary's markdown (so the article's Plans & Notes list, and its references, link the published docs), deduping same-named plan snapshots (only the latest was uploaded). Notes are matched by id, plans by exact slug, references by their per-commit archived key.
4. Serialize the structured sidecar from that enriched copy (capped/dropped per the contract above).
5. **Push the summary doc** (its stored doc id sent only when the reuse gate passes).
6. Persist the new article URL + doc id (and the woven attachment URLs/ids) onto the summary locally.
7. **Clean up orphaned docs** best-effort: delete each previously-recorded orphan id concurrently; clear only the ids that actually deleted from the summary's orphan list, keep the failed ones for the next push to retry. A cleanup or bookkeeping failure is logged and **never** surfaces as a failed push (the summary is already pushed and stored).

The successfully-pushed **attachment count** is the sum of pushed plans + notes + references.

### Binding-required retry

If the summary push fails with binding-required and this attempt was not already a retry, invoke the injected binding callback for the repo URL. On a "bound" outcome, retry the **entire** push **exactly once** (a second binding-required would then propagate rather than loop). On any other outcome, raise the typed binding error with that outcome. Any non-binding error propagates unchanged.

### Cross-commit dedup (multi-commit subject)

Across the subject's summaries (processed oldest→newest so the newest content wins):

- Pick the **winner revision per plan base-slug, per note id, and per reference `<source>:<nativeId>` key**:
  - Plans: latest by update timestamp, with a slug tiebreak (string compare, so a malformed timestamp can't poison the ordering). The same comparator is used wherever "latest snapshot" is decided, so the dedup paths can't disagree on which snapshot is latest (a disagreement would push one slug but weave the URL against the other, dropping the link).
  - Notes: latest by update timestamp (string compare; first-seen kept on a tie).
  - References: latest by the reference's **referenced-at** timestamp (string compare; first-seen kept on a tie). A reference is identified across commits by its **stable `<source>:<nativeId>`**, not its per-commit archived key, so the same ticket appearing on two commits pushes to **one** Space article.
- Remember each winner's **owner commit** and any **seed doc id together with the URL it was minted with** — a doc id surfaced by *any* commit's prior push, so the push updates the one existing Space doc in place, and the paired URL lets the reuse gate decide whether that id is on the current backend (and lets the woven URL match the id). A **losing (older) revision only fills a seed doc id (and its URL) the winner lacked**; it never overwrites the winner's own doc id (doing so would push the latest content to an older article and orphan the winner's real one).
- Assign each winner to **exactly one** owner commit, so the doc uploads once even though many commits reference it.

This dedup is **shared identically** by the live-share push and the Create-PR branch push.

### Push loop + covered construction

Push each summary oldest→newest with only its owned attachments (strict mode on for live share). Accumulate branch-wide maps of attachment doc ids — one per attachment kind (plans by base slug, notes by id, references by `<source>:<nativeId>`) — each pre-seeded with the known seed ids, so a doc pushed "under" one commit is still resolvable from another commit that references it. Then build the covered reference: each commit's attachment doc ids are resolved from those shared maps and folded into one flat id set (so a plan/note/reference pushed under a different commit is still linked). For live share, a **plan/note** attachment failure anywhere aborts with a typed error — the share page must not point at stale seeded doc ids. A reference failure does **not** abort (references are best-effort even here), so one reference the backend rejects can't sink an otherwise-strict share.

### Whole-branch push, no share link

A separate path pushes **all** of a branch's memories (`base..HEAD`) to the bound Space **as plain articles, creating no share link**, reusing the same cross-commit dedup (plans, notes, and references). It is **best-effort** (non-strict): an unreadable plan/note is collected, not thrown; a reference push failure is logged and skipped (never collected — same as the leaf); and a single summary's own push failure (transient network / 5xx) is collected as a summary failure so an early success is not discarded by a later failure. A **wrapped** binding error (a *first* binding-required whose injected resolver could not satisfy it) and a plugin-outdated error propagate and abort the whole batch — they would fail every remaining summary too. **A raw *second* binding-required is a different case:** when the leaf's exactly-once retry is exhausted the leaf re-raises the original (unwrapped) binding-required, and this path does **not** recognize that unwrapped form as fatal — it is demoted to a collected per-summary failure and the batch keeps pushing later commits. (Surprising; a real gap — the double-binding case aborts on the single-summary leaf but not here.) It throws "nothing to share" when the branch has no summaries. Result: pushed count, attachment count, attachment failures, summary failures.

**Branch-mismatch guard:** this path reads the *current* HEAD's `base..HEAD`, and it runs asynchronously after PR creation, so HEAD may have moved off the requested branch. It re-checks the current branch just before loading and aborts loudly if it differs, so another branch's memories are never published under the requested branch's identity.

### Per-subject serialization

All generate / reconcile / whole-branch passes for one `(workspace, branch)` subject run through a single in-flight guard. Overlapping passes must not interleave: the covered list is replaced wholesale by a PATCH, so a slower pass computed from an older `base..HEAD` could otherwise clobber a newer covered list (lost update).

### Shared binding-resolver callback

A shared wiring opens the binding chooser for a repo URL and maps its outcome to the `{ status }` shape this pipeline expects: selected → bound, another-open → another-open, anything else → cancelled (the chooser never yields "failed" — the push layer raises that itself). This shared copy is injected at **two** of the three push call sites — the per-summary panel push and the Create-PR push. The **third** call site, the share-context mint, does **not** route through it: it hand-duplicates the same chooser-open + outcome-mapping logic inline, so a change to the chooser arguments or a new outcome kind must in fact be made in two places, not one. (Surprising; the "made once" intent is only partly realized.)

## State Transitions

The single-summary push is a leaf operation: it either returns a result, raises a fatal binding/plugin error (which the caller routes to the chooser / outdated flow), or — for binding-required on the first attempt — resolves a binding and retries once. Multi-commit pushes iterate this leaf oldest→newest, aborting on the first fatal error (and, for the whole-branch path, collecting non-fatal per-summary failures).

## Notable Behavior

- **One push path, never two.** The per-summary button, the live share, and the Create-PR push all funnel through the same primitive, so a subject is never pushed twice into duplicate articles with desynced doc ids. (Notable.)
- **Per-attachment failures are collected, not thrown.** A single bad plan/note doesn't abort the remaining attachments or the summary; only fatal binding/plugin errors abort. (Notable.)
- **References are always best-effort — even under strict mode.** A reference push failure is logged and skipped and never joins the per-attachment failures list, so the strict live-share path (which fatally aborts on that list) can never be sunk by one reference the backend rejects. References are auto-extracted context, not user-attached content, and the CLI push path likewise logs+skips, keeping the two in step. (Surprising; intentional.)
- **A stored doc id is only reused on the backend that minted it.** The reuse gate compares the current push's URL origin against the origin recovered from the stored doc's URL; a mismatch drops the stored id so the server mints a fresh doc rather than overwriting a different backend's article. Every seed/propagated id therefore travels with its minting URL. It's a cleanliness optimization, not a correctness guard — the server re-validates space/repo/owner regardless. (Notable.)
- **Published article URLs are server-preferred, not hard-coded.** The client uses the server-returned url (absolute verbatim; relative prefixed with the display base) and only falls back to the `?doc=<id>` alias when the server returned none — so stored/displayed URLs match the web app's canonical article path. (Notable.)
- **Strict vs. best-effort attachments differ by caller.** The manual push silently skips an unreadable attachment; the live share treats it as a hard failure so the share page can't point at a stale seeded doc id. (Surprising; intentional.)
- **The sidecar is optional and capped.** Above ~1.5 MiB it is dropped and only markdown is pushed — the article push must never fail because the structured twin was too big. Stripping churning fields also keeps an unchanged re-push byte-identical so the server upsert no-ops. (Notable.)
- **A losing revision only fills a missing doc id — never overwrites the winner's.** Overwriting would push the newest content to an older article and leak the winner's real doc. (Surprising; intentional.)
- **Orphan cleanup is best-effort and self-healing.** Only successfully-deleted ids are cleared; failed ones are retried on the next push, and a cleanup failure never fails the push. (Notable.)
- **Binding-required retries exactly once.** A second binding-required after a successful bind indicates a server bug and is propagated, not looped. On the single-summary leaf the re-raised error is fatal and aborts; on the whole-branch path that same unwrapped error is instead demoted to a collected per-summary failure, so the batch continues. (Surprising; intentional-looking gap.)
- **The whole-branch push guards against a moved HEAD.** Because it runs after PR creation, it re-verifies the branch just before loading and aborts rather than publish the wrong branch's memories under this branch's identity. (Surprising; intentional.)
- **Overlapping passes for one subject are serialized.** The covered list is a wholesale-replace PATCH, so a stale slower pass must not clobber a newer one. (Notable.)

## Shared Behavior

- **Single-document push/delete RPC** — endpoint, headers, body, and status mapping are **Summary Push to Jolli Space** (94); this pipeline is the multi-doc orchestration on top of it.
- **Binding-required flow and chooser** — **Binding Required Flow** (95) and **VS Code Binding Chooser Webview** (117); injected here as a callback.
- **Plugin-outdated** — a fatal error that propagates unchanged; mapping owned by **Plugin Outdated Flow** (96).
- **Live-share record shapes** the covered reference is stored into — **Branch Share Store** (233); the mint/reconcile triggers are **VS Code Live Branch Share** (234).
- **Manual Share/Update button UI** and the Create-PR trigger/toasts — **VS Code Summary Webview Panel** (109) and **PR Creation and Update** (99).
- **CLI-core parity** — a CLI-core port of the branch-memories push loop exists (231); the dedup and push semantics are meant to match.
