# Ingest Phase Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a distinct `Updating Memory Bank…` label on the sidebar Branch-tab toolbar while the post-commit worker is running a topic-KB ingest, instead of the generic `AI summary in progress…`.

**Architecture:** The detached `QueueWorker` writes a single-purpose marker file `.jolli/jollimemory/worker-phase` (content `ingest`) for the duration of an ingest entry and deletes it in `finally`. The VS Code extension watches that file with a `FileSystemWatcher`, feeds the phase into `StatusStore` (parallel to the existing `workerBusy` boolean, bound to it so a lost lock clears the phase), pushes it to the webview on its own `worker:phase` message (mirroring the existing `sync:phase` channel), and `SidebarScriptBuilder` selects the label from the phase.

**Tech Stack:** TypeScript (cli ESM + vscode esbuild/CJS bundle), Vitest, VS Code FileSystemWatcher, webview postMessage protocol.

**Spec:** [`docs/superpowers/specs/2026-06-10-ingest-phase-indicator-design.md`](../specs/2026-06-10-ingest-phase-indicator-design.md)

> **Execution note (user preference overrides skill default):** Do NOT run `npm run all` or commit per task. Each task writes its test + implementation only. A single consolidated verification + commit happens in the final task.

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| [`cli/src/core/Locks.ts`](../../../cli/src/core/Locks.ts) | Worker-status file name constants | Add `WORKER_PHASE_FILE` |
| [`cli/src/hooks/QueueWorker.ts`](../../../cli/src/hooks/QueueWorker.ts) | Drains queue; writes phase marker around ingest | Wrap ingest branch |
| [`cli/src/hooks/QueueWorker.test.ts`](../../../cli/src/hooks/QueueWorker.test.ts) | Worker tests | Add phase-marker tests |
| [`vscode/src/stores/StatusStore.ts`](../../../vscode/src/stores/StatusStore.ts) | Host-side status state | Add `workerPhase` field + setter + invariant |
| [`vscode/src/stores/StatusStore.test.ts`](../../../vscode/src/stores/StatusStore.test.ts) | StatusStore tests | Add phase tests |
| [`vscode/src/views/SidebarScriptBuilder.ts`](../../../vscode/src/views/SidebarScriptBuilder.ts) | Webview client JS (label, state, message handler) | Add phase state + handler + label selection |
| [`vscode/src/views/SidebarScriptBuilder.test.ts`](../../../vscode/src/views/SidebarScriptBuilder.test.ts) | Webview script tests | Assert generated JS |
| [`vscode/src/views/SidebarWebviewProvider.ts`](../../../vscode/src/views/SidebarWebviewProvider.ts) | Host→webview push | Add `getWorkerPhase` dep + `worker:phase` push |
| [`vscode/src/Extension.ts`](../../../vscode/src/Extension.ts) | Wires watchers + provider deps | Add phase watcher + dep wiring |

---

## Task 1: cli — phase-marker constant + worker writer

**Files:**
- Modify: `cli/src/core/Locks.ts` (near `WORKER_LOCK_FILE`, line ~90)
- Modify: `cli/src/hooks/QueueWorker.ts` (imports lines 20 & 95; ingest branch lines 484-488)
- Test: `cli/src/hooks/QueueWorker.test.ts` (inside `describe("runWorker — ingest dispatch", ...)`, line ~2130)

- [ ] **Step 1: Add the phase-file constant in `Locks.ts`**

Find (line ~90):

```typescript
export const WORKER_LOCK_FILE = "worker.lock";
```

Add immediately after it:

```typescript
/**
 * Cosmetic, best-effort marker the QueueWorker writes while running a phase the
 * UI should label specially (currently only `ingest`). Lives next to
 * `worker.lock` in `<cwd>/.jolli/jollimemory/`. It is NOT a lock and carries no
 * mutual-exclusion role — the extension reads it only to pick a toolbar label.
 * Its lifetime is bound to `worker.lock` on the reader side: when the lock
 * disappears the phase is forced to null, so a stale marker left by a crashed
 * worker cannot mislead beyond the lock's own staleness window.
 */
export const WORKER_PHASE_FILE = "worker-phase";
```

