# 197. Knowledge Graph Construction

## Topic Statement

Assemble a repo's knowledge-graph artifact from its topic knowledge base by reading topic index entries and pages, computing per-topic content and metadata fingerprints, and choosing among skip, no-model reassemble, full distillation, and incremental fingerprint-diff update before joining, validating, and writing the result.

## Scope

**In scope:**
- The storage-capability gate that decides whether a graph is built at all.
- Pinning every read to the on-disk folder layer (not the passed storage) and the loop-avoidance rationale.
- Building the per-topic distillation inputs and the per-topic source-metadata join map from index entries and pages, including all field-fallback chains.
- The two per-topic fingerprints (content fingerprint over the exact model inputs; metadata fingerprint over the join fields the content fingerprint excludes) and exactly which fields each covers.
- The derivation of the topic-level co-change edge list this layer computes itself and hands to assembly: its two parameters and their production values, the over-shared-file rule, the cross-category pairing restriction, the intersection and ordering rules, what bounds the output (and what does not), and which build paths supply it.
- The baseline-usability decision: when a prior artifact is reusable as the incremental baseline vs. when there is no usable baseline.
- The empty-index branch (all topics deleted → write an empty graph) and its "nothing ever built" exception.
- The four-way build decision: true skip, no-model reassemble, incremental, full.
- The diff partition (clean/dirty/added/deleted) and how it routes to the incremental distiller.
- The deliberate non-recovery policy: an incremental failure is not caught here and does not fall back to a full rebuild.
- The result record returned to callers and the call sites that invoke this non-fatally.

**Out of scope (boundaries):**
- The graph data model, validation, edge normalization, join, rollup, and assembly mechanics (spec 196) — this spec calls assembly and passes it the fingerprint maps and the co-change edge list, but the shapes, the co-change edge's nine validation rules, and the invariants live there.
- The model calls inside full/incremental distillation and their parsing/sanitizing (spec 198) — this spec decides which distiller to call and on what inputs; the calls themselves are spec 198.
- How the artifact file is serialized, written atomically, and read back (spec 199).
- How the topic index and topic pages are produced and persisted (the topic ingest pipeline, spec 152; topic index and page storage, spec 156).
- The storage providers themselves (orphan-branch, folder, dual-write) and how the folder layer is located.
- Credential resolution and the wider compile/queue surfaces that call this.

## Data Contracts

### Inputs to a build

- A working directory.
- A storage handle (the active provider for the repo).
- A model-call configuration (credentials, model selection, provider routing).
- Options: an optional injectable timestamp (for deterministic tests) and an optional one-line progress reporter.

### Folder root

The per-repo Memory Bank root. Taken from the storage handle's folder root when present, else the working directory. All reads and the artifact write are rooted here.

### Distillation topic input (per topic)

- A slug (the topic's stable slug).
- A title (from the index entry).
- A summary (from the index entry).
- A content body (from the topic page, or empty string when the page is missing).

### Source-metadata join entry (per topic)

- Source branches — the page's related branches, else the index entry's related branches, else empty.
- Source commits — distinct commit references derived from the page's source refs, else the index entry's source refs, else empty (see below).
- Overview — the first prose paragraph of the page body, capped.
- Full body — the page content verbatim (empty string when missing).

### Commit-reference derivation

From a list of source refs, keep only the summary-type refs, dedup on the **full** identifier (two distinct commits can share an 8-character prefix; the prefix is display-only), preserve first-seen order, and emit one reference per surviving ref carrying the 8-character prefix as its hash and an empty message.

### Content fingerprint (per topic)

A hash over exactly the inputs the distiller consumes: the index title, the index summary, and the page content, separated by NUL bytes to keep field boundaries unambiguous. Keyed by topic slug.

### Metadata fingerprint (per topic)

A hash over the join fields the content fingerprint deliberately excludes: the comma-joined source branches and the comma-joined source-commit hashes, NUL-separated. Keyed by topic slug. These are not model inputs, so they can drift while the content fingerprint stays put (a new commit folded into a topic whose summary regenerated identically; a branch rename). The rolled-up commit count is derived from them. Overview and full body are derived from content, so they are already covered by the content fingerprint.

### Repo display name

The basename of the folder root, computed once per build. Passed into assembly as the artifact's stamped repo display name (the viewer's breadcrumb-root label — see spec 196). Also participates in the true-skip decision below.

