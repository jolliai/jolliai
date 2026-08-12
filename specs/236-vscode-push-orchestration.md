# 236. VS Code Push Orchestration

## Topic Statement

The UI-agnostic pipeline that pushes one commit summary plus caller-chosen context attachments to a Jolli Space — weaving the published attachment URLs back into the article, riding a size-capped structured sidecar, and cleaning up orphaned docs — and, for a multi-commit subject, dedupes recurring attachments to their latest revision so each maps to exactly one Space doc. It is the single push path shared by the per-summary "Share" button, the live branch/commit share, and the Create-PR "push memories" flow, so a subject is never pushed twice into duplicate articles.

**Which kinds of attachment exist is data, not code.** This pipeline names no attachment kind anywhere in its push loop: it iterates the shared context-kind registry, reads each kind's identity, body, title, document-state and failure policy off that kind's definition, and pushes with this surface's own HTTP stack. A kind registered in that table rides this pipeline with no change here.

## Scope

**In scope:**

- The single-summary push primitive: kind-agnostic attachment selection, the generic per-kind push loop, per-attachment failure collection, URL weaving, the structured sidecar and its byte cap, the summary push, and orphan-doc cleanup.
- Strict vs. best-effort attachment handling, why they differ by caller, and the fact that "best-effort" is read off the **kind's own definition** rather than hard-coded here.
- The **skipped-attachment channel**: a second, non-fatal report separate from the failure list, and the rule that it is populated per KIND rather than per item.
- The document-type refusal, which short-circuits one kind for the rest of that summary's push.
- Where a published id is written back — onto the matching item, or onto the memory for a kind that publishes one article per commit.
- The per-commit aggregate collapse, and why it runs on a branch of the selection logic the per-summary reduction is skipped on.
- The doc-id reuse gate: a stored server-minted doc id is reused as an update target only when it was minted against the same backend origin as the current push.
- Server-preferred published-article URL resolution (prefer the server-returned url; fall back to the `?doc=` alias only when absent).
- The binding-required resolution: resolve via an injected callback and retry exactly once.
- Cross-commit dedup: latest revision per kind's declared cross-commit identity across the subject, seed doc ids, and single-owner assignment.
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
- What each registered kind *is* (its identity fields, its body source, its title, its aggregate) — owned by **Jolli Space Push Article Assembly** (231), which defines the registry this pipeline iterates.
- Converting a previously-shipped model's per-item article identifiers into the commit-level one, which runs as this pipeline's first step — owned by **Legacy Skill-Article Migration** (343).

## Data Contracts

### Single-summary push result

Pushing one summary returns UI-renderable data only (no VS Code calls):

- The **summary doc id + URL**.
- The **published attachments, keyed by document type** — the kind-agnostic record every new consumer reads. Each published attachment carries its per-commit entry key, its **cross-commit base key** (so a covered-list builder can resolve the shared article), its title, doc id and URL.
- **Legacy named views** of that same map (plans / notes / references), each projecting the entry key onto that kind's historical field name. Kept for existing consumers and deliberately not extended for a new kind.
- The summary after URL-rewrite + persist + orphan-cleanup (the caller adopts this as current).
- The collected per-attachment **failures** — user-attached kinds only.
- The **skipped attachments** — a separate list, see below.
- Whether it was an update (the summary already had an article URL) vs. a first push.
- The count of attachments successfully pushed, summed **across every kind**.

**Published article URL resolution.** Each published article URL is resolved from the push response, not hard-coded: prefer the server-returned `url` field — an absolute `http(s)://…` value is used verbatim; a relative value is prefixed with the display base (with exactly one `/` join). Only when the server returned **no** url does the client fall back to the `<base>/articles?doc=<docId>` alias. This applies uniformly to the summary doc and every attachment doc, so the stored/displayed URL matches the web app's canonical article path when the server provides one.

### Where a published id is written back

Each kind declares whether its article belongs to an **item** or to the **commit**:

