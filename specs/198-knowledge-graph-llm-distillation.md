# 198. Knowledge Graph LLM Distillation

## Topic Statement

Turn topic-KB pages into the distilled graph (categories, topics, units, edges) through a three-phase model pipeline that sanitizes and backfills on the full path but fails closed on the incremental path so a transient model error never overwrites a still-good graph with degraded data.

## Scope

**In scope:**
- The three model phases — categorize all topics, distil per-topic units (fanned out), link typed edges **within one category** (fanned out per category) — and their request shapes (action, parameters, output-token cap, streaming flag).
- The response parser: code-fence stripping, prose-wrapped JSON span extraction, and graceful null on failure.
- The per-field coercion/sanitizing rules: string-or-fallback, blank-or-fallback, string-array filter, confidence clamping.
- The full-path category distillation: category dedup, blank-label fallback, topic mapping, hallucinated-slug drop, and the backfill that guarantees every input topic survives.
- The per-topic unit distillation: per-topic id namespacing with collision suffixing, kind validation, blank-title/summary fallbacks, and the bounded retry loop that decides when a topic's call is a failure.
- The edge distillation: the per-category fan-out, the two-unit minimum, endpoint/type/self/duplicate filtering, the batch-scoped endpoint drop, confidence clamping, truncation handling, and the strict-vs-lenient parse policy.
- The incremental distillation: clean-unit reuse by whitelist, changed-topic re-distillation, the category-delta call plus the pure category merge, the affected-category edge recompute and the edge-granularity merge against the baseline edges, and the no-model pure-deletion path.
- The fail-closed contract on every incremental model call (throws instead of degrading), and how it is expressed — a strict flag on the edge phase, and the absence of a per-item error handler on the unit fan-out.
- The progress reporting emitted per phase.

**Out of scope (boundaries):**
- The model-call transport itself — credential resolution, provider routing, streaming watchdogs, model-id resolution, the returned text + stop-reason envelope (the LLM client and provider routing — specs 8-10). This spec consumes that envelope's text and its max-tokens stop-reason signal.
- The prompt template text and its versioning (the prompt template library — spec 11). This spec names the four actions and the parameters each is filled with, not the prose.
- The bounded-concurrency helper used to fan out both the unit calls and the per-category edge calls (a shared utility; only its done/error semantics — and the consequence of supplying or omitting its per-item error handler — are in scope).
- The data model, validation, edge normalization, join, and rollup that consume the distilled graph (spec 196). This spec emits a distilled graph; it does not assemble.
- The build orchestration that decides full vs. incremental and supplies the baseline and the diff (spec 197). This spec is the dispatch target.

## Data Contracts

### Distillation input

A list of per-topic inputs, each carrying: a slug, a title, a summary, and a content body.

### Configuration

Model-call configuration (credentials, model selection, provider routing) threaded into every call.

### Progress reporter

An optional callback taking a one-line human-readable message. Throttle-free, transient, never persisted. Distinct from the debug log.

### Phase output cap and concurrency constants

- The categorize and delta calls use a large output cap (16,384 tokens) and force streaming.
- Each per-topic unit call uses a small cap (4,096 tokens) and does not force streaming.
- Each per-category edge call uses a large cap (32,000 tokens) and forces streaming.
- Unit calls fan out at a fixed concurrency (4) — but that constant is the **hosted-provider** limit. It is passed through the shared provider-aware fan-out limit, which forces it to **one** whenever the active provider is the local-agent one (spec 280 owns why: each call spawns a whole agent CLI process).
- Edge calls fan out at a fixed concurrency (4), passed through the same provider-aware limit and likewise forced to **one** under the local-agent provider.
- A per-topic unit call gets at most three attempts.

### Distilled graph (output)

The four-list bundle defined in spec 196 (categories, topics, units, edges), referentially sound and ready for assembly. It does **not** include the artifact's co-change topic-edge list — that population is derived deterministically outside this layer (spec 197).

### Strict flag (edge phase only)

A per-call flag the edge distiller takes, set on the incremental path and unset on the full path. When set, an unparseable response or a response missing the contracted array **throws** instead of degrading to empty, and the per-category fan-out is given **no** per-item error handler so a thrown category aborts the whole round.

