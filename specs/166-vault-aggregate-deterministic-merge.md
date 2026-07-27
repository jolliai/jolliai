# 166. Vault Aggregate Deterministic Merge

## Topic Statement

Reduce two sets of rows for one vault-owned aggregate file into a single ordered set whose serialization is byte-identical regardless of which input was supplied first.

## Scope

**In scope:**

- The four aggregate kinds the vault stores as the working tree's authoritative index over per-commit content: a file manifest, a commit index, a branch-to-folder mapping, and a long-form recap catalog.
- The primary-key dedup rule for each kind.
- The per-kind conflict tie-break rule applied when both inputs carry a row at the same primary key.
- The locale-independent total order used to sort the merged rows.
- The cross-device byte-identical-output guarantee that makes the merge function safe to invoke independently on two devices that just exchanged bytes.
- Empty-input and disjoint-input handling.
- The order-independence property (merging A with B and merging B with A must serialize identically).
- The canonical folder-name derivation used elsewhere to keep the branch mapping's row content deterministic; this spec defines the algorithm and the empty-input fallback.

**Out of scope (boundaries — what is sent/received but not re-specified here):**

- The vault working-tree reconciliation round that invokes this merge when an integration step reports a conflict on one of the four aggregate paths, including how stage-2/stage-3 row sets are obtained, how the result is written back, how the index is updated, and the surrounding tiered conflict pyramid that places this merge as the second-tier resolver. The reconciliation round is the only caller; spec 150 (sync engine reconciliation) is the boundary.
- The on-disk JSON envelope format (version field, the named array property that wraps the row set) and validators that the backend applies before accepting a push. This spec defines only the row-set merge; the envelope is provided by callers and re-attached by them after the merge returns. Spec 05 (summary index format) is the closest sibling.
- The semantics of any individual row field beyond the primary key and the tie-break-relevant fields named below. The merge function treats other fields as opaque payload.
- The legacy database-to-git first-bind import path. The functions are exported there for potential future use but the current legacy importer never produces inputs at vault aggregate paths.
- Field-level well-formedness validation (timestamp shape, folder/branch invariants, primary-key uniqueness across the final set). The merge produces inputs the backend validator accepts under the documented per-kind invariants, but it does not itself validate fields or reject malformed rows.
- Tombstone / deletion semantics. There is no tombstone in any of the four schemas; rows simply do not appear. Removal of stale rows is performed downstream at consumption time by the file-existence check on the manifest's referenced paths, not by this merge.

## Data Contracts

### Inputs

For each of the four kinds the merge takes two row sets:

- **Local row set** — the row set the local device contributes (typically the rows the local device's index entry held just before integration began).
- **Remote row set** — the row set the remote source contributes (typically the rows the remote's index entry held).

Each row set is an ordered sequence of rows. The merge does not require uniqueness within either input; duplicate primary keys within a single input are tolerated (the row that appears latest at the same primary key inside that input wins for that input prior to the cross-input combine, by construction of the implementation).

### Row shapes used by the merge

Only the fields the merge inspects are spec-relevant; other fields are opaque and preserved verbatim on the surviving row.

**Manifest row** — one row per content file:

- **file identifier** (string, required): primary key.
- **generated-at timestamp** (ISO-8601 string, required): tie-break field. Stored within a nested "source" group on the row alongside other source-of-truth fields that the merge does not inspect.

**Index row** — one row per commit (or amend):

- **commit hash** (string, required): primary key.
- **parent commit hash** (nullable string, required): tie-break field; the "set vs. null" status modifies the tie-break order, not just the equality test. The literal null value is required to be explicit on the row; the spec does not consider absent fields.
- **generated-at timestamp** (ISO-8601 string, required): secondary tie-break field used when both rows agree on the set-vs-null status of the parent.

**Branch row** — one row per branch-to-folder mapping:

- **branch name** (string, required): primary key.
- (No tie-break field. The folder field is required to be a deterministic function of the branch name at write time, so any two valid rows for the same branch differ only in fields whose value is irrelevant to downstream consumers.)

**Catalog row** — one row per commit recap with optional topic breakdown:

- **commit hash** (string, required): primary key.
- (No tie-break field. Each commit's recap is required to be a deterministic function of the commit, so any two rows at the same commit hash carry identical primary content.)

### Output

A single ordered sequence of rows with these properties:

- Each primary key appears at most once.
- Rows are ordered by primary key under a fixed locale-independent total order (see below).
- The set of rows is equal to a per-kind reduction of the union of the inputs (see per-kind rules below).

### Locale-independent ordering

The comparator for the output sort is defined directly on the primary-key string using value comparison (less-than / greater-than) on the underlying code-unit sequence. A locale-aware comparison is explicitly not used because its result depends on the host's locale data — two devices in different locales would otherwise produce different orders for the same row set, the serialized bytes would differ, and the next round of integration would re-conflict the file indefinitely.

## Behavior

### Per-kind reduction

The four merges follow the same skeleton: build a primary-key-indexed accumulator, seed it from the local input, fold the remote input into it under a per-kind decision rule, then emit the accumulator's values in primary-key order.

For all four kinds:

1. Create an empty primary-key-indexed accumulator.
2. For each row in the local input, in input order, set the accumulator at the row's primary key to that row. (Within-input duplicates collapse to the last occurrence.)
3. For each row in the remote input, in input order, apply the per-kind decision rule below to either replace or retain the accumulator's row at that primary key. (Within-input duplicates again collapse to the last occurrence, modulated by the rule.)
4. Take the accumulator's row values, sort them by primary key under the locale-independent order, and return the sorted sequence.

#### Manifest decision rule (tie-break: newer generated-at wins; ties keep accumulator)

For an incoming remote row at primary key `k`:

- If no row exists at `k`, insert the incoming row.
- If a row exists at `k`, compare the incoming row's generated-at timestamp to the existing row's:
  - If the incoming timestamp is **strictly greater** than the existing timestamp (lexical comparison on the ISO-8601 string suffices because all timestamps share the same fixed-width UTC shape), replace the row with the incoming one.
  - Otherwise, retain the existing row. This branch covers both "older" and "equal" — equality keeps the accumulator's row, which (by seeding order) means the local row is kept on a generated-at tie.

#### Index decision rule (two-axis tie-break: parent-set beats parent-null; otherwise newer generated-at wins; ties keep accumulator)

For an incoming remote row at primary key `k`:

- If no row exists at `k`, insert the incoming row.
- If a row exists at `k`, compute for both rows whether the parent commit hash is non-null:
  - **Both have a non-null parent OR both have a null parent** — fall back to the timestamp rule: replace only if the incoming row's generated-at is **strictly greater** than the existing's, otherwise retain. (Tie keeps accumulator → local on the first remote-side pass.)
  - **Incoming has a non-null parent, existing has a null parent** — replace, regardless of timestamps.
  - **Incoming has a null parent, existing has a non-null parent** — retain, regardless of timestamps.

The asymmetry treats a non-null parent as a stronger claim: a row generated with full ancestor context outranks one generated without, even if the latter is newer.

#### Branches decision rule (last-write-wins; remote always replaces)

For an incoming remote row at primary key `k`:

- Always replace the accumulator's row at `k` with the incoming row. (Insert if absent, overwrite if present.)

#### Catalog decision rule (last-write-wins; remote always replaces)

Same as branches: always replace, no tie-break.

### Output ordering

After folding, the accumulator's row values are sorted by primary key under the locale-independent order:

- The comparator returns `-1` when the left primary key is strictly less than the right, `+1` when strictly greater, `0` when equal. Equality at the primary key cannot occur in practice because the accumulator deduplicated.
- The comparison is on the raw string value — the spec does not invoke locale tables, collation rules, or Unicode normalization at sort time. (Normalization happens earlier when callers produced the primary key, if at all.)

### Empty and disjoint inputs

- If both inputs are empty, the output is an empty sequence.
- If one input is empty, the output is the other input deduplicated by primary key (within-input duplicates collapse to the last occurrence) and sorted by primary key under the locale-independent order. The decision rule never runs because there is nothing to combine.
- If the inputs are disjoint (no shared primary keys), the output is the union of both inputs sorted by primary key. The decision rule runs for each remote row but never finds an existing accumulator entry, so insertion is unconditional.

### Within-input duplicates

The merge does not reject duplicates within a single input. Each input is folded in order, so within-input duplicates collapse such that the last occurrence wins. The cross-input decision rule then runs once per remote row against the post-local-fold accumulator, so a remote-side within-input duplicate may itself decide between candidates under the per-kind rule before the final cross-input decision settles. This is observable only on pathological input and is not relied on by callers; treat it as "stable on well-formed input, defined-but-unsupported on duplicates."

## State Transitions

The merge is a pure function — no state, no I/O, no clock, no randomness, no global lookup. The same `(local, remote)` pair always returns rows whose serialized bytes are identical to the same `(local, remote)` pair invoked on any other device. There are no transitions to enumerate.

## Notable Behavior

- **Newer-wins is strict, not weak.** Manifest and same-parent-status index branches replace only when the incoming timestamp is strictly greater than the existing. Equal timestamps keep whichever row was already in the accumulator. Because the accumulator is seeded from the local input first, an exact timestamp tie keeps the local row. This stability is intentional: it makes the merge deterministic on within-millisecond clock collisions across devices, which would otherwise cause the next round to re-conflict the same file.

- **Index parent-set beats newer parent-null.** The 2×2 tie-break treats a non-null parent commit hash as a stronger claim than a null one, irrespective of timestamps. A row written by a device that had no ancestor context (e.g. fresh clone, or branch with no parent at generation time) loses to any non-null-parent row at the same commit, even if the null-parent row is much newer. This is intentional — the non-null-parent row carries strictly more information and downstream consumers prefer it.

- **Branches and catalog use last-write-wins by design, not oversight.** Both kinds have invariants enforced at write time (the folder name is a deterministic function of the branch name; the recap is a deterministic function of the commit) that make any two valid rows at the same primary key carry the same primary content. The only field that can differ is irrelevant to downstream consumers (a created-at timestamp on branches; nothing on catalog). Last-write-wins is therefore equivalent to any other tie-break on well-formed input, and is cheaper.

- **Locale-aware sort would silently break cross-device convergence.** A locale-aware comparator on the same row set can produce different orders on two devices (for example, an accented character may sort before or after an ASCII character depending on the locale). The serialized bytes would then differ, and the next integration step would conflict on the same file again. The merge therefore uses a fixed locale-independent string order even when the host has a locale-aware comparator readily available.

- **Cross-device byte-identical convergence is the contract.** The serialized bytes of the merge of two row sets must equal the serialized bytes of the merge of those same two row sets in the other order. The dedup-then-sort skeleton, the strict tie-break on the timestamp axis, and the locale-independent sort key together guarantee this: dedup is commutative on disjoint and equal-row cases; the asymmetric tie-breaks resolve deterministically based only on the rows themselves (not on input order, because the dominant row wins under the strict-comparison rule from either side); and the sort key is a pure function of the primary key. Tests pin all four kinds against this property by serializing `merge(A, B)` and `merge(B, A)` and comparing the byte sequences.

- **Within-input duplicates are not rejected.** Either input may carry the same primary key multiple times. The merge tolerates this by folding inputs in order; the last occurrence at a primary key inside the same input wins for that input. Validators on the backend reject duplicates in the final serialized file, but the merge does not — it produces a deduplicated output by construction (one row per primary key in the accumulator).

- **No tombstone, no deletion.** Removal of stale rows is not part of the merge. A manifest row whose referenced file no longer exists on disk is treated as a zombie at consumption time and pruned on the next regeneration of the row set, not by the merge. The merge will faithfully carry a zombie row forward indefinitely if no regeneration occurs.

- **The folder field on a branch row is trusted, not recomputed.** The merge passes the incoming folder field through verbatim even if it does not match the canonical folder derivation. Enforcement of the folder-equals-canonical invariant is the responsibility of the writer (and the backend validator on push), not the merge.

### Canonical folder-name derivation

A separate helper used by writers to populate the branch row's folder field deterministically:

1. Apply Unicode NFKD decomposition to the input branch name.
2. Convert to lowercase.
3. Replace every contiguous run of characters that is not a lowercase ASCII letter, ASCII digit, or hyphen with a single hyphen.
4. Collapse any contiguous run of hyphens into a single hyphen.
5. Trim leading and trailing hyphens.
6. If the result is the empty string, return the literal string "branch" (the fallback prevents a writer from producing an empty folder name, which the backend validator would reject).

Properties relied on elsewhere:

- Idempotent — applying the algorithm twice produces the same result as applying it once.
- Locale-independent — depends only on Unicode decomposition tables and ASCII character classes, not on the host's locale.
- Total — every string maps to a non-empty result.
- Stable across implementations — the algorithm is mirrored byte-for-byte by every other component that needs to produce the same folder for the same branch, so a writer in any surface produces the row that any other surface also accepts.

## Shared Behavior

- The tiered conflict resolution that places this merge as the second tier (between "fast path: no conflict" and "AI-mediated merge / user prompt") is specified by spec 150 (sync engine reconciliation). The merge is invoked as the deterministic best-effort attempt; if it succeeds, the integration proceeds and no user prompt is required.
- The on-disk envelope around each row set (version marker, named array property holding the row set) is specified alongside the per-kind storage layout in spec 05 (summary index format) and adjacent specs. The merge does not produce or consume the envelope.
- The locale-independent total order on strings is a property the merge depends on but does not extend; any other component that must serialize the same row set with the same byte sequence must use the same comparator.
- The canonical-folder algorithm is mirrored by the slug derivation used by other components that need to map a branch (or branch-like identifier) to a filesystem path; this spec defines it in the context of the branch row's folder field but the algorithm itself is shared.