- **Item-scoped** (the usual case) — the id and URL are written onto the summary array entry whose per-commit identity matches the published article, so an item recurring across commits only updates the entry that actually pushed. The field names are the kind's own; a kind that declares none takes the uniform pair.
- **Commit-scoped** — the article covers the whole commit, so there is no entry to match and the id/URL are written onto the **memory itself**, under names the kind must declare explicitly. Inheriting the uniform names there would overwrite the memory article's own published identity, so the registry refuses to load a commit-scoped kind that omits either name.

The same scope decides where a *prior* push's id is read from when the reuse gate below is evaluated.

### Attachment selection

The selection is a **map keyed by document type**, not a fixed set of named fields, and it is **tri-state**:

- **No selection at all** → push the summary's own items for every kind, each passed through that kind's per-summary reduction when it declares one (only the plan kind does, collapsing same-named archived snapshots to the latest).
- **A selection present, with an array for a kind** → push exactly those items.
- **A selection present, with no entry for a kind** → push **none** of that kind. Never "fall back to the summary's own", which would either silently publish nothing or publish an un-deduped duplicate set.

The live share and the whole-branch push always supply a selection, built from the cross-commit dedup below with doc ids already resolved so each push updates the one Space doc in place. The standalone button supplies none.

A caller may still pass the frozen legacy named shape naming only the three kinds that predate the registry. **No shipped call site does** — every production caller either supplies the map form or supplies nothing — so this is a compatibility path, not the live contract. When it is used it is normalized by **walking the registry**: every registered kind gets an explicit entry, taking the caller's array for the three legacy names and an explicit empty array for every other kind. That expansion must not be re-implemented per surface: a named selection is a *complete* answer ("push none of every kind I did not name"), so an outdated per-surface list is silent, and that is exactly how the branch-share path came to skip a registered kind. The expansion also refuses to run if one of the three legacy names no longer matches a registered kind — a rename would otherwise leave the adapter emitting a key nothing matches, silently pushing none of that kind through every legacy caller, with nothing type-checking it. The reverse direction is deliberately *not* an error: a kind the named shape cannot express expands to "push none", which is the only safe default.