The unit distiller carries **no such flag**. It always runs its bounded retry loop and always throws on exhaustion; whether that throw degrades or aborts is decided purely by whether the *caller's* fan-out supplies a per-item error handler (the full path does, the incremental path does not).

## Behavior

### Response parsing

Given the model's text (possibly undefined):
1. Null on empty input.
2. Trim; strip a leading code fence (optionally tagged) and a trailing fence.
3. If the result does not start with an object-open brace, fall back to the outermost brace span (first open brace to last close brace); null if no valid span.
4. Parse the span as JSON; null on any parse error.

This is lenient by construction — it never throws; it returns null.

### Field coercion helpers

- **String-or-fallback** — return the value if it is a string, else a fallback (default empty string).
- **Blank-or-fallback** — like string-or-fallback but treats a whitespace-only value as missing, so a model that emits an empty title or summary still gets the fallback rather than rendering a blank, unsearchable card.
- **String-array filter** — keep only the string elements of an array; non-arrays become empty.
- **Confidence clamp** — coerce to a number; non-finite becomes a default (0.7); otherwise clamp into the inclusive range [0.5, 1.0].
- **Kinds coercion** — build a canonical kinds list from a raw unit. Accept, in this precedence: a `kinds` array; a stray scalar `kinds`; or a legacy scalar single-kind field (the last is a transitional robustness net for model responses only). Keep only known unit kinds, dedupe preserving first-seen order (the first survivor is primary), and cap at three. Yields an empty list if nothing valid survives.

### Phase 1 (full) — categorize

1. Build a topics block, one line per input topic (`- <slug> -- <title>: <summary>`), or a `(none)` placeholder when empty.
2. Issue the categorize call (large cap, streaming) with the topics block.
3. Parse the response (lenient).
4. **Categories** — for each returned category: take its id (string-or-fallback); drop it when the id is empty or already seen (dedup keep-first, because the viewer keys cards/maps/layout off category id and a repeat would corrupt layout); otherwise keep it with a blank-or-fallback short title defaulting to the id, and a string summary.
5. **Topics** — index the input topics by slug. For each returned topic: drop it when its slug is not a real input slug (hallucination); otherwise emit it with title defaulting to the source title, short title defaulting to the source title and capped at 80 characters, summary defaulting to the source summary, and a category id kept only if it resolves to a known category — otherwise the reserved uncategorized id.
6. **Backfill** — walk the input topics in order. For each, emit the mapped topic if the model produced one (flagging the need for the uncategorized bucket if it landed there), else emit a fallback topic in the uncategorized bucket (slug, source title, capped source title as short title, source summary). This guarantees the graph never silently loses a topic.
7. If any topic landed in the uncategorized bucket and that category is not already present, append it (a fixed label and summary).

### Phase 2 — distil units for one topic (bounded retry)

The per-topic distiller loops up to the attempt cap (three). Each attempt:

1. Issue the unit call (small cap, no forced streaming) with the topic title and the content (or an `(empty)` placeholder when content is empty).
2. Parse the response (lenient) and take its unit field.
3. **If the unit field is an array**, build units from it: for each returned unit take a trimmed local id and a kinds list via the kinds-coercion helper; skip it when the id is empty OR the coerced kinds list is empty. Namespace the local id per topic for global uniqueness, suffixing on a within-topic collision (`<id>`, `<id>-2`, `<id>-3`, …). Emit the unit with a global id of the form `<topic-slug>::<local-id>`, the topic slug, the kinds list, a blank-or-fallback short title defaulting to the local id and capped at 80 characters, a blank-or-fallback summary defaulting to the short title, and anchors built from the string-array filter of the file and commit lists. Then:
   - **At least one usable unit** → return them immediately. No retry.
   - **An explicitly empty array** → return the empty list immediately. A legitimate "no units found" is never retried.
   - **A non-empty array whose every entry was unusable** (no valid id + kinds) → log a warning naming the topic, the raw count, and the attempt number, and **retry**; on the last attempt, **throw** naming the topic, the raw count, and the attempt cap.
