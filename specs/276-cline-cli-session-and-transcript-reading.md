# 276. Cline CLI Session Discovery and Transcript Reading

## Topic Statement

This spec defines how Cline CLI (the standalone `cline` terminal tool) sessions are detected, discovered for the current project, and read into the canonical normalized message form from a per-session JSON sidecar and messages file under the CLI's own data directory.

## Scope

**In scope**

- Detecting the Cline CLI by the presence of its sessions directory.
- The on-disk layout: one directory per session, each holding a metadata sidecar and a messages file.
- The project-attribution rule: matching the sidecar's workspace-root (or cwd) field directly against the current project path.
- The messages-path resolution rule, including the safety rule around trusting a sidecar-declared path only when absolute.
- The freshness signal: the messages file's own modification time, not any field inside the sidecar or messages file.
- The per-message block shape and the `<user_input>` unwrapping applied only to human turns.
- The cursor structure used for incremental resumption (indexed by message-array position).
- The optional time-cutoff filter that lets a queue-driven caller attribute records to a specific commit boundary.
- The title-resolution behavior specific to this source.

**Out of scope**

- The Cline VS Code extension source — covered by a separate spec.
- Cline CLI's WAL-mode `sessions.db` — deliberately never read by this source (see Notable Behavior).
- The downstream LLM call that consumes the assembled context.
- Multi-session merging policy (handled by a shared context-assembly layer).

## Data Contracts

### Detection

The Cline CLI is considered installed when `<home>/.cline/data/sessions` exists and is accessible. There is no gate on any embedded-database runtime module — detection is a plain directory-existence check, and the discoverer never reads the CLI's WAL-mode session database.

### Directory layout

- Data root: `<home>/.cline/data`
- Sessions root: `<dataDir>/sessions`
- Per-session directory: `<sessionsDir>/<id>/`, containing:
  - `<id>.json` — the metadata sidecar (see below).
  - `<id>.messages.json` — the canonical messages file, unless the sidecar declares an absolute override.

### Sidecar file (`<id>.json`)

| Field | Type | Notes |
| --- | --- | --- |
| `session_id` | string, optional | The session id; falls back to the directory name `<id>` when absent. |
| `cwd` / `workspace_root` | string, optional | Project-attribution field; `workspace_root` takes priority over `cwd` when both are present. |
| `messages_path` | string, optional | A candidate override for the messages file location. Trusted only when it is an absolute path (see Behavior). |
| `metadata.title` | string, optional | Trimmed and used as the discovered session's title when non-empty. |

### Messages file

A JSON object:

| Field | Type | Notes |
| --- | --- | --- |
| `messages` | array, optional | Absent/non-array is treated as zero messages. |

Each message:

| Field | Type | Notes |
| --- | --- | --- |
| `role` | string, optional | `"user"` or `"assistant"` (else dropped). |
| `content` | array of blocks, optional | A block has a `type` and, for `type: "text"`, a `text` string. Non-`"text"` block types are never read. |
| `ts` | number, optional | Milliseconds since epoch. |

### Session-info record (output of discovery)

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | string | Sidecar's `session_id`, or the session directory name if absent. |
| `transcriptPath` | string | The resolved messages-file path (see Behavior). |
| `updatedAt` | string | The messages file's mtime, rendered as an ISO 8601 instant — **not** any field from the sidecar or the messages file itself. |
| `source` | string | The literal source tag for the Cline CLI (`"cline-cli"`). |
| `title` | string, optional | The sidecar's trimmed `metadata.title`, when non-empty. |

### Cursor

| Field | Type | Notes |
| --- | --- | --- |
| `transcriptPath` | string | The resolved messages-file path. |
| `lineNumber` | int | Reused as a message-array index: count of messages already consumed. |
| `updatedAt` | string | The wall-clock instant the cursor was produced. |

### Normalized entry (output of read)