Then, on **either** branch, a kind that declares an aggregate applies it to the selected items — collapsing what one commit will publish (today: a commit's whole skill set into one article). The aggregate runs even on the selection branch, because the branch-share path always selects.

### Structured sidecar

A structured twin of the markdown article rides on the summary push so the share page can render it directly instead of regex-parsing the markdown. It is the enriched summary (attachment URLs woven in) **minus** the client push-state fields: the memory article's own churning doc id/url, **the commit-level skill article's id/url** (minted earlier in the same run and already woven onto the summary by serialization time), and the orphan-cleanup bookkeeping — so a re-push of unchanged content is byte-identical and the server upsert can no-op. It is **byte-capped at ~1.5 MiB**; above that it is dropped (with a warning) and only the markdown is pushed — the markdown push must never fail on account of the sidecar.

**The strip list here is one field shorter than the CLI's twin:** this surface does not strip the unresolved-orphan-hash bookkeeping, so a consolidated memory that carries one publishes it inside the sidecar. (Notable; a real divergence between the two implementations of the same sidecar.)

### Doc-type discriminator

Every pushed document carries a `docType` discriminator: `summary` for the memory itself, and each registered context kind's own tag for an attachment. Under the flat per-branch storage layout this is the sole disambiguator the server uses to tag and route the doc, and the set of accepted values is the server's configuration rather than anything fixed here.

### Doc-id reuse gate (per-document, env-keyed)

A stored server-minted numeric document id (for the memory itself or for any attachment) is sent to the backend as an **update target** on a re-push **only when the id was minted against the same backend origin as the current push**. The decision compares two "env keys":

- the env key of the **current push** — the lowercased URL **origin** (scheme + host + port) of the resolved base URL, and
- the env key **recovered from the stored document's URL** — the origin of the article URL the id was minted with.

When they match, the stored id is sent so the one existing article updates in place. On a mismatch, the stored id (and its URL) are **dropped** so the backend mints a **fresh** document instead of overwriting a different backend's article — e.g. a `jolli-local.me` id must never update a `jolli.ai` doc. A **missing** stored URL is treated as legacy / never-pushed (reuse allowed); an **unparseable** one is treated as env-agnostic (reuse allowed) rather than throwing.

For this to work, **every propagated / seed doc id travels together with its minting URL** — the id alone is insufficient because the URL's origin *is* the env the gate tests. The env key is origin-only (deliberately not org/tenant): id namespaces are per-backend, and the server re-validates space/repo/owner on every push, so this gate is a cleanliness optimization (avoid a doomed cross-backend overwrite), never the correctness guard. This is the per-document, tenant-precise sibling of the branch-share store's backend-scoping (233), which is coarser (registrable-domain) because a share URL is tenant-free.

### Binding outcome

The injected binding callback reports one of: bound, another-chooser-already-open, cancelled, or failed. The orchestrator raises a typed binding error carrying that outcome so the caller can choose messaging.

### Live content reference (built here, stored by 233)

- **Commit subject** → a commit-doc list: the pushed summary doc ids + one flat set of attachment doc ids resolved for the single commit.
- **Branch subject** → a branch collection: a branch relative-path identity + a `covered` list of `{ commit hash, summary doc id, attachment doc ids }`, one per commit in `base..HEAD`.

Either way, a commit's attachment-id set is resolved **per registered kind**, with no kind named: for each kind, every item that commit's own stored array holds is looked up — by that kind's **cross-commit** identity — in a branch-wide map accumulated across the whole push loop and pre-seeded with the ids the dedup already knew. So a doc pushed "under" one commit is still linkable from another commit that references it.

**A kind whose published article is identified differently from its stored items contributes nothing to this set.** The lookup key comes from the commit's stored items; the map key comes from the published article. Those are the same string for every item-scoped kind — but not for a kind that publishes one aggregate article per commit: the article is keyed by a commit-level identity minted for the aggregate, while the summary stores the individual items under their own identities, so the lookup can never hit and that kind's doc id never enters the covered set. (Surprising; see 234, which owns the consequence.)

## Behavior

### Push one summary + attachments

1. **Migrate legacy per-item article identifiers** on the memory into the commit-level aggregate one, before anything else reads them (owned by 343). Idempotent, so the binding-required re-entry below costs nothing.
2. Refuse at the **entry gate** below if this repo's outbound push is opted out.
3. Resolve the display base and the env key of the backend this push targets, and normalize the caller's selection into the map form.
4. **Push attachments, one registered kind at a time, in registry order** — and for each kind, one item at a time in the order the selection lists them. Per item:
   - Derive its per-commit identity, its title and its body from the kind's own definition. The body is read from wherever that kind says: an orphan-branch snapshot, the item's own inline content, a synthesis from the item's fields, or a mix.
   - A body that is absent or empty means **skip**. For a **best-effort** kind this is unremarkable and only logged; for a user-attached kind it is logged as notable, and under **strict** mode it is additionally recorded as a per-attachment failure.
   - The stored doc id — read from the item or from the memory, per the kind's document scope — is sent as an update target **only when the doc-id reuse gate passes**; otherwise it is omitted so the server mints a fresh doc.
   - Each successful push yields the doc's URL + id (resolved via the server-preferred URL resolution above), recorded under the kind's document type with the item's per-commit and cross-commit identities.
5. **Failure classification during that loop** — three tiers, and which one a failure lands in is read off the kind's own definition, never hard-coded:
   - **Fatal** (see "The fatal set" below) → propagate immediately, aborting the whole push.
   - **The server refuses this document type** → **short-circuit the kind**: stop pushing items of that kind for the rest of this summary and record one skipped entry naming the type. Every remaining item of that kind would fail identically, so this replaces a dozen identical errors with one actionable line. Other kinds carry on.
   - **Anything else** → for a **best-effort** kind, log it and accumulate it privately; for a user-attached kind, add it to the per-attachment failures list. A best-effort failure is deliberately kept **out** of that list, because the strict live-share path turns the list into a fatal abort and a kind the user never attached must not be able to sink a share.
6. **Report what was skipped, per kind rather than per item.** After each kind's loop, at most two entries are emitted into the skipped channel: one for a refused document type, and — when any best-effort items failed — one carrying that kind's failure **count** and the **first** reason. The log keeps every title; the reported entry does not, because callers render it verbatim into a notification. "Best effort" means *does not abort the push*, not *is hidden from the user*.
7. **Weave** the published URLs into the summary's markdown, first applying each kind's per-summary reduction to the rendered copy so the body lists exactly the set that was uploaded. Item-scoped kinds match by per-commit identity; a commit-scoped kind's id/URL go onto the memory itself.
8. Serialize the structured sidecar from that enriched copy (capped/dropped per the contract above), then **push the summary doc** (its stored doc id sent only when the reuse gate passes), then persist the new article URL + doc id — plus the woven attachment ids/URLs, written onto the summary's **own** unreduced items so an unpushed same-named snapshot keeps its place in stored history.
9. **Clean up orphaned docs** best-effort: delete each previously-recorded orphan id concurrently; clear only the ids that actually deleted from the summary's orphan list, keep the failed ones for the next push to retry. A cleanup or bookkeeping failure is logged and **never** surfaces as a failed push (the summary is already pushed and stored).

The successfully-pushed **attachment count** is summed across every kind.

### Entry gate: the repo's outbound opt-out

Before any attachment is read or pushed, the orchestrator fails fast on the per-repo outbound-push opt-out (spec 310) and raises the push-disabled refusal. Checking here — and not only inside each HTTP call — is what stops a doomed per-attachment push from being issued and then mislabelled as an attachment failure. The HTTP client still re-checks per call, both as defense-in-depth for non-orchestrator callers and because spec 310 requires the flag be read **live**, so a push of N attachments performs 1 + N reads and a mid-push opt-out takes effect immediately.

### The fatal set (abort the loop, don't collect)

The fatal predicate is the shared repo-wide-refusal membership (spec **327**) — an outdated client, an outdated plugin, this repo's outbound opt-out, and a server permission/allowlist refusal — **plus** binding-required, which is fatal *here* because the orchestrator cannot run the binding chooser itself and so must propagate to the caller that can.

There is now exactly **one** attachment loop, so the predicate cannot drift between kinds by construction; it used to be applied at one loop per kind. Membership comes from the shared module rather than a local type-check chain precisely so a new repo-wide type is added once and every classifier picks it up — and it comes from a module no test stubs, so a partial mock cannot turn the predicate into an undefined value.

### Binding-required retry

If the summary push fails with binding-required and this attempt was not already a retry, invoke the injected binding callback for the repo URL. On a "bound" outcome, retry the **entire** push **exactly once** (a second binding-required would then propagate rather than loop). On any other outcome, raise the typed binding error with that outcome. Any non-binding error propagates unchanged.

### Cross-commit dedup (multi-commit subject)

Runs once over every registered kind, naming none. Across the subject's summaries (processed oldest→newest so the newest content wins):

- Pick the **winner revision per cross-commit identity**, where both the identity and the recency field are declared by the kind. Recency is compared **as a string**, deliberately — that avoids a malformed timestamp poisoning the ordering, and an item missing the field reads as the empty string and therefore loses. First-seen is kept on a tie unless the kind supplies a deterministic tiebreak; the plan kind does, on slug, and it is the *same* comparator used wherever "latest snapshot" is decided, so the dedup paths cannot disagree about which snapshot is latest (a disagreement would push one snapshot but weave the URL against another, dropping the link).
- A kind's cross-commit identity is joined from declared item fields and may optionally have a trailing archive stamp stripped. That is what makes the same external ticket referenced on two commits push to **one** article, while its per-commit identity still decides which commit entry receives the woven URL. It also means a kind whose cross-commit identity **equals** its per-commit identity never dedupes across commits at all — which is exactly what a per-commit measurement wants, since two commits' measurements are different facts rather than revisions of one artifact.
- Remember each winner's **owner commit** and any **seed doc id together with the URL it was minted with** — a doc id surfaced by *any* commit's prior push, so the push updates the one existing doc in place, and the paired URL lets the reuse gate decide whether that id is on the current backend (and lets the woven URL match the id). A **losing (older) revision only fills a seed doc id (and its URL) the winner lacked**; it never overwrites the winner's own doc id (doing so would push the latest content to an older article and orphan the winner's real one).
- Assign each winner to **exactly one** owner commit, so the doc uploads once even though many commits reference it.

