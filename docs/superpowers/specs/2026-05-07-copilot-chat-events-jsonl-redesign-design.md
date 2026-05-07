# VS Code Copilot Chat Redesign — Read `events.jsonl`, Not OpenTelemetry Traces

**Date:** 2026-05-07
**Status:** Approved for implementation
**Branch:** `feature-support-copilot`
**Supersedes:** [`2026-05-06-copilot-chat-support-design.md`](./2026-05-06-copilot-chat-support-design.md)
**Precedent:** [`2026-05-05-copilot-cli-support-design.md`](./2026-05-05-copilot-cli-support-design.md) (sibling source — kept untouched by this redesign)

## Background

The 2026-05-06 design shipped a `copilot-chat` source that scanned VS Code workspaceStorage for chat session JSONL files. After deploying it and committing on a real machine, the Summary Detail panel's *Manage All Conversations* modal showed **zero `copilot-chat` sessions**, while the status panel correctly reported "4 active sessions" (live discovery worked).

Hands-on filesystem audit on the user's machine (macOS 14, 2026-05-07; mtimes spanning Jan – May 2026 across many wsHash entries) shows the original design's `<wsHash>/chatSessions/<sid>.jsonl` target really is a live conversation store — the original reader's *path* was correct but its *format* (OpenTelemetry trace fallback at `debug-logs/<sid>/main.jsonl`) was not, and a separate, parallel store was missed entirely. The full picture:

1. **`<wsHash>/GitHub.copilot-chat/debug-logs/<sid>/main.jsonl` is OpenTelemetry trace data, not conversation content.** Each line is a span event (`type:"session_start"`, `spanId`, `dur`, `attrs.copilotVersion`) with no `role` / `content` field. The original reader correctly returned zero entries from these files. **Unconditionally discarded** — never contained conversational data; the previous design's use of it as a "v2 fallback" was the bug.
2. **`<wsHash>/chatSessions/<sid>.jsonl` is the active VS Code Chat panel store.** Written by the built-in Chat panel across all modes (Ask / Edit / Agent). Verified live as of May 6 2026 (a 76 MB session file dated within 24 hours of audit, mode `agent`, sid present in `chat.ChatSessionStore.index`). Format: `kind:0` init document followed by `kind:1` (set at JSON path) and `kind:2` (delete at path) patches; replaying yields a final document whose `requests[]` array contains the conversation. **Read via a patch replayer.**
3. **`~/.copilot/session-state/<sid>/events.jsonl` is the active Copilot CLI Agent backend store.** Written by the Copilot CLI agent process whether invoked from the standalone `copilot` terminal or from VS Code's embedded "GitHub Copilot CLI Agent" chat session type (the `copilotcli:/...` sids in `ChatSessionStore.index`). Per-session event log; direct verification: parsing `dab1bc55-…/events.jsonl` reproduced exact prompts visible in VS Code's chat panel. **Read via event-stream parser.**
4. **`<wsHash>/chatSessions/<sid>.json` is a deprecated single-document snapshot format.** All observed instances are from Jan 2026; no `.json` file with mtime in the last four months exists in any wsHash on the audited machine. Will not be read by the new design (the 48h freshness window would exclude all observed files anyway). Documented for completeness; revisit if a user reports historical-import needs.

Stores 2 and 3 are **parallel active formats** corresponding to **different chat entry points** — not a version-evolution sequence. A user who alternates between the VS Code Chat panel and the Copilot CLI within the same workspace produces files in both stores concurrently. Both must be read to give that user a complete `copilot-chat` view.

### Entry-point mapping (verified 2026-05-07 by hands-on test)

The VS Code chat panel "+" dropdown menu items have non-obvious storage routing — verified by creating one session through each menu item and tracing where it landed:

| Menu item | UI looks like | Underlying mechanism | Persists to | sid prefix in `ChatSessionStore.index` | Reader needed |
|---|---|---|---|---|---|
| **"New Copilot CLI Session"** | Terminal-style banner ("GitHub Copilot v…", "Describe a task to get started") | Spawns a VS Code integrated terminal running the `copilot` binary | `~/.copilot/session-store.db` (sessions + turns) **and** `~/.copilot/session-state/<sid>/events.jsonl` with `vscode.metadata.json: {origin:"other"}` (no `folderPath`) | not indexed (terminal session, not a chat) | **None** — already covered by existing `copilot` source via the SQLite db |
| **"New Chat" / "New Chat Editor" / "New Chat Window"** with copilotcli-backend model selected | Standard chat bubbles | Routes to Copilot CLI agent backend over IPC; no terminal | `~/.copilot/session-state/<sid>/events.jsonl` only — **NOT** in `session-store.db` — `vscode.metadata.json: {origin:"vscode", workspaceFolder.folderPath:"<cwd>"}` | `copilotcli:/<sid>` | **Scan A** — `events.jsonl` reader, gated by `folderPath === cwd` |
| **"New Chat" / "New Chat Editor" / "New Chat Window"** with non-copilotcli model selected | Standard chat bubbles | Routes to OpenAI/Anthropic API directly | `<wsHash>/chatSessions/<sid>.jsonl` patch log | varies by model vendor | **Scan B** — patch-log reader |

**The naming is misleading.** "New Copilot CLI Session" creates a terminal, not a chat session — its content is already captured by the existing `copilot` source. The work in this redesign covers the *other* three menu items, which actually use the chat panel UI.

**The single rule "non-empty `folderPath`" cleanly separates Scan A from the existing `copilot` source:** terminal-spawned `copilot` sessions write `events.jsonl` with `origin:"other"` and **no** `folderPath` field, so Scan A skips them. Chat-panel `copilotcli`-backend sessions write `origin:"vscode"` with `folderPath` set, so Scan A picks them up. Verified with five concurrent sessions on the audited machine spanning all three menu items.

