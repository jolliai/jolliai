# 04. Summary Tree Structure

## Topic Statement
Define the in-memory hierarchical commit-summary tree, its per-node fields, the rules for aggregating data across the tree, and the schema-version discriminator that selects between two layout regimes.

## Scope
**In scope:**
- The shape of a commit-summary node and the recursive tree it forms.
- The shape of an embedded topic record.
- The shape of an embedded plan reference, note reference, and end-to-end test scenario.
- The shape of an embedded LLM-call metadata record and a diff-stats record.
- The shape of an embedded per-model conversation-usage record, an estimated-cost field, and a price-table verification-date field.
- The version-based discriminator that selects between the legacy regime (referred to as v3) and the unified-hoist regime (referred to as v4 onward).
- Pure traversal helpers: collecting all topics in chronological order, aggregating diff statistics, summing conversation turns, summing conversation tokens (scalar and per-segment breakdown), merging per-model conversation usage across the tree, summing estimated cost across the tree, counting topics, collecting leaf-descendant source nodes, collecting transcript hashes, computing duration spans, collecting display-topics under each regime, collecting and deduplicating plans, updating one topic at a global tree-index, deleting one topic at a global tree-index.
- The leaf-vs-container rule used by the canonical diff-stats helper.
- The lightweight summary-index entry shape and the parent-pointer convention.

**Out of scope (boundaries):**
- How summary nodes are persisted or read back (covered by "Orphan Branch Summary Storage", "Folder-Based Summary Storage", "Dual-Write Summary Storage").
- How summary nodes are produced from transcripts and diffs (the LLM/summarization pipeline).
- The presentation of summaries in any UI (markdown rendering, web view, push-to-cloud).
- Plan-progress evaluation (referenced only as an embedded artifact shape).

## Data Contracts

### CommitSummary node
Represents a single commit's summary. Forms a tree via the optional `children` array.

Required fields:
- `version`: integer schema version. Values ≤ 3 are the legacy regime; values ≥ 4 are the unified-hoist regime.
- `commitHash`: the version-control commit hash this node is indexed under.
- `commitMessage`: the commit message (for a squash root, this is the squash commit's own message, not any source's).
- `commitAuthor`: author identifier string.
- `commitDate`: the commit's author-date as ISO-8601.
- `branch`: the branch name at which the summary was generated.
- `generatedAt`: ISO-8601 wall-clock timestamp at the moment the summary was (re)generated. Updated on every summary-generating event (commit, amend, squash, rebase).

Optional classification fields:
- `ticketId`: a ticket/issue identifier extracted from text (e.g. `PROJ-123`, `#789`).
- `commitType`: enumeration `commit` | `amend` | `squash` | `rebase` | `cherry-pick` | `revert`. Indicates how this commit came to exist.
- `commitSource`: enumeration `cli` | `plugin`. Indicates which user surface initiated the operation.

