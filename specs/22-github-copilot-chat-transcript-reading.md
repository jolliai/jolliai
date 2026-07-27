# 22 — GitHub Copilot Chat Transcript Reading

## Topic Statement

This spec defines how GitHub Copilot Chat sessions associated with the current VS Code workspace are detected, discovered, and read into the canonical normalized message form, including the workspace-locator behavior that maps the current project's absolute path to a Copilot Chat workspace identifier.

## Scope

**In scope**

- Detecting Copilot Chat presence by the existence of either of two known on-disk roots.
- The two distinct backends Copilot Chat uses, depending on which model the user picked for a "New Chat":
  - The Copilot CLI agent backend, which writes a per-session newline-delimited event log under the user's home, gated by a per-session metadata file pointing at a workspace folder.
  - The non-Copilot-CLI backend, which writes a per-session newline-delimited patch log under VS Code's per-workspace storage directory.
- The workspace-locator step that maps the current project's absolute path to a VS Code workspace identifier by scanning each workspace's metadata for a `folder` URI.
- Per-workspace session discovery: the two scans, run in sequence and concatenated.
- The staleness window applied to each scan.
- The deprecated snapshot-format files explicitly skipped.
- The two reader paths chosen by the trailing path segments of the transcript locator.
- The patch-log replay model used by the non-Copilot-CLI backend (initial-document, set-at-path, delete-at-path semantics).
- Mapping of the surviving event/request shapes to the canonical role tags.
- The cursor structure used for incremental resumption.
- The optional time-cutoff filter that lets a queue-driven caller attribute records to a specific commit boundary, applied to each backend with the appropriate timestamp shape.

**Out of scope**

- The standalone Copilot CLI source (the "New Copilot CLI Session" terminal entry-point), which is covered by a separate spec.
- The downstream LLM call that consumes the assembled context.
- Multi-session merging policy (handled by a shared context-assembly layer).
- Multi-root workspaces.

## Data Contracts

### Detection

Copilot Chat is considered present when at least one of these two roots exists as a directory:

- VS Code globalStorage extension root: `<vscodeUserData>/User/globalStorage/github.copilot-chat`
- Copilot CLI session-state root: `<home>/.copilot/session-state`

Either root can carry chat-panel "New Chat" data, depending on which backend the model selection routed the chat to. ENOENT is silent; other failures of `stat` log a warning.

### VS Code user-data directory

| Platform | Path                                              |
| -------- | ------------------------------------------------- |
| macOS    | `~/Library/Application Support/Code`              |
| Linux    | `~/.config/Code`                                  |
| Windows  | `%APPDATA%/Code` (fallback `~/AppData/Roaming/Code`) |

Resolution is shared with Cursor through a common workspace-locator layer that takes a flavor name; here the flavor is the VS Code stable build.

### Backend A — Copilot CLI agent backend

Per-session directory: `<home>/.copilot/session-state/<sessionId>/`. The directory contains:

| File                     | Purpose                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `vscode.metadata.json`   | JSON object whose `workspaceFolder.folderPath` is the absolute path of the workspace folder this session was launched against. Used to gate which sessions belong to which project. |
| `events.jsonl`           | The session's newline-delimited event log. Each line is a JSON event.                                  |

Each event line has at minimum:

| Field        | Type   | Notes                                                                                                  |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------ |
| `type`       | string | Event kind. Conversation events are `"user.message"` and `"assistant.message"`. Session-lifecycle, tool-call, tool-result, turn-boundary, and system-prompt events are ignored. |
| `timestamp`  | string | Optional ISO 8601 instant.                                                                             |
| `data.content` | string | The conversation text. Empty/missing content drops the event.                                        |

### Backend B — Non-Copilot-CLI backend

Per-session file: `<vscodeUserData>/User/workspaceStorage/<workspaceHash>/chatSessions/<sessionId>.jsonl`.

Each file is a JSONL patch log. The reader replays the patches into a final document and reads `requests[]` from it. Each line is a patch event:

| Kind | Shape                       | Effect                                                                  |
| ---- | --------------------------- | ----------------------------------------------------------------------- |
| 0    | `{ kind: 0, v: <document> }` | Replace the entire document with `v`. Typically the first line.         |
| 1    | `{ kind: 1, k: <path>, v }`  | Set `v` at the path `k` (an array of string/number segments).           |
| 2    | `{ kind: 2, k: <path> }`     | Delete the value at path `k`. For array element deletes, splice.        |
| other| `{ kind: <n> }`              | Logged and skipped (forward compatibility).                             |

The replayed document carries a `requests` array where each request has at minimum:

| Field            | Type    | Notes                                                                                                  |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `message.text`   | string  | The user's text. Non-empty produces a `"human"` entry.                                                 |
| `response`       | array   | Each chunk has an optional `value` string. Their concatenation, if non-empty, produces an `"assistant"` entry. |
| `timestamp`      | number  | Optional milliseconds since the Unix epoch.                                                            |

Files with the deprecated `.json` snapshot suffix are explicitly NOT read. Only `.jsonl` patch logs are scanned.

