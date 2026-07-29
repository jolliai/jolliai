# 138. Single-Phase Search Pipeline

## Topic Statement

A search request runs through a single phase: a non-empty query is required, the configured storage backend is established, a relevance index is opened (and memoized), and the query is matched against the index to produce a flat, relevance-ranked list of hits — with no caller-supplied hash hints, no catalog/detail split, and no model invocation anywhere in the pipeline.

## Scope

**In scope:**

- The single dispatch path shared verbatim by the command-line surface and the in-process tool surface, so both return identical results.
- The required-query guard and the error it raises.
- The storage-backend establishment that must precede any read, and why it precedes it.
- The relevance-index open through a process-wide cache keyed by the resolved index directory, including the staleness check on every open.
- The accepted query inputs forwarded to the index (query string, optional branch restriction, optional kind restriction, optional limit) and the shape of each hit in the returned list.
- The response shape (`{ hits }`) and the rule that it must not vary between the two surfaces that call this pipeline.

**Out of scope (boundaries):**

- The command-line surface — positional-argument assembly, flag validation, output streams, file output, exit codes, and the stdin/here-doc bridge — is owned by the **search command surface** spec.
- The in-process tool surface that exposes this pipeline to an external agent host — its tool name, declared argument schema, and result-envelope wrapping — is owned by the **MCP server tool surface** spec.
- The on-disk relevance index — its format, how it is built and persisted, how the index directory is resolved, the staleness signature, and the ranking algorithm itself — is owned by the **local search index** spec. This spec describes only that the pipeline opens that index, threads the active storage through the open, and forwards the query to it.
- The skills that consume a `{ hits }` response and render it for the user are owned by the **recall-skill** and **search-skill** content specs.
- The storage-backend selection (which backend the configured mode resolves to) is owned by the storage-provider spec; this spec describes only that the configured backend is constructed and installed as process-wide active storage before any read.

## Data Contracts

### Request

The pipeline accepts:

| Field  | Type             | Meaning                                                                 |
| ------ | ---------------- | ---------------------------------------------------------------------- |
| query  | string           | The search query. Required and must be non-empty after trimming.        |
| branch | string, optional | Restrict results to a single branch.                                    |
| type   | enum, optional   | Restrict results to one kind: topic-kind or commit-kind.                |
| limit  | number, optional | Maximum number of hits to return. Forwarded unchanged, including unset. |

There is **no** hash-hint list, **no** recency filter, and **no** token budget on this pipeline. A request is fully described by the four fields above.

### Response envelope

A single object with one field: a `hits` array. Each element is a hit (see below). There is no truncation flag, no candidate count, no estimated-token count, and no query echo at the pipeline boundary. The envelope shape is identical no matter which surface invoked the pipeline.

### Hit shape

Each hit carries:

| Field      | Type   | Meaning                                                                 |
| ---------- | ------ | ---------------------------------------------------------------------- |
| id         | string | An internal identifier for the indexed document.                       |
| type       | enum   | Kind discriminator — topic-kind or commit-kind.                        |
| title      | string | A one-line label for the hit.                                          |
| snippet    | string | A short excerpt from the matching content.                            |
| branch     | string | The branch the hit is associated with.                                |
| commitDate | string | A display-date string.                                                 |
| slug       | string | A human-readable identifier (meaningful for topic-kind hits).         |
| hash       | string | The short (8-character) commit identifier (meaningful for commit-kind hits). |
| score      | number | A relevance score from the ranking engine.                            |

All fields are always present. The `slug` field carries the topic identity for topic-kind hits; the `hash` field carries the commit identity for commit-kind hits. The score is an internal ranking value; consuming skills are instructed not to surface it to the user.

## Behavior

### Single dispatch path

There is no phase selection. Every search request runs the same sequence below. The presence or absence of any optional field never changes the path; the optional fields only narrow what the index returns.

1. **Require a query.** If the query is absent, empty, or whitespace-only after trimming, raise an error whose message reads "`query` is required and must be non-empty". This guard runs before the index is opened.
2. **Open the relevance index.** Open the index for the bound working directory, threading the active storage handle so the index directory resolves to the same location the index was written to (under the memory-bank root in folder-mode / dual-write configurations, not the checkout). The open goes through a process-wide cache keyed by the resolved index directory: on a cache hit the cached instance is reused; on a cache miss the index is restored from disk (or rebuilt) and inserted into the cache. A source-signature check on every open detects staleness, so a stale cache entry is transparently reopened.
3. **Match and rank.** Forward the query string, the optional branch restriction, the optional kind restriction, and the optional limit to the index. The hits the index returns — already relevance-ranked — are wrapped, in order, into the response object as `{ hits }` with no additional projection, filtering, or re-sorting.

