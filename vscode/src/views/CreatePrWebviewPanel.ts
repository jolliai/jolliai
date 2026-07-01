/**
 * CreatePrWebviewPanel
 *
 * Singleton editor-column webview that presents a "Create Pull Request" pane
 * pre-populated with the branch's memories, diff stats, and a drafted PR body.
 *
 * Lifecycle modelled on NoteEditorWebviewPanel.  Message handling mirrors the
 * PR-action patterns in SummaryWebviewPanel (worker-busy guard, cross-branch
 * guard delegated to handleCreatePr).
 *
 * openDiff note (v1): a true branch-vs-main per-file diff requires resolving a
 * merge-base ref outside the vscode.diff API; for v1 the handler falls back to
 * opening the working-tree file via vscode.open so the user at least sees the
 * file content.  A follow-up can wire up the real branch diff command once one
 * is registered.
 */

import { randomBytes } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { isPathInside } from "../../../cli/src/core/PathUtils.js";
import { wrapWithMarkers } from "../../../cli/src/core/PrDescription.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { findOpenPrForBranch, handleCreatePr, handleUpdatePrWithPush } from "../services/PrCommentService.js";
import { log } from "../util/Logger.js";
import { isWorkerBlockingBusy } from "../util/LockUtils.js";
import { buildCreatePrViewModel, type CreatePrViewModel } from "./CreatePrData.js";
import { buildCreatePrHtml } from "./CreatePrHtmlBuilder.js";

/** Messages sent from the Create PR webview to the extension host. */
type Msg =
	| { command: "createPr"; title?: string; body?: string }
	| { command: "copyBody" }
	| { command: "openMemory"; hash: string }
	| { command: "openDiff"; path: string }
	| { command: "openPr"; url: string };

export class CreatePrWebviewPanel {
	private static current: CreatePrWebviewPanel | undefined;

	private vm: CreatePrViewModel | undefined;

