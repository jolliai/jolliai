/**
 * Drives the Memory Bank sync engine inside the long-lived VS Code plugin.
 *
 * Two signals trigger a sync round:
 *
 *   1. **Polling tick**: every `syncPollIntervalSec` (default 90 min) —
 *      pulls remote commits pushed by another device and pushes any local
 *      FolderStorage writes accumulated since the last round. Cadence is
 *      deliberately slow because committed writes don't need real-time
 *      visibility across devices; the "Sync now" button covers the
 *      "I want it now" case.
 *   2. **Manual command**: `jollimemory.syncNow` invoked from the command
 *      palette or the Settings webview "Sync now" button.
 *
 * **Explicitly no file watcher and no post-commit hook auto-trigger** —
 * the source plan included both but user feedback during Phase 4 dropped
 * them: a watcher on `<localFolder>` fires for the engine's own mirror
 * writes (loop risk), and auto-syncing on every commit makes the UX feel
 * surprising. The slow poll + the manual button is the explicit contract.
 *
 * Rounds are serialized via `sync.lock` (in `SyncEngine.runRound`); if the
 * lock is held, the call returns `newState: "syncing"` and we stay quiet.
 *
 * The orchestrator owns the engine instance for the lifetime of the
 * workspace. On workspace switch we tear everything down and rebuild —
 * `<localFolder>/<repoName>/` is workspace-specific.
 */

import type * as vscode from "vscode";
import { loadConfig } from "../../../cli/src/core/SessionTracker.js";
import { createLogger } from "../../../cli/src/Logger.js";
import type { SyncEngine } from "../../../cli/src/sync/SyncEngine.js";
import { isTerminalSyncError } from "../../../cli/src/sync/SyncTypes.js";

const log = createLogger("Sync:StatusOrchestrator");
import type {
	SyncRoundOptions,
	SyncRoundResult,
	SyncState,
} from "../../../cli/src/sync/SyncTypes.js";
import type {
	StatusBarManager,
	SyncStatusDetail,
} from "../util/StatusBarManager.js";

const MIN_POLL_SEC = 90 * 60; // 90 min floor — matches CLI configure floor; sync is heavy, manual button covers urgency
const MAX_POLL_SEC = 86400; // 24h ceiling so a confused config can't park the engine for weeks
const DEFAULT_POLL_SEC = 90 * 60; // 90 min — slow background cadence, Sync-now button covers urgency

export interface StatusOrchestratorOpts {
	readonly engine: SyncEngine;
	readonly statusBar: StatusBarManager;
	readonly workspaceFolder: vscode.WorkspaceFolder;
	readonly pollIntervalSec?: number;
	/**
	 * Promise that must resolve before any sync round runs. Wired to the
	 * extension's `initializeKB()` step so `<localFolder>/<repo>/.jolli/
	 * config.json` is written BEFORE `git pull` can materialize the
	 * directory empty-handed. Without this gate, the first sync round
	 * could pull `<repo>/` from a peer device (whose `.jolli/config.json`
	 * is denied from sync per AllowList §1), and KBPathResolver on the
	 * next call would see the dir without identity → allocate
	 * `<repo>-2/`, splitting content across two folders.
	 *
	 * Defaults to a resolved Promise for tests / paths that don't need
	 * the gate.
	 */
	readonly readyPromise?: Promise<void>;
	/**
	 * Fires after every completed round, regardless of outcome. Used by
	 * the VS Code wiring to invalidate the Memory Bank tree-view cache and
	 * tell the sidebar webview to re-list folders — `git pull` produces
	 * file-system writes that `KbFoldersService.cleanRepos` doesn't observe
	 * on its own, so without this hook the tree shows the pre-sync state
	 * until the user clicks Refresh manually. Safe for sync errors too
	 * (state === "offline") because a partial pull may still have landed
	 * files on disk before the failure.
	 */
	readonly onRoundFinished?: (state: SyncState, result: SyncRoundResult) => void;
	/** Test seam — substitute setInterval/clearInterval. */
	readonly timer?: {
		setInterval: (handler: () => void, ms: number) => unknown;
		clearInterval: (handle: unknown) => void;
	};
}

