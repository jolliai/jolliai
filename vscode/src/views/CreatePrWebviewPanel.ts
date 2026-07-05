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
 * openDiff: a "Files changed" row opens a real `base..HEAD` per-file diff in a
 * new editor tab via `vscode.diff`. Both sides are served by
 * CreatePrDiffContentProvider (`git show <ref>:<path>`) under the jolli-prdiff
 * scheme — the base is the same refined delta base the diffstat header is
 * computed from, so the diff and the counts can't disagree. When no diff base
 * resolves (branch fully merged with no own commits) the handler falls back to
 * opening the working-tree file.
 */

import { randomBytes } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { isPathInside } from "../../../cli/src/core/PathUtils.js";
import { wrapWithMarkers } from "../../../cli/src/core/PrDescription.js";
import type { JolliMemoryBridge } from "../JolliMemoryBridge.js";
import { pushBranchMemoriesToSpace } from "../services/LiveShareController.js";
import { ShareBindingError } from "../services/JolliPushOrchestrator.js";
import { parseJolliApiKey, PluginOutdatedError } from "../services/JolliPushService.js";
import {
	findOpenPrForBranch,
	findPrWithHistoryForBranch,
	handleCreatePr,
	handleUpdatePrWithPush,
} from "../services/PrCommentService.js";
import { log } from "../util/Logger.js";
import { isWorkerBlockingBusy } from "../util/LockUtils.js";
import { loadGlobalConfig } from "../util/WorkspaceUtils.js";
import { resolveBindingViaChooser } from "./BindingResolver.js";
import { buildCreatePrViewModel, type CreatePrViewModel } from "./CreatePrData.js";
import { CreatePrDiffContentProvider } from "./CreatePrDiffContentProvider.js";
import { buildPrDiffUri, PR_DIFF_SCHEME } from "./CreatePrDiffUri.js";
import { buildCreatePrHtml } from "./CreatePrHtmlBuilder.js";