### Workspace.json (per-workspace metadata)

Each `<workspaceHash>` directory under VS Code's `workspaceStorage` contains a `workspace.json` whose `folder` field is a `file://` URI pointing at the workspace folder. Multi-root workspaces (with a `workspace` field) are silently skipped.

### Session-info record (output of discovery)

| Field            | Type    | Notes                                                                                       |
| ---------------- | ------- | ------------------------------------------------------------------------------------------- |
| `sessionId`      | string  | Backend A: the session directory name. Backend B: the file name without the suffix.         |
| `transcriptPath` | string  | Backend A: the absolute path of `events.jsonl`. Backend B: the absolute path of the per-session `.jsonl`. |
| `updatedAt`      | string  | The transcript file's mtime rendered as an ISO 8601 instant.                                |
| `source`         | string  | The literal source tag for Copilot Chat.                                                    |

### Cursor

| Field            | Type   | Notes                                                                                                          |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `transcriptPath` | string | The transcript path (events.jsonl path or chat-sessions .jsonl path).                                          |
| `lineNumber`     | int    | Backend A: count of lines already consumed (1-based at line completion). Backend B: count of `requests[]` already consumed. |
| `updatedAt`      | string | The transcript file's mtime at the time the cursor was produced.                                               |

### Discovery result (with error channel)

Discovery returns sessions and an optional structured error. The error carries a kind (parse, fs, schema, unknown) and a message. ENOENT on either root is silent. The first non-ENOENT error from either scan is the one returned; the other is debug-logged.

## Behavior

### Workspace lookup

1. Iterate VS Code's `workspaceStorage` root, listing each `<workspaceHash>`.
2. For each, read `workspace.json` and extract `folder` (skip if absent or if the file lacks a `folder` field).
3. Convert the URI to a filesystem path; URIs not starting with `file://` are skipped, unparseable URIs are warned and skipped.
4. Normalize for matching: backslashes → forward slashes, trim trailing slashes, lowercase on macOS and Windows. Linux compares case-sensitively.
5. Compare against the project directory normalized the same way; return the first match. Null if no workspace points at the project.

This step is shared with Cursor through a common workspace-locator layer; Copilot Chat passes the VS Code flavor name.

### Discovery flow

Two scans run in sequence; their session lists are concatenated; the first error encountered is returned.

**Scan A — Copilot CLI agent backend (events.jsonl):**

1. List directories under `<home>/.copilot/session-state/`. ENOENT → empty result, no error. Other failures → fs error.
2. For each session directory:
    - Read and parse `vscode.metadata.json`. Failures (missing, unparseable, missing `workspaceFolder.folderPath`) skip the session silently.
    - Compare the metadata's `folderPath`, normalized as above, against the project directory normalized the same way. Mismatch skips the session.
    - `stat` `events.jsonl` for its mtime. Failures skip.
    - If the mtime is older than the staleness cutoff, skip.
    - Emit a session-info record with the events-file path as the transcript locator.

