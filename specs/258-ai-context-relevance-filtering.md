# 258 — AI Context-Relevance Filtering

## Topic Statement

Before a commit summary is generated, a pure-LLM relevance ranker assesses each active CONTEXT item (plan, note, reference) against the commit's change and uses a single batch call to (a) attach a per-item categorical tier (`high` / `mid` / `low`) emitted directly by the model, (b) attach a one-line reason, (c) order the kept items by tier for display, and (d) conservatively soft-exclude every item the model tiered `low`. The layer is always attempted, is credential-driven, and fails open on every error path: any failure keeps every item and excludes nothing. Under a locally-run agent-CLI credential provider, the ranking call is skipped outright — not attempted at all, and not treated as a failure — yielding the identical keep-all result.

## Scope

**In scope:**

- The candidate set the ranker is offered: the user-kept plans/notes/references **minus** every reference from a track-only source, and the consequences of that carve-out for tiers, reasons, and the soft-excluded set.
- The candidate representation: small items sent verbatim under per-kind character caps; larger items reduced to a mechanical, fence-aware skeleton under a skeleton cap.
- The total prompt character budget over all rendered items, with tail-drop of the overflow.
- The single batch ranking LLM call and its contract: output-token ceiling, a short wall-clock timeout, and the same model/credential resolution used by summary generation.
- The tolerant, block-delimited response parser, its tier-normalization rule, and its conservative defaults.
- The tier and auto-exclude decision, both driven by the model's per-item categorical tier — **not** a numeric score, **not** rank position.
- The display-only numeric score derived FROM the tier, and the display-only rank derived from tier-then-insertion order.
- The fail-open contract on every error (LLM failure, timeout, parse failure, git failure).
- The proactive skip of the ranking call under a locally-run agent-CLI credential provider — distinct from fail-open because no call is ever issued.
- The change signal fed to the ranker (commit message + changed-file list + declared symbols).
- The change fingerprint, keyed only on the sorted changed-file set.
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
- **Total items character budget**: ≈ 120,000 characters (≈ 40K tokens at the estimate). Rendered items beyond this are dropped from the tail.
- **Reference whole-send cap**: ≈ 4,000 characters (aligned with the summarize stage's per-reference cap, so the ranker never sees more of a reference than the summary ever would).
- **Plan/note whole-send cap**: ≈ 6,000 characters.
- **Skeleton cap**: ≈ 4,500 characters per item (≈ 1.5K tokens).
- **Output-token ceiling** for the ranking call: ≈ 4,096 tokens (one short block per item).
- **Per-call timeout**: ≈ 45 seconds.

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

### Prompt assembly

- **Items block.** Render each item as an indexed entry: a 1-based `[index]`, its kind, its title, then its representation. Accumulate entries while the running character total stays within the total items budget. When adding the next entry would exceed the budget **and at least one entry is already included**, stop and drop the remaining tail (logged), recording how many were dropped. This guarantees at least one item always survives, even if a single item is itself oversized. Build a map from the 1-based index to the item id.
- **Change block.** A "commit message" line (or a placeholder when empty), an optional indented "changed files" list, and an optional "key symbols" line.

### The ranking call

A single batch call is issued with the change block and the items block. Its contract:

- The output-token ceiling and the short per-call timeout above. The timeout is deliberately short so a wedged call fails open quickly **without holding the post-commit queue lock**.
- Model and credentials are resolved exactly as summary generation resolves them (default mid-tier model alias, resolved to a vendor id; direct or proxy credentials from the caller's config).
- Before any of this is attempted, a locally-run agent-CLI credential provider short-circuits the whole call: such a provider runs a full, multi-minute turn per invocation, which can never complete inside the ranking call's short timeout — issuing it would only cold-start the agent and then force-kill it on every commit. The ranker skips straight to the same keep-all result (every item kept, tier mid, empty reason) without spawning anything.

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

1. Map each parsed record back onto its item via the index→id map. An item the model **omitted** is conservatively kept: tier `mid`, empty reason — never a false `high`, never auto-excluded, nothing silently dropped for lack of a response line.
2. Order the items by **tier** (`high` → `mid` → `low`), breaking ties by original insertion order (stable). Assign 1-based ranks in that order. This ordering is purely for kept-item display; nothing thresholds on the rank.
3. Derive the display fields from the tier: `relevant = (tier !== "low")`; `score` = the tier's nominal value (`high` 0.9 / `mid` 0.6 / `low` 0.2); `autoExclude = (tier === "low")`.

The model's tier is authoritative and is not re-binned by rank position — there is no numeric score to compare across runs, so absolute cutoffs and bottom-third logic no longer exist.

### Fail-open

Any error anywhere in the flow (call failure, timeout, parse failure, an upstream git failure while building the change signal) yields a **keep-all** result: every item marked relevant, tier `mid`, score `0.6`, empty reason, ranked in insertion order, `autoExclude` false. The `mid` default is a neutral data-layer choice (nothing over-claimed), but it is effectively **inert**: the fail-open reason is empty, and every display surface gates its tier chip on a non-empty reason, so a fail-open row shows no tier at all. An **empty** candidate list short-circuits to an empty result with no call at all. A locally-run agent-CLI provider short-circuits the same way (see "The ranking call") — not because anything failed, but because the call is deliberately never attempted for that provider.

### Building the change signal

- The **commit message** is supplied by the caller (the pre-commit panel has none yet; the post-commit worker does).
- The **changed files** come from a name-only diff of the commit range, normalized to forward-slash; a git failure leaves the list empty (best-effort).
- The **symbols** are declaration names scraped from the **added** lines of the diff body (matching common declaration keywords followed by an identifier), de-duplicated and bounded; a diff-read failure leaves the list empty (best-effort).

### Change fingerprint

The fingerprint is a hash of the **sorted changed-file set only**, joined by newlines. It deliberately **excludes the commit message** so that the pre-commit panel (which has no message yet) and the post-commit worker (which does) compute the **same fingerprint for the same file set**. This is what lets the worker reuse the panel's already-persisted ranking instead of re-running the call. The hash is order-independent (the set is sorted first).

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
- **At least one item always survives the budget.** The tail-drop only fires once at least one item is already rendered, so even a single oversized candidate is included (skeletonized).
- **Both orchestrators populate results and set tiers.** The fresh-rank path and the fingerprint-reuse path both return a fully-populated per-item results list with each item's tier, and both stamp `low` onto soft-excluded records. The reuse path was previously left empty; it now rebuilds the results from the persisted per-item ranking so the kept-item relevance projection works on both paths.
- **Fail-open default is `mid`, and inert.** Keep-all stamps `mid` (a neutral default that over-claims nothing), not `high`. Because the fail-open reason is empty and every surface gates its tier chip on a non-empty reason, the tier value never actually renders on a fail-open row.
- **Fingerprint excludes the message on purpose.** Keying only on the file set is what makes the pre-commit (no message) and post-commit (with message) fingerprints agree, enabling one-ranking reuse.
- **Fail-open is total.** Nothing in this layer can break summary generation: the worst case is "keep everything, exclude nothing".
- **A locally-run agent-CLI provider never attempts the call.** Ranking is skipped proactively (not as a failure) because a full agent turn cannot fit inside the ranking call's short timeout; the result is shaped identically to the fail-open keep-all, but no request is ever issued.
- **The IntelliJ port implements an earlier, superseded version of this algorithm.** Where this spec describes the model emitting a tier directly (high/mid/low) as the sole authoritative signal, the IntelliJ port instead asks the model for a relevant/score pair per item and derives tier from RANK POSITION (top third → high, middle third → mid, bottom third → low), with soft-exclude requiring BOTH a bottom-third rank AND an explicit "not relevant" answer — the single-condition tier===low rule does not hold there. The IntelliJ port also has no proactive skip for a locally-run agent-CLI provider, passes no per-call timeout override (relying on the transport's global timeout), has no fingerprint-based reuse of a persisted ranking (every assessment recomputes fresh), records no tier on its soft-excluded items, and has no kept-item relevance projection (only the soft-excluded list is recorded). The numeric budgets (items-block budget, per-kind caps, skeleton cap, output-token ceiling) are identical across both platforms.

## Shared Behavior

- **Prompt template (spec 11)** — the ranking call's action, template body, and version stamp live in the template library; this spec owns only the call contract and the response parsing.
- **Exclusion selection store (spec 188)** — the persisted **full per-item ranking** (kind/key/tier/reason + original-exclude + optional dismissed flag) and change fingerprint this layer's output feeds, plus the dismiss/clear operations over them.
- **Working-memory review panel (spec 247)** — the pre-commit surface that calls orchestrator 1, persists its full per-item output, and renders the per-item tiers/reasons; its ranking is non-authoritative and is superseded by the post-commit recompute.
- **Multi-topic summary generation (spec 12)** — consumes the kept context in relevance-ranked order, records the soft-excluded set on the stored summary's excluded-context field, and records the kept-item relevance projection (kind/key/tier/reason) on the stored summary's per-kept-item relevance field. Spec 12 also owns both halves of the track-only carve-out: the split that removes those references from this layer's candidate set, the unconditional splice-back afterwards, and the separate rule that the prompt-block builder skips a track-only source's definition entirely.
- **Plan/note archival (specs 42, 43)** — a soft-excluded plan/note is removed from the archive-side selection but **not** discarded; it keeps no commit hash, its registry row and backing file stay intact, and it reappears for re-evaluation on the next commit. This is now **identical** to how a user hard-exclude of a plan/note/reference is treated — both are skip-only for the current commit, neither deletes the item (see [188 — Commit Exclusion Selection Store]). Conversations are the exception: an excluded conversation is a one-time discard.