export class StatusOrchestrator implements vscode.Disposable {
	private readonly engine: SyncEngine;
	private readonly statusBar: StatusBarManager;
	private readonly cwd: string;
	private readonly pollMs: number;
	private readonly timer: NonNullable<StatusOrchestratorOpts["timer"]>;
	private readonly readyPromise: Promise<void>;
	/**
	 * Late-bound: Extension.ts wires this after `KbFoldersService` and
	 * `SidebarWebviewProvider` are constructed (which is AFTER `activateSync`
	 * has already run an eager first round). A `setter` rather than a
	 * constructor arg keeps the dependency graph manageable.
	 */
	private onRoundFinished?: (state: SyncState, result: SyncRoundResult) => void;
	private pollHandle: unknown = null;
	private currentRoundPromise: Promise<unknown> | null = null;
	private lastState: SyncState = "synced";
	private disposed = false;
	/**
	 * Monotonically incremented on every `start()`. Each `tick()`
	 * captures the value at entry; if `stop()` runs before the tick
	 * reaches `engine.runRound` (e.g. while still awaiting
	 * `readyPromise` on first boot), the captured generation won't
	 * match the current `pollGeneration` and the tick bails BEFORE
	 * running the round. Fixes P2#2 — pre-fix a user toggling
	 * auto-sync off during the KB-init wait would still see the
	 * already-queued tick run a round when ready settled.
	 */
	private pollGeneration = 0;

	constructor(opts: StatusOrchestratorOpts) {
		this.engine = opts.engine;
		this.statusBar = opts.statusBar;
		this.cwd = opts.workspaceFolder.uri.fsPath;
		this.readyPromise = opts.readyPromise ?? Promise.resolve();
		this.onRoundFinished = opts.onRoundFinished;
		const clamped = clampPoll(opts.pollIntervalSec);
		this.pollMs = clamped * 1000;
		this.timer = opts.timer ?? {
			setInterval: (h, ms) => setInterval(h, ms),
			clearInterval: (handle) =>
				clearInterval(handle as ReturnType<typeof setInterval>),
		};
	}

	/** Starts the polling loop. Idempotent. */
	start(): void {
		if (this.disposed) return;
		if (this.pollHandle !== null) return;
		// Bump generation so any ticks queued by a previous `start()`
		// session (that were dropped by an intervening `stop()`) don't
		// accidentally fire when the user re-enables auto-sync.
		this.pollGeneration++;
		const gen = this.pollGeneration;
		this.pollHandle = this.timer.setInterval(() => {
			void this.tick("poll", gen);
		}, this.pollMs);
		// Kick off an immediate round so opt-in users see status update right
		// away rather than waiting for the first poll boundary.
		void this.tick("poll", gen);
	}

	/**
	 * Stops polling without disposing the orchestrator. Idempotent. The
	 * engine + status-bar wiring stay alive so manual `syncNow()` keeps
	 * working — this only tears down the recurring interval and any
	 * "eager initial tick" path that `start()` may have queued
	 * (P2#2 — pre-fix the queued tick would still run a round when
	 * `readyPromise` settled, even if the user toggled OFF in between).
	 */
	stop(): void {
		if (this.pollHandle !== null) {
			this.timer.clearInterval(this.pollHandle);
			this.pollHandle = null;
		}
		// Bump generation so any tick currently awaiting `readyPromise`
		// from this poll session sees a mismatch and bails before
		// running a round.
		this.pollGeneration++;
	}

	/** Visible for tests — whether the polling interval is currently scheduled. */
	get isPolling(): boolean {
		return this.pollHandle !== null;
	}

	/** Stops polling and marks the orchestrator unusable. */
	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	/**
	 * Manual sync invoked from `jollimemory.syncNow`. Uses
	 * `pollGeneration: undefined` to signal "no generation check" — a
	 * user-initiated round is never cancelled by a concurrent `stop()`
	 * since the user explicitly asked for it.
	 */
	async syncNow(): Promise<void> {
		await this.tick("manual", undefined);
	}

	/** Visible for tests. */
	get lastObservedState(): SyncState {
		return this.lastState;
	}

