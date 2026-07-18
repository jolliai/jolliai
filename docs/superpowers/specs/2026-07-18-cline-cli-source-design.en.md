# Cline Session Source Integration Design (CLI + VS Code Extension)

> Date: 2026-07-18
> Scope: the summary triplet (session capture → memory), for **two independent sources**: Cline CLI + Cline VS Code extension. Excludes MCP registration and references extraction.

## Goal

Let jollimemory capture sessions produced by **both forms of Cline**, reading their transcripts at post-commit time and generating commit summaries, consistent with existing "hook-less sources" like Cursor / Copilot Chat / OpenCode:

1. **Cline CLI** — `~/.cline/`, a terminal TUI, the `cline` binary.
2. **Cline VS Code extension** — `saoudrizwan.claude-dev`, data under VS Code globalStorage.

The two have **completely different storage locations, file names, and message schemas** (see Observed Reality), so each is implemented as an **independent triplet**, but per the CLAUDE.md rule (Copilot CLI + Copilot Chat, same product, share one `copilotEnabled`) they **share a single `clineEnabled` config flag**.

**Explicitly out of scope (this round):** MCP registration (Cline supports it via `cline_mcp_settings.json` — separate PR), references extraction (`ClineEnvelopeParser` — separate PR), git-hook install changes (Cline is hook-less).

## Source ids and naming

Following the Copilot precedent (bare-name file = bare-name source id). **The extension is Cline's flagship form (far more users than the CLI), so it takes the bare name:**

| Form | `TranscriptSource` id | Label | Triplet file prefix |
|---|---|---|---|
| VS Code extension | `"cline"` | `Cline (VS Code)` | `Cline*` (`ClineDetector.ts`, …) |
| CLI | `"cline-cli"` | `Cline CLI` | `ClineCli*` |

## Observed Reality (verified on a real machine, 2026-07-18)

> This section is mandated by integrating-external-systems: every conclusion comes from real runtime bytes on this machine, not documentation or an imagined fixture. Both forms were driven through a real task on this machine and captured.

### A. Cline CLI

- Data root: `~/.cline/data/` = `<home>/.cline/data`, **home-relative and consistent cross-platform** (Windows `%USERPROFILE%\.cline\data`, Linux `$HOME/.cline/data`); confirm during the plan whether a `CLINE_DIR`/XDG env override exists and, if so, prefer it.
- Layout:

```
~/.cline/data/
├── db/sessions.db(+.db-wal/.db-shm)   ← SQLite, journal_mode=WAL
├── sessions/<id>/<id>.json            ← metadata sidecar (plain JSON)
└── sessions/<id>/<id>.messages.json   ← transcript (plain JSON, single object)
```

