# Ingest phase indicator — design

**Date:** 2026-06-10
**Status:** Approved (pending spec review)

## Problem

The VS Code sidebar shows a single status string — `AI summary in progress…` —
whenever the post-commit `QueueWorker` holds `worker.lock`. The worker drains
several kinds of operations under that lock:

- **summary generation** — real LLM call (~20–40s)
- **rebase-pick migration** — 1:1 hash migration, no LLM, sub-second
- **topic-KB ingest** — re-aggregates cross-commit topics and regenerates the
  `_wiki` (observed ~84s in the wild)

Because the busy signal is a single boolean fed by the lock file, all three
render the same `AI summary in progress…` label. During an ingest the user sees
"AI summary in progress" even though no summary is being generated. This was
hit directly after a `git rebase`: the rebase-pick migrated 1:1 (no LLM), then
a chain-spawned worker ran the ingest for ~84s under the same label.

### Root cause

The worker phase is a binary black box to the extension:

- `QueueWorker` holds one `worker.lock` for the whole drain
  ([`cli/src/core/Locks.ts`](../../../cli/src/core/Locks.ts)).
- The extension watches `worker.lock` via a `FileSystemWatcher`; present →
  `setWorkerBusy(true)`, deleted → `false`
  ([`vscode/src/Extension.ts`](../../../vscode/src/Extension.ts) ~1411–1463).
- `workerBusy` is a single boolean
  ([`vscode/src/stores/StatusStore.ts`](../../../vscode/src/stores/StatusStore.ts)),
  and `SidebarScriptBuilder` hard-codes `AI summary in progress…` when it is
  true ([`vscode/src/views/SidebarScriptBuilder.ts`](../../../vscode/src/views/SidebarScriptBuilder.ts) ~425).

The lock's create/delete only brackets the *entire* drain, so the lock alone
cannot distinguish phases. The worker must emit a phase signal that the
extension reads.

## Scope

**Only the ingest phase is split out.** Summary generation and rebase-pick
migration keep showing `AI summary in progress…`. This is a deliberate YAGNI
boundary — the signaling channel is built so future phases can be added by one
enum value, but we do not enumerate them now.

- **Label:** `Updating Memory Bank…` (English, to match the existing
  English-only sidebar UI; the Chinese gloss is "正在更新记忆库").

## Approach

Three options were considered for the worker → extension signal (the worker is
a detached process, so only file IPC is available):

- **A — dedicated phase marker file + new watcher (chosen).** Clean single
  purpose, mirrors the existing lock-watcher pattern, extensible by one enum
  value, does not touch the IntelliJ-shared lock format.
- **B — write phase into `worker.lock` content, reuse the lock watcher.**
  Rejected: overloads the mutual-exclusion lock with status data; `worker.lock`
  format is owned by `Locks.ts` and shared with IntelliJ, so the format change
  ripples cross-surface.
- **C — reuse the `syncPhase` channel.** Rejected: `syncPhase` is the in-process
  Memory Bank *sync* engine channel (download/merge/upload); the detached worker
  cannot reach it without a file bridge anyway, and reusing it muddies its
  meaning.

## Design

### 1. Worker side (`cli/`)

In [`QueueWorker.ts`](../../../cli/src/hooks/QueueWorker.ts), wrap the ingest
branch (`isIngestOperation(op)` → `runIngestFromQueue`, ~484–486):

- Before ingest starts: write `<projectDir>/.jolli/jollimemory/worker-phase`
  with content `ingest`.
- `try / finally`: delete the file on both success and failure.
- All other operations (summary, rebase-pick) do **not** write it — absent file
  = default `AI summary in progress…`, matching the "only ingest" scope.
- Resolve the path via `getJolliMemoryDir(cwd)` (same dir as sessions/cursors;
  worktree-aware).

**Crash fallback:** a stale `worker-phase` left by a crashed worker does not
mislead for long because the extension binds the phase lifetime to the lock —
when `worker.lock` disappears (release or 5-min stale), the phase is forced to
null. So the phase file needs no independent staleness logic.

### 2. Extension side (`vscode/`)

**a. `StatusStore` — new phase field** (parallel to `workerBusy`, mirroring the
existing `syncPhase` shape):

- `private workerPhase: "ingest" | null = null`, added to `StatusSnapshot`.
- `setWorkerPhase(phase)` with equality short-circuit (like `setSyncPhase`).
- `changeReason` union gains `"workerPhase"`.
- **Invariant:** `setWorkerBusy(false)` also forces `workerPhase = null` — this
  is the crash-fallback landing point.

**b. `Extension.ts` — phase watcher** (next to the existing lock watcher,
~1411–1463):

- `createFileSystemWatcher` on `worker-phase`.
- `onDidCreate / onDidChange`: read content; `=== "ingest"` →
  `statusStore.setWorkerPhase("ingest")`.
- `onDidDelete`: `setWorkerPhase(null)`.
- The existing `lockWatcher.onDidDelete` path keeps clearing phase via the
  StatusStore busy→false invariant; no extra disk read there.
- Beside the startup `isWorkerBusy(...).then(setWorkerBusy)`, add a one-shot
  initial read of the phase file (covers "extension started while worker is
  already ingesting").

**c. `SidebarScriptBuilder` — label selection** (replace the hard-coded line at
~425):

```
workerBusy && phase === 'ingest'
  ? { label: 'Updating Memory Bank…', severity: 'info' }
  : { label: 'AI summary in progress…', severity: 'info' }   // unchanged
```

The phase rides the existing snapshot → webview push path (same channel as
`workerBusy`); no new webview protocol message.

### Data flow

```
QueueWorker(ingest entry) ──write worker-phase=ingest──> disk
        │                                                 │
        └─ finally: delete file                  FileSystemWatcher (ext)
                                                          │
                                             StatusStore.setWorkerPhase
                                                          │
                                       snapshot ──push──> webview ──> toolbar label
        worker.lock gone ──> workerBusy=false ──(invariant)──> workerPhase=null
```

## Testing

- **cli (97% threshold):** `QueueWorker` ingest branch writes the phase file and
  deletes it in `finally`; non-ingest operations do not write it.
- **vscode:** `StatusStore` — `setWorkerPhase` equality short-circuit; the
  `setWorkerBusy(false)` → clears phase invariant. `SidebarScriptBuilder` —
  busy + ingest → `Updating Memory Bank…`; busy + no phase → still
  `AI summary in progress…`.

## Intentionally unchanged

- `worker.lock` format / `Locks.ts` (so the IntelliJ-shared format is untouched).
- The `syncPhase` channel (Memory Bank sync engine; not reused).
- Labels for rebase-pick / squash / summary phases (only ingest is split out).