Optional metrics fields:
- `transcriptEntries`: count of transcript records read for this summary.
- `conversationTurns`: count of human-role turns in the transcript.
- `conversationTokens`: scalar total of conversation token usage attributed to this commit (equals `input + output + cached` of the breakdown below). **Forward-only**: absent on summaries generated before the field existed and on commits whose conversations carried no usage; a literal zero is never persisted. A consolidated root aggregates its children (see the token aggregation helpers). Derivation of the number is deferred to "Commit-Pipeline Conversation Token Attribution"; extraction and pricing to "Token Usage Extraction and Cost Estimation".
- `conversationTokenBreakdown`: the per-segment (input / output / cached) split of `conversationTokens` (a conversation-token-breakdown record, defined below). **Forward-only and co-written with `conversationTokens`** — both present or both absent going forward; older summaries may carry the scalar total only.
- `conversationModels`: optional array of per-model conversation-usage records (defined below), one bucket per distinct model the conversation(s) attributed to this commit consumed (sessions can switch models mid-stream). **Forward-only**: absent on summaries generated before the field existed, and on commits whose surviving usage produced no per-model buckets at all (a non-capturing producer). May be present even when `estimatedCostUsd` is absent — every model in the list can be unpriced. A consolidated root aggregates its children's per-model usage (see the merge-per-model-across-tree helper). Derivation is deferred to [245 — Commit-Pipeline Conversation Token Attribution]; the price lookup that consumes it is deferred to [257 — Multi-Provider Pricing and Cost Estimation].
- `estimatedCostUsd`: optional estimated USD cost of `conversationModels`, priced at list rates as of `pricesAsOf`. **Forward-only, and present only when the priced total is strictly positive** — a commit whose entire `conversationModels` list is unpriced (every model absent from the price table) keeps the list but omits this field, so absence means "no priced usage", not "zero cost". A consolidated root's cost SUMS its children's already-priced `estimatedCostUsd` (see the cost-aggregation helper below) — it does **not** re-derive cost from the merged per-model usage, so a legacy child with per-model usage but no stamped cost contributes 0 to the root's sum even though its usage could in principle be priced. Defined and priced by [257 — Multi-Provider Pricing and Cost Estimation].
- `pricesAsOf`: optional date string, the price table's verification-date stamp at the time `estimatedCostUsd` was computed, co-written with `estimatedCostUsd` (both present or both absent). Lets a reader judge how stale a cost figure is. Defined by [257 — Multi-Provider Pricing and Cost Estimation].
- `llm`: an LLM-call-metadata record (defined below); absent for pure container nodes (squash/merge containers make no LLM call).

Optional diff-stats fields:
- `stats`: a diff-stats record (defined below). **Legacy field** — its meaning varies by node type:
  - On a leaf node: the diff of this commit against its parent (correct).
  - On an amend root: may be the delta `oldHash..newHash` (when produced via a delta-override path) or the full amended diff `HEAD~1..HEAD` (otherwise).
  - On a squash or rebase-pick root: absent.
  Display code MUST NOT read this field directly.
- `diffStats`: a diff-stats record. **Authoritative new field**, present on every node type with consistent meaning: this commit's actual diff against its parent. Display code reads diff-stats through a single helper that prefers this field.

Optional content fields:
- `topics`: array of topic records (defined below). Under the unified-hoist regime this array on a root is the authoritative consolidated set; the empty array is legitimate (recap-only commits). Under the legacy regime, an amend root may carry a delta in this field while children carry the pre-amend topics.
- `recap`: a one-paragraph human-readable summary of the commit's main work, paired with `topics`. Under the unified-hoist regime, only the root carries the authoritative value; children of a hoisted root must have this stripped. Legacy nodes may lack this field.
- `children`: array of CommitSummary nodes forming the tree. Ordered by `commitDate` descending (newest first). Conventions:
  - Leaf node: omitted or empty.
  - Amend root: `[originalSummaryBeforeAmend]`.
  - Squash root: all source summaries, newest-first.
  - Rebase-pick root: `[originalSummary]`.

Optional cross-storage / push fields:
- `jolliDocUrl`: full URL of the externally-pushed document.
- `jolliDocId`: server-side numeric identifier for direct update on subsequent pushes.
- `orphanedDocIds`: array of numeric document identifiers superseded during squash/rebase merge, kept so they can be deleted from the external service after a successful push. **Plan documents are never orphaned** — only memory-summary documents.
- `treeHash`: the version-control tree hash for this commit, used for cross-branch matching of identical content.
- `e2eTestGuide`: array of E2E test scenarios (defined below).
- `plans`: array of plan references (defined below).
- `notes`: array of note references (defined below).

Optional back-fill classification fields (present only on summaries produced by the historical back-fill flow, not the live post-commit pipeline):
- `backfilled`: boolean flag marking the summary as back-fill-produced. Absent on live-pipeline summaries.
- `backfillConfidence`: enumeration `high` | `medium` | `low` — the confidence of the back-fill conversation attribution, reported as the *weakest* tier of the turns actually included so a badge never overclaims. Absent when no conversation was attributed. Only meaningful when `backfilled`.
- `backfillMethod`: enumeration `file-overlap` | `branch-match` | `time-window` | `diff-only` — which back-fill signal produced the summary. The first three mean a conversation was attributed (mapping to high / medium / low confidence respectively); `diff-only` means no conversation was confidently found and the summary was generated from the git diff alone. Only meaningful when `backfilled`.

