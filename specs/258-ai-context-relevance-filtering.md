# 258 — AI Context-Relevance Filtering

## Topic Statement

Before a commit summary is generated, a pure-LLM relevance ranker assesses each active CONTEXT item (plan, note, reference) against the commit's change and uses a single batch call to (a) attach a per-item categorical tier (`high` / `mid` / `low`) emitted directly by the model, (b) attach a one-line reason, (c) order the kept items by tier for display, and (d) conservatively soft-exclude every item the model tiered `low`. The layer is always attempted, is credential-driven, and fails open on every error path: any failure keeps every item and excludes nothing. The call is now issued for **every** credential provider — including a locally-run agent-CLI provider, which previously short-circuited to keep-all without issuing anything; only the per-call wall-clock differs by provider.

## Scope

**In scope:**

- The candidate set the ranker is offered: the user-kept plans/notes/references **minus** every reference from a track-only source, and the consequences of that carve-out for tiers, reasons, and the soft-excluded set.
- The candidate representation: small items sent verbatim under per-kind character caps; larger items reduced to a mechanical, fence-aware skeleton under a skeleton cap.
- The **change-affinity pre-ordering** applied before the budget is spent, its needle derivation, its scoring rule, its deliberately-ascending direction, and why that direction is the correct one for a fail-open-keep layer.
- The total prompt character budget over all rendered items, how it is spent walking the affinity order, and tail-drop of the overflow.
- The single batch ranking LLM call and its contract: output-token ceiling, a provider-dependent wall-clock timeout, and the same model/credential resolution used by summary generation.
- The tolerant, block-delimited response parser, its tier-normalization rule, and its conservative defaults.
- The tier and auto-exclude decision, both driven by the model's per-item categorical tier — **not** a numeric score, **not** rank position.
- The display-only numeric score derived FROM the tier, and the display-only rank derived from tier-then-insertion order.
- The strictly-by-identity lookup that maps a model verdict back onto its candidate, and the absence of any positional fallback.
- The fail-open contract on every error (LLM failure, timeout, parse failure, git failure, an argument-size failure when spawning a local agent CLI).
- The change signal fed to the ranker (commit message + changed-file list + declared symbols + a capped head of the change's diff).
- The change fingerprint, keyed only on the sorted changed-file set, and the accepted stale-diff reuse window that follows from leaving the diff out of it.
- The two orchestrators: one that reads item content and ranks; one that reconstructs a decision from a previously-persisted full per-item ranking without re-ranking.
- The projection that emits a per-KEPT-item relevance record (kind/key/tier/reason) for the stored summary.

**Out of scope (boundaries — referenced, not duplicated):**

- The raw prompt-template body and its version stamp (owned by [11 — Prompt Template Library]).
- Persistence of the produced soft-exclude set + fingerprint, and the dismiss/clear operations over it (owned by [188 — Commit Exclusion Selection Store]).
- The pre-commit review-panel overlay that displays tiers/reasons and calls the first orchestrator (owned by [247 — VS Code Working-Memory Review Panel]).
- How the summary generator consumes the ranked context blocks, and how the soft-excluded set and the kept-item relevance projection are recorded as two fields on the stored summary (owned by [12 — Multi-Topic Commit Summary Generation]).
- How the surrounding pipeline drops soft-excluded plans/notes from archival without discarding them (owned by [42 — Plan Archival on Commit] and [43 — Note Archival on Commit]).
- LLM transport, proxy routing, and credential/origin resolution (specs 08, 09, 10).

## Data Contracts

### The candidate set (what the ranker is and is not offered)

The ranker's input is **not** simply "every active CONTEXT item". The caller partitions the user-kept set first and offers this layer only part of it:

- The input set is the user-kept plans, notes, and references **minus every reference whose source declares itself track-only** (the flag is owned by the source-definition spec; which source declares it is the built-in-source catalog's concern).
- The withheld track-only references are spliced back into the caller's kept set **unconditionally** after this layer returns, on both the normal-commit path and the amend path.

Consequences for this layer's own contracts, all directly observable:

- A track-only reference never becomes a candidate, so it never receives a tier and never receives a reason.
- It therefore never appears in the soft-excluded set, and never lands on the stored summary's excluded-context field by way of a verdict.
- It likewise never appears in the kept-item relevance projection, since that projection walks this layer's per-item results.
- Nothing in this layer can drop a track-only reference. That is precisely why the split exists upstream rather than being expressed as a rule inside the ranker.
- An explicit **user hard-exclude** of a track-only reference, or an already-persisted excluded-context entry for it, is still honored downstream. The carve-out protects such a reference from an *AI* verdict only, not from the user.

### Context item (input candidate)

Each candidate carries:

- **kind**: one of `plan`, `note`, `reference`.
- **id**: an opaque identifier echoed back to the caller unchanged — a plan slug, a note identifier, or a reference key (see reference key below).
- **title**: a short label.
- **content**: the item's full text, read from disk by the caller. May be large.

### Change signal

- **commit message**: the message the change was (or will be) committed with. May be empty.
- **changed files**: the ordered list of repo-relative changed-file paths, in forward-slash form.
- **symbols**: a bounded, de-duplicated list of declared symbol names extracted from the change.
- **diff**: the head of the change's diff text, capped to the diff budget below with an in-band truncation marker naming the pre-cap length. May be empty (diff unavailable, or the caller supplied none).

### Relevance result (per item)

- **id**, **kind**: copied from the candidate.
- **tier**: one of `high`, `mid`, `low`, taken **directly from the model's output** (normalized — see "Response parsing"). This is the authoritative signal; everything else on the record is derived from it.
- **relevant**: boolean — `true` unless the tier is `low`. `low` is the soft-exclude tier, so a not-`low` tier means "kept".
- **score**: a nominal confidence in `[0, 1]` derived **from the tier** (`high` → 0.9, `mid` → 0.6, `low` → 0.2), **never** returned by the model. Retained for audit/telemetry display only; nothing ranks or filters by it.
- **reason**: a one-line explanation (possibly empty).
- **rank**: 1-based position after ordering by tier (`high` → `mid` → `low`), ties broken by original insertion order. Display order only — nothing thresholds on it.
- **autoExclude**: boolean — true exactly when `tier === "low"`. This is the single soft-exclude condition.

### Soft-excluded item (per auto-excluded item)

For each item with `autoExclude` true (i.e. tiered `low`), the first orchestrator emits a record: **kind**, **key** (the item id), **title** (a human label — for a reference this is the display label, see below), **reason**, and a **tier** fixed to the lowest band (`low`). This record is what downstream traceability consumes.

### Kept-item relevance record

For each KEPT item (not auto-excluded) whose **reason is non-empty**, a projection emits a record: **kind**, **key** (the item id), **tier**, **reason**. This is what lands on the stored summary's per-kept-item relevance field. Items with an empty reason are dropped from this projection (see "Kept-item relevance projection").

### Reference identity

- **Reference key**: `<source>:<nativeId>` — the same composite key the exclusion store and the summary pipeline use to address a reference row, so a single key flows across all three without translation.
- **Reference display label**: `<nativeId> — <title>`, so a soft-excluded reference reads identically to a kept reference row (a bare title looked inconsistent next to kept rows).

### Tunable budgets (values, not names)

- **Chars-per-token estimate**: ≈ 3, deliberately low (code and CJK are denser than English prose) so the budget errs toward smaller prompts.
- **Total items character budget**: ≈ 160,000 characters (≈ 53K tokens at the estimate). Rendered items beyond this are dropped from the tail of the **affinity order** (below).
- **Diff budget** for the change signal's diff head: ≈ 20,000 characters — deliberately between the commit-message stage's diff budget and the summary stage's own diff cap, so the diff characterizes the change without dominating the prompt.
- **Reference whole-send cap**: ≈ 4,000 characters (aligned with the summarize stage's per-reference cap, so the ranker never sees more of a reference than the summary ever would).
- **Plan/note whole-send cap**: ≈ 6,000 characters.
- **Skeleton cap**: ≈ 4,500 characters per item (≈ 1.5K tokens).
- **Affinity scan cap**: ≈ 8,000 characters of a candidate's body are scanned when scoring change-affinity (the head of a document carries its topic; the cap bounds the sort's cost).
- **Output-token ceiling** for the ranking call: ≈ 8,192 tokens (one short block per item; raised so a many-item response does not truncate — a truncated tail is omitted from the parse and then conservatively kept, the same silent-leak shape as a budget overflow).
- **Per-call timeout**: ≈ 120 seconds for the API-backed providers, ≈ 180 seconds when the provider is a locally-run agent CLI (which must cold-start a real process). A provider left unset takes the shorter of the two. Both sit well inside the queue worker's lock-heartbeat window, so a long ranking call cannot cause the worker's lock to be reclaimed as stale.

Two of these are additionally overridable per invocation — the per-call timeout and the total items budget — but **no production caller passes either**; every live invocation takes the defaults. They are an unwired extension point exercised only by tests.

## Behavior

### Candidate representation

For each candidate, produce the text the ranker will see:

1. For a **reference**, first strip a leading YAML frontmatter block if present (the title is carried separately); for a **plan/note**, use the content as-is. Trim.
2. If the resulting body is at or under the item's whole-send cap (reference cap for references, plan/note cap otherwise), send it **verbatim**.
3. Otherwise, reduce it to a **skeleton** capped at the smaller of the skeleton cap and the item's whole-send cap. (Because the skeleton cap never exceeds the whole-send cap, skeletonizing can never produce a larger representation than sending the item whole would have.)

### Skeleton extraction (large items)

The skeleton is mechanical and fence-aware:

- A metadata line stating the kind, the original character and line counts, and that this is a mechanical skeleton (not full text).
- The title.
- An "overview": the lead prose before the first heading, capped at a short length.
- All section headings, concatenated.
- Referenced file-path tokens found in the body (those matching a path with a known code/doc extension), normalized to forward-slash form and capped in count.
- Each section's first sentence, appended one at a time until the running text approaches the cap; the whole is truncated to the cap with an elision marker if needed.

Fence tracking is **marker-type-aware**: a fenced block closes only on the same fence-marker character it opened with, so a `~~~` line inside a ```` ``` ```` block (or vice versa) does not spuriously toggle the state. Heading and file-path detection are suppressed inside fenced blocks.

### Change-affinity pre-ordering (before the budget is spent)

Candidates are re-ordered before the items block is built, so that the scarce character budget is spent on the candidates most worth judging:

1. **Needles.** Derive a set of change-characterizing tokens: for each changed file, only its **final** path segment — both with and without its final extension, though the extension-stripped form is derived only when the name actually has an interior dot, so a dot-leading name such as a hidden configuration file contributes its full form alone — plus every declared symbol from the change signal. Tokens are lowercased, trimmed, de-duplicated, and any token shorter than three characters is dropped. Intermediate directory segments are **deliberately excluded**: in a monorepo, generic segments appear in almost every document and would swamp a substring-based score with noise. The diff is **not** a needle source.
2. **Score.** A candidate's affinity is the count of **distinct** needles that occur as a **substring** anywhere in its title plus the scanned head (affinity scan cap) of its **raw** body. It is a count of distinct needles, not of occurrences, and there is no word-boundary requirement; the text scanned is the raw body, **not** the reduced representation the model will actually see.
3. **Order.** Sort **ascending — least-affinity first**. The sort is stable (equal scores keep their original relative order), operates on a copy (the caller's list is never mutated), and is skipped entirely when the needle set is empty or fewer than two candidates exist, leaving the original order intact.

**Why ascending, which is counter-intuitive.** This layer is fail-open-**keep**: a candidate the budget drops is conservatively kept *unjudged*, so only candidates that actually reach the model can ever be excluded. The budget must therefore be spent on the candidates most likely to warrant exclusion — the low-affinity ones, whose overlap with the change is slight. A high-affinity candidate lost to the budget is kept anyway, so the only cost of dropping it is that its tier and reason go undisplayed. Ordering most-important-first would instead drop the likely-unrelated tail and keep it unjudged — precisely the silent context leak this layer exists to prevent.

This ordering affects only **which** candidates enter the prompt and **what block index** each receives. The layer's returned ordering is unchanged: still tier-then-original-insertion-order, never affinity order.

### Prompt assembly

- **Items block.** Walk the **affinity order**. Render each item as an indexed entry: a 1-based `[index]`, its kind, its title, then its representation. Accumulate entries while the running total of **rendered entry lengths** stays within the total items budget. When adding the next entry would exceed the budget **and at least one entry is already included**, stop and drop the remaining tail (logged), recording how many remained. This guarantees at least one item always survives, even if a single item is itself oversized — and a zero or negative budget therefore admits exactly **one** entry, the lowest-affinity one. Only the rendered entries are counted, not the blank-line separators joining them, so once two or more entries are admitted the emitted block marginally exceeds the nominal budget; with a single entry there is no separator and it cannot. Build a map from the 1-based index to the item id.
- **Change block.** A "commit message" line (or a placeholder when empty), an optional indented "changed files" list, an optional "key symbols" line, and — **last, and only when the diff is non-empty** — a diff section explicitly labelled as possibly truncated, carrying the change signal's capped diff head.

### The ranking call

A single batch call is issued with the change block and the items block. Its contract:

- The output-token ceiling and the per-call timeout above. The timeout is resolved **from the active provider**: the longer ceiling for a locally-run agent CLI (so cold-start variance does not force-kill a call that is about to succeed), the shorter one otherwise. The ceiling exists so a wedged call cannot pin the post-commit queue lock indefinitely — not because ranking is expected to take that long.
- Model and credentials are resolved exactly as summary generation resolves them (default mid-tier model alias, resolved to a vendor id; direct or proxy credentials from the caller's config).
- The call is issued for **every** provider. There is no longer any provider under which ranking is skipped by design; the former short-circuit for a locally-run agent-CLI provider has been removed, so such a user's commits go through the same ranking as everyone else's.
- **One provider-shaped failure mode remains, reached by failure rather than by design.** Every local agent CLI but one receives the whole prompt as a single command-line argument; the exception streams it over standard input. With a large items block plus a large diff, that argument can exceed the platform's per-argument size limit and the spawn fails outright. The failure is caught by the fail-open path, so the observable result is keep-all — the same outcome the old deliberate skip produced, but arrived at as an error rather than as a decision, and only for large inputs.

### Response parsing

The response is a sequence of blocks, each introduced by a delimiter line. Segments before the first delimiter and empty segments are discarded. Parsing is tolerant:

- For each block, read `index`, `tier`, and `reason` as simple `name: value` lines (case-insensitive, first match). There is no `relevant` field and no `score` field in the response — the model emits a categorical tier directly.
- A block whose `index` is missing or non-integer is **skipped** entirely.
- `tier`: normalized to `high` / `mid` / `low` (see "Tier normalization").
- `reason`: trimmed; defaults to empty.

### Tier normalization

The raw tier token from the model is folded to one of `high` / `mid` / `low`:

- Missing / empty → `mid` (a conservative keep: not auto-excluded like `low`, never a false `high`).
- Case-insensitively, a token starting with `high` → `high`; starting with `low` → `low`.
- For backward-compatibility with an older free-text vocabulary, a token starting with any of `no`, `none`, `not`, `false`, `unrelated`, `irrelevant`, `exclude` → `low` (honor the exclude intent rather than silently keeping it).
- Everything else (including `mid`, `med`, `medium`, or any unrecognized value) → `mid`.

### Merge, rank, tier, auto-exclude

1. Map each parsed record back onto its item **strictly by the item's identity**, via the index→id map built while rendering the block. An item with no entry in that map was dropped by the budget; an item present in the map but absent from the response was omitted by the model. Both cases are conservatively kept: tier `mid`, empty reason — never a false `high`, never auto-excluded, nothing silently dropped for lack of a response line. There is **no positional fallback**: an earlier design guessed a block index from the item's original position when the map lookup missed, which after the affinity re-ordering would graft a *different* item's verdict onto the dropped item — potentially excluding context the model never saw. That fallback is gone.
2. Order the items by **tier** (`high` → `mid` → `low`), breaking ties by original insertion order (stable). Assign 1-based ranks in that order. This ordering is purely for kept-item display; nothing thresholds on the rank.
3. Derive the display fields from the tier: `relevant = (tier !== "low")`; `score` = the tier's nominal value (`high` 0.9 / `mid` 0.6 / `low` 0.2); `autoExclude = (tier === "low")`.

The model's tier is authoritative and is not re-binned by rank position — there is no numeric score to compare across runs, so absolute cutoffs and bottom-third logic no longer exist.

### Fail-open

Any error anywhere in this layer (call failure, timeout, parse failure, a failed spawn of a local agent CLI) yields a **keep-all** result: every item marked relevant, tier `mid`, score `0.6`, empty reason, ranked in insertion order, `autoExclude` false. The `mid` default is a neutral data-layer choice (nothing over-claimed), but it is effectively **inert**: the fail-open reason is empty, and every display surface gates its tier chip on a non-empty reason, so a fail-open row shows no tier at all. An **empty** candidate list short-circuits to an empty result with no call at all — that is now the **only** input that skips the call.

### Building the change signal

- The **commit message** is supplied by the caller (the pre-commit panel has none yet; the post-commit worker does).
- The **changed files** come from a name-only diff of the commit range, normalized to forward-slash, obtained by its own dedicated read; a git failure leaves the list empty (best-effort).
- The **symbols** and the **diff** both come from a **single** diff read of the same range. That read is itself capped (≈ 60,000 characters) by the shared diff-reading helper. Symbols are declaration names scraped from the **added** lines of that body (matching common declaration keywords followed by an identifier), de-duplicated and bounded. The diff signal is the **head** of the same body, capped to the diff budget (≈ 20,000 characters) with a truncation marker naming the pre-cap length. Note which pre-cap length: this marker reports the length of the body it was handed — already subject to the upstream cap — not the raw diff's true size, which appears only in the upstream read's own marker. On a large change the two markers therefore quote different numbers, and neither one alone states how big the diff really was.

A git failure while building the change signal is **not** an error this layer sees. The change-signal read degrades to empty symbol and diff fields rather than raising (the changed-file list is gathered separately and survives), and the surrounding pipeline carries its own rescue that falls back to keeping all user-kept context. The observable outcome matches this layer's fail-open, but the mechanism is the caller's, not this one's.
- Because the read and the file-list read are separate, a **diff-read failure empties both the symbols and the diff while the changed-file list survives** (best-effort on each side).

**Consequence of the two-stage cap, for large changes.** The upstream read's own cap does not simply truncate: when the raw diff exceeds it, the read first prepends a per-file change-statistics list covering **every** changed file, plus its own truncation marker naming the pre-cap length, and only then fills the remaining space with the head of the diff body. Since the ranker then takes the first ≈ 20,000 characters of *that*, a change whose raw diff exceeds the upstream cap hands the ranker a head that **begins with the file list** — and when that list is long relative to the 20,000-character window, the "diff" signal degenerates into little more than a restatement of the changed-file list the ranker already has, with few or no actual hunks. The diff signal is therefore strongest for small and medium changes and weakest exactly where a large commit most needs disambiguating.

### Change fingerprint

The fingerprint is a hash of the **sorted changed-file set only**, joined by newlines. It deliberately **excludes the commit message** so that the pre-commit panel (which has no message yet) and the post-commit worker (which does) compute the **same fingerprint for the same file set**. This is what lets the worker reuse the panel's already-persisted ranking instead of re-running the call. The hash is order-independent (the set is sorted first).

**The diff is deliberately excluded too, and that leaves an accepted stale-reuse window.** The ranker now consumes a diff, but the fingerprint does not, so a ranking judged against one diff can be reused against a *different* diff over the identical file set: the interactive pre-commit surface ranks a file set against the working-tree diff, the user then edits **the same files in place** so the change's topic shifts while its file set stays identical, and the commit lands without a re-rank — whereupon the worker's fingerprint matches and the earlier, differently-grounded verdicts are reused. The window is narrow: it requires the interactive pre-commit surface to have ranked, an in-place edit that leaves the file set untouched but changes the subject, and a commit before any re-rank. It cannot occur on the command-line / programmatic paths, which have no pre-commit surface and therefore always rank fresh against the real committed diff.

Folding the diff into the key is **deliberately not done**: the pre-commit diff (working tree against the current head) and the post-commit diff (the commit against its parent) are not guaranteed byte-identical even for identical content, so the keys would perpetually miss and **every** commit would pay a redundant re-rank — judged too high a price for so narrow a case.

### Orchestrator 1 — assess relevance (reads content, ranks)

Given registry entries already filtered of user hard-excludes **and already stripped of track-only references** (see "The candidate set"), a change signal, and an LLM config:

1. Build candidates from the entries, reading each entry's canonical content from its source path on disk, falling back to the title when the file is missing or empty (best-effort, never throws — plan source paths can point outside the worktree).
2. If there are no candidates, return the registry entries unchanged with an empty soft-exclude set.
3. Rank the candidates.
4. Partition the results: an auto-excluded item (tier `low`) becomes a soft-excluded record (with its display title and reason, tier fixed to the lowest band); every other item is a **kept** entry, appended in **relevance-ranked order** to its kind's list.
5. Return the kept plans/notes/references (each in relevance order), the soft-excluded set, and the raw per-item results (both for the panel overlay and for the kept-item relevance projection below).

This orchestrator always recomputes — it is the authoritative path.

### Orchestrator 2 — reconstruct from a persisted full ranking (no re-rank)

Given registry entries and a previously-persisted **full per-item ranking** — one entry per ranked item carrying `kind`, `key`, `tier`, `reason`, the AI's original `excluded` judgment, and an optional user `dismissed` veto flag (see spec 188) — this is a **pure** function with no I/O and **no ranking call**:

1. Index the persisted entries by kind and key.
2. Walk the registry entries in their **registry order**. For each entry with a matching persisted verdict, compute its **effective exclude** = `excluded AND NOT dismissed`:
   - Effectively excluded → a soft-excluded record (title + reason, tier `low`), and a result carrying the entry's original tier + reason with `autoExclude` true.
   - Not effectively excluded (never excluded, OR excluded-then-dismissed) → a **kept** entry, and a result carrying the entry's original tier + reason with `autoExclude` false. A dismissed item therefore lands as KEPT while still showing the AI's original tier + reason — nothing the AI concluded is lost.
   - An entry with **no** persisted verdict (legacy file, or an item added after the ranking) is kept with **no** result record — display layers fall back to a plain title row.
3. Return the kept entries (in registry order — deliberately **not** re-ranked), the soft-excluded set, and the **populated** per-item results (reconstructed above). The results list is what lets the reuse path rebuild both the effective exclude set and the kept items' tier/reason without re-running the LLM. Reconstructed results carry no meaningful score (fixed 0) or rank (renumbered in registry order purely to keep the field monotonic) — those never persist.

The authoritative data here is the per-item verdict list; top-N ordering is secondary, so preserving registry order is acceptable. Because the dismiss mechanism (spec 188) sets a flag on the persisted entry rather than removing it, the entry's tier + reason survive a dismiss and a kept-after-dismiss item still carries its original verdict.

### Kept-item relevance projection

A projection over a decision's per-item results produces the per-KEPT-item relevance records for the stored summary (spec 12): for every result that is **not** auto-excluded **and** whose reason is **non-empty**, emit `{kind, key, tier, reason}`. It works identically for both orchestrators (a fresh rank with full results, or a fingerprint-reuse with results rebuilt from the persisted list; a legacy selection file with no persisted ranking yields an empty projection).

Empty-reason results are dropped on purpose: the fail-open keep-all fabricates `tier "mid", reason ""` for every item, and a per-item model omission also defaults to an empty reason — neither is a real verdict, and persisting them would stamp a fabricated tier onto the artifact and render dangling separators in the display. Soft-excluded items are unaffected — they are recorded on the soft-excluded set instead, which keeps a low-tier entry even with an empty reason.

## State Transitions

The layer is stateless and pure per invocation. Orchestrator 1 performs disk reads to gather content; orchestrator 2 performs no I/O. Neither persists anything — persistence of the produced soft-exclude set and fingerprint is the caller's responsibility (spec 188).

## Notable Behavior

- **Track-only references are carved out before this layer runs, not filtered inside it.** They are removed from the candidate set upstream and spliced back into the kept set unconditionally afterwards, so this layer can never assign them a tier, a reason, or an auto-exclude verdict. Framing it as an input carve-out rather than an internal rule is deliberate: it makes "a relevance verdict cannot drop a track-only reference" structurally true rather than dependent on a conditional inside the ranker.
- **No config gate.** The layer is always attempted. Whether it does anything depends only on the presence of credentials and on the fail-open path; there is no user-facing on/off switch for relevance filtering.
- **The model emits the tier directly; the tier is authoritative.** The model returns a categorical `high`/`mid`/`low` per item. There is no numeric score in the response and no rank-position binning — the score and rank on the result are both **derived** (score from the tier, rank from tier-then-insertion order) and exist only for display/audit. A previous design had the model return a `relevant` flag + a `[0,1]` score that the caller binned into thirds by rank; that is gone.
- **Soft-exclude is a single condition: `tier === "low"`.** An item is soft-excluded exactly when the model tiered it `low`. There is no "bottom third" and no two-condition rule.
- **Conservative parser.** The parser reads only `index`, `tier`, `reason`. A missing/garbled/unrecognized tier normalizes to `mid` (a keep); an item the model omitted entirely is kept at `mid` with an empty reason. The parser errs toward keeping context, never toward silently dropping it. It still honors the old free-text exclude vocabulary (`no`/`none`/`not`/`false`/`unrelated`/`irrelevant`/`exclude` → `low`) for backward compatibility.
- **At least one item always survives the budget.** The tail-drop only fires once at least one item is already rendered, so even a single oversized candidate is included (skeletonized). A zero or negative budget therefore still admits exactly one entry — the lowest-affinity candidate.
- **The budget is spent least-affinity-first, which reads backwards until you see why.** Candidates are pre-ordered by *ascending* change-affinity, so the tail the budget drops is the *high*-affinity, likely-relevant set. That is correct precisely because dropping is a keep: only candidates that reach the model can be excluded, so the budget belongs to the candidates that might warrant exclusion. Ordering most-relevant-first would keep the likely-unrelated tail unjudged — the leak the layer exists to close. (Surprising; intentional.)
- **The affinity score is coarse on purpose.** It counts distinct substring hits of file basenames (with and without extension) and declared symbols in the candidate's title plus a bounded head of its raw body — no word boundaries, no occurrence weighting, no intermediate directory segments (which would match nearly every document in a monorepo), and no contribution from the diff. It reorders only; it never excludes.
- **Affinity order is prompt-only.** It changes which candidates the model sees and what block index each gets; the returned ordering remains tier-then-original-insertion-order.
- **Verdict lookup is by identity only.** After the re-ordering, block position no longer corresponds to input position, so a positional fallback would attach one item's verdict to another. The fallback that used to exist was removed for exactly that reason; an unmatched item is simply kept at `mid`.
- **The rendered block slightly overshoots its nominal budget.** Only the entries themselves are counted against the budget, not the separators joining them.
- **The prompt was not updated for the diff, and its version stamp was not advanced.** The change block now carries a diff section, but the ranking instructions still tell the model to judge from the commit message's intent and the item's own topic and never mention a diff at all — and the template's version stamp is unchanged despite a materially different rendered input. So the strongest new signal is supplied without being asked for or explained, and the (action, version) pair no longer distinguishes the two shapes of input. This is a real gap, not a documented design choice. (Surprising.)
- **The diff signal is weakest for the largest changes.** For a change whose raw diff overflows the upstream read cap, the head handed to the ranker leads with a whole-file list; when that list is long, little or no actual hunk content fits inside the diff budget, and the "diff" degenerates toward a restatement of the changed-file list. (Surprising.)
- **The per-call timeout and items budget are overridable but unwired.** Both overrides exist on the invocation options and neither has a production caller; every live run takes the defaults.
- **Both orchestrators populate results and set tiers.** The fresh-rank path and the fingerprint-reuse path both return a fully-populated per-item results list with each item's tier, and both stamp `low` onto soft-excluded records. The reuse path was previously left empty; it now rebuilds the results from the persisted per-item ranking so the kept-item relevance projection works on both paths.
- **Fail-open default is `mid`, and inert.** Keep-all stamps `mid` (a neutral default that over-claims nothing), not `high`. Because the fail-open reason is empty and every surface gates its tier chip on a non-empty reason, the tier value never actually renders on a fail-open row.
- **Fingerprint excludes the message on purpose — and the diff, at a known cost.** Keying only on the file set is what makes the pre-commit (no message) and post-commit (with message) fingerprints agree, enabling one-ranking reuse. Leaving the diff out too keeps that reuse working, at the price of an accepted window in which a pre-commit ranking is reused against a different committed diff over the same file set (see "Change fingerprint"). Folding the diff in was rejected because the two surfaces' diffs of identical content are not byte-identical, so every commit would re-rank.
- **Fail-open is total.** Nothing in this layer can break summary generation: the worst case is "keep everything, exclude nothing".
- **No provider is skipped any more.** The proactive short-circuit under a locally-run agent-CLI provider is gone: every provider now issues the call, with only a longer wall-clock for the local-agent case. The one residual local-agent-shaped hazard is an argument-size failure when a very large prompt is passed as a single command-line argument, which lands on the fail-open path — the same visible outcome as the old skip, but reached by error rather than by design and only for large inputs.
- **A ranking call can now run for minutes, and that is inside the worker's lock heartbeat.** The raised ceilings (≈ 120 s, ≈ 180 s under a local agent CLI) are comfortably under the queue worker's lock staleness threshold, and the worker heartbeats its lock throughout, so a slow ranking cannot get the worker's lock reclaimed.
- **There is one implementation.** The JetBrains IDE surface's second implementation of this layer was deleted; nothing on that surface ever called it, so its removal changed source only and no behavior changed there.

## Shared Behavior

- **Prompt template (spec 11)** — the ranking call's action, template body, and version stamp live in the template library; this spec owns only the call contract and the response parsing. Note the mismatch recorded under Notable Behavior: the rendered input gained a diff section while the instruction body (which never mentions a diff) and the version stamp both stayed as they were.
- **Exclusion selection store (spec 188)** — the persisted **full per-item ranking** (kind/key/tier/reason + original-exclude + optional dismissed flag) and change fingerprint this layer's output feeds, plus the dismiss/clear operations over them.
- **Working-memory review panel (spec 247)** — the pre-commit surface that calls orchestrator 1, persists its full per-item output, and renders the per-item tiers/reasons; its ranking is non-authoritative and is superseded by the post-commit recompute.
- **Multi-topic summary generation (spec 12)** — consumes the kept context in relevance-ranked order, records the soft-excluded set on the stored summary's excluded-context field, and records the kept-item relevance projection (kind/key/tier/reason) on the stored summary's per-kept-item relevance field. Spec 12 also owns both halves of the track-only carve-out: the split that removes those references from this layer's candidate set, the unconditional splice-back afterwards, and the separate rule that the prompt-block builder skips a track-only source's definition entirely.
- **Plan/note archival (specs 42, 43)** — a soft-excluded plan/note is removed from the archive-side selection but **not** discarded; it keeps no commit hash, its registry row and backing file stay intact, and it reappears for re-evaluation on the next commit. This is now **identical** to how a user hard-exclude of a plan/note/reference is treated — both are skip-only for the current commit, neither deletes the item (see [188 — Commit Exclusion Selection Store]). Conversations are the exception: an excluded conversation is a one-time discard.
