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
	SyncPhase,
	SyncRoundOptions,
	SyncRoundResult,
	SyncState,
} from "../../../cli/src/sync/SyncTypes.js";
import type { StatusStore } from "../stores/StatusStore.js";
import type {
	StatusBarManager,
	SyncStatusDetail,
} from "../util/StatusBarManager.js";

/**
 * User-facing labels for the sync engine's `SyncPhase` events. Deliberately
 * conversational — not 1:1 with git commands — so the sidebar reads as
 * product copy rather than ops output.
 */
const PHASE_LABELS: Record<SyncPhase, string> = {
	downloading: "Sync: Getting latest memories…",
	merging: "Sync: Bringing it together…",
	resolving: "Sync: Sorting out conflicts…",
	uploading: "Sync: Sharing your changes…",
	waiting: "Sync: Another device is syncing — waiting…",
};

/**
 * Initial label set at round start, before the first `onPhase` callback
 * fires. Plain — at this point we haven't yet picked a phase. Also used
 * after a transient (`network`) failure: the activity is kept visible
 * because the next poll usually recovers, but reset to this neutral label
 * so the user isn't left looking at a stale phase string.
 */
const SYNC_START_LABEL = "Syncing memory bank…";

/**
 * Titles for the bottom-right VS Code error notification raised when a round
 * ends in terminal failure. The phase key picks the copy so the user sees
 * *where* the round broke. Surfaced via `notifyError` (vscode.window.show-
 * ErrorMessage) rather than the toolbar phase indicator — the toolbar is
 * reserved for *transient* in-flight progress; persistent failures belong on
 * the notification surface so the user can dismiss them explicitly.
 */
const FAILURE_LABELS: Record<SyncPhase | "starting", string> = {
	starting: "Sync: Couldn't start",
	downloading: "Sync: Couldn't fetch latest memories",
	merging: "Sync: Couldn't merge changes",
	resolving: "Sync: Couldn't resolve conflicts",
	uploading: "Sync: Couldn't share your changes",
	waiting: "Sync: Personal Space is still locked",
};

const MIN_POLL_SEC = 90 * 60; // 90 min floor — matches CLI configure floor; sync is heavy, manual button covers urgency
const MAX_POLL_SEC = 86400; // 24h ceiling so a confused config can't park the engine for weeks
const DEFAULT_POLL_SEC = 90 * 60; // 90 min — slow background cadence, Sync-now button covers urgency

export interface StatusOrchestratorOpts {
	readonly engine: SyncEngine;
	readonly statusBar: StatusBarManager;
	/**
	 * Unified activity registry — the orchestrator pushes a `"sync"` activity
	 * at round start and relabels it as the engine progresses through phases.
	 * Terminal failures keep the activity alive with `severity: "error"` so
	 * the sidebar shows *where* the last round broke until the next round
	 * succeeds. Optional: tests that don't drive the sidebar can omit it.
	 */
	readonly statusStore?: StatusStore;
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
	/**
	 * Raises a persistent failure notification (bottom-right toast) when a
	 * round ends in terminal failure. The toolbar phase indicator is for
	 * transient in-flight progress only — persistent errors belong on the
	 * notification surface so the user can dismiss them explicitly. Wired
	 * to `vscode.window.showErrorMessage` in production; tests substitute a
	 * spy. Optional: paths that don't surface a UI (tests with no statusStore)
	 * can omit it and the orchestrator skips the call silently.
	 */
	readonly notifyError?: (title: string, message: string) => void;
	/** Test seam — substitute setInterval/clearInterval. */
	readonly timer?: {
		setInterval: (handler: () => void, ms: number) => unknown;
		clearInterval: (handle: unknown) => void;
	};
	/**
	 * Persistent "last successful round started" timestamp (ms since epoch).
	 * Gates the eager `tick()` on `start()`: if we've recently synced
	 * (within `EAGER_TICK_MIN_ELAPSED_MS`), `start()` waits for the next
	 * poll boundary instead of burning another round.
	 *
	 * Production wires this to `vscode.ExtensionContext.globalState` so the
	 * value survives Reload Window (the case the pre-fix removal was trying
	 * to avoid — every reload burned a round). Tests pass an in-memory
	 * shim. Omitting the seam disables the eager-tick path, identical to
	 * the pre-fix "no eager tick ever" behaviour.
	 */
	readonly lastSuccessAt?: {
		get(): number | undefined;
		set(ms: number): void;
	};
	/**
	 * Override for the eager-tick freshness threshold. Defaults to 30 min.
	 * Lower than the default poll interval (90 min) so a normal user open
	 * after lunch / overnight gets an eager refresh; higher than any
	 * realistic Reload Window cycle so dev iteration doesn't burn rounds.
	 */
	readonly eagerTickMinElapsedMs?: number;
}