Derivation of all three back-fill fields is deferred to the back-fill specs ("Backfill Commit Attribution Algorithm", "Backfill Engine Orchestration").

### TopicSummary record
A single independent problem-or-goal description within a commit.
- `title`: short label.
- `trigger`: what initiated the work.
- `response`: what was done.
- `decisions`: key decisions taken.
- `todo`: optional follow-up items.
- `filesAffected`: optional array of 2–5 key file paths relative to repo root.
- `category`: optional enumeration: `feature` | `bugfix` | `refactor` | `tech-debt` | `performance` | `security` | `test` | `docs` | `ux` | `devops`.
- `importance`: optional enumeration: `major` | `minor`.

(Note: the JVM-hosted surface mirrors these enumerations in a **data-transfer type only** — it deserializes summaries into them for display and re-serializes them when handing a summary back for a write, but it computes nothing from them. One value, `tech-debt`, contains a hyphen and is represented there with that language's identifier-quoting convention. The consequence worth recording is a lockstep requirement: a new category value added here and not mirrored there fails to deserialize on that surface.)

### DiffStats record
- `filesChanged`: integer.
- `insertions`: integer.
- `deletions`: integer.

### ConversationTokenBreakdown record
- `input`: integer — uncached input tokens.
- `output`: integer — output tokens.
- `cached`: integer — cache-**creation** tokens only. (Cache-read tokens are deliberately excluded upstream; the semantics and rationale belong to "Token Usage Extraction and Cost Estimation".)

The three fields sum to the node's `conversationTokens`.

### ModelTokenUsage record (per-model conversation usage)
- `model`: string — the exact model identifier as it appeared in the transcript (not a resolved alias).
- `provider`: enumeration `anthropic` | `openai` | `unknown` — which billing family the model belongs to. Carried end-to-end but not itself consulted by the price lookup, which keys purely on `model` (see "Multi-Provider Pricing and Cost Estimation"). The `unknown` member is declared but not produced by any live path today.
- `input`: integer — uncached input tokens attributed to this model.
- `output`: integer — output tokens attributed to this model.
- `cached`: integer — tokens billed at this model's cached rate (segment meaning is provider-dependent; see "Multi-Provider Pricing and Cost Estimation").

A `CommitSummary.conversationModels` array holds zero or more of these, one per
distinct `model` value seen in the commit's surviving conversation usage. Segment
semantics mirror `ConversationTokenBreakdown` but are kept in a separate,
per-model record rather than folded into it, because the scalar
`conversationTokenBreakdown` predates per-model pricing and remains the
provider-agnostic figure every surface (including non-cost-aware ones) can
still read.

### LlmCallMetadata record
- `model`: actual model identifier returned by the API (may differ from the requested identifier due to aliasing).
- `inputTokens`: integer.
- `outputTokens`: integer.
- `cachedTokens`: optional integer — prompt-cache tokens on **the product's own summarization call** (cache-read + cache-creation, summed). Distinct from the node's `conversationTokenBreakdown.cached`, which measures the developer's conversation and excludes cache-read. Optional because summaries written before the field existed lack it (readers default to `0`). Defined by "Anthropic Message API Call".
- `apiLatencyMs`: integer wall-clock milliseconds.
- `stopReason`: nullable string. The literal value `max_tokens` indicates the response may have been truncated.

### PlanReference record
- `slug`: string. After archival it takes the form `<originalSlug>-<commitHash8or-more>`.
- `title`: first markdown `#` heading from the plan source.
- `editCount`: integer count of write/edit operations on this plan in transcripts.
- `addedAt`: ISO-8601.
- `updatedAt`: ISO-8601.
- `jolliPlanDocUrl`: optional pushed-document URL.
- `jolliPlanDocId`: optional pushed-document numeric identifier.

### NoteReference record
- `id`: string identifier.
- `title`: string.
- `format`: enumeration `markdown` | `snippet`.
- `content`: optional snapshot of the snippet content at archive time.
- `addedAt`: ISO-8601.
- `updatedAt`: ISO-8601.
- `jolliNoteDocUrl`: optional pushed-document URL.
- `jolliNoteDocId`: optional pushed-document numeric identifier.

### E2eTestScenario record
- `title`: short scenario label.
- `preconditions`: optional setup-state description.
- `steps`: array of plain-language ordered steps.
- `expectedResults`: array of plain-language expected observations.

### Topic-with-date (traversal output)
A topic record decorated with:
- `commitDate`: from the source node.
- `generatedAt`: from the source node (preferred over `commitDate` by display code's date helper).
- `treeIndex`: optional integer; the topic's position in the chronological traversal (used to address the topic for edit/delete).

### SummaryIndexEntry (lightweight index document)
- `commitHash`: required.
- `parentCommitHash`: required tri-state:
  - `null`: top-level root (a corresponding `summaries/<commitHash>.json` exists).
  - non-null string: child node; the parent is found by following the chain to a root.
  - undefined: legacy entry, treated as a root for backward compatibility.
- `treeHash`: optional, enables cross-branch matching.
- `commitType`: optional enumeration (same as on the node).
- `commitMessage`, `commitDate`, `branch`, `generatedAt`: required (mirrored from the node).
- `topicCount`: optional integer (total topics across the entire tree rooted here).
- `diffStats`: optional diff-stats record, mirrored.

### SummaryIndex (lightweight index document)
- `version`: integer (allowed values include 1 and 3 in current data; the JVM port writes 3).
- `entries`: array of summary-index entries.
- `commitAliases`: optional map of `unknownHash → knownHash` strings, populated when a commit's tree-hash matches an indexed summary's tree-hash. Once written, never invalidated. Avoids repeat hash-resolution calls for the same unrecognized commits.

## Behavior

### Schema-version discriminator
A pure predicate `isUnifiedHoistFormat(node)` returns true when the node's `version` is ≥ 4. The discriminator drives the choice of traversal regime in three places: the effective-topics resolver, the source-expansion-for-consolidation step, and the display-topics collector. The discriminator is `version`, **not** `topics.length` — using length would mis-classify both legacy amend roots (which have non-empty topics that are a delta) and unified-hoist recap-only commits (which legitimately have empty topics).

### Children ordering and reversal
Children are stored newest-first (`commitDate` descending). Traversal helpers that need chronological order reverse children before recursing.

### Collect all topics, chronologically (`collectAllTopics`)
1. Reverse the children array (oldest-first), recurse into each child, and concatenate the results.
2. Append the current node's `topics` (each annotated with this node's `commitDate` and `generatedAt`).
3. Return the concatenated list.

The result is purely chronological (oldest topic first), regardless of the version regime. Used as the legacy-fallback path; not the display path under the unified-hoist regime.

### Collect display topics (`collectDisplayTopics`)
1. If `isUnifiedHoistFormat(node)` is true, return only the node's own `topics` (each annotated with the node's `commitDate` and `generatedAt`); do not recurse into children. An empty topics array is a valid result (recap-only commit).
2. Otherwise, return `collectAllTopics(node)`.