- [ ] **Step 2: Extend the fs + Logger imports in `QueueWorker.ts`**

Find (line 20):

```typescript
import { existsSync, readFileSync } from "node:fs";
```

Replace with:

```typescript
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

Find (line 95):

```typescript
import { createLogger, errMsg, setLogDir, setLogLevel } from "../Logger.js";
```

Replace with:

```typescript
import { createLogger, errMsg, getJolliMemoryDir, setLogDir, setLogLevel } from "../Logger.js";
```

Extend the existing Locks import (line 38):

```typescript
import { acquireWorkerLock, refreshWorkerLockMtime, releaseWorkerLock, withPlansLock } from "../core/Locks.js";
```

Replace with (add `WORKER_PHASE_FILE`):

```typescript
import { acquireWorkerLock, refreshWorkerLockMtime, releaseWorkerLock, withPlansLock, WORKER_PHASE_FILE } from "../core/Locks.js";
```

- [ ] **Step 3: Wrap the ingest branch with the phase marker in `QueueWorker.ts`**

Find (lines 484-488):

```typescript
	if (isIngestOperation(op)) {
		log.info("Processing queue entry: type=ingest triggeredBy=%s", op.triggeredBy);
		await runIngestFromQueue(op, cwd, storage);
		return;
	}
```

Replace with:

```typescript
	if (isIngestOperation(op)) {
		log.info("Processing queue entry: type=ingest triggeredBy=%s", op.triggeredBy);
		// Cosmetic phase marker so the VS Code toolbar shows "Updating Memory
		// Bank…" instead of "AI summary in progress…" during the (potentially
		// ~80s) topic-KB ingest. Best-effort: a write/delete failure must never
		// break ingest, so both ends are wrapped and logged at debug only.
		const phaseFile = join(getJolliMemoryDir(cwd), WORKER_PHASE_FILE);
		try {
			writeFileSync(phaseFile, "ingest");
		} catch (e) {
			log.debug("worker-phase write skipped (non-fatal): %s", errMsg(e));
		}
		try {
			await runIngestFromQueue(op, cwd, storage);
		} finally {
			try {
				rmSync(phaseFile, { force: true });
			} catch (e) {
				log.debug("worker-phase cleanup skipped (non-fatal): %s", errMsg(e));
			}
		}
		return;
	}
```

(`join` is already imported from `node:path` at line 21 — no import change needed.)

- [ ] **Step 4: Write the failing tests in `QueueWorker.test.ts`**

Add a `node:fs` + `node:os` + `node:path` import block at the top of the test file if not already present (the file likely already imports some; only add what is missing):

```typescript
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Inside `describe("runWorker — ingest dispatch", () => { ... })` (after the existing `beforeEach` at line ~2149), add:

```typescript
		it("writes worker-phase=ingest during ingest and removes it after", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "jolli-phase-"));
			mkdirSync(join(tmp, ".jolli", "jollimemory"), { recursive: true });
			const phaseFile = join(tmp, ".jolli", "jollimemory", "worker-phase");

			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			let phaseSeenDuringIngest: string | null = null;
			vi.mocked(drainIngest).mockImplementation(async () => {
				phaseSeenDuringIngest = existsSync(phaseFile) ? readFileSync(phaseFile, "utf-8") : null;
				return { batches: 1, ingested: 2, outcome: "OK", topicFailures: [] };
			});

			await __test__.processQueueEntry(makeIngestOp("post-merge"), tmp, storageWithWiki(true), false);

			expect(phaseSeenDuringIngest).toBe("ingest");
			expect(existsSync(phaseFile)).toBe(false);

			rmSync(tmp, { recursive: true, force: true });
		});

		it("removes worker-phase even when ingest throws", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "jolli-phase-"));
			mkdirSync(join(tmp, ".jolli", "jollimemory"), { recursive: true });
			const phaseFile = join(tmp, ".jolli", "jollimemory", "worker-phase");

			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockRejectedValue(new Error("boom"));

			await expect(
				__test__.processQueueEntry(makeIngestOp("post-merge"), tmp, storageWithWiki(true), false),
			).rejects.toThrow("boom");

			expect(existsSync(phaseFile)).toBe(false);

			rmSync(tmp, { recursive: true, force: true });
		});
```

