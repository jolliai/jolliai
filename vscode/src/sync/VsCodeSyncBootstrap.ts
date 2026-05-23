/**
 * VS Code activation glue for the Memory Bank sync engine.
 *
 * `activateSync` is called once from `Extension.activate()`. It always
 * registers the sync commands; the `StatusOrchestrator` itself is built
 * **lazily** the first time it's needed — either eagerly at activation if
 * the user is already signed in (`jolliApiKey` present), or on a manual
 * Sync Now click.
 *
 * Plan §0.7 split the old "Enable Memory Bank cloud sync" master toggle
 * into two independent dimensions:
 *
 *   - **Manual sync** — the "Sync to Personal Space Now" button. Available
 *     whenever `jolliApiKey` is configured; no extra opt-in toggle.
 *   - **Auto sync** — the `Auto-sync to Personal Space` toggle, which maps
 *     to `config.syncEnabled`. Controls whether the orchestrator's polling
 *     tick is scheduled. With auto off, the orchestrator still exists for
 *     manual triggers but never polls on its own.
 *
 * The runtime keeps a single `StatusOrchestrator` reference for the
 * workspace lifetime. Once built it stays built; toggling auto-sync off
 * later does not tear it down (a full tear-down on toggle would require
 * config-watching + dispose plumbing — bigger refactor for a smaller win).
 */

import { clearInterval, setInterval } from "node:timers";
import * as vscode from "vscode";
import { loadConfig } from "../../../cli/src/core/SessionTracker.js";
import { createLogger } from "../../../cli/src/Logger.js";
import { buildSyncEngine } from "../../../cli/src/sync/SyncBootstrap.js";
import type { StatusBarManager } from "../util/StatusBarManager.js";
import { StatusOrchestrator } from "./StatusOrchestrator.js";
import { registerSyncCommands } from "./SyncCommands.js";
import { VsCodeConflictUi } from "./VsCodeConflictUi.js";

const log = createLogger("Sync:VsCodeBootstrap");

/**
 * Holds the (possibly null) `StatusOrchestrator` for the workspace, and
 * knows how to build it on demand when sync becomes enabled. Commands hold
 * a reference to this runtime instead of the orchestrator directly so they
 * see the latest state after lazy-build.
 */
export class SyncRuntime {
	private orchestrator: StatusOrchestrator | null = null;
	private building: Promise<StatusOrchestrator | null> | null = null;
	/**
	 * Dedupe set for repo-mapping conflict notifications (plan §P2#3).
	 * Key: `${folder}::${sortedIdentities.join("|")}`. Once shown once
	 * per session, the same collision stays silent on every subsequent
	 * poll tick — repeating the same toast every 90 min would be noise.
	 * The set resets on window reload (= new SyncRuntime instance).
	 */
	private readonly notifiedConflicts = new Set<string>();

	/**
	 * `syncPollIntervalSec` captured at orchestrator construction. Settings
	 * changes to this field would otherwise require a window reload because
	 * `StatusOrchestrator` reads `pollIntervalSec` once at construction and
	 * stores it as a fixed `pollMs`. `reconcileAutoSync` compares the live
	 * config value to this captured value and rebuilds the orchestrator on
	 * mismatch (P2#3).
	 */
	private lastBuiltPollIntervalSec: number | undefined = undefined;

	/**
	 * `jolliApiKey` captured at orchestrator construction. An account switch
	 * (sign-out → sign-in with a different key) needs to dispose the cached
	 * orchestrator so the next round mints under the new identity; without
	 * this, `ensureBuilt` would happily return the stale instance because
	 * the post-sign-in key is non-empty. Pre-fix the docstring claimed
	 * "dispose on changed jolliApiKey" but no key comparison was actually
	 * implemented.
	 */
	private lastBuiltJolliApiKey: string | undefined = undefined;

	/**
	 * Dispose for the LockedWaitHandler attached to the currently-active
	 * orchestrator. Each `ensureBuilt` rebuild creates a fresh handler
	 * (with its own interval-cleanup closure); the prior handler must be
	 * disposed before we lose the reference, otherwise the closure leaks
	 * until extension deactivate (one leak per rebuild — sign-out → sign-in,
	 * account switch, poll-interval change all rebuild).
	 */
	private currentLockedWaitDispose: (() => void) | null = null;