	/**
	 * True iff a sync round is currently executing inside this process.
	 * Used by `jollimemory.syncNow` to surface a "busy" toast on repeat
	 * clicks instead of silently coalescing — repeated clicks still resolve
	 * once the in-flight round finishes (existing behavior), but the user
	 * now sees an explicit signal that their action was registered.
	 */
	isRoundInFlight(): boolean {
		return this.currentRoundPromise !== null;
	}

	/**
	 * Runs a single round and updates the status bar. Coalesces overlapping
	 * triggers (poll tick + manual click at the same instant) so the engine
	 * only sees one round at a time — `sync.lock` would serialize them anyway
	 * but avoiding the second call saves a roundtrip.
	 *
	 * **Awaits the round to completion**. Earlier versions fire-and-forgot the
	 * IIFE which made `syncNow()` resolve immediately, hiding errors from the
	 * caller and leaving the user wondering why nothing happened. When a round
	 * is already in flight we await that one instead so concurrent callers all
	 * see the same outcome.
	 */
	private async tick(
		reason: SyncRoundOptions["reason"],
		queuedAtGeneration: number | undefined,
	): Promise<void> {
		if (this.disposed) return;
		if (this.currentRoundPromise !== null) {
			// Another round is already executing in this process. Wait for it
			// so the caller's await actually corresponds to visible work.
			await this.currentRoundPromise;
			return;
		}
		// Capture pre-tick state so we can restore it if the round bails
		// after `setState("syncing")` due to a generation mismatch
		// (P2#2 — user toggled OFF auto-sync while we were waiting on
		// readyPromise). Without this, the status bar would stay stuck
		// on "syncing" forever.
		const preTickState = this.lastState;
		this.setState("syncing");
		this.currentRoundPromise = (async () => {
			try {
				// Wait for the workspace's KB init step
				// (`<localFolder>/<repo>/.jolli/config.json` written by
				// `initializeKBFolder`) before any `git pull`. Subsequent
				// rounds resolve immediately because the promise has
				// already settled (plan §P1#2). The wait lives INSIDE the
				// promise body — placing it before `currentRoundPromise`
				// assignment would let two near-simultaneous `syncNow()`
				// calls both pass the coalesce gate.
				//
				// KB init failures shouldn't permanently block sync — the
				// extension already logs them; we proceed and the round
				// will fail visibly if the working tree is unrecoverable.
				await this.readyPromise.catch(() => {});
				// P2#2 — if `stop()` ran while we were awaiting readyPromise,
				// the captured `queuedAtGeneration` won't match the current
				// generation any more. Bail BEFORE running the round so a
				// poll tick queued in the auto-sync-ON window doesn't fire
				// after the user toggled OFF. Manual `syncNow()` passes
				// `queuedAtGeneration: undefined` so this check is skipped
				// (user explicitly asked for the round; no implicit cancel).
				if (
					queuedAtGeneration !== undefined &&
					queuedAtGeneration !== this.pollGeneration
				) {
					this.setState(preTickState);
					return;
				}
				// Read `syncTranscripts` from the CLI config (where the
				// Settings webview writes it). Pre-fix this read used
				// `vscode.workspace.getConfiguration("jollimemory")`, but
				// `vscode/package.json` doesn't contribute that setting key,
				// so the value was always undefined → `Boolean(undefined)
				// === false` and the toggle was a no-op. CLI config is the
				// single source of truth for sync settings (P2#1 fix).
				const cliConfig = await loadConfig();
				const transcripts = cliConfig.syncTranscripts === true;
				const result = await this.engine.runRound({
					cwd: this.cwd,
					reason,
					transcripts,
				});
				this.setState(result.newState, buildDetail(result));
				this.fireRoundFinished(result.newState, result);
			} catch (e) {
				// I6: prior version silently set offline + zero log. Combined
				// with the engine's own outer catch (also formerly silent,
				// fixed in B5) prod failures had zero diagnostic surface.
				// Log the stack and surface a classified lastError so the
				// status bar shows the red "Sync failed" branch with the
				// exception message in the tooltip instead of a bare
				// "Offline" indistinguishable from a dropped network.
				const message = (e as Error).message;
				log.error(
					"StatusOrchestrator.tick caught: %s\n%s",
					message,
					(e as Error).stack ?? "(no stack)",
				);
				// `fetched/pulled/pushed` are hardcoded `false` here because the
				// engine's `runRound` contract doesn't surface partial progress
				// on an unexpected throw — by the time we land in this catch,
				// the engine has lost which steps already wrote bytes to disk.
				// This is the documented "trust caveat" on `SyncRoundResult`;
				// downstream consumers must treat these three booleans as
				// unreliable whenever `lastError.code === "sync_failed_after_retries"`.
				const result: SyncRoundResult = {
					fetched: false,
					pulled: false,
					pushed: false,
					conflicts: [],
					newState: "offline",
					lastError: { code: "sync_failed_after_retries", message },
				};
				this.setState("offline", buildDetail(result));
				this.fireRoundFinished("offline", result);
			} finally {
				this.currentRoundPromise = null;
			}
		})();
		await this.currentRoundPromise;
	}

