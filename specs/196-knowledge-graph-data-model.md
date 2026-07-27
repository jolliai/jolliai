# 196. Knowledge Graph Data Model

## Topic Statement

Define the node/edge/entity shapes of the knowledge graph, the referential-integrity invariants every graph must satisfy, and the deterministic edge-deduplication and join/rollup rules that turn a validated distilled graph into the final artifact a viewer consumes.

## Scope

**In scope:**
- The four entity types of the distilled (pre-join) graph: categories, topics, units, edges — their required fields and value domains.
- The fixed enumerations: the unit-kind set, the edge-type set, and which edge types are symmetric (undirected).
- The second, structurally distinct edge population the final artifact carries — topic-level co-change edges: their shape, their dedicated validator, and the fact that they are NOT part of the distilled subset recovered as an incremental baseline.
- The per-topic source-metadata join shape supplied by the caller, and the final merged shapes (graph category, graph topic) that extend the distilled shapes with joined and rolled-up fields.
- The rollup statistics (per-topic, per-category, and graph-wide edge classification).
- The referential-integrity validation: what makes a distilled graph un-shippable.
- The two pure edge-normalization passes (symmetric collapse; generic-relationship subsumption) and the order they run in.
- The assembly step that ties validation, normalization, join, prune, and rollup together and stamps the schema version and the repo display name.
- The field-set restore that recovers the distilled subset from a previously-emitted graph for reuse as an incremental baseline, and the predicate that gates a fingerprint map as usable.
- The graph-wide schema-version constant and the rule governing when it must change.

**Out of scope (boundaries):**
- How the distilled graph is produced (the model calls and their parsing — spec 198).
- How the caller obtains the per-topic source metadata, computes content/metadata fingerprints, derives the co-change topic-edge list it hands to assembly, and decides full vs. incremental (spec 197).
- How the final artifact is serialized, written, and read back (spec 199).
- The incremental category-merge that produces a reassigned category/topic layer (its rules are inputs to assembly; the merge itself is described in spec 197/198 as a pre-assembly producer). This spec documents only the shapes it produces and consumes.
- The viewer runtime that renders the artifact (it carries a thin mirror of the edge-dedup logic only to clean up artifacts written before normalization existed; once a graph is rebuilt that mirror is a no-op).

## Data Contracts

### Fixed enumerations

- **Unit kinds** — a fixed set of seven: a deliberate-tradeoff kind, a how-it-works kind, a bug/gotcha-resolved kind, a hard-limit kind, a surprising-pitfall kind, an explicitly-out-of-scope kind, and a project-wide-norm kind. (In this spec: `decision`, `mechanism`, `fix`, `constraint`, `gotcha`, `non-goal`, `convention`.) The first three were the original set; the other four were added to stop overloading the deliberate-tradeoff (`decision`) kind. A unit carries an ORDERED, deduplicated list of these kinds, length one to a fixed maximum of three: the first entry is the PRIMARY kind (drives display colour), the rest are secondary labels.
- **Edge types** — exactly five: a builds-on relationship, a downstream-consequence relationship, a replaces/obsoletes relationship, a conflict relationship, and a generic weak-association relationship. (In this spec: `extends`, `caused-by`, `supersedes`, `contradicts`, `related-to`.)
- **Symmetric edge types** — the subset of edge types whose two directions state the same fact: the generic-association type and the conflict type. The other three are directed. This subset drives the symmetric-collapse normalization.
- **Uncategorized category id** — a single reserved category id used as the catch-all bucket for any topic that resolves to no real category. Shared by every producer so they all bucket the same way.
- **Maximum kinds per unit** — three.

### Distilled category

- An id (string, the stable key the viewer keys layout off of).
- A short title (string, a display label).
- A summary (string, one sentence).

### Distilled topic

- A slug (string, the stable per-topic key).
- A short title (string).
- A summary (string, one sentence).
- A title (string, the full human title).
- A category id (string, must resolve to a category).

