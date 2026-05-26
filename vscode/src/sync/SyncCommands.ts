/**
 * Command registrations for the Memory Bank sync surface.
 *
 *   - `jollimemory.syncNow` — drives one round via
 *     `runtime.ensureBuilt()`+`syncNow()`. Lazy-builds the orchestrator on
 *     first invocation after the user enables sync, so the Settings
 *     toggle takes effect without a Reload Window.
 */

import * as vscode from "vscode";
import { log } from "../util/Logger.js";
import type { SyncRuntime } from "./VsCodeSyncBootstrap.js";

export interface SyncCommandsOpts {
	readonly runtime: SyncRuntime;
}

export function registerSyncCommands(
	opts: SyncCommandsOpts,
): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand("jollimemory.syncNow", async () => {
			log.info("SyncCommands", "jollimemory.syncNow invoked → ensureBuilt()");
			const orch = await opts.runtime.ensureBuilt();
			if (orch === null) {
				// §0.7: the only remaining precondition for manual sync is a
				// Jolli sign-in. The dormant toast points the user there
				// (Settings → Memory Bank account section) rather than at the
				// long-gone "Enable Memory Bank cloud sync" master toggle.
				log.warn(
					"SyncCommands",
					"ensureBuilt returned null — sync dormant, showing info toast",
				);
				await vscode.window.showInformationMessage(
					"Memory Bank sync needs a Jolli sign-in. Open Settings → Memory Bank and sign in to Jolli, then try again.",
				);
				return;
			}
			// P3-A — always route through `requestManualSync`, which
			// coalesces in-flight rounds correctly:
			//
			//   - No round in flight → fires a manual tick (old `syncNow()`
			//     behaviour).
			//   - Round in flight → arms `pendingManualFollowup`, awaits the
			//     in-flight promise, then a followup manual tick runs in
			//     `tick`'s finally. Required because the in-flight round may
			//     bail at the generation-mismatch check without executing
			//     the engine (e.g. user toggled auto-sync OFF during a
			//     `readyPromise` wait). Pre-fix: SyncCommands early-returned
			//     and the user's click was silently lost.
			//
			// Status bar still shows "Syncing…" throughout, so the user has
			// visible feedback without an extra toast.
			log.info("SyncCommands", "orchestrator available → calling requestManualSync()");
			await orch.requestManualSync();
			log.info("SyncCommands", "requestManualSync() completed");
		}),
	];
}
