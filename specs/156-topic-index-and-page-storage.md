# 156. Topic Index and Page Storage

## Topic Statement

Persist the topic knowledge base as a single routing index plus one canonical document per topic, identified by a path-safety-guarded slug, through the active storage backend with corruption-tolerant reads.

## Scope

**In scope:**
- The two named persisted artefacts: the routing index (one file listing every topic by stable slug, title, summary, related branches, source references, and last-updated instant) and per-topic canonical pages (one file per topic, keyed by stable slug, carrying the full body plus the same per-topic metadata as the index entry).
- The fixed logical paths the two artefacts occupy under a topics directory: a single `index.json` at a well-known location plus per-topic `<slug>.json` siblings.
- Slug path-safety validation at the persistence boundary (read and write), with read of an unsafe slug returning the same value as a missing page and write of an unsafe slug throwing.
- Corruption tolerance on reads: a missing or unparseable index reads as empty; a missing or unparseable page reads as null; a schema-version-only index with no topics field reads as empty.
- The single commit message attached to each index write and each page write.
- Slug listing under the topics directory, with two reserved filenames excluded (the index file and the high-water mark file).
- Orphan purge: deletion of every page whose slug is not in a caller-supplied keep set, returning the purged slugs and skipping a write when nothing needs to be purged.
- The fallback resolution chain used when a caller does not thread an explicit storage handle: caller-supplied → process-global active override → newly-constructed default backend.

**Out of scope (boundaries):**
- How the index and page contents are produced (see spec 152 — topic ingest pipeline).
- The visible wiki layer that may be rendered from these pages (separate spec for the wiki markdown rendering).
- The per-storage-backend mechanics: orphan-branch commits, folder-mirror file writes, and the dual-write composite that fans both out (specs 01, 02, 03). The store described here only calls into the active backend through its abstract file-write contract.
- The high-water mark of processed source identifiers (a third file under the same topics directory, owned by a separate persistence module — its corruption tolerance and version field follow the same conventions but are not specified here).
- The memory-bank folder layout that determines the on-disk root the folder backend points at (spec 151).
- The repository identity resolution and folder claiming flow that picks which root directory a project's storage operates on (separate spec — repository name extraction and KB-path collision handling).
- The slug normalisation tier upstream of the persistence boundary: the route/reconcile layer is responsible for producing a safe slug; this layer only enforces a final guard.

## Data Contracts

### Routing index (persisted, one per topic-KB)

The single routing index file holds:

- **Schema version** — fixed integer (currently 1). The reader does not branch on the value, but the field is written unconditionally so future readers can.
- **Topics** — an ordered list of entries. Each entry carries:
  - **Stable slug** — kebab-case identifier used both as the entry key and to derive the per-topic page's filename. Required.
  - **Title** — human-readable label.
  - **Summary** — short one-sentence description used as the topic's index bullet.
  - **Related branches** — list of real branch names contributing to this topic, in first-seen order.
  - **Source references** — list of folded source identifiers. Each carries a type, a stable identifier, an ISO-8601 timestamp, and an optional originating branch (absent for sources that are not branch-scoped or for entries persisted before the field existed).
  - **Last-updated** — ISO-8601 instant.

The file is serialised as tab-indented JSON. Missing file or unparseable content is treated as an empty index (schema version 1, empty topics list) — never throws. An index whose top-level shape lacks a topics field is also treated as empty (the reader defaults the missing field to an empty list).

### Topic page (persisted, one per topic)

Each topic owns a separate file whose name is derived from the entry's stable slug. Each page carries:

- **Schema version** — fixed integer (currently 1).
- **Stable slug** — the same value used to derive the filename.
- **Title** — same as in the index entry.
- **Content** — the reconciled prose body. This is the only field absent from the index entry.
- **Related branches** — same shape as in the index entry.
- **Source references** — same shape as in the index entry.
- **Last-updated** — same shape as in the index entry.

The page file is serialised as tab-indented JSON. Missing file or unparseable content yields a null page on read — never throws.

### Slug safety predicate (shared by every persistence-boundary call)

A slug is **safe** when all of the following hold:
- It is a non-empty string.
- It does not contain the forward-slash character.
- It does not contain a literal two-dot sequence.

Any slug failing the predicate is **unsafe**. The predicate is applied as the very first step inside every public read, write, and (indirectly via list filtering) purge operation that interpolates a slug into a path — before any storage call is made.

