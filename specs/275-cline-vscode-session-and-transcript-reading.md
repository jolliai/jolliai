# 275. Cline VS Code Extension Session Discovery and Transcript Reading

## Topic Statement

This spec defines how Cline VS Code extension sessions are detected, discovered for the current project, and read into the canonical normalized message form from the extension's globalStorage task-history file and per-task conversation-replay file.

## Scope

**In scope**

- Detecting the Cline VS Code extension by the presence of its globalStorage task-history file, checked across every supported VS Code-family flavor.
- The cross-platform user-data directory layout shared with the VS Code-family workspace locator.
- The task-history file: one JSON array shared globally per flavor (not per-workspace), each entry carrying its own originating working directory.
- The project-attribution rule: matching a task-history entry's working-directory field directly against the current project path (no workspace-hash indirection).
- The per-task transcript file: a raw replay of the underlying model API's conversation history.
- The scaffolding-stripping rules applied to human-turn text specific to this replay format (environment-details blocks, boilerplate, echoed tool-result text, `<task>`/`<feedback>` unwrapping).
- The role mapping and the assistant-side "kept raw" policy.
- The cursor structure used for incremental resumption (indexed by message position).
- The optional time-cutoff filter that lets a queue-driven caller attribute records to a specific commit boundary.
- The title-resolution behavior specific to this source (native title vs. fallback).

**Out of scope**

- The Cline CLI (`cline` binary) source — covered by a separate spec.
- The downstream LLM call that consumes the assembled context.
- Multi-session merging policy (handled by a shared context-assembly layer).
- Multi-root VS Code workspaces (out of scope entirely — this source does not consult `workspace.json` at all; see Notable Behavior).

## Data Contracts

### Detection

The Cline VS Code extension is considered installed when, for at least one supported VS Code-family flavor, `<globalStorage>/saoudrizwan.claude-dev/state/taskHistory.json` exists and is readable. Flavors are checked in a fixed order and detection short-circuits on the first hit. ENOENT (or any other access failure) on a given flavor's file simply advances to the next flavor; if every flavor misses, the extension is reported not installed. There is no gate on any embedded-database runtime module — this source never touches SQLite.

MCP registration does **not** use this predicate. It asks a different question about Cline — whether the extension's MCP settings file is accessible — and asks it of **every** supported flavor without short-circuiting, because each flavor has its own independent MCP settings file. The two predicates can disagree in both directions, so "detected" here says nothing about whether Cline was registered as an MCP host; see spec 149.

### User-data directory (per flavor)