### Unit anchors

Two string lists grounding a unit in the codebase/history:
- A list of file paths.
- A list of commit identifiers.

### Distilled unit

- An id (string, globally unique across the whole graph).
- A topic slug (string, must resolve to a topic).
- A kinds list (an ordered, deduplicated, non-empty list of at most three unit kinds; the first is the primary and drives colour).
- A short title (string).
- A summary (string).
- Anchors (the two-list shape above).

### Graph edge

- A from-endpoint (string, a unit id).
- A to-endpoint (string, a unit id).
- A type (one of the five edge types).
- A confidence (number).
- An evidence string (one sentence).

### Co-change topic edge

A second, structurally distinct edge population. It lives on the **final artifact only** — it is not part of the distilled graph, is not produced by the model layer, and is never touched by either edge-normalization pass. Its endpoints are **topic slugs**, not unit ids:

- A from-endpoint (string, a topic slug; `fromTopic`).
- A to-endpoint (string, a topic slug; `toTopic`).
- A fixed kind literal (`kind`, whose only permitted value is `co-change`).
- A shared-file list (`sharedFiles`, a non-empty string list of file paths).
- A shared-file count (`sharedFileCount`, a number that must equal the shared-file list's length).
- An optional semantic type (`semanticType`, one of the five edge types).

The shared-file count is this population's **only** weight. There is no confidence, no normalization, and no inverse-document-frequency or other statistical weighting on a co-change edge.

**The optional semantic type is declared but never populated.** No build path sets it, so every emitted co-change edge omits it; a consumer that branches on its presence is unreachable for produced data. It exists only as a forward-compatible slot the validator will accept.

Despite the name, this population carries no version-control information: its derivation (spec 197) reads only the model-asserted file anchors on units. Nothing about it is derived from commit history or diffs.

### Distilled graph

The pre-join, pre-validation bundle: a list of categories, a list of topics, a list of units, a list of edges. This is exactly what the model layer emits and what assembly consumes.

### Per-topic source metadata (join input)

Supplied by the caller, keyed by topic slug:
- A list of source branch names.
- A list of source commit references, each carrying a hash and a message.
- An overview string (a short prose lead-in).
- A full body string (the verbatim topic page body, surfaced in the viewer's reader drawer).

### Graph category (final)

Everything a distilled category has, plus three rolled-up counts: topic count, unit count, commit count.

### Graph topic (final)

Everything a distilled topic has, plus:
- The four joined source-metadata fields (branches, commits, overview, full body).
- A derived wiki-file name (a deterministic string of the form `topic--<slug>.md`).
- Two rolled-up counts: unit count, commit count.

### Graph statistics

Seven graph-wide counts: number of categories, topics, units, and unit edges; two unit-edge classifications — intra-topic edges (both endpoints in the same topic) and cross-topic edges (endpoints in different topics); and the co-change topic-edge count (`coChangeTopicEdgeCount`).

The set is still seven counts, but its **membership changed**: the former cross-category classification (endpoints in topics belonging to different categories) was REMOVED and the co-change count was ADDED in its place. Unit-edge classification is therefore **binary** — every unit edge is either intra-topic or cross-topic, and no category-level classification of unit edges is computed at all. The removal is grounded upstream: typed unit edges can no longer span two categories (spec 198), so that count had become a constant zero.

### Knowledge graph (final artifact)

- A schema version (the graph-wide constant; see below).
- A generated-at timestamp (caller-supplied, for determinism in tests).
- A source description string (a fixed human-readable provenance label).
- A per-topic content-fingerprint map (keyed by slug; the incremental baseline — see spec 197). Defaults to an empty map.
- A per-topic metadata-fingerprint map (keyed by slug; covers the join fields the content fingerprint deliberately excludes — see spec 197). Defaults to an empty map.
- The statistics block.
- The list of final graph categories.
- The list of final graph topics.
- The list of units (carried verbatim from the distilled graph).
- The list of edges (carried after normalization).
- The list of co-change topic edges (`coChangeTopicEdges`), emitted verbatim from the assembly argument and last in the object. Defaults to an empty list when assembly is not given one.
- An optional repo display name (the folder-root basename, stamped at build time; consumed by the viewer as the breadcrumb-root label). Omitted when the builder supplies an empty name, and absent on artifacts built before it existed — optional, and its addition did NOT bump the schema version.

### Schema version constant

A single integer stamped onto every emitted artifact. Its governing rule: because units, edges, categories, and topics are embedded verbatim, ANY change to their output shape — a new field, a changed kind/edge-type value, a changed id format — is a breaking shape change and must bump this constant. It is the primary and only complete guard against an incremental build reusing a structurally-incompatible baseline; in particular it is the only thing that catches a newly-added field (a field-set check cannot detect a field it does not yet know about — see the restore step below). Any future change to either fingerprint map's shape, or any new top-level field, must bump it again.

The current value is **4**. The most recent bump (3 → 4) accompanied two top-level output-shape changes made together: adding the co-change topic-edge list, and swapping one graph-wide statistic for another (the cross-category classification out, the co-change count in). The bump before that accompanied converting the single-kind field to the ordered kinds list and expanding the kind set from three to seven (an output-shape change on units). The two fingerprint maps were introduced together at that earlier version. The repo-display-name addition did NOT bump it — it is optional and backward-compatible. For the runtime consequence of a bump on repositories holding an older artifact, see spec 197.

## Behavior

### Referential-integrity validation

Given a distilled graph, produce a (possibly empty) list of human-readable error strings — never throw. A non-empty result means the graph must not ship. The checks, in order:

1. Build the set of known category ids and the set of known topic slugs.
2. For each topic whose category id is not a known category id: record an "unknown categoryId" error.
3. Walk units, building the set of unit ids as it goes. For each unit:
   - If its id was already seen: record a "duplicate unit id" error (the first occurrence is still added to the known-id set).
   - If its topic slug is not a known topic slug: record an "unknown topicSlug" error.
   - If its kinds list is not canonical — a non-empty, deduplicated list of at most three, every member a known unit kind — record an "invalid kinds" error.
4. Walk edges, keeping a seen set of `from|to|type` keys. For each edge:
   - If its from-endpoint is not a known unit id: record an "edge from unknown unit" error.
   - If its to-endpoint is not a known unit id: record an "edge to unknown unit" error.
   - If its type is not one of the five edge types: record an "invalid type" error.
   - If its `from|to|type` key was already seen: record a "duplicate edge" error.

**Notable:** the duplicate-edge key is the ordered triple `from|to|type`. It cannot see a symmetric duplicate whose endpoints are reversed (`a|b|related-to` vs `b|a|related-to`) — that class of duplicate is removed by the symmetric-collapse pass before validation runs, so it never reaches this check.

### Co-change topic-edge validation

A separate validator over the co-change edge list and the distilled topic list. Like referential-integrity validation it produces a (possibly empty) list of human-readable error strings and **never throws**. Nine rules, applied per edge in this order:

1. The kind is not the fixed `co-change` literal.
2. The from-endpoint is not a known topic slug.
3. The to-endpoint is not a known topic slug.
4. The two endpoints are the same slug (a self-edge) — **else**, when they differ, the from-endpoint sorts after the to-endpoint (non-canonical endpoint order). These two are mutually exclusive: a self-edge is never also reported as non-canonical.
5. Both endpoints' topics belong to the **same** category. Co-change edges are cross-category only.
6. The shared-file list is not an array, or is empty.
7. The shared-file count does not equal the shared-file list's length.
8. A semantic type is present but is not one of the five edge types. (An absent semantic type is always fine — and is the only case produced data exercises.)
9. The endpoint pair was already seen on an earlier edge in the list (a duplicate pair).

The derivation in spec 197 satisfies rules 4, 5, and 9 by construction, so on produced data this validator is a guard against a hand-edited or future-producer artifact rather than a live filter.

### Symmetric-edge collapse

A pure, order-preserving pass over a list of edges that collapses each symmetric edge to one edge per unordered endpoint pair (per type):

1. Pass one — for every edge of a symmetric type, compute an unordered pair key (the two endpoints sorted, plus the type). Track the winning edge per key: keep the higher-confidence edge; on a tie, keep the first occurrence.
2. Pass two — emit every edge in original order, but drop a symmetric edge unless it is the recorded winner for its key.

Directed (non-symmetric) edges pass through untouched and in place. Three-or-more duplicates of one symmetric pair collapse to the single highest-confidence edge.

### Generic-relationship subsumption

A pure, order-preserving pass that drops a generic-association edge whenever a more specific typed edge already links the same unordered unit pair:

1. Collect the unordered endpoint-pair keys of every non-generic edge.
2. Emit every edge except a generic-association edge whose unordered pair is in that set.

Rationale captured in code: the generic type carries no information a specific edge between the same pair does not already imply; rendering both would draw two redundant lines. Confidence is irrelevant — a higher-confidence generic edge is still dropped in favor of any specific one. Two genuinely-distinct specific edges on one pair are both kept (only the generic type is ever dropped). The match is on the unordered pair, so a directed specific edge subsumes the generic type in either orientation.

### Assembly

Given a distilled graph, a per-topic source-metadata map, a generated-at timestamp, a repo display name, the two (defaulted-to-empty) fingerprint maps, and — as a seventh argument, also defaulted to empty — a co-change topic-edge list, produce the final artifact:

1. **Normalize edges first** — run symmetric-collapse, then generic-subsumption, over the distilled edges. All downstream steps (validation, stats, emit) use this cleaned edge list, so the artifact never carries the redundant duplicates. The co-change list is untouched by both passes.
2. **Validate** the distilled graph with the cleaned edges substituted in, **and** run the co-change topic-edge validator over the supplied co-change list against the distilled topics. Union the two error lists. If the union is non-empty, **throw** with a message naming the error count and joining the errors. (Callers invoke assembly non-fatally, so a throw degrades to "no graph this run" rather than failing the wider operation.) A bad co-change edge is therefore as fatal to a build as a dangling unit edge.
3. **Join topics** — for each distilled topic, attach its source metadata if present, else attach empty defaults (empty branch list, empty commit list, empty overview, empty body). A topic absent from the source map is still rendered. Derive the wiki-file name from the slug. Initialize both rollup counts to zero.
4. **Topic rollups** — count units per topic by topic slug; set each topic's unit count from that (zero when none), and its commit count from the length of its joined source-commit list.
5. **Category prune + rollups** — for each distilled category, gather the topics referencing it and compute topic count, summed unit count, summed commit count. Then **drop any category with zero topics**. (After validation every topic's category id resolves to a real category, so a zero-topic category is unreferenced and safe to remove. This is what keeps the incremental "categories only grow" merge from leaving an empty card behind when a topic is deleted or re-categorized out of a category, including the catch-all bucket.)
6. **Edge classification** — build a unit-id→topic-slug map. For each cleaned edge: if both endpoints map to the same topic, increment intra-topic; otherwise increment cross-topic. Classification is binary; no topic-slug→category-id map is built and no category-level classification is computed.
7. **Stats** — assemble the seven counts (categories = surviving category count, topics, units, edges = cleaned edge count, the two edge classifications, and the co-change topic-edge count taken from the supplied co-change list's length).
8. **Emit** — return the artifact with the schema-version constant, the timestamp, the fixed source label, the two fingerprint maps (verbatim from the arguments), the stats, the surviving categories, the joined topics, the units verbatim, the cleaned edges, and the co-change list verbatim from the argument (last in the object). The repo display name is emitted only when non-empty; an empty name omits the field.

### Restore to distilled baseline

Given an arbitrary parsed object (a previously-emitted artifact), recover the distilled subset for reuse as an incremental baseline, or return null when it cannot be trusted:

1. If the input is not a non-null object, return null.
2. If any of the four top-level arrays (categories, topics, units, edges) is absent or non-array, return null.
3. Run a **field-set check** on every element:
   - Each category must have string id, short title, and summary.
   - Each topic must have string slug, short title, summary, title, and category id.
   - Each unit must have string id, topic slug, short title, summary; a canonical kinds list; and an anchors object whose file list and commit list are both string arrays.
   - Each edge must have string from and to, a type that is one of the five edge types, a numeric confidence, and a string evidence.
   If any element fails, return null.
4. Otherwise return a freshly-rebuilt distilled graph: categories and topics reduced to exactly their distilled fields (the joined/rolled-up fields are stripped); units rebuilt with their kinds and anchors arrays **copied** (new array instances, not shared references); edges rebuilt to exactly the edge fields.

**The co-change topic-edge list is deliberately NOT recovered.** Restore recovers only the four distilled arrays; the co-change list is absent from its output and is never read back off a prior artifact by any consumer. It is recomputed from scratch on every build that writes an artifact (spec 197), so a stale or hand-edited co-change list on disk can never survive into a new build.

**Scope of this check (captured in comments):** it catches a currently-required field that is missing or mistyped in the baseline — a removed/renamed field, a changed kind/edge-type value, a changed id format, or corruption. It cannot catch a baseline that predates a newly-added field: a validator only checks fields it knows about, so an old element lacking a brand-new field still passes, and the explicit field-pick simply omits the new field (degraded display for reused elements until the next full rebuild — never a crash). Guarding "added field" drift is the job of the schema-version constant: bumping it makes a version mismatch trigger a full rebuild before restore is even reached.

### Canonical-kinds predicate

Given an arbitrary value, decide whether it is a canonical kinds list: an array, non-empty, length at most three, no duplicates, and every member a known unit kind. This is stricter than the ingestion-time coercion (which coerces a stray scalar, or accepts a legacy single-kind field, into a list — see spec 198).

### Fingerprint-map predicate

Given an arbitrary value, decide whether it is a usable fingerprint map (a plain object whose every value is a string):

- Reject a non-object, null, or array.
- Reject if any value is not a string.
- Accept the empty object.

A malformed map (only reachable via hand-corruption or a future bug) means the baseline cannot be diffed, so the caller treats it like any other unusable baseline and does a one-time full rebuild that heals it — rather than letting a diff throw and getting stuck producing no graph every build.

## State Transitions

### A distilled graph through assembly

```
DISTILLED ──(normalize edges)──> DISTILLED' (clean edge list)
DISTILLED' ──(validate fails)──> THROW (no artifact)
DISTILLED' ──(validate passes)──> JOINED ──(prune empty categories)──> ROLLED ──> ARTIFACT
```

### A symmetric edge pair

```
{a→b:sym, b→a:sym} ──(collapse)──> {winner only}   (higher confidence; tie → first)
{a→b:dir, b→a:dir} ──(collapse)──> {both kept}      (directed: distinct facts)
```

### A generic edge on a pair

```
{a→b:generic} alone                       ──> kept
{a→b:generic, a→b:specific}               ──> {specific kept, generic dropped}
{a→b:generic, b→a:specific}               ──> {specific kept, generic dropped}  (unordered match)
{a→b:specific1, a→b:specific2}            ──> {both kept}
```

### A prior artifact through restore

```
not-an-object / missing-or-nonarray-top-level ──> null
any element fails field-set check             ──> null
all pass                                      ──> DistilledGraph (derived fields stripped, anchors copied)
```

## Notable Behavior

- **Edge dedup is the source of truth at assembly time.** Both normalization passes run inside assembly, so every emitted artifact — full, incremental, or the no-model reassemble — is already clean. The viewer carries only a defensive mirror for legacy artifacts.
- **Normalization runs before validation.** This is deliberate: it kills the reversed-pair symmetric duplicate that the validator's ordered `from|to|type` key cannot see, so a graph that would otherwise validate-fail on a duplicate is silently cleaned instead.
- **Validation never throws; assembly does.** Validation returns a string list. Assembly is the only step that throws, and only on a non-empty validation result — degraded by the caller to "no graph this run".
- **A zero-topic category is always pruned**, even on the full path. The distiller rarely emits an unused category, but if it does, it goes too.
- **A topic with no source metadata still renders** with empty joined fields and zero commit count.
- **Unit-edge classification is binary, and the artifact carries no cross-category unit-edge count.** Every unit edge is intra-topic or cross-topic. The statistic that used to count category-crossing unit edges is gone rather than kept-at-zero, because the upstream distillation layer can no longer produce such an edge at all (spec 198).
- **Two edge populations, two validators, one throw.** Unit edges and co-change topic edges are validated by separate functions with separate rule sets; assembly unions their error lists and throws once. Neither validator throws on its own.
- **The co-change list is supplied to assembly, not derived by it.** Assembly validates it, counts it, and emits it verbatim; it does not compute, filter, sort, normalize, or de-duplicate it. Both edge-normalization passes operate on unit edges only.
- **The co-change list is never restored from a prior artifact.** Unlike the four distilled arrays, it is recomputed every build — so it is the one top-level array that cannot go stale relative to the units it was derived from.
- **A co-change edge's optional semantic type is dead contract.** The field is part of the validated shape but no producer populates it, on any path.
- **"Co-change" names an intent, not the input.** The endpoints, the shared-file list, and the weight are all derived from the model-asserted file anchors on units — no commit history, diff, or commit anchor participates. See spec 197 for the derivation and the exact comparison performed.
- **The two fingerprint maps are inert to consumers.** The viewer and the export read only categories/topics/units/edges; the fingerprint maps exist solely as the incremental baseline. They still count toward the schema-version contract because they are top-level fields.
- **Restore copies anchor arrays.** Reused units get fresh anchor array instances so a later mutation of the baseline cannot alias into the new graph.
- **The wiki-file name is derived, not stored.** Each final topic's wiki-file string is computed deterministically from the slug during assembly.
- **The repo display name is stamped at assembly positionally**, so every build path must supply it. An empty name omits the field; the value is otherwise inert to assembly logic (it doesn't affect validation, join, prune, or rollup) — it exists solely as the viewer's breadcrumb-root label.
- **A unit's kinds are multi-label and ordered** (one to three; the first is primary and drives colour). Validation and restore both enforce canonicality (non-empty, deduplicated, ≤3, all known kinds); the ingestion-time coercion in spec 198 is looser — it accepts a stray scalar or a legacy single-kind field and derives a canonical list from it.

## Shared Behavior

- **Producers and the assembler agree on the catch-all bucket.** The reserved uncategorized category id is shared between the full distiller's backfill, the incremental category merge, and the empty-category prune, so all three bucket and clean the same way. See spec 198 for the producers.
- **Source-metadata join input comes from the topic KB.** The per-topic source-metadata map is built by the construction layer from the topic index entries and topic pages (branches, commit refs, overview, full body). See spec 197.
- **The fingerprint maps are populated by the construction layer.** Assembly stores whatever maps it is handed; the construction layer computes them and decides full vs. incremental from them. See spec 197.
- **The co-change topic-edge list is derived by the construction layer.** Assembly owns its shape, its validator, its statistic, and its placement in the artifact; the derivation algorithm — the two parameters, the over-shared-file rule, the cross-category restriction, and the ordering guarantees the validator relies on — is spec 197.
- **The removed cross-category unit-edge statistic is a consequence of the distillation layer.** Per-category edge fan-out makes a category-crossing typed unit edge structurally impossible; see spec 198.
