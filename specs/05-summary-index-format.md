# Summary Index Format

## Topic Statement

A flat record set, persisted alongside summary payloads, that enables fast lookup, listing, pagination, and cross-branch matching of every summary node ever stored — root or descendant — without loading individual summary payloads.

## Scope

**In scope:**
- Shape of a single index entry and the surrounding index container.
- Atomic update of the index alongside any payload write.
- Ordering, listing, and counting semantics derived from the index.
- Format-version markers and how readers branch on them.
- Tree-hash and commit-hash alias mechanisms used for cross-branch resolution.
- Tie-break rules when multiple entries share a tree hash.
- Recovery behavior when the index is missing or corrupt.

**Out of scope:**
- The summary payload tree itself (node nesting, hoist semantics, content fields).
- The storage backend used to persist files (covered by the storage-backend topic).
- The end-to-end commit/amend/squash/rebase pipelines (covered by the pipeline topic).
- Migration mechanics from older formats (covered by the schema-migration topic).

## Data Contracts

### Index entry

A lightweight record describing one node in the summary forest. Fields:

- **commit hash** (required, string): the commit hash this node was written for. Globally unique within the index — acts as the primary key.
- **parent commit hash** (required, nullable): the commit hash of this entry's direct parent in the summary forest.
  - `null` (explicit): this entry is a root — its full payload exists at the top of the summary store under this commit hash.
  - non-null string: this entry is a descendant; the named hash is its direct parent in the forest.
  - absent / undefined (legacy only): treat as a root for backward compatibility.
- **tree hash** (optional, string): the hash of the source-tree snapshot that the original commit pointed to. Populated when computable; absent when the commit is no longer reachable in the source store. Used for cross-branch matching.
- **commit type** (optional, enumerated): how the commit was produced (e.g. plain commit, amend, squash, rebase, cherry-pick, revert). Cached on the entry so list views can render type badges without loading the payload.
- **commit message** (required, string): the commit's own message text.
- **commit date** (required, ISO timestamp): the commit's author/commit timestamp.
- **branch** (required, string): the branch name on which the summary was generated.
- **generated-at** (required, ISO timestamp): when the summary record was produced.
- **topic count** (optional, integer, root entries only): total number of topics across the entire summary subtree. Cached for list-badge display.
- **diff stats** (optional, root entries only): files-changed, insertions, deletions for the actual commit-vs-parent diff. Cached on the entry so list views never re-run a diff.

### Index container

A single structured record holding:

- **format version** (required, integer): currently a small enumeration of supported format versions (legacy version `1` and current version `3`). Determines reader behavior — see Notable Behavior.
- **entries** (required, list): all entries, in no required order.
- **commit aliases** (optional, map of string → string): a cache of "unknown commit hash → known commit hash" redirections, populated by tree-hash matching. Once written, an alias is never deleted.

### Display-date convention

A common rule used for sorting: the most recent of the entry's commit date and generated-at timestamp wins. Amended/regenerated entries thus surface as recent activity even when the underlying commit is old.

### Ambiguous-hash error contract

When the abbreviated-identifier prefix scan returns more than one match, the lookup raises a typed error carrying:
- The prefix that was supplied. **Invariant:** the prefix length is strictly between 0 and 40 characters; constructors that violate this raise a plain error rather than producing a degenerate ambiguous-hash error.
- The list of full commit hashes that matched. **Invariant:** the list contains at least two entries; the not-found case must surface as a normal not-found return rather than a single-match ambiguous error.

The error is identified by a name field set to a stable string. Catch sites use a duck-typed guard (name string equality plus a structural shape check on the carried fields) rather than a class-based instanceof check, so the catch survives cross-bundle deserialization where the error's prototype chain may differ between sender and receiver.

## Behavior

### Listing recent roots

1. Load the index container.
2. If absent or empty, return an empty list.
3. Filter to entries whose parent is null (or absent for legacy-version entries).
4. Sort the filtered set by the display-date convention, descending.
5. Take the first N (N supplied by caller, default an implementation-defined small constant).
6. For each surviving entry, load the corresponding root payload and return only those that loaded successfully.

### Counting roots

1. Load the index.
2. Return the count of entries whose parent is null (or absent for legacy entries).

### Hash membership query

1. Load the index.
2. Return the union of all entry commit hashes plus all keys of the alias map.

### Per-entry lookup with cross-branch fallback

The lookup accepts an input commit hash that may be the full identifier or any abbreviation of 1 to 40 hex characters.

1. **Normalize.** The input is lowercased before any matching. Index entries, filenames on disk, and alias-map keys are all stored lowercase, so an uppercase abbreviated input that bypasses normalization would only resolve through the cross-tree fallback in the terminal step, never through the index.