**A commit-scoped kind can never produce a seed here.** This step reads a candidate doc id off the *item*, using the kind's declared field name — but for a commit-scoped kind that name addresses a field of the memory, which the item does not carry. So the lookup always comes back empty, no seed is propagated, and the first push of that kind in a run is always evaluated against whatever the memory itself stored. (Notable; harmless, because the per-item read is redundant for such a kind — the push path reads its stored id off the memory anyway — but it does mean the seed map is silently always empty for it.)

This dedup is **shared identically** by the live-share push and the Create-PR branch push, and its per-commit output is the selection map handed to the leaf.

### Push loop + covered construction

Push each summary oldest→newest with only its owned attachments (strict mode on for live share). Accumulate one branch-wide map of attachment doc ids **per registered kind**, keyed by that kind's cross-commit identity and pre-seeded with the known seed ids, so a doc pushed "under" one commit is still resolvable from another commit that references it. Only the kind-agnostic published-attachment record is read when filling those maps — deliberately, even though the result still carries the legacy named views. Then build the covered reference as described above.

For live share, a **user-attached** failure anywhere aborts with a typed error — the share page must not point at stale seeded doc ids. A **best-effort** kind's failure does not abort even here, so one item the backend rejects can't sink an otherwise-strict share.

**Best-effort skips are logged once for the whole subject and never surfaced from this path.** The per-summary skipped entries are accumulated and written out as one aggregated line at the end of the loop, but no channel carries them to the user. That is a deliberate split from the whole-branch push, which does report them: this path is re-entered on **every** share-modal open as a background reconcile, so a notification would fire unprompted and repeatedly, and the only value this path returns to its interactive caller is the server's own share response — not a place for client-side diagnostics. (Surprising; intentional asymmetry.)

