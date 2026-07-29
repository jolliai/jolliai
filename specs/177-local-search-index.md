# 177. Local Full-Text Search Index

## Topic Statement

A disposable on-disk inverted index over the project's stored memory is built lazily from authoritative source data, persisted as two sidecar files in the project's hidden memory directory, restored on subsequent queries when a cheap source-signature check still matches, and otherwise rebuilt from source.

## Scope

**In scope:**

- The two-file persistence layout (index payload and manifest sidecar) and the directory it lives in.
- The shape of one indexed document — the unified flat record used for both topic-page records and per-commit records.
- The source-signature contract — what inputs it digests and what kinds of source mutations it does or does not catch.
- The rebuild-or-restore decision at open time and the conditions that fail the restore guard (missing files, JSON parse failure, schema-version mismatch, signature mismatch).
- The tokenizer rule applied at both index-time and query-time, including its augmentation for character-script writing systems that the default rule treats as separators.
- The ranking model used at query time (a term-frequency / inverse-document-frequency variant with field-length normalization) and the per-field declarations that drive it.
- The exact-enum branch-filter semantics and why a tokenized text filter is not used for that field.
- The optional record-kind filter and the optional result-count clamp applied at query time.
- The atomic-write ordering used to persist the pair and what happens when the pair is torn.
- The required-versus-best-effort classification of the persist step: which entry points treat a failed persist as fatal, which one swallows a narrow class of permission failures and serves the query from memory, and exactly which error codes qualify.
- The in-process memoization layer used by the long-lived agent server and the cheap staleness check it consults on every reuse.
- The "force rebuild and exit" entry point that performs an immediate rebuild and reports the document count.
- The "warm the index" hook the compile sweep runs after ingest, including its non-fatal containment.

**Boundaries:**

- The agent-protocol server that exposes the index to clients, its tool argument shape, and its tool-response envelope are owned by the MCP server tool-surface spec.
- The two-phase LLM-driven search pipeline (catalog phase + detail phase) used by the command-line surface is owned by the two-phase search pipeline spec; that pipeline does not consult this on-disk inverted index.
- The on-disk format of the per-commit catalog file and the per-commit index file that this index reads from at build time are owned by the summary-catalog-file spec and the summary-index-format spec.
- The on-disk format of the topic index and topic pages that this index reads from at build time is owned by the topic-index-and-page-storage spec.
- The compile sweep that opportunistically warms this index is owned by the ingest-trigger-and-cooldown spec and the multi-repo memory-bank compile sweep spec; this spec only describes what crosses that boundary (a rebuild call with a non-fatal containment).
- The atomic write-then-rename primitive used to persist the two files is shared infrastructure; this spec only describes the ordering in which it is invoked.
- The shared hidden-memory directory resolution rule (per-project subdirectory under a kb-root, with the kb-root taking precedence over the bound working directory when present) is shared infrastructure; this spec only describes which root is used and why.

## Data Contracts

### File layout

Two sidecar files live in the project's hidden memory directory:

| File         | Purpose                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| Index file   | Serialized inverted index plus stored documents, as a single JSON blob. |
| Manifest file | A small JSON sidecar holding the version stamp, the source signature, and the persist timestamp. |

The directory the pair lives in is resolved by the same rule used for all per-project hidden state: a backend-configured "kb-root" takes precedence over the caller's working-directory binding, falling back to the working-directory binding when no kb-root is configured. This is load-bearing — the compile sweep that warms the index runs with the kb-root set, and the long-lived agent server runs from the project checkout; both must resolve the same pair of files for the warm-up to be useful.

### Manifest sidecar

The manifest is a JSON object with three fields:

| Field             | Type    | Meaning                                                                             |
| ----------------- | ------- | ----------------------------------------------------------------------------------- |
| schema version    | integer | A monotonically increasing integer bumped whenever the document shape or schema changes. Mismatch on restore triggers a rebuild. |
| source signature  | string  | The signature returned by the source-signature procedure at persist time.            |
| saved at          | string  | An ISO-8601 timestamp of when the persist completed. Diagnostic only.                |

