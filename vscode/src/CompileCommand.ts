/**
 * Command registration for the "Build Knowledge Wiki" toolbar button.
 *
 *   - `jollimemory.compileNow` — sweeps every repo in the Memory Bank folder via
 *     `compileAllRepos`, then refreshes the Memory Bank panel. The button lives on
 *     the repo-wide Memory Bank panel, so it compiles all repos (not just the
 *     active workspace).
 */

import * as vscode from "vscode";
import { log } from "./util/Logger.js";

export interface CompileCommandOpts {
	readonly sidebarProvider: { refreshKnowledgeBaseFolders(): void };
}

/**
 * Re-entrancy guard for the multi-repo sweep. `compileAllRepos` mutates the
 * process-global storage override per repo, so two overlapping runs (double-click,
 * or a compile launched while one is still going) would interleave those swaps and
 * write a repo's pages through another repo's storage. The sibling `syncNow`
 * coalesces in-flight rounds for the same reason; this is the compile analogue.
 */
let compileInFlight = false;

export function registerCompileCommand(opts: CompileCommandOpts): vscode.Disposable {
	return vscode.commands.registerCommand("jollimemory.compileNow", async () => {
		log.info("CompileCommand", "jollimemory.compileNow invoked");
		const { sidebarProvider } = opts;

		const { loadConfig } = await import("../../cli/src/core/SessionTracker.js");
		const config = await loadConfig();
		if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
			log.info("CompileCommand", "No API key configured — showing info message");
			await vscode.window.showInformationMessage(
				"Building the knowledge wiki needs an API key. Open Settings → Memory Bank to sign in or configure a key, then try again.",
			);
			return;
		}
		if (!config.localFolder) {
			await vscode.window.showInformationMessage(
				"No Memory Bank folder configured. Open Settings → Memory Bank to set one, then try again.",
			);
			return;
		}

		// Check-and-set with no await in between, so concurrent invocations can't
		// both pass the guard.
		if (compileInFlight) {
			log.info("CompileCommand", "compile already in flight — ignoring concurrent invocation");
			await vscode.window.showInformationMessage("Knowledge wiki build is already in progress.");
			return;
		}
		compileInFlight = true;

		const { compileAllRepos } = await import("../../cli/src/core/MultiRepoCompile.js");

		try {
			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					// Title is fixed for the notification's lifetime (VS Code API), so it
					// stays a neutral prefix; the wiki/graph phase + repo + detail all ride
					// in progress.report({ message }) so both phases appear as peers.
					title: "Jolli Memory",
					cancellable: false,
				},
				async (progress) =>
					compileAllRepos(config.localFolder as string, config, {
						onProgress: (message) => progress.report({ message }),
					}),
			);
			const failedNote = result.failed ? ` (${result.failed} failed)` : "";
			await vscode.window.showInformationMessage(
				`Knowledge wiki updated: ${result.totalIngested} source(s) across ${result.repos.length} repo(s)${failedNote}.`,
			);
		} catch (err) {
			await vscode.window.showErrorMessage(
				`Knowledge wiki build failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			compileInFlight = false;
		}

		sidebarProvider.refreshKnowledgeBaseFolders();
	});
}
