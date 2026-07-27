# 21 — GitHub Copilot CLI Transcript Reading

## Topic Statement

This spec defines how GitHub Copilot CLI session histories are detected, discovered for the current project, and read into the canonical normalized message form from a local embedded structured-data store.

## Scope

**In scope**

- Detecting GitHub Copilot CLI installation by the presence of its session-store file.
- The on-disk location of the session-store file.
- The relevant tables and columns: a sessions table that records each session's working directory and metadata, and a turns table that records ordered conversation turns.
- The discovery query, which selects every session row unfiltered and unordered, and the two post-retrieval filters applied to it: the shared session-directory attribution rule, and the freshness/staleness window.
- The shared session-directory attribution rule — containment plus a nested-repository / submodule / linked-worktree exclusion walk — and the fact that it cannot be expressed in the store query.
- The synthetic transcript-locator scheme.
- The transcript-read query that walks the turns table for a given session in order.
- Mapping of the per-turn user/assistant pair fields to the canonical role tags.
- The cursor structure used for incremental resumption (indexed by turn position).
- The optional time-cutoff filter that lets a queue-driven caller attribute records to a specific commit boundary.

**Out of scope**

- VS Code Copilot Chat (the in-editor surface) — handled by a separate spec.
- The downstream LLM call that consumes the assembled context.
- Multi-session merging policy (handled by a shared context-assembly layer).
- The runtime feature gate beyond noting that, like every other embedded-store source, Copilot CLI reports as not installed on runtimes that lack the embedded-database support.

## Data Contracts

### Detection

GitHub Copilot CLI is considered installed when:

1. The runtime supports the embedded-database module, and
2. The session-store file exists at the resolved path and is a regular file.

Either condition failing reports Copilot CLI as not installed. ENOENT is silent; other failures of `stat` are warned. A non-supporting runtime emits an informational log line that explains why Copilot CLI is reported absent.

### Storage location

The session-store lives under the user's home in a Copilot-specific directory: `<home>/.copilot/session-store.db`. The store uses write-ahead-logging mode; the runtime-built-in embedded-database module reads it correctly because it is statically linked against the same SQLite version that produced the store.

### Tables and columns (relevant subset)

| Table      | Columns the reader uses                                                                              | Notes                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `sessions` | `id`, `cwd`, `repository`, `branch`, `host_type`, `summary`, `created_at`, `updated_at`              | One row per session. `cwd` is the working directory the session was launched in. `updated_at` is a TEXT field carrying an ISO 8601 instant. |
| `turns`    | `turn_index`, `user_message`, `assistant_response`, `timestamp`                                      | One row per conversation turn, scoped to a session. `turn_index` is a per-session 0-based ordinal protected by a `UNIQUE(session_id, turn_index)` constraint. `timestamp` is TEXT (ISO 8601 instant). |

### Session-info record (output of discovery)

| Field            | Type    | Notes                                                                                                |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `sessionId`      | string  | The session row's `id`.                                                                              |
| `transcriptPath` | string  | A synthetic locator: the database file's absolute path, a `#` separator, and the session id.        |
| `updatedAt`      | string  | The session row's `updated_at` re-rendered as a canonical ISO 8601 instant.                          |
| `source`         | string  | The literal source tag for Copilot CLI.                                                              |

### Cursor

| Field            | Type   | Notes                                                                                  |
| ---------------- | ------ | -------------------------------------------------------------------------------------- |
| `transcriptPath` | string | The synthetic locator.                                                                 |
| `lineNumber`     | int    | Reused as a turn-row index: count of turn rows already consumed on prior reads.        |
| `updatedAt`      | string | The wall-clock instant the cursor was produced.                                        |

### Normalized entry (output)

A single turn row produces up to two entries: one human and one assistant.

| Field       | Type                       | Notes                                                                                                |
| ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `role`      | `"human"` or `"assistant"` | A non-empty `user_message` produces a `"human"` entry; a non-empty `assistant_response` produces an `"assistant"` entry. |
| `content`   | string                     | The corresponding string field, used as-is.                                                         |
| `timestamp` | string or absent           | The turn row's `timestamp` if it parses as a valid instant; absent otherwise.                       |

### Discovery result (with error channel)

Discovery returns a session list and an optional error record. ENOENT on the session-store is silent. Other `stat` or query failures classify into corruption, lock, permission, schema, or unknown.

## Behavior

### Discovery flow