	/**
	 * Late-bound post-round listener — set via `setOnRoundFinished` after
	 * the dependencies (kbFolders, sidebar) are constructed. Stored here so
	 * orchestrators built later via `ensureBuilt()` inherit it on creation.
	 */
	private onRoundFinished?: Parameters<StatusOrchestrator["setOnRoundFinished"]>[0];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly statusBar: StatusBarManager,
		/**
		 * Promise that must settle before the first sync round runs.
		 * Wired to the extension's `initializeKB()` so the per-source-repo
		 * `.jolli/config.json` is on disk before any `git pull` (P1#2 fix).
		 */
		private readonly readyPromise: Promise<void> = Promise.resolve(),
	) {}

	/**
	 * Wires the post-round callback. Safe to call before or after the
	 * orchestrator is built — propagates to a live orchestrator immediately
	 * and is also re-applied to any orchestrator created later.
	 */
	setOnRoundFinished(cb: Parameters<StatusOrchestrator["setOnRoundFinished"]>[0]): void {
		this.onRoundFinished = cb;
		this.orchestrator?.setOnRoundFinished(cb);
	}

	/** Returns the current orchestrator if built, else null. Does not build. */
	get(): StatusOrchestrator | null {
		return this.orchestrator;
	}

	/**
	 * Tears down the currently-cached orchestrator + its locked-wait handler
	 * and clears the three captured-config fields. Used by every rebuild
	 * path (sign-out, account switch, poll-interval change) so the leak fix
	 * stays in one place instead of duplicated across four call sites.
	 */
	private disposeOrchestrator(): void {
		if (this.orchestrator !== null) {
			this.orchestrator.dispose();
			this.orchestrator = null;
		}
		this.currentLockedWaitDispose?.();
		this.currentLockedWaitDispose = null;
		this.lastBuiltJolliApiKey = undefined;
		this.lastBuiltPollIntervalSec = undefined;
	}

	/**
	 * Plan §P2#3 — surface cross-device folder collisions to the user as
	 * a warning notification, deduplicated within a session. Each unique
	 * `(folder, identities)` tuple shows exactly one toast per workspace
	 * load; repeated calls with the same conflict are silent. Extracted
	 * from the `buildSyncEngine` call site so it can be unit-tested
	 * directly. Visible for tests.
	 */
	notifyRepoMappingConflicts(
		conflicts: ReadonlyArray<{
			folder: string;
			identities: ReadonlyArray<string>;
		}>,
	): void {
		for (const c of conflicts) {
			const key = `${c.folder}::${[...c.identities].sort().join("|")}`;
			if (this.notifiedConflicts.has(key)) continue;
			this.notifiedConflicts.add(key);
			const identitiesList = c.identities.join(", ");
			void vscode.window.showWarningMessage(
				`Memory Bank: the folder "${c.folder}" is claimed by ${c.identities.length} different source repos (${identitiesList}). Rename the source repo or change "Local Folder" on one device to disambiguate.`,
			);
		}
	}

	/**
	 * Reacts to a settings save OR a sign-out: re-reads `syncEnabled` and
	 * `jolliApiKey` from CLI config and starts OR stops the orchestrator's
	 * polling loop to match. Two directions:
	 *
	 *   - OFF → ON: build the orchestrator if not yet built, then
	 *     `orch.start()` (which is itself idempotent). Pre-fix this is
	 *     where polling wouldn't begin without a window reload.
	 *   - ON → OFF: call `orch.stop()` to tear down the interval. Pre-fix
	 *     this transition was completely unhandled — toggling OFF in
	 *     Settings would NOT stop the running poll loop until the window
	 *     was reloaded (P2#2).
	 *
	 * `wantPoll` requires BOTH the user-facing `syncEnabled` toggle AND a
	 * present `jolliApiKey`. Gating on creds here is what makes sign-out
	 * tear down an already-polling orchestrator: `clearAuthCredentials`
	 * drops `jolliApiKey` but leaves `syncEnabled` intact (so it auto-
	 * resumes on next sign-in), and this method then notices the missing
	 * creds and stops the loop.
	 *
	 * All branches re-read CLI config on every call so the truth source
	 * is always disk, not a cached flag.
	 */
	async reconcileAutoSync(): Promise<void> {
		const config = await loadConfig();
		const wantPoll = config.syncEnabled === true && Boolean(config.jolliApiKey);
		// `syncPollIntervalSec` is captured at orchestrator construction
		// (StatusOrchestrator turns it into a fixed `pollMs`). If the user
		// changed it in Settings, the existing orchestrator still ticks at
		// the old interval — dispose + rebuild so the new value takes effect
		// without a window reload (P2#3).
		if (
			this.orchestrator !== null &&
			this.lastBuiltPollIntervalSec !== config.syncPollIntervalSec
		) {
			log.info(
				"reconcileAutoSync: syncPollIntervalSec changed (%s → %s) — rebuilding orchestrator",
				this.lastBuiltPollIntervalSec,
				config.syncPollIntervalSec,
			);
			this.disposeOrchestrator();
		}
		const orch = this.orchestrator;
		if (wantPoll) {
			const built = orch ?? (await this.ensureBuilt());
			if (built === null) return;
			if (built.isPolling) return;
			built.start();
			log.info("reconcileAutoSync: auto-sync polling started");
			return;
		}
		// wantPoll === false. Two sub-cases:
		//
		//   1. `syncEnabled` toggled off but the user is still signed in →
		//      keep the orchestrator alive so manual `syncNow` still works;
		//      just stop the polling tick.
		//   2. `jolliApiKey` is gone (sign-out) → dispose + null so a later
		//      sign-in flows through `ensureBuilt` instead of reusing the
		//      stale instance. Without this, the post-sign-in path with
		//      unchanged poll interval would short-circuit on the cached
		//      `orch !== null` and never re-evaluate auth state.
		if (orch !== null && !config.jolliApiKey) {
			this.disposeOrchestrator();
			log.info("reconcileAutoSync: jolliApiKey gone — disposed cached orchestrator (sign-out)");
			return;
		}
		// Stop only if currently polling. If the orchestrator was never
		// built, there's nothing to stop.
		if (orch?.isPolling) {
			orch.stop();
			log.info("reconcileAutoSync: auto-sync polling stopped");
		}
	}

	/**
	 * Builds the orchestrator if prerequisites are now met. Returns null
	 * when sync is still dormant (no auth, no workspace, or the engine
	 * builder bails). Subsequent calls return the same instance — once
	 * built, it stays built for the session.
	 *
	 * Plan §0.7: this no longer gates on `config.syncEnabled`. That flag
	 * only controls whether the polling tick gets scheduled (see the
	 * `orch.start()` branch below). Manual `Sync Now` works whenever
	 * `jolliApiKey` is set, regardless of the auto-sync toggle.
	 *
	 * Concurrent callers share a single in-flight build promise so two
	 * near-simultaneous `syncNow` clicks don't race two orchestrators into
	 * existence.
	 */
	async ensureBuilt(): Promise<StatusOrchestrator | null> {
		// Sign-out invalidates the cached orchestrator. The orchestrator's
		// engine still mints fresh creds every round, BUT
		// `SyncCommands.syncNow` relies on `ensureBuilt()` returning null
		// in the dormant state to show the actionable "needs sign-in" toast
		// instead of letting the round die at `mint_failed` with a noisier
		// auth message. So before returning the cached instance, confirm
		// the user is still signed in; if not, dispose and fall through to
		// the dormant return.
		//
		// We also dispose on a *changed* `jolliApiKey` (e.g. account
		// switch) so the next round picks up the new creds via a fresh
		// engine build. The engine itself reads creds per round via
		// `BackendClient`'s default provider, so this is mostly belt-and-
		// suspenders for cases where account switch coincides with other
		// config changes; the always-dispose-on-missing branch is the
		// load-bearing one.
		const config = await loadConfig();
		if (!config.jolliApiKey) {
			if (this.orchestrator !== null) {
				log.info("ensureBuilt: jolliApiKey gone — disposing cached orchestrator (sign-out)");
				this.disposeOrchestrator();
			}
			return null;
		}
		// Account switch — same field is now a different key. Dispose so
		// the next build mints under the new identity.
		if (
			this.orchestrator !== null &&
			this.lastBuiltJolliApiKey !== undefined &&
			this.lastBuiltJolliApiKey !== config.jolliApiKey
		) {
			log.info("ensureBuilt: jolliApiKey changed — disposing cached orchestrator (account switch)");
			this.disposeOrchestrator();
		}
		if (this.orchestrator !== null) return this.orchestrator;
		if (this.building !== null) return this.building;
		this.building = (async () => {
			try {
				const folder = vscode.workspace.workspaceFolders?.[0];
				if (!folder) {
					log.debug("ensureBuilt: no workspace folder");
					return null;
				}
				// Plan §0.12 — when the engine hits 423 vault_locked, flip the
				// status bar to "Personal Space busy" immediately instead of
				// leaving it on the silent "Syncing…" spinner for up to 6 min.
				// Capture `statusBar` once so the closure can reach it later
				// even though `this` isn't usable inside a plain function ref.
				//
				// The engine now carries an `info.selfLocked` boolean (sourced
				// from persisted `pending-lock.json` evidence — see
				// `PendingLockStore` and `SyncEngine.readSelfLockState`).
				// No thunk wiring needed; the handler reads it directly off
				// each event so plugin-reload, CLI, and account-switch
				// scenarios all produce the right label without extra glue.
				const statusBar = this.statusBar;
				const onLockedWait = makeLockedWaitHandler(statusBar);
				// Record dispose on the runtime so a subsequent rebuild
				// (sign-out → sign-in, account switch, poll-interval change)
				// can free the prior handler's interval-cleanup closure
				// instead of leaking it until extension deactivate. The
				// `context.subscriptions` entry reads the live field so
				// deactivate disposes the currently-active handler and
				// post-rebuild becomes a no-op (instead of double-disposing).
				this.currentLockedWaitDispose = () => onLockedWait.dispose();
				this.context.subscriptions.push({
					dispose: () => this.currentLockedWaitDispose?.(),
				});
				const engine = await buildSyncEngine({
					cwd: folder.uri.fsPath,
					ui: new VsCodeConflictUi(),
					onLockedWait: onLockedWait.handler,
					// Plan §P2#3 — extracted so we can unit-test it
					// independently of the full `ensureBuilt` IIFE which
					// requires a real workspace folder + engine wiring.
					onRepoMappingConflict: (conflicts) =>
						this.notifyRepoMappingConflicts(conflicts),
				});
				if (engine === null) {
					log.debug("ensureBuilt: buildSyncEngine returned null");
					return null;
				}
				const orch = new StatusOrchestrator({
					engine,
					statusBar: this.statusBar,
					workspaceFolder: folder,
					pollIntervalSec: config.syncPollIntervalSec,
					readyPromise: this.readyPromise,
					onRoundFinished: this.onRoundFinished,
				});
				this.lastBuiltPollIntervalSec = config.syncPollIntervalSec;
				this.lastBuiltJolliApiKey = config.jolliApiKey;
				this.context.subscriptions.push(orch);
				// Auto polling is gated by `syncEnabled` (§0.7). When off, the
				// orchestrator exists for manual `syncNow()` calls but never
				// schedules a poll tick on its own. `orch.isPolling` (rather
				// than a separate flag) is the truth source for whether
				// polling is live, so toggling off later via
				// `reconcileAutoSync` can read it back consistently (P2#2).
				if (config.syncEnabled === true) {
					orch.start();
					log.info("Memory Bank auto-sync polling started");
				} else {
					log.info(
						"Memory Bank sync engine built (auto-sync off — manual only)",
					);
				}
				this.orchestrator = orch;
				return orch;
			} finally {
				this.building = null;
			}
		})();
		return this.building;
	}
}

