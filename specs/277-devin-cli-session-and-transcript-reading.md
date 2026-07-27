# 277. Devin CLI Session Discovery and Main-Chain Transcript Reading

## Topic Statement

This spec defines how Devin CLI sessions are discovered for the current project and how one session's message forest is reconstructed into the canonical linear conversation, from a single global embedded structured-data store shared by every project on the machine.

## Scope

**In scope**

- The on-disk location of Devin's global session store, including per-OS resolution rules.
- The runtime feature gate: discovery and reading require an embedded-database module provided by the runtime; if the runtime cannot provide it, Devin is silently skipped.
- The relevant tables and columns at a structural level.
- The installation check.
- The discovery query: which sessions fall within the staleness window and are not hidden (both enforced in the query), and which belong to the current project (enforced after retrieval, by the shared session-directory attribution rule applied to the primary working directory and to each entry of an auxiliary list of additional working directories).
- The shared session-directory attribution rule — containment plus a nested-repository / submodule / linked-worktree exclusion walk — and the fact that it cannot be expressed in the store query.
- The message-forest model and the main-chain reconstruction (root-to-tip walk, with a fallback tip-selection rule when the recorded tip is missing or absent).
- Message extraction: role mapping, content filtering, and which fields are read from the message payload.
- The cursor structure used for incremental resumption, including its anchor-based resume semantics (distinct from a plain positional index) and legacy fallback.
- The optional time-cutoff filter that lets a queue-driven caller attribute records to a specific commit boundary.
- The synthetic transcript-locator scheme that allows multiple sessions sharing one database file to each get their own cursor key.
- Title resolution: the session title comes from discovery, not from per-line transcript parsing.
- A bundling/runtime note: the source is silently absent on a runtime that lacks the embedded-database module.

**Out of scope**

- Per-message streaming / live-tailing.
- The embedded-database failure-classification layer beyond noting that scan errors are surfaced (shared SQLite-helpers layer, already covered elsewhere).
- The downstream LLM call that consumes the assembled context.
- Multi-session merging policy (context-assembly layer).
- Config/enable wiring and aggregator-level status reporting (owned elsewhere).

## Data Contracts

### Storage location

Devin stores all CLI sessions, across every project, in a single embedded structured-data store file named `sessions.db`, located under a per-OS data directory:

| Platform | Path |
| --- | --- |
| macOS / Linux | `<XDG_DATA_HOME>/devin/cli/sessions.db`, or `~/.local/share/devin/cli/sessions.db` when the XDG variable is unset (macOS does **not** use an Application Support path here) |
| Windows | `%APPDATA%\devin\cli\sessions.db` (Roaming), or `~/AppData/Roaming/devin/cli/sessions.db` when `APPDATA` is unset. Windows does not consult the XDG variable. |

The home directory used for the fallback forms is resolved via the runtime's home-directory lookup, not an environment variable, since the environment may be minimal in a detached background process.

### Tables and columns (relevant subset)

| Table | Columns the reader uses | Notes |
| --- | --- | --- |
| `sessions` | `id`, `title`, `last_activity_at`, `working_directory`, `workspace_dirs`, `hidden`, `main_chain_id` | One row per session. `last_activity_at` is integer **epoch seconds** (not milliseconds). `working_directory` is the primary working directory the session was started in. `workspace_dirs` is a JSON array of additional attached working-directory path strings, or null. `hidden` is a 0/1 flag. `main_chain_id` is the node id of the tip of the currently-accepted conversation chain, or null. |
| `message_nodes` | `session_id`, `node_id`, `parent_node_id`, `chat_message` | Zero or more rows per session, forming a **forest**: every node but a root has exactly one `parent_node_id`, and a node may have multiple children (alternate regenerations are sibling children of the same parent). `chat_message` is a JSON blob (see below). |

### Chat-message payload (`message_nodes.chat_message`)

| Field | Type | Notes |
| --- | --- | --- |
| `role` | string | One of `"system"`, `"user"`, `"assistant"`, `"tool"` (only `"user"` and `"assistant"` are mapped to output; the rest are dropped). |
| `content` | string | The turn's text. An assistant turn that is purely a tool call carries an empty string here. |
| `metadata.created_at` | string | ISO 8601 instant. Absent or unparsable renders as no timestamp. |

Other fields the live payload may carry (tool-call detail, thinking, telemetry, extension data) are not read.

### Session-info record (output of discovery)

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | string | The session row's `id`. |
| `transcriptPath` | string | A synthetic locator: the database file's absolute path, a `#` separator, and the session id. |
| `updatedAt` | string | The session row's `last_activity_at` (epoch seconds), rendered as an ISO 8601 instant. |
| `source` | string | The literal source tag for Devin. |
| `title` | string or absent | The session row's `title`, when it is a non-empty, non-whitespace-only string; otherwise absent. |