### Collect sorted topics (`collectSortedTopics`)
1. Compute the source-node list (see leaf-descendants helper below).
2. Compute the display-topic list via `collectDisplayTopics`.
3. Annotate each display topic with a `treeIndex` equal to its position in that list.
4. Sort by:
   1. The day portion (first 10 characters) of `generatedAt` if present, otherwise `commitDate`, in **descending** day order.
   2. Within the same day, by `importance`: `major` before `minor` (a missing or absent importance sorts as if it were "not minor", i.e. before a minor topic).
5. Return the sorted topics and the unsorted source-node list.

### Aggregate diff stats (`aggregateStats`)
Recursive sum of `stats.filesChanged`, `stats.insertions`, `stats.deletions` across a node and all descendants (using zeros where `stats` is absent). **Note that this aggregator is intentionally NOT the canonical display path.**

### Resolve diff stats (`resolveDiffStats`) — canonical display helper
Given a node:
1. If `node.diffStats` is present, return it.
2. Otherwise, if the node is a leaf (no children or empty children), return `node.stats` (or all zeros if `stats` is absent).
3. Otherwise (node has children), return `aggregateStats(node)`.

The branch-3 fallback exists specifically for legacy v3 amend roots, where `stats` is a delta and the children's `stats` are the pre-amend full diff; aggregating them produces the visually-correct historical value. Display code MUST use this helper and MUST NOT read `stats` directly.