### Co-change topic-edge list (builder-computed)

The list of topic-level co-change edges (shape and validation: spec 196), derived by this layer from the distilled units and topics and handed to assembly as its seventh argument. It is the **third** builder-computed input to assembly, alongside the two fingerprint maps and the repo display name — computed here, stored verbatim there. It is never read back from a prior artifact.

Two derivation parameters exist, both with a single fixed production value:

- **Over-sharing threshold — production value 3.** A file touched by that many or more distinct categories is discarded before any pairing happens.
- **Minimum shared-file count — production value 1.** A topic pair emits an edge only when its surviving shared-file intersection is at least this large.

Neither parameter is reachable from any shipped surface: no configuration field, environment variable, or command flag sets either one, and no build path overrides them. The values above are the only values the derivation ever runs with.

### Topic diff partition

Comparing the baseline content-fingerprint map against the freshly-computed one yields four buckets:
- **dirty** — slugs present in both but with a changed fingerprint.
- **added** — slugs present now, absent from the baseline.
- **deleted** — slugs in the baseline, absent now.
- **clean** — slugs present in both with an unchanged fingerprint.

### Build result

- A built flag.
- An optional reason string (present when nothing was built).
- An optional mode (`full` or `incremental`; absent when nothing was built).
- Optional counts: topics, units, edges.
- An optional artifact path.

## Behavior

### Storage-capability gate

If the storage handle does not advertise a folder-rendering capability (i.e. it is orphan-branch-only), log and return immediately with built=false and a reason naming the missing folder layer. The graph needs the folder layer for both the artifact and the viewer.

### Reader pinning

Construct a fresh folder-rooted reader at the folder root and route every topic read through it — never through the passed storage handle. Rationale captured in code: the artifact (and thus the incremental baseline) lives in and is derived from the folder; in dual-write mode the passed storage reads the orphan branch. If the two trigger paths read different sources, their topic summaries drift and each recomputes the other's fingerprints as dirty, re-distilling in a loop. Pinning every build to the folder keeps the baseline self-consistent. The folder is guaranteed populated here because dual-write mirrors to it during the ingest that precedes this build, and the folder-layer gate above guarantees a folder exists.

### Read the index and resolve the baseline (before the empty-index gate)

1. Read the topic index through the pinned reader.
2. Read the prior artifact from the folder root (returns null when missing or unparseable).
3. Resolve the baseline distilled graph: it is reusable only when **all three** hold — the prior artifact's schema version equals the current schema-version constant, its content-fingerprint map passes the fingerprint-map predicate, and it field-validates via the restore step. Any of these failing yields a null baseline (no usable starting point → a one-time full distillation that heals it, distinct from a recoverable incremental failure which keeps the old graph). The baseline is resolved **before** the empty-index gate so an empty index over a non-empty baseline is correctly read as "the last topic was just deleted", not "nothing was ever built".

   The schema-version equality check is exact, not a floor: an artifact at the previous version is as unusable as a corrupt one. Because the constant was bumped to 4 (spec 196), **every repository whose stored artifact is still at version 3 resolves a null baseline on its next build and takes a one-time full re-distillation** — the full model cost, once, per repository. After that write the artifact carries the new version and incremental builds resume as normal.

### Empty-index branch

When the index has zero topics:
- If a usable baseline exists and it had one or more topics: this is the deletion-to-zero case. Assemble an empty graph (no categories/topics/units/edges, empty fingerprint maps) — **no model call**, and **no co-change list is supplied at all**, so assembly's default leaves the artifact carrying an empty one — report the write step, write it (overwriting the stale artifact so the viewer stops showing phantom topics), and return built=true, mode=incremental, all counts zero, with the artifact path. A bare skip here would leave the last good graph on disk forever.
- Otherwise (no usable baseline, or a baseline that is already empty — i.e. nothing was ever built): log and return built=false with reason "no topics".