	private setState(state: SyncState, detail?: SyncStatusDetail): void {
		this.lastState = state;
		this.statusBar.setSyncState(state, detail);
	}

	/**
	 * Late-binding setter for the post-round listener. Used by Extension.ts
	 * after `KbFoldersService` and `SidebarWebviewProvider` are constructed
	 * (which happens after `activateSync` has already fired the eager first
	 * round). Passing `undefined` clears the listener.
	 */
	setOnRoundFinished(cb: ((state: SyncState, result: SyncRoundResult) => void) | undefined): void {
		this.onRoundFinished = cb;
	}

	/**
	 * Safely fires `onRoundFinished`. A throwing listener should NOT take
	 * down the sync loop — we log at debug only and continue. Mirrors the
	 * `onStateChange` swallow-and-log convention in `SyncEngine.report`.
	 */
	private fireRoundFinished(state: SyncState, result: SyncRoundResult): void {
		if (!this.onRoundFinished) return;
		try {
			this.onRoundFinished(state, result);
		} catch {
			// Intentionally silent — UI refresh is best-effort.
		}
	}
}

/**
 * Maps a `SyncRoundResult` into the status bar's `SyncStatusDetail`.
 * Visible for tests.
 *
 * The `failed` flag is set for any terminal lastError code — anything other
 * than `network`. This matches the source plan §0.6 contract: 401/404 after
 * step retries exhausted, mint_failed, git_missing, clone/fetch/pull errors,
 * migration_failed, and `sync_failed_after_retries` all warrant the louder
 * "Sync failed" visual. Transient `network` failures stay as plain "Offline"
 * because the next poll tick is very likely to succeed.
 */
export function buildDetail(
	result: SyncRoundResult,
): SyncStatusDetail | undefined {
	const detail: {
		-readonly [K in keyof SyncStatusDetail]: SyncStatusDetail[K];
	} = {};
	if (result.conflicts.length > 0) {
		detail.conflictCount = result.conflicts.length;
	}
	if (result.lastError) {
		detail.lastError = result.lastError.message;
		if (isTerminalSyncError(result.lastError.code)) {
			detail.failed = true;
			detail.failedCode = result.lastError.code;
		}
		// Engine-provided self-lock evidence (see
		// `PendingLockStore` / `SyncEngine.readSelfLockState`). The status
		// bar's `vault_locked` visual uses this to relabel "another device"
		// → "your previous sync". `selfLocked` only ever appears on
		// `code === "vault_locked"` per the engine contract; the strict
		// `=== true` keeps the implicit `undefined` reading as "not self".
		if (result.lastError.selfLocked === true) {
			detail.selfLocked = true;
		}
	}
	return Object.keys(detail).length === 0 ? undefined : detail;
}

/* Visible for testing. */
export function clampPoll(value: number | undefined): number {
	const raw =
		typeof value === "number" && Number.isFinite(value)
			? value
			: DEFAULT_POLL_SEC;
	return Math.min(MAX_POLL_SEC, Math.max(MIN_POLL_SEC, Math.floor(raw)));
}
