# 20 — Cursor Session and Transcript Reading

## Topic Statement

This spec defines how Cursor IDE sessions are detected, discovered for the current project, and read into the canonical normalized message form from a local embedded structured-data store, including the workspace-anchor mechanism that ensures the user's actively-open conversation is included even when its last update falls outside the staleness window.

## Scope

**In scope**

- Detecting Cursor IDE installation by the presence of its global state store.
- The cross-platform user-data directory layout for Cursor.
- The two relevant embedded structured-data stores: a global store holding all conversations, and per-workspace stores carrying pointers to the workspace's currently-focused conversations.
- The workspace-lookup step that maps the current project's absolute path to a workspace identifier by scanning per-workspace metadata.
- The anchor-extraction step that reads the per-workspace pointer arrays.
- The time-window scan over the global store.
- The union-and-dedupe step that merges anchors and time-window results.
- The synthetic transcript-locator scheme for per-session cursor keying.
- The transcript shape: a per-conversation header list of message references, and per-message blobs keyed in the same store.
- Mapping of the message-type integer to the canonical role tags.
- The cursor structure used for incremental resumption (indexed by message position).
- The optional time-cutoff filter that lets a queue-driven caller attribute records to a specific commit boundary.

**Out of scope**

- Multi-root workspaces (single-folder workspaces only).
- The downstream LLM call that consumes the assembled context.
- Multi-session merging policy (handled by a shared context-assembly layer).
- The runtime feature gate beyond noting that, like every other embedded-store source, Cursor reports as not installed on runtimes that lack the embedded-database support.

## Data Contracts

### Detection

Cursor is considered installed when the runtime supports the embedded-database module and Cursor's global state file exists and is a regular file. Either condition failing reports Cursor as not installed.

This predicate governs discovery, the status tree, and this spec's "not installed" reporting only. MCP registration asks a **distinct, presence-only** question about Cursor — the same global-state-file check without the runtime gate — so Cursor can be reported "not installed" here in the same run in which it is registered as an MCP host. See spec 149.

### User-data directory

The Cursor user-data root is platform-specific, identical in shape to a VS Code-family install:

| Platform | Path                                             |
| -------- | ------------------------------------------------ |
| macOS    | `~/Library/Application Support/Cursor`           |
| Linux    | `~/.config/Cursor`                               |
| Windows  | `%APPDATA%/Cursor` (fallback `~/AppData/Roaming/Cursor`) |

### Embedded stores

| Store                          | Path                                                           | Tables read                                                        | Notes                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Global state                    | `<userDataRoot>/User/globalStorage/state.vscdb`                | `cursorDiskKV` (key, value)                                        | All conversation data lives here, keyed by string. Two key families: composer-data records and per-message bubble records.       |
| Per-workspace state             | `<userDataRoot>/User/workspaceStorage/<workspaceHash>/state.vscdb` | `ItemTable` (key, value)                                           | One file per workspace. Carries a row whose key identifies the per-workspace composer pointer set.                               |

### Workspace metadata file

Each `<workspaceHash>` directory contains a `workspace.json` that describes which folder the workspace is anchored to. The reader consumes the `folder` field, which is a `file://` URI pointing at the project directory. Multi-root workspaces (with a `workspace` field instead) are silently skipped.

### Composer-data record (global store)

Keys of the form `composerData:<composerId>` carry a JSON value with at least:

| Field                            | Type    | Notes                                                                                                          |
| -------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `composerId`                     | string  | The conversation's identifier.                                                                                 |
| `lastUpdatedAt`                  | number  | Milliseconds since the Unix epoch. Non-finite values are skipped.                                              |
| `fullConversationHeadersOnly`    | array   | Ordered list of message references; each carries a `bubbleId` and may carry a `type` integer.                  |

### Bubble record (global store)

Keys of the form `bubbleId:<composerId>:<bubbleId>` carry a JSON value with at least:

| Field        | Type   | Notes                                                                                          |
| ------------ | ------ | ---------------------------------------------------------------------------------------------- |
| `type`       | int    | `1` for human turns, `2` for assistant turns; other values are dropped.                        |
| `text`       | string | The conversation text.                                                                         |
| `createdAt`  | string | Optional ISO 8601 instant.                                                                     |

### Workspace pointer record (per-workspace store)