The **whole-branch share loop** applies its own stop test at the *summary* level: the shared repo-wide refusal set, plus the typed binding error. Every summary in the loop belongs to the same repo, so a repo-wide refusal — outdated plugin, this repo's push opt-out, the server's allowlist/ownership verdict — fails all of them; collecting them would report one condition as "Shared 0 memories, but N failed" *and* keep firing doomed requests for every remaining commit. The binding error is added because by then the chooser has already run without producing a binding. Everything else (network / HTTP 5xx) is recorded per-summary so earlier successes are not discarded.

### Whole-branch push, no share link

A separate path pushes **all** of a branch's memories (`base..HEAD`) to the bound Space **as plain articles, creating no share link**, reusing the same cross-commit dedup over every registered kind. It is **best-effort** (non-strict): an unreadable user-attached body is collected, not thrown; a best-effort kind's push failure is logged and skipped (never collected — same as the leaf); and a single summary's own push failure (transient network / 5xx) is collected as a summary failure so an early success is not discarded by a later failure. A **wrapped** binding error (a *first* binding-required whose injected resolver could not satisfy it) and a plugin-outdated error propagate and abort the whole batch — they would fail every remaining summary too. **A raw *second* binding-required is a different case:** when the leaf's exactly-once retry is exhausted the leaf re-raises the original (unwrapped) binding-required, and this path does **not** recognize that unwrapped form as fatal — it is demoted to a collected per-summary failure and the batch keeps pushing later commits. (Surprising; a real gap — the double-binding case aborts on the single-summary leaf but not here.) It throws "nothing to share" when the branch has no summaries.

