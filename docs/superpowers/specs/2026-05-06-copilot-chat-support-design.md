# VS Code Copilot Chat as a Transcript Source — Design

**Date:** 2026-05-06
**Status:** **Superseded by [`2026-05-07-copilot-chat-events-jsonl-redesign-design.md`](./2026-05-07-copilot-chat-events-jsonl-redesign-design.md)** — both storage paths assumed below (`<wsHash>/chatSessions/<sid>.jsonl` and `<wsHash>/GitHub.copilot-chat/debug-logs/<sid>/main.jsonl`) turned out not to contain conversation content on real VS Code 1.118.x machines. Real conversations live in `~/.copilot/session-state/<sid>/events.jsonl`. This document is preserved for design history.
**Branch:** `feature-support-copilot`
**Precedent:**
- [`feature-support-cursor`](../../../) (commit `af74e2cb` — vscode workspaceStorage scanning)
- [`feature-support-copilot`](../../../) (commit `357fcca6` — Copilot CLI as the sixth source)

## Summary

Add **VS Code Copilot Chat** as the seventh AI agent transcript source. This is a *separate product* from GitHub Copilot CLI, with a *separate on-disk format* (JSONL patch logs in vscode workspaceStorage rather than SQLite in `~/.copilot/`), but it ships under the same "GitHub Copilot" name and is treated by users as the same product. The design reconciles this gap by introducing a new internal source `"copilot-chat"` (code-level isolation) that **shares** the existing `copilotEnabled` flag (single user-facing toggle).

A field user report on Windows triggered this work: VS Code Copilot Chat sessions on the user's machine were not picked up despite the `~/.copilot/` directory existing — because that user only used VS Code's chat panel, never the terminal `copilot` binary, and Copilot Chat conversations live elsewhere entirely.

## Goals

- Treat VS Code Copilot Chat sessions as first-class peers of Copilot CLI / Cursor / OpenCode / Codex sessions: same enable/disable semantics, same status reporting, same surfacing in the Settings UI and Summary Details panel.
- Single user-facing toggle "GitHub Copilot" that controls both `~/.copilot/session-store.db` (CLI) and vscode workspaceStorage chat sessions (Chat). Reflects product reality: both are "GitHub Copilot" to users.
- Auto-detect on installer first run when *either* form is present; never overwrite an explicit user choice.
- Surface JSONL parse / fs scan errors with a structured error kind, not silent zero-session results.
- Extract a shared `VscodeWorkspaceLocator` module so this integration *and* the existing Cursor integration *and* future vscode-fork integrations (Insiders, Code-OSS, Windsurf, Trae, …) all locate workspaces through one path resolver.
- Achieve coverage parity with the Cursor / Copilot-CLI integrations (≥97% statements/lines on the new modules).

## Non-goals

- **No separate Copilot Chat toggle.** `copilotEnabled` controls both source forms. UI shows one "GitHub Copilot" row; tooltip/sub-line distinguishes which forms were detected ("CLI ✓ + Chat ✓", "CLI only", "Chat only").
- **No `chatEditingSessions/` reads.** That directory under each workspaceStorage entry contains editor edit-operation logs, not conversational content. Out of scope.
- **No `globalStorage/github.copilot-chat/copilotCli/*` reads.** That subtree is the vscode-bundled Copilot CLI binary, which writes back to `~/.copilot/session-store.db` — already covered by the existing `"copilot"` source.
- **No multi-root `.code-workspace` support (v1).** When a workspace is opened from a `.code-workspace` file, vscode's `workspace.json` contains a `workspace` URI rather than a single `folder` URI. v1 reads single-folder workspaces only and skips multi-root entries silently. Revisit on first user report.
- **No VS Code Insiders / Code-OSS / fork support (v1).** v1 targets `Code` (VS Code Stable) only. The shared `VscodeWorkspaceLocator` is parameterized by flavor so adding Insiders / forks later is a one-line flavor-map extension.
- **No Windows CI verification this iteration.** Path logic supports `%APPDATA%\Code` for parity with the Cursor and Copilot-CLI discoverers, but live testing is macOS only. Documented as a known gap; revisit on first Windows user report.
- **No live tail / real-time scanning.** Commit-time batch read suffices, matching every other source.
- **No write to chat session files.** All access is read-only; we never collide with vscode's writers or risk corrupting in-flight sessions.