**Scan B — Non-Copilot-CLI backend (chatSessions/*.jsonl):**

1. Resolve the workspace hash via the workspace lookup. Null → empty result, no error.
2. List the `chatSessions` directory under the workspace. ENOENT → empty result, no error. Other failures → fs error.
3. For each entry:
    - Skip files that don't have the newline-delimited records suffix (the deprecated snapshot-format files have a different suffix and are ignored).
    - `stat` the file for its mtime. Failures skip.
    - If the mtime is older than the staleness cutoff, skip.
    - Emit a session-info record with the file's path as the transcript locator. The session id is the file name without the suffix.

### Reader dispatch

The transcript-reading entry point dispatches on the trailing path segments of the transcript locator:

- A path matching the events-file shape under the Copilot CLI session-state root → events-log reader.
- A path matching the per-session JSONL file under a workspace's `chatSessions` directory → patch-log reader.
- Any other shape raises (defense-in-depth invariant; the discoverer should only emit recognized shapes).

### Events-log reader (Backend A)

1. Stream the file line-by-line.
2. Skip the first `cursor.lineNumber` lines.
3. For each remaining line:
    - On JSON-parse failure, advance the consumed-line count and continue (one bad line never blocks the rest, matching the other JSONL readers).
    - Apply the time cutoff: if the event has a string `timestamp` and lex-compares strictly greater than the cutoff (ISO 8601 strings are lex-sortable), undo the consumed-line increment and stop the loop.
    - Read `data.content`. If absent, empty, or non-string, advance and continue.
    - For event type `"user.message"`, emit `{ role: "human", content, timestamp? }` with the event's timestamp if present.
    - For event type `"assistant.message"`, emit `{ role: "assistant", content, timestamp? }` similarly.
    - Other event types are skipped.
4. Compute the new cursor at the current consumed-line count, with `updatedAt` set from the file's mtime.

### Patch-log reader (Backend B)

1. Read the entire file as text.
2. Split into lines and discard blanks.
3. Replay patches into a final document:
   - kind 0: replace the document.
   - kind 1: walk `k` and set `v` at the leaf, creating intermediate containers (object or array, decided by whether the next path segment is a number).
   - kind 2: walk `k` and delete at the leaf; for array element deletes, splice so the array shifts.
   - unknown kinds: log a warning and skip.
   - JSON-parse failure on any line raises a parse-class structured error. (Distinguishes "mid-write" from "structurally broken file" upstream.)
4. Read `requests[]` from the document. If not an array, raise a schema-class structured error.
5. Skip the first `cursor.lineNumber` requests.
6. For each remaining request in order:
    - Apply the time cutoff: if the request has a numeric `timestamp` strictly greater than the parsed cutoff, stop without consuming this request.
    - Emit a `"human"` entry from `message.text` if it is a non-empty string.
    - Concatenate the `value` chunks of `response`; if non-empty, emit an `"assistant"` entry.
    - Advance the consumed-request count past this request.
7. Compute the new cursor at the last-consumed request count, with `updatedAt` set from the file's mtime.

### Cursor advancement (both readers)

The cursor's `lineNumber` advances only past records actually consumed. Records deferred by the time cutoff are not counted as consumed; the next read with a wider cutoff will pick them up.

### Patch-log read errors

A patch-log read raises a structured error carrying a kind:

- `parse` — a patch line is not valid JSON.
- `fs` — the file cannot be read.
- `schema` — the replayed document does not contain a `requests` array.
- `unknown` — anything else.

The kind is exposed on the raised error's `cause` so a queue-driven caller can decide whether to retry or surface to the user.

## State Transitions

Discovery and reading are read-only. The cursor's `lineNumber` is monotonically non-decreasing across reads of the same transcript as long as the producer only appends.

## Notable Behavior

- **Two backends, one source tag**: VS Code routes a "New Chat" to either backend depending on the model the user selected. Both produce sessions tagged with the same Copilot Chat source tag, and both are discovered for the same project.
- **Backend A is gated by metadata.folderPath**, not by workspace hash: the per-session metadata file points at the workspace directly, so workspace-hash lookup is not required for scan A.
- **Backend B is gated by workspace hash**: scan B uses the shared workspace-locator to convert the project path to a workspace hash, then enumerates the `chatSessions` directory under that hash.
- **Deprecated snapshot files are not read**: only newline-delimited patch logs are read; legacy snapshot files are ignored.
- **mtime is the freshness signal**: there is no per-session metadata field that consistently reflects "last activity" across both backends, so the file's mtime is used.
- **The two-day staleness window applies to both scans**: stale sessions are dropped before the result list is built.
- **The patch log is replayed on every read**: the reader does not maintain a between-call replay cache; each call re-reads and re-replays. Cursor-based skipping bypasses re-emitting old entries but not re-replaying patches.
- **Patch-log integer paths create arrays, string paths create objects**: when intermediate containers must be created during a set-at-path, the next path segment's type decides the container shape.
- **Array element deletes use splice, not key-delete**: this matches the producer's emitted semantics for cleaning up pending-request records.
- **Forward compatibility**: an unknown patch kind logs a warning and is skipped; a future patch kind cannot break replay of the rest of the file.
- **Per-line JSON parse failure is non-fatal in the events log** (matches the other JSONL readers' "one bad line never blocks the rest" rule).
- **Per-line JSON parse failure IS fatal in the patch log** (because each patch must apply for the document to be coherent); this is surfaced as a parse-class structured error.
- **Time-cutoff comparison uses string lex-compare for the events log** (ISO 8601 strings are lex-sortable) and parsed-number-compare for the patch log (timestamps are milliseconds).
- **Untimed events in the events log are consumed**, matching the conservative-include rule used by every other source reader.
- **Untimed requests in the patch log are consumed** — their timestamp is treated as before-cutoff, consistent with the same rule.
- **Standalone Copilot CLI is a separate source**: the terminal-launched Copilot CLI session is reported via the Copilot CLI source spec; only chat-panel "New Chat" sessions are reported via this Copilot Chat spec.

## Shared Behavior

- **Staleness limit of two days** is shared across every discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source }`) matches every other discovery-based source.
- **Source tag of `"copilot-chat"`** is the literal value shared with downstream session persistence; it is distinct from the standalone Copilot CLI source tag.
- **Cross-platform user-data directory resolution and workspace-folder lookup** are shared with the Cursor source through a common workspace-locator layer; only the flavor name differs.
- **Path normalization for workspace-folder matching** (backslashes → forward slashes, trim trailing slashes, case-fold on macOS and Windows) matches the Cursor source.
- **Canonical normalized entry shape** (`{ role: "human"|"assistant", content, timestamp? }`) matches every other source reader.
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` matches every other source reader. For backend A, `lineNumber` counts events-log lines; for backend B, it counts replayed `requests[]` already consumed.
- **Time-cutoff filter** matches every other source reader: cutoff stops consumption, cursor advances only past consumed records, untimed records are conservatively included.
- **Newline-delimited record format** for the events log is the same on-disk shape used by Claude Code and Codex; the per-line schema differs.