The per-workspace `ItemTable` row whose key is the composer-data row carries a JSON value with two arrays:

| Field                       | Type            | Notes                                                                              |
| --------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `lastFocusedComposerIds`    | array of string | Composers most-recently focused in this workspace.                                 |
| `selectedComposerIds`       | array of string | Composers currently selected in this workspace.                                    |

The reader unions and dedupes these two arrays to form the workspace anchor set.

### Session-info record (output of discovery)

| Field            | Type    | Notes                                                                                          |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `sessionId`      | string  | The composer id.                                                                               |
| `transcriptPath` | string  | A synthetic locator: the global store's absolute path, a `#` separator, and the composer id.   |
| `updatedAt`      | string  | The composer-data `lastUpdatedAt` rendered as an ISO 8601 instant.                             |
| `source`         | string  | The literal source tag for Cursor.                                                             |

### Cursor (the persistence one, not the IDE)

| Field            | Type   | Notes                                                                                  |
| ---------------- | ------ | -------------------------------------------------------------------------------------- |
| `transcriptPath` | string | The synthetic locator.                                                                 |
| `lineNumber`     | int    | Reused as a bubble index: count of conversation messages already consumed.             |
| `updatedAt`      | string | The wall-clock instant the cursor was produced.                                        |

### Normalized entry (output of read)

| Field       | Type                       | Notes                                                              |
| ----------- | -------------------------- | ------------------------------------------------------------------ |
| `role`      | `"human"` or `"assistant"` | Mapping is bubble.type `1` → `"human"`, `2` → `"assistant"`.       |
| `content`   | string                     | Trimmed text from the bubble.                                      |
| `timestamp` | string or absent           | The bubble's `createdAt` if present.                               |

## Behavior

### Workspace lookup

1. Iterate the per-flavor `workspaceStorage` root, listing each `<workspaceHash>` directory.
2. For each, read `workspace.json` and extract the `folder` URI.
3. Convert the URI to a filesystem path (URIs not starting with `file://` are skipped; unparseable URIs are skipped with a warning).
4. Normalize for matching: convert backslashes to forward slashes, trim trailing slashes, and lowercase on case-insensitive platforms (macOS, Windows). Linux compares case-sensitively.
5. Compare against the project directory normalized the same way. Stop at the first match and return that workspace hash.
6. Return null if no workspace.json points at the project. The discovery result is then an empty list with no error (it is normal for a project never opened in Cursor not to have a workspace).

### Anchor extraction

1. Resolve the per-workspace state path: `<workspaceStorage>/<workspaceHash>/state.vscdb`.
2. If absent, return an empty anchor list (a workspace-level miss does not abort discovery).
3. Open read-only, query the `ItemTable` row whose key is the composer-data record, parse its JSON value, and union the two pointer arrays after filtering each to strings only.
4. On any failure, return an empty anchor list with a warning log; discovery continues with time-window-only results.

### Time-window scan

1. Pre-flight `stat` the global state path. Missing → empty result with no error. Other failures → classified scan error.
2. Open the global state read-only.
3. Compute the staleness cutoff (now minus the staleness limit).
4. Query all rows whose key matches `composerData:%`.
5. For each row, parse the JSON. Reject rows with a non-string `composerId` or a non-finite `lastUpdatedAt`. (For non-finite timestamps, only emit a warning when the composer is in the anchor set; for non-anchor composers, silently skip.)
6. Compute `inAnchor = anchorSet.has(composerId)` and `inWindow = lastUpdatedAt >= cutoff`.
7. **Union step**: include the composer if `inAnchor || inWindow`. Anchors are always included even when out-of-window.
8. **Dedupe step**: each composer id appears once.
9. Emit a session-info record per surviving composer.

### Discovery scan-error surface

Like the OpenCode discoverer, the result carries an optional structured error. ENOENT on the global store is silent. Other failures (corruption, lock, permission, schema, unknown) are classified and surfaced.

### Transcript read flow