- **WAL trap — reproduced live:** the `sessions.db` main file is only **4096 bytes (empty)**; the single session row lives entirely in `sessions.db-wal` (~99 KB). The system `sqlite3` (native, WAL-aware) reads it; `sql.js` (pure JS/WASM, the same one from OpenCode PR #834) reads only the main file → **0 sessions**. **Therefore the CLI discovery layer does not read SQLite; it scans the plain `sessions/<id>/` directory tree.**
- Sidecar `<id>.json` top-level: `session_id, source("cli"), started_at, status, provider, model, cwd, workspace_root, prompt, metadata{git.{url,branch}, checkpoint, title, usage}, messages_path`. **No `updated_at`** → use the mtime of `<id>.messages.json`.
- Transcript `<id>.messages.json`: **a single JSON object** `{version, updated_at, agent, sessionId, messages[], system_prompt}`. Each message: `{id, role:"user"|"assistant", content:[blocks], ts:epochMs, modelInfo?, metrics?}`.
- Four block types: `text{text}` / `thinking{thinking}` / `tool_use{id,name,input}` / `tool_result{tool_use_id,name,content:[{query,result,success}]}`.
- **Special case:** user text is wrapped in `<user_input mode="act|plan|yolo">…</user_input>`; the reader/title parser must unwrap it.
- The transcript is **rewritten whole** (top-level `updated_at`), not JSONL → the cursor is a message index.

### B. Cline VS Code extension

- Data root: `<vscodeUserDataDir>/User/globalStorage/saoudrizwan.claude-dev/`. **Scanned across all VS Code flavors** (`Code` / `Code - Insiders` / `Cursor` / `Windsurf` / `VSCodium`).
  - **Verified current state:** `VscodeWorkspaceLocator.ts:24`'s `VscodeFlavor` currently has only `"Cursor" | "Code"`; CopilotChat does **not** iterate multiple flavors (no existing precedent to copy).
  - This source therefore needs: (a) **extending the `VscodeFlavor` union** to add Insiders/Windsurf/VSCodium (the file header comment already states "only requires extending the union", with each flavor's `getVscodeUserDataDir` path mapping); (b) a new `ALL_VSCODE_FLAVORS` list iterated in the detector/discoverer. When several flavors hit, sessions are merged.
- Layout:

```
globalStorage/saoudrizwan.claude-dev/
├── state/taskHistory.json          ← discovery index (plain JSON array)
├── tasks/<taskId>/
│   ├── api_conversation_history.json   ← transcript (Anthropic-native array)
│   ├── ui_messages.json                ← UI event stream (has ts, command, … — unused here)
│   ├── task_metadata.json              ← files_in_context / model_usage / env
│   └── focus_chain_taskid_*.md
├── settings/cline_mcp_settings.json    ← MCP (unused here)
└── checkpoints/  cache/
```

- **No transcript database, no WAL trap** — all plain JSON.
- Index `state/taskHistory.json`: an **array** `[{id, ulid, ts:epochMs, task, tokensIn/Out, totalCost, size, cwdOnTaskInitialization, isFavorited, modelId}]`. **Project attribution uses `cwdOnTaskInitialization`**; `ts` is updatedAt; `task` is the title.
- Transcript `tasks/<id>/api_conversation_history.json`: an **Anthropic-native array** `[{role, content:[blocks], ts:epochMs}]`. **Each message carries `ts`** (keys=`content,role,ts`) → `beforeTimestamp` attribution can use `ts` directly, with no need to correlate `ui_messages.json`.
- Blocks: `text` / `thinking` / Anthropic-native `tool_use` / `tool_result`. Only `text` blocks carry prose — `thinking`/`tool_use`/`tool_result` blocks are dropped by the reader.
- **User-turn shape (differs from the CLI's `<user_input>`):** a `role:"user"` turn is **not** bare human text. Cline injects, as sibling `text` blocks: a `# task_progress RECOMMENDED …` boilerplate block (first turn), an `<environment_details>…</environment_details>` scaffolding block (open tabs / file tree / clock, multi-KB), and — because Cline replays the API conversation — tool results echoed as plain `[<tool> …] Result:` text **under role `user`** (not assistant). The real human prose is wrapped in `<task>…</task>` (first turn) or `<feedback>…</feedback>` (later turns). The reader must unwrap task/feedback and drop the boilerplate + scaffolding + tool-result echoes, else the ~6-char task drowns in ~7 KB of noise and tool output is mis-attributed as human speech.
- **Provider-dependent pitfall (observed):** the captured fixture used deepseek-v4-flash, whose tool **calls** land as **XML-in-text** (e.g. `<execute_command>…`) inside a `text` block rather than a native `tool_use` block; Anthropic-family models use native blocks. The reader keeps assistant text raw (so XML-in-text tool calls survive verbatim — degrade gracefully) and drops native `tool_use`/`tool_result` blocks (only `text` is extracted). Both representations are covered by `ClineTranscriptReader.test.ts`.

## Architecture

Two triplets (`cli/src/core/`), each shedding the complexity it doesn't need. Both readers share their cursor/merge/`beforeTimestamp` logic via a small helper module `ClineTranscriptShared.ts` (`ClineScanError`, `mapClineRole`, `buildClineReadResult`, `emptyClineReadResult`, `NormalizedMessage`); each reader only parses its file shape and normalizes messages before delegating.

### A. Cline CLI triplet (scans plain directories, bypassing WAL)

- **`ClineCliDetector.ts`**: `getClineCliDataDir(home?)` → `<home>/.cline/data`; `getClineCliSessionsDir(home?)`; `isClineCliInstalled()` → the `sessions/` dir exists (**no `node:sqlite` gate**, no SQLite reads).
- **`ClineCliSessionDiscoverer.ts`**: `ClineCliScanResult = {sessions, error?}`; `scanClineCliSessions(projectDir, sessionsDir?)` walks `sessions/*/` reading sidecars, attributing by `workspace_root` (falling back to `cwd`) via `normalizePathForCompare`; `updatedAt` = messages.json mtime; `transcriptPath = messages_path`; 48h stale window. `discoverClineCliSessions(projectDir)` is a thin wrapper.
- **`ClineCliTranscriptReader.ts`**: `readClineCliTranscript(path, cursor?, beforeTimestamp?)` reads the whole JSON → `messages[]`; **index cursor** (reuses `TranscriptCursor.lineNumber` as consumed count); `ts` filter; blocks → `TranscriptEntry` (unwrapping the user's `<user_input>` wrapper); `mergeConsecutiveEntries` at the end.

### B. Cline extension triplet (source id `cline`, scans globalStorage, all plain JSON)

- **`ClineDetector.ts`**: `getClineStorageDirs()` → iterates `ALL_VSCODE_FLAVORS` (the extended `VscodeFlavor`), each `getVscodeUserDataDir(flavor)` + `User/globalStorage/saoudrizwan.claude-dev`, returning the **existing** flavor dirs; `isClineInstalled()` → any flavor has `state/taskHistory.json` or `tasks/`.
- **`ClineSessionDiscoverer.ts`**: `scanClineSessions(projectDir, storageDirs?)` reads each hit flavor's `state/taskHistory.json` array and merges, attributing by `cwdOnTaskInitialization`; `updatedAt` = entry `ts`; `transcriptPath` = that flavor's `tasks/<id>/api_conversation_history.json`; `title` = `task`; 48h stale. `discoverClineSessions` is a thin wrapper.
- **`ClineTranscriptReader.ts`**: `readClineTranscript(path, cursor?, beforeTimestamp?)` reads the whole Anthropic-native array; **index cursor**; `ts` filter; extracts `text` blocks only (native `tool_use`/`tool_result`/`thinking` dropped); for user turns unwraps `<task>`/`<feedback>` and drops `# task_progress` boilerplate / `<environment_details>` / `[…] Result:` tool-result echoes, while assistant text is kept raw; `mergeConsecutiveEntries`.

## Wiring points (ripple map, one branch per source)

> A background Explore agent verified the anchors; each site below needs **one branch each for `cline` (extension) and `cline-cli` (CLI)**.

1. `cli/src/Types.ts`: add `"cline"`, `"cline-cli"` to `TRANSCRIPT_SOURCES`; add `clineEnabled?` to `JolliMemoryConfig` (**one flag governs both**); `StatusInfo` **merged display**: add one group `clineDetected?` (true if extension OR CLI detected) / `clineEnabled?` / `clineScanError?` — not a separate group per source.
2. `TranscriptSourceLabel.ts`: `cline:"Cline (VS Code)"`, `cline-cli:"Cline CLI"`.
2b. `cli/src/core/VscodeWorkspaceLocator.ts`: **extend the `VscodeFlavor` union** (`"Cursor" | "Code"` → add `"Code - Insiders" | "Windsurf" | "VSCodium"`), and export a new `ALL_VSCODE_FLAVORS`. (`getVscodeUserDataDir` uses `join(..., flavor)`, so the flavor string is the directory name — no mapping table needed. Existing `"Cursor"`/`"Code"` literal callers are unaffected by widening the union.)
3. `QueueWorker.ts`: two discovery blocks (`clineEnabled!==false && isClineInstalled()` / `…isClineCliInstalled()`); two reader-dispatch arms.
4. `TranscriptMessageCounter.ts`: two dispatch cases.
5. `TranscriptLoader.ts`: two JSON-file branches; add `"cline" | "cline-cli"` to the `JsonlSource` `Exclude<…>`.
6. `ActiveSessionAggregator.ts`: add `loadCline` (extension) + `loadClineCli` (CLI) to `Promise.all`.
7. `SessionTracker.ts`: `clineEnabled === false` filters both sources.
8. `SessionTitleResolver.ts`: `PARSE_LINE` gains `cline` + `cline-cli` (both stub parsers — sources carry `SessionInfo.title` from their discoverers).
9. `Installer.ts`: detect both, auto-enable (`clineEnabled === undefined` → `true`), status/scan for both.
10. `StatusCommand.ts`: **one merged "Cline" row** (shows the combined detected/enabled of extension + CLI), not a row per source.
11. `ConfigureCommand.ts`: `clineEnabled` in keys / boolean guard / descriptions (one flag).

**Untouched:** `references/**`, git-hook installer, `SkillInstaller`, MCP `HostRegistrars`, any SQLite dependency.

## Data flow

```
post-commit → QueueWorker.loadSessionTranscripts
  ├─ [cline-cli] clineEnabled!==false && isClineCliInstalled()
  │    → discoverClineCliSessions(cwd)  // scan ~/.cline/data/sessions/*/, by workspace_root
  │    → readClineCliTranscript(messages_path, cursor, beforeTs)
  └─ [cline]     clineEnabled!==false && isClineInstalled()
       → discoverClineSessions(cwd)     // read taskHistory.json, by cwdOnTaskInitialization
       → readClineTranscript(api_conversation_history.json, cursor, beforeTs)
  → feeds the existing summary pipeline (no difference from other sources)
```

## Error handling

- Root dir / index missing → the corresponding `isXInstalled()` returns `false`, the source is silently skipped.
- A single session/task failing to read or corrupt JSON → recorded as the corresponding `ScanError`, does not affect others, not thrown.
- Transcript parse failure → the reader returns empty entries + the original cursor (no advance).
- Missing CLI `<user_input>` wrapper / extension XML-in-text tools → lenient matching, degrades to raw text.

## Test strategy

- Six new triplet test files (`ClineCli*` ×3 = CLI, `Cline*` ×3 = extension), plus a shared-helper test.
- **Fixtures (block structure captured from this machine 2026-07-18, inlined into the reader tests with a provenance comment; paths/timestamps sanitized):**
  - CLI (`ClineCliTranscriptReader.test.ts`): covers text/thinking/native `tool_use`/`tool_result` + the `<user_input>` wrapper.
  - Extension (`ClineTranscriptReader.test.ts`): covers `<task>`/`<feedback>` unwrap, `# task_progress` boilerplate + `<environment_details>` strip, `[…] Result:` tool-result-as-user drop, **XML-in-text** tools (deepseek-family), and a dedicated **native `tool_use`/`tool_result`** case.
- Update shared dispatch tests to add both source branches: `TranscriptMessageCounter(.dispatch).test.ts`, `TranscriptLoader.test.ts`, `ActiveSessionAggregator.test.ts`, `SessionTracker.test.ts`, `SessionTitleResolver.test.ts`, `TranscriptSourceLabel.test.ts`, `QueueWorker.test.ts`, `Installer.test.ts`, `StatusCommand.test.ts`, `ConfigureCommand.test.ts`.
- Coverage floor: `cli/vite.config.ts` 97/96/97/97 (`Types.ts` exempt).

## Resolved decisions

- Source ids: bare `cline` = VS Code extension (flagship), `cline-cli` = CLI.
- CLI and extension share a single `clineEnabled` flag (Copilot precedent).
- Extension scanned across all VS Code flavors (Code/Insiders/Cursor/Windsurf/VSCodium).
- Status merged into one "Cline" row (not a row/field-group per source).
- Neither discovery layer reads SQLite (CLI scans plain dirs to bypass WAL; the extension has no DB).
- The two readers share cursor/merge/`beforeTimestamp` logic via `ClineTranscriptShared.ts` (deduplication chosen over self-contained readers).

## Open items (confirm during implementation)

- `TranscriptEntry` carries only role/content/timestamp — tool_use/tool_result/thinking blocks are intentionally dropped, keeping only `text` (matches every existing reader).
- Confirm whether the CLI honors a `CLINE_DIR`/XDG env override for the data root.
- Whether `metadata.git.branch` (CLI) / checkpoint should enrich attribution (default YAGNI; stays with `beforeTimestamp`).