### Build the per-topic inputs and fingerprints

For each index entry, in order:
1. Read the topic page through the pinned reader (may be null).
2. Take content from the page, else empty string.
3. Append a distillation topic input (slug, index title, index summary, content).
4. Compute and store the content fingerprint for the slug.
5. Build the source-metadata join entry (branches with page→index→empty fallback; commit refs derived from page refs → index refs → empty; overview = first paragraph of content; full body = content).
6. Compute and store the metadata fingerprint for the slug.

### Overview extraction

The overview is the first block of the content that, after trimming, is non-empty and does not begin with a heading marker, capped to a fixed length (600 characters). Blocks are split on blank-line boundaries. When no qualifying block exists, the overview is empty.

### Co-change topic-edge derivation

Between having a distilled graph and calling assembly, this layer derives the co-change edge list itself. The derivation is pure: no model call, no storage read, no git access, no clock. Its only inputs are the distilled unit list and the distilled topic list.

In execution order:

1. **Resolve each topic slug to its category** from the distilled topics. A duplicated slug resolves to its last occurrence.
2. **Build a file → category-set map.** For every unit whose topic slug resolves to a category, every path string in that unit's file anchors gains that unit's topic's category. A unit whose topic is not in the graph is skipped entirely and contributes nothing.
3. **Discard over-shared files.** Any file whose category set has reached the over-sharing threshold (three or more distinct categories) is dropped outright. It contributes to no pair.
4. **Build a topic slug → surviving-file-set map** — the union of each topic's units' non-discarded file anchors.
5. **Pair topics.** Walk every unordered pair of distinct topics exactly once, in the order the topics appear in the distilled topic list. A pair is skipped when either side has no surviving files, and skipped when **both topics belong to the same category** — the pairing is restricted to **cross-category** pairs.
6. **Intersect.** The shared-file list is the intersection of the two topics' surviving-file sets, built by walking the first topic's files in insertion order and testing membership in the second's. The pair is skipped when the intersection is smaller than the minimum shared-file count.
7. **Sort the shared-file list** into plain ascending string order.
8. **Canonicalize the endpoints** by string comparison: the lexicographically smaller slug becomes the from-endpoint, the other the to-endpoint.
9. **Emit** the edge with the fixed kind literal, the sorted shared-file list, and a weight equal to that list's length. No semantic type is set.

**What is compared — and what is not.** A "shared file" is **exact string equality** between two path strings taken verbatim from units' file anchors, which are whatever the model asserted for that topic. There is **no path normalization, no case folding, and no path-separator conversion**: two spellings of the same file are two different files here, and neither contributes to the other's intersection. The units' commit anchors are never read.

**What bounds the output.** Only the two parameters above. There is **no** minimum-commit threshold, **no** minimum-unit threshold, **no** per-topic fan-out cap, and **no cap on the total number of emitted edges** — nothing ranks, prunes, or truncates the result, and there is no tie-breaking because there is no ranking. Each unordered pair is visited exactly once by construction, so no de-duplication pass is needed either.

**Output ordering.** The emitted list follows the pair-scan order over the input topic list. It is **not** sorted by weight, by slug, or by anything else. Only the shared-file list within an edge, and the from/to assignment, are canonically ordered — which is precisely what makes the canonical-order and duplicate-pair validation rules in spec 196 hold by construction.

**Derived consequence.** A surviving (non-discarded) file is touched by at most two distinct categories, and an emitted pair spans exactly two different categories. Therefore **every shared file on an emitted edge is touched by exactly the two endpoint categories and no third**, and a file spanning three or more categories contributes to nothing at all.

### Build decision

With a non-empty index:

**No usable baseline → full.** Run the full distiller over all topic inputs, then assemble and write.

**Usable baseline → diff.** Partition the current content fingerprints against the baseline's. Then:

1. **No content change at all** (dirty, added, and deleted all empty):
   - Resolve the baseline's metadata-fingerprint map through the fingerprint-map predicate (null when absent or malformed).
   - The true-skip now also requires the baseline artifact's stamped repo display name to equal the current one.
   - If that map exists and equals the freshly-computed metadata map (same keys, same values) AND the baseline's stamped repo display name equals the current one: **true skip** — log, return built=false with reason "no changes" and the topic count. No model call, no write.
   - Otherwise (metadata drifted, the baseline metadata map is missing/corrupt, or the repo display name changed): **no-model reassemble** — reuse the baseline distilled layer verbatim, **re-derive the co-change edge list from that reused layer**, re-join the fresh source metadata, assemble with the fresh fingerprint maps, the current repo display name, and the re-derived co-change list, report the write step, write, and return built=true, mode=incremental with the assembled counts. This refreshes the on-disk source/commit-count fields (and the stamped repo display name) without any model call. A missing/corrupt baseline metadata map counts as drifted, so one reassemble heals it.
2. **Some content change** (dirty ∪ added ∪ deleted non-empty): log the partition counts, set mode=incremental, and run the incremental distiller with the topic inputs, the restored baseline, and the diff. Then assemble and write.

After a full or incremental distillation: derive the co-change edge list from the distilled graph; assemble the distilled graph with the source map, the timestamp, the repo display name, both fresh fingerprint maps, and the derived co-change list; report the write step; write the artifact; log the rollup counts and elapsed time; and return built=true with the mode and the assembled counts.

So the co-change list is derived on **three** of the four build paths — the full path, the incremental path, and the no-model reassemble path — and is deliberately not supplied on the empty-graph path. There is no path on which a co-change list is carried over from a prior artifact.

### Deliberate non-recovery on incremental failure

An incremental failure — a model error in the delta/units/edges calls, or a validation throw from assembly — is **not** caught here to fall back to a full rebuild. It bubbles to the caller's non-fatal try/catch, which keeps the last good artifact and retries on the next trigger. Rationale captured in code:
- A full re-run pays every model call again — exactly what incremental avoids; one transient hiccup should not trigger a large rebuild.
- On a transient model error, a full rebuild hits the same model and likely fails too, burning double the budget.
- A validation throw on the incremental path can only mean a merge bug (the incremental path is built to always emit a referentially-sound graph); auto-full would mask it and still pay incremental + full every build. Keeping the old graph is cheap, safe, and surfaces the bug.

"No usable baseline" (handled before the diff) is a different case: there is no starting point, so a one-time full is correct — that is not a fallback.

### Callers (non-fatal)

This build is invoked, non-fatally, right after the visible-wiki render in the manual compile paths (single-repo compile, multi-repo sweep) and after a drain in the queue worker. A throw degrades to "no graph this run" and never fails the compile/drain. The queue-worker invocation deliberately keeps the old graph and never auto-falls-back to a full rebuild, consistent with the policy above.

## State Transitions

### A build run

```
INITIAL ─(orphan-only storage)──────────────> SKIP (built=false, "orphan-only")
INITIAL ─(index empty, baseline had topics)─> WRITE EMPTY GRAPH (no model)
INITIAL ─(index empty, no/empty baseline)───> SKIP (built=false, "no topics")
INITIAL ─(no usable baseline)───────────────> FULL distill → assemble → write
INITIAL ─(baseline; no content change; meta same)──> SKIP (built=false, "no changes")
INITIAL ─(baseline; no content change; meta drift)─> NO-MODEL REASSEMBLE → write
INITIAL ─(baseline; content changed)────────> INCREMENTAL distill → assemble → write
ANY distill/assemble throw ─────────────────> propagates to caller (keep last good graph)
```

### A topic across baseline vs. current (per slug)

```
in baseline + same content fingerprint  ──> CLEAN  (units reused verbatim; baseline category kept)
in baseline + changed content fingerprint ─> DIRTY (re-distilled; re-categorized via delta)
not in baseline                           ──> ADDED (distilled; categorized via delta)
in baseline, gone now                     ──> DELETED (units filtered out; dangling edges dropped)
```

### Metadata-only drift on an otherwise-clean graph

```
content fingerprints all match
  ├─ metadata fingerprints match (same keys+values) AND repo display name unchanged ──> TRUE SKIP (no write)
  └─ metadata fingerprints differ / map missing / repo display name changed        ──> NO-MODEL REASSEMBLE (write fresh metadata/name)
```

