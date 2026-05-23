/**
 * StatusBarManager
 *
 * Owns the bottom status bar item for Jolli Memory. Two distinct surfaces:
 *
 *   - **Legacy** (default, used when `config.syncEnabled !== true`):
 *     `Jolli Memory` when enabled, `$(circle-outline) Jolli Memory (disabled)`
 *     when disabled. Drive via `update(enabled: boolean)` — the existing API
 *     that command modules (`CommitCommand`, `PushCommand`, etc.) already call.
 *
 *   - **Sync** (used when the Memory Bank sync engine is active): a 4-state
 *     machine — `synced` / `syncing` / `conflicts` / `offline`. Drive via
 *     `setSyncState(state, detail?)` from the sync orchestrator. Optional
 *     detail (`conflictCount`, `lastError`, etc.) feeds the tooltip.
 *
 * Branch and staged count are not shown — VS Code's built-in Source Control
 * status bar already provides that information.
 */

import * as vscode from "vscode";
import type { TerminalSyncErrorCode } from "../../../cli/src/sync/SyncTypes.js";

/** UI-facing sync states matching the source plan §6 four-icon model. */
export type SyncState = "synced" | "syncing" | "conflicts" | "offline";

/** Optional context surfaced in the status bar tooltip. */
export interface SyncStatusDetail {
	readonly conflictCount?: number;
	readonly lastFetchAt?: string;
	readonly lastError?: string;
	/**
	 * When true on an `offline` state, the bar renders a terminal-failure
	 * visual (red `Sync failed` by default, or a specialized one keyed on
	 * `failedCode`). Set by the orchestrator when the round's
	 * `lastError.code` is anything other than `network` — those codes mark
	 * the round as truly failed; `network` errors stay quiet because the
	 * next poll tick almost always recovers.
	 */
	readonly failed?: boolean;
	/**
	 * Specific lastError code for the failed visual. Lets the bar pick a
	 * gentler treatment for recoverable causes like `vault_locked` (just
	 * "Personal Space busy", warning background — the user can retry once
	 * the other device finishes) vs. the louder "Sync failed" + error
	 * background for everything else.
	 */
	readonly failedCode?: TerminalSyncErrorCode;
	/**
	 * Set on `vault_locked` rounds when the lock is **almost certainly held
	 * by THIS device's own previous round** — i.e. the orchestrator
	 * remembers a previous round that ended offline with a terminal
	 * non-network code (vault_mismatch / push failed / migration failed /
	 * pull failed / mint failed). That round acquired the backend lock at
	 * mint time but never reached notify-push, so the lock is dangling on
	 * its TTL. Without this flag the user sees "Personal Space is being
	 * synced by another device" which is misleading and unhelpful — they
	 * can't speed up an unknown peer, they CAN learn about the actual
	 * cause and wait the (shorter than they think) TTL.
	 */
	readonly selfLocked?: boolean;
}

export class StatusBarManager {
	private readonly item: vscode.StatusBarItem;
	/**
	 * Set the first time `setSyncState` is called; never cleared. The sync
	 * orchestrator owns the bar while sync is active, so the legacy
	 * `update(enabled)` path (called from commit/push/squash listeners and
	 * `refreshStatusBar`) must NOT clobber "Syncing…" / "Sync failed" /
	 * "Conflicts" with a plain "Jolli Memory". Pre-fix every memory op
	 * silently wiped the sync visual until the next poll tick rewrote it.
	 *
	 * One-way flag: once sync has taken over for the session, no other
	 * caller can downgrade the bar. The orchestrator's own `setSyncState`
	 * remains the only way to change the visual.
	 */
	private syncOwned = false;