/** Default freshness window — see `eagerTickMinElapsedMs`. */
const DEFAULT_EAGER_TICK_MIN_ELAPSED_MS = 30 * 60_000;

export class StatusOrchestrator implements vscode.Disposable {
	private readonly engine: SyncEngine;
	private readonly statusBar: StatusBarManager;
	private readonly statusStore: StatusStore | undefined;
	private readonly cwd: string;
	private readonly pollMs: number;
	private readonly timer: NonNullable<StatusOrchestratorOpts["timer"]>;
	private readonly readyPromise: Promise<void>;
	/**
	 * Most-recent phase the engine emitted during the in-flight round.
	 * Used to label a sticky error visual when the round ends in failure.
	 * Reset to `null` at the start of each round.
	 */
	private currentPhase: SyncPhase | null = null;
	/**
	 * Late-bound: Extension.ts wires this after `KbFoldersService` and
	 * `SidebarWebviewProvider` are constructed, which happens after
	 * `activateSync` returns. The first round (poll or manual) always
	 * fires after that wiring is in place, so the setter exists purely
	 * for ergonomics — keeping the dependency graph linear instead of
	 * threading the callback through the constructor.
	 */
	private onRoundFinished?: (state: SyncState, result: SyncRoundResult) => void;
	private readonly notifyError?: (title: string, message: string) => void;
	private pollHandle: unknown = null;
	private currentRoundPromise: Promise<unknown> | null = null;
	/**
	 * P3-A — followup latch. Set by `requestManualSync()` when a manual
	 * `syncNow` arrives during an in-flight round. The current round may
	 * bail (generation mismatch in `tick`) without actually executing the
	 * engine, in which case the manual intent would otherwise be lost.
	 * After the current round settles (in `tick`'s finally), the latch is
	 * checked and an unconditional manual tick is scheduled. Cleared by
	 * the followup tick before it starts so subsequent manual clicks
	 * during THAT tick can re-arm.
	 */
	private pendingManualFollowup = false;
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
	private readonly lastSuccessAt: StatusOrchestratorOpts["lastSuccessAt"];
	private readonly eagerTickMinElapsedMs: number;

	constructor(opts: StatusOrchestratorOpts) {
		this.engine = opts.engine;
		this.statusBar = opts.statusBar;
		this.statusStore = opts.statusStore;
		this.cwd = opts.workspaceFolder.uri.fsPath;
		this.readyPromise = opts.readyPromise ?? Promise.resolve();
		this.onRoundFinished = opts.onRoundFinished;
		this.notifyError = opts.notifyError;
		this.lastSuccessAt = opts.lastSuccessAt;
		this.eagerTickMinElapsedMs = opts.eagerTickMinElapsedMs ?? DEFAULT_EAGER_TICK_MIN_ELAPSED_MS;
		const clamped = clampPoll(opts.pollIntervalSec);
		this.pollMs = clamped * 1000;
		this.timer = opts.timer ?? {
			setInterval: (h, ms) => setInterval(h, ms),
			clearInterval: (handle) =>
				clearInterval(handle as ReturnType<typeof setInterval>),
		};
	}

	/**
	 * Starts the polling loop. Idempotent.
	 *
	 * **Conditional eager round on `start()`.** Pre-§P2-fix: always fired
	 * an immediate `tick()`, which burned a round on every `Developer:
	 * Reload Window` during extension development. Then the eager tick
	 * was removed entirely, which fixed dev iteration but made auto-sync
	 * silent for up to the full poll interval (90 min default) after
	 * VS Code restart — including the "open laptop in the morning, want
	 * overnight remote changes" case.
	 *
	 * Current: fire eager tick iff `lastSuccessAt.get()` is undefined
	 * (cold start) OR older than `eagerTickMinElapsedMs` (default 30 min).
	 * Reload Window with a fresh successful round (seconds ago) → no eager
	 * tick. Re-open after lunch / overnight → eager tick. Persistence
	 * survives Reload Window via `globalState` so the dev-iteration
	 * "burn a round on every reload" regression doesn't return.
	 */
	start(): void {
		if (this.disposed) return;
		if (this.pollHandle !== null) return;
		// Bump generation so any ticks queued by a previous `start()`
		// session (that were dropped by an intervening `stop()`) don't
		// accidentally fire when the user re-enables auto-sync.
		this.pollGeneration++;
		const gen = this.pollGeneration;
		// Eager tick uses `reason: "poll"` — semantically this IS auto-sync
		// firing its first poll early, just on the startup boundary instead
		// of waiting for the interval. Avoids adding a new reason variant
		// (which would force every consumer of `SyncRoundOptions["reason"]`
		// to learn it).
		if (this.shouldFireEagerTick()) {
			void this.tick("poll", gen);
		}
		this.pollHandle = this.timer.setInterval(() => {
			void this.tick("poll", gen);
		}, this.pollMs);
	}