## Notable Behavior

- **Reads are pinned to the folder, never the passed storage.** This prevents a dual-write repo from oscillating between the orphan-branch and folder views and re-distilling in a loop.
- **The baseline is resolved before the empty-index gate.** This is what lets "all topics deleted" overwrite the stale graph with an empty one instead of skipping and leaving phantom topics.
- **The empty-graph-on-delete path runs no model call** yet still writes — the only write path that is both model-free and produces a strictly smaller graph.
- **No-model reassemble exists for join-metadata drift, and also for repo-name drift.** Branches and commit refs are not model inputs, so they can change while every content fingerprint is unchanged. The metadata fingerprint catches that and triggers a write-only refresh so on-disk commit counts never go stale. Likewise, a repo folder renamed changes the stamped repo display name with no content change — a write-only refresh keeps the breadcrumb-root label current, no model call.
- **A missing or corrupt baseline metadata map counts as drift, not as a skip.** This guarantees an older artifact (written before metadata fingerprints existed) heals on the next build rather than ever producing a false skip.
- **"Co-change" describes what the signal approximates, not what it is computed from.** The name actively misleads: **no** commit history, diff, or commit-anchor data enters the derivation. The sole input is the model-asserted file anchors on units, compared as exact strings with no normalization of any kind. Nothing in this layer consults git to produce a co-change edge.
- **The co-change derivation is recomputed on every build that writes, and never restored.** Restore (spec 196) deliberately omits it, so there is no path on which an older co-change list survives into a new artifact — including the no-model reassemble path, which re-derives it from the reused baseline distilled layer.
- **The co-change derivation has no output bound.** Only the over-sharing threshold and the minimum shared-file count constrain it. A repository with many cross-category topics sharing anchors emits proportionally many edges; there is no top-N, no per-topic degree limit, and no total cap.
- **The co-change parameters are not tunable at runtime.** They exist as named values with fixed production settings; no shipped surface exposes them.
- **The schema-version bump forces exactly one full re-distillation per repository.** The version check is equality, so an existing version-3 artifact is treated as no baseline at all. This is the "no usable baseline" path, not a failure — it heals in one build.
- **Commit refs dedup on the full identifier, not the 8-character prefix.** Two commits sharing a prefix are counted separately; the prefix is display-only.
- **Source branches and commit refs fall through page → index → empty.** A present page that omits those fields still picks up the index entry's values.
- **The overview skips a leading heading.** The first non-heading, non-empty block becomes the overview; a leading markdown heading is bypassed.
- **No usable baseline triggers a one-time full, which is not a fallback.** It is distinguished from a recoverable incremental failure (which keeps the old graph) precisely because there is no starting point to build from.
- **Incremental failures are never auto-promoted to full.** They bubble out; the last good graph stays on disk and the next trigger retries.
- **The timestamp is injectable** for deterministic tests; otherwise the real clock is used.

## Shared Behavior

- **Schema-version and restore gating.** The baseline-usability decision relies on the schema-version constant, the restore field-set check, and the fingerprint-map predicate — all defined in spec 196. A version mismatch short-circuits to full before restore is even attempted.
- **Assembly and the builder-computed inputs.** This layer computes both fingerprint maps, the repo display name, and the co-change topic-edge list, and hands all of them to assembly, which stores them verbatim on the artifact. The co-change edge's shape and its nine validation rules — including the ones this derivation satisfies by construction — plus the join, validation, edge normalization, prune, and rollups are all spec 196. A co-change edge that fails validation makes assembly throw, which this layer does not catch.
- **The two distillers.** The full and incremental distillation calls (and their fail-open vs. fail-closed policies) are spec 198. This layer only chooses which to call and on what inputs.
- **Artifact read/write.** Reading the prior artifact as the baseline and writing the new one are spec 199; this layer treats them as a null-tolerant read and an atomic write returning the path.
- **Topic index and pages.** The index entries and topic pages consumed here are produced and persisted by the topic ingest pipeline (spec 152) and the topic index/page storage (spec 156).
