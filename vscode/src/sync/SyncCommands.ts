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
			// A round may already be running from a previous click or from
			// the polling timer. We **don't queue another round** — silently
			// ignore the click. No toast: the status bar already shows
			// "Syncing…" so the user has visible feedback; a popup would be
			// noise ("yes, I know, I'm the one who clicked") and could even
			// be confusing if the round finished between the click and the
			// toast render.
			if (orch.isRoundInFlight()) {
				log.info(
					"SyncCommands",
					"syncNow ignored — a round is already in flight (silent no-op)",
				);
				return;
			}
			log.info("SyncCommands", "orchestrator available → calling syncNow()");
			await orch.syncNow();
			log.info("SyncCommands", "syncNow() completed");
		}),
	];
}