Result: pushed count, attachment count, attachment failures, summary failures, **and the skipped attachments** — the per-kind entries the leaf produced, forwarded rather than dropped, on the reasoning that this is a button the user pressed and returning plain success while publishing fewer articles than the branch has context for misstates what happened. They are kept out of the failure list, which must never turn this push into a failure.

**Branch-mismatch guard:** this path reads the *current* HEAD's `base..HEAD`, and it runs asynchronously after PR creation, so HEAD may have moved off the requested branch. It re-checks the current branch just before loading and aborts loudly if it differs, so another branch's memories are never published under the requested branch's identity.

### Per-subject serialization

All generate / reconcile / whole-branch passes for one `(workspace, branch)` subject run through a single in-flight guard. Overlapping passes must not interleave: the covered list is replaced wholesale by a PATCH, so a slower pass computed from an older `base..HEAD` could otherwise clobber a newer covered list (lost update).

### Shared binding-resolver callback

A shared wiring opens the binding chooser for a repo URL and maps its outcome to the `{ status }` shape this pipeline expects: selected → bound, another-open → another-open, anything else → cancelled (the chooser never yields "failed" — the push layer raises that itself). This shared copy is injected at **two** of the three push call sites — the per-summary panel push and the Create-PR push. The **third** call site, the share-context mint, does **not** route through it: it hand-duplicates the same chooser-open + outcome-mapping logic inline, so a change to the chooser arguments or a new outcome kind must in fact be made in two places, not one. (Surprising; the "made once" intent is only partly realized.)

## State Transitions

The single-summary push is a leaf operation: it either refuses at the entry gate with the push-disabled refusal, returns a result, raises a fatal error from the set above (which the caller routes to the chooser / outdated / opt-out flow), or — for binding-required on the first attempt — resolves a binding and retries once. Multi-commit pushes iterate this leaf oldest→newest, aborting on the first fatal error (and, for the whole-branch path, collecting non-fatal per-summary failures).

## Notable Behavior