	/**
	 * Decides whether `start()` should fire an immediate tick before the
	 * first poll interval elapses. `true` when:
	 *   - No persistence seam was wired (test default — preserves the
	 *     pre-fix "no eager tick" baseline so existing tests that count
	 *     ticks don't observe a new one).
	 *
	 * Wait, that's backwards: callers without the seam wired probably DO
	 * want the eager behaviour. Actually the safer default is the
	 * opposite — without persistence we can't distinguish reload-burn from
	 * a real restart, so skip eager to err on "don't burn a round". Tests
	 * that want the eager-tick path through here pass an in-memory shim
	 * with `get()` returning a stale timestamp.
	 */
	private shouldFireEagerTick(): boolean {
		if (this.lastSuccessAt === undefined) return false;
		const last = this.lastSuccessAt.get();
		if (last === undefined) return true; // cold start — never synced
		return Date.now() - last >= this.eagerTickMinElapsedMs;
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
		this.statusStore?.setSyncPhase(null);
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

	/**
	 * P3-A entry point for `jollimemory.syncNow` (replaces the previous
	 * "early-return if in-flight" pattern in `SyncCommands`).
	 *
	 * Why a separate method rather than just calling `syncNow()`:
	 *
	 *   - If no round is in flight, this is equivalent to `syncNow()` —
	 *     fires a manual tick and awaits it.
	 *   - If a round IS in flight, the old code path silently no-op'd. But
	 *     the in-flight round may bail before executing the engine (the
	 *     `queuedAtGeneration !== pollGeneration` check at the top of
	 *     `tick()`'s IIFE fires when the user toggled auto-sync OFF mid-
	 *     await). In that window, the manual click is dropped: SyncCommands
	 *     declines to fire because the flag is set, and the in-flight
	 *     promise resolves having done no work.
	 *
	 * Fix: when a round is already in flight, set the followup latch
	 * (`pendingManualFollowup`) and await the in-flight promise. After it
	 * settles, `tick`'s finally schedules a fresh manual tick. Awaiting
	 * here preserves the existing semantics that the command's
	 * `await orch.syncNow()` resolves only after work has been attempted.
	 *
	 * The followup tick uses `reason: "manual"` and `pollGeneration:
	 * undefined`, so it is exempt from the generation-mismatch bail — a
	 * manual click is the user's explicit ask, not subject to auto-sync
	 * toggling.
	 */
	async requestManualSync(): Promise<void> {
		if (this.currentRoundPromise === null) {
			await this.tick("manual", undefined);
			return;
		}
		this.pendingManualFollowup = true;
		const inFlight = this.currentRoundPromise;
		try {
			await inFlight;
		} catch {
			// Errors are already surfaced via tick's own catch + status
			// bar; we only awaited to coalesce timing. Don't re-throw.
		}
		// The in-flight round's finally has either already fired the
		// followup tick (and cleared the latch) or set up the scheduling
		// to do so. Await the orchestrator becoming idle so the caller's
		// "command completed" message corresponds to real work.
		if (this.currentRoundPromise !== null) {
			try {
				await this.currentRoundPromise;
			} catch {
				// Same rationale as above.
			}
		}
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
		// Reset phase tracker + reset the sidebar indicator. If the previous
		// round left a sticky-error phase up, this overwrites it with the
		// neutral "Syncing memory bank…" so the user sees the new attempt
		// rather than stale failure copy.
		this.currentPhase = null;
		this.statusStore?.setSyncPhase({
			label: SYNC_START_LABEL,
			severity: "info",
		});
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
					// Generation mismatch (user disabled auto-sync mid-await).
					// Drop the sidebar indicator too — the round will not run.
					this.statusStore?.setSyncPhase(null);
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
				this.applyRoundOutcomeToSyncPhase(result);
				this.fireRoundFinished(result.newState, result);
				// Persist the successful-round timestamp so the next `start()`
				// (after Reload Window or restart) can decide whether to fire
				// an eager tick. Only counts genuine `synced` outcomes —
				// `conflicts` / `offline` / `syncing` don't reset the staleness
				// clock since the user's vault is still drifting from remote.
				if (result.newState === "synced" && this.lastSuccessAt !== undefined) {
					try {
						this.lastSuccessAt.set(Date.now());
					} catch (e) {
						log.debug("lastSuccessAt.set threw (swallowed): %s", (e as Error).message);
					}
				}
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
				this.applyRoundOutcomeToSyncPhase(result);
				this.fireRoundFinished("offline", result);
			} finally {
				this.currentRoundPromise = null;
			}
		})();
		await this.currentRoundPromise;
		// P3-A followup. If a manual `requestManualSync()` arrived during
		// the above round (or during a bail BEFORE the engine actually
		// ran), honour it now with an unconditional manual tick. Clear the
		// latch BEFORE firing so the followup tick itself can re-arm if
		// yet another manual click lands while it runs.
		if (this.pendingManualFollowup && !this.disposed) {
			this.pendingManualFollowup = false;
			await this.tick("manual", undefined);
		}
	}

	private setState(state: SyncState, detail?: SyncStatusDetail): void {
		this.lastState = state;
		this.statusBar.setSyncState(state, detail);
	}

	/**
	 * Engine `onPhase` delegate. Records the most-recent phase and pushes
	 * the conversational label to the sidebar. Safe to call without a
	 * StatusStore (test path / dormant sync) — falls through silently.
	 */
	handlePhase(phase: SyncPhase): void {
		// Engine rounds can outlive `dispose()` — `currentRoundPromise` is
		// not cancellable from here. Without this gate, a phase event from
		// an in-flight round would re-set `syncPhase` to a non-null label
		// AFTER `dispose()` already cleared it, leaving a stale indicator
		// in the about-to-be-destroyed StatusStore.
		if (this.disposed) return;
		this.currentPhase = phase;
		this.statusStore?.setSyncPhase({
			label: PHASE_LABELS[phase],
			severity: "info",
		});
	}

	/**
	 * Final-state handler for the sidebar sync-phase indicator.
	 *
	 *   - `synced`              → clear (sidebar idle).
	 *   - `conflicts`           → keep visible with a "N conflicts need your
	 *                             attention" label (info severity — the
	 *                             status bar's `$(warning)` carries the
	 *                             alarm visual).
	 *   - `offline` + terminal  → clear the toolbar indicator and raise a
	 *                             VS Code error notification (bottom-right
	 *                             toast) naming the failed phase. The toolbar
	 *                             reflects only transient in-flight progress;
	 *                             persistent failure copy lives on the
	 *                             notification surface where the user can
	 *                             dismiss it explicitly.
	 *   - `offline` + network   → reset to the neutral "Syncing memory bank…"
	 *                             label; the next poll usually recovers.
	 */
	private applyRoundOutcomeToSyncPhase(result: SyncRoundResult): void {
		if (!this.statusStore) return;
		if (result.newState === "synced") {
			this.statusStore.setSyncPhase(null);
			return;
		}
		if (result.newState === "conflicts") {
			const n = result.conflicts.length;
			this.statusStore.setSyncPhase({
				label:
					n > 0
						? `Sync: ${n} ${n === 1 ? "conflict needs" : "conflicts need"} your attention`
						: "Sync: Conflicts need your attention",
				severity: "info",
			});
			return;
		}
		if (result.newState === "offline" && result.lastError) {
			// Terminal errors raise a persistent VS Code notification (toast)
			// naming the phase that broke; the toolbar clears to idle since
			// the round is no longer in flight. Transient `network` failures
			// also clear — leaving "Syncing memory bank…" on the toolbar
			// would imply in-flight work when in reality the round bailed and
			// the next poll won't fire for up to 90 minutes.
			this.statusStore.setSyncPhase(null);
			if (isTerminalSyncError(result.lastError.code)) {
				const phaseKey: SyncPhase | "starting" =
					this.currentPhase ?? "starting";
				this.notifyError?.(FAILURE_LABELS[phaseKey], result.lastError.message);
			}
			return;
		}
		// `newState === "syncing"` (sync.lock held by another process — could
		// be a stale lock from a previous crashed round or a genuine
		// concurrent VS Code window). The current round didn't actually run,
		// so showing an in-flight "Syncing…" indicator is a lie. Clear to
		// idle; the next poll will retry.
		this.statusStore.setSyncPhase(null);
	}

	/**
	 * Late-binding setter for the post-round listener. Used by Extension.ts
	 * after `KbFoldersService` and `SidebarWebviewProvider` are constructed.
	 * Passing `undefined` clears the listener.
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
	// P2 #2 — surface stageVault's canary buckets. Without this the
	// `symlinked` paths (strong hostile-placement signal) only land in
	// the engine log; the status bar shows a green check even though the
	// round refused to stage potentially malicious content. See
	// `SyncRoundResult.canary` doc — UI consumers SHOULD surface these
	// even when `newState === "synced"`.
	const canary = result.canary;
	if (canary !== undefined) {
		if (canary.symlinked.length > 0) {
			detail.canarySymlinkedCount = canary.symlinked.length;
			detail.canarySymlinkedSample = canary.symlinked;
		}
		if (canary.unowned.length > 0) {
			detail.canaryUnownedCount = canary.unowned.length;
			detail.canaryUnownedSample = canary.unowned;
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