Note: `__test__.processQueueEntry`, `makeIngestOp`, and `storageWithWiki` already exist in this test file (see lines ~1983, ~2131, ~2135). `storageWithWiki` returns `never`-typed; passing it as the storage arg matches the existing call sites.

---

## Task 2: vscode — `StatusStore.workerPhase`

**Files:**
- Modify: `vscode/src/stores/StatusStore.ts`
- Test: `vscode/src/stores/StatusStore.test.ts`

- [ ] **Step 1: Add the type to the union and snapshot in `StatusStore.ts`**

Find (lines 31-38):

```typescript
export type StatusChangeReason =
	| "init"
	| "refresh"
	| "setStatus"
	| "workerBusy"
	| "syncPhase"
	| "extensionOutdated"
	| "migrating";
```

Replace with (add `"workerPhase"`):

```typescript
export type StatusChangeReason =
	| "init"
	| "refresh"
	| "setStatus"
	| "workerBusy"
	| "workerPhase"
	| "syncPhase"
	| "extensionOutdated"
	| "migrating";
```

Find the `StatusSnapshot` interface (lines 57-65), the `workerBusy: boolean;` line:

```typescript
	readonly workerBusy: boolean;
```

Add directly after it:

```typescript
	readonly workerBusy: boolean;
	readonly workerPhase: "ingest" | null;
```

Find the `EMPTY` snapshot (lines 74-83), the `workerBusy: false,` line, and add after it:

```typescript
	workerBusy: false,
	workerPhase: null,
```

Find the private field block (lines 89-92), the `private workerBusy = false;` line, and add after it:

```typescript
	private workerBusy = false;
	private workerPhase: "ingest" | null = null;
```

- [ ] **Step 2: Bind phase lifetime to busy + add the setter**

Find `setWorkerBusy` (lines 124-130):

```typescript
	setWorkerBusy(busy: boolean): void {
		if (this.workerBusy === busy) {
			return;
		}
		this.workerBusy = busy;
		this.rebuildSnapshot("workerBusy");
	}
```

Replace with:

```typescript
	setWorkerBusy(busy: boolean): void {
		if (this.workerBusy === busy) {
			return;
		}
		this.workerBusy = busy;
		// Phase lifetime is bound to the lock: when the worker stops being busy
		// the phase marker is meaningless, so clear it here. This is the crash-
		// fallback landing point — a stale `worker-phase` file left by a dead
		// worker can never outlive the lock's busy state.
		if (!busy) {
			this.workerPhase = null;
		}
		this.rebuildSnapshot("workerBusy");
	}

	/**
	 * Push (or clear) the post-commit worker's phase. Only `"ingest"` is
	 * surfaced today; any other phase is represented as `null` (default
	 * "AI summary in progress…" label). Equality-checked so a redundant call
	 * is a no-op.
	 */
	setWorkerPhase(phase: "ingest" | null): void {
		if (this.workerPhase === phase) {
			return;
		}
		this.workerPhase = phase;
		this.rebuildSnapshot("workerPhase");
	}
```

- [ ] **Step 3: Include the field in `rebuildSnapshot`**

Find `rebuildSnapshot` (lines 161-173), the `workerBusy: this.workerBusy,` line, and add after it:

```typescript
			workerBusy: this.workerBusy,
			workerPhase: this.workerPhase,
```

