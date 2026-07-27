# 19 — OpenCode Transcript Reading

## Topic Statement

This spec defines how OpenCode session transcripts are discovered and read from a local embedded structured-data store, with a feature gate that tolerates a runtime missing the embedded-database support so the rest of the product still works.

## Scope

**In scope**

- The on-disk location of the OpenCode embedded structured-data store.
- The relevant tables and columns at a structural level.
- The runtime feature gate: discovery and reading require an embedded structured-data store provided by the runtime; if the runtime cannot provide it, OpenCode is silently skipped.
- The lazy-import pattern: the runtime feature is loaded on first use, not at module load.
- The discovery query: which sessions fall within the staleness window (enforced in the query) and which belong to the current project (enforced after retrieval, by the shared session-directory attribution rule).
- The shared session-directory attribution rule — containment plus a nested-repository / submodule / linked-worktree exclusion walk — and the fact that it cannot be expressed in the store query.
- The transcript-read query: which messages and parts make up a session, in what order.
- Mapping of OpenCode message roles to the canonical role tags.
- Filtering of part types: only text-bearing parts contribute to a normalized entry.
- The cursor structure used for incremental resumption (indexed by message position).
- The optional time-cutoff filter that lets a queue-driven caller attribute records to a specific commit boundary.
- The synthetic transcript-locator scheme that allows multiple sessions sharing one database file to each get their own cursor key.
- A bundling note: the VS Code extension bundle targets a runtime that may lack the embedded-database support, and the codepath tolerates the missing module.

**Out of scope**

- Per-message streaming / live-tailing.
- The embedded-database failure-classification layer beyond noting that scan errors are surfaced (covered by a shared SQLite-helpers spec).
- The downstream LLM call that consumes the assembled context.
- Multi-session merging policy (handled by a shared context-assembly layer).

## Data Contracts

### Storage location

OpenCode stores data in a single embedded structured-data store at the user's XDG data home, under an OpenCode-specific subdirectory. The default location is `<xdg-data-home>/opencode/opencode.db`, where `<xdg-data-home>` resolves to `~/.local/share` if the XDG environment variable is unset.

### Tables and columns (relevant subset)

| Table     | Columns the reader uses                                                | Notes                                                                                             |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `session` | `id`, `title`, `directory`, `time_created`, `time_updated`             | One row per session. `directory` is the working directory the session was launched in. `time_created` and `time_updated` are integer milliseconds since the Unix epoch. |
| `message` | `id`, `session_id`, `data`, `time_created`                             | One row per message. `data` is a JSON blob whose `role` field carries `"user"`, `"assistant"`, or other. `time_created` is integer milliseconds since the Unix epoch. |
| `part`    | `message_id`, `data`, `time_created`                                   | Zero or more rows per message. `data` is a JSON blob whose `type` field is one of `"text"` (with a `text` string), tool-call, tool-result, patch, reasoning, finish, image-url, or other. |

### Session-info record (output of discovery)

| Field            | Type    | Notes                                                                          |
| ---------------- | ------- | ------------------------------------------------------------------------------ |
| `sessionId`      | string  | The session row's `id`.                                                        |
| `transcriptPath` | string  | A synthetic locator: the database file's absolute path, a `#` separator, and the session id. |
| `updatedAt`      | string  | The session row's `time_updated` rendered as an ISO 8601 instant.              |
| `source`         | string  | The literal source tag for OpenCode.                                           |

### Cursor

| Field            | Type   | Notes                                                                                  |
| ---------------- | ------ | -------------------------------------------------------------------------------------- |
| `transcriptPath` | string | The synthetic locator (matches the session-info shape).                                |
| `lineNumber`     | int    | Reused as a message index: count of session messages already consumed on prior reads.  |
| `updatedAt`      | string | The wall-clock instant the cursor was produced.                                        |

### Normalized entry (output)

