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
		const { resolveLlmCredentialSource } = await import("../../cli/src/core/LlmClient.js");
		const config = await loadConfig();
		// Gate on a usable generation path, not on a raw key: the Local Agent provider
		// generates through the agent tool's own login and holds no API key, so a
		// key-only check would wrongly block it. Mirrors the CLI compile gate.
		if (resolveLlmCredentialSource(config) === null) {
			log.info("CompileCommand", "No usable LLM provider — showing info message");
			await vscode.window.showInformationMessage(
				"Building the knowledge wiki needs an AI provider. Open Settings → Memory Bank to sign in, configure a key, or select the Local Agent, then try again.",
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
			const n = result.totalIngested;
			const repos = `${result.repos.length} repo(s)`;
			// User-facing wording: say "commit summaries" (not the internal "sources"),
			// and special-case 0 as "already up to date" so it never reads as
			// "0 sources / nothing found".
			const summary =
				n === 0
					? `Knowledge wiki already up to date — no new commit summaries to add (${repos})${failedNote}.`
					: `Knowledge wiki updated — added ${n} new commit summar${n === 1 ? "y" : "ies"} across ${repos}${failedNote}.`;
			await vscode.window.showInformationMessage(summary);
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