Identical to the VS Code-family layout used elsewhere in this product:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/<flavor>` |
| Linux | `~/.config/<flavor>` |
| Windows | `%APPDATA%/<flavor>` (fallback `~/AppData/Roaming/<flavor>`) |

Supported flavors: `Code`, `Code - Insiders`, `Cursor`, `VSCodium`, `Windsurf` — the same flavor set used by every other VS Code-family source in this product. Because `Cursor` is one of the scanned flavors, the Cline extension is detected and its sessions discovered even when it is installed inside the Cursor IDE rather than stock VS Code.

The globalStorage root for the extension, per flavor, is `<userDataRoot>/User/globalStorage/saoudrizwan.claude-dev`.

### Task-history file (per flavor, discovery source)

Path: `<globalStorage>/state/taskHistory.json`. A single JSON array, global to the flavor (not scoped to any one workspace/window). Each entry:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | The task/session id. Entries missing this (non-string) are skipped entirely. |
| `cwdOnTaskInitialization` | string | The absolute working directory the task was started in. Entries missing this (non-string) are skipped entirely. This is the sole project-attribution signal — there is no workspace-hash lookup. |
| `ts` | number | Milliseconds since epoch; used as both freshness signal and the session's `updatedAt`. An entry lacking a numeric `ts` is treated as stale (not fabricated as "now") and dropped. |
| `task` | string | Optional; trimmed and used as the discovered session's title when non-empty. |

### Per-task transcript file (read source)

Path: `<globalStorage>/tasks/<id>/api_conversation_history.json`. A JSON array of messages, each shaped as a raw replay of the underlying model-provider API conversation:

| Field | Type | Notes |
| --- | --- | --- |
| `role` | string | `"user"` or `"assistant"` (or other values, dropped). |
| `content` | string or array of blocks | A block has a `type` and, for `type: "text"`, a `text` string. Non-`"text"` block types (`thinking`, `tool_use`, `tool_result`, …) are never read. |
| `ts` | number | Optional; milliseconds since epoch. |

### Session-info record (output of discovery)

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | string | The task-history entry's `id`. |
| `transcriptPath` | string | `<globalStorage>/tasks/<id>/api_conversation_history.json`. |
| `updatedAt` | string | The task-history entry's `ts`, rendered as an ISO 8601 instant. |
| `source` | string | The literal source tag for the Cline extension (`"cline"`). |
| `title` | string, optional | The task-history entry's trimmed `task` field, when non-empty. |

### Cursor

| Field | Type | Notes |
| --- | --- | --- |
| `transcriptPath` | string | The per-task transcript file's absolute path. |
| `lineNumber` | int | Reused as a message-array index: count of messages already consumed. |
| `updatedAt` | string | The wall-clock instant the cursor was produced. |

### Normalized entry (output of read)

| Field | Type | Notes |
| --- | --- | --- |
| `role` | `"human"` or `"assistant"` | `"user"` → `"human"`, `"assistant"` → `"assistant"`; anything else is dropped. |
| `content` | string | For human turns: scaffolding stripped (see below). For assistant turns: raw joined text blocks, verbatim. |
| `timestamp` | string, optional | The message's `ts` rendered as ISO 8601, when `ts` is a number. |

### Discovery result (error channel)

Discovery returns a session list and an optional structured error with a `kind` of `"parse"` or `"fs"` and a `message`. `"schema"` and `"unknown"` are declared as possible kinds but are never produced by this discoverer — unreachable in the current implementation.

## Behavior

### Detection flow

1. For each supported flavor, in order, attempt to access `<globalStorage>/state/taskHistory.json`.
2. Return true on the first flavor where the access succeeds.
3. Return false if no flavor has the file.

### Discovery flow

1. Compute the staleness cutoff (now minus 48 hours) and the normalized target path (backslash-to-forward-slash, trailing-slash trim, lowercased on macOS/Windows, case-sensitive on Linux).
2. For each flavor's globalStorage directory (all flavors are scanned, not just the first hit):
   - Read and JSON-parse `state/taskHistory.json`.
   - A missing file (ENOENT) for this flavor contributes zero sessions and no error.
   - A parse failure or other read failure for this flavor is caught, logged, and classified: a malformed-JSON error becomes a `"parse"`-kind error, anything else becomes a `"fs"`-kind error. Only the *first* such error encountered across all flavors is retained; scanning continues into the remaining flavors regardless.
   - A successfully-parsed non-array value is treated as zero entries.
   - For each entry: skip if `id` or `cwdOnTaskInitialization` is not a string; skip if the normalized `cwdOnTaskInitialization` doesn't equal the normalized project directory; skip if `ts` is not a number or is older than the cutoff; otherwise emit a session-info record.
3. Concatenate the sessions found across all flavors.
4. The queue-facing wrapper strips the error channel, logging a warning if one was present, and always returns a plain session array.

### Transcript read flow

1. Read the entire per-task transcript file as JSON. On a read or parse failure, log an error and return an empty result that preserves the caller's cursor position unchanged (or index 0 if no cursor was supplied) rather than resetting it.
2. If the parsed value isn't an array, treat it as zero messages.
3. For each message, map its role and extract text:
   - Human turns: collect only `type: "text"` blocks (or the whole string, if `content` is a bare string), then reduce each block through the scaffolding-stripping rule below, drop any block that reduces to empty, and join the survivors with a blank line.
   - Assistant turns: collect only `type: "text"` blocks and join them with a blank line, verbatim — no stripping. (Native `tool_use`/`tool_result` blocks, present when the underlying model is Anthropic-family, are silently excluded by the "only `type: text`" filter; providers that instead emit XML-shaped tool markup as plain text keep that markup, since it looks like ordinary text to this reader.)
4. Starting from the cursor's message index (0 if none), walk forward:
   - If a wall-clock cutoff is in effect and the message's `ts` is a number greater than the cutoff, stop the walk without counting this message as consumed.
   - Otherwise count the message as consumed. If its mapped role is undefined or its extracted text is empty, produce no entry; otherwise emit `{ role, content, timestamp? }`.
5. Coalesce consecutive same-role entries (joining content with a blank line, keeping the earliest timestamp of the run).
6. Compute the new cursor: with a cutoff, the index just past the last consumed message; without one, the total message count.

### Scaffolding-stripping rule (human turns only)

Applied per collected text block, in order:

1. Remove every `<environment_details>…</environment_details>` span, then trim. If nothing remains, the block contributes nothing.
2. If what remains starts with the `# task_progress` boilerplate marker, or starts with a `[<tool-name…>] Result:` echoed-tool-output marker, the **entire block** is dropped — not just the matched portion.
3. Otherwise, if the remaining text contains a `<task>…</task>` span, the block's contribution is the (trimmed) content of the **first** such span, and everything else in the block is discarded.
4. Otherwise, if it contains a `<feedback>…</feedback>` span, the block's contribution is the (trimmed) content of the first such span.
5. Otherwise, the block's contribution is the environment-details-stripped, trimmed text as-is — this is the path for plain follow-up human text with no wrapper tags at all.