| Field       | Type                       | Notes                                                                |
| ----------- | -------------------------- | -------------------------------------------------------------------- |
| `role`      | `"human"` or `"assistant"` | OpenCode `"user"` maps to `"human"`; `"assistant"` is preserved.    |
| `content`   | string                     | Joined text of the message's text-typed parts.                       |
| `timestamp` | string                     | The message row's `time_created` rendered as an ISO 8601 instant.    |

### Discovery result (with error channel)

Discovery returns a session list and an optional error record. The error record carries a kind (corruption, lock, permission, schema, or unknown) and a message. A missing database file is not an error — it surfaces as an empty list with no error.

## Behavior

### Feature gate

The runtime support required to open the embedded structured-data store is provided by a runtime-built-in module. The reader checks the runtime version against the minimum that ships the module before attempting any discovery or read. The version check compares major and minor version numbers — it is not a live load — so it does not emit any experimental-feature warning.

- **Runtime supports the embedded-database module** → proceed.
- **Runtime does not support it** → installation status reports OpenCode as not present; discovery and reading return empty results without raising. An informational log line records that OpenCode support is disabled on this runtime.

### Lazy import

The actual embedded-database module is imported the first time a connection is opened, not at file load. Code paths that only transitively reference the helper module (such as the post-commit hook on a happy path that doesn't end up reading OpenCode) do not trigger the experimental-feature warning the runtime would otherwise emit. The shared SQLite helpers module performs this dynamic import inside the `withSqliteDb` wrapper.

### Installation check

`isOpenCodeInstalled()` returns true only when both:

1. The runtime supports the embedded-database module (per the feature gate above), and
2. The database file exists at the resolved path and is a regular file.

Either condition failing returns false. The intent is to avoid showing OpenCode as "detected but yields zero sessions" on hosts where any scan would fail.

### Discovery flow

1. Resolve the database path. Pre-flight `stat` it. If the file is missing (ENOENT), return an empty result with no error. If `stat` fails for another reason (permission, I/O), classify and return as a discovery error.
2. Open the database read-only via the lazy-imported runtime support.
3. Compute the staleness cutoff (now minus the staleness limit).
4. Issue a single query: select `id`, `title`, `directory`, `time_created`, `time_updated` from `session` where `time_updated` is strictly greater than the cutoff. The query carries **no directory predicate and no ordering clause**:
   - The directory predicate cannot live in the query any more, because attribution is no longer a string comparison — it requires a filesystem walk (see "Session-directory attribution" below). The query therefore returns every in-window session for every project on the machine, and the row's `directory` column is selected so the predicate can be applied to it afterwards.
   - Because every row that survives the two filters is kept regardless of position, the previous `time_updated` descending ordering was dropped as buying nothing. **The result set is unordered.**
5. For each row, apply the shared session-directory attribution rule to the row's `directory` against the project directory. Rows that fail are dropped silently.
6. For each surviving row, validate that `time_updated` is a finite number (defends against schema drift). Rows that fail validation are skipped with a warning.
7. Emit a session-info record per surviving row, populating the synthetic transcript locator.
8. Close the connection. If any step raised, classify the error and return it on the result. If the error indicates the database disappeared between detection and open, treat it as a missing file (empty result, no error).

The query intentionally does not filter by `parent_id` — child sessions created by auto-compaction continue an active conversation, so excluding them would lose recent activity.

### Session-directory attribution (shared rule, restated in full)

This is the shared attribution predicate every hookless, directory-scoped source applies; spec 253 is its canonical statement. OpenCode applies it once per row, against the session row's `directory` column. Evaluated in this order, first rule wins:

1. **Absent directory.** A missing, empty, or otherwise falsy `directory` is rejected before any path handling runs. This gate is load-bearing here: the predicate is mapped across every row of a machine-global store, and a row legitimately carrying no directory must skip that one session rather than fault and lose the whole scan.
2. **Containment.** Both paths are normalized — backslashes folded to forward slashes, trailing separators stripped, and the result lowercased **only** on case-insensitive host platforms (Windows and macOS; Linux compares case-sensitively). The session is a candidate only when the normalized `directory` either equals the normalized project directory, or begins with it followed by a single separator. The required separator is the boundary guarantee: a sibling directory whose name merely starts with the project directory's name (root `…/repo` vs candidate `…/repo2`) does not match.
3. **Exact match.** When the two normalize equal, the session is attributed immediately and the exclusion walk below is deliberately skipped — the project root is itself a repository root and carries its own marker, so inspecting it would reject every session.
4. **Exclusion walk for a strict subdirectory.** Walk upward one parent at a time from the session directory, stopping when the current directory normalizes equal to the project directory. At each visited directory — **including the session directory, excluding the project directory** — check whether it holds its own `.git` entry. If any does, the session is **not** attributed. One existence check covers all three exclusion cases and they are deliberately not distinguished: a nested clone carries a `.git` directory, a submodule and a linked worktree each carry a `.git` file. No entry-type inspection, no repository is opened, no version-control subprocess is run.
5. **Missing intermediate directory.** A visited directory that no longer exists simply reports "no marker here" and the walk continues, so a session whose recorded directory has since been deleted is **kept** (best-effort).
6. **Loop guard (unreachable).** The walk also stops on reaching a directory that is its own parent. Containment already guaranteed the project directory is an ancestor, so this is structurally unreachable; it exists only to make an infinite loop impossible.

No symbolic links are resolved anywhere in the rule: both the comparison and the walk operate on the literal path strings.

### Transcript read flow

1. Parse the synthetic transcript locator into the database path and the session id.
2. Open the database read-only.
3. Issue one query that joins `message` against `part`, scoped to the session id, ordered by message creation time, then by part creation time.
4. Group rows back into messages, keyed by message id, preserving first-seen order.
5. Skip the first `cursor.lineNumber` messages.
6. For each remaining message in order:
    - Apply the time cutoff if supplied: a message whose `time_created` exceeds the cutoff stops the loop without consuming the message.
    - Validate `time_created` as finite; otherwise drop and continue.
    - Parse the message `data` JSON and extract `role`. Map `"user"` to `"human"`, `"assistant"` to `"assistant"`. Any other role is dropped.
    - Walk the message's part `data` JSONs, keeping only those whose `type` is text. Trim each text and discard the empties; join the survivors with newlines. If nothing survives, drop.
    - Emit `{ role, content, timestamp }` where `timestamp` is the message's `time_created` rendered as an ISO 8601 instant.
7. After the loop, coalesce consecutive same-role entries.
8. Compute the new cursor.

### Cursor advancement

- **Without a time cutoff**: the new cursor is the total number of messages in the session at read time. Subsequent calls only see messages added afterward.
- **With a time cutoff**: the new cursor is the index just past the last consumed message; deferred messages remain available to the next call.

### Error surface during read

A read failure (missing database, corrupt database, schema drift, lock contention, or other) raises with a message that includes the session id; the session is not silently treated as empty. Discovery's error channel is the path for surfacing scan failures to the UI.

### Bundling on a host runtime that lacks the module

The VS Code extension is bundled to a runtime target that may not include the embedded-database module. The bundler tolerates the missing module at build time (it is loaded only via dynamic import) and the runtime feature gate ensures the module is never actually imported on a host that lacks it. On such a host, OpenCode reports as not installed and the rest of the product proceeds as if it isn't present.

## State Transitions

Discovery and reading are read-only with respect to the database. The cursor's `lineNumber` is monotonically non-decreasing across reads of the same session as long as OpenCode only appends messages.

## Notable Behavior

- **The synthetic transcript locator gives each session its own cursor key** even though all sessions share one database file. The format is `<dbPath>#<sessionId>`.
- **The locator is parsed by splitting on the last `#`**, allowing database paths that themselves contain `#` characters to round-trip.
- **The discovery result set is unordered.** The query previously ordered by recency descending; that clause was dropped when the directory predicate moved out of the query, because every row surviving the filters is kept regardless of position. Callers must not assume the most-recently-touched session appears first.
- **The transcript query orders by message-then-part creation time**, so even out-of-order inserts surface in stable, time-aligned order.
- **Both top-level and continuation (compacted) sessions are included**: filtering to `parent_id IS NULL` would exclude active conversations after auto-compaction.
- **Directory attribution is containment, not exact equality, and it happens after retrieval.** A session launched from a subdirectory of the project — the ordinary case in a monorepo package folder — is attributed to the project; under the previous exact-equality predicate every such session was silently dropped. The predicate needs a filesystem walk, so it cannot be pushed into the store query; the query fetches every in-window session on the machine and the walk filters them.
- **A nested repository, submodule, or linked worktree inside the project is excluded.** Containment alone would attribute such a session to both the inner context and the enclosing one; the intervening-marker walk makes the inner context its sole owner. The same session is attributed normally when the question is asked about that inner root instead.
- **Case-insensitive directory match on Windows and macOS**: VS Code URIs lowercase drive letters, so a project directory may arrive lowercased while the database stores the original casing. Linux stays case-sensitive.
- **A null directory column is an expected input, not an error.** The predicate's falsy gate runs before any path handling specifically because it is reached in normal operation across a machine-global store, and a fault there would drop every session in the scan rather than one.
- **Non-finite timestamps are skipped, not zeroed**: a row whose `time_updated` or `time_created` is not a finite number is dropped with a warning, not converted to a sentinel; this defends against schema drift turning into a spurious "corrupt" error from a downstream date conversion.
- **Stale-but-existent sessions are excluded by the query; out-of-project sessions are not.** The staleness cutoff is still enforced in the query, so no stale row is ever materialized. The directory predicate is the opposite: it runs after retrieval, so the query's row count reflects every project on the machine and only the post-filter count reflects this project.
- **Read raises on failure**, while discovery returns a structured error record. The two layers split responsibility: discovery surfaces UI-actionable errors; read surfaces per-session failures.
- **The lazy import keeps a transitively-importing module quiet**: a hook script that only references the helper transitively does not pay the experimental-feature warning until it actually opens a database.

## Shared Behavior

- **Staleness limit of two days** is shared across every discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source }`) matches every other discovery-based source.
- **Source tag of `"opencode"`** is the literal value shared with downstream session persistence.
- **Synthetic transcript-locator scheme** (`<storeRoot>#<sessionId>`) is shared with the Cursor and Copilot CLI sources, all of which back many sessions with one embedded store file.
- **Canonical normalized entry shape** (`{ role: "human"|"assistant", content, timestamp }`) matches every other source reader.
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` matches every other source reader; `lineNumber` is reused for what is conceptually a message index.
- **Same-role coalescing** is applied with the same semantics as every other source reader.
- **Time-cutoff filter** matches every other source reader: cutoff stops consumption, cursor advances only past consumed records, untimed records are conservatively included.
- **Working-directory based attribution** uses the shared session-directory attribution predicate restated above and owned canonically by **spec 253** — containment with a nested-repository / submodule / linked-worktree exclusion walk. The identical rule is applied by the Codex (spec 18), GitHub Copilot CLI (spec 21), Devin CLI (spec 277), and Antigravity (spec 278) sources. Adoption is not universal: several other hookless directory-scoped sources still match on exact-path equality (see spec 253's adoption note).
- **Post-retrieval directory filtering with an unordered result set** is shared with the Copilot CLI and Devin CLI sources: all three moved their directory predicate out of the store query when attribution became a filesystem walk, and all three dropped their ordering clause at the same time.
- **Embedded-database scan-error classification** (corruption, lock, permission, schema, unknown) is shared with the Cursor and Copilot CLI sources via a common helpers layer.