- [ ] **Step 4: Write the tests in `StatusStore.test.ts`**

Add inside the top-level `describe("StatusStore", () => { ... })`:

```typescript
	it("setWorkerPhase updates the snapshot and reason", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		store.setWorkerBusy(true);
		store.setWorkerPhase("ingest");
		expect(store.getSnapshot().workerPhase).toBe("ingest");
		expect(store.getSnapshot().changeReason).toBe("workerPhase");
	});

	it("setWorkerPhase is a no-op when unchanged", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		let emits = 0;
		store.onChange(() => {
			emits++;
		});
		store.setWorkerPhase(null); // already null → no emit
		expect(emits).toBe(0);
	});

	it("setWorkerBusy(false) clears a set workerPhase (lock-bound lifetime)", () => {
		const store = new StatusStore({ getStatus: vi.fn() } as never);
		store.setWorkerBusy(true);
		store.setWorkerPhase("ingest");
		store.setWorkerBusy(false);
		expect(store.getSnapshot().workerPhase).toBeNull();
		expect(store.getSnapshot().workerBusy).toBe(false);
	});
```

Note: `onChange` is the `BaseStore` subscription method (used elsewhere in the suite). If the exact subscription method name differs in this file's other tests, mirror that name.

---

## Task 3: vscode — webview state, message handler, and label selection

**Files:**
- Modify: `vscode/src/views/SidebarScriptBuilder.ts`
- Test: `vscode/src/views/SidebarScriptBuilder.test.ts`

- [ ] **Step 1: Add `workerPhase` to the initial webview state**

Find (lines 102-106):

```javascript
    // Live flag pushed by the host whenever the post-commit Worker is holding
    // the lock. Drives the "AI summary in progress…" indicator on the Branch
    // toolbar. Not persisted — start from false on every load and let the next
    // worker:busy or status push correct it.
    workerBusy: false,
```

Replace with:

```javascript
    // Live flag pushed by the host whenever the post-commit Worker is holding
    // the lock. Drives the "AI summary in progress…" indicator on the Branch
    // toolbar. Not persisted — start from false on every load and let the next
    // worker:busy or status push correct it.
    workerBusy: false,
    // Live phase of the running worker (currently only 'ingest'), pushed on the
    // worker:phase channel. Selects "Updating Memory Bank…" over the default
    // summary label. Not persisted — host re-pushes on reload.
    workerPhase: null,
```

- [ ] **Step 2: Reset `workerPhase` on load**

Find (lines 113-116):

```javascript
  // workerBusy is intentionally reset on load (above), even if persisted state
  // had it set — the lock is process-bound and cannot survive a reload.
  state.workerBusy = false;
  state.syncPhase = null;
```

Replace with:

```javascript
  // workerBusy is intentionally reset on load (above), even if persisted state
  // had it set — the lock is process-bound and cannot survive a reload.
  state.workerBusy = false;
  state.workerPhase = null;
  state.syncPhase = null;
```

- [ ] **Step 3: Select the label from the phase**

Find (lines 423-427):

```javascript
      const items = [];
      const indicator = state.workerBusy
        ? { label: 'AI summary in progress…', severity: 'info' }
        : null;
      items.push(buildToolbarIndicator(indicator));
```

Replace with:

```javascript
      const items = [];
      const indicator = state.workerBusy
        ? (state.workerPhase === 'ingest'
            ? { label: 'Updating Memory Bank…', severity: 'info' }
            : { label: 'AI summary in progress…', severity: 'info' })
        : null;
      items.push(buildToolbarIndicator(indicator));
```

- [ ] **Step 4: Handle the `worker:phase` message**

Find the `worker:busy` case (lines 684-699), ending at its closing `}` and `break;`. Immediately after that case's closing brace (before `case 'sync:phase': {` at line 700), insert:

```javascript
      case 'worker:phase': {
        // Per-phase label for the post-commit Worker. Independent of
        // worker:busy; only 'ingest' is surfaced today, anything else clears to
        // the default summary label. Only the Branch tab reacts.
        state.workerPhase = (msg.phase === 'ingest') ? 'ingest' : null;
        if (state.activeTab === 'branch') {
          renderToolbar();
        }
        break;
      }
```

- [ ] **Step 5: Write the tests in `SidebarScriptBuilder.test.ts`**

Add to the `describe("SidebarScriptBuilder", () => { ... })` block:

```typescript
	it("selects the Updating Memory Bank label for the ingest phase", () => {
		const js = buildSidebarScript();
		expect(js).toContain("Updating Memory Bank…");
		expect(js).toContain("state.workerPhase === 'ingest'");
	});

	it("keeps the default AI summary label for non-ingest busy state", () => {
		const js = buildSidebarScript();
		// Both labels must coexist — the ternary falls back to the summary label.
		expect(js).toContain("AI summary in progress…");
	});

	it("handles the worker:phase message channel", () => {
		const js = buildSidebarScript();
		expect(js).toContain("case 'worker:phase'");
	});
```

---

## Task 4: vscode — host push + watcher wiring

**Files:**
- Modify: `vscode/src/views/SidebarWebviewProvider.ts` (interface ~56; `pushStatus` ~872-894)
- Modify: `vscode/src/Extension.ts` (dep object ~830-836; lock watcher block ~1411-1463)

- [ ] **Step 1: Add `getWorkerPhase` to the provider interface**

In `SidebarWebviewProvider.ts`, find the `getSyncPhase?` declaration (lines 56-59):

```typescript
		getSyncPhase?: () => {
			readonly label: string;
			readonly severity: "info" | "error";
		} | null;
	};
```

Replace with:

```typescript
		getSyncPhase?: () => {
			readonly label: string;
			readonly severity: "info" | "error";
		} | null;
		/**
		 * Returns the current post-commit worker phase from StatusStore. Pushed
		 * to the webview as `worker:phase` so the Branch tab toolbar can show
		 * "Updating Memory Bank…" during a topic-KB ingest. Optional so existing
		 * tests that only stub `getWorkerBusy` keep compiling.
		 */
		getWorkerPhase?: () => "ingest" | null;
	};
```

- [ ] **Step 2: Push `worker:phase` in `pushStatus`**

Find the end of `pushStatus` (lines 885-894):

```typescript
		// Sync-phase indicator. Optional on the provider interface so existing
		// tests that don't stub `getSyncPhase` keep working unchanged.
		const getSyncPhase = this.deps.statusProvider.getSyncPhase;
		if (getSyncPhase) {
			this.postMessage({
				type: "sync:phase",
				phase: getSyncPhase(),
			});
		}
	}
```

Replace with:

```typescript
		// Sync-phase indicator. Optional on the provider interface so existing
		// tests that don't stub `getSyncPhase` keep working unchanged.
		const getSyncPhase = this.deps.statusProvider.getSyncPhase;
		if (getSyncPhase) {
			this.postMessage({
				type: "sync:phase",
				phase: getSyncPhase(),
			});
		}
		// Worker-phase indicator (ingest). Same StatusStore change event as
		// worker:busy; optional getter so existing stubs keep compiling.
		const getWorkerPhase = this.deps.statusProvider.getWorkerPhase;
		if (getWorkerPhase) {
			this.postMessage({
				type: "worker:phase",
				phase: getWorkerPhase(),
			});
		}
	}
```

- [ ] **Step 3: Wire the dep in `Extension.ts`**

Find (lines 834-835):

```typescript
			getWorkerBusy: () => statusProvider.getWorkerBusy(),
			getSyncPhase: () => statusStore.getSnapshot().syncPhase,
```

Replace with:

```typescript
			getWorkerBusy: () => statusProvider.getWorkerBusy(),
			getSyncPhase: () => statusStore.getSnapshot().syncPhase,
			getWorkerPhase: () => statusStore.getSnapshot().workerPhase,
```