	constructor() {
		this.item = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			100,
		);
		this.item.command = "jollimemory.focusSidebar";
		this.item.tooltip = "Jolli Memory — click to open sidebar";
		this.item.show();
	}

	/**
	 * Legacy visual. Used by existing command modules and by activate() when
	 * `config.syncEnabled` is false. Preserves 0.99.x pixel output exactly.
	 *
	 * No-op once sync has taken over the bar — see `syncOwned`.
	 */
	update(enabled: boolean): void {
		if (this.syncOwned) return;
		if (!enabled) {
			this.item.text = "$(circle-outline) Jolli Memory (disabled)";
			this.item.backgroundColor = new vscode.ThemeColor(
				"statusBarItem.warningBackground",
			);
			this.item.color = undefined;
			this.item.tooltip = "Jolli Memory — click to open sidebar";
			return;
		}

		this.item.text = "Jolli Memory";
		this.item.backgroundColor = undefined;
		this.item.color = undefined;
		this.item.tooltip = "Jolli Memory — click to open sidebar";
	}

	/**
	 * Sync visual. Used by the StatusOrchestrator when `config.syncEnabled` is
	 * true and a `SyncEngine` is driving rounds.
	 */
	setSyncState(state: SyncState, detail?: SyncStatusDetail): void {
		this.syncOwned = true;
		switch (state) {
			case "synced":
				this.item.text = "$(check) Jolli Memory";
				this.item.backgroundColor = undefined;
				this.item.color = undefined;
				this.item.tooltip = buildTooltip("Memory Bank in sync", detail);
				return;
			case "syncing":
				this.item.text = "$(sync~spin) Syncing…";
				this.item.backgroundColor = undefined;
				this.item.color = undefined;
				this.item.tooltip = buildTooltip(
					"Memory Bank sync in progress",
					detail,
				);
				return;
			case "conflicts": {
				const n = detail?.conflictCount ?? 0;
				this.item.text =
					n > 0
						? `$(warning) ${n} conflict${n === 1 ? "" : "s"}`
						: "$(warning) Conflicts";
				this.item.backgroundColor = new vscode.ThemeColor(
					"statusBarItem.warningBackground",
				);
				this.item.color = undefined;
				this.item.tooltip = buildTooltip(
					n > 0
						? `${n} ${n === 1 ? "item needs" : "items need"} your attention`
						: "Memory Bank has conflicts",
					detail,
				);
				return;
			}
			case "offline":
				if (detail?.failed && detail.failedCode !== undefined) {
					const visual = terminalCodeVisual(detail.failedCode, detail);
					this.item.text = visual.text;
					this.item.backgroundColor = new vscode.ThemeColor(visual.backgroundThemeKey);
					this.item.color = undefined;
					this.item.tooltip = buildTooltip(visual.headline, detail);
					return;
				}
				// Transient offline (e.g., network blip, backend hiccup) — do
				// NOT surface a problem-looking visual, because:
				//   - "Offline" reads like sign-in / auth trouble at a glance
				//   - "Unsynced" reads like the user disabled sync themselves
				//   - the next poll tick is overwhelmingly likely to recover
				// Fall back to the neutral legacy visual. A persistent failure
				// will eventually surface as `failed: true` once retry budgets
				// exhaust (handled above).
				this.item.text = "Jolli Memory";
				this.item.backgroundColor = undefined;
				this.item.color = undefined;
				this.item.tooltip = "Jolli Memory — click to open sidebar";
				return;
		}
	}

	/** Disposes the status bar item. */
	dispose(): void {
		this.item.dispose();
	}
}

function buildTooltip(headline: string, detail?: SyncStatusDetail): string {
	if (!detail) return `${headline} — click to open sidebar`;
	const parts = [headline];
	if (detail.lastError) parts.push(`Error: ${detail.lastError}`);
	if (detail.lastFetchAt) parts.push(`Last fetch: ${detail.lastFetchAt}`);
	parts.push("Click to open sidebar");
	return parts.join("\n");
}

interface TerminalCodeVisual {
	readonly text: string;
	readonly headline: string;
	readonly backgroundThemeKey: "statusBarItem.warningBackground" | "statusBarItem.errorBackground";
}

/**
 * Maps every `TerminalSyncErrorCode` to its status-bar visual. Compile-
 * enforced exhaustiveness (the trailing `assertNever`) means adding a
 * new terminal code to the union breaks the build here until a UI
 * treatment is chosen for it — pre-fix the previous if/else fell back to
 * a generic "Sync failed" for any new code and the omission was invisible.
 */
function terminalCodeVisual(code: TerminalSyncErrorCode, detail: SyncStatusDetail): TerminalCodeVisual {
	switch (code) {
		case "vault_locked":
			// Recoverable contention — another device is mid-sync, OR THIS
			// device's previous round left the backend lock dangling. Warning
			// (not error) background so the user understands "wait a moment",
			// not "fix something".
			return {
				text: "$(error) Personal Space busy",
				headline:
					detail.selfLocked === true
						? "Your previous sync failed and its backend lock is still releasing — no other device is involved"
						: "Personal Space is being synced by another device",
				backgroundThemeKey: "statusBarItem.warningBackground",
			};
		case "localfolder_invalid":
			return {
				text: "$(error) Memory Bank folder invalid",
				headline: "Update the Memory Bank folder in Settings",
				backgroundThemeKey: "statusBarItem.errorBackground",
			};
		case "push_rejected":
			return {
				text: "$(error) Push rejected",
				headline: "Server refused the push — see Memory Bank log for details",
				backgroundThemeKey: "statusBarItem.errorBackground",
			};
		case "symlink_quarantine_failed":
			// §P2 sweep refused to let the round continue because one or more
			// symlinks could not be moved into the quarantine directory. The
			// next round retries (idempotent), so transient EBUSY/AV cases
			// self-recover; the headline tells the user where to look if it
			// persists.
			return {
				text: "$(error) Sync paused",
				headline: "Symlink quarantine failed — inspect Memory Bank folder, then retry",
				backgroundThemeKey: "statusBarItem.errorBackground",
			};
		case "vault_mismatch":
		case "mint_failed":
		case "git_missing":
		case "clone_failed":
		case "fetch_failed":
		case "pull_failed":
		case "migration_failed":
		case "sync_failed_after_retries":
			return {
				text: "$(error) Sync failed",
				headline: "Memory Bank sync failed",
				backgroundThemeKey: "statusBarItem.errorBackground",
			};
		default: {
			// Compile-time guard — a new TerminalSyncErrorCode forces a
			// case here. Runtime fallback is the generic visual so we
			// never crash the status bar on an unrecognized code.
			const _exhaustive: never = code;
			void _exhaustive;
			return {
				text: "$(error) Sync failed",
				headline: "Memory Bank sync failed",
				backgroundThemeKey: "statusBarItem.errorBackground",
			};
		}
	}
}