1. Parse the synthetic locator into the global store path and composer id.
2. Open the store read-only.
3. Read the composer-data record. If absent, raise with the composer id in the message.
4. Read `fullConversationHeadersOnly` (treat absent as empty).
5. Skip the first `cursor.lineNumber` headers.
6. For each remaining header in order:
    - Read the bubble record by `bubbleId:<composerId>:<bubbleId>`. If missing, advance past it without producing an entry.
    - Apply the time cutoff: if the bubble's `createdAt` is parseable and strictly after the cutoff, stop the loop without consuming this header.
    - Determine the role from the bubble's `type` (or, if absent, from the header's `type`). Map `1` to `"human"` and `2` to `"assistant"`. Any other value drops the bubble.
    - Trim the bubble's `text`. If empty, advance past the header without producing an entry.
    - Emit `{ role, content, timestamp: createdAt }`.
7. Coalesce consecutive same-role entries.
8. Compute the new cursor.

### Cursor advancement

- **Without a time cutoff**: the new cursor is the total number of headers in the conversation at read time.
- **With a time cutoff**: the new cursor is the index just past the last consumed header.

### Time-window filter and out-of-window anchors

The combined effect is:

- A composer that hasn't been touched in two days but is the user's currently-focused conversation in this workspace is still discovered.
- A composer last updated within two days but never associated with this workspace is also discovered (because the time window is global, not workspace-scoped).
- This is intentional: it covers the common cases where Cursor focuses an old session and where the user briefly opens a different project in the same Cursor instance.

## State Transitions

Discovery and reading are read-only with respect to all stores. The cursor's `lineNumber` is monotonically non-decreasing across reads of the same conversation as long as Cursor only appends messages.

## Notable Behavior

- **There is no authoritative "this conversation belongs to this workspace" pointer in the global store**: the global store carries every conversation; workspace attribution comes only from the per-workspace pointer arrays plus the time window.
- **Workspace lookup is path-keyed**, not id-keyed: the project's absolute path is resolved to a workspace hash by scanning each workspace's `workspace.json`. The hash is opaque to the rest of the system.
- **Per-platform path normalization** mirrors the VS Code convention: backslashes → forward slashes, trailing slashes trimmed, lowercased on macOS and Windows. Linux is case-sensitive.
- **The pointer arrays are unioned, not preferred**: lastFocused and selected together form the anchor set; either origin is enough to anchor a composer.
- **Anchor composers ride past the staleness window**: the union with the time-window scan ensures the user's actively-open conversation isn't excluded just because it hasn't received a new message recently.
- **Bubble.type is the role authority, falling back to header.type**: bubble JSON carries the canonical type, but the headers list also has it; if the bubble is missing the field, the header's value is used.
- **Bubbles missing from the store advance the index without producing an entry**: a rare race, treated as a no-op rather than an error.
- **The synthetic locator follows the same `<dbPath>#<sessionId>` pattern** as OpenCode and Copilot CLI, so the cursor and reader contracts are uniform across embedded-store sources.
- **Workspace.json with `workspace` instead of `folder` is silently skipped**: multi-root workspaces (`.code-workspace` files) are out of scope.
- **Bad URIs are warned but not fatal**: an unparseable URI logs a warning and the scanner continues.
- **The trailing-slash trim uses a linear loop** rather than a regex, to avoid a polynomial-redos warning on JSON-loaded paths.
- **A workspace-level read failure does not abort discovery**: an empty anchor set falls back to time-window-only results.

## Shared Behavior

- **Staleness limit of two days** is shared across every discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source }`) matches every other discovery-based source.
- **Source tag of `"cursor"`** is the literal value shared with downstream session persistence.
- **Synthetic transcript-locator scheme** (`<storeRoot>#<sessionId>`) is shared with the OpenCode and Copilot CLI sources.
- **Cross-platform user-data directory resolution** is shared with VS Code Copilot Chat through a common workspace-locator layer; only the flavor name differs.
- **Workspace lookup, path normalization, and folder-URI parsing** are shared with VS Code Copilot Chat through the same layer.
- **Canonical normalized entry shape** (`{ role: "human"|"assistant", content, timestamp? }`) matches every other source reader.
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` matches every other source reader; `lineNumber` is reused as a bubble index.
- **Same-role coalescing** is applied with the same semantics as every other source reader.
- **Time-cutoff filter** matches every other source reader: cutoff stops consumption, cursor advances only past consumed records, untimed records are conservatively included.
- **Embedded-database scan-error classification** is shared with OpenCode and Copilot CLI through a common helpers layer.
- **Runtime feature-gate behavior** matches OpenCode: a runtime that lacks embedded-database support reports Cursor as not installed and is silent.