## Observed Reality

Verified hands-on on 2026-05-06 against VS Code Stable 1.x on macOS 14, with 16 active workspaceStorage entries.

### On-disk layout

```
~/Library/Application Support/Code/User/
├── globalStorage/github.copilot-chat/
│   ├── copilotCli/                        # vscode-bundled Copilot CLI binary — covered by "copilot" source
│   │   ├── copilot
│   │   ├── copilotCLIShim.js
│   │   └── copilotCLIShim.ps1
│   ├── ask-agent/Ask.agent.md             # agent templates — not session content
│   ├── plan-agent/Plan.agent.md
│   ├── explore-agent/Explore.agent.md
│   ├── debugCommand/copilotDebugCommand.js
│   ├── copilot-cli-images/
│   └── toolEmbeddingsCache.bin
│
└── workspaceStorage/<wsHash>/             # one entry per workspace folder
    ├── workspace.json                     # {"folder": "file:///abs/path"} — same shape as Cursor
    ├── state.vscdb                        # general vscode state (not read here)
    ├── chatSessions/                      # ← READ THIS
    │   └── <sessionId>.jsonl              # one file per chat session
    └── chatEditingSessions/               # editing operation logs — out of scope
```

The presence of `globalStorage/github.copilot-chat/` is the install signal; the real conversation content lives one level up under `workspaceStorage/<wsHash>/chatSessions/<sessionId>.jsonl`. Workspace attribution is exact via `workspace.json`'s `folder` URI — identical to the Cursor algorithm.

