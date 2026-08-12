# Summary Catalog File

## Topic Statement

A denormalized, root-only catalog persisted alongside the summary index that surfaces per-commit recap, ticket identifier, and topic detail for every root entry without requiring individual summary payload reads.

## Scope

**In scope:**
- On-disk shape of the catalog container and each catalog entry.
- When the catalog is written: eager write-along with summary writes, eager removal with explicit index removals, bulk population during schema migration, and lazy build on read.
- Freshness-check and reconcile logic executed by the guaranteed-non-null read path.
- Concurrency model: how the catalog participates in the shared cross-process lock and what happens under lock contention.
- The two public access points exposed to callers.
- Bootstrap behavior when the catalog file is absent.

**Out of scope:**
- The summary tree structure of individual payload entries (covered by the summary tree structure spec).
- The index format, root-vs-descendant identification, and how entry-maps are built (covered by the summary index format spec).
- The search catalog pipeline that consumes the catalog (a separate topic).
- The display-topic collector's internal mechanics; only its externally observable contract ("flattens nested-children topics into a single ordered list, handling legacy data") is referenced here.
- The storage backend's atomic write and locking primitives (covered by the storage backend spec).

## Data Contracts

### Catalog container

A single structured record holding:

- **format version** (required, integer): currently `1`. Independent of the index format version — the two version markers evolve separately.
- **entries** (required, list): zero or more catalog entries in insertion order.

### Catalog entry

One record per root commit summary. Fields:

- **commit hash** (required, string): the commit hash this entry describes. Joins to the corresponding index entry. Globally unique within the catalog.
- **recap** (optional, string): a one-paragraph narrative summarizing the commit. Omitted when absent.
- **ticket identifier** (optional, string): a ticket or issue reference sourced from the summary payload. The catalog is the authoritative holder of this field; the index does not carry it. Omitted when absent. **Copied verbatim, with no validation:** the projection takes whatever the payload holds, so a legacy identifier that does not conform to the whitelisted ticket shape (a plan slug, a commit hash, a placeholder phrase) is carried into the catalog unchanged and re-carried on every subsequent write-along — even though the two read surfaces that do re-validate suppress that same value.
- **topics** (optional, list): zero or more topic records derived via the display-topic collector. Omitted when absent.

### Topic record

One record per topic surfaced by the display-topic collector. Fields:

- **title** (required, string): the topic's display title.
- **decisions** (optional, string): full-length decisions text. No length cap is applied at storage time; trimming is a search-pipeline concern. Omitted when absent.
- **category** (optional, enumerated string): topic category classification. Omitted when absent.
- **importance** (optional, enumerated string): one of `major` or `minor`. Omitted when absent.
- **files affected** (optional, list of strings): paths or identifiers of files touched by this topic. Omitted when absent.

Optional fields at every level are omitted entirely when absent — they are not written as explicit null values.

## Behavior

### Passthrough load

A direct, non-reconciling loader that returns the catalog container as stored, or null when:
- the catalog file is absent, or
- the file cannot be parsed (parse failure is logged at error level before returning null).

No lock is acquired. No reconcile is performed. Callers that need a guaranteed-fresh, non-null view must use the freshness-aware loader instead.

### Freshness-aware load (lazy build)

The only path the rest of the codebase uses to consume catalog data. Returns a non-null catalog, building or reconciling if necessary.

1. **Pre-flight check (no lock):** read the catalog via the passthrough loader. If every entry's commit hash is a current root in the index, and every current root in the index has a corresponding catalog entry, the catalog is fresh — return it immediately without acquiring the lock.
2. **Lock acquisition:** acquire the shared cross-process lock that gates summary writes.
3. **Lock contention:** if the lock cannot be acquired, compute an in-memory reconciled view — drop entries whose hash is no longer a root, append stub entries for missing roots where possible — and return that view without writing it back to disk. This is a stale-coherent degradation; the on-disk catalog remains unchanged.
4. **Reconcile and persist:** with the lock held:
   - Drop all entries whose commit hash is no longer a root in the current index.
   - For each current root not already represented in the catalog, read that root's summary payload and project a new entry. If a root's summary payload is unreadable, log a warning and skip that root.
   - Append new entries after the surviving existing entries (insertion-order preservation; see Ordering under State Transitions).
   - Atomically write the updated catalog with a commit message recording the counts of entries added and removed.
5. Release the lock and return the reconciled catalog.

### Eager write-along

Every summary write operation (initial write, amend-migration, squash-merge consolidation) emits a catalog write in the same atomic batch as the summary payload write and the index write. Readers see either the pre-write or post-write state, never a partial.

Reconcile rule applied during write-along:
1. Load the current catalog (treat absent as an empty container).
2. Build the current index entry-map from the just-written index.
3. Drop catalog entries whose commit hash is no longer a root in that entry-map.
4. Append or replace the entry for the root being written.
5. Submit the updated catalog as part of the atomic batch.

### Eager removal

When an explicit-removal index update is issued:
1. Check whether the removed commit hash is present in the current catalog.
2. If present: remove that entry and submit the updated catalog in the same atomic batch as the index write.
3. If absent: omit the catalog file write entirely (no-op).

### Bulk population (migration)

During the index v1→v3 schema migration, the catalog is populated in the same atomic batch by projecting a catalog entry from every successfully flattened root. Roots whose summary payloads cannot be read are skipped without failing the migration.

### Bootstrap