	/**
	 * Host-side in-flight guard for the create/update-PR action. The webview's own
	 * `inFlight` flag only survives within a single render, but `show()` re-renders
	 * this same singleton (resetting the webview's flag to false) when the "Create
	 * PR" command is re-run. Without a host-side lock, a second click while the
	 * first push/create is still awaiting would fire a concurrent push + duplicate
	 * PR create. This flag lives on the instance, so it spans re-renders.
	 */
	private prActionInFlight = false;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly workspaceRoot: string,
	) {
		this.panel.onDidDispose(() => {
			CreatePrWebviewPanel.current = undefined;
		});
		this.panel.webview.onDidReceiveMessage((m: Msg) => {
			void this.handle(m);
		});
	}

	/**
	 * Opens the Create PR pane (or reveals the existing one).
	 *
	 * Returns early with an info toast when there are no unmerged memories on
	 * the current branch — nothing to draft a PR from.
	 */
	static async show(
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		bridge: JolliMemoryBridge,
		mainBranch: string,
	): Promise<void> {
		const result = await buildCreatePrViewModel(bridge, mainBranch);
		if ("empty" in result) {
			await vscode.window.showInformationMessage(
				"No committed memories on this branch yet — nothing to open a PR from.",
			);
			return;
		}

		// Detect an open PR already on this branch so the pane renders an
		// "Update PR" affordance instead of "Create PR". Best-effort: a gh
		// failure (not installed / unauthenticated) just leaves the pane in
		// create mode rather than blocking it.
		try {
			const existingPr = await findOpenPrForBranch(workspaceRoot, result.branch);
			if (existingPr) result.existingPr = existingPr;
		} catch (e: unknown) {
			log.warn(
				"CreatePrPanel",
				`existing-PR lookup failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}

		if (CreatePrWebviewPanel.current) {
			CreatePrWebviewPanel.current.render(result);
			CreatePrWebviewPanel.current.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			"jollimemory.createPr",
			`Create PR — ${result.branch}`,
			vscode.ViewColumn.One,
			{ enableScripts: true, localResourceRoots: [extensionUri], retainContextWhenHidden: true },
		);
		const self = new CreatePrWebviewPanel(panel, workspaceRoot);
		CreatePrWebviewPanel.current = self;
		self.render(result);
	}

	/** Disposes the current panel. Used in tests for singleton reset. */
	static dispose(): void {
		if (CreatePrWebviewPanel.current) {
			CreatePrWebviewPanel.current.panel.dispose();
			CreatePrWebviewPanel.current = undefined;
		}
	}

	private render(vm: CreatePrViewModel): void {
		this.vm = vm;
		this.panel.webview.html = buildCreatePrHtml(vm, randomBytes(16).toString("hex"));
	}

	private async handle(m: Msg): Promise<void> {
		if (!this.vm) return;
		const post = (msg: Record<string, unknown>): void => {
			void this.panel.webview.postMessage(msg);
		};

		switch (m.command) {
			case "createPr": {
				if (await isWorkerBlockingBusy(this.workspaceRoot)) {
					vscode.window.showWarningMessage(
						"Jolli Memory: AI summary is being generated. Please wait a moment.",
					);
					// The webview's submit() set inFlight=true and disabled both
					// submit buttons. Without a settling message the listener only
					// re-enables on prCreating/prCreateFailed/prCreateBlockedCrossBranch/
					// prStatus, so returning silently would leave the buttons stuck
					// forever. prCreateFailed is the listener's "operation settled,
					// let the user retry" signal — post it so a retry is possible
					// once the worker finishes. Covers both create and update paths
					// (the guard runs before the existingPr branch). (#1)
					post({ command: "prCreateFailed" });
					return;
				}
				// Host-side re-entry guard. A re-run of the "Create PR" command
				// re-renders this singleton and resets the webview's own inFlight
				// flag, so a second click could otherwise land here while the first
				// push/create is still awaiting — two pushes + a duplicate PR. Post
				// prCreateFailed so the (re-rendered) buttons re-enable for a retry
				// once the first action settles.
				if (this.prActionInFlight) {
					post({ command: "prCreateFailed" });
					return;
				}
				this.prActionInFlight = true;
				try {
					const title = m.title?.trim() ? m.title : this.vm.title;
					const body = m.body?.trim() ? wrapWithMarkers(m.body) : wrapWithMarkers(this.vm.bodyMarkdown);
					// Same webview message for both modes; the host is the source of
					// truth for whether an open PR exists. Update pushes + syncs the
					// draft into the existing PR; otherwise create a fresh one.
					if (this.vm.existingPr) {
						await handleUpdatePrWithPush(title, body, this.workspaceRoot, post, this.vm.branch);
					} else {
						await handleCreatePr(title, body, this.workspaceRoot, post, this.vm.branch);
					}
				} finally {
					this.prActionInFlight = false;
				}
				return;
			}

			case "openPr": {
				// Defense-in-depth: only follow http(s) URLs. `m.url` is webview-
				// supplied; without a scheme check a `file:`/`vscode:`/`command:` URI
				// would be handed to openExternal. Mirrors the openDiff traversal
				// guard below and the https-only check on the PR-history rows.
				const uri = vscode.Uri.parse(m.url);
				if (uri.scheme !== "https" && uri.scheme !== "http") {
					log.warn("CreatePrPanel", `openPr rejected non-http(s) URL: ${m.url}`);
					return;
				}
				await vscode.env.openExternal(uri);
				return;
			}

			case "copyBody":
				await vscode.env.clipboard.writeText(wrapWithMarkers(this.vm.bodyMarkdown));
				await vscode.window.showInformationMessage("PR body copied to clipboard.");
				return;

			case "openMemory":
				await vscode.commands.executeCommand("jollimemory.viewMemorySummary", m.hash);
				return;

			case "openDiff": {
				// v1 fallback: open the working-tree file instead of a branch diff.
				// A proper branch-vs-main diff requires a merge-base ref that is not
				// yet exposed via a registered command; this is non-blocking for v1.
				// `m.path` is repo-relative (from `git diff --name-status`), so
				// resolve it against the workspace root — `Uri.file(m.path)` alone
				// would treat it as absolute and open the wrong file / fail.
				//
				// Traversal guard: `m.path` is webview-supplied and could carry
				// `../` segments (or be absolute) to point outside the workspace.
				// `path.resolve` collapses `..` and lets an absolute `m.path`
				// override the base; isPathInside then confirms the result stays
				// within workspaceRoot. Reject escapes rather than opening them. (#6)
				const resolved = nodePath.resolve(this.workspaceRoot, m.path);
				if (!isPathInside(resolved, this.workspaceRoot)) {
					log.warn("CreatePrPanel", `openDiff rejected path outside workspace: ${m.path}`);
					return;
				}
				await vscode.commands
					.executeCommand("vscode.open", vscode.Uri.file(resolved))
					.then(undefined, (e: unknown) => {
						log.warn("CreatePrPanel", `openDiff failed: ${e instanceof Error ? e.message : String(e)}`);
					});
				return;
			}
		}
	}
}