export interface SyncActivationResult {
	readonly runtime: SyncRuntime;
	readonly disposables: ReadonlyArray<vscode.Disposable>;
}

/**
 * Plan §0.12 — adapt engine `onLockedWait` events into a live status-bar
 * countdown. Each engine event reseats the timer (mid-wait re-fires are
 * possible if the engine re-mints quickly and the next attempt also 423s),
 * and the timer self-stops when it hits zero. Two engine semantics this
 * helper pins down:
 *
 *   - **`info.attempt` is 1-indexed** ("`attempt = 1` = the initial mint
 *     that just observed 423"). The displayed label `"attempt N/M failed"`
 *     uses the raw value verbatim — the pre-fix `info.attempt + 1` form
 *     ran off the end on the final wait (`3 + 1 = 4` of `4`, but attempt 4
 *     was the LAST attempt with no retry after it).
 *   - **`nextRetryInMs` is the upcoming wait**, not the time-since-start.
 *     We tick `remainSec` down once per second so the user sees motion.
 *
 * Returns a handler + `dispose` so the extension can clear any in-flight
 * timer at deactivation. Exported for unit tests.
 */
export interface LockedWaitHandler {
	readonly handler: (info: {
		readonly attempt: number;
		readonly totalAttempts: number;
		readonly nextRetryInMs: number;
		readonly message: string;
		readonly selfLocked: boolean;
	}) => void;
	dispose(): void;
}