This redesign extends the discoverer to scan **both** active locations (`~/.copilot/session-state/` and `<wsHash>/chatSessions/*.jsonl`) and dispatches to one of two reader implementations based on path. The standalone `copilot` source (which reads `~/.copilot/session-store.db` via `CopilotSessionDiscoverer`) is **out of scope**: it was already shipping correct data on the same commits that produced empty `copilot-chat` results, so its discovery path is independently verified working.

## Goals

- Make new commits' stored transcripts include real `copilot-chat` sessions whether the user chatted via the **VS Code Chat panel** (Ask / Edit / Agent modes — written to `<wsHash>/chatSessions/<sid>.jsonl`) or via **Copilot CLI Agent** sessions (written to `~/.copilot/session-state/<sid>/events.jsonl`), or both.
- Reuse the existing `TranscriptSource` value `"copilot-chat"`, the `copilotEnabled` config flag, the QueueWorker integration points, and the Summary Modal rendering — only the discoverer/reader/detector internals change.
- Distinguish VS Code-embedded CLI Agent sessions from `~/.copilot/session-state/` directories that are standalone-CLI side-state, using the presence of a non-empty `vscode.metadata.json.workspaceFolder.folderPath` matching the project directory.
- Maintain the cli workspace's coverage gate (≥97% statements/lines).
- Keep test fixtures grounded in **real captured content** for both active formats, not hand-written approximations — directly addressing the failure mode that produced the previous design.

## Non-goals

