/**
 * Edge-triggered popup gate for the `symlink_quarantine_failed` terminal
 * code (plan §P2 / I6).
 *
 * **Why a gate.** The status bar already surfaces every terminal sync
 * failure (red "Sync paused", tooltip with `lastError.message`), but the
 * tooltip is invisible until the user hovers the bar. For a security
 * gate that just refused to stage the round, the user must see a one-time
 * prompt — otherwise the failure is effectively silent.
 *
 * **Why session-only (no on-disk state).** Persistent state (`.jolli/…`)
 * would require write paths, cleanup logic, and account-switch
 * scoping. A per-process boolean covers every real scenario:
 *
 *   - Transient (EBUSY / antivirus lock): one popup, next round
 *     sweeps clean, flag re-arms. The user sees one notification,
 *     not a stream.
 *   - Persistent (real hostile symlink the user must remove): one
 *     popup, every subsequent failed round is silent in the
 *     notification area but the status bar stays red. A VS Code
 *     restart re-arms — that next popup IS a useful reminder
 *     because the user hasn't acted yet.
 *   - Mixed (user fixes one symlink, another appears later): the
 *     `failed=0` round in between flips the flag back to armed,
 *     so the second symlink gets its own popup.
 *
 * The gate intentionally does NOT take a `vscode` import; the caller
 * passes a `show` function bound to `vscode.window.showErrorMessage`.
 * This keeps the file unit-testable without a `vscode` mock.
 */

import type { SyncRoundResult } from "../../../cli/src/sync/SyncTypes.js";

/**
 * Decision returned by `onRoundFinished` so the caller can dispatch the
 * button actions (`vscode.commands.executeCommand`, opening a folder URI,
 * …). The gate itself stays free of `vscode` dependencies so it can be
 * unit-tested as plain TypeScript.
 */
export interface PopupAction {
	readonly message: string;
	readonly actions: ReadonlyArray<string>;
}

/**
 * `armed` semantics:
 *
 *   - `true` (initial state): the next `failed > 0` round fires a popup.
 *   - `false` (after firing): silenced until a `failed === 0` outcome
 *     re-arms us.
 *
 * Any non-`symlink_quarantine_failed` round result counts as `failed === 0`
 * for re-arming purposes — a clean sync, a `network` blip, even a
 * different terminal code all qualify. The point is to fire again the
 * next time the symlink sweep specifically fails.
 */
export class SymlinkPopupGate {
	private armed = true;

	/**
	 * Returns the popup payload if a popup should be fired this round, or
	 * `null` if the gate is silenced or the round was not a symlink failure.
	 *
	 * Visible for testing — production callers wire the result to
	 * `vscode.window.showErrorMessage(payload.message, ...payload.actions)`.
	 */
	consume(result: SyncRoundResult): PopupAction | null {
		const isSymlinkFail = result.lastError?.code === "symlink_quarantine_failed";
		if (!isSymlinkFail) {
			this.armed = true;
			return null;
		}
		if (!this.armed) return null;
		this.armed = false;
		const tail = result.lastError?.message ? `: ${result.lastError.message}` : "";
		return {
			message: `Memory Bank sync paused — symlink quarantine failed${tail}. Inspect the Memory Bank folder and try again.`,
			actions: ["Open Memory Bank Folder"],
		};
	}
}