### Reserved filenames under the topics directory

Two basenames sit alongside topic pages but are not pages and must never appear in the slug list returned by enumeration:
- The routing index file's basename.
- The high-water-mark (processed-set) file's basename.

The slug enumerator filters these out by exact-basename match against a small reserved set.

### Write batch shape

Every write goes through the active backend's multi-file write contract: a list of entries (each carrying a path, the new content, and an optional delete marker) plus a single commit message string. The store layer issues each write as a single batch (one entry for the index file write, one entry per page on a page write, N delete-marker entries on a purge).

### Resolved storage handle

The fallback chain used to find the storage backend for a call is:

1. The handle passed in explicitly by the caller (highest priority, used by the ingest pipeline to thread a snapshot view).
2. The process-global active override (set by the compile sweep when iterating per-repo).
3. A newly-constructed default backend bound to the caller's working directory.

The third tier emits a warning (suppressed under the test runner) because it bypasses the configured dual-write fan-out — folder-mirror users would silently miss writes that fall back to it.

## Behavior

### Read the routing index

1. Resolve the storage handle (caller → process-global → default-construct).
2. Issue a single read for the index file at its fixed path.
3. If the backend returns null (file absent), return an empty index (schema version 1, empty topics list).
4. Otherwise attempt to parse the content as JSON.
5. If parsing throws, log a warning ("failed to parse — treating as empty") and return an empty index.
6. Otherwise return a normalised index: schema version forced to 1, topics list taken from the parsed object's topics field or substituted with an empty list when the field is absent.

The reader does not validate any per-entry field shape. Garbage entries that happen to deserialise as JSON pass through unchanged. The schema-version field on the returned object is always set to the current value regardless of what the file carried.

### Write the routing index