- **No backfill of pre-existing stored transcripts.** Stored transcripts on the orphan branch are immutable per the QueueWorker model; old commits stay as-is. Users see correct data starting from the next non-squash commit after deploying this change.
- **No change to `CopilotSessionDiscoverer` / `CopilotTranscriptReader` (the `copilot` CLI standalone source).** It continues to read `~/.copilot/session-store.db` via `node:sqlite`. The `copilotEnabled` flag remains the single user-facing toggle for both Chat and CLI.
- **No deduplication between `copilot` and `copilot-chat`.** A session that appears in both `session-store.db` (with non-null `cwd`) and `session-state/<sid>/vscode.metadata.json` (with non-empty `folderPath`) would be emitted twice with different `source` values. Not observed in practice; treating the corner case adds plumbing for marginal benefit.
- **No use of `<wsHash>/state.vscdb` `chat.ChatSessionStore.index`.** The index contains metadata only (title, timing, settings); message bodies are not in the SQLite store. Pulling the index in would add a SQLite read with no body-fidelity gain.
- **No support for non-VS-Code-flavor hosts (Insiders, Code-OSS, Cursor's Copilot mode).** The session backend in `~/.copilot/session-state/` is shared across hosts, but `vscode.metadata.json` is written only by VS Code Stable; other hosts may use different metadata file names. Revisit on first user report.
- **No reading of `<wsHash>/chatSessions/<sid>.json`** (the deprecated single-document snapshot format). All observed instances on the audited machine have mtimes in Jan 2026 — already four months past the 48h freshness window. Adding a third reader for an apparently dead format would burn complexity and test surface for zero observable benefit.
- **No write access to any chat-related file.** All access is read-only.
- **No removal of the `VscodeWorkspaceLocator` module.** It still serves the Cursor integration and is reused here for the `<wsHash>/chatSessions/` path resolution.

## Observed Reality

Verified hands-on on 2026-05-07, macOS 14, VS Code Stable 1.118.1, GitHub Copilot extension 0.46.2. Two parallel active stores serving different chat entry points; one deprecated store noted for completeness:

### On-disk layout

**Store A — Copilot CLI Agent backend:** `~/.copilot/session-state/<sid>/events.jsonl`

```
~/.copilot/                                    # Copilot CLI agent backend root
├── session-store.db                           # SQLite (WAL) — used by `copilot` source only
├── session-store.db-wal                       # ← ~140 KB live data; `copilot` reader uses node:sqlite
├── session-store.db-shm
├── config.json                                # not used here
├── command-history-state.json                 # not used here
├── ide/<uuid>.lock                            # IDE bridge handshake — not used
├── logs/                                      # not used
├── vscode.session.metadata.cache.json         # not used (per-host cache, not session content)
└── session-state/                             # ← READ THIS
    └── <sessionId>/                           # one directory per session, sid = UUIDv4
        ├── events.jsonl                       # ← READ THIS — append-only event log (conversation lives here)
        ├── vscode.metadata.json               # ← READ THIS — VS Code attribution: workspaceFolder.folderPath
        ├── vscode.requests.metadata.json      # not used
        ├── workspace.yaml                     # not used (mirror of session-store.db sessions row when CLI-created)
        ├── checkpoints/                       # not used
        ├── files/                             # not used
        └── research/                          # not used
```

**Store B — VS Code built-in Chat panel:** `<userDataDir>/User/workspaceStorage/<wsHash>/chatSessions/<sid>.jsonl`

```
~/Library/Application Support/Code/User/workspaceStorage/<wsHash>/
├── workspace.json                             # {"folder":"file:///abs/path"} — used to locate wsHash for current cwd
├── chatSessions/                              # ← READ THIS — VS Code Chat panel (Ask/Edit/Agent modes)
│   ├── <uuid>.jsonl                           # ← READ THIS — active patch log format (verified live as of May 6 2026)
│   └── <uuid>.json                            # deprecated single-document snapshot — last write Jan 2026, NOT read
├── GitHub.copilot-chat/debug-logs/            # OpenTelemetry traces — NOT conversation, ignored
└── state.vscdb                                # not used (chat.ChatSessionStore.index has metadata only)
```

The `<wsHash>` lookup uses the existing `findVscodeWorkspaceHash("Code", projectDir)` helper from `VscodeWorkspaceLocator`, which compares each `workspaceStorage/<entry>/workspace.json`'s `folder` URI against the current project directory. Multi-root `.code-workspace` entries (which use `workspace` instead of `folder`) are silently skipped, matching the Cursor source's behavior.

### Distinguishing VS Code chat from CLI standalone

A session directory `~/.copilot/session-state/<sid>/` may be created by either source:

| Created by | `vscode.metadata.json` | `workspaceFolder.folderPath` | Also in `session-store.db`? |
|---|---|---|---|
| **VS Code embedded "Copilot CLI Agent" chat session** | exists | non-empty absolute path | **no** (verified: 0 rows for the two embedded sessions on the audited machine) |
| **`copilot` terminal CLI** | usually exists, sometimes absent | empty string `""` or absent | **yes** (with `cwd`, `summary`, `turns`) |

**Heuristic**: `vscode.metadata.json` exists AND `workspaceFolder.folderPath` is a non-empty string equal to (after path normalization) the current project directory ⇒ this is a VS Code chat session and we own it. Otherwise skip — the `copilot` source already covers CLI standalone via `session-store.db`.

The single rule (*non-empty folderPath*) carries two responsibilities at once: (a) **gates inclusion** of VS Code-embedded sessions (which are absent from `session-store.db` and would otherwise be invisible), and (b) **prevents double-emit** of CLI standalone sessions (which are *also* present in `session-state/` but already surfaced by the `copilot` source via `session-store.db`).

Cross-tabulation on the audited machine (2026-05-07) confirms this is the only sound discriminator:

| sid (truncated) | `events.jsonl` size | `folderPath` | `session-store.db` row | `turns` rows | Surfaced by |
|---|---|---|---|---|---|
| `478eb16c` | 384 KB | `/Users/…/feature/change-…` (matches cwd) | 0 | 0 | **only events.jsonl** ⇒ `copilot-chat` |
| `dab1bc55` | 723 KB | `/Users/…/feature/change-…` (matches cwd) | 0 | 0 | **only events.jsonl** ⇒ `copilot-chat` |
| `6cb63aa5` | 131 KB | `""` | 1 | 2 | `session-store.db` ⇒ `copilot` |
| `70dceafd` | 105 KB | `""` | 1 | 2 | `session-store.db` ⇒ `copilot` |
| `9dfa138e` | 226 KB | `""` | 1 | 2 | `session-store.db` ⇒ `copilot` |
| `ef28e639` | 210 KB | `""` | 1 | 3 | `session-store.db` ⇒ `copilot` |
| `aa13c631` | (no `events.jsonl`) | (no `vscode.metadata.json`) | 1 | 0 | empty session, neither path emits |

The two sessions with non-empty `folderPath` (478eb16c, dab1bc55) are **invisible** to the existing `copilot` source — that's the bug the new `copilot-chat` reader fixes. The four with empty `folderPath` are **already covered** by the `copilot` source, and skipping them in the new reader is what avoids the duplication that would otherwise show two tabs per session in the Manage modal.

### `events.jsonl` schema

Each line is one JSON event. Top level:

```jsonc
{
  "type": "user.message",                     // ← drives interpretation
  "timestamp": "2026-05-06T16:47:24.077Z",    // ISO 8601, present on most events
  "id": "<uuid>",                             // event id
  "parentId": "<uuid>",                       // event causality (not used)
  "data": { /* shape depends on type */ }
}
```

Observed `type` values, with handling:

| `type` | Handling | `data` shape (relevant fields) |
|---|---|---|
| `session.start` | skip | `{sessionId, version, producer:"copilot-agent", copilotVersion, startTime, selectedModel, context.cwd, ...}` |
| `system.message` | skip | `{role:"system", content:"You are the GitHub Copilot CLI..."}` |
| **`user.message`** | **emit** `{role:"human", content: data.content, timestamp: o.timestamp}` | `{content:"<user prompt>", transformedContent:"<augmented prompt>"}` — we use `content`, not `transformedContent` |
| `assistant.turn_start` | skip | `{turnId, interactionId}` |
| **`assistant.message`** | **emit** if `data.content` is non-empty string: `{role:"assistant", content: data.content, timestamp: o.timestamp}` | `{messageId, content:"<assistant response>", toolRequests?:[...]}` — content-only message ⇒ keep; tool-only message (`content === ""`) ⇒ drop |
| `assistant.turn_end` | skip | `{turnId, ...}` |
| `tool.execution_start` | skip | tool call invocation |
| `tool.execution_complete` | skip | tool call result |
| `hook.start` / `hook.end` | skip | session lifecycle |
| `session.shutdown` / `session.resume` / `session.error` | skip | session lifecycle |
| (any other / unknown) | skip | future-proofing |

Distribution example (session `dab1bc55-…`, 331 lines): `session.start ×1, system.message ×6, user.message ×6, assistant.turn_start/end ×55, assistant.message ×54 (50 with content, 4 tool-only), tool.execution_start/complete ×66 ea, hook.start/end ×5 ea, session.shutdown ×6, session.resume ×5, session.error ×1` ⇒ 56 emitted entries (6 user + 50 assistant).

### Mid-write robustness (`events.jsonl`)

`events.jsonl` is appended to during a live chat. A reader observing it mid-write may see a truncated last line. Per-line `JSON.parse` failure is treated as **skip this line, continue**, the same way the existing Claude JSONL reader handles incomplete entries. The line cursor advances past the bad line so the next commit doesn't re-feed it.

This is more aggressive than the prior Copilot Chat reader's "any parse error ⇒ zero messages for the whole session" policy, and matches the ergonomics of every other JSONL-based reader in the codebase. The cost is occasionally losing one corrupted line; the benefit is never blocking an entire session over one bad write.

### Legacy patch-log schema (`chatSessions/<sid>.jsonl`)

Each line is a JSON event:

```jsonc
// kind 0 — initial document (always line 0)
{"kind":0,"v":{"version":3,"sessionId":"<uuid>","requests":[], /* ... */ }}

// kind 1 — set value at JSON path
{"kind":1,"k":["requests",0,"result"],"v":{ /* the new value at that path */ }}

// kind 2 — delete value at JSON path
{"kind":2,"k":["pendingRequests",0]}
```

Reconstructing the conversation requires **replaying patches in order**: start with `kind:0` `v` as the document, apply each `kind:1` as a set-at-path and each `kind:2` as a delete-at-path, in file order. The final document's `requests[]` array contains the conversation. Each `requests[i]` has shape:

```jsonc
{
  "message": { "text": "user prompt..." },          // user input
  "response": [ { "value": "..." }, /* ... */ ],    // streamed assistant output (post-stream merged by patches)
  "result": { "metadata": { "codeBlocks": [/* ... */] } },
  "timestamp": 1776416700000                         // milliseconds since epoch
}
```

Path semantics for the replayer:
- Numeric segment ⇒ array index (auto-grow with `null` slots if needed for `set`)
- String segment ⇒ object key
- `delete` on a missing path is a no-op (vscode emits these legitimately for already-cleaned `pendingRequests`)
- `set` with parents missing creates intermediate objects/arrays based on the **next** segment's type

**Mid-write policy for patch logs:** A truncated last line that fails `JSON.parse` invalidates everything after it (later patches assume earlier patches landed). The reader **stops at the first parse failure**, replays everything before it, and emits whatever `requests[]` is well-defined. The cursor does **not** advance past the bad line — next commit will retry once the writer completes the line.

### Legacy snapshot schema (`chatSessions/<sid>.json`)

Single JSON document, identical schema to a fully-replayed patch log's final state:

```jsonc
{
  "version": 3,
  "sessionId": "<uuid>",
  "lastMessageDate": 1735810185123,
  "requests": [ /* same shape as patch-log requests[i] above */ ],
  "inputState": { /* ... */ }
}
```

Read via `JSON.parse(fileContent)`. Same `requests[i]` extraction logic as patch log.

### Shared `requests[i] → entries` extraction (formats 2 & 3)

After replay/parse:
- For each `requests[i]` where `i > cursor`:
  - If `req.message?.text` is a non-empty string ⇒ emit `{role:"human", content: req.message.text, timestamp: req.timestamp ? new Date(req.timestamp).toISOString() : undefined}`
  - Flatten `req.response` into a single string (concat `.value` fields where the entry is `{value: string}`; ignore other shapes); if non-empty ⇒ emit `{role:"assistant", content: <flattened>, timestamp: req.timestamp ? ISO : undefined}`
- Cursor advances to `requests.length - 1` (last successfully processed request index).

### Time-window filter

Sessions whose `events.jsonl` mtime is older than `48h` are skipped at the discoverer layer. This matches `OpenCode` / `Cursor` / `Copilot CLI` conventions and keeps stored transcripts focused on recent activity. The 48h constant is shared as `SESSION_STALE_MS` in the discoverer file.

## Architecture

### Module map

```
cli/src/core/
├── CopilotChatDetector.ts                # MODIFIED — switch probe target
├── CopilotChatDetector.test.ts           # rewritten
├── CopilotChatSessionDiscoverer.ts       # REWRITTEN — read ~/.copilot/session-state/
├── CopilotChatSessionDiscoverer.test.ts  # rewritten
├── CopilotChatTranscriptReader.ts        # REWRITTEN — parse events.jsonl
└── CopilotChatTranscriptReader.test.ts   # rewritten

cli/src/hooks/
└── QueueWorker.ts                        # 1-line change: pass beforeTimestamp to readCopilotChatTranscript
```

The QueueWorker change is a single-line update at [line 1532](../../../cli/src/hooks/QueueWorker.ts#L1532): the existing `readCopilotChatTranscript(session.transcriptPath, cursor ?? undefined)` becomes `readCopilotChatTranscript(session.transcriptPath, cursor ?? undefined, beforeTimestamp)`. The discovery branch at lines 1455–1463 stays untouched (the new `discoverCopilotChatSessions` keeps the same name and signature).

**Untouched**:
- `cli/src/Types.ts` (`TranscriptSource` already includes `"copilot-chat"`)
- `cli/src/hooks/QueueWorker.ts` discovery block (lines 1455–1463) and the surrounding pipeline
- `cli/src/core/VscodeWorkspaceLocator.ts` (still used by Cursor integration)
- `cli/src/core/CopilotSessionDiscoverer.ts` and `CopilotTranscriptReader.ts` (the `copilot` CLI source)
- `cli/src/commands/StatusCommand.ts` (`counts.copilot + counts["copilot-chat"]` aggregation)
- `vscode/src/views/SummaryWebviewPanel.ts` (`getEnabledSources` returns `"copilot-chat"`)
- `vscode/src/views/SummaryScriptBuilder.ts` (`'Copilot Chat'` label)
- `vscode/src/providers/StatusTreeProvider.ts` (single-toggle UI)

### `CopilotChatDetector` (modified)

```typescript
export function getCopilotChatStorageDir(home?: string): string
//   <userDataDir>/User/globalStorage/github.copilot-chat (Copilot Chat extension)
//   PRESERVED — still used by the detector probe and existing test mocks.

export function getCopilotCliSessionStateDir(home?: string): string
//   path.join(home ?? os.homedir(), ".copilot", "session-state")
//   NEW — Copilot CLI agent backend root.

export async function isCopilotChatInstalled(): Promise<boolean>
//   true when EITHER probe path exists as directory
//   The discoverer handles per-cwd matching; the detector only answers the
//   "does this user have ANY Copilot Chat install?" question.
```

### `CopilotChatSessionDiscoverer` (rewritten)

```typescript
const SESSION_STALE_MS = 48 * 60 * 60 * 1000;

export interface CopilotChatScanResult {
    readonly sessions: ReadonlyArray<SessionInfo>;
    readonly error?: CopilotChatScanError;
}

export async function scanCopilotChatSessions(projectDir: string): Promise<CopilotChatScanResult>
export async function discoverCopilotChatSessions(projectDir: string): Promise<ReadonlyArray<SessionInfo>>
```

`scanCopilotChatSessions` runs **two scans in sequence** and concatenates results. Either scan may independently produce an `error`; the first error encountered is returned (subsequent are debug-logged), but partial sessions from the successful scan are still returned.

**Scan A — current format `~/.copilot/session-state/`:**

1. `root = ~/.copilot/session-state`. If `readdir(root)` throws `ENOENT` → empty. Other fs errors → set `error: { kind:"fs" }`, empty sessions.
2. `cutoff = Date.now() - SESSION_STALE_MS`.
3. For each entry `<sid>` in `readdir(root)`:
   1. `metaPath = <root>/<sid>/vscode.metadata.json`. `readFile + JSON.parse`. Failure ⇒ debug-log, skip.
   2. Read `meta.workspaceFolder.folderPath`. Missing, non-string, or empty string ⇒ skip.
   3. `normalizePathForMatch(folderPath) !== normalizePathForMatch(projectDir)` ⇒ skip.
   4. `transcriptPath = <root>/<sid>/events.jsonl`. `stat`. Failure ⇒ debug-log, skip.
   5. `mtimeMs < cutoff` ⇒ skip.
   6. Emit `{ sessionId: <sid>, transcriptPath, updatedAt: ISO(mtime), source: "copilot-chat" }`.

**Scan B — legacy formats `<wsHash>/chatSessions/<sid>.{jsonl,json}`:**

1. `wsHash = await findVscodeWorkspaceHash("Code", projectDir)`. `null` ⇒ skip Scan B (this cwd never had a VS Code session).
2. `sessionsDir = <wsStorageDir>/<wsHash>/chatSessions`. `readdir`. ENOENT ⇒ skip Scan B. Other fs errors ⇒ set `error` (only if Scan A didn't already set one), continue with what Scan A returned.
3. For each entry whose name ends with `.jsonl` (entries ending with `.json` are explicitly skipped — see Non-goals re. deprecated snapshot format):
   1. `transcriptPath = <sessionsDir>/<entry>`. `stat`. Failure ⇒ debug-log, skip.
   2. `mtimeMs < cutoff` ⇒ skip.
   3. `sessionId = entry.slice(0, -".jsonl".length)`.
   4. Emit `{ sessionId, transcriptPath, updatedAt: ISO(mtime), source: "copilot-chat" }`.

`discoverCopilotChatSessions` strips the error channel and `log.warn`s if present, matching the existing convention.

`normalizePathForMatch` is imported from `VscodeWorkspaceLocator.ts` — same case-folding and trailing-slash logic the Cursor source uses, ensuring mac-vs-linux behavior consistency across both VS Code-derived sources.

**Cross-format collisions are not deduplicated.** If a sid appears in both Scan A and Scan B (extremely unlikely — different sid namespaces in practice), both are emitted. Same rationale as the Non-goals section's "no copilot vs copilot-chat dedup": treating it adds plumbing for marginal benefit.

### `CopilotChatTranscriptReader` (rewritten — dispatcher + 3 sub-readers)

```typescript
export async function readCopilotChatTranscript(
    transcriptPath: string,
    cursor?: TranscriptCursor,
    beforeTimestamp?: string,
): Promise<TranscriptReadResult>
```

Signature matches the post-redesign QueueWorker call site (1-line update at [line 1532](../../../cli/src/hooks/QueueWorker.ts#L1532) noted in the Module map).

**Dispatch by path/extension:**

| Pattern | Sub-reader |
|---|---|
| `<...>/.copilot/session-state/<sid>/events.jsonl` | `readEventsJsonl` |
| `<...>/chatSessions/<sid>.jsonl` | `readPatchLog` |

The dispatcher matches on the trailing path segments of `transcriptPath`. Unrecognized pattern ⇒ throw — should never happen given the discoverer only ever emits one of the two.

**Cursor semantics:**

`TranscriptCursor.lineNumber` (existing field, no schema change) carries different meanings per sub-reader:
- `readEventsJsonl` → line number in events.jsonl (next read starts at `lineNumber + 1`)
- `readPatchLog` → last-emitted-`requests[]`-index + 1 (next read emits `requests[i]` for `i >= lineNumber`)

The two interpretations never mix because the cursor is keyed by `transcriptPath`, and each transcriptPath only ever maps to one sub-reader. Documented in code comments at the dispatcher.

#### Sub-reader: `readEventsJsonl(path, cursor, beforeTimestamp)`

1. `startLine = cursor?.lineNumber ?? 0`. Open via `readline.createInterface`.
2. Maintain `currentLine = 0`. For each line:
   1. `currentLine++`. If `currentLine <= startLine` ⇒ skip.
   2. `JSON.parse(line)`. On parse error ⇒ skip line, advance cursor (consistent with Claude reader).
   3. Switch on `evt.type`:
      - `"user.message"` ⇒ if `evt.data?.content` is a non-empty string: push `{role:"human", content, timestamp: evt.timestamp}`.
      - `"assistant.message"` ⇒ if `evt.data?.content` is a non-empty string: push `{role:"assistant", content, timestamp: evt.timestamp}`. (Tool-only messages with `content === ""` are dropped.)
      - default ⇒ skip.
   4. `beforeTimestamp` gate: if set and `evt.timestamp > beforeTimestamp` ⇒ **break without consuming**, set `endLine = currentLine - 1`. Matches Gemini reader semantics.
3. Return `{ entries, newCursor: { transcriptPath, lineNumber: endLine, updatedAt: now }, totalLinesRead: endLine - startLine }`.

#### Sub-reader: `readPatchLog(path, cursor, beforeTimestamp)`

1. `readFile(path, "utf-8")`, split by `\n`, drop empty trailing line.
2. Initialize `doc = {}`. For each line in order:
   1. `JSON.parse(line)`. On parse error ⇒ **stop replaying** (later patches assume earlier landed). Do not advance cursor past the bad line.
   2. `kind === 0` ⇒ `doc = evt.v`.
   3. `kind === 1` ⇒ `setAtPath(doc, evt.k, evt.v)`.
   4. `kind === 2` ⇒ `deleteAtPath(doc, evt.k)`.
   5. otherwise ⇒ debug-log, skip.
3. Apply shared `requests[] → entries` extraction (see *Observed Reality* section), starting from index `cursor?.lineNumber ?? 0`.
4. `beforeTimestamp` gate: any request with `req.timestamp > beforeTimestamp` (after ms→ISO conversion) ⇒ **stop emitting and do not advance cursor past it** — re-read on next commit.
5. Return `{ entries, newCursor: { transcriptPath, lineNumber: <highest emitted index + 1>, updatedAt: now }, totalLinesRead: requests.length - (cursor?.lineNumber ?? 0) }`.

#### Shared helpers (private)

- `setAtPath(doc, segments, value)`: numeric segment ⇒ array index (auto-grow with `null`); string ⇒ object key; create intermediate parents based on next segment's type.
- `deleteAtPath(doc, segments)`: no-op if any path segment is missing. Numeric segment + array ⇒ `splice`; string segment + object ⇒ `delete`.
- `extractFromRequests(requests, startIdx, beforeTimestamp)`: used by `readPatchLog`; emits `{role, content, timestamp}` entries per the rules in the *Shared `requests[i] → entries` extraction* subsection.

### Data flow (commit time)

```
QueueWorker.loadSessionTranscripts(cwd)
  ├─ existing claude/codex/gemini/opencode/cursor branches (untouched)
  ├─ existing copilot CLI branch (untouched) — discoverCopilotSessions(cwd), reads session-store.db
  └─ if (config.copilotEnabled && isCopilotChatInstalled())
        └─ discoverCopilotChatSessions(cwd)
              ├─ Scan A: readdir(~/.copilot/session-state) → for each <sid>:
              │      └─ vscode.metadata.json: folderPath ≟ cwd (normalized)
              │         events.jsonl: stat + 48h mtime gate
              │         emit SessionInfo { transcriptPath: <abs>/events.jsonl, source:"copilot-chat" }
              └─ Scan B: findVscodeWorkspaceHash("Code", cwd) →
                       readdir(<wsHash>/chatSessions) → for each *.jsonl (skip *.json — deprecated):
                          stat + 48h mtime gate
                          emit SessionInfo { transcriptPath: <abs>/<sid>.jsonl, source:"copilot-chat" }
        └─ readAllTranscripts(allSessions, cwd, beforeTimestamp)
              └─ source==="copilot-chat" ⇒ readCopilotChatTranscript(path, cursor, beforeTimestamp)
                    └─ dispatch by path suffix:
                       ├─ events.jsonl   → readEventsJsonl   (line-based cursor; user.message + non-empty assistant.message)
                       └─ <sid>.jsonl    → readPatchLog      (request-idx cursor; replay kind:0/1/2 → requests[])
                    └─ TranscriptReadResult → entered into stored transcript JSON
```

The downstream path (stored transcript writer → orphan branch → webview reader → modal renderer) is unchanged.

## Error handling

| Failure | Layer | Behavior |
|---|---|---|
| `~/.copilot/session-state/` missing | discoverer (Scan A) | empty Scan A, no error (user just doesn't use the new format) |
| `~/.copilot/session-state/` other fs error | discoverer (Scan A) | Scan A empty, set `error: { kind:"fs" }`; Scan B still runs |
| `<sid>/vscode.metadata.json` missing / unparseable | discoverer (Scan A) | skip sid (debug log) — pure CLI side-state |
| `folderPath` empty / non-string / not matching cwd | discoverer (Scan A) | skip sid (no log) |
| `<sid>/events.jsonl` missing / stat fails | discoverer (Scan A) | skip sid (debug log) |
| `findVscodeWorkspaceHash` returns null | discoverer (Scan B) | skip Scan B (no VS Code workspace ever opened this cwd) |
| `<wsHash>/chatSessions/` missing | discoverer (Scan B) | skip Scan B (legacy format never used by this VS Code install) |
| `<wsHash>/chatSessions/` other fs error | discoverer (Scan B) | empty Scan B, set `error` only if Scan A didn't already |
| `mtime < cutoff` (any format) | discoverer | skip (silent — common case) |
| `readEventsJsonl`: per-line `JSON.parse` failure | reader | skip line, advance cursor, continue |
| `readPatchLog`: per-line `JSON.parse` failure | reader | **stop replay** at bad line; emit whatever was assembled before; cursor does **not** advance past bad line (next commit retries) |
| Any reader: file I/O failure (read/open) | reader | throw — QueueWorker [line 1530–1536](../../../cli/src/hooks/QueueWorker.ts#L1530-L1536) catches, logs error, skips this session |
| Reader: zero entries after filtering | reader + QueueWorker | session dropped from `sessionTranscripts` (existing `entries.length > 0` gate) |

## Types & config

No type changes — `TranscriptSource`, `SessionInfo`, `StoredSession`, `StoredTranscript`, `TranscriptCursor`, `TranscriptReadResult`, `CopilotChatScanError` already exist with the right shapes.

No config changes — `copilotEnabled` (single user-facing toggle) is unchanged.

## Testing

### `CopilotChatSessionDiscoverer.test.ts` (rewritten)

Cases (all use vitest tmpdir + a fake `HOME` and a fake `~/Library/.../workspaceStorage` root to isolate from the user's real disk):

**Scan A — `~/.copilot/session-state/`:**

| # | Scenario | Expectation |
|---|---|---|
| 1 | session-state does not exist (and Scan B also empty) | `{ sessions: [] }`, no error |
| 2 | session-state exists but empty | `{ sessions: [] }` |
| 3 | One sid with `folderPath === cwd` and fresh `events.jsonl` | 1 SessionInfo, `transcriptPath` ends with `events.jsonl` |
| 4 | `folderPath` is empty string `""` | skip (CLI standalone marker) |
| 5 | `folderPath` is missing field | skip |
| 6 | `folderPath` does not match cwd | skip |
| 7 | `folderPath` differs only in case (macOS) | match (via `normalizePathForMatch`) |
| 8 | `folderPath` differs only in trailing slash | match |
| 9 | `vscode.metadata.json` does not exist | skip |
| 10 | `vscode.metadata.json` is malformed JSON | skip (debug log) |
| 11 | `events.jsonl` does not exist | skip |
| 12 | `events.jsonl` mtime > 48h ago | skip |
| 13 | `readdir(~/.copilot/session-state)` returns EACCES | `error: { kind:"fs" }`; Scan B still runs |
| 14 | Scan A mixed: 1 matches, 1 empty folderPath, 1 stale, 1 path mismatch | 1 emitted from Scan A |

**Scan B — `<wsHash>/chatSessions/`:**

| # | Scenario | Expectation |
|---|---|---|
| 15 | `findVscodeWorkspaceHash` returns null (no matching workspace.json) | Scan B emits 0, no error |
| 16 | wsHash exists but `chatSessions/` does not | Scan B emits 0 |
| 17 | wsHash + `chatSessions/<sid>.jsonl` (fresh mtime) | 1 SessionInfo, transcriptPath ends with `<sid>.jsonl`, sessionId is `<sid>` |
| 18 | wsHash + `chatSessions/<sid>.json` (fresh mtime) | **skip** — deprecated snapshot format excluded by suffix filter |
| 19 | Mix of `.jsonl` + `.json` + `.tmp` (irrelevant suffix) | only `.jsonl` emitted |
| 20 | `chatSessions/<sid>.jsonl` mtime > 48h | skip |
| 21 | `chatSessions/` returns EACCES, Scan A produced sessions | Scan A sessions returned, Scan B `error` set |
| 22 | `chatSessions/` returns EACCES, Scan A also errored | Scan A's error wins (returned first) |

**Combined:**

| # | Scenario | Expectation |
|---|---|---|
| 23 | Both scans produce sessions | both batches concatenated; total = sum of both |
| 24 | Same sid in both Scan A and Scan B | both emitted (no dedup, per design) |

### `CopilotChatTranscriptReader.test.ts` (rewritten)

Fixtures derived from real captures of each format (sanitized to short test strings). Each test constructs files from typed factories, **not** from hand-written JSON, so a future schema drift is caught by adding one event type / patch kind.

**Dispatcher:**

| # | Scenario | Expectation |
|---|---|---|
| D1 | Path ends with `/session-state/<sid>/events.jsonl` | calls `readEventsJsonl` |
| D2 | Path ends with `/chatSessions/<sid>.jsonl` | calls `readPatchLog` |
| D3 | Path matches no pattern (e.g. `.json` slipped through) | throws |

**`readEventsJsonl`:**

| # | Scenario | Expectation |
|---|---|---|
| E1 | Happy path: session.start + 2× user.message + 2× assistant.message + tool.* + assistant.turn_* + session.shutdown | 4 entries in file order; `newCursor.lineNumber` = total lines |
| E2 | `assistant.message` with `content === ""` and `toolRequests` populated | dropped |
| E3 | All non-conversation types | 0 entries |
| E4 | `beforeTimestamp` cuts later events | pre-cutoff entries returned; cursor stops at last consumed line |
| E5 | Cursor increment after appended lines | second call returns only the new lines |
| E6 | One malformed line in middle | skipped, cursor advances, surrounding entries returned |
| E7 | `evt.timestamp` missing | entry emitted with `timestamp: undefined` |

**`readPatchLog`:**

| # | Scenario | Expectation |
|---|---|---|
| P1 | `kind:0` init with empty `requests` + `kind:1` set at `requests[0]` to a full request | 1 user + 1 assistant entry |
| P2 | Multiple `kind:1` patches at deep paths (`["requests",0,"response",0,"value"]`) | final `requests[0].response[0].value` reflects last set |
| P3 | `kind:2` delete at `["pendingRequests",0]` | no crash; subsequent `requests[]` extraction unaffected |
| P4 | `kind:2` on missing path | no-op, no error |
| P5 | Cursor=2 after 4 requests had been emitted before; new patch adds requests[4] | only requests[4] emitted |
| P6 | `beforeTimestamp` cuts a request whose `req.timestamp` is later | cursor stops at last emitted index, request not consumed |
| P7 | Mid-line `JSON.parse` failure (truncated last line) | replay stops at bad line; emit what's assembled; cursor stays at previous good state |
| P8 | Unknown `kind` value | debug-log, skip patch |
| P9 | `req.message.text` empty string | skip user emit but still emit assistant if present |
| P10 | `req.response` is empty array | skip assistant emit |

### `CopilotChatDetector.test.ts` (rewritten)

| # | Scenario | Expectation |
|---|---|---|
| 1 | `~/.copilot/session-state/` is a directory | `true` (Copilot CLI agent backend present) |
| 2 | `~/.copilot/session-state/` missing, but `<userDataDir>/User/globalStorage/github.copilot-chat` exists | `true` (Copilot Chat extension installed) |
| 3 | Both probe paths missing | `false` |
| 4 | One probe path exists but is a file, the other is missing | `false` |
| 5 | `stat` throws non-ENOENT (EACCES) on either probe path — warn-logs and treats as missing | `false` if both treated as missing |

### Integration coverage

The QueueWorker and SummaryWebviewPanel test suites already assert behavior for `source: "copilot-chat"` sessions. Those tests use stub session data and don't exercise the reader internals, so they pass without modification once the rewritten reader produces the same `TranscriptReadResult` shape.

`cli` workspace coverage gate (97% statements/lines) is held: the rewritten files are smaller and more focused than the prior versions, with denser test coverage.

## Migration & rollout

- **Backwards compatibility**: the previous design produced zero data on any user's machine, so rolling forward causes no functional regression. Users who chat via the **VS Code Chat panel** start seeing correct data on the first non-squash commit after installing the new version, via Scan B of the discoverer; users who chat via the **Copilot CLI Agent** (standalone `copilot` terminal or VS Code's "GitHub Copilot CLI Agent" chat session type) get correct data via Scan A. Users who use both get both.
- **No backfill**: pre-existing stored transcripts on the orphan branch are immutable. Old commits will continue to display the same (typically empty) `copilot-chat` data in the Manage modal. This is consistent with how every other source addition has shipped (Cursor, OpenCode, Copilot CLI all started capturing data only at deploy time).
- **No data migration**: nothing to delete or convert; the old design wrote no `copilot-chat` sessions to the orphan branch in observed runs.
- **48h freshness window keeps both stores honest**: stale `chatSessions/<sid>.jsonl` from a workspace the user no longer touches will not surface. Same for `events.jsonl` from idle sessions. Symmetric with every other source.
- **Telemetry / status panel**: status panel session counts use `discoverCopilotChatSessions(cwd)`; counts become more accurate (no longer inflating with debug-logs span events that produced zero stored entries) and now include both Store A and Store B contributions.

## Risks

1. **`vscode.metadata.json` schema drift.** If a future Copilot release changes `workspaceFolder.folderPath` to a `vscode.Uri` shape (`{ scheme, path }`) or relocates the field, Scan A silently emits zero sessions. **Mitigation**: integration smoke test in CI that lints a real captured `vscode.metadata.json` against the expected shape. Documented in this spec; logged at debug level on parse failure so a `DEBUG=jollimemory:* git commit` invocation surfaces the drift. Scan B's coverage of legacy formats provides degraded-but-nonzero data during the drift window.
2. **`events.jsonl` event-type renames.** If `user.message` becomes `chat.user.message`, the reader emits zero conversation entries while parsing fine. **Mitigation**: the reader logs a debug-level message when a recognized session yields zero conversation entries, making this drift visible without alarming non-debug users.
3. **Patch-log schema drift.** A future VS Code version could introduce `kind:3` (e.g. "splice array range"), invalidating the assumption that {0,1,2} cover all patches. **Mitigation**: the replayer debug-logs unknown `kind` values rather than throwing, so a missed patch yields a slightly stale document but not zero output. Schema drift detector (test P8) prevents regressions in our handling of known kinds.
4. **Multi-host divergence.** If VS Code Insiders or an Insiders-derived fork uses a different `vscode.metadata.json` filename, Scan A misses those hosts. Scan B still works for hosts whose user-data root happens to match `Code` (none currently). **Mitigation**: out of scope here; fold into the next host-support iteration via `VscodeWorkspaceLocator`'s flavor parameter.
5. **`session-state/` entries written by future Copilot CLI versions with non-empty `folderPath`.** If Copilot CLI starts populating `vscode.metadata.json.folderPath` for terminal sessions to record the `cwd`, those sessions would be picked up by **both** the `copilot` source (via session-store.db) and the `copilot-chat` source (via Scan A). **Mitigation**: accepted; revisit on first observed double-post.
6. **Cross-format duplicate sids (Scan A + Scan B).** Sids in `~/.copilot/session-state/` and `<wsHash>/chatSessions/` come from different namespaces in observation; collision is theoretically possible but unobserved. **Mitigation**: per Non-goals, no dedup. Both copies would surface as separate sessions in the modal.
7. **Performance on long-running sessions.** A multi-thousand-turn `events.jsonl` could grow into the multi-MB range. The reader's `readline` stream is O(lines), bounded by the cursor; first-time read is the only large operation per session. Patch logs are size-bounded by VS Code's internal cap; snapshots are small (< 1 MB observed). Comparable to the existing Claude reader. No additional mitigation needed.