### Storage-backend establishment (caller responsibility, but load-bearing for this pipeline)

Both surfaces that call this pipeline construct the configured storage backend for the bound working directory and install it as the process-wide active storage **before** invoking the pipeline, then pass that handle through to the index open. This must happen first: without it, the index open would fall through to the default (orphan-branch) backend, so a folder-mode or dual-write user would index a different store than the one their data lives in — and the two surfaces would diverge, breaking the contract that the command-line fallback returns the same results as the in-process tool. (See Notable Behavior.)

### Failure modes

- An empty / whitespace-only query raises the required-query error described above, before any I/O.
- Any error raised while opening the index or matching the query propagates unchanged; this pipeline has no in-pipeline catch. The two calling surfaces each wrap propagated errors into their own error envelope. One qualification: the pipeline's lack of a catch is unchanged, but the index open no longer *raises* for one narrow class — when a rebuild happens behind the open and its cache write is denied with a permission-class error, the index open absorbs that failure below this boundary, logs a warning, and returns a fully-built in-memory index, so the pipeline sees a normal success and serves hits. Nothing else about the open is absorbed; every other failure shape still reaches this boundary and propagates. See the **local search index** spec for the exact error codes and the intent-based classification behind them.
- An index that exists but matches nothing is **not** a failure: the pipeline returns `{ hits: [] }`.

## Notable Behavior

- **The pipeline is single-phase with no hash-hint mechanism.** There is no catalog phase, no detail phase, no `--hashes` round-trip, and no token-budget packing. A request is one query plus optional narrowing flags; the response is one flat ranked list. (Notable.)
- **The same dispatch path backs both the command-line surface and the in-process tool surface, deliberately.** Both call the identical function and receive the identical `{ hits }` envelope, so the documented "command-line fallback === in-process primary" parity holds. A change to ranking or hit shape reaches both surfaces at once. (Notable; load-bearing.)
- **Storage-backend establishment must precede the index open.** Skipping it makes the index resolve under the wrong root for folder-mode / dual-write users, returning wrong (or empty) results and silently diverging the two surfaces. The active-storage handle is also threaded into the index open so the index directory resolves to where the index was actually written. (Surprising; load-bearing.)
- **The relevance index is memoized process-wide with a per-open staleness check.** Repeated searches in a long-lived host reuse the cached index; a source-signature check on every open reopens a stale entry transparently. Concurrent searches on the same directory may race to populate the same cache slot, but the recompute is idempotent so a loser's work is a harmless overwrite. (Notable.)
- **The limit is forwarded unchanged, including when unset.** The pipeline injects no default; the index applies whatever it treats as the unset default. A documented engine default exists, but it is not imposed at this boundary. (Notable.)
- **No model invocation anywhere.** Ranking is the index's job; semantic judgment over the returned hits is the consuming skill's job. The pipeline itself never calls a model. (Notable.)
- **The earlier two-phase pipeline is gone.** A prior design dispatched between a catalog phase and a detail phase on the presence of caller-supplied hash hints, packed a token budget, and offered a typed remote-backend stub. None of that is reachable from any current caller — the data shapes for that design survive only as an unused extension point and as the recall-payload projection types, not as a search path. (Notable; historical.)

## State Transitions

Search is stateless per invocation.

Each call computes its result from the request, the active storage handle, and the relevance index at the moment of the call. The only cross-call state is the process-wide index cache, which is an optimization (transparently reopened on staleness) and never alters the result of a call. There is no per-session memory and no notion of a "current phase" — there is only one phase. This paragraph exists to make the absence of a state machine explicit.

## Shared Behavior

- The command-line surface — positional-argument assembly, flag validation, output streams, file output, exit codes, and the stdin bridge — is defined by the **search command surface** spec.
- The in-process tool surface — tool name, argument schema, and result-envelope wrapping — is defined by the **MCP server tool surface** spec.
- The on-disk relevance index — format, build/persist flow, index-directory resolution, staleness signature, and ranking algorithm — is defined by the **local search index** spec.
- The skills that consume the `{ hits }` response are defined by the **recall-skill** and **search-skill** content specs.