### Title resolution

The discovered session's `title` (task-history's `task` field) is the sole native-title source for this transcript source. If it is absent (no `task` field, or it trims to empty), the shared title-resolution fallback chain's per-line parser for this source is a no-op that always returns undefined regardless of its input line — meaning any Cline extension session discovered without a task-history title unconditionally displays as the generic untitled-session placeholder; there is no first-message-based recovery for this source in practice, even though the fallback chain nominally exists.

## State Transitions

Detection, discovery, and reading are all read-only with respect to Cline's on-disk state. The cursor's message index is monotonically non-decreasing across reads of the same task as long as Cline only appends to the per-task transcript file.

## Notable Behavior

- **No workspace-hash indirection.** Unlike the other VS-Code-family sources in this product (Cursor, Copilot Chat), which resolve the current project to a `workspaceStorage/<hash>` directory via `workspace.json` scanning, Cline's extension attributes sessions purely by comparing each task-history entry's own `cwdOnTaskInitialization` field to the project path. `workspace.json` is never read by this source.
- **Task history is global per flavor, not per-workspace**, and every flavor's file is scanned (not just the first flavor where the extension is detected) — a project opened once in stock VS Code and once inside the Cursor IDE surfaces sessions from both.
- **Detected across all VS Code-family flavors, including the Cursor IDE flavor**, since Cline is a normal VS Code extension and Cursor is VS Code-compatible; a user running Cline inside Cursor is indistinguishable, at the detection layer, from running it in stock VS Code.
- **An entry with no numeric `ts` is discarded as stale, not defaulted to "now"** — there is no fabricated freshness signal.
- **A malformed task-history file for one flavor does not abort the scan of the others**; only the first error encountered is retained and reported, but every flavor still contributes whatever sessions it validly has.
- **Assistant text is trusted verbatim**, including any provider-specific tool-call markup embedded as plain text; only genuine non-text content blocks (native tool_use/tool_result, thinking) are excluded.
- **Dropping an entire scaffolding block on a boilerplate/tool-result-echo match, rather than trying to salvage trailing content**, is a deliberate all-or-nothing rule — a block is either pure noise or pure signal, never a mix requiring partial extraction beyond the environment-details strip.
- **Only the first `<task>` or `<feedback>` span in a block is honored** — a non-global match, so a message with multiple such spans (not observed in practice) would silently lose all but the first.
- **The per-line title fallback for this source is a permanent no-op** — every session lacking a native task-history title falls through the entire fallback chain to the generic placeholder, unlike sources (e.g. Claude) with a real per-line parser.
- **`"schema"` and `"unknown"` scan-error kinds are declared but unreachable** for this source; only `"parse"` (malformed JSON) and `"fs"` (any other read failure) are ever actually constructed.
- **No embedded-database gate applies to this source at all** — it is plain JSON file I/O throughout, so unlike Cursor, OpenCode, or Copilot CLI, there is no runtime-capability check that can report it as "not installed" independent of the file actually existing.

## Shared Behavior

- **Staleness limit of two days** is shared across every discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source }`) matches every other discovery-based source.
- **Source tag of `"cline"`** is the literal value shared with downstream session persistence; distinct from the Cline CLI's `"cline-cli"` tag.
- **Cross-platform user-data directory resolution** (flavor-parameterized) is shared with Cursor and VS Code Copilot Chat through the same workspace-locator layer, though this source uses only the directory-resolution half of that layer, not its workspace-hash lookup.
- **Canonical normalized entry shape** (`{ role: "human"|"assistant", content, timestamp? }`) matches every other source reader.
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` matches every other source reader; `lineNumber` is reused as a message-array index.
- **Same-role coalescing** (join with a blank line, keep earliest timestamp) is the same primitive used by every other source reader.
- **Time-cutoff filter** matches every other source reader: cutoff stops consumption, cursor advances only past consumed records, untimed records are conservatively included (consumed).
- **The message-index cursor arithmetic, role mapping, and the empty-result-preserving-cursor behavior on an unreadable file are implemented in one primitive shared verbatim with the Cline CLI source** — the two sources differ only in how each gets from its raw file format to the shared normalized-message shape that primitive consumes.