The manifest is the "index is ready" marker — it is written **after** the index payload, so a crash between the two writes leaves the index payload on disk but no matching manifest, and the next open rebuilds rather than restoring.

### Document shape

Every record stored in the index — whether it is a topic-page record or a per-commit record — is the same flat shape. Fields not applicable to one record kind carry a sentinel empty string rather than being omitted:

| Field        | Type           | Meaning                                                                                                                                |
| ------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| identifier   | string         | A namespaced stable string. For topic records, the form is "topic:" followed by the topic's stable slug. For commit records, "commit:" followed by the full commit hash. Also used as the document id by the indexer. |
| record kind  | enum           | One of two values: a topic-kind or a commit-kind discriminator.                                                                          |
| title        | string         | For topic records, the topic title. For commit records, the recorded commit message.                                                     |
| content      | string         | The searchable body, built per record kind (see below).                                                                                 |
| decisions    | string         | A joined decision text. Topic records leave this empty; commit records concatenate the per-topic decision strings present in the catalog. |
| branch       | string list    | The set of branches the record relates to (see below).                                                                                  |
| category     | string         | For commit records, the literal string identifying a commit-source. For topic records, the dominant source-reference type (the most frequent kind among the topic page's source references, defaulting to a topic-kind sentinel when the topic has no source references). |
| commit date  | string         | An ISO-8601 timestamp. For commit records, the recorded commit date. For topic records, the topic page's last-updated timestamp.        |
| slug         | string         | The topic's stable slug for topic records; the empty string for commit records.                                                          |
| hash         | string         | The full commit hash for commit records; the empty string for topic records.                                                             |

#### Content composition

For a **topic record**, content is the topic's title followed by the topic page's stored body (or, when no topic page exists on disk, the topic-index entry's summary text as a fallback) — concatenated with a separator so both contribute to the body-tokenization stream.

For a **commit record**, content is the joined non-empty union of: the recorded commit message, the per-commit recap, the concatenation of per-topic titles, and the concatenation of per-topic decisions strings. Each component is separator-joined when present; empty components are dropped.

#### Branch field semantics

The branch field is a **list**, not a single string, declared in the index schema as an enumerated set-typed field. The choice is load-bearing — see Notable Behavior.

- For a **commit record**, the list contains exactly one element: the branch the index entry records for that commit.
- For a **topic record**, the list is the topic's related-branches list — the branches that have contributed source references to the topic — taken from the topic page when one exists, else from the topic-index entry.

The branch filter, at query time, applies exact set-membership: a record matches the filter "branch must be B" iff B is one of the elements of that record's branch list. This is **not** a tokenized text match — see Notable Behavior.

### Index schema declarations

The schema attached to the index declares each field's role for ranking and filtering. The relevant declarations:

- The identifier, the record kind, the title, the content, the decisions text, the category, the commit date, the slug, and the hash are **tokenized text fields** subject to ranking. The default field is the content body; tokens from other text fields contribute to scoring with the same field-length normalization.
- The branch list is an **enumerated set-typed field** — its value is matched exactly against a candidate element rather than tokenized.

### Source signature

The signature is a single string assembled from these inputs, concatenated with a pipe separator:

| Position | Input                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 1        | The schema version constant.                                                                            |
| 2        | The count of commit-index entries (0 when the index file is absent).                                    |
| 3        | The count of catalog entries (0 when the catalog file is absent or empty).                              |
| 4        | The count of topic-index entries (0 when the topic index file is absent or empty).                      |
| 5        | The maximum "generated at" timestamp across all commit-index entries (the empty string when no entries). |
| 6        | The maximum "last updated at" timestamp across all topic-index entries (the empty string when no entries). |
| 7        | A hexadecimal cryptographic digest of the catalog's searchable content: for each catalog entry, the commit hash, the recap text (empty string when absent), and the concatenation of per-topic title plus decisions (empty string when decisions are absent), all separated by a control character. |

The first six positions catch count and timestamp changes (adds, removes, re-summarizes that update the timestamps). The seventh position catches **in-place content edits that preserve counts and timestamps** — the regression case is a body edit made through the editor surface that rewrites a recap but does not bump the per-entry generated-at field; without the content digest the signature would be stable and the index would serve stale results.

### Result envelope (per hit)

The result of a query is a hit list. Each hit has:

| Field        | Type   | Meaning                                                                                       |
| ------------ | ------ | --------------------------------------------------------------------------------------------- |
| identifier   | string | The document identifier.                                                                       |
| record kind  | enum   | The record kind discriminator (topic or commit).                                               |
| title        | string | The document title.                                                                            |
| snippet      | string | The first 280 characters of the document content body — a fixed display window, never grown to a query-aware excerpt. |
| branch       | string | The branch list joined by single spaces. (See Notable Behavior on the join.)                   |
| commit date  | string | The document's commit-date field.                                                              |
| slug         | string | The document's slug field (empty for commit records).                                          |
| hash         | string | The document's hash field (empty for topic records).                                           |
| score        | number | The ranking score returned by the underlying ranker.                                           |

### Query request shape

A query carries:

| Field         | Required | Meaning                                                                                                |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| query string  | yes      | The free-text query, passed through the same tokenization rule that built the index.                    |
| branch        | no       | When present, an exact-set-membership filter on the record's branch list.                              |
| record kind   | no       | When present, restricts results to records of the given kind (topic or commit).                         |
| result limit  | no       | When present, the maximum number of hits to return. Coerced and clamped (see below).                    |

## Behavior

### Open

The open procedure is the steady-state entry point — used by the agent server on each query path.

1. Compute the source signature once.
2. Resolve the index directory using the kb-root-or-cwd rule.
3. Attempt to restore from the on-disk pair (see Restore). On success, return a wrapper holding the in-memory index.
4. On any restore failure, run the build procedure (see Build) using the **already-computed** signature — do not recompute it inside build (each recompute re-reads the index file, the catalog file, and the topic index from disk; doing it twice on a cold path is wasteful).

### Restore

Restoring the pair is the only fast path. The procedure:

1. Read and JSON-parse the manifest file. Any of: missing file, parse error, or any other read-time exception causes the procedure to return a "not restored" outcome (caller falls through to build). The catch is broad — restore is best-effort and any failure shape demotes to a rebuild.
2. Check that the manifest's schema version equals the current schema-version constant. A mismatch returns "not restored".
3. Check that the manifest's source signature equals the freshly-computed signature. A mismatch returns "not restored".
4. Read and JSON-parse the index file.
5. Deserialize the index payload into an in-memory index.
6. **Reapply the augmented tokenizer to the deserialized index.** This is load-bearing — deserialization rebuilds the index with the **default** tokenizer components, dropping the augmented one. The query path consults the index's tokenizer at query time, so a restored index that was not re-augmented would tokenize a query through the default rule even though the on-disk inverted index was populated with the augmented rule's tokens; queries in the augmented script would match nothing despite the relevant tokens being present.
7. Return the restored index.

### Build

The build procedure constructs the in-memory index from authoritative sources and persists it.

1. Collect every document — a topic record per topic in the topic index, and a commit record per catalog entry that has a matching commit-index head. A catalog entry without a matching index head is silently dropped (not browsable through the agent surface and therefore not indexable).
2. Create an empty index using the declared schema, with the augmented tokenizer attached as a component.
3. Bulk-insert all documents.
4. Persist the pair (see Persist), passing the signature that was supplied to build, under the caching mode the caller selected — **required** or **best-effort** (see "Persistence is required or best-effort"). The build's default is required; only the two read-triggered entry points pass best-effort.
5. Log an informational line reporting the built document count.
6. Return a wrapper holding the in-memory index plus the document count.

At step 4 the in-memory index is already complete and queryable; persisting it is a cache-population step, which is what makes the best-effort classification safe for a read.

### Persistence is required or best-effort

The persist step is classified by **who asked for the build**, not by what went wrong:

- **Required** — an explicit force-rebuild. Both callers of that entry point are in this class: the reindex command-mode entry point, and the compile-sweep warm-up. Landing the files *is* the point of that call: they are what lets a later long-lived server process skip the rebuild. A persist failure of any shape — permission-class included — propagates out of the build rather than being absorbed, so the build never reports a warm-up that warmed nothing. What the caller then does with it differs by caller: the reindex entry point surfaces it, while the compile-sweep warm-up catches it in its own non-fatal containment and logs a warning (described later in this spec).
- **Best-effort** — a rebuild that happened **behind a read** (either read entry point: the plain open and the memoized open, on a stale or missing cache). The caller wants results; the on-disk copy is only an optimization for next time.

Under best-effort, and only under best-effort, a persist failure whose error carries one of exactly three permission-class codes — `EPERM`, `EACCES`, `EROFS` — is swallowed. The handling is:

1. Log a warning naming the target directory and the failure's message, stating that the index was built but not cached and that the next search will rebuild it.
2. Serve the query from the fully-built in-memory index, exactly as if the persist had succeeded.

Every other failure shape still propagates out of the read path unchanged — a full disk, a target directory that vanished because the memory-bank folder moved, a corrupt directory, a serialization error. Those are real misconfigurations, and swallowing them would convert every subsequent search into a silent full rebuild whose only trace is a log line.

#### Topic record construction

For each topic in the topic index:

- Read the topic page on disk by stable slug. If the page exists, use its body, its related branches, its source references, and its last-updated timestamp. If the page does not exist, fall back to the topic-index entry's summary text, its related branches, its source references, and its last-updated timestamp.
- Derive the category by scanning the source-reference list and selecting the most-frequent type. Sort the (type, count) pairs descending by count and pick the first; ties resolve in the order produced by the underlying map iteration. When the source-reference list is empty, the category is the topic-kind sentinel.
- Compose the content body as title + separator + body.
- The decisions field is the empty string for topic records.
- The slug field is the topic's stable slug; the hash field is the empty string.

#### Commit record construction

For each catalog entry:

- Look up the matching commit-index entry by full commit hash. If absent, skip this catalog entry — the commit is not browsable.
- Compose the content body as the join (with newline separators) of: the commit message from the index entry, the recap from the catalog entry, the concatenation of per-topic titles from the catalog entry, and the concatenation of per-topic decisions strings (per-topic decisions whose value is absent are filtered out). Empty components are omitted from the join.
- The decisions field is the per-topic decisions concatenation.
- The branch field is a single-element list containing the commit-index entry's branch.
- The category is the literal commit-source sentinel.
- The commit-date is the index entry's commit-date.
- The slug field is the empty string; the hash field is the full commit hash.

### Source signature procedure

1. In parallel, read the commit-index, the catalog (with lazy build), and the topic index.
2. Compute the count of commit-index entries (0 when absent).
3. Compute the maximum "generated at" string across commit-index entries (the empty string when no entries).
4. Compute the maximum "last updated at" string across topic-index entries (the empty string when no entries).
5. Compute a SHA-1 hex digest of the joined catalog-content string described in Data Contracts.
6. Concatenate the schema version, the three counts, the two timestamps, and the digest with pipe separators. Return the resulting string.

### Persist

1. Ensure the index directory exists, recursively creating parents as needed.
2. Serialize the in-memory index to a JSON string through the underlying engine's persist function.
3. Atomically write the index file (write-to-temp, rename-over).
4. Compose the manifest object with the current schema version, the supplied signature, and the current timestamp.
5. Atomically write the manifest file (write-to-temp, rename-over).

The order — index first, manifest second — is load-bearing. A crash between steps 3 and 5 leaves the index file on disk without a matching manifest, and the next open's manifest read fails, demoting the open to a rebuild. The inverse ordering would leave a manifest that points at a half-written index.

### Force rebuild entry point

A separate command-mode entry point bypasses restore entirely and forces a full build, regardless of whether the on-disk pair is fresh.

1. Compute the source signature.
2. Run the build procedure with that signature.
3. Print a single line to standard output: the literal string "Reindexed " followed by the document count followed by " document(s).". The noun is "document(s)" verbatim — there is no singular/plural agreement.
4. The process returns without ever opening any agent transport.

Before computing the signature, this entry point first constructs the configured storage backend for the bound working directory (used both as the project root and as the kb-root) and installs it as the process-wide active storage. Without this step the rebuild's reads would fall through to the orphan-branch fallback, and a folder-mode user would reindex from the wrong (possibly empty) store and see a misleading "0 document(s)" report.

### Query

1. Coerce the result-limit input. The input is treated as untrusted (it crosses an external tool boundary that validates the request envelope but does not enforce per-tool argument types).
   - When the input is absent, the limit becomes the default value (20).
   - Convert the input to a number. If the conversion is not finite (NaN, infinity), fall back to the default value (20).
   - Integer-truncate the result.
   - Clamp the truncated value to the closed range \[1, 100\].
   - The clamp is necessary because the underlying engine preallocates a result array sized to the limit, which raises a range error past `2^32 - 1` and denial-of-service-allocates huge arrays well before that. Without the not-finite fallback, a string-typed input would coerce to NaN and silently produce zero hits — the clamp passes NaN through (`Math.max/min(NaN, …)` is NaN), and the underlying engine treats a NaN-sized array as zero-length.
2. Build a filter map.
   - If a record-kind filter is supplied, add a key for the record-kind field with the supplied value as a plain string match.
   - If a branch filter is supplied, add a key for the branch field with a value shaped as "contains-all of the single-element list \[B\]" — an exact set-membership match.
3. Issue the underlying ranked query with: the query string as the term, the clamped limit as the cap, and the filter map (omitted entirely when empty).
4. Map each engine hit to a result entry by copying the document's identifier, kind, title, branch list (joined with single spaces), commit-date, slug, and hash; the snippet is the first 280 characters of the document's content body; the score is taken from the engine hit unchanged.
5. Return the result list.

### In-process memoization for long-lived processes

A process-global memo from index-directory to (signature, wrapper) supports the long-lived agent server, which repeatedly issues queries.

1. Compute the source signature.
2. Resolve the index directory.
3. Look up the memo entry by directory.
   - If an entry exists **and** its stored signature equals the freshly-computed signature, return its wrapper unchanged.
4. Otherwise, attempt to restore from disk (with the freshly-computed signature). On success, wrap the restored index; on failure, run the build procedure (with the same signature).
5. Insert (or replace) the memo entry with the current signature and the (re)opened wrapper.
6. Return the wrapper.

The signature is recomputed on **every** memoized call — it is the cheap-staleness check. Only the expensive restore-or-build step is skipped on a hit. A signature change transparently reopens.

The memo is keyed by the **resolved index directory**, not the caller's working directory. Two working directories that resolve to the same kb-root share one memo entry — this is the desired behavior for the warm-up flow.

A separate "clear the memo" operation exists as a test seam and a safety hatch.

### Compile-sweep warm-up

The ingest-trigger-and-cooldown command and the multi-repo memory-bank compile sweep both invoke a force-rebuild at the end of their per-repo work. They do so through a **lazy import** inside an **inner try-catch**:

- Lazy import contains the dependency footprint: the underlying engine is loaded only when the warm-up actually runs. A load failure of the engine module is therefore localized to the warm-up step.
- The inner catch ensures a warm-up failure is logged at warn level and otherwise swallowed. Search-index warming must never fail the surrounding command.

### Concurrency

The index has no explicit lock and assumes a single-writer-at-a-time invariant in practice. Concurrent writers race on the atomic-write-then-rename for both files; last-writer wins for each file independently. A torn pair (one writer's index, another writer's manifest) cannot survive an open: the signature embedded in the surviving manifest will mismatch the document set in the surviving index only if their underlying signatures differed, and the open will demote to a rebuild on the signature check.

The long-lived memo is also process-global and unsynchronized; concurrent queries that miss the memo together race to populate the same entry, but each recomputes the same signature and either restores the same payload or rebuilds the same document set, so a concurrent loser's work is harmless overwrite.

## State Transitions

The index has three observable states for a given resolved directory:

1. **Absent** — no index file, no manifest file. An open computes the signature, attempts restore (which fails on the missing manifest read), and runs the build, transitioning to Fresh.
2. **Fresh** — index file present, manifest present, manifest's schema version matches the current constant, and manifest's source signature matches the freshly-computed signature. An open restores and returns. The state remains Fresh.
3. **Stale** — index file present, manifest present, but the manifest fails one of the restore guards (schema version mismatch, signature mismatch). An open's restore returns "not restored" and the build runs, atomically persisting a new pair and transitioning the directory back to Fresh.

4. **Stale → Stale** — the Stale case above, except the rebuild's cache write is denied with one of the three permission-class codes. The build succeeds in memory and the query is answered from it, but no matching pair lands: depending on where in the persist sequence the denial hit, the directory is left either untouched or torn (the index payload replaced with no matching manifest). Both read as Stale, so the directory stays Stale and the *next* read repeats the whole sequence. This is the only outcome in which a completed build does not leave the directory Fresh. A non-permission persist failure does not reach this state — it propagates, leaving the directory Stale and the caller with an error instead of hits.

A torn pair (index present, manifest absent, or manifest present without index, or manifest present with mismatched JSON) collapses into Stale from the open's point of view — the restore guard fails and the build runs.

The force-rebuild entry point unconditionally transitions the directory to Fresh, regardless of its prior state — unless its (required) persist fails, in which case the failure propagates and the directory keeps whatever state it had.

The in-process memo has two states per directory: Empty (no entry) and Populated (entry with a signature and a wrapper). On every memoized call, a Populated entry transitions to Empty (and is then refilled) iff its stored signature does not equal the freshly-computed one; otherwise it stays Populated.

## Notable Behavior

- **Partial-update is not implemented; the index is rebuild-only.** Any signature change rebuilds the entire index from sources rather than incrementally adding or removing affected documents. This is intentional simplicity — the cost of a full rebuild is acceptable for the document volumes in play, and incremental updates against a persisted ranking index are a much larger contract. (Notable.)
- **The branch filter uses an enumerated set-typed field, not a tokenized text field.** A tokenized filter on a string-typed field would split a branch name like "feature/auth" into the tokens "feature" and "auth" and would match the union of records carrying either token — so a query filtered to "feature/auth" would also surface records on a sibling slash-branch like "feature/billing". The set-typed declaration matches the element exactly, with no tokenization or token-union semantics. This also means the filter runs **inside** the index alongside the ranked query, so the returned limit is already post-filter — there is no over-fetch-then-post-filter window in which a rare-branch hit could fall outside the top-N. (Surprising; load-bearing.)
- **The record-kind filter, by contrast, *is* a tokenized text-field filter.** This is safe because the two possible values ("topic" and "commit") are each a single exact token; tokenization is a no-op for them. (Notable.)
- **The augmented tokenizer adds character-script n-grams for writing systems the default rule treats as separators.** The default rule splits on a Latin-letters-and-digits character class, so a body composed of Chinese, Japanese, or Korean characters tokenizes to zero tokens and is unsearchable. The augmented tokenizer wraps the default rule (preserving Latin lowercasing and English stemming) and additionally emits, for each maximal run of characters from a fixed set of script ranges (the common-CJK block, an extension block, a compatibility block, hiragana, katakana, and hangul-syllables): every character as a unigram (so single-character queries match) and every adjacent pair as a bigram (so multi-character queries score on contiguity). Because the same tokenizer is applied at index-time and at query-time, the produced n-gram sets line up for the ranker's scoring. No dictionary segmentation is used — the n-grams trade some precision for guaranteed recall. (Notable; load-bearing.)
- **The tokenizer must be reapplied to a restored index.** The deserializer rebuilds the index with default components, dropping the augmented tokenizer. The query path reads the index's tokenizer at query time, so a restored index that was not re-augmented would tokenize a query in an augmented script through the default rule and match nothing despite the n-grams being present in the inverted index. The reapply step is a single field reassignment on the restored index. (Notable; load-bearing.)
- **The augmented tokenizer guards against non-string field values.** A document field that is not a string (a defensive case mirrored from the underlying engine's default behavior) bypasses the n-gram step and returns whatever the default rule produced; no exception is raised. (Notable; defensive.)
- **The branch field is a list, even for commit records.** A commit record always carries a single-element list; the schema declaration does not vary by record kind. This keeps the filter shape uniform. (Notable.)
- **A topic with no topic page on disk falls back to the topic-index entry's summary as its content body, related-branches list, source references, and timestamp.** The fallback is silent — the index still emits a topic record for that slug, just with less rich content. (Notable.)
- **A catalog entry with no matching commit-index head is silently dropped.** Such an entry is not browsable through the agent surface, so indexing it would surface results no caller could resolve. The drop is not logged. (Notable.)
- **A catalog entry with absent recap, absent topics, and absent ticket is still indexed.** Its content body collapses to the commit message alone; its decisions text is the empty string. (Notable.)
- **A per-topic decisions entry whose value is missing is filtered out of the join.** The concatenation only joins truthy decisions strings. (Notable.)
- **The source signature catches in-place catalog content edits that preserve counts and timestamps.** Earlier signature shapes hashed only counts and newest timestamps and would not change when an editor surface rewrote a recap without bumping the per-entry generated-at field. The current signature folds a SHA-1 digest of catalog content (recap plus per-topic title/decisions, per commit hash) into the seventh position so any in-place edit changes the signature and the stale index is rebuilt. (Notable; load-bearing.)
- **The source signature is recomputed on every memoized agent-server call.** This is intentionally cheap — the inputs are already-loaded files in the I/O path of any subsequent query — and is the only mechanism by which the long-lived process detects a stale memo. The alternative (write-side invalidation from every mutator path) was rejected as too invasive. (Notable; load-bearing.)
- **The "compute once on a cold open" rule.** The non-memoized open computes the signature exactly once and threads it through whichever of restore or build runs. The build path explicitly accepts a signature parameter rather than recomputing — each recompute re-reads three files. (Notable.)
- **A restore failure of any shape demotes to a rebuild.** The restore's catch is broad: missing manifest, missing index, JSON parse failure, signature mismatch, schema-version mismatch, or any other exception. The result is the same — the build runs and produces a fresh pair. There is no diagnostic distinction between "corrupt" and "stale". (Notable.)
- **The manifest is the "index is ready" marker.** It is written **after** the index payload. A crash mid-pair leaves the index without a manifest; the next open rebuilds. The torn pair never serves results. (Notable; load-bearing.)
- **A read-triggered rebuild survives an unwritable index directory — and only that.** A query whose cache is stale rebuilds in memory and then tries to cache; if the cache write fails with one of exactly three permission-class codes (`EPERM`, `EACCES`, `EROFS`) the failure is logged as a warning naming the directory and the message, and the query is answered from the fully-built in-memory index. The condition this exists for is a sandboxed agent: for folder-backed storage the index directory resolves under the memory-bank root, which sits outside the workspace such a sandbox makes writable, so persisting is denied there while everything else about the request is fine. Any other failure shape still propagates out of the read. (Surprising; load-bearing.)
- **The unwritable-cache condition presents as INTERMITTENT.** The swallow only sits on the rebuild path, and a rebuild only happens when the cache is stale — a fresh cache never reaches it. So the same sandboxed search alternates between silent success (cache still fresh) and a warning plus an uncached rebuild (any commit changed the source signature). Nothing about the sandbox changed between the two; only the cache's freshness did. (Surprising.)
- **The classification is by caller intent, not by error shape.** The identical permission failure is fatal on an explicit reindex and survivable behind a read. This is deliberate: the reindex exists to leave a file on disk, while the read exists to return hits. (Notable.)
- **The result snippet is a fixed 280-character prefix of the content body.** It is not a query-aware excerpt, not an ellipsized window around a matched term, and not configurable. (Notable.)
- **The branch field returned in a hit is a single string formed by joining the branch list with spaces.** A topic with multiple related branches is rendered as a single space-separated string in the hit envelope. This is a display-side projection: the underlying record still holds a set. (Notable.)
- **The result-limit clamp covers both denial-of-service-sized values and non-numeric input.** The clamp must coerce the value first (because string-typed input can reach the surface despite the protocol's outer envelope validation), fall back to the default on non-finite values (because `Math.trunc` on NaN is NaN, which poisons the clamp), integer-truncate, and bound to \[1, 100\] (because the engine preallocates an array of the requested size, which range-errors past `2^32-1`). (Surprising; defensive.)
- **The filter map is omitted from the underlying ranked query when no filter is supplied.** This is a small surface optimization that preserves the engine's "no filter" code path; the alternative — always passing an empty map — would still work but exercises the filter path needlessly. (Notable.)
- **The force-rebuild entry point initializes storage first, then invokes the rebuild with that storage handle.** Both steps are load-bearing — without the storage handle the index dir would resolve to the working directory rather than the kb-root, and the rebuild would write to a different file than the long-lived server would later read. (Notable; load-bearing.)
- **The force-rebuild entry point's confirmation line uses the literal "document(s)"** regardless of count, with no singular/plural agreement. (Notable.)
- **Compile-sweep warm-up failures are non-fatal and lazy-imported.** A warm-up failure (missing engine module, file I/O error, anything else) is caught inside an inner try, logged at warn level, and swallowed. The underlying engine is imported lazily inside that try so a module-load failure is also contained — search-index warming must never fail the surrounding compile pass. (Notable; defensive.)
- **The memo is keyed by the resolved index directory, not the working directory.** Two working directories that resolve to the same kb-root share one memo entry. (Notable.)
- **The memo has no eviction policy.** It grows unboundedly within a single process. For the agent server this is acceptable because the process binds to one working directory at startup. (Notable.)

## Shared Behavior

- The agent-protocol server that exposes the `search` tool over the in-process memoized index — its tool argument shape, response envelope, and error envelope — is owned by the MCP server tool-surface spec.
- The two-phase LLM-driven search pipeline used by the command-line surface (catalog phase plus detail phase, with no on-disk inverted index) is owned by the two-phase search pipeline spec; the surface there does not consult this index.
- The on-disk format and persistence of the per-commit catalog file (one of the index's source inputs) is owned by the summary-catalog-file spec.
- The on-disk format and persistence of the per-commit index file (the other source input from which branch and commit-date are joined) is owned by the summary-index-format spec.
- The on-disk format of the topic index file and the topic-page store (the topic-record source inputs) is owned by the topic-index-and-page-storage spec.
- The atomic write-then-rename primitive used to persist the index and manifest is shared infrastructure across the project.
- The hidden-memory directory resolution rule (kb-root-or-cwd) is shared infrastructure across the project.
- The ingest-trigger-and-cooldown spec and the multi-repo memory-bank compile sweep spec own the warm-up flow that invokes a force-rebuild at the end of per-repo work; this spec owns only the rebuild's data flow.