- **One push path, never two.** The per-summary button, the live share, and the Create-PR push all funnel through the same primitive, so a subject is never pushed twice into duplicate articles with desynced doc ids. (Notable.)
- **Per-attachment failures are collected, not thrown.** A single bad user-attached item doesn't abort the remaining attachments or the summary; only the fatal set aborts. (Notable.)
- **One loop, not one loop per kind.** Nothing in this pipeline names a kind: the loop reads identity, body, title, document scope, per-summary reduction, aggregate and failure policy off each kind's own declaration. Registering a kind makes it push here with no change. The cost is that a mistake in a declaration is silent rather than a compile error on this side — an unknown field name reads as the empty string, which for a recency field means "oldest" and for an identity means every item collides. (Notable.)
- **A kind may publish ONE article for many items.** Such a kind declares an aggregate that collapses the commit's selected items into a single synthetic item just before the push, and declares that its published id/URL live on the **memory** rather than on any item. The aggregate runs on **both** selection branches — including the branch-share path, which always selects — because it is a per-commit presentation decision that no cross-commit dedup can make. The per-summary reduction is the opposite: it is skipped whenever a selection is present, and it is also applied to the copy the markdown renders from, because it is a statement about which items *exist* for that commit. (Surprising; the two collapses look alike and are not.)
- **The fatal set is repo-wide, not just "binding + plugin".** It is the shared repo-wide refusal set (shared with the CLI and the JVM host — spec 327) plus binding-required, so an outdated client, **this repo's outbound opt-out**, and a server permission/allowlist refusal all abort the loop too. Each is a property of the repo + credential: continuing would fire N doomed requests and report one condition as N per-item failures, and would rob the surfaces of the "re-enable to push" / admin-oriented handling they have for exactly these. (Notable; the set is wider than it reads.)
- **"Best effort" is a property of the KIND, declared in the registry — not a hard-coded exception for one kind.** Any kind that declares it is logged-and-skipped instead of collected, so the strict live-share path (which fatally aborts on the collected list) can never be sunk by it. Both auto-extracted kinds carry the declaration today: external references and the per-commit skill aggregate. The reasoning is the same for both — the user never attached them, so one item the server rejects must not abort a share — and it means adding a fourth auto-extracted kind is a declaration, not an edit here. (Surprising; the older behavior really was a single named exception.)
- **A refused document type short-circuits the whole kind for that summary.** When the server reports it has no configuration for a document type, the remaining items of that kind are not attempted: they would all fail identically, so one actionable report replaces a dozen look-alike transient errors. Other kinds continue, and the next summary re-attempts the kind from scratch. (Notable.)
- **Skipped attachments are a second channel, and they are reported per KIND, not per item.** They exist because "best effort" must mean *does not abort the push*, not *is hidden from the user* — a push that silently dropped articles while reporting success is a lie. Both routes into the channel are kind-wide conditions, and the caller renders every entry verbatim into a notification, so a per-item channel made the clean refusal path silent while the degraded path produced a notification a dozen titles long. The count and the first reason travel; the individual titles stay in the log. (Surprising; the collapse is the point.)
- **A stored doc id is only reused on the backend that minted it.** The reuse gate compares the current push's URL origin against the origin recovered from the stored doc's URL; a mismatch drops the stored id so the server mints a fresh doc rather than overwriting a different backend's article. Every seed/propagated id therefore travels with its minting URL. It's a cleanliness optimization, not a correctness guard — the server re-validates space/repo/owner regardless. (Notable.)
- **Published article URLs are server-preferred, not hard-coded.** The client uses the server-returned url (absolute verbatim; relative prefixed with the display base) and only falls back to the `?doc=<id>` alias when the server returned none — so stored/displayed URLs match the web app's canonical article path. (Notable.)
- **Strict vs. best-effort attachments differ by caller.** The manual push silently skips an unreadable user-attached body; the live share treats it as a hard failure so the share page can't point at a stale seeded doc id. Strictness never applies to a kind the registry declares best-effort. (Surprising; intentional.)
- **An aggregate kind's article can never enter the live share's covered set.** The covered lookup is keyed by the identities the commit's stored items carry, while the published aggregate is keyed by a commit-level identity minted for it — so the two can never match. (Surprising; a real gap, owned by 234.)
- **The whole-branch push reports skipped attachments; the live share does not.** Same leaf, same entries; the share path aggregates them into one log line and returns nothing, because it re-runs as a background reconcile on every modal open and would otherwise notify unprompted and repeatedly. (Surprising; intentional asymmetry.)
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
- **The repo-wide refusal set** underlying both the attachment-loop fatal test and the whole-branch loop's stop test — **Repo-Wide Push-Refusal Classification** (327).
- **The per-repo outbound opt-out** the entry gate reads, and the live-read rule that makes the gate 1 + N reads — **Per-Repo Outbound-Push Control** (310).
- **Live-share record shapes** the covered reference is stored into — **Branch Share Store** (233); the mint/reconcile triggers are **VS Code Live Branch Share** (234).
- **Manual Share/Update button UI** and the Create-PR trigger/toasts — **VS Code Summary Webview Panel** (109) and **PR Creation and Update** (99).
- **The context-kind registry itself** — which kinds exist, their identity/body/title/aggregate declarations, the load-time validation that rejects a malformed one, and the batch-assembly path that shares the same table — **Jolli Space Push Article Assembly** (231).
- **The legacy-identifier migration** run as this pipeline's first step — **Legacy Skill-Article Migration** (343).
- **CLI-core parity** — a CLI-core port of the branch-memories push loop exists (231); the dedup and push semantics are meant to match, with two recorded divergences: the sidecar strip list (above) and the failure policy — the CLI path logs-and-skips *every* kind and therefore ignores the best-effort declaration entirely, which only this surface acts on.