### Aggregate conversation turns (`aggregateTurns`)
Sum of `conversationTurns` across the node and all descendants (using 0 where absent).

### Aggregate conversation tokens (`aggregateConversationTokens`)
Recursive sum of the scalar `conversationTokens` across the node and all descendants (using 0 where absent). A consolidated root's total therefore includes the tokens folded into its amend/rebase/squash children, matching the per-row subline so a branch total is never less than the sum of its rows.

### Aggregate conversation-token breakdown (`aggregateConversationTokenBreakdown`)
Recursive sum of the per-segment `conversationTokenBreakdown` (input / output / cached) across the node and all descendants — the segmented counterpart of the scalar aggregator, walking the same tree.

The fallback is **per field, not per object**: for each node the aggregator reads each of the three segments with an independent zero-fallback (`raw?.input ?? 0`, etc.), rather than substituting a zeroed object only when the whole breakdown is absent. Summaries load through a bare parse with no schema validation, so a present-but-partial breakdown (hand-edited, older schema, or a future producer that writes only some segments) must not leak a missing field into the sums: missing-plus-number is NaN, which would poison the tree total, and since `NaN > 0` is false, would make the aggregate figure silently vanish from the token bar / article.

### Merge per-model conversation usage across the tree (`aggregateConversationModels`)
Recursive merge of `conversationModels` across a node and all descendants, one
bucket per distinct `model` value, summing that model's `input` / `output` /
`cached` segments wherever it appears in the tree. The per-model counterpart of
`aggregateConversationTokenBreakdown`: a consolidated root (amend/squash) must
report the models its folded-in children consumed, not only its own, so a
cost estimate computed from the root's merged usage matches the sum of what
its rows would price individually. Nodes with no `conversationModels` (absent
field) contribute nothing; the merge does not fabricate a bucket for a model
it never saw.

### Aggregate estimated cost across the tree (`aggregateEstimatedCost`)
Recursive sum of the node's own `estimatedCostUsd` (using 0 where absent)
across the node and all descendants — the cost counterpart of
`aggregateConversationTokens`. This is a plain SUM of each node's
already-priced scalar; it does **not** re-derive a cost from the merged
per-model usage above. Consequently a node that carries `conversationModels`
but no `estimatedCostUsd` (its usage was captured but never priced, or was
priced to a non-positive/unpriced total) contributes exactly 0 to this sum,
even though its per-model usage is visible via the merge helper — the two
helpers deliberately answer different questions ("what models were used" vs.
"what has already been priced") and must not be conflated. Because nodes
written before the field existed also contribute 0, the tree-level total is
always a lower bound, exactly as the per-node field is.

### Count topics (`countTopics`)
Sum of `topics.length` across the node and all descendants (using 0 where absent).

### Collect leaf descendants (`collectSourceNodes`)
Returns the leaf descendants of the node (NOT the node itself, NOT intermediate containers). The rule is purely structural:
1. For each child in `node.children` (in stored order):
   - If the child has no children (leaf), append it to the result.
   - Otherwise recurse into the child's children.
2. Return the result.

Examples:
- Leaf node → `[]`.
- Squash of leaves `[A1, A2, A3]` → `[A1, A2, A3]`.
- Rebase pick `(A → A')` with `A` a leaf → `[A]`.
- Amend `(A → A')` with `A` a leaf → `[A]` (root excluded).
- Amend over squash (`A'` wraps `S` wraps `[A1, A2, A3]`) → `[A1, A2, A3]` (intermediate container `S` skipped).
- Rebase-pick over squash → `[A1, A2, A3]`.