| Field | Type | Notes |
| --- | --- | --- |
| `role` | `"human"` or `"assistant"` | `"user"` → `"human"`, `"assistant"` → `"assistant"`; anything else dropped. |
| `content` | string | Text-type blocks joined with a newline, then trimmed. For human turns, further unwrapped from a `<user_input>` tag when present. |
| `timestamp` | string, optional | The message's `ts` rendered as ISO 8601, when `ts` is a number. |

### Discovery result (error channel)

Discovery returns a session list and an optional structured error with a `kind` of `"fs"` (the only kind ever actually produced by this discoverer — the sessions-directory read failing for a reason other than "not found") and a `message`. `"parse"`, `"schema"`, and `"unknown"` are declared as possible kinds but unreachable here: a per-session sidecar parse failure is handled as a silent per-session skip (see Behavior), never surfaced as a scan-level error.

## Behavior

### Detection flow

1. Attempt to access `<home>/.cline/data/sessions`.
2. Return true if it succeeds, false otherwise (including ENOENT).

### Discovery flow

1. List the sessions directory. A missing directory (ENOENT) yields an empty result with no error. Any other listing failure yields an empty result with a `"fs"`-kind error.
2. Compute the staleness cutoff (now minus 48 hours) and the normalized target project path.
3. For each session-directory entry (by name, `id`):
   - Read and JSON-parse the sidecar `<id>.json`. On any failure (missing file, invalid JSON), log at debug level and skip this session entirely — this is not surfaced through the discovery error channel.
   - Compute the attribution root as `workspace_root` if present, else `cwd`. Skip the session if neither is a string, or if the normalized root doesn't match the normalized project path.
   - Resolve the messages path: if the sidecar's `messages_path` is a string **and** is an absolute path, use it verbatim; otherwise (missing, or a relative/non-absolute value) fall back to the canonical `<sessionsDir>/<id>/<id>.messages.json`. A relative or foreign-machine-synced `messages_path` is deliberately not trusted, since resolving it against the process's current working directory would silently miss a live session.
   - `stat` the resolved messages path for its mtime. Any failure (file doesn't exist) skips the session silently.
   - Skip the session if the messages file's mtime is older than the staleness cutoff.
   - Emit a session-info record: `sessionId` from the sidecar's `session_id` (or the directory name), `transcriptPath` the resolved messages path, `updatedAt` from the messages file's mtime, `title` from the sidecar's trimmed `metadata.title` when non-empty.
4. The queue-facing wrapper strips the error channel, logging a warning if one was present, and always returns a plain session array.

### Transcript read flow

1. Read the entire messages file as JSON. On a read or parse failure, log an error and return an empty result that preserves the caller's cursor position unchanged (or index 0 if none was supplied).
2. Take the `messages` array (or treat it as empty if absent/non-array).
3. For each message: map its role; extract text by joining `type: "text"` blocks with a newline and trimming (non-text block types — e.g. `thinking`, `tool_use`, `tool_result` — are never read, for **both** roles alike, unlike the VS Code extension source which only filters non-text blocks and additionally strips embedded scaffolding on human turns); if the mapped role is `"human"`, further reduce the joined text by extracting the inner content of a `<user_input …>…</user_input>` tag when present (any attributes on the opening tag are ignored), or keep the text as-is if no such tag is found, then trim.
4. Starting from the cursor's message index (0 if none), walk forward:
   - If a wall-clock cutoff is in effect and the message's `ts` is a number greater than the cutoff, stop the walk without counting this message as consumed.
   - Otherwise count the message as consumed. If its mapped role is undefined or its extracted text is empty, produce no entry; otherwise emit `{ role, content, timestamp? }`.
5. Coalesce consecutive same-role entries.
6. Compute the new cursor: with a cutoff, the index just past the last consumed message; without one, the total message count.

### Title resolution

Identical pattern to the VS Code extension source: the sidecar's `metadata.title` is the sole native title. When absent, the fallback chain's per-line parser for this source is a permanent no-op (always returns undefined regardless of input), so any session lacking a sidecar title unconditionally falls through to the generic untitled-session placeholder.

## State Transitions

Detection, discovery, and reading are all read-only with respect to Cline CLI's on-disk state. The cursor's message index is monotonically non-decreasing across reads of the same session as long as the messages file is only appended to.

## Notable Behavior

- **The CLI maintains a WAL-mode `sessions.db` that this source never reads.** Detection and discovery are both built entirely on plain JSON sidecar + messages files; this is a deliberate design choice to avoid any embedded-database runtime dependency for this source, in contrast to Cursor/OpenCode/Copilot CLI which do read an embedded SQLite store and are consequently gated by runtime SQLite support.
- **Per-session sidecar corruption is invisible at the discovery-error level.** A malformed or unreadable `<id>.json` is logged at debug level and the session is simply skipped — it never becomes a `"parse"`-kind (or any) discovery error, unlike the VS Code extension source where a malformed *flavor-wide* `taskHistory.json` does surface as a scan error. The granularity differs because this source's per-session sidecars are independent files, while the extension's history is one shared file per flavor.
- **Freshness comes from the messages file's mtime, not from any timestamp field inside either JSON document.** Neither the sidecar nor the messages file is required to carry (or is ever read for) an explicit "last updated" field.
- **`messages_path` from the sidecar is trusted only when absolute.** A relative value, or one that arrived via file sync from a different machine, would resolve against the current process's working directory rather than the session's actual location — the discoverer falls back to the canonical location instead of risking a silent miss.
- **The session id falls back to the directory name** when the sidecar omits `session_id`, so a session is always identifiable even from a minimal or partially-written sidecar.
- **No scaffolding-stripping is needed or applied** — unlike the VS Code extension's raw-API-replay format, this source's message content blocks contain only clean text; the only normalization performed on human turns is the `<user_input>` unwrap.
- **Non-text content blocks (`thinking`, `tool_use`, `tool_result`) are dropped uniformly for both human and assistant turns** — there is no asymmetric "assistant kept raw" rule here as there is for the VS Code extension source, because this source's format never puts provider-specific tool markup inside a `text` block in the first place.
- **A missing messages file for an otherwise-valid session is a silent skip**, with no log line at all (distinguishing it from the sidecar-parse-failure case, which does debug-log).
- **`"parse"`, `"schema"`, and `"unknown"` scan-error kinds are declared but unreachable** for this source's discovery-error channel; only `"fs"` is ever actually constructed (and only for a sessions-directory listing failure, not a per-session issue).
- **The per-line title fallback for this source is a permanent no-op**, identical in behavior to the VS Code extension source's stub.

## Shared Behavior

- **Staleness limit of two days** is shared across every discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source }`) matches every other discovery-based source.
- **Source tag of `"cline-cli"`** is the literal value shared with downstream session persistence; distinct from the VS Code extension's `"cline"` tag.
- **Canonical normalized entry shape** (`{ role: "human"|"assistant", content, timestamp? }`) matches every other source reader.
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` matches every other source reader; `lineNumber` is reused as a message-array index.
- **Same-role coalescing** is the same primitive used by every other source reader.
- **Time-cutoff filter** matches every other source reader: cutoff stops consumption, cursor advances only past consumed records, untimed records are conservatively included (consumed).
- **The message-index cursor arithmetic, role mapping, and the empty-result-preserving-cursor behavior on an unreadable file are implemented in one primitive shared verbatim with the Cline VS Code extension source** — the two sources differ only in how each gets from its own raw file format to the shared normalized-message shape that primitive consumes.
- **Path normalization for project-directory matching** (backslash-to-forward-slash, trailing-slash trim, case-fold on macOS/Windows) uses the same primitive as the VS Code extension source, though this source compares a sidecar field directly rather than a workspace-hash-resolved path.
