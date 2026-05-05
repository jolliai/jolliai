# Cursor Support — Design

**Date:** 2026-05-03
**Branch:** `feature-support-cursor`
**Scope:** Add Cursor (the IDE) as a fifth `TranscriptSource`. Mirrors the OpenCode integration pattern: passive discovery from a global SQLite database, no hooks, no Cursor-side configuration. Setup-time detection with a status hint to the user.

---

## 1. Goals & non-goals

### Goals

- jollimemory's git-driven summary pipeline (`PostCommitHook` → `QueueWorker`) treats Cursor Composer conversations the same as Claude Code / Codex / OpenCode / Gemini transcripts: discovered, attributed to a commit, parsed to `TranscriptEntry[]`, and folded into the LLM summarization context.
- `jolli setup` and `jolli status` detect Cursor's presence and surface "Cursor → enabled" without requiring any Cursor-side config or restart.

### Non-goals

- VS Code extension–layer adaptation (e.g. `engines.vscode` widening, marketplace publishing to Cursor's registry, host-detection in webviews). Cursor is a VS Code fork — packaging, marketplace, and IDE host concerns are deferred. `vscode/` is **not** modified.
- A Cursor-side hook or extension installed inside Cursor itself. Cursor exposes no public hook protocol; we do not work around this with synthetic injection.
- Mid-conversation streaming. Like Codex/OpenCode, Cursor is scanned at git events (post-commit), not in real time.
- Indexing of Cursor's `agentKv:blob:*` rows (file-snapshot blobs not used by transcript display).

---

## 2. What we know about Cursor's storage

Verified by hands-on inspection of `~/Library/Application Support/Cursor/` on the current machine (5 workspaces, 12 composers).

### 2.1 Files & databases

| Path | Role |
|---|---|
| `/Applications/Cursor.app` | Application bundle (used for installation detection) |
| `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` | Global SQLite (`ItemTable`, `cursorDiskKV`). **Holds all transcript data.** |
| `~/Library/Application Support/Cursor/User/workspaceStorage/<wsHash>/workspace.json` | `{"folder": "file:///abs/path"}` — the bridge from a folder path to its workspace hash |
| `~/Library/Application Support/Cursor/User/workspaceStorage/<wsHash>/state.vscdb` | Per-workspace SQLite (`ItemTable`, `cursorDiskKV`). Holds workspace UI state and a **pointer** to the most recently used composer. |
| `…/chatSessions/*.jsonl` | **Ignored.** VS Code-native `Chat` panel state, contains no Cursor Composer transcript content (verified empty `requests: []`). |

Linux equivalent path: `~/.config/Cursor/User/...`. Windows: `%APPDATA%/Cursor/User/...`. The implementation uses platform-aware path resolution.

### 2.2 The `cursorDiskKV` table layout

The global SQLite's `cursorDiskKV` table holds Cursor-specific KV rows. Three relevant key shapes:

| Key shape | Count (sample) | Purpose | Used? |
|---|---|---|---|
| `composerData:<composerId>` | 12 | Composer session header — name, timestamps, `fullConversationHeadersOnly` (ordered bubble index), unifiedMode (`agent`/`ask`/`edit`), modelConfig | **Yes** |
| `bubbleId:<composerId>:<bubbleId>` | 18 | Single message — `text`, `richText`, `type` (1 = user, 2 = assistant — to be confirmed; see §6.2), `createdAt` (ISO), `modelInfo`, `tokenCount` | **Yes** |
| `checkpointId:<composerId>:<id>` | 7 | File-state snapshot reference (constant 142 B) | No |
| `agentKv:blob:<sha256>` | 50 | Binary attachments | No |

A composer is the unit jollimemory will treat as a "session." It groups N bubbles in a parent-child tree via `composerData.fullConversationHeadersOnly` (ordered list of `{bubbleId, type, grouping}`).

### 2.3 The workspace ↔ composer relationship

Composers are **stored globally**, not per-workspace. The on-disk schema does not reify a strong workspace→composers relation. Investigation findings:

- `composerData.trackedGitRepos` exists but is **empty** in observed rows.
- `composerData.workspaceUris` exists but is also empty.
- `globalStorage.ItemTable.backgroundComposer.windowBcMapping` is keyed by *window ID*, not by workspace, and lists only currently-running background composers (empty in the steady state).
- The per-workspace `state.vscdb`'s `ItemTable.composer.composerData` value contains only `selectedComposerIds` and `lastFocusedComposerIds` — these are precise pointers from Cursor itself, but only to the most recent / currently selected composer, not the full history.

**Conclusion**: There is no on-disk authoritative mapping from "workspace" to "all composers ever used in that workspace." The β′ algorithm in §3.3 makes the best of what is available.

---

## 3. Architecture

### 3.1 Component map

```
                                            ┌──────────────────────────────┐
                                            │  CursorDetector              │
                                            │  (one-shot install probe)    │
                                            └──────────────┬───────────────┘
                                                           │
              consulted by                                 │ used by
                ┌────────────────────────┐                 ▼
                │  Installer.ts (setup)  │       ┌─────────────────────────┐
                └────────────────────────┘       │   `jolli status` /      │
                                                 │    StatusInfo.cursor*   │
                                                 └─────────────────────────┘

    ┌─────────────────────┐                                ┌────────────────────────┐
    │  QueueWorker.ts     │ ───── on every commit ───►    │ CursorSessionDiscoverer │
    │  (post-commit)      │                                │ (β′: pointer + window) │
    └─────────────────────┘                                └─────────────┬──────────┘
                                                                         │ SessionInfo[]
                                                                         ▼
                                                          ┌──────────────────────────┐
                                                          │ CursorTranscriptReader   │
                                                          │ (composerId → entries)   │
                                                          └─────────────┬────────────┘
                                                                        │ TranscriptEntry[]
                                                                        ▼
                                                          (existing) Summarizer pipeline
```

No new hooks. No new state files. No changes to the orphan-branch storage format.

### 3.2 New files

| File | Approx. size | Mirrors |
|---|---|---|
| `cli/src/core/CursorDetector.ts` | ~30 LoC | `ClaudeDetector.ts` |
| `cli/src/core/CursorDetector.test.ts` | tests | — |
| `cli/src/core/CursorSessionDiscoverer.ts` | ~250 LoC | `OpenCodeSessionDiscoverer.ts` |
| `cli/src/core/CursorSessionDiscoverer.test.ts` | tests | `OpenCodeSessionDiscoverer.test.ts` |
| `cli/src/core/CursorTranscriptReader.ts` | ~150 LoC | `OpenCodeTranscriptReader.ts` |
| `cli/src/core/CursorTranscriptReader.test.ts` | tests | `OpenCodeTranscriptReader.test.ts` |

### 3.3 The β′ session-attribution algorithm

The discoverer's job is to answer: *given a `projectDir` and a time-window cutoff, which composers contain conversation that should be folded into the next commit summary?*

```
Input: projectDir (absolute path), staleCutoffMs (now − 48h, matches other sources)

Step 1  Find the workspace hash for this projectDir.
        - Iterate workspaceStorage/*/workspace.json
        - Parse `folder` URI; URL-decode; strip `file://`
        - Match (case-insensitive on darwin/win32) against projectDir
        - If no match → return [] (project never opened in Cursor)

Step 2  Read pointers from per-workspace state.vscdb.
        - ItemTable.composer.composerData → { lastFocusedComposerIds, selectedComposerIds }
        - Take union of both lists; this is the "anchor set"

Step 3  Read time-window candidates from global state.vscdb.
        - SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'
        - For each row, parse value, keep those with lastUpdatedAt ≥ staleCutoffMs
        - This is the "window set"

Step 4  Final composerId set = anchorSet ∪ windowSet.
        - Anchor set guarantees recall for the focused workspace.
        - Window set catches background composers and worktree-multiplexed cases
          (user opens the same composer across multiple windows).

Step 5  Map each composerId to a SessionInfo:
        - sessionId       = composerId
        - transcriptPath  = `${globalDbPath}#${composerId}` (synthetic, like OpenCode)
        - updatedAt       = composerData.lastUpdatedAt (ISO)
        - source          = "cursor"
```

**Acknowledged false-positive**: a composer used in workspace A but updated within the time window of an unrelated commit in workspace B will be picked up. This is intentional — the LLM summarizer can naturally ignore unrelated content; under-recall is harder to recover from than over-recall.

### 3.4 Transcript reading

`CursorTranscriptReader.readCursorTranscript(transcriptPath, cursor?, beforeTimestamp?)`:

```
1. Parse synthetic path "<dbPath>#<composerId>".
2. Open globalStorage/state.vscdb read-only.
3. Read composerData:<composerId> → fullConversationHeadersOnly = ordered bubbleIds.
4. Read bubbleId:<composerId>:<bubbleId> rows in that order.
5. For each bubble:
     - Map bubble.type → "human" | "assistant"  (1=human, 2=assistant; see §6.2)
     - Take bubble.text (fall back to empty string if absent — `richText` parsing
       is a Phase-2 enhancement, see §7.2)
     - Use bubble.createdAt (ISO) as timestamp
     - Skip non-conversational types and empty bodies
6. Apply mergeConsecutiveEntries (shared with TranscriptReader / OpenCodeTranscriptReader).
7. Cursor advances by index into the bubble list (mirrors OpenCode's pattern).
8. Apply beforeTimestamp cutoff if provided (drop entries strictly after).
```

Cursor reads use the same `withOpenCodeDb`-style pattern: dynamically import `node:sqlite`, open read-only, run a callback, close. We **introduce a small refactor** in `OpenCodeSessionDiscoverer.ts` to extract `withSqliteDb(dbPath, fn)` and `hasNodeSqliteSupport()` into a shared helper file (`cli/src/core/SqliteHelpers.ts`) so Cursor uses them too. This is a *targeted improvement* that serves the current goal and the existing OpenCode caller is rewritten to use the shared helper. (See §7.4 for justification.)

### 3.5 Type-system extensions

In `cli/src/Types.ts`:

```ts
export type TranscriptSource = "claude" | "codex" | "gemini" | "opencode" | "cursor";

export interface JolliMemoryConfig {
    // … existing fields …
    /** Enable Cursor Composer session discovery at post-commit time (default: auto-detect) */
    readonly cursorEnabled?: boolean;
}

export interface StatusInfo {
    // … existing fields …
    /** Whether Cursor data dir was detected */
    readonly cursorDetected?: boolean;
    /** Whether Cursor session discovery is enabled in config (undefined = auto-detect) */
    readonly cursorEnabled?: boolean;
    /** Cursor DB scan failed (corrupt, locked, schema drift, etc.) */
    readonly cursorScanError?: { readonly kind: "corrupt" | "locked" | "permission" | "schema" | "unknown"; readonly message: string };
}
```

Note: the existing `openCodeScanError.kind` literal type is duplicated rather than extracted, because the design decision is to mirror OpenCode's exact shape for consistency. If both fields end up needing identical shapes for a third source, an extraction is warranted then.

### 3.6 Wiring

Three integration points need to know about cursor:

| Module | Change |
|---|---|
| `cli/src/core/SessionTracker.ts` `filterSessionsByEnabledIntegrations` | Add `if (config.cursorEnabled === false) filtered = filtered.filter(s => s.source !== "cursor")`. |
| `cli/src/hooks/QueueWorker.ts` (the discoverer fan-out) | Add a call to `discoverCursorSessions(projectDir)` alongside the existing OpenCode/Codex calls; concatenate results. |
| `cli/src/install/Installer.ts` | After `isCursorInstalled()` returns true, emit a one-line console hint: `"✓ Detected Cursor — Composer sessions will be auto-collected from local SQLite"`. Set `config.cursorEnabled = true` if not yet set. |
| `cli/src/commands/StatusCommand.ts` (or equivalent — wherever `getStatus` is built) | Populate `cursorDetected`, `cursorEnabled`, `cursorScanError`, and an extra entry in `sessionsBySource`. |

---

## 4. Setup-time integration (Q3 = consistent with Codex/OpenCode)

The first time the user runs `jolli setup`, `jolli enable`, or `jolli install` in a repo:

1. `Installer.ts` calls `isCursorInstalled()` (checks `/Applications/Cursor.app` on darwin, `~/.config/Cursor` on linux, etc., **and** `globalStorage/state.vscdb` reachable, **and** `hasNodeSqliteSupport()` true).
2. If detected, log: `"✓ Detected Cursor — Composer sessions will be auto-collected from local SQLite"`. Persist `cursorEnabled: true` in `config.json` (only on first detection — subsequent runs respect a user-set `false`).
3. Nothing else: no hook installation, no Cursor-side files written, no restart prompted.

`jolli disable` (if present) sets `cursorEnabled: false`. `jolli status` shows the enable/detect flags consistently with OpenCode rows.

---

## 5. Error handling

Same classification scheme as OpenCode (`OpenCodeScanError.kind`):

| Kind | Trigger | Surfacing |
|---|---|---|
| `corrupt` | `SQLITE_CORRUPT` / `SQLITE_NOTADB` | UI warning row |
| `locked` | `SQLITE_BUSY` / `SQLITE_LOCKED` (Cursor app holding write lock) | UI warning row, transient |
| `permission` | `EACCES` / `EPERM` / `SQLITE_CANTOPEN` | UI warning row |
| `schema` | `no such table` / `no such column` (Cursor version drift) | UI warning row, signal to update jollimemory |
| `unknown` | Anything else | UI warning row |

ENOENT (DB file absent) is **not** a scan error — it is treated as "Cursor not installed/never opened" and is silent.

`hasNodeSqliteSupport()` returning false (e.g. VS Code extension running on bundled Node 18) → `isCursorInstalled()` returns false; cursor support is disabled silently for that runtime.

---

## 6. Testing strategy

### 6.1 Unit tests (vitest, in-repo)

- `CursorDetector.test.ts` — mock `stat()` for `Cursor.app` and `state.vscdb`; verify `isCursorInstalled()` returns true only when both exist and `hasNodeSqliteSupport()` is true.
- `CursorSessionDiscoverer.test.ts` — fixture SQLite databases (created in test setup with `node:sqlite`):
    - empty global DB → `[]`
    - global DB with composerData rows but no matching workspace → `[]` (β′ Step 1 fails)
    - global DB + workspace.json + per-workspace `composer.composerData` pointer → returns anchor composer
    - time-window expansion includes additional composers with `lastUpdatedAt` in window
    - duplicates between anchor set and window set are deduped
    - case-insensitive workspace folder match on darwin/win32
    - URL-decoding of `file://` URIs (paths with spaces, unicode)
    - SQLITE_CORRUPT / EACCES → `OpenCodeScanError` returned (no exception escapes)
- `CursorTranscriptReader.test.ts` —
    - synthetic path parsing (missing `#`, empty parts, → throws)
    - bubble ordering follows `fullConversationHeadersOnly`
    - empty `text` skipped
    - cursor resumption (skip already-read bubbles)
    - `beforeTimestamp` cutoff respected
    - bubble.type → human/assistant mapping (see §6.2 for fixture sourcing)

### 6.2 The bubble.type ↔ role mapping

Empirical assumption: `type: 1` = user, `type: 2` = assistant. **This must be confirmed during implementation** by:
1. Creating fixture composer with one user message and one assistant message via real Cursor.
2. Reading the resulting `bubbleId:*` rows.
3. Asserting the mapping.

If the mapping is reversed or richer (e.g. tool-result bubbles get a third type), the reader's mapping table is the only place that changes. The single source of truth lives in `CursorTranscriptReader.ts` as a small constant map; tests pin it.

### 6.3 Coverage budget

Same threshold as the rest of `cli/src/` (97% statements, 96% branches, 97% functions, 97% lines per `cli/vite.config.ts`). New code should not regress totals.

---

## 7. Open issues, risks, and explicitly deferred work

### 7.1 Risk: Cursor schema drift

Cursor is closed-source and ships frequently. `cursorDiskKV` schema is undocumented. If a future Cursor release renames `composerData` keys or restructures `fullConversationHeadersOnly`, the discoverer/reader silently produces empty transcripts. Mitigation:

- Surface `kind: "schema"` errors loudly in `jolli status`.
- Pin a tiny structural smoke-test fixture (a tarred minimal `state.vscdb`) committed to the repo, regenerated when known-good Cursor versions are tested.

### 7.2 `richText` is unused — Phase 2

Cursor stores message content twice: `text` (plain) and `richText` (ProseMirror JSON). The `text` field is sufficient for v1. If `text` is ever empty when `richText` is non-empty (e.g. a code-block-only message), the bubble is dropped. **Phase 2** would add a minimal ProseMirror walker; estimated +50 LoC.

### 7.3 Risk: workspace match miss

If the user opens a project in Cursor via a symlinked path or a dev-container path, `workspace.json.folder` will not equal `process.cwd()`. The β′ algorithm degrades to "no anchor, time-window only" — still functional, slightly less precise. Documented; not addressed in v1.

### 7.4 Refactor: `SqliteHelpers.ts` extraction

`OpenCodeSessionDiscoverer.ts` exports `withOpenCodeDb`, `hasNodeSqliteSupport`, `NODE_SQLITE_MIN_VERSION`, and `classifyScanError` — all of which are **not OpenCode-specific**. With Cursor as a second SQLite-based source, these belong in a shared file:

- New file: `cli/src/core/SqliteHelpers.ts` containing `withSqliteDb`, `hasNodeSqliteSupport`, `NODE_SQLITE_MIN_VERSION`, and `classifyScanError` (renamed from OpenCode-specific names).
- `OpenCodeSessionDiscoverer.ts` imports from the new file instead of defining them.
- `CursorSessionDiscoverer.ts` imports from the new file from day one.

This is in scope because it directly serves the current goal — without it, the same logic would be duplicated. Tests for `classifyScanError` move to `SqliteHelpers.test.ts`.

### 7.5 Out of scope

- `node:sqlite` is Node 22.5+. The VS Code extension bundles Node 18 (per `CLAUDE.md`). On that runtime, cursor support is disabled the same way OpenCode currently is — `hasNodeSqliteSupport()` returns false, `isCursorInstalled()` returns false, no UI surface.
- `intellij/` plugin: no change. The IntelliJ port writes to the same orphan branch + `~/.jolli/jollimemory/` state, but it has its own session-discovery surface (none for OpenCode/Cursor today; adding parity is a separate workstream).

---

## 8. Implementation order

Suggested sequence for the implementation plan that follows this spec:

1. Extract `SqliteHelpers.ts` from `OpenCodeSessionDiscoverer.ts`. Confirm `npm run all` still green. **Pure refactor commit.**
2. Add `TranscriptSource` literal `"cursor"` and config/status fields to `Types.ts`. Wire `filterSessionsByEnabledIntegrations`. Type-only commit, tests should still pass.
3. Implement `CursorDetector.ts` + tests.
4. Implement `CursorSessionDiscoverer.ts` (β′ algorithm) + tests.
5. Implement `CursorTranscriptReader.ts` + tests. **Confirm `bubble.type` → role mapping using a real Cursor fixture before merging.**
6. Wire `QueueWorker.ts` discoverer fan-out and `Installer.ts` setup hint.
7. Update `getStatus` / `StatusCommand` to surface `cursorDetected` / `cursorEnabled` / `cursorScanError`.
8. End-to-end smoke test on the implementer's own Cursor: real composer in `feature-support-cursor` workspace → make a commit → verify the resulting summary references the Cursor conversation content.

---

## 9. Things this PR will explicitly **not** touch

(Per the user's "intentionally unchanged" PR-summary norm.)

- `vscode/` — no marketplace, host detection, or `engines.vscode` work.
- `intellij/` — no Kotlin port of the discoverer.
- The `jollimemory/summaries/v3` orphan branch format.
- `~/.jolli/jollimemory/` runtime state shape (no new files, no cursor-specific subdirectory).
- `cli/src/install/ClaudeHookInstaller.ts`, `GeminiHookInstaller.ts`, `GitHookInstaller.ts` — no Cursor-side hook because Cursor exposes no hook protocol.
- `chatSessions/*.jsonl` reading — verified empty of conversation content.