**Behavior change on the JVM-hosted surface.** That surface used to compute this itself with an older rule — "any node whose own `topics` are non-empty, including the root". It now consumes the rule above over a bridge action. The two rules disagree on the most common case: for a plain leaf memory, the old rule returned **one** source node (the leaf itself, since a leaf carries its own topics) while the rule above returns **zero** (leaves only, root excluded — and a leaf memory's only node *is* the root). So a leaf memory that previously reported one source commit on that surface now reports none, and its source-commits drill-down is empty where it used to have a single entry. This is not a parity note; it is a user-visible change in what that surface displays.

### Collect all transcript hashes (`collectAllTranscriptHashes`)
Returns the list of `commitHash` values starting with the root and recursing into each child in stored order. Used by display code to look up `transcripts/<hash>.json` files for every commit whose work is embedded in this tree (transcripts are addressed by original hash, not hoisted).

### Compute duration days (`computeDurationDays`)
1. Compute the source-node list.
2. If 1 or fewer source nodes, return 1.
3. Otherwise, build a set of distinct day keys and return its size. A day key is produced by **parsing** each source node's `generatedAt` (falling back to `commitDate`) into an instant and taking the first 10 characters of its UTC representation — not by taking a prefix of the stored string. For a timestamp stored with a non-UTC offset the two differ: a late-evening local commit can bucket into the following UTC day.

**Basis change on the JVM-hosted surface.** That surface used to compute this itself, bucketing on the leading 10 characters of `commitDate` alone. It now consumes the rule above over a bridge action, so its day buckets are keyed on `generatedAt` (with `commitDate` only as a fallback) and are UTC-normalized. A tree whose nodes carry a `generatedAt` on a different day than their `commitDate` — or whose timestamps carry offsets — can therefore report a different day count on that surface than it used to.

### Format duration label (`formatDurationLabel`)
1. Compute duration in days.
2. Build a `1 day` or `<N> days` string.
3. If 1 or fewer source nodes, return that string verbatim.
4. Otherwise, take the source nodes' timestamps (`generatedAt` if present, else `commitDate`), find the earliest and latest, format each as a short date with month abbreviation, day, year, and append ` (<earliest> — <latest>)` to the duration string.

### Update one topic in tree (`updateTopicInTree`)
Returns either `null` (out-of-range index) or `{result, consumed}` where `consumed` is the total number of topics in the subtree.

Algorithm — recursive, structurally-sharing:
1. Take a reverse copy of the current node's children (oldest-first to match `collectAllTopics`).
2. Walk children in order; track an `offset` of topics consumed so far. If a child has already been modified in this pass, append the remaining children unchanged.
3. For each child, recurse with `globalIndex - offset`. Add the child's `consumed` to `offset`. If the child's subtree returned a structurally-different result, mark "child modified" and append the modified subtree; otherwise append the original.
4. After children are walked, compute `localIndex = globalIndex - offset`. If no child was modified and `localIndex` falls within the node's own `topics` array, replace that topic with `{...original, ...updates}` and return a node-copy with the updated topics and the (re-reversed-back-to-stored-order) children. Otherwise return the (possibly-child-modified) node and `consumed = offset + ownTopics.length`.

### Delete one topic in tree (`deleteTopicInTree`)
Same shape as the update operation but the local-hit branch removes the topic at `localIndex` instead of merging updates into it. Same out-of-range-returns-null behavior.

### Is leaf node (`isLeafNode`)
Returns true when `children` is missing or empty.

### Collect all plans (`collectAllPlans`)
1. Walk the tree (root then children, in stored order).
2. For each visited node's `plans` array (if present), insert each plan into a map keyed by `slug`. On collision, keep whichever entry has the larger `updatedAt` string (lexicographic ISO-8601 comparison).
3. Return the map's values.

### Date helpers (used by display code, not by the tree primitives)
- A canonical "display date" helper returns `entry.generatedAt || entry.commitDate` (using a falsy-OR fallback so an empty `generatedAt` falls through; documented as intentional given some legacy data persists `generatedAt` as an empty string).
- Date-formatting helpers exist in two flavors: short (e.g. `Apr 5, 2026`) and full (e.g. `February 27, 2026 at 7:49 PM`). Both wrap the underlying date construction in a try/catch that returns the input string unchanged on error. The catch arms are marked unreachable in coverage tooling because the underlying APIs return `Invalid Date` instead of throwing. (Notable.)

## State Transitions

The tree itself is an immutable data structure: traversal helpers do not mutate; mutating helpers (`updateTopicInTree`, `deleteTopicInTree`) return new tree instances that structurally share unmodified subtrees with the input.

The schema-version field marks the tree's regime:
- `version ≤ 3` (legacy): topic data may be split between root and children (amend) or live entirely on children (squash). Display path is `collectAllTopics`.
- `version ≥ 4` (unified hoist): root carries the authoritative consolidated `topics` and `recap`; children of a hoisted root have these fields stripped. Display path is the root-only path.

There is no in-tree transition between regimes; each persisted summary fixes its own `version` at write time, and consumers branch on it at read time.

## Notable Behavior

- **Bugs as features:** The ambiguous semantics of the legacy `stats` field are intentionally preserved; the canonical display helper exists to document and contain the ambiguity, not to fix it. (Intentional-bug.)
- **Topic-length is NOT the discriminator.** A v4 recap-only commit has `topics === []` but is still "unified-hoist". A v3 legacy amend root has non-empty `topics` (the delta) but is still "legacy". Using `topics.length > 0` as the regime check would mis-classify both. (Surprising; intentional.)
- **Children stored newest-first.** Every traversal helper that needs chronological order reverses the children array. (Notable.)
- **`aggregateStats` is intentionally not the canonical path.** It is kept for legacy-fallback inside `resolveDiffStats` and for out-of-band branch-level aggregation in upstream session hooks; display code must not call it directly. (Notable.)
- **`resolveDiffStats` branch 3 (containers without `diffStats`) preserves a legacy quirk.** On a legacy amend root the field-level stats record a delta and the children's stats record the pre-amend full diff. Aggregating them recovers the user-expected total. New writes set `diffStats` directly and skip this branch. (Surprising; intentional.)
- **`collectSourceNodes` is purely structural.** It does NOT look at `topics`. Under unified-hoist, children have stripped topics, so any "has own topics" rule would return an empty list and break the source-commits drill-down. The structural rule (leaves only) is the durable definition. (Surprising; intentional.) **There is now one implementation of this rule**: the JVM-hosted surface, which used to apply the older "has own topics, including the root" rule, consumes this one. That is a behavior change on that surface, not a parity note — a leaf memory there now reports zero source nodes where it previously reported one.
- **`collectAllTranscriptHashes` walks ALL nodes** including the root and intermediate containers, not just leaves. A transcript file is keyed by every original commit hash that was touched by the work, regardless of whether that commit is now an intermediate container. (Notable.)
- **`computeDurationDays` returns 1 for single-source trees.** Even if the lone source node spans multiple days conceptually, the helper returns 1 because it only computes a set across **multiple** sources. (Notable.)
- **Plan deduplication keeps the lexicographically-greater `updatedAt`.** This works correctly only because `updatedAt` is ISO-8601 (which is lexicographically-orderable). (Notable.)
- **Tree mutation helpers structurally share.** When neither the topic-target nor any descendant of a child is modified, the helper returns the original child (by reference) instead of a copy, allowing identity comparisons up the call stack. (Notable.)
- **Out-of-range index returns `null`.** Both the update and delete helpers return null if the requested global index is past the end of the tree's topics. The recursion is total (always returns a `consumed` count), so a `null` only ever propagates from the very top. The intermediate-recursion `null` paths are marked unreachable in coverage tooling. (Notable.)
- **Tree-index addressing uses chronological order.** The `treeIndex` annotated on each topic by `collectSortedTopics` is assigned on the chronological list (the output of `collectDisplayTopics`, before sorting), so it matches the index used by `updateTopicInTree`/`deleteTopicInTree` regardless of presentation sort order. (Notable.)
- **Sort-day collapsed when all topics share a date.** Under the unified-hoist regime, every topic on a squash or amend root carries the root's own date, so the day-key falls equal and the topic sort collapses to importance-only. The previous timeline-grouping presentation that depended on cross-day ordering was removed in favor of a flat list. (Notable; intentional.)
- **Index `version` field is heterogeneous.** Index documents in current data may carry `version: 1` (legacy, written by the initial-tree blob; see "Orphan Branch Summary Storage") or `version: 3` (written by the index updater). Consumers tolerate both values. There is only one index writer now — the JVM-hosted surface's hard-coded `version: 3` writer is gone, and index writes on that surface go through this implementation. (Notable.)
- **Parent-pointer is tri-state.** A summary-index entry's `parentCommitHash` may be `null` (root), a string (child), or `undefined` (legacy v1 entry, treated as root for backward compatibility). Consumers must distinguish all three. (Notable.)
- **Tree-hash alias is one-shot.** Once written into the index's `commitAliases` map, an alias is never invalidated, even if the underlying commits change. (Surprising; intentional.)
- **Container nodes have no `llm` field** because no API call was made to produce the container; the LLM data lives on the leaves whose summaries the container wraps. (Notable.)
- **Token-breakdown aggregation falls back per field, not per object.** A present-but-partial breakdown must contribute its present segments; a per-object fallback would let a missing field become NaN and, because `NaN > 0` is false, silently hide the whole aggregate figure. (Surprising; intentional.)
- **`conversationTokens` and `conversationTokenBreakdown` are co-written and never zero.** Going forward both are present or both absent; a literal zero total is never stored, so absence means "no usage-bearing conversation", not "zero". Older data may carry the scalar total alone. (Notable.)
- **`conversationModels` can be present without `estimatedCostUsd`.** Unlike the scalar/breakdown pair, per-model usage and cost are NOT strictly co-written: a commit whose usage is entirely on unpriced models keeps `conversationModels` (for future re-pricing) but omits `estimatedCostUsd` and `pricesAsOf` entirely. Absence of the cost field therefore means "no priced usage", not "zero cost" and not "no usage at all" — three distinct states collapse into two possible field combinations, which display code must not conflate. (Surprising; intentional. See "Multi-Provider Pricing and Cost Estimation".)
- **`aggregateEstimatedCost` sums already-priced numbers; it does not price.** A node with rich `conversationModels` but no stamped `estimatedCostUsd` (unpriced at write time) contributes 0 to the tree-level cost sum even though its usage is visible through `aggregateConversationModels`. The two aggregations are not interchangeable, and a future price-table fix does not retroactively change this sum without a re-write of the node's `estimatedCostUsd`. (Surprising; intentional — a lower bound by construction.)
- **`children` ordering convention is fixed.** Newest-first by `commitDate` descending. Helpers that need chronological order reverse before recursing. (Notable.)
- **There is one implementation of every helper in this spec.** The former JVM-language port is gone; the JVM-hosted surface consumes these helpers over a bridge action, memoized per unique summary document, so tree analysis has a single behavior everywhere. Two of the three former parity gaps closed as **behavior changes** on that surface rather than as no-ops — the source-node rule (a leaf memory now yields zero source nodes, previously one) and the duration day-bucket basis (now `generatedAt`-first and UTC-normalized, previously a prefix of `commitDate`). The third, the hard-coded index `version: 3` writer, is simply gone along with the port. What survives of the old port is a **data-transfer type only**: the enumerations (including the identifier-quoted `tech-debt` category) are mirrored on that surface for deserialization and re-serialization, which makes them a lockstep requirement but not a second implementation of any rule. (Notable.)

## Shared Behavior
- The persistence and read paths for nodes and the lightweight index document are defined by **Orphan Branch Summary Storage**, **Folder-Based Summary Storage**, and **Dual-Write Summary Storage**.
- The `conversationTokens` / `conversationTokenBreakdown` fields are extracted and priced (Sonnet-only) by **Token Usage Extraction and Cost Estimation** and attributed per commit by **Commit-Pipeline Conversation Token Attribution**; the aggregation helpers here are the tree-walk those surfaces call. The `backfill*` fields are derived by the back-fill specs.
- The `conversationModels` / `estimatedCostUsd` / `pricesAsOf` fields are attributed per commit by **Commit-Pipeline Conversation Token Attribution** (the write-time helper that decides which of them to stamp) and priced against the per-model table by **Multi-Provider Pricing and Cost Estimation**; the merge-per-model and cost-sum helpers here are the tree-walk the VS Code sidebar's branch token bar calls to build its primary, model-aware figure.