1. Resolve the session-store path. Pre-flight `stat` it. ENOENT → empty list, no error. Other failures → classified scan error.
2. Open the store read-only.
3. Compute the staleness cutoff (now minus the staleness limit).
4. Issue a single query: select every row of the sessions table. The query carries **no predicate of any kind and no ordering clause** — it is a full-table scan:
   - The `cwd` predicate cannot live in the query, because attribution is no longer a string comparison — it requires a filesystem walk (see "Session-directory attribution" below). The query therefore returns every session for every project on the machine, and the row's `cwd` column is filtered afterwards.
   - The cutoff is **not** applied in SQL either, but for an independent reason: `updated_at` is TEXT, and a SQL `>` comparison would be lexicographic and only correct if every row used canonical UTC ISO 8601. Filtering happens after parsing the instant.
   - Because every row that survives the two post-filters is kept regardless of position, the previous `updated_at` descending ordering was dropped as buying nothing. **The result set is unordered.**
5. For each row, apply the shared session-directory attribution rule to the row's `cwd` against the project directory. Rows that fail are dropped silently.
6. For each surviving row, parse `updated_at`. Rows whose timestamp is not finite are skipped with a warning. Rows whose parsed instant is older than the cutoff are skipped silently.
7. Emit a session-info record per surviving row, populating the synthetic transcript locator and re-rendering `updated_at` as a canonical ISO 8601 instant.
8. Close the store. On any failure, classify and return as a discovery error. A "vanished between detection and open" race is treated as ENOENT (empty list, no error).

### Session-directory attribution (shared rule, restated in full)

This is the shared attribution predicate every hookless, directory-scoped source applies; spec 253 is its canonical statement. Copilot CLI applies it once per row, against the session row's `cwd` column. Evaluated in this order, first rule wins:

1. **Absent directory.** A missing, empty, or otherwise falsy `cwd` is rejected before any path handling runs. This gate is load-bearing here: the predicate is mapped across every row of a machine-global store, and a session started outside any project stores no `cwd` — that one row must be skipped rather than fault and lose the whole scan.
2. **Containment.** Both paths are normalized — backslashes folded to forward slashes, trailing separators stripped, and the result lowercased **only** on case-insensitive host platforms (Windows and macOS; Linux compares case-sensitively). The session is a candidate only when the normalized `cwd` either equals the normalized project directory, or begins with it followed by a single separator. The required separator is the boundary guarantee: a sibling directory whose name merely starts with the project directory's name (root `…/repo` vs candidate `…/repo2`) does not match.
3. **Exact match.** When the two normalize equal, the session is attributed immediately and the exclusion walk below is deliberately skipped — the project root is itself a repository root and carries its own marker, so inspecting it would reject every session.
4. **Exclusion walk for a strict subdirectory.** Walk upward one parent at a time from the session directory, stopping when the current directory normalizes equal to the project directory. At each visited directory — **including the session directory, excluding the project directory** — check whether it holds its own `.git` entry. If any does, the session is **not** attributed. One existence check covers all three exclusion cases and they are deliberately not distinguished: a nested clone carries a `.git` directory, a submodule and a linked worktree each carry a `.git` file. No entry-type inspection, no repository is opened, no version-control subprocess is run.
5. **Missing intermediate directory.** A visited directory that no longer exists simply reports "no marker here" and the walk continues, so a session whose recorded directory has since been deleted is **kept** (best-effort).
6. **Loop guard (unreachable).** The walk also stops on reaching a directory that is its own parent. Containment already guaranteed the project directory is an ancestor, so this is structurally unreachable; it exists only to make an infinite loop impossible.

No symbolic links are resolved anywhere in the rule: both the comparison and the walk operate on the literal path strings.

### Transcript read flow

1. Parse the synthetic locator into the database path and session id.
2. Open the store read-only.
3. Issue one query: select all turn rows scoped to the session id, ordered by `turn_index` ascending.
4. Skip the first `cursor.lineNumber` rows.
5. For each remaining row in order:
    - Apply the time cutoff: if the row's `timestamp` parses as a finite instant strictly after the cutoff, stop the loop without consuming the row.
    - Compute the per-turn timestamp: the row's `timestamp` if it parses as finite; otherwise absent.
    - If `user_message` is a non-empty string, emit `{ role: "human", content: user_message, timestamp }`.
    - If `assistant_response` is a non-empty string, emit `{ role: "assistant", content: assistant_response, timestamp }`.
    - Advance the consumed-rows count past this row.
6. Coalesce consecutive same-role entries.
7. Compute the new cursor.

### Cursor advancement

- **Without a time cutoff**: the new cursor is the total turn-row count at read time.
- **With a time cutoff**: the new cursor is the count of rows actually consumed before the cutoff caused the loop to stop.

### Why a row-count cursor (vs a turn_index cursor)

