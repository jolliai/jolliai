# GitHub Copilot CLI as a Transcript Source — Design

**Date:** 2026-05-05
**Status:** Approved for implementation
**Branch:** `feature-support-copilot`
**Precedent:** [`feature-support-cursor`](../../../) (commit `af74e2cb`)

## Summary

Add GitHub Copilot CLI as the sixth AI agent transcript source, alongside Claude Code, Codex, Gemini, OpenCode, and Cursor. Copilot CLI is treated as a *discovery-based* source (like OpenCode and Cursor): jollimemory scans the user's `~/.copilot/session-store.db` SQLite database during the post-commit pipeline, matches sessions to the current working directory via the database's own `cwd` column, and reads the conversation from the `turns` table. No agent hook is installed because Copilot CLI exposes no hook surface; integration is read-only.

## Goals

- Treat Copilot CLI sessions as first-class peers of Cursor / OpenCode / Codex sessions: same enable/disable semantics, same status reporting, same surfacing in the Settings UI and Summary Details panel.
- Auto-detect Copilot CLI on installer first run and enable the integration by default; never overwrite an explicit user choice.
- Surface SQLite scan errors (corrupt DB, locked WAL, schema mismatch, permission denied) to the UI with a structured error kind, not silent zero-session results.
- Extract a shared `SqliteHelpers` module from `OpenCodeSessionDiscoverer` and use it from the new Copilot modules — no new dependency, no second SQLite stack. (See *Relation to PR #65* below.)
- Achieve coverage parity with the Cursor integration (≥97% statements/lines on the new modules) so the CLI workspace's coverage gate stays green.

## Non-goals

- **No hook script.** The Copilot CLI binary exposes no `stop` / `after-turn` / `notify` hook (verified via `copilot --help`); the only externally-visible export is `--share[=path]`, a user-initiated markdown dump. We rely on discovery only.
- **No use of `~/.copilot/session-state/<id>/`.** That directory contains richer artifacts (`workspace.yaml`, `checkpoints/index.md`, `files/`, `research/`, `inuse.<pid>.lock`) but the `turns` table is sufficient for transcript summarization. Bringing in the side-state would add format-drift risk for marginal gain. (Revisit if LLM summary quality complains.)
- **No write to the Copilot DB.** All access is read-only (`DatabaseSync(path, { readOnly: true })`) so we never collide with the `inuse.<pid>.lock` semantics or risk corrupting a live session.
- **No Cursor-style pointer + time-window heuristic.** Copilot stores `cwd` directly on each session row, so workspace attribution is exact. Time-window logic is unnecessary and would only add false positives.
- **No Windows CI verification this iteration.** Path logic supports `%USERPROFILE%/.copilot` for parity with cursor/opencode discoverers, but live testing is macOS/Linux only. Documented as a known gap; revisit on first Windows user report.
- **No FTS5 search-index reads.** The `search_index` virtual table is Copilot's own internal index; not part of this scope.

## Observed Reality

Verified hands-on on 2026-05-05 against GitHub Copilot CLI v1.0.40 on macOS 14, with the CLI process actively running (lock file `inuse.12190.lock` present).

### On-disk layout

```
~/.copilot/
├── config.json                       # {"firstLaunchAt": "..."} — not used by us
├── command-history-state.json
├── session-store.db                  # SQLite 3.x, journal_mode=wal  ← we read this
├── session-store.db-wal              # ~200 KB live; pure-JS SQLite cannot read this
├── session-store.db-shm
├── ide/<uuid>.lock                   # IDE bridge locks — not used
├── logs/process-*.log                # not used
└── session-state/<session-id>/       # per-session richer state — not used
    ├── workspace.yaml                # mirrors the sessions row
    ├── checkpoints/index.md          # high-level plan
    ├── inuse.<pid>.lock              # PID file while session is active
    ├── files/, research/             # tool outputs
```

### `session-store.db` schema (relevant subset)

```sql
sessions(id TEXT PK, cwd TEXT, repository TEXT, host_type TEXT,
         branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT)
turns(id INTEGER PK AUTOINCREMENT, session_id TEXT FK, turn_index INTEGER,
      user_message TEXT, assistant_response TEXT, timestamp TEXT,
      UNIQUE(session_id, turn_index))
checkpoints, session_files, session_refs, search_index (FTS5)  -- not used
```

`PRAGMA journal_mode → wal`, `PRAGMA user_version → 0`. Schema has no formal version field; we treat it as drift-prone (validate each row, skip-and-warn on malformed).

### Runtime state

- WAL is the default and sibling files contain the most recent ~200 KB of writes. **Anything that cannot read `*.db-wal` (sql.js, better-sqlite3 in some configs, custom WASM) returns wrong/empty data.** We use `node:sqlite` (Node 22.5+ native), already in use for OpenCode and Cursor.
- The `inuse.<pid>.lock` file does not block SQLite read access; we only read.
- Sessions appear in the table at session start (verified: a freshly-started session with zero turns still has its `sessions` row), so `cwd` matching works from the moment Copilot opens.

### Smoke test

```js
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(`${HOME}/.copilot/session-store.db`, { readOnly: true });
db.prepare("SELECT cwd FROM sessions LIMIT 1").get();
// → { cwd: '/Users/flyer/jolli/code/jollimemory' }
```

Passed against a live Copilot CLI process (WAL active, lock file present) — proves the chosen library works in production runtime state, not just at-rest fixtures.

## Architecture

Copilot integration mirrors Cursor's structure 1:1, only swapping the discovery algorithm (exact `cwd` match instead of pointer + 48h time-window). All other layers — Types, SessionTracker filter, Installer auto-enable, status reporting, CLI commands, VSCode panels — follow the existing template.

### New CLI modules (`cli/src/core/`)

| File | Responsibility |
|---|---|
| `CopilotDetector.ts` | Exports `isCopilotInstalled(): Promise<boolean>` (gates on Node version + file existence) and `getCopilotDbPath(): string`. Callers compose these two — no aggregate return shape. |
| `CopilotSessionDiscoverer.ts` | `withSqliteDb(dbPath, db => …)` to run `SELECT id, cwd, repository, branch, host_type, summary, created_at, updated_at FROM sessions WHERE cwd = ?` (with normalized cwd). Return one entry per matching session, `transcriptPath = "<dbPath>#<sessionId>"`, `lastUpdatedAt = parse(updated_at)`. Classify failures via `classifyScanError` from `SqliteHelpers`. |
| `SqliteHelpers.ts` | Extracted from `OpenCodeSessionDiscoverer.ts` as a pure refactor (separate commit, zero behavior change). Exports `SqliteDbHandle`, `withSqliteDb`, `NODE_SQLITE_MIN_VERSION`, `hasNodeSqliteSupport`, `classifyScanError`. OpenCode keeps its existing public symbols as deprecated re-exports for backward compatibility. |
| `CopilotTranscriptReader.ts` | Parse `<dbPath>#<sessionId>` → run `SELECT turn_index, user_message, assistant_response, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index` → emit one `{role:"human", text:user_message}` + one `{role:"assistant", text:assistant_response}` per row. Support read-cursor incremental reads — resume from a stored `turn_index` (this is jollimemory's internal read cursor, unrelated to the Cursor IDE source) and a `since` timestamp cutoff to align with the commit window. Skip rows with empty/null messages. |

### Type and config additions

- [`cli/src/Types.ts`](../../cli/src/Types.ts): add `"copilot"` to `TranscriptSource`; add `copilotEnabled?: boolean` on `JolliMemoryConfig`; add `copilotDetected: boolean`, `copilotEnabled: boolean`, `copilotScanError?: { kind: "corrupt"|"locked"|"permission"|"schema"|"unknown"; message: string }` to `StatusInfo`.
- [`cli/src/core/SessionTracker.ts`](../../cli/src/core/SessionTracker.ts): add a copilot branch to `filterSessionsByEnabledIntegrations`.

### Pipeline wiring

- [`cli/src/hooks/QueueWorker.ts`](../../cli/src/hooks/QueueWorker.ts): mirror the Cursor block — call `scanCopilotSessions()` when `copilotEnabled && copilotDetected`, append to active sessions, route reads to `CopilotTranscriptReader`. Reuse the `Source` keying pattern.
- [`cli/src/install/Installer.ts`](../../cli/src/install/Installer.ts): on detect-and-undefined, set `copilotEnabled: true`. Never overwrite an explicit `false`. Surface `copilotScanError` via `getStatus()`.

### CLI surface

- [`cli/src/commands/StatusCommand.ts`](../../cli/src/commands/StatusCommand.ts): integration row "Copilot" mirroring Cursor's row.
- [`cli/src/commands/ConfigureCommand.ts`](../../cli/src/commands/ConfigureCommand.ts): accept `copilotEnabled` key with boolean coercion + Node 22.5+ help note.

### VSCode surface

- [`vscode/src/providers/StatusTreeProvider.ts`](../../vscode/src/providers/StatusTreeProvider.ts): Copilot row with `pushIntegrationItem` for healthy state, error row when `copilotScanError` is set.
- [`vscode/src/views/SummaryWebviewPanel.ts`](../../vscode/src/views/SummaryWebviewPanel.ts) + [`SummaryScriptBuilder.ts`](../../vscode/src/views/SummaryScriptBuilder.ts): include `"copilot"` in `getEnabledSources()` and `sourceOrder`, label `"Copilot"`.
- [`vscode/src/views/SettingsHtmlBuilder.ts`](../../vscode/src/views/SettingsHtmlBuilder.ts) + [`SettingsScriptBuilder.ts`](../../vscode/src/views/SettingsScriptBuilder.ts) + [`SettingsWebviewPanel.ts`](../../vscode/src/views/SettingsWebviewPanel.ts): toggle row "Copilot" with description "Session discovery via Copilot CLI's local SQLite store"; include in dirty-detection, validation ("at least one integration"), and the load/save payload.

### Data flow (per post-commit)

```
QueueWorker (post-commit)
  → CopilotDetector.detect()                  → {installed, dbPath}
  → CopilotSessionDiscoverer.scan(cwd, dbPath) → [{ id, transcriptPath, lastUpdatedAt, ... }]
  → for each new/changed session:
      CopilotTranscriptReader.read(transcriptPath, { since, fromTurnIndex })
       → BubbleStream → existing summarizer pipeline
  → status report includes copilotDetected / copilotEnabled / copilotScanError
```

## Design choices (with rationale)

1. **Exact `cwd` match, normalized via `path.resolve`.** Strips trailing slashes, no `realpath`. Rationale: Copilot writes the user's literal `cwd` as it was at session start; symlink chase is rare in practice and adds I/O. Edge case (macOS `/var` ↔ `/private/var`) is left to a follow-up if it bites.
2. **No time-window fallback.** `cwd` is a strong signal; adding a 48h window only invites unrelated workspace bleed-through.
3. **Read-only DB handle.** Confirmed compatible with Copilot's own writer via WAL; avoids any chance of locking interference.
4. **Schema-drift defensive coding.** Validate every read field (non-null `id`, finite parsed timestamp, non-empty messages); silently skip malformed rows; warn at the discoverer level. Same posture as Cursor.
5. **`transcriptPath = "<dbPath>#<sessionId>"`.** Reuses the OpenCode/Cursor encoding so existing cursor-tracking and dedup machinery in `SessionTracker` works without special-casing.
6. **`SqliteHelpers` extraction in this PR.** The Cursor PR (#65) plans the same extraction but is still open and not in main. Rather than wait or duplicate the SQLite open/error logic into a third copy, we land the pure-refactor extraction here (separate commit, zero behavior change), then build Copilot on top. Cursor's PR will resolve the conflict by deleting its own copy of `SqliteHelpers` — the public surface is intentionally identical so the merge is mechanical.

## Testing strategy

Mirror Cursor's coverage pattern; expect ~97% on the three new modules.

- **Unit tests** with fixture DBs constructed via `node:sqlite` directly (same approach as `OpenCodeSessionDiscoverer.test.ts`):
  - `CopilotSessionDiscoverer.test.ts`: cwd match / no match, repository field exposure, malformed timestamp skipped, missing-id row skipped, classified errors (corrupt / locked / permission), URL-decoded path edge cases (parity with Cursor's path matching), `path.resolve` normalization (trailing slash).
  - `CopilotTranscriptReader.test.ts`: parse `dbPath#sessionId`, ordered turn rendering, role mapping (`user_message` → human, `assistant_response` → assistant), empty-message filtering, read-cursor resume from a `turn_index`, `since` timestamp cutoff, missing-session error, malformed-row skip.
  - `CopilotDetector.test.ts`: present / absent DB, Node-version gating, Windows path branch via mocked `os.homedir()` + `os.platform()`.
- **QueueWorker** pipeline tests: two new cases (happy path with copilot sessions; `copilotEnabled=false` short-circuits discovery) — verifies the new ~12 lines of pipeline glue actually execute.
- **VSCode panel tests**: extend the same files Cursor touched (`StatusTreeProvider.test.ts`, `SummaryWebviewPanel.test.ts`, `SummaryScriptBuilder.test.ts`, `SettingsHtmlBuilder.test.ts`, `SettingsScriptBuilder.test.ts`, `SettingsWebviewPanel.test.ts`) with one happy-path + one error-path assertion each.
- **No live-Copilot integration test in CI.** Test fixtures construct realistic SQLite state; live-data smoke test was performed manually during discovery and is documented in this spec.

## Intentionally not done (per project convention)

These are out of scope for this PR; listing them so reviewers can see the decisions were deliberate and not omissions.

- `~/.copilot/session-state/<id>/checkpoints/index.md` and the `checkpoints` DB table — Copilot CLI's own conversation-compression nodes (user-triggered via `/summarize` or auto-triggered when the context window fills), structured as `{title, overview, history, work_done, technical_details, important_files, next_steps}` per checkpoint. **Not** ingested for three reasons:
  1. **Slicing mismatch.** Checkpoints are cut on Copilot's own context-window / user trigger, not on git-commit boundaries. jollimemory's contract is "summary per commit", and using Copilot's pre-summarized text would let Copilot's slicing override that contract.
  2. **Existence is optional.** A session with no `/summarize` call has zero checkpoint rows (verified locally on the live session — `index.md` is empty header only). The `turns` table, by contrast, has one row per interaction. Transcript must come from `turns`.
  3. **Drift surface.** `turns` has 4 stable columns; `checkpoints` has 7 semantic fields and is the area of the Copilot CLI schema most likely to evolve.

  Possible follow-up: if downstream summary quality is poor on long sessions, inject the latest checkpoint's `overview + work_done + technical_details + important_files` as **supplemental context** to the existing turns-based summarizer prompt — never as a replacement. Tracked as a separate ticket if/when needed.
- `session_files`, `session_refs`, FTS5 `search_index` tables — not read.
- `--share[=path]` markdown export — not consumed; users who want it can pipe manually.
- Windows CI testing — code path supported, live verification deferred.
- Hook-based integration — Copilot CLI exposes no hook; not implementable without upstream changes.
- New top-level dependency — none introduced. (`node:sqlite` already in use.)

## Open questions

None at design time. Surface them in implementation if the schema turns out to differ across Copilot CLI versions (current target: 1.0.x).

## Relation to PR #65 (Cursor IDE support)

PR #65 (`feature-support-cursor`) and this branch (`feature-support-copilot`) both add a new SQLite-backed transcript source and both want the same `SqliteHelpers` module abstracted out of `OpenCodeSessionDiscoverer`. PR #65 is currently OPEN and has not landed on main, so this branch cannot import a `SqliteHelpers` module that does not exist.

Strategy:

- This PR includes a standalone **pure-refactor commit** that extracts `SqliteHelpers` from `OpenCodeSessionDiscoverer.ts`, with the *same public symbols* PR #65 plans to expose (`SqliteDbHandle`, `withSqliteDb`, `NODE_SQLITE_MIN_VERSION`, `hasNodeSqliteSupport`, `classifyScanError`). OpenCode keeps deprecated re-exports for backward compatibility.
- Whichever PR merges first owns the extraction. The second PR resolves the conflict by deleting its own copy of `SqliteHelpers.ts` and keeping the rest of its changes — no API drift because the surface was designed to match.
- Coordinated via PR descriptions; no shared branch or rebase chain required.

## Rollout

Same as Cursor: ships in the next CLI minor + matching VSCode patch. No migration. No flag. Auto-detected on installer run; users who don't have Copilot CLI installed see no change.