Per-platform user-data root (matches Cursor's per-platform map):

| Platform | Root |
|---|---|
| darwin | `~/Library/Application Support/Code` |
| linux  | `~/.config/Code` |
| win32  | `%APPDATA%\Code` |

### `<sessionId>.jsonl` schema

The file is a **JSON document patch log**, not a stream of messages. Each line is one event:

```jsonc
// kind 0 — initial document (always line 0)
{"kind": 0, "v": {
  "version": 3,
  "creationDate": 1776416572549,
  "initialLocation": "panel",
  "responderUsername": "",
  "sessionId": "<uuid>",
  "hasPendingEdits": false,
  "requests": [],
  "pendingRequests": [],
  "inputState": { /* ... */ }
}}

// kind 1 — set value at JSON path
{"kind": 1, "k": ["requests", 0, "result"], "v": { /* the new value at that path */ }}

// kind 2 — delete value at JSON path
{"kind": 2, "k": ["pendingRequests", 0]}
```

Reconstructing the conversation requires **replaying patches in order**: start with the `kind:0` initial document, apply each `kind:1` as a set-at-path, each `kind:2` as a delete-at-path, in file order. The final document's `requests[]` array contains the conversation. Each `requests[i]` has shape:

```jsonc
{
  "message": { "text": "user prompt..." },          // user input
  "response": [ { "value": "..." }, ... ],          // streamed assistant output (post-stream merged by patches)
  "result": {
    "metadata": {
      "codeBlocks": [
        { "code": "...", "language": "ts", "markdownBeforeBlock": "..." }
      ],
      "timings": { "firstProgress": 23361, "totalElapsed": 163605 }
    }
  },
  "timestamp": 1776416700000
}
```

The transcript reader emits one `{role: "human", text: message.text}` and one `{role: "assistant", text: <flattened response>}` per `requests[i]` with non-empty content. **`response[]` is the source of truth** for assistant text (streaming chunks are already merged by the patch sequence); `codeBlocks` is sidecar metadata, not re-emitted.

### Smoke test

```js
// One session file → final document → request count
const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
let doc = {};
for (const raw of lines) {
  const evt = JSON.parse(raw);
  if (evt.kind === 0) doc = evt.v;
  else if (evt.kind === 1) setAtPath(doc, evt.k, evt.v);
  else if (evt.kind === 2) deleteAtPath(doc, evt.k);
}
console.log(doc.requests.length, "requests");
// → matches the chat panel's visible turn count in vscode
```

Verified against a 22-line fixture (file size ~840 KB, 4 user/assistant turns).

### Differences vs Cursor

| Dimension | Cursor (existing) | Copilot Chat (new) |
|---|---|---|
| User data root | `~/Library/Application Support/Cursor` (etc) | `~/Library/Application Support/Code` (etc) |
| Workspace lookup | `workspace.json` `folder` URI → wsHash | **same** (shared via `VscodeWorkspaceLocator`) |
| Session storage | global `cursorDiskKV` SQLite + per-workspace pointer DB | per-workspace `chatSessions/<id>.jsonl` files |
| Session attribution | β′ algorithm (anchor pointers ∪ time window) | Direct: each file in `<wsHash>/chatSessions/` belongs to that workspace |
| Read library | `node:sqlite` | `JSON.parse` per line |
| Schema model | row → composer JSON blob | document → patch log replay |

The two sources share the workspace-locator layer, but the session-discovery and transcript-reading layers diverge entirely. **No SQLite dependency is added for Copilot Chat** — pure JSON parsing, no `node:sqlite` gate.

## Architecture

### Module map

```
cli/src/core/
├── VscodeWorkspaceLocator.ts        # NEW — shared workspaceStorage path/hash logic
├── VscodeWorkspaceLocator.test.ts
├── CopilotChatDetector.ts           # NEW
├── CopilotChatDetector.test.ts
├── CopilotChatSessionDiscoverer.ts  # NEW
├── CopilotChatSessionDiscoverer.test.ts
├── CopilotChatTranscriptReader.ts   # NEW (incl. patch replayer)
├── CopilotChatTranscriptReader.test.ts
├── CursorDetector.ts                # MODIFIED — call shared locator
└── CursorSessionDiscoverer.ts       # MODIFIED — call shared locator
```

### Shared layer: `VscodeWorkspaceLocator`

```typescript
type VscodeFlavor = "Cursor" | "Code"

function getVscodeUserDataDir(flavor: VscodeFlavor, home?: string): string
//   darwin   ~/Library/Application Support/<flavor>
//   linux    ~/.config/<flavor>
//   win32    %APPDATA%/<flavor>

function getVscodeWorkspaceStorageDir(flavor: VscodeFlavor, home?: string): string
//   <userDataDir>/User/workspaceStorage

function findVscodeWorkspaceHash(
    flavor: VscodeFlavor,
    projectDir: string,
): Promise<string | null>
//   Scans <wsStorageDir>/<entry>/workspace.json for a `folder` file:// URI that
//   resolves to projectDir. Single-folder workspaces only — entries with a
//   `workspace` field instead of `folder` are silently skipped (multi-root
//   .code-workspace, out of scope).

function normalizePathForMatch(p: string): string
//   Strips trailing slashes; lowercases on darwin/win32. Used by both flavors.
```

`CursorDetector.getCursorUserDataDir`, `CursorDetector.getCursorGlobalDbPath` (which delegates to a Cursor-flavor call to the shared locator), `CursorDetector.getCursorWorkspaceStorageDir`, and `CursorSessionDiscoverer.findCursorWorkspaceHash` / `normalizePathForMatch` are reimplemented as thin wrappers over the shared module. **Public symbols on those files are preserved** — no downstream import paths change.

### `CopilotChatDetector`

```typescript
function getCopilotChatStorageDir(home?: string): string
//   getVscodeUserDataDir("Code", home) + "/User/globalStorage/github.copilot-chat"

async function isCopilotChatInstalled(): Promise<boolean>
//   stat(getCopilotChatStorageDir()).isDirectory()
//   No node:sqlite gate — JSONL is plain JSON.
```

### `CopilotChatSessionDiscoverer`

Algorithm:

1. `wsHash := findVscodeWorkspaceHash("Code", projectDir)` — return empty if null
2. `sessionsDir := <wsStorageDir>/<wsHash>/chatSessions` — return empty if missing
3. `cutoff := now - 48h`
4. For each `*.jsonl` file in `sessionsDir`:
   - `mtime := stat(file).mtimeMs`
   - Skip if `mtime < cutoff`
   - Emit `SessionInfo { sessionId: basename without .jsonl, transcriptPath: <abs>, updatedAt: ISO(mtime), source: "copilot-chat" }`
5. Return `{ sessions, error? }`

`transcriptPath` is the absolute file path (no synthetic `#` discriminator — each file is one session).

### `CopilotChatTranscriptReader`

The reader has two layers:

**Patch replayer** (pure function, ~50 LOC):

```typescript
type PatchEvent =
  | { kind: 0; v: unknown }                 // init
  | { kind: 1; k: PathSegment[]; v: unknown }   // set
  | { kind: 2; k: PathSegment[] }                // delete
type PathSegment = string | number

function replayPatches(lines: ReadonlyArray<string>): unknown {
    let doc: unknown = {}
    for (const raw of lines) {
        const evt = JSON.parse(raw) as PatchEvent | { kind: number }
        switch (evt.kind) {
            case 0: doc = (evt as { v: unknown }).v; break
            case 1: doc = setAtPath(doc, (evt as { k: PathSegment[] }).k, (evt as { v: unknown }).v); break
            case 2: doc = deleteAtPath(doc, (evt as { k: PathSegment[] }).k); break
            default: log.warn("Unknown patch kind %s — skipping", evt.kind); break
        }
    }
    return doc
}
```

`setAtPath` and `deleteAtPath` mutate the document in place; `replayPatches` applies them in file order. (Mutation is fine: the replayer owns the document and never exposes intermediate states.) Path semantics:
- Numeric segment → array index (auto-grow with `undefined` slots if needed for `set`)
- String segment → object key
- `delete` on a missing path is a no-op (vscode emits these legitimately for already-cleaned `pendingRequests`)
- `set` with parents missing creates intermediate objects/arrays based on next segment type

**Transcript layer:**

```typescript
async function readCopilotChatTranscript(
    transcriptPath: string,
    cursor?: { lastReadRequestIdx: number },
): Promise<{
    messages: ReadonlyArray<{ role: "human" | "assistant"; text: string }>
    newCursor: { lastReadRequestIdx: number }
}>
```

- Read the entire `.jsonl` file → `replayPatches` → final document
- Extract `doc.requests` (default to `[]` on missing/non-array)
- For each `requests[i]` where `i > (cursor?.lastReadRequestIdx ?? -1)`:
  - Emit `{role: "human", text: req.message.text}` if `req.message?.text` is a non-empty string
  - Flatten `req.response[]` to a single string (concatenate `.value` fields where present); emit `{role: "assistant", text}` if non-empty
- Return `{messages, newCursor: {lastReadRequestIdx: doc.requests.length - 1}}`

**Re-replaying the whole file each call is by design.** A 5 MB jsonl replays in <50 ms; the cursor avoids re-emitting already-summarized turns, but the doc itself is rebuilt each time. Storing intermediate state would couple cursor format to internal patch-replayer state — fragile.

**Mid-write robustness.** vscode appends patches without atomicity guarantees, so a session file may be observed mid-write (last line truncated / partial JSON). The reader treats `JSON.parse` failure on any line as a `parse`-kind scan error and emits zero messages for that session this run — never a partial transcript. The next commit-time scan retries; the cursor isn't advanced on parse failure.

## Types & config

```typescript
// cli/src/Types.ts

type TranscriptSource = "claude" | "codex" | "gemini" | "opencode" | "cursor" | "copilot" | "copilot-chat"

interface JolliMemoryConfig {
    // ...existing fields
    copilotEnabled?: boolean   // unchanged — controls BOTH "copilot" (CLI) and "copilot-chat" (Chat) sources
    // No copilotChatEnabled — single shared toggle.
}

interface StatusInfo {
    // ...existing fields
    copilotDetected: boolean         // unchanged
    copilotChatDetected: boolean     // NEW
    copilotEnabled?: boolean         // unchanged — shared toggle
    copilotScanError?: SqliteScanError                // unchanged
    copilotChatScanError?: { kind: "parse" | "fs" | "schema" | "unknown"; message: string }  // NEW
}
```

`SessionTracker.filterSessionsByEnabledIntegrations` adds:

```typescript
case "copilot-chat":
    return config.copilotEnabled !== false   // same flag as "copilot"
```

## Pipeline wiring

`Installer.install()` — auto-enable on first install:

```typescript
const copilotDetected     = config.copilotEnabled !== false && (await isCopilotInstalled())
const copilotChatDetected = config.copilotEnabled !== false && (await isCopilotChatInstalled())
if ((copilotDetected || copilotChatDetected) && config.copilotEnabled === undefined) {
    await saveConfig({ copilotEnabled: true })
    log.info("GitHub Copilot detected (CLI=%s, Chat=%s) — enabled session discovery", copilotDetected, copilotChatDetected)
}
```

`Installer.getStatus()`:

```typescript
const copilotDetected     = await isCopilotInstalled()
const copilotChatDetected = await isCopilotChatInstalled()

let copilotChatScanError: { kind: ...; message: string } | undefined
if (config.copilotEnabled !== false && copilotChatDetected) {
    const scan = await scanCopilotChatSessions(projectDir)
    if (scan.sessions.length > 0) allEnabledSessions = [...allEnabledSessions, ...scan.sessions]
    copilotChatScanError = scan.error
}
```

`QueueWorker` — same pattern as Copilot CLI source, gated on shared flag.

## VS Code surface

- **`StatusTreeProvider`**: one "GitHub Copilot" row.
  - Detected = `copilotDetected || copilotChatDetected`
  - Tooltip: `"CLI: ${copilotDetected ? "✓" : "✗"}, Chat: ${copilotChatDetected ? "✓" : "✗"}"`
  - Error rows: each `*ScanError` surfaces independently when set.
- **Settings panel** (`SettingsHtmlBuilder` / `Script` / `Webview`): unchanged "GitHub Copilot" toggle bound to `copilotEnabled`. Description updated:
  > "Discovers sessions from GitHub Copilot CLI (`~/.copilot/session-store.db`) and VS Code Copilot Chat (workspace storage)."
- **Summary panel** (`SummaryWebviewPanel` + `SummaryScriptBuilder`): `getEnabledSources()` includes both `"copilot"` and `"copilot-chat"` when `copilotEnabled !== false`. `sourceOrder` places `"copilot-chat"` after `"copilot"`. Source label: `"Copilot Chat"`.

## CLI commands

- **`StatusCommand`**: one Copilot row; sub-line shows form breakdown:
  ```
  GitHub Copilot   detected: yes (CLI ✓ + Chat ✓), enabled: yes, sessions: 7
  ```
- **`ConfigureCommand`**: no new flag; `--set copilotEnabled` controls both forms.

## Testing

| Module | Coverage focus |
|---|---|
| `VscodeWorkspaceLocator` | Two flavors × three platforms path resolution; `workspace.json` shapes (single `folder` / multi-root `workspace` / missing / unparseable URI / file URI percent-encoding) |
| `CopilotChatDetector` | Storage dir present / absent / not a directory |
| `CopilotChatSessionDiscoverer` | No wsHash / wsHash but no chatSessions/ / chatSessions/ empty / all stale / partial fresh / mtime boundary at cutoff |
| `replayPatches` | Init only / init + sets / init + sets + deletes / unknown kind (warn + skip) / set with missing parent / delete on missing path / nested array growth / numeric vs string path segments / parse errors per line |
| `readCopilotChatTranscript` | Empty `requests` / multi-turn / cursor advance / skip empty messages / `response[]` flatten with mixed shapes / non-array `requests` defended |
| `Installer` integration | Auto-enable on either form / status panel reflects both forms / no-overwrite when user explicitly disabled |
| VSCode panel tests | Same pattern as Cursor / Copilot-CLI: one happy + one error path per panel file (`StatusTreeProvider`, `SummaryWebviewPanel`, `SummaryScriptBuilder`, `SettingsHtmlBuilder`, `SettingsScriptBuilder`, `SettingsWebviewPanel`) |

≥97% statements / lines / branches / functions on new modules, matching the cli workspace coverage gate.

## Out of scope (deferred follow-ups)

These were considered and intentionally postponed:

- Multi-root `.code-workspace` workspace support — needs design pass on how a single `.code-workspace` file maps to one or many `git` projects.
- VS Code Insiders / Code-OSS / Windsurf / Trae / other vscode-fork support — gated on `VscodeWorkspaceLocator` flavor extension; cheap to add per-fork once a user reports demand.
- Live tail of in-progress sessions — every other source uses commit-time batch reads.
- Reading `chatEditingSessions/` (editor edit-operation logs) — separate signal class; would need a different transcript shape than `{role, text}`.

## Release & migration

Same as Copilot CLI: ships in the next CLI minor + matching VS Code patch. No migration. No flag. Auto-detected on installer run; users without VS Code Copilot Chat installed see no change. Users who have *only* Copilot Chat (the field-report case) get auto-enabled on install just like CLI-only users do.