4. **If the unit field is not an array** — an unparseable body, or a parseable object simply lacking the field — log a warning naming the topic and the attempt number and **retry**; on the last attempt, **throw** naming the topic and the attempt cap.

The retry exists because these failures are independent per attempt, so a small number of retries collapses the observed per-topic miss rate. There is no strict flag on this phase: the loop's terminal state is always a throw, and the *caller* decides whether that throw degrades or aborts.

### Phase 2 (full) — fan out unit calls

1. Report `extracting units 0/<total>`.
2. Map over the input topics at the fixed concurrency, each calling the per-topic unit distiller. After each completes, increment a done counter and re-report `extracting units <done>/<total>`.
3. **A per-topic error is swallowed by the fan-out's per-item error handler**: log a non-fatal warning, still increment and re-report the counter, and contribute an empty unit list for that topic. (The full path has no prior graph to protect. Supplying this handler is the *only* thing that makes the full path fail-open here.)
4. Flatten the per-topic lists into the global unit list.

### Phase 3 — distil edges for one category batch

Given a batch of units (all from one category):

1. If fewer than two units are in the batch, return an empty edge list **without a model call**.
2. Build a units block, one line per unit in the batch (`- <id> [<topic>] <shortTitle>: <summary>`).
3. Issue the edge call (large cap, streaming) with the units block.
4. Capture whether the stop-reason indicates a max-tokens truncation, and parse the response (lenient).
5. **Strict gate (incremental):** if strict is set and the parsed value's edge field is not an array, **throw**. When the truncation flag is also set, log a warning first explaining that truncation is the usual cause (the cut-off JSON will not parse) and naming the remedy (raise the cap or split the graph). The thrown message names truncation when applicable. (On the full path strict is off — see step 7.)
6. **Non-strict truncation:** if not strict but the truncation flag is set, log a warning that the edges that did parse are kept.
7. Filter edges: for each returned edge, take from, to, and type; skip when from equals to (self-edge), either endpoint **is not a known unit id within this batch**, or the type is not one of the five edge types. Skip a repeated `from|to|type` triple. Emit the survivor with clamped confidence and a string evidence.

Because the known-id set is built from the batch alone, any returned edge pointing outside the batch is dropped — the second of two independent mechanisms that keep typed unit edges inside one category.

### Phase 3 — the per-category fan-out

1. Group the units by their topic's category id. A unit whose topic is absent from the topic list is dropped (defensive — it would be a dangling unit at assembly).
2. Choose the target category ids: on the full path, every category that has units; on the incremental path, only the caller-supplied affected category ids.
3. Run one edge call per target category at the fixed edge concurrency, each over **only that category's units**, and concatenate the per-category results in target order.
4. **Strict propagates to each call.** When strict is set the fan-out is given no per-item error handler, so a thrown category aborts the whole round (the incremental path keeps the prior graph). When strict is unset, a failed category logs a non-fatal warning naming the category and contributes no edges (the full path has no prior graph to keep).

Two properties fall out of this structure rather than from extra logic: each call is bounded by one category's unit count, so no single call grows with the whole graph; and a typed unit edge **cannot** span two categories, because the model never sees two categories at once.

### Full distillation pipeline

1. Report `categorizing <count> topic(s)`; run phase 1; log the result.
2. Run the phase-2 fan-out; log the unit total.
3. Report `distilling intra-category edges (<count> categor(y|ies))`; run the phase-3 fan-out over every category (non-strict); log the edge total.
4. Return the distilled graph (categories, topics, units, edges). It is referentially sound by construction (hallucinated slugs dropped, dangling/self/bad edges filtered, kinds validated, every input topic backfilled), and every edge in it is intra-category.

### Incremental Phase 1 — category delta