### Cursor

| Field | Type | Notes |
| --- | --- | --- |
| `transcriptPath` | string | The synthetic locator (matches the session-info shape). |
| `lineNumber` | int | Legacy/positional field: reused as a main-chain node index. Without a time cutoff, set to the total chain length; with a cutoff, set to the index just past the last node consumed. |
| `anchorId` | string, optional | The `node_id` (as a string) of the last main-chain node actually consumed on this read. Preferred over `lineNumber` for resuming, when present. |
| `updatedAt` | string | The wall-clock instant the cursor was produced. |

### Normalized entry (output)

| Field | Type | Notes |
| --- | --- | --- |
| `role` | `"human"` or `"assistant"` | Devin `"user"` maps to `"human"`; `"assistant"` is preserved; `"system"` and `"tool"` are dropped. |
| `content` | string | Trimmed `content` of the message payload; empty content is dropped. |
| `timestamp` | string or absent | The node's `metadata.created_at`, verbatim (not reformatted), when present as a string. |

### Discovery result (with error channel)

Discovery returns a session list and an optional error record carrying a kind (corruption, lock, permission, schema, or unknown) and a message. A missing database file is not an error — it surfaces as an empty list with no error.

## Behavior

### Feature gate

Devin discovery and reading require a runtime-built-in embedded-database module. The check compares the runtime's major/minor version against the minimum that ships the module — it is not a live load, so it never triggers the module's experimental-feature warning by itself.

- **Runtime supports the module** → proceed.
- **Runtime does not support it** → installation reports Devin as not present; discovery returns an empty result with no error, silently (this is distinguished internally from a genuine scan failure). An informational log records that Devin support is disabled on this runtime.

### Installation check

Devin is considered installed only when both:
1. The runtime supports the embedded-database module, and
2. The session database file exists at the resolved path and is a regular file (a directory at that path does not count).

### Discovery flow