export function makeLockedWaitHandler(
	statusBar: {
		setSyncState: StatusBarManager["setSyncState"];
	},
): LockedWaitHandler {
	let timer: ReturnType<typeof setInterval> | null = null;
	const clearTimer = () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
	const handler: LockedWaitHandler["handler"] = (info) => {
		clearTimer();
		let remainSec = Math.max(0, Math.round(info.nextRetryInMs / 1000));
		const render = () => {
			// `info.selfLocked` is engine-provided and persistence-backed
			// (see `PendingLockStore` / `SyncEngine.readSelfLockState`).
			// `true` means this device's prior round acquired the backend
			// write-lock and never released it via notify-push; the entry
			// is still within the TTL grace window. Read it verbatim — no
			// echo to a process memo, no thunk indirection.
			const selfLocked = info.selfLocked;
			const lastError = selfLocked
				? `Your previous sync left the Personal Space lock held; it is still releasing. Attempt ${info.attempt}/${info.totalAttempts} — next retry in ${remainSec}s`
				: `${info.message} (attempt ${info.attempt}/${info.totalAttempts} — next retry in ${remainSec}s)`;
			statusBar.setSyncState("offline", {
				failed: true,
				failedCode: "vault_locked",
				selfLocked,
				lastError,
			});
		};
		render();
		if (remainSec > 0) {
			timer = setInterval(() => {
				remainSec = Math.max(0, remainSec - 1);
				render();
				if (remainSec === 0) clearTimer();
			}, 1000);
		}
	};
	return { handler, dispose: clearTimer };
}

/**
 * Registers the sync commands and eagerly tries to build the orchestrator.
 * On a cold start with `syncEnabled` already true, this is the only
 * bootstrap path. On a fresh enable mid-session, `runtime.ensureBuilt()`
 * is called from the command handlers (via `registerSyncCommands`'s
 * `runtime` argument).
 */
export async function activateSync(
	context: vscode.ExtensionContext,
	statusBar: StatusBarManager,
	/**
	 * P1#2 gate — sync rounds wait for `<localFolder>/<repo>/.jolli/
	 * config.json` to exist before pulling. Pass the extension's
	 * `initializeKB()` Promise here.
	 */
	readyPromise: Promise<void> = Promise.resolve(),
): Promise<SyncActivationResult> {
	const runtime = new SyncRuntime(context, statusBar, readyPromise);

	// Eager build for the common case where sync was already enabled when
	// the window opened. Errors are swallowed — activation must never fail.
	await runtime.ensureBuilt().catch((e) => {
		log.warn("eager ensureBuilt failed: %s", (e as Error).message);
	});

	const cmds = registerSyncCommands({ runtime });
	for (const d of cmds) context.subscriptions.push(d);

	return { runtime, disposables: cmds };
}