1. Resolve the storage handle.
2. Serialise the index object as tab-indented JSON.
3. Issue a single write batch containing one entry (the index file's path and serialised content) with a commit message of the form `Update topic KB index (<N> topics)` where N is the entry count.
4. The backend's write semantics apply (atomic for the version-controlled-ref backend, per-file atomic but not batch-atomic for the folder-mirror backend, primary-then-shadow with swallowed shadow failures for the dual-write composite).

There is no read-modify-write guarantee at this layer. A caller that wants to update the index must read, mutate, and write — concurrent callers can race. The compile entry point holds an external vault-write lock to serialise this against the worker; the worker holds the same lock for the duration of a drain.

### Read a topic page

1. Apply the slug safety predicate to the caller-supplied slug.
2. If the slug is unsafe, log a warning and return null **without touching storage**. The warning carries the unsafe slug verbatim. (Path-traversal guard.)
3. Otherwise resolve the storage handle.
4. Issue a single read for the file at `<topics-dir>/<slug>.json`.
5. If the backend returns null, return null.
6. Otherwise parse the content as JSON. If parsing throws, log a warning and return null. (Corruption tolerance.)
7. Otherwise return the parsed object verbatim. The reader does not validate the object's shape against the page schema.

### Write a topic page

1. Apply the slug safety predicate to the page object's stable slug.
2. If the slug is unsafe, throw an error whose message contains the literal phrase "unsafe slug" followed by the slug. No storage call is made. (Page slugs come from upstream model output via the reconcile parser; this is the final boundary check before disk.)
3. Otherwise resolve the storage handle.
4. Serialise the page object as tab-indented JSON.
5. Issue a single write batch containing one entry (the per-slug file path and serialised content) with a commit message of the form `Update topic page <slug>`.

### List topic page slugs

1. Resolve the storage handle.
2. Ask the backend to list every file under the topics directory.
3. Filter the listing to entries whose path starts with the topics directory prefix and ends with the `.json` extension. (Defensive: a well-behaved backend already returns paths under the requested prefix, but the filter survives extra entries from a future backend that lists more.)
4. For each surviving path, slice off the directory prefix and the trailing extension to recover the bare slug.
5. Drop any slug that is empty, contains a forward-slash (a nested file rather than a sibling), or matches one of the reserved basenames. Note that the listing filter only checks for `/` and the reserved set — it does **not** apply the full safety predicate. A slug containing a literal `..` would survive listing (it would fail to be created in the first place because writes are guarded, but a file pre-existing on disk from outside this store would surface here).
6. Return the surviving slugs in the order produced by the backend.

### Purge pages outside a keep set

1. Materialise the caller-supplied iterable of keep-slugs as a set.
2. Resolve the storage handle.
3. Enumerate the slug list (delegating to the list operation above, threading the resolved handle).
4. Compute the orphans: every enumerated slug not in the keep set.
5. If the orphan list is empty, return an empty list **without issuing any storage call**. (No-op fast path.)
6. Otherwise issue a single write batch containing one delete-marker entry per orphan (each entry carries the orphan's per-slug file path, an empty content string, and the delete flag) with a commit message of the form `Purge <N> orphaned topic page(s)`.
7. Log the purge at info level with the count and the comma-joined list of slugs.
8. Return the orphan list (as a plain array, in the same order as the enumeration).

The single-batch delete propagates to both layers of any dual-write composite (the primary backend's delete-by-directive and the shadow backend's hidden-file unlink).

### Empty-index constructor

A separate exported helper returns a freshly-allocated empty index (schema version 1, empty topics list). Callers use it from the rebuild path (the compile entry point with the `--rebuild` flag), which writes this empty value to disk to reset the routing index in place before re-running ingest.

### Storage fallback warning

When the storage handle cannot be resolved from either the caller or the process-global override, the fallback emits a single warning ("caller did not thread storage or call setActiveStorage. Folder-mode users will miss this write") and returns a default backend bound to the working directory. The warning is suppressed when running under the test runner. The default backend is the version-controlled-ref backend — chosen as the "system of record" so a missed thread does not silently lose data, at the cost of bypassing the configured fan-out for folder-mode users.

## State Transitions

### Per index entry

```
ABSENT ──(caller upserts the entry)──> PRESENT
PRESENT ──(caller upserts the same slug with new fields)──> PRESENT (replaced in place)
PRESENT ──(caller writes the empty index — rebuild)──> ABSENT
```

The store itself does not upsert; callers read, mutate, and write. The replace-in-place vs append-on-write semantics live entirely in the caller's mutation logic.

### Per page file

```
ABSENT ──(write with safe slug)──> PRESENT
PRESENT ──(write same slug with new fields)──> PRESENT (replaced)
PRESENT ──(purge excludes this slug)──> ABSENT (delete-marker batch)
ANY ──(write with unsafe slug)──> ANY unchanged; write throws
```

A page file outliving its index entry (e.g. a rebuild that emptied the index, or a slug-change during reconcile) is an **orphan**. Orphans linger until the next purge. The purge converges page files to the routing index but does not run automatically — it is invoked by the caller, and exactly one caller invokes it: the single-repo compile entry point on its rebuild path, once after that invocation's drain. No ordinary drain purges, so an orphan created outside a rebuild persists until the next rebuild.

### Per read on a corrupt file

```
file absent ──> empty value (no warning)
file present + unparseable ──> empty value + warning logged
file present + parseable ──> returned verbatim (no shape validation)
file present + missing topics field (index only) ──> empty topics list (no warning)
```

The same shape applies to the page read with "empty value" replaced by "null".

## Notable Behavior

- **Path-traversal guard is the only validation at the persistence boundary.** Slugs reach this layer from the route/reconcile pipeline; the upstream normalisation tier already enforces character set, dedup, length cap, and a fallback to `untitled-topic`. This layer trusts none of it and re-checks for the three patterns that would let a slug escape the topics directory or nest a file inside another directory: empty string, embedded slash, embedded `..`. Read of an unsafe slug returns null with a warning before any storage call; write of an unsafe slug throws before any storage call.
- **The corruption fallback is "treat as empty", not "abort".** A drain that finds an unparseable index file proceeds as if the index were freshly empty — the route model receives `(none yet)`, every topic is treated as new, and reconcile rebuilds pages from scratch. This is the same trajectory the rebuild flag drives intentionally. (Surprising on first read but intentional: it lets a manually corrupted vault recover by running ingest, rather than wedging every drain on the parse error.)
- **Reads never throw; writes can.** The save-page operation is the only call in the store that throws — exclusively on an unsafe slug, which is upstream's bug. Every other failure mode (missing file, corrupt JSON, missing schema field, backend read error surfacing as null) is swallowed into a benign empty/null return value.
- **No layer-level locking.** The store performs no locking around the read-mutate-write cycle. Callers that need atomicity hold the external vault-write lock (the same one used by the worker drain and the sync engine) for the duration of their mutation sequence. The atomicity guarantees come from the underlying backend: the version-controlled-ref backend is atomic per write batch; the folder backend is atomic per file but not per batch; the dual-write composite is primary-first sequential with swallowed shadow failures. There is no transactional grouping across the index write and the page writes — a crash between them leaves the index referring to a missing page (a subsequent read returns null and the next ingest cycle re-creates the page) or a page with no index entry (lingers until the next orphan purge).
- **Single-write commits, one message per artefact.** The index write and every page write produce their own commit on the version-controlled-ref backend; the orphan purge produces one delete commit batching every orphan. Folder-mirror writes likewise issue per-file atomic moves but share the batch's commit message only for logging.
- **Tab-indented JSON.** Both files are serialised with a tab as the indent string. A human re-reading the orphan branch sees pretty-printed content. (No surprises; recorded for completeness.)
- **Listing tolerates a permissive backend.** The slug enumerator double-filters the backend's listing (prefix start + extension end) instead of trusting that the backend already restricted to the requested prefix. This is defensive against future backends.
- **Reserved-name filter excludes only two basenames.** Any future sibling file under the topics directory would be returned by the enumerator as a "slug" unless its basename is added to the reserved set. (Notable: the high-water-mark file's basename is currently the only non-index basename in the reserved set.)
- **Purge is a single batch and best-effort no-op when empty.** A purge invoked with a keep set that already covers every on-disk page issues zero writes (the call is observably a no-op, including no commit, no log line, and no shadow-layer ping).
- **The default empty index is materialised by a separate helper.** The same shape is returned from every "missing or corrupt" path, but the rebuild flow uses the explicit helper to make the "reset in place" intent visible at the call site.
- **Storage fallback emits a warning, not an error.** When a caller forgets to thread the storage handle and the process-global override is also unset, the store falls back to constructing the version-controlled-ref backend bound to the caller's cwd. The warning is the only signal — under dual-write mode, the fan-out to the folder mirror is silently skipped for that one call. The warning is suppressed under the test runner so unit tests do not have to muffle it.
- **The page schema and the index-entry schema overlap entirely except for the content field.** The duplication is deliberate so the index can be served as a directory of topics without touching the per-page files. A page write therefore does not implicitly update the index; the caller must write both artefacts whenever an entry's metadata changes.
- **The slug list returned by enumeration is not deduplicated against the routing index.** A page file with no matching index entry is still returned. This is the input the orphan purge depends on.
- **Schema version is forced on read, not validated.** The reader always returns the current schema version on the in-memory object regardless of what the file's schema-version field said. A future cross-version migration would replace the reader, not branch inside it.

## Shared Behavior

- **Storage backend abstraction.** All reads and writes are issued through the active storage provider's read-file / list-files / write-files contract. The store does not know whether the backend is the version-controlled-ref backend, the folder-mirror backend, or the dual-write composite that fans both out. See specs 01 (orphan-branch summary storage), 02 (folder-based summary storage), and 03 (dual-write summary storage) for the per-backend mechanics.
- **Active-storage resolution chain.** The caller → process-global override → default-construct chain is shared with the summary store (which uses the same resolver). The compile sweep swaps the process-global per repo and restores it in a finally; the worker dispatch threads an explicit handle so the resolution never falls past tier 1.
- **Pages and the visible wiki.** The wiki layer is rendered from these canonical pages by the wiki renderer (separate spec). The renderer reads pages by walking the routing index — not by directory scan — so any orphan page that escaped a purge cannot appear in the visible wiki even if it lingers on disk.
- **Slug normalisation upstream of this layer.** The compile-side parser normalises raw model slugs (lowercase; non-`[a-z0-9-]` collapsed to `-`; runs of `--` collapsed; trimmed; truncated to 40 chars; fallback to `untitled-topic`). The store does not re-do this work; it only refuses to write the three traversal patterns the normaliser is supposed to have removed. See spec 152 (topic ingest pipeline) for the normalisation rules.
- **High-water-mark file.** A third file under the topics directory holds the set of source identifiers already folded into the knowledge base. Its corruption tolerance, schema version field, and tab-indented JSON serialisation mirror this spec's conventions but its content is owned by a separate persistence module (see the processed-source store within spec 152).
- **External vault-write lock.** Callers serialise mutation sequences (read index, mutate, write index, write pages) by holding the shared vault-write lock used by the worker drain, the compile entry point, and the sync engine. The store itself does not acquire this lock.