1. Resolve the database path per the per-OS rule above.
2. If the runtime lacks the embedded-database module, return an empty result immediately, silently.
3. Pre-flight `stat` the database file. Missing (ENOENT) → empty result, no error. Any other stat failure → classify and surface as a discovery error.
4. Open the database read-only.
5. Compute the staleness cutoff: now minus 48 hours, converted to epoch seconds (matching the column's unit).
6. Issue a single query: select `id`, `title`, `last_activity_at`, `working_directory`, `workspace_dirs` from `sessions` where `hidden = 0` and `last_activity_at` is strictly greater than the cutoff. The query carries **no directory predicate and no ordering clause**:
   - The directory predicate cannot live in the query, because attribution is no longer a string comparison — it requires a filesystem walk (see "Session-directory attribution" below). The query therefore returns every in-window, non-hidden session for every project on the machine, and the directory columns are filtered afterwards.
   - Because every row that survives the filters is kept regardless of position, the previous `last_activity_at` descending ordering was dropped as buying nothing. **The result set is unordered.**
7. For each row, determine directory membership by applying the shared session-directory attribution rule (below) against the target project directory, in this order:
   - The row's `working_directory`, when it is a string — attributed on success, **or**
   - failing that, each entry in the row's parsed `workspace_dirs` array in turn, accepting on the first entry the rule attributes.
   - `workspace_dirs` is tolerantly parsed: a null/empty value, malformed JSON, a non-array JSON value, or non-string array entries all yield no additional directories rather than throwing or aborting the row.
8. Rows failing the directory check are dropped. Of the rest, rows whose `last_activity_at` is not a finite number are dropped with a warning (schema-drift defense).
9. Emit a session-info record per surviving row, with `title` collapsed to absent when it is empty or whitespace-only.
10. Close the connection. A failure while querying that indicates the database vanished between the pre-flight stat and the open is treated as "not installed" (empty result, no error); any other failure is classified and returned as a discovery error.

### Session-directory attribution (shared rule, restated in full)

This is the shared attribution predicate every hookless, directory-scoped source applies; spec 253 is its canonical statement. Devin applies it up to `1 + N` times per row — once against `working_directory`, then once per parsed `workspace_dirs` entry until one attributes. Each individual application evaluates in this order, first rule wins:

1. **Absent directory.** A missing, empty, or otherwise falsy directory value is rejected before any path handling runs. This gate is load-bearing here: the predicate is mapped across every row of a machine-global store, and both `working_directory` and `workspace_dirs` are nullable — such a value must skip that one candidate rather than fault and lose the whole scan.
2. **Containment.** Both paths are normalized — backslashes folded to forward slashes, trailing separators stripped, and the result lowercased **only** on case-insensitive host platforms (Windows and macOS; Linux compares case-sensitively). The candidate is attributed only when the normalized directory either equals the normalized project directory, or begins with it followed by a single separator. The required separator is the boundary guarantee: a sibling directory whose name merely starts with the project directory's name (root `…/repo` vs candidate `…/repo2`) does not match.
3. **Exact match.** When the two normalize equal, the candidate is attributed immediately and the exclusion walk below is deliberately skipped — the project root is itself a repository root and carries its own marker, so inspecting it would reject every session.
4. **Exclusion walk for a strict subdirectory.** Walk upward one parent at a time from the candidate directory, stopping when the current directory normalizes equal to the project directory. At each visited directory — **including the candidate directory, excluding the project directory** — check whether it holds its own `.git` entry. If any does, the candidate is **not** attributed. One existence check covers all three exclusion cases and they are deliberately not distinguished: a nested clone carries a `.git` directory, a submodule and a linked worktree each carry a `.git` file. No entry-type inspection, no repository is opened, no version-control subprocess is run.
5. **Missing intermediate directory.** A visited directory that no longer exists simply reports "no marker here" and the walk continues, so a candidate whose directory has since been deleted is **kept** (best-effort).
6. **Loop guard (unreachable).** The walk also stops on reaching a directory that is its own parent. Containment already guaranteed the project directory is an ancestor, so this is structurally unreachable; it exists only to make an infinite loop impossible.

No symbolic links are resolved anywhere in the rule: both the comparison and the walk operate on the literal path strings.

### Transcript read flow (main-chain reconstruction)

1. Parse the synthetic transcript locator into the database path and session id.
2. Open the database read-only.
3. Look up the session row's `main_chain_id`. If the session id is not found at all, raise.
4. Load every `message_nodes` row for the session into memory, indexed by `node_id`.
5. **Tip selection**: if `main_chain_id` is null, or does not correspond to any loaded node for this session, fall back to a computed tip (see below). Otherwise use `main_chain_id` as the tip.
6. **Fallback tip selection** (used when the recorded tip is unusable): identify every node that is nobody's parent (a leaf). Among the leaves — or, if the forest is fully cyclic and has no leaves, among all nodes — pick the one with the greatest parseable `metadata.created_at`; a node whose payload is unparsable JSON or lacks a timestamp ranks lowest. Ties (including when no candidate has a parseable timestamp) break on the greater `node_id`. This deliberately avoids picking by greatest `node_id` alone, since the highest id in a forest can belong to a discarded regeneration sibling rather than the accepted chain's actual tip.
7. **Chain walk**: starting at the tip, follow `parent_node_id` pointers upward, collecting nodes, until a pointer is null, points at a node not present in this session (dangling), or would revisit an already-visited node (cycle guard — the walk simply stops rather than looping forever). Reverse the collected list into root-to-tip (chronological) order.
8. **Resolve the start index** from the incoming cursor:
   - No cursor → start at index 0.
   - Cursor carries `anchorId` → locate that node id in the freshly-built chain. If found, resume just after it. If not found (a regeneration behind the cursor re-pointed the chain and dropped that node), restart from index 0 — this deliberately re-emits the surviving portion of the chain rather than skipping past nodes that no longer exist, so regenerated content is not silently lost.
   - Cursor carries no `anchorId` (legacy shape) → resume at `min(cursor.lineNumber, chain.length)`, a plain positional index.
9. Slice the chain from the resolved start index onward and, for each node in order:
   - If the node's `chat_message` fails to parse as JSON, skip it (advancing the consumed-index counter) and continue.
   - If a `beforeTimestamp` cutoff is supplied and the node has a parseable `metadata.created_at` strictly after the cutoff, stop the walk without consuming this node (it is left for a future read). A node with no timestamp, or an unparsable one, does not stop the walk — it is conservatively kept.
   - Map `role` via `user → human`, `assistant → assistant`; any other role (including missing) is unmapped and the node is dropped.
   - Trim `content`; an empty result (including when `content` is absent) drops the node.
   - A node surviving both checks emits `{ role, content, timestamp }`.
10. Coalesce consecutive same-role entries in the surviving output.
11. Compute the new cursor:
    - `anchorId`: the `node_id` of the last node actually consumed this read (as a string); if nothing new was consumed, carry the incoming cursor's `anchorId` forward unchanged.
    - `lineNumber`: without a `beforeTimestamp` cutoff, the full chain length; with a cutoff, the index just past the last consumed node.
12. On any failure during the above, wrap the error with a message naming the session id, preserving the original error's `code` property (if any) so callers can distinguish a vanished-database condition from a genuine corruption.

### Title resolution

The session title is populated entirely by discovery (from the `sessions.title` column) and carried on the session-info record; the transcript reader performs no per-line or per-message title extraction for Devin.

## State Transitions

Discovery and reading are read-only with respect to the database. Because the underlying data is a forest rather than an append-only log, the reconstructed chain for a given session is **not guaranteed monotonic**: a regeneration can change which nodes belong to the accepted chain between two reads of the same session, which is why resumption prefers the content-anchored cursor (`anchorId`) over a raw positional index — the positional index alone cannot detect that the referenced position no longer holds the same content.

## Notable Behavior

- **The forest, not a flat log, is the underlying structure.** Alternate regenerations of a turn are sibling nodes sharing a parent; only the accepted chain (walked from the tip) is ever surfaced.
- **Anchor-based resume detects and recovers from regeneration.** If a regeneration invalidates the previously-consumed anchor node, the next read restarts from the beginning of the (new) chain rather than slicing past content that no longer exists — this is the mechanism that prevents a regenerated turn from being silently dropped.
- **A legacy cursor with no `anchorId` still works**, falling back to the plain positional index, clamped to the chain's current length.
- **Fallback tip selection favors recency over node id.** When `main_chain_id` is null or dangling, the reader picks the most-recently-created leaf, not the highest `node_id` — a discarded regeneration sibling can have a higher id than the accepted tip.
- **Directory scoping supports an auxiliary directory list.** A session started from an attached workspace/worktree can be attributed to the project purely through `workspace_dirs`, even when `working_directory` points elsewhere. Both fields go through the identical attribution rule.
- **Directory matching is containment, not exact equality.** A session started in a subdirectory of the project — e.g. a monorepo package folder — is attributed to the project, and no longer needs that subdirectory separately listed in `workspace_dirs` to be found. This replaced an exact-path-equality match that silently dropped every such session; earlier revisions of this spec described that behavior as a known intentional gap, and that statement is **no longer true**.
- **A nested repository, submodule, or linked worktree inside the project is excluded.** Containment alone would attribute such a session to both the inner context and the enclosing one; the intervening-marker walk makes the inner context its sole owner. The same session is attributed normally when the question is asked about that inner root instead.
- **The discovery query is unordered.** Its `last_activity_at` descending ordering was dropped when the directory predicate moved out of the query, because every surviving row is kept regardless of position. Callers must not assume the most-recently-active session appears first.
- **`working_directory`/`workspace_dirs` matching is normalized** (separator folding, trailing-slash trim, case folding on Windows/macOS only) to tolerate how Devin persists paths across platforms.
- **A null directory value is an expected input, not an error.** Both directory fields are nullable, so the attribution rule's falsy gate runs before any path handling; a fault there would drop every session in the scan rather than one candidate.
- **`last_activity_at` is epoch seconds** and must not be conflated with other sources' millisecond conventions.
- **Malformed `workspace_dirs` never sinks the whole row or scan** — it degrades to "no additional directories," not an error.
- **A cyclic `parent_node_id` graph cannot hang the reader** — the walk's visited-set guard stops it deterministically.
- **System and tool-role nodes are always dropped**, including a tool-call-only assistant turn recorded with empty `content`, which is separately dropped by the empty-content check.
- **Blank/whitespace-only titles collapse to absent**, not an empty string, at discovery time.

## Shared Behavior

- **Staleness limit of 48 hours** is shared across every discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source, title? }`) matches every other discovery-based source.
- **Source tag `"devin"`** is the literal value shared with downstream session persistence.
- **Synthetic transcript-locator scheme** (`<dbPath>#<sessionId>`, parsed by splitting on the *last* `#`) is shared with OpenCode, Cursor, and Copilot CLI.
- **Canonical normalized entry shape** (`{ role: "human"|"assistant", content, timestamp? }`) matches every other source reader.
- **Same-role coalescing** is applied with the same semantics as every other source reader.
- **Time-cutoff filter** matches every other source reader: cutoff stops consumption without consuming the boundary node, cursor advances only past consumed records, untimed/unparsable-timestamp records are conservatively included rather than excluded.
- **Runtime feature-gate behavior** matches OpenCode and Cursor: a runtime lacking the embedded-database module reports the source as not installed and stays silent, via the same shared feature-gate and error-classification helpers.
- **Working-directory-based attribution** uses the shared session-directory attribution predicate restated above and owned canonically by **spec 253** — containment with a nested-repository / submodule / linked-worktree exclusion walk — extended here by applying it to the additional `workspace_dirs` list as well. The identical rule is applied by the Codex (spec 18), OpenCode (spec 19), GitHub Copilot CLI (spec 21), and Antigravity (spec 278) sources. Adoption is not universal: several other hookless directory-scoped sources still match on exact-path equality (see spec 253's adoption note).
- **Post-retrieval directory filtering with an unordered result set** is shared with the OpenCode and Copilot CLI sources: all three moved their directory predicate out of the store query when attribution became a filesystem walk, and all three dropped their ordering clause at the same time.