When the catalog file is absent (legacy install, surface that wrote without catalog awareness), the passthrough loader returns null and the freshness-aware loader treats this as an empty container with format version 1. The lazy build then fills the catalog from the current index roots.

## State Transitions

A catalog entry, keyed by commit hash, transitions through these states:

- **Absent** → **Present** when a summary write-along produces a root entry, when the lazy build appends a missing root, or when the bulk migration populates it.
- **Present** → **Absent** when a write-along reconcile determines the hash is no longer a root in the freshly-written index, when an eager removal targets it, or when a lazy-build reconcile drops it.
- **Present** → **Present (updated)** when a write-along replaces the entry for a root that was already cataloged (e.g. an amend that leaves the commit hash as a root updates the entry's recap and topics in place).

Catalog entries are never descendants — a hash that transitions from root to descendant in the index is dropped from the catalog by the next write-along or lazy-build reconcile.

Ordering within the entries list: surviving entries retain their existing position; newly appended entries are added after all surviving entries. No chronological sort is applied.

## Notable Behavior

### Root-only by design

The catalog holds exactly one entry per root commit hash. Looking up a descendant commit hash in the catalog is intentionally impossible — the catalog is not a substitute for the index on non-root queries.

### Independent version markers

The catalog's format version and the index's format version are separate integers that evolve independently. A reader must not infer the catalog version from the index version or vice versa.

### Decisions stored at full length

Topic decisions text is persisted without truncation. Applying a token budget or character limit is the responsibility of the search pipeline that consumes the catalog, not of the catalog storage layer.

### Ticket identifier is catalog-authoritative

The ticket identifier field is present only in catalog entries, not in index entries. Surfaces that need ticket identifiers for root commits must read the catalog; copying the field into the index would require a coordinated schema migration across all three implementations of the index consumer.

### The authoritative holder of the ticket identifier is not a validated one

An asymmetry worth stating plainly: the catalog is where the ticket identifier lives for root commits, yet the catalog projection applies **no** shape validation to it, while the whitelist that guards that field at read time is applied at two entirely different surfaces (a panel title, and the per-commit hit projection behind the recall payload). Consequently a non-conforming legacy identifier is invisible at those two guarded surfaces yet permanently present — and re-persisted on every write-along — in the very file that is treated as authoritative for the field. Neither guarded surface writes back, so nothing ever repairs the catalog copy. The whitelist itself is owned by **Multi-Topic Commit Summary Generation**.

### Stale-coherent degradation under lock contention

When the lazy build cannot acquire the lock, it returns an in-memory reconciled view rather than blocking or failing. That view is coherent (no phantom entries, no missing known roots that could be derived from already-loaded data) but may be incomplete for roots whose payloads would require a fresh read. The on-disk catalog is not modified; the next uncontested read will complete the reconcile and persist.

### Catalog coexists with the index

The catalog does not replace the index. Callers that need every-entry data (including descendants, tree hashes, diff stats, commit types) continue to use the index. The catalog exists specifically for the search pipeline's Phase 1 path, which needs recap and topics on root-only entries without loading individual payload files.

### Consumers of the freshness-aware load

Two surfaces consume the catalog via the freshness-aware (guaranteed-non-null) loader and benefit from the lazy build + reconcile semantics described above:

- **Search command surface Phase 1.** The two-phase search pipeline's Phase 1 builds a scannable per-root catalog view for the chat LLM by joining the index's per-root metadata with this catalog's per-root recap and topics. See **Search Command Surface** and **Two-Phase Search Pipeline**.
- **MCP search tool source signature.** The MCP server's `search` tool folds a digest of the catalog's content (per-root recap plus per-topic title and decisions text) into the source signature it uses to decide whether the persisted search index is stale, so an in-place edit that does not change the index's entry count (e.g. a recap rewrite) still rebuilds the index. See **MCP Server Tool Surface**.

Both consumers rely on the same single read of the freshness-aware loader; they do not maintain independent catalog copies.

### Display-topic collector handles legacy nesting

Topics in each catalog entry are produced by a shared display-topic collector that flattens nested-children topic structures into a single ordered list. This ensures squash-consolidated and amend-merged topics are surfaced correctly, even when the underlying payload carries them in a nested form from an older summary generation.

## Shared Behavior

- **Storage backend** — atomic multi-file writes, payload paths, the read/write plumbing of whichever backend is this repository's system of record, and the cross-process lock primitive. **The catalog is submitted in the same batch as the summary and index writes, so in every writable routing state it lands in the Memory Bank folder's hidden layer as well as in the system of record, rather than under one configured storage mode** (that routing is owned by spec 344).
- **Summary index format** — how roots are identified, the structure of the index entry-map, and the index's own atomic update protocol that the catalog write-along participates in.
- **Summary tree structure** — the payload structure that catalog projection reads to extract recap, ticket identifier, and topics.
- **Cross-process lock** — the shared lock acquired by the lazy build and held during all write operations on the summary store.
- **Schema migration** — the v1→v3 index migration that triggers bulk catalog population.
- **Display-topic collector** — the shared utility that flattens nested-children topic data into an ordered list; its behavior is not duplicated here.
- **Search Command Surface** — defines the externally-observable behavior of the search command path that triggers the catalog's Phase 1 consumption.
- **MCP Server Tool Surface** — defines the externally-observable behavior of the MCP `search` tool whose source-signature computation reads this catalog.
- **Local Search Index** — defines the persisted-index freshness model that the MCP search tool's source signature drives.