1. Build an existing-categories block (`- <id> -- <shortTitle>: <summary>`, or `(none)`) and a changed-topics block (or `(none)`).
2. Issue the delta call (large cap, streaming) with both blocks.
3. Parse the response (lenient).
4. **Fail closed:** if either contracted array (new categories, topics) is missing or non-array, **throw**. An unparseable response, an empty object, or a half-shaped object would otherwise dump every changed topic into the uncategorized bucket over a still-good baseline. (A raw model-call error already throws because the call is awaited.) Two empty arrays are a legitimate response.
5. **New categories** — for each: take the id; drop it when empty, already seen in this delta, or already an existing baseline id; otherwise keep it with a blank-or-fallback short title defaulting to the id and a string summary.
6. **Topics** — index the changed topics by slug. For each returned topic: drop it when its slug is not in the changed set (hallucination or out-of-scope); otherwise emit it with title defaulting to the source title, blank-or-fallback short title defaulting to the source title and capped at 80 characters, blank-or-fallback summary defaulting to the source summary, and a category id kept only if it resolves to an existing-or-new id, else the uncategorized bucket.

### Pure category merge (no model)

Given the baseline categories/topics, the category delta, the current topic inputs, and the changed-slug set, rebuild the category list and topic-to-category assignment:

1. Index the baseline categories by id (keep-first on a duplicated baseline id) and build a normalized-short-title → id map (first occurrence wins; normalization is trim + lowercase).
2. For each delta new category: skip when its id already exists (the existing one wins, keeping its metadata). Otherwise, if its normalized short title matches an existing category's, record a remap from the delta id to that existing id (avoids two cards with the same label, since cards are keyed by id — a delta-only hazard). Otherwise add it.
3. For each current topic: pick the source assignment from the delta if the slug changed, else from the baseline. Resolve its category id through the remap, defaulting to the baseline/delta value, or to the uncategorized id when no source exists. Take short title and summary from the source, or a fallback (truncated current title; current summary) when no source exists. Demote to the uncategorized id when the resolved id does not exist. Emit the topic with the current title (always authoritative), the resolved short title, summary, and category id.
4. If any topic landed in the uncategorized bucket and that category is absent, add it (a fixed label and summary). Empty categories are pruned later at assembly (spec 196).

A topic absent from both delta and baseline gets a minimal fallback so it is never silently dropped.

### Incremental distillation pipeline

Given the input, the field-validated baseline, and the diff:

1. Compute the changed-slug set (dirty ∪ added), the clean-slug set, the current-slug set, and the changed-topic list.
2. **Units** — reuse baseline units whose topic slug is in the **current clean set** (a whitelist, never a "not-dirty" blacklist — a blacklist would drag deleted topics' units back). If there are changed topics, fan out their unit calls at the fixed concurrency with **no per-item error handler**: a throw out of the per-topic distiller (a model error, or a body that survived all its retries) aborts the whole round, so the caller keeps the prior good graph — emitting a topic with zero units over a baseline that had them is data loss, not degradation. Concatenate reused and freshly-distilled units.
3. **Categories** — if there are changed topics, run the delta call and then the pure merge over the baseline and the current topics. Otherwise (pure deletion), keep the baseline categories and the baseline topics filtered to the current slug set.
4. **Edges** — if there are changed topics, recompute edges only for the **affected categories** and then **merge at edge granularity** against the baseline edges (see below). Otherwise (pure deletion), drop any baseline edge whose endpoint no longer exists — **no model call** (removing units can only invalidate edges, never create them).
5. Return the distilled graph.

### Incremental edge merge (keep / drop / recompute per edge)

The edge layer is **not** recomputed in full on the incremental path. Given the merged topic list, the final unit list, and the changed-slug set:

1. **Affected categories** = the set of category ids that, after re-categorization, contain at least one changed topic.
2. **Recompute** fresh edges via the phase-3 fan-out restricted to those affected categories only, with strict on. Every other category's edges are untouched by the model.
3. **Keep** a baseline edge when all of these hold: both endpoint unit ids still exist in the final unit list; **neither** endpoint's topic is in the changed set ("clean–clean"); and the edge is intra-category. Filtering kept edges to intra-category is what guarantees no stale cross-category unit edge survives from an older baseline written before per-category batching.
4. **Take** a fresh edge only when it **touches** a changed topic. A fresh clean–clean edge is dropped in favour of the baseline copy, so links between unchanged units never reshuffle between builds.
5. **De-duplicate** the concatenation of kept-baseline-then-fresh on the `from|to|type` triple, first occurrence winning.

### Progress reporting

The full pipeline reports: `categorizing <n> topic(s)`, then `extracting units <done>/<total>` as each topic resolves (including failed ones, since the error path still bumps the counter), then `distilling intra-category edges (<n> categor(y|ies))`. The incremental pipeline reports `extracting units <done>/<changed-total>` during the changed-topic fan-out, `categorizing <n> changed topic(s)` before the delta call, and `distilling intra-category edges (<n> affected categor(y|ies))` before the affected-category recompute. Both edge messages singularize/pluralize the category noun on the count.

## State Transitions

### An edge response through the parser/strict gate

```
parseable to expected array             ──> sanitized list (batch-scoped endpoints)
parseable, array field missing          ──> [] (lenient) / throw if strict
parseable, array field empty            ──> [] (both paths — legitimate "none")
unparseable                             ──> null→[] (lenient) / throw if strict
unparseable + max_tokens (strict)       ──> throw, message names truncation
```

### A unit response through the retry loop (per topic)

```
array with >=1 usable unit           ──> return units (no retry)
array, explicitly empty              ──> return [] (no retry — legitimate "no units")
array, non-empty, all unusable       ──> warn + retry; throw after the attempt cap
unparseable / array field missing    ──> warn + retry; throw after the attempt cap
```

The throw is then swallowed to `[]` by the full path's per-item error handler, or aborts the round on the incremental path (which supplies none).

### A topic through the full categorize+backfill

```
model emitted it, valid category   ──> kept as-is
model emitted it, bad/absent category ─> uncategorized
model dropped it (backfill)         ──> uncategorized (never lost)
model hallucinated a non-input slug ──> dropped
```

### A topic through the incremental pipeline

```
clean    ──> units reused; baseline category/title kept (stable layout);
             clean–clean intra-category baseline edges kept verbatim
dirty    ──> units re-distilled (no error swallow); re-categorized via delta+merge;
             its category's edges recomputed, fresh edges touching it taken
added    ──> units distilled (no error swallow); categorized via delta+merge;
             its category's edges recomputed, fresh edges touching it taken
deleted  ──> units filtered out; dangling edges dropped (no model)
```

### A unit local id through namespacing

```
first occurrence  ──> <topic>::<id>
second occurrence ──> <topic>::<id>-2
third occurrence  ──> <topic>::<id>-3
```

## Notable Behavior

- **Typed unit edges cannot span two categories.** The edge phase is fanned out per category and each call sees only that category's units, so a cross-category typed edge is structurally impossible — and any returned edge pointing outside the batch is dropped besides. This is what made the artifact's former cross-category unit-edge statistic a constant zero, and why it was removed from the statistics set rather than kept (spec 196). Cross-category coupling is instead carried by the deterministic co-change edge population (spec 197).
- **The full path is fail-open; the incremental path is fail-closed.** Every degradation the full path tolerates (unparseable edge response → empty; per-topic unit failure → empty; failed edge category → no edges) becomes a round-aborting throw on the incremental path, because there a degraded result would overwrite a still-good baseline with data loss. The two paths differ only in the edge phase's strict flag and in whether a per-item error handler is supplied to each fan-out.
- **The unit phase has no strict flag — it has a retry loop.** Three attempts per topic, retrying an unparseable body and a non-empty-but-all-unusable array, warning on each retry, throwing on exhaustion. Fail-open vs. fail-closed is decided entirely by the caller's error handler, not by a flag on the call.
- **An explicitly empty array is never a failure and is never retried.** A topic with legitimately no units returns immediately on the first attempt; a category with no edges parses to an empty array and proceeds. Strict requires the contracted array to be present, not non-empty.
- **`{}` is treated as a failure.** A parseable object missing the contracted array fails the strict edge gate, and is a retryable-then-fatal condition for a unit call — silently degrading it would wipe a layer (a dirty topic's units, or an affected category's edges).
- **Edge truncation is diagnosable.** When a strict edge response is unparseable and the stop-reason was max-tokens, a warning is logged before the throw and the thrown message names truncation — otherwise "graph never updates" gives no clue why. Per-category batching makes this far less likely than a single whole-graph call, since each call is bounded by one category's unit count rather than the graph's.
- **The full path keeps partially-parsed truncated edges.** A non-strict truncated edge response keeps whatever edges parsed and logs a warning.
- **Hallucinated slugs are dropped, dropped topics are backfilled.** The full categorize phase guarantees exactly the input topic set survives — no extra, none missing.
- **Unit ids are namespaced per topic with collision suffixing**, guaranteeing global uniqueness even when the model reuses a local id within a topic.
- **The category merge keeps clean topics stable.** Clean topics keep their baseline category id, short title, and summary, so category ids — and thus the viewer's layout — stay stable across incremental builds.
- **Delta category collisions resolve toward the existing category.** An id collision drops the delta category (existing metadata wins); a normalized-short-title collision folds the delta category into the existing id to avoid duplicate-labelled cards.
- **The current topic title is always authoritative** in the merge, even though the prompt tells the model to keep it unchanged.
- **Incremental edges are merged, not recomputed in full.** Only the categories containing a changed topic are re-run through the model; clean–clean intra-category baseline edges are kept verbatim, only fresh edges that touch a changed topic are taken, and the concatenation is de-duplicated. This is what keeps unchanged links from reshuffling between builds — and it means an incremental round's model cost scales with the affected categories, not the whole graph.
- **A fresh clean–clean edge loses to the baseline copy.** When a recomputed category emits an edge between two unchanged topics, the baseline's version wins and the fresh one is discarded, so confidence/evidence on untouched links stay stable.
- **A kept baseline edge must be intra-category.** A baseline written before per-category batching may still hold cross-category edges; the keep filter drops them, so one incremental build is enough to purge them.
- **Pure deletion runs no model call** in either the units, categories, or edges phase.
- **Fewer than two units in a category batch skips that category's edge call entirely** — no model call, no edges from it, on both paths.
- **Confidence is clamped into [0.5, 1.0]** with a 0.7 default for a non-numeric value.
- **The unit call is the only phase that does not force streaming.** Categorize, delta, and edges all force streaming; the small-cap per-topic unit call does not.
- **Units carry a coerced multi-label kinds list**, built by the kinds-coercion helper (array, stray scalar, or legacy single-kind field, in that precedence; deduped, first-seen-order, capped at three).
- **A non-empty units response yielding zero usable units is a failure on both paths.** It throws — on the incremental path to protect the prior good graph, on the full path to be caught and degraded by the fan-out's per-topic error handler. Only an explicit empty array is treated as legitimate "no units".

## Shared Behavior

- **The model-call envelope.** Every phase issues one call through the shared LLM client and reads back its text and its stop-reason (used only to detect a max-tokens truncation on the edge call). Credential resolution, provider routing, streaming watchdogs, and model-id resolution are specs 8-10. The pipeline inherits all of that for free.
- **Prompt templates.** Each phase is filled from one of four named templates (categorize, category-delta, units, edges). The template prose and versioning are spec 11. The edges template is written for a single category's units and explicitly declares cross-category relationships out of scope for the call, matching this layer's per-category fan-out; the units template asks for load-bearing units only rather than a fixed count. Changing the output shape of any of these templates is a breaking shape change that must bump the graph schema-version constant (spec 196).
- **The uncategorized bucket.** The reserved uncategorized category id is the same constant used by the empty-category prune in assembly (spec 196); the full backfill and the incremental merge both bucket into it.
- **The distilled-graph output.** What this layer emits is consumed verbatim by assembly (spec 196): the edge normalization, referential validation, join, prune, and rollups all run downstream. The incremental path is built to always emit a referentially-sound graph so assembly never throws on it.
- **Cross-category coupling is somebody else's job.** Because this layer can only produce intra-category typed edges, the artifact's cross-category structure comes from the deterministic co-change topic-edge population derived by the construction layer (spec 197) from the file anchors this layer's units carry. This layer neither derives nor sees that population.
- **The dispatch decision.** The construction layer (spec 197) decides full vs. incremental, supplies the baseline and the diff, and catches a thrown round non-fatally to keep the last good graph.