2. **Empty-string short-circuit.** A zero-length input returns not-found immediately, without loading the index. (Without this, a zero-length prefix would match every entry in the prefix-scan step and surface as an ambiguous-hash error listing every hash in the index — a degenerate response shape.)

3. **Direct read.** Attempt to load the payload file named by the input identifier. On hit, return the loaded payload. This step always runs before the index is loaded.

4. **Branch on input length.** Load the index. If absent, return not-found. Then:
   - **Full-identifier branch (input length equals 40):** look up the input in the alias map. If a redirection is recorded, dereference it once and load the aliased payload. If no redirection, fall through to the cross-tree fallback in the terminal step.
   - **Abbreviated-identifier branch (input length is 1 to 39):** scan the index entries for any whose commit hash starts with the input, treating the input as a prefix. Three outcomes:
     - **Exactly one match:** load the matched entry's payload.
     - **Two or more matches:** raise an ambiguous-hash error carrying the input prefix and the full set of matching commit hashes (see "Ambiguous-hash error contract").
     - **Zero matches:** fall through to the cross-tree fallback in the terminal step.

   *Notable boundary:* abbreviated input never resolves through the alias map. Aliases are scanned from already-resolved 40-character identifiers, so an abbreviated input would only hit aliases coincidentally; the deliberate design forces abbreviations to resolve against live index entries via the prefix scan, where ambiguity can be reported back to the caller.

5. **Cross-tree fallback (terminal).** Reachable from both branches. Only applies when the loaded index is at the current format version (legacy index versions return not-found). Compute the source-tree hash of the input commit by querying the underlying source store. If unavailable, return not-found. Build a working entry-map from the index, find all entries with a matching tree hash, pick the shallowest entry per the tree-hash tie-break rule (see "Tree-hash tie-break"), and load its payload. Return not-found if no entry matches.

   The fallback is "cross-tree" in the sense of cross-commit-tree-pointer: it catches cherry-pick / rebase copies that share a source-tree snapshot with an indexed commit but are not themselves in the index. It is not cross-worktree and not cross-summary-store.

### Tree-hash tie-break

When multiple entries share the same tree hash:

1. Compute each entry's depth: walk parent links until a null parent is reached, counting steps. Cycles are guarded by tracking visited hashes; on a cycle, the walk halts and the depth so far is used.
2. Sort: shallowest first; on equal depth, most recent display-date first.
3. Return the first entry.

This biases matches toward container roots over buried descendants and toward recently-regenerated entries over stale siblings.

### Background alias scan