- [ ] **Step 4: Add the phase FileSystemWatcher in `Extension.ts`**

Find the end of the lock-watcher block (lines 1461-1463):

```typescript
	context.subscriptions.push(lockWatcher);
	// Check initial state — lock file might already exist on activation
	void isWorkerBusy(workspaceRoot).then(setWorkerBusy);
```

Replace with:

```typescript
	context.subscriptions.push(lockWatcher);
	// Check initial state — lock file might already exist on activation
	void isWorkerBusy(workspaceRoot).then(setWorkerBusy);

	// ── Worker phase file watcher ───────────────────────────────────────
	// The worker writes `.jolli/jollimemory/worker-phase` (content "ingest")
	// while running a topic-KB ingest, so the Branch toolbar can show
	// "Updating Memory Bank…" instead of "AI summary in progress…". The phase
	// is purely cosmetic; its busy-bound lifetime (StatusStore clears it on
	// workerBusy=false) means a stale marker left by a crashed worker can't
	// outlive the lock. Separate from the lock watcher because a phase-file
	// write does not touch worker.lock, so onDidChange there would not fire.
	const phaseWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(workspaceRoot, ".jolli/jollimemory/worker-phase"),
	);
	const readWorkerPhase = async (): Promise<void> => {
		try {
			const uri = vscode.Uri.joinPath(
				vscode.Uri.file(workspaceRoot),
				".jolli",
				"jollimemory",
				"worker-phase",
			);
			const bytes = await vscode.workspace.fs.readFile(uri);
			const content = Buffer.from(bytes).toString("utf-8").trim();
			statusStore.setWorkerPhase(content === "ingest" ? "ingest" : null);
		} catch {
			// File missing / unreadable → no special phase.
			statusStore.setWorkerPhase(null);
		}
	};
	phaseWatcher.onDidCreate(() => void readWorkerPhase());
	phaseWatcher.onDidChange(() => void readWorkerPhase());
	phaseWatcher.onDidDelete(() => statusStore.setWorkerPhase(null));
	context.subscriptions.push(phaseWatcher);
	// Check initial state — phase file might already exist on activation
	// (extension started while a worker is mid-ingest).
	void readWorkerPhase();
```

---

## Task 5: Verify + commit (single consolidated pass)

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; cli coverage stays ≥ 97% statements / 96% branches / 97% functions / 97% lines.

If coverage dipped on the new `QueueWorker` phase branch, confirm the Task 1 tests exercise both the write-success path and the ingest-throws path (they do); if the `log.debug` catch lines are flagged uncovered, add a `/* v8 ignore next N */` on the two best-effort `catch` blocks (mirrors the existing best-effort catch-ignore style in this file) — do NOT lower the threshold.

- [ ] **Step 2: Commit (DCO sign-off, no AI co-author trailer)**

```bash
git add cli/src/core/Locks.ts cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts \
        vscode/src/stores/StatusStore.ts vscode/src/stores/StatusStore.test.ts \
        vscode/src/views/SidebarScriptBuilder.ts vscode/src/views/SidebarScriptBuilder.test.ts \
        vscode/src/views/SidebarWebviewProvider.ts vscode/src/Extension.ts
git commit -s -m "feat(vscode): distinct toolbar label for topic-KB ingest phase"
```

Expected: commit succeeds with a `Signed-off-by:` trailer and no `Co-Authored-By: Claude` / `🤖 Generated with` footer.

---

## Intentionally unchanged

- `worker.lock` format / lock acquisition in `Locks.ts` (IntelliJ-shared format untouched; only a new sibling constant added).
- The `syncPhase` channel (Memory Bank sync engine — not reused).
- Labels for rebase-pick / squash / summary phases (only ingest is split out).
- IntelliJ plugin (no UI parity required for this cosmetic VS Code label).