/** Messages sent from the Create PR webview to the extension host. */
type Msg =
	| { command: "createPr"; title?: string; body?: string }
	| { command: "copyBody" }
	| { command: "openMemory"; hash: string }
	| { command: "openDiff"; path: string; oldPath?: string }
	| { command: "openPr"; url: string }
	| { command: "signIn" };

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

	/** Tracks Jolli sign-in state so a successful submit knows whether to push memories. Kept in sync via notifyAuthChanged + render. */
	private signedIn = false;

	/**
	 * Registration for the jolli-prdiff content provider that backs the
	 * "Files changed" diff. Disposed when the panel closes so a later panel can
	 * re-register the scheme without a duplicate-registration throw.
	 */
	private readonly diffProviderReg: vscode.Disposable;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly workspaceRoot: string,
		private readonly extensionUri: vscode.Uri,
		private readonly bridge: JolliMemoryBridge,
	) {
		this.diffProviderReg = vscode.workspace.registerTextDocumentContentProvider(
			PR_DIFF_SCHEME,
			new CreatePrDiffContentProvider((ref, relPath) => this.bridge.readFileAtRef(ref, relPath)),
		);
		this.panel.onDidDispose(() => {
			this.diffProviderReg.dispose();
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
		signedIn = false,
	): Promise<void> {
		const result = await buildCreatePrViewModel(bridge, mainBranch);
		if ("empty" in result) {
			await vscode.window.showInformationMessage(
				"No committed memories on this branch yet — nothing to open a PR from.",
			);
			return;
		}
		// Drives the share notice: signed-in confirms the PR also shares memories
		// to Jolli Space; signed-out shows a Sign In link. Auth state lives on the
		// VS Code side, so the pure view-model builder can't compute it.
		result.signedIn = signedIn;

		// Detect an open PR already on this branch so the pane renders an
		// "Update PR" affordance instead of "Create PR", plus the branch's
		// closed/merged PR history for the "Previously: …" strip. Best-effort: a
		// gh failure (not installed / unauthenticated) just leaves the pane in
		// create mode with no history rather than blocking it.
		try {
			const { existingPr, history } = await findPrWithHistoryForBranch(workspaceRoot, result.branch);
			if (existingPr) result.existingPr = existingPr;
			if (history.length > 0) result.prHistory = history;
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
		const self = new CreatePrWebviewPanel(panel, workspaceRoot, extensionUri, bridge);
		CreatePrWebviewPanel.current = self;
		self.render(result);
	}

	/**
	 * Pushes a new auth state to the open panel so its share notice swaps between
	 * the signed-in confirmation and the Sign In link in place (no re-render,
	 * which would wipe any title/body typed into the edit form). Called from the
	 * extension's sign-in callback and sign-out handler. No-op when no panel is
	 * open. Mirrors SidebarWebviewProvider.notifyAuthChanged / SettingsWebviewPanel.
	 */
	static notifyAuthChanged(authenticated: boolean): void {
		if (CreatePrWebviewPanel.current) CreatePrWebviewPanel.current.signedIn = authenticated;
		void CreatePrWebviewPanel.current?.panel.webview.postMessage({ command: "authChanged", authenticated });
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
		this.signedIn = vm.signedIn === true;
		const codiconCssUri = this.panel.webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, "assets", "codicons", "codicon.css"),
		);
		this.panel.webview.html = buildCreatePrHtml(vm, randomBytes(16).toString("hex"), {
			cspSource: this.panel.webview.cspSource,
			codiconCssUri: codiconCssUri.toString(),
		});
	}

	/**
	 * Rebuilds and re-renders the pane after a successful Create/Update PR. Two
	 * things change post-submit and must be re-derived from source rather than
	 * reused from the now-stale in-memory vm:
	 *
	 *   1. **Body markdown.** When signed in, the submit path pushes the branch's
	 *      memories to Jolli Space, and JolliPushOrchestrator persists each
	 *      summary's freshly-minted `jolliDocUrl` (plus plan/note URLs) back to
	 *      storage. At first render nothing was pushed, so the body had no
	 *      "## Jolli Memory" link or context URLs. A full rebuild via
	 *      `buildCreatePrViewModel` (which reads summaries fresh from storage)
	 *      picks them up; the old `{ ...this.vm }` reuse kept the pre-push body.
	 *   2. **Open PR.** A fresh Create flips the pane into Update mode with a
	 *      clickable PR #N pill; an Update that fell back to creating a new PR
	 *      must re-point at it. Re-resolving via `findOpenPrForBranch` is
	 *      self-correcting for both paths.
	 *
	 * Both steps are best-effort and independent: a rebuild or gh failure logs a
	 * warning and falls back to the previous vm (the success toast already
	 * confirmed the create) rather than blanking the pane. `prHistory` and
	 * `signedIn` — panel-populated fields the pure builder doesn't compute — are
	 * carried over from the previous vm / instance state.
	 */
	private async refreshAfterSubmit(): Promise<void> {
		if (!this.vm) return;
		let next: CreatePrViewModel = this.vm;
		try {
			const rebuilt = await buildCreatePrViewModel(this.bridge, this.vm.mainBranch);
			if (!("empty" in rebuilt)) {
				next = { ...rebuilt, prHistory: this.vm.prHistory, signedIn: this.signedIn };
			}
		} catch (e: unknown) {
			log.warn("CreatePrPanel", `post-submit rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		try {
			const existingPr = await findOpenPrForBranch(this.workspaceRoot, next.branch);
			if (existingPr) next = { ...next, existingPr };
		} catch (e: unknown) {
			log.warn(
				"CreatePrPanel",
				`post-create PR lookup failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		this.render(next);
	}

	private async handle(m: Msg): Promise<void> {
		// render() sets this.vm and is called synchronously in show() right after
		// construction registers this handler, so a message can never arrive before
		// vm exists — this guard covers an unreachable pre-render window.
		/* v8 ignore start */
		if (!this.vm) return;
		/* v8 ignore stop */
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
					const outcome = this.vm.existingPr
						? await handleUpdatePrWithPush(title, body, this.workspaceRoot, post, this.vm.branch)
						: await handleCreatePr(title, body, this.workspaceRoot, post, this.vm.branch);
					// On failure/block the handler already posted prCreateFailed /
					// prCreateBlockedCrossBranch — the webview has re-enabled its buttons
					// and stays put (edit form kept open for a retry). Nothing more to do.
					if (outcome === "succeeded") {
						// The full operation isn't done at PR-live: when signed in we then
						// share the branch's memories to the user's Jolli Space (the pane's
						// share notice promises this). The handler's mid-flight prStatus is
						// NOT a webview settle signal (see CreatePrHtmlBuilder) — the buttons
						// stay disabled and the progress line keeps updating through here.
						// A share failure never rolls back the already-created PR.
						if (this.signedIn) {
							post({ command: "prProgress", text: "Sharing memories to your Jolli Space…" });
							try {
								await this.pushMemoriesToSpace();
							} catch (err) {
								// pushMemoriesToSpace handles its own expected errors, but an
								// unexpected throw (e.g. loadGlobalConfig failing before its inner
								// try) must NOT skip the settle below — that would leave the panel's
								// buttons disabled. The PR is already live; surface and continue.
								log.warn(
									"CreatePrPanel",
									`pushMemoriesToSpace threw: ${err instanceof Error ? err.message : String(err)}`,
								);
								vscode.window.showWarningMessage("PR is ready, but sharing memories to Jolli Space failed.");
							}
						}
						// Rebuild the whole pane from fresh storage and re-render regardless
						// of the pre-submit mode. This does two things at once: (a) the body
						// now reflects the memory/context URLs the push just minted (absent
						// at first render — nothing was pushed yet), and (b) the open PR is
						// re-resolved so a fresh Create flips into Update mode with a clickable
						// PR #N pill, and an Update that fell back to CREATING a new PR (the
						// tracked PR was closed/merged between render and submit) re-points at
						// the new one instead of a dead pill. The re-render also lands in the
						// read-only view with freshly-enabled buttons.
						await this.refreshAfterSubmit();
						// Terminal settle for the whole operation: re-enable the buttons,
						// clear the progress line, and return to the read-only view (an
						// update from the edit form would otherwise leave the form open).
						// Harmless when wasCreate already re-rendered into a settled view.
						post({ command: "prComplete" });
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

			case "signIn":
				// Kick off the browser OAuth flow. On success the extension's URI
				// callback calls notifyAuthChanged(true), flipping this pane's notice
				// to the signed-in variant.
				await vscode.commands.executeCommand("jollimemory.signIn");
				return;

			case "openDiff": {
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
				// `oldPath` (rename base-side) is webview-supplied too — apply the same
				// traversal guard before it reaches a `git show <base>:<oldPath>`.
				if (m.oldPath && !isPathInside(nodePath.resolve(this.workspaceRoot, m.oldPath), this.workspaceRoot)) {
					log.warn("CreatePrPanel", `openDiff rejected oldPath outside workspace: ${m.oldPath}`);
					return;
				}
				// Open a real base..HEAD per-file diff in a new editor tab. The base
				// is the same refined delta base the "Files changed" counts are
				// computed from (see getBranchDiffBase), so the diff matches the
				// header. Both sides are virtual documents served by the jolli-prdiff
				// content provider: an added file has an empty base side, a deleted
				// file an empty HEAD side.
				const base = await this.bridge.getBranchDiffBase(this.vm.mainBranch);
				if (base) {
					// For a rename the new path doesn't exist at the base, so the left
					// (base) side must read from the old path; the right (HEAD) side is
					// always the current path. Non-renames use the same path on both.
					const left = buildPrDiffUri(m.oldPath ?? m.path, base);
					const right = buildPrDiffUri(m.path, "HEAD");
					const title = `${nodePath.basename(m.path)} (${this.vm.mainBranch} ↔ ${this.vm.branch})`;
					await vscode.commands
						.executeCommand("vscode.diff", left, right, title)
						.then(undefined, (e: unknown) => {
							log.warn("CreatePrPanel", `openDiff failed: ${e instanceof Error ? e.message : String(e)}`);
						});
					return;
				}
				// No resolvable diff base (branch fully merged with no own commits,
				// or no common ancestor) — fall back to opening the working-tree file
				// so the row still does something useful.
				await vscode.commands
					.executeCommand("vscode.open", vscode.Uri.file(resolved))
					.then(undefined, (e: unknown) => {
						log.warn("CreatePrPanel", `openDiff failed: ${e instanceof Error ? e.message : String(e)}`);
					});
				return;
			}
		}
	}

	/**
	 * Pushes the branch's memories to the bound Jolli Space as articles (no share
	 * link). Runs only after a successful Create/Update PR when signed in. UI —
	 * apiKey guard, binding-chooser wiring, and toasts — mirrors
	 * SummaryWebviewPanel.runJolliPush so both surfaces behave identically. A push
	 * failure is surfaced as a non-blocking toast; the PR is already created.
	 */
	private async pushMemoriesToSpace(): Promise<void> {
		if (!this.vm) return;
		const branch = this.vm.branch;
		const config = await loadGlobalConfig();
		const apiKey = config.jolliApiKey;
		if (!apiKey) {
			vscode.window.showWarningMessage("Please configure your Jolli API Key first (STATUS panel → ...).");
			return;
		}
		const resolvedBaseUrl = parseJolliApiKey(apiKey)?.u;
		if (!resolvedBaseUrl) {
			vscode.window.showWarningMessage(
				"Jolli site URL could not be determined. Please regenerate your Jolli API Key and set it again (STATUS panel → ...).",
			);
			return;
		}
		const baseUrl = resolvedBaseUrl.replace(/\/+$/, "");

		try {
			const result = await pushBranchMemoriesToSpace(
				{
					bridge: this.bridge,
					workspaceRoot: this.workspaceRoot,
					apiKey,
					resolveBinding: (repo) =>
						resolveBindingViaChooser({ extensionUri: this.extensionUri, baseUrl, apiKey, repoUrl: repo }),
				},
				branch,
			);

			const n = result.pushedCount;
			const noun = n === 1 ? "memory" : "memories";
			const failures = [...result.summaryFailures, ...result.attachmentFailures];
			if (failures.length > 0) {
				// Partial success: report how many shared plus the failures, so an
				// early success is never masked by a later failure (modal, not toast,
				// to match the visibility of the old fail-fast error path).
				const tail =
					result.summaryFailures.length > 0
						? `${result.summaryFailures.length} memory/memories and ${result.attachmentFailures.length} attachment(s) failed to push`
						: `${result.attachmentFailures.length} attachment(s) failed to push`;
				vscode.window.showWarningMessage(
					`Shared ${n} ${noun} to your Jolli Space, but ${tail}.`,
					{
						modal: true,
						detail: failures.map((f) => `• ${f.label}: ${f.message}`).join("\n"),
					},
				);
			} else {
				vscode.window.showInformationMessage(`Shared ${n} ${noun} to your Jolli Space.`);
			}
		} catch (err: unknown) {
			if (err instanceof ShareBindingError) {
				if (err.outcome === "anotherOpen") {
					vscode.window.showInformationMessage(
						"A Memory space chooser is already open for this repo. Finish there, then create the PR again to share.",
					);
				} else if (err.outcome === "cancelled") {
					vscode.window.showErrorMessage(
						"Push cancelled — no Memory space chosen for this repo. Create the PR again when you're ready to share.",
					);
				} else {
					vscode.window.showErrorMessage("Sharing failed — could not bind a Memory space for this repo.");
				}
				return;
			}
			if (err instanceof PluginOutdatedError) {
				vscode.window.showErrorMessage(
					"Sharing failed — your Jolli Memory plugin is outdated. Please update to the latest version.",
					{ modal: true },
				);
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			vscode.window.showWarningMessage(`PR is ready, but sharing memories to Jolli Space failed: ${msg}`);
		}
	}
}