The cursor counts fully-consumed result-set rows starting from zero. With Copilot's `UNIQUE(session_id, turn_index)` constraint the row index and `turn_index` move in lockstep, so the two are equivalent in normal operation. If turns were ever deleted (leaving holes), a value-based resume keyed on `turn_index` would be required; the current implementation does not handle that case.

### Empty / partial turns

A row whose `user_message` is null or empty produces no human entry; a row whose `assistant_response` is null or empty produces no assistant entry. A row with neither produces nothing but still counts as consumed, so the cursor advances past it.

### Read failures

A read failure (missing store, corrupt store, schema drift, lock contention, or other) raises with a message that includes the session id; the session is not silently treated as empty.

## State Transitions

Discovery and reading are read-only with respect to the session-store. The cursor is monotonically non-decreasing across reads of the same session as long as Copilot CLI only appends turns.

## Notable Behavior

- **The cwd column is per-session**: each session row carries its own working directory, so workspace attribution is decided directly from the row and does not require a separate workspace-pointer file.
- **The discovery query is an unfiltered, unordered full-table scan.** Both of its former clauses are gone: the `cwd` predicate moved out because attribution now needs a filesystem walk, and the recency ordering was dropped because every surviving row is kept regardless of position. Callers must not assume the most-recently-touched session appears first.
- **Directory attribution is containment, not exact equality.** A session launched from a subdirectory of the project — the ordinary case in a monorepo package folder — is attributed to the project; under the previous exact-equality predicate every such session was silently dropped.
- **A nested repository, submodule, or linked worktree inside the project is excluded.** Containment alone would attribute such a session to both the inner context and the enclosing one; the intervening-marker walk makes the inner context its sole owner. The same session is attributed normally when the question is asked about that inner root instead.
- **A null cwd is an expected input, not an error.** The predicate's falsy gate runs before any path handling specifically because a session started outside any project stores no `cwd`, and a fault there would drop every session in the scan rather than one.
- **Two-day staleness window applied after retrieval, not in SQL**: because `updated_at` is TEXT, lexicographic SQL comparison would be unreliable across timezones and formats. Parsing the instant first is robust. This is an independent reason from the one that moved the directory predicate out of the query.
- **One turn row produces two entries**: the user and assistant messages of a single turn are stored together on one row; they are emitted as two separate entries in canonical form so the same coalescing rules apply.
- **Empty halves are dropped, not emitted as empty entries**: a turn with only a user message produces only a human entry.
- **Per-turn timestamp is shared between the human and assistant halves**: if one entry parses as instant-bearing, both do.
- **Non-finite `updated_at` warns, non-finite turn `timestamp` does not warn**: the discoverer guards against schema drift loudly; the reader treats a missing per-turn timestamp as routine.
- **`updated_at` is re-rendered as canonical ISO 8601** in the session-info record so downstream callers see one canonical format regardless of how the store happened to format it.
- **The session-store uses write-ahead-logging mode**: the read uses the runtime's built-in embedded-database module (statically linked SQLite) rather than a pure-script implementation that cannot see WAL data.
- **The synthetic locator follows the same `<dbPath>#<sessionId>` pattern** as OpenCode and Cursor.

## Shared Behavior

- **Staleness limit of two days** is shared across every discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source }`) matches every other discovery-based source.
- **Source tag of `"copilot"`** is the literal value shared with downstream session persistence.
- **Synthetic transcript-locator scheme** (`<storeRoot>#<sessionId>`) is shared with OpenCode and Cursor.
- **Canonical normalized entry shape** (`{ role: "human"|"assistant", content, timestamp? }`) matches every other source reader.
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` matches every other source reader; `lineNumber` is reused as a turn-row index.
- **Same-role coalescing** is applied with the same semantics as every other source reader.
- **Time-cutoff filter** matches every other source reader: cutoff stops consumption, cursor advances only past consumed records, untimed records are conservatively included.
- **Working-directory based attribution** uses the shared session-directory attribution predicate restated above and owned canonically by **spec 253** — containment with a nested-repository / submodule / linked-worktree exclusion walk. The identical rule is applied by the Codex (spec 18), OpenCode (spec 19), Devin CLI (spec 277), and Antigravity (spec 278) sources. Adoption is not universal: several other hookless directory-scoped sources still match on exact-path equality (see spec 253's adoption note).
- **Post-retrieval directory filtering with an unordered result set** is shared with the OpenCode and Devin CLI sources: all three moved their directory predicate out of the store query when attribution became a filesystem walk, and all three dropped their ordering clause at the same time.
- **Embedded-database scan-error classification** is shared with OpenCode and Cursor through a common helpers layer.
- **Runtime feature-gate behavior** matches OpenCode: a runtime that lacks embedded-database support reports Copilot CLI as not installed and is silent.
