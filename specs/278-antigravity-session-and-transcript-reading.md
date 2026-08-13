# 278. Antigravity Conversation Discovery and Transcript Reading

## Topic Statement

This spec defines how conversations from Antigravity (Google's Gemini-powered agentic IDE/CLI) are detected, discovered for the current project, and read into the canonical normalized message form, including the workspace-path-recovery mechanism that reads a small per-conversation encrypted database only to extract one plaintext field, and the discovery-time optimizations that keep repeated scans cheap.

## Scope

**In scope**
- Antigravity's three interface variants and their shared on-disk layout.
- Installation detection, gated by the same runtime embedded-database feature check used by other embedded-store sources.
- The per-conversation database's role: recovering only the workspace path from an otherwise-encrypted blob, via a length-prefixed byte scan rather than full protobuf decoding.
- The plaintext sibling transcript file that carries the actual conversation content.
- Repo/workspace scoping, including cross-worktree attribution.
- The discovery-time optimizations: cheap file-stat staleness gate before opening the database, skip-reopen when a newer variant of the same conversation was already accepted, and streaming early-exit title extraction.
- Cross-variant de-duplication of a conversation that exists under more than one interface variant.
- Plaintext transcript line-type-to-role mapping, including the request-envelope unwrapping and tool-call summarization.
- The per-session tool-call tally built from the same tool-call array the summaries are rendered from, and the per-bucket instant taken from the line's own creation time.
- The cursor structure for incremental resumption and the optional time-cutoff filter.
- Title resolution for a discovered session.

**Out of scope**
- The encrypted per-conversation blobs and the separate VS Code shell layer — neither is read by this source.
- The runtime feature-gate mechanics themselves beyond noting the shared gate (covered by a shared SQLite-helpers spec).
- The downstream LLM call that consumes assembled context.
- Multi-session merging policy.
- Config enablement, status/telemetry rendering, installer wiring, and aggregator fan-out (owned elsewhere).

## Data Contracts

### Interface variants and on-disk layout

Antigravity ships three interface variants sharing an identical layout, all rooted at `~/.gemini/<variant>/`:

| Variant | Description |
| --- | --- |
| `antigravity` | The 2.0 app |
| `antigravity-ide` | The IDE |
| `antigravity-cli` | The CLI |

For a variant to be considered present, its `~/.gemini/<variant>/conversations/` directory must exist. A variant root that exists without a `conversations/` subdirectory is not counted.

Per-variant resolved paths:

| Path | Purpose |
| --- | --- |
| `~/.gemini/<variant>/conversations/<convId>.db` | Per-conversation SQLite database (WAL mode). Encrypted agent data; only a `trajectory_metadata_blob` row is read, and only to recover a workspace path. |
| `~/.gemini/<variant>/brain/<convId>/.system_generated/logs/transcript_full.jsonl` | Plaintext, line-oriented conversation transcript. |

### Installation detection

Antigravity is considered installed only when both:
1. The runtime supports the built-in embedded-database module (the same major.minor version check shared with other embedded-store sources), and
2. At least one variant's `conversations/` directory contains a file ending in `.db`.

On a runtime that lacks the embedded-database module, an informational log records the runtime's version and the reported node-version requirement, and installation is reported false without touching the filesystem for `.db` files.

This predicate governs discovery, the status tree, and this spec's "not installed" reporting only. MCP registration asks a **distinct, presence-only** question about Antigravity — it drops the runtime gate and also accepts a bare variant root with no `conversations/` directory at all — so Antigravity can be reported "not installed" here in the same run in which it is registered as an MCP host. See spec 149; that looser variant rule belongs to it, not to this spec.

### Workspace-path recovery (`trajectory_metadata_blob`)

The per-conversation database is queried for a single row: the `data` column of the `trajectory_metadata_blob` row whose id is the main record. The row's `data` is a protobuf-shaped binary blob. Rather than decode the full protobuf schema, the workspace path is recovered by a targeted byte scan:

1. Find the first occurrence of the literal byte sequence `file://` in the blob (treating it as a byte/latin1 string, not requiring valid UTF-8 elsewhere in the blob).
2. If not found, or found at the very start of the buffer (no length-prefix byte preceding it), recovery fails and the conversation is treated as unmatched.
3. Otherwise, walk backward from the byte before the match, treating each byte as part of a protobuf varint (continuation bit set) until a byte without the continuation bit is reached. Decode the accumulated bytes as a length varint.
4. If the decoded length is shorter than the length of `"file://"`, or the value would run past the end of the buffer, recovery fails.
5. Slice out exactly `length` bytes starting at the match as UTF-8 — this is the field's exact value, robust even when a subsequent field's tag byte happens to be a printable character that a naive "scan to next control byte" approach would run past.
6. The value must start with `file://`; otherwise recovery fails.
7. The remainder after the `file://` prefix is percent-decoded; if the escape sequences are malformed, the raw (un-decoded) slice is kept instead of failing.
8. If the resulting path matches the Windows-URI shape (a leading slash immediately before a drive letter and colon, `file:///C:/…`), the leading slash is stripped so the value reads as a native Windows path (`C:/…`). POSIX paths are left untouched.

The recovered value is the workspace path used for repo-scoping. No other field of the blob (git remote, branch, or the protobuf's outer structure) is read.

### Repo/workspace scoping

A conversation is attributed to the current project when its recovered workspace path is attributed — by the shared session-directory attribution rule (see below) — to **any** member of a set of candidate roots: the project directory itself, plus every worktree root of the same repository (as reported by listing the repo's worktrees). The set is walked in enumeration order and the first root that attributes the path wins; no further roots are consulted.

The set-based match (rather than testing the project directory alone) exists because the IDE may be opened against a different checkout (e.g. the primary worktree) than the one where a commit and its hook run (e.g. a linked feature worktree); matching against every worktree root keeps the conversation attributed to the same repo regardless of which worktree the hook runs from. If listing worktrees fails (git unavailable, or the directory is not inside a repo), the candidate set degrades to the project directory alone — the attribution rule itself is unchanged, so containment still applies against that single root.

The candidate roots are kept as raw on-disk paths rather than pre-normalized, because the attribution rule's exclusion walk must address real directories; the rule performs its own separator and case folding internally.

### Session-info record (output of discovery)

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | string | The conversation id (the `.db` filename without its extension). |
| `transcriptPath` | string | Absolute path to the sibling plaintext transcript file. |
| `updatedAt` | string | The conversation database file's modification time, rendered as an ISO 8601 instant. |
| `source` | string | The literal source tag for Antigravity. |
| `title` | string or absent | The first user-input line's unwrapped request text (see Title resolution), truncated to 120 code points with an ellipsis if longer; absent if none could be read. |

### Discovery result (with error channel)

Discovery returns a session list and an optional structured error (kind: corruption, lock, permission, schema, or unknown, plus a message). A missing conversations directory, or a database that vanishes between being listed and opened, is not an error — it silently yields no session for that entry. Only the first genuine (non-missing) scan failure encountered across the whole scan is retained and returned.

### Cursor

| Field | Type | Notes |
| --- | --- | --- |
| `transcriptPath` | string | The plaintext transcript's absolute path. |
| `lineNumber` | int | Count of transcript lines already consumed on prior reads (0-based line index into the filtered, non-blank line array). |
| `updatedAt` | string | The timestamp of the last line consumed, or the wall-clock instant if no timestamped line was consumed. |

### Plaintext transcript line shape

Each line of the transcript is one JSON object with (at least): a step index, a `type`, a `created_at` (an ISO 8601 UTC instant), and usually `content` (a string). Some planner-response lines additionally carry `tool_calls`, an array of `{ name, args }` objects where `args` may carry a command line and/or a tool summary string.

### Normalized entry (output of read)

| Field | Type | Notes |
| --- | --- | --- |
| `role` | `"human"` or `"assistant"` | See line-type mapping below. |
| `content` | string | See per-type content construction below. |
| `timestamp` | string or absent | The line's `created_at`, when present. |

### Line-type → role/content mapping

| Line type | Role | Content |
| --- | --- | --- |
| user-input | human | The content string, unwrapped from a user-request envelope if present (see Envelope unwrapping); the whole trimmed string is used if the envelope tags are absent. Empty result after unwrapping is dropped. |
| planner-response | assistant | The content string, followed by one line per tool-call entry rendered as a summary (see Tool-call summarization); empty parts are filtered out and the remainder is newline-joined. If nothing survives, no entry is emitted. |
| run-command | assistant | The content string verbatim, only if non-empty. |
| checkpoint, conversation-history, generic, system-message, list-directory, view-file, and any other type | — | Skipped; no entry emitted. Generic carries only workspace-access banners; tool-invocation rows are already represented by the tool-call summaries on the planner-response that spawned them. |

### Envelope unwrapping

User input arrives wrapped as a user-request envelope (plus optional sibling metadata tags that are not part of the match and are effectively dropped). If the user-request tags are found, the whitespace-trimmed inner text is used; otherwise the whole trimmed input string is used. This unwrapping is shared between the transcript reader (per-turn content) and the discoverer's title extraction (first user turn).

### Tool-call summarization

Each tool call renders as `↪ <name>` optionally followed by `: <detail>`, where `<detail>` is the tool call's command-line argument if it is a string, else its tool-summary argument if that is a string, else empty (in which case the summary is just `↪ <name>` with no trailing colon/detail). The name falls back to the literal `tool` if absent.

### Per-session tool-call tally (output of read)

The same tool-call array the summaries above are rendered from also feeds a per-session tally, reported alongside the entries and the cursor and **always present even when empty** — an empty tally is the recorded fact "this session called no tools", which a consumer must be able to tell apart from a source that records nothing at all. Each bucket carries a display name, a classification, a call count, and optionally the instant of its most recent observed call.

Two properties are forced by what this transcript records:

- **Every call is classified as a built-in one, and none can be de-duplicated.** A tool-call entry carries a name and its arguments — no call identity, no naming prefix, no server field — so there is nothing to split into an external-server bucket and nothing to compare two occurrences on.
- **Every occurrence is counted, not de-duplicated by name.** That is correct rather than merely tolerable: the transcript is append-only and each step appears once, so a repeated planner-response line is not a shape this source produces.

The per-bucket instant is the line's own creation time, parsed to an epoch instant. A line with no creation time, or one that does not parse, contributes a bucket with no instant.

## Behavior

### Feature gate

Detection and discovery both check the runtime embedded-database support before touching any database file, identical to the shared gate used by other embedded-store sources (major.minor version comparison against the runtime's declared minimum, not a live module load, so it never triggers the runtime's experimental-feature warning by itself).

### Variant enumeration

The three fixed variant names are scanned in a fixed order (`antigravity`, `antigravity-ide`, `antigravity-cli`) against a given home directory, returning only those whose `conversations/` subdirectory exists, each with its resolved root, conversations directory, and brain directory.

### Discovery flow

1. Skip entirely (return an empty result) if the runtime lacks embedded-database support.
2. Resolve the set of worktree-normalized roots for the current project directory (project directory itself, plus every worktree root of its repo if resolvable).
3. Compute the staleness cutoff: now minus 48 hours.
4. For each present variant, in variant-enumeration order:
   a. List the variant's conversations directory, filtering to files ending in `.db`. A listing failure for one variant is logged and that variant is skipped; the scan continues with the remaining variants.
   b. For each `.db` file (conversation id = filename without extension):
      - **Staleness pre-check**: `stat` the database file. If `stat` fails, skip this entry (do not open the database). If the file's modification time is older than the 48-hour cutoff, skip this entry without opening the database.
      - **Skip-if-already-newer**: if a conversation with the same id was already accepted from an earlier variant in this same scan pass with a modification time at or after this entry's, skip this entry without opening the database (this covers a conversation id migrated between variants; the newest copy wins and older duplicates never pay the open cost).
      - Open the database read-only, query the metadata blob, and attempt workspace-path recovery on its data column if the row exists.
      - A genuine (non-missing) open/query failure is classified; the first such classified failure across the whole scan is retained as the result's error. The scan continues past the failing entry regardless.
      - If no workspace path was recovered, or the shared session-directory attribution rule (below) attributes the recovered path to none of the resolved candidate roots, skip this entry.
      - Compute the expected sibling transcript path. If it does not exist on disk yet, skip this entry (a matched conversation whose transcript has not materialized is not yet ready to surface) and log at debug level.
      - Record/replace this conversation id's entry (transcript path + modification time) in the accumulating map, keyed by conversation id.
5. For each surviving conversation id (one entry per id, regardless of how many variants matched it), read its title (see Title resolution) and emit a session-info record.
6. Return the accumulated session list, plus the first classified error encountered (if any). A backward-compatible wrapper discards the error channel and returns only the session array.

### Session-directory attribution (shared rule, restated in full)

This is the shared attribution predicate every hookless, directory-scoped source applies; spec 253 is its canonical statement. Antigravity applies it once per candidate root, against the recovered workspace path, accepting on the first root that attributes it. Each individual application evaluates in this order, first rule wins:

1. **Absent directory.** A missing, empty, or otherwise falsy workspace path is rejected before any path handling runs; recovery failure therefore degrades to "unattributed" rather than faulting the scan.
2. **Containment.** Both paths are normalized — backslashes folded to forward slashes, trailing separators stripped, and the result lowercased **only** on case-insensitive host platforms (Windows and macOS; Linux compares case-sensitively). The workspace path is attributed to this root only when its normalized form either equals the normalized root, or begins with it followed by a single separator. The required separator is the boundary guarantee: a sibling directory whose name merely starts with the root's name (root `…/repo` vs candidate `…/repo2`) does not match.
3. **Exact match.** When the two normalize equal, the path is attributed immediately and the exclusion walk below is deliberately skipped — a candidate root is itself a repository or worktree root and carries its own marker, so inspecting it would reject every conversation.
4. **Exclusion walk for a strict subdirectory.** Walk upward one parent at a time from the workspace path, stopping when the current directory normalizes equal to the root. At each visited directory — **including the workspace path itself, excluding the root** — check whether it holds its own `.git` entry. If any does, the path is **not** attributed to this root. One existence check covers all three exclusion cases and they are deliberately not distinguished: a nested clone carries a `.git` directory, a submodule and a linked worktree each carry a `.git` file. No entry-type inspection, no repository is opened, no version-control subprocess is run.
5. **Missing intermediate directory.** A visited directory that no longer exists simply reports "no marker here" and the walk continues, so a workspace path that has since been deleted is **kept** (best-effort).
6. **Loop guard (unreachable).** The walk also stops on reaching a directory that is its own parent. Containment already guaranteed the root is an ancestor, so this is structurally unreachable; it exists only to make an infinite loop impossible.

No symbolic links are resolved anywhere in the rule: both the comparison and the walk operate on the literal path strings.

Interaction with the multi-root candidate set worth noting: because a linked worktree's own root carries a `.git` file, a workspace path sitting inside a linked worktree is **rejected** by the walk when tested against the enclosing worktree's root — but that same linked worktree's root is itself a member of the candidate set, so the path is attributed there instead. The two rules compose to "attributed to the repo exactly once, through the innermost matching worktree root."

### Cross-variant de-duplication

The same conversation id can exist under more than one variant (a user who migrated between variants retains the id). The accumulating map is keyed by conversation id; when the same id is seen again, the copy with the strictly newer database modification time replaces the existing one, and the at-or-after skip check avoids re-opening the database for a variant that is provably not newer than one already accepted. The final session list therefore contains at most one entry per conversation id, sourced from whichever variant's copy was most recently touched.

### Title resolution

For each conversation that survives scoping and de-duplication, the transcript is streamed line-by-line (not loaded whole) looking for the first line whose type is user-input and whose content is a string. That content is unwrapped (see Envelope unwrapping) and, if non-empty, truncated to 120 characters with a trailing ellipsis if longer, and used as the session's title. The stream and its underlying file descriptor are always closed once a title is found, the file ends, or an error occurs; an error other than "file not found" is logged at debug level. If no qualifying line is found or the read fails, the session has no title, and downstream title resolution falls back to reading the first human turn from the full transcript.

### Transcript read flow

1. Read the whole transcript file. If the read fails for any reason (including file not found), return an empty entry list with the cursor unchanged from the input (or line 0 / current wall-clock time if no cursor was supplied) and zero lines read. This never raises.
2. Split into lines, discarding blank/whitespace-only lines.
3. Start at the cursor's line number (0 if no cursor).
4. Compute the time cutoff from the optional `beforeTimestamp` if supplied, else unbounded.
5. Walk lines from the start index to the end:
   - Parse each line as JSON; a parse failure skips that line and continues (does not abort the read).
   - If the line has a `created_at` and its parsed instant is at or after the cutoff, stop the loop without consuming this line — it will be re-read on the next call. (A line without `created_at` is always consumed, since — by the transcript's append-only, chronological ordering — it necessarily precedes the stopping point.)
   - Otherwise, if `created_at` is present, remember it as the running "last timestamp".
   - Apply the line-type mapping to conditionally append a normalized entry. For a planner-response line, walk its tool-call array **before** rendering the summaries and count each named call into the tally, stamping the line's own creation time (parsed to an epoch instant) as that bucket's most-recent-call time when it parses.
6. After the loop, coalesce consecutive same-role entries (shared merge behavior with every other source reader).
7. Compute the new cursor: line number is the index of the first unconsumed line (either past the end, or the stopping line under a cutoff); the timestamp is the last consumed line's timestamp, or the incoming cursor's timestamp (or current wall-clock time) if no line carried a timestamp.
8. Return the coalesced entries, the new cursor, the count of lines consumed this pass, and the tool-call tally.

### Cursor advancement

- **Without a time cutoff**: the loop runs to the end of the file; the new cursor's line number is the total non-blank line count.
- **With a time cutoff**: the loop stops at the first line at/after the cutoff; the new cursor's line number is that stopping line's index, so it is re-considered (not skipped) on the next call.

## State Transitions

Discovery and reading are read-only with respect to both the database and the transcript file. The cursor's line number is monotonically non-decreasing across reads of the same transcript as long as Antigravity only appends lines. The transcript-read function itself never throws — a missing or unreadable file degrades to an empty read result rather than propagating an error, which differs from some other embedded-store readers (e.g. Cursor, OpenCode) that raise on a genuine read failure.

## Notable Behavior

- **The database is read only to recover one string field.** No other content — including the git remote and branch fields that the same blob's byte layout otherwise carries — is read; all conversation content comes from the plaintext sibling file.
- **Workspace-path recovery is a targeted byte scan, not a protobuf decode.** It exploits the fixed tag/length-varint/bytes shape of a protobuf string field to read exactly the field's byte length, which is robust against a later field's tag byte happening to be a printable character (e.g. `:`) that a "scan until control byte" heuristic would run past.
- **Windows drive-letter URIs get their spurious leading slash stripped** (`file:///C:/…` → `C:/…`) so the recovered path matches a native path once normalized; POSIX paths are untouched.
- **Malformed percent-escapes fall back to the raw slice** rather than failing recovery outright.
- **Worktree-aware scoping.** Unlike a source that only tests the literal project directory, this discoverer tests every worktree root of the repo, because the IDE frequently sits on a different checkout than the one running the git hook. The set is walked in order and short-circuits on the first root that attributes the path.
- **Attribution per root is containment, not exact equality.** A workspace path recorded in a subdirectory of a worktree root is attributed to that root; under the previous exact-equality set-membership test every such conversation was silently dropped.
- **A nested repository or submodule inside a worktree is excluded.** Containment alone would attribute such a workspace to both the inner context and the enclosing worktree; the intervening-marker walk makes the inner context its sole owner.
- **Three staleness/cost-avoidance optimizations, in order of cheapness**: a file-stat gate before any database open; a same-scan "already accepted a newer copy of this id" skip before opening the database for a later-enumerated variant; and a streaming, early-exit title read that never loads a full multi-MB transcript just to extract its title.
- **De-duplication keeps the newest copy across variants**, using at-or-after (not strictly-after) on modification time so a same-or-earlier duplicate is never reopened.
- **A matched conversation without a materialized transcript yet is silently excluded** (not an error) — the sibling file may not exist yet if the conversation is still very new.
- **The transcript reader never throws.** Every failure mode (missing file, malformed JSON, unreadable path) degrades to an empty result with the cursor held at its input position, unlike other embedded-store readers that raise on genuine failure.
- **Unparseable individual JSON lines are skipped, not fatal** to the rest of the read.
- **A line without `created_at` is always consumed even under a time cutoff**, on the assumption (append-only, chronological file) that it necessarily precedes any later timestamped stopping point.
- **The tool calls this spec previously treated only as text to summarise are also counted.** The same array that renders the `↪ <name>` lines feeds a per-session tally, and each bucket carries the planner-response line's own creation time as its most-recent-call instant. Nothing about the summaries changed; the tally is a second consumer of an array that was already parsed. (Notable; the tally was undocumented here until the per-bucket instant made it load-bearing.)
- **This source's tally can neither classify an external-server call nor de-duplicate one.** A tool-call entry carries a name and arguments only — no call identity, no naming prefix, no server field — so every call is a built-in and every occurrence counts. Counting every occurrence is correct here rather than merely tolerable, because the transcript is append-only and each step appears exactly once. (Notable.)
- **This source's own title path truncates to 120 code points**, but the shared title resolver re-truncates a native title to the shared 60-code-point limit, so the effective displayed title length is 60.

## Shared Behavior

- **Staleness limit of 48 hours** is shared across every discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source, title? }`) matches every other discovery-based source.
- **Source tag `"antigravity"`** is the literal value shared with downstream session persistence, title-resolution dispatch, and human-readable labeling ("Antigravity").
- **Canonical normalized entry shape** (`{ role: "human"|"assistant", content, timestamp? }`) matches every other source reader.
- **The per-session tool-call tally and its always-present-even-when-empty contract** are the shared tally behaviour every tool-recording source reader applies; this source contributes only built-in, un-de-duplicable buckets, and takes each bucket's instant from the line's own creation time.
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` matches every other line-oriented source reader.
- **Same-role coalescing** is applied with the same semantics as every other source reader.
- **Time-cutoff filter** matches every other source reader: cutoff stops consumption before the stopping line, the cursor advances only past consumed lines, and untimed lines are conservatively consumed.
- **Runtime feature-gate behavior (embedded-database support check)** is shared with OpenCode, Cursor, and Copilot CLI: a runtime lacking the built-in module reports the source as not installed and scans return empty rather than raising.
- **Discovery scan-error classification** (corruption, lock, permission, schema, unknown) is shared with the other embedded-store sources via a common helpers layer; a missing file is uniformly treated as "not present," never a reportable error.
- **Native-title pre-population** (so the shared title resolver's first-priority branch is satisfied without a per-source line parser) follows the same pattern as OpenCode, Cursor, Copilot, Devin, Cline, and Cursor CLI — the shared resolver's per-source line-parser table maps Antigravity to a no-op parser.
- **Session-directory attribution** uses the shared predicate restated above and owned canonically by **spec 253** — containment with a nested-repository / submodule / linked-worktree exclusion walk. This source is the only adopter that applies it against a *set* of roots rather than a single project directory. The identical per-root rule is applied by the Codex (spec 18), OpenCode (spec 19), GitHub Copilot CLI (spec 21), and Devin CLI (spec 277) sources. Adoption is not universal: several other hookless directory-scoped sources still match on exact-path equality (see spec 253's adoption note).