Given a list of candidate commit hashes (typically those that didn't match directly):

0. **Refuse outright when this process sees the manually-disabled suppression flag**, before the index is loaded and — crucially — before the shared cross-process lock is acquired. Acquiring that lock is itself a disk write, and the alias write it guards would be dropped by the storage gate anyway, so taking it would create a lock file for a write that can never land. The refusal reports **"no new aliases written"** — the same answer as "nothing to alias" — which is what stops the caller from re-detecting the same candidates and re-creating the lock file on every refresh. (The suppression flag — what it is, and which processes ever set it — and the broader no-write promise are owned by **Zero-Write Contract for a Manually-Disabled Repository** (304); only this scan's own refusal and its return value are specified here.)
1. Load the index. If absent, or its format version isn't current, do nothing.
2. For each candidate not already an entry and not already an alias key:
   1. Compute its tree hash. If unavailable, skip.
   2. Find the shallowest entry with the same tree hash. If found, record the candidate-to-entry redirection in a working alias map.
3. If no new aliases were found, do nothing.
4. Otherwise acquire the shared cross-process lock.
   - If the lock cannot be acquired, abandon the write — a future scan will retry.
5. Merge the working aliases over the existing aliases (existing wins on key conflict — implementation merges new over old, but the precondition above already excludes existing keys, so order is moot).
6. Persist the updated index. Release the lock.

### Atomic index update

Every payload write that touches a summary forest is paired with a fresh index serialization in the same atomic write. The procedure for one payload-affecting operation:

1. Load the existing index, or treat as empty if absent.
2. Build a working map: existing-entries by commit hash.
3. For the operation's new or modified subtree, walk it depth-first, producing one entry per node. Each entry's parent link is set to its direct parent in the walk; the root's parent is null. Tree hashes are computed where possible. For root nodes, derive cached topic count and cached diff stats from the node's own data, falling back to the existing entry's cached diff stats when the node lacks them, falling back to a fresh diff computation as a last resort.
4. Upsert each produced entry into the working map, replacing prior entries for the same commit hash.
5. Construct the new index container: current format version, entries derived from the working map's values, alias map preserved verbatim from the prior index.
6. Submit the payload writes plus the index serialization as one atomic batch.

### Reclassification on rewrite

When an entry that was previously a root is upserted with a non-null parent (e.g. an amend wraps the old root inside a new root), the upsert overwrites the old entry. The previous root entry's identity is preserved (same commit hash); only its parent link changes from null to the new parent's hash. No separate "remove from index" call is issued in rewrite flows.

### Explicit removal

A separate removal path exists for administrative cleanup. It strips an entry by commit hash and writes only the updated index. This path must not be used in amend, squash, or rebase flows: the upsert mechanism above already reclassifies the affected entries, and a removal would orphan descendants whose parent link still points to the removed hash.

## State Transitions

A single entry, by commit hash, transitions through these states:

- **Absent** → **Root** when its first summary is written (parent = null).
- **Root** → **Descendant** when a rewrite operation produces a new root that adopts this entry as a direct or indirect child (parent updated to the new root's hash).
- **Descendant** → **Root** is not a normal flow but is structurally permitted on re-upsert.
- **Any** → **Aliased-from** when a different unknown hash gets a tree-hash match against this entry; the alias map gains a key but this entry itself is unchanged.
- **Any** → **Removed** only via the explicit administrative removal path.

The index format-version transitions from legacy to current only via the schema-migration flow.

## Notable Behavior

### Format-version branching

Readers inspect the format-version marker on every load:

- Legacy version: every entry is treated as a root regardless of its parent field. Cross-branch tree-hash fallback is not attempted. Migration is required before the current behaviors apply.
- Current version: entries with explicit null parent are roots, entries with non-null parent are descendants, entries with absent/undefined parent are legacy stragglers treated as roots. Cross-branch tree-hash fallback and alias scanning are enabled.

The migration check itself only inspects the version marker; it does not require any per-entry reformatting.

### Aliases never expire

Once a tree-hash match writes an alias, it persists for the life of the index. There is no eviction. This trades a bounded-but-unbounded growth in the alias map for guaranteed O(1) re-lookup of previously matched unknown hashes.

### Listing relies on the cached display-date

Amend, squash, and rebase reshuffle entries; relying on insertion order would yield wrong "most recent" results. Sorting by the display-date convention keeps regenerated entries at the top regardless of when they were first inserted.

### Diff-stats source-of-truth precedence

For a root entry's cached diff stats, the upsert prefers (1) the value carried on the freshly-built node, (2) the value already cached on a prior entry for the same hash, (3) a freshly computed diff against parent. This guarantees the cached payload and the cached entry agree by construction whenever both are written together, and avoids a redundant diff call when neither has changed.

### Tree-hash availability is best-effort

When the tree hash for a node cannot be computed (e.g. the source object is no longer reachable), the entry is written without that field. This is not fatal: lookups for that hash fall back to direct payload read, and cross-branch matching for it simply cannot succeed until/unless the object becomes reachable again.

### Recovery from corrupt index

On parse failure of the index payload, readers log the failure and treat the index as absent. Writers that subsequently produce an upsert will rebuild a fresh index from the operation's own subtree only — older entries not represented in the operation are lost from the index but their underlying payload files remain. There is no automatic full-index rebuild; recovery is opportunistic and incremental. When the index file is read but parses as a null payload (the absent-or-empty case), the read path now logs a warning at production-visible level distinguishing "fresh repository" from "underlying source store read failure" — older code returned silently.

### Locking for alias-only writes

Pure alias scans (no payload changes) acquire the same shared cross-process lock that the summary-write pipelines use. If the lock cannot be acquired, the alias write is silently dropped — a future invocation retries. This is acceptable because aliases are a cache and never load-bearing for correctness, only for performance.

### A disabled project's alias scan refuses before the lock, and says so

The manually-disabled refusal is placed ahead of the lock acquisition rather than relying on the storage layer to swallow the write, because the lock file is itself a write. Equally load-bearing is the *answer* it returns. Callers treat "new aliases written" as "your view is out of date, refresh" — and a refresh recomputes the same unmatched-candidate set and re-enters the scan. Reporting "no new aliases written" therefore terminates the cycle; claiming success while writing nothing would spin refresh → rescan → lock-file write on every tick, which is precisely the loop the gate exists to prevent. (Surprising; load-bearing.)

### Counting and listing exclude descendants

Both the root count and the recent-roots listing filter to parent-null entries. Descendant entries exist for lookup and traversal only, not for top-level display. A summary forest with N source commits collapsed into one root contributes 1 to the root count and N+1 entries to the index.

## Shared Behavior

- **Storage backend** — atomic multi-file writes, payload paths, and locking primitives.
- **Summary tree format** — the payload structure that the index flattens into entries; in particular, what counts as a root vs descendant, and what topic count and diff stats mean inside a node.
- **Schema migration** — the transition from the legacy index format to the current one, including version markers and entry shape changes.
- **Pipeline operations** — when and why upserts happen (commit, amend, squash, rebase pick, manual overwrite).
- **Cross-process lock** — the shared lock that gates all writes to the summary store.
