import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ActiveConversationItem } from "../../../cli/src/core/ActiveSessionAggregator.js";
import { sumConversationTokens } from "../../../cli/src/core/ConversationTokenTotals.js";
import { getWorkingTreeDiffStats } from "../../../cli/src/core/GitOps.js";
import { findTicketInContext } from "../util/CommitMessageUtils.js";
import { buildNextMemoryHtml } from "./NextMemoryHtmlBuilder.js";
import type { SerializedTreeItem } from "./SidebarMessages.js";

interface Bridge {
	generateCommitMessageForFiles(relativePaths: ReadonlyArray<string>): Promise<string>;
	getCurrentBranch(): Promise<string>;
}

interface SidebarBroadcastHost {
	registerBroadcastTarget(webview: vscode.Webview): void;
	unregisterBroadcastTarget(webview: vscode.Webview): void;
	handleOutbound(raw: unknown): void;
	getPlansSnapshot(): ReadonlyArray<SerializedTreeItem>;
	getFilesSnapshot(): ReadonlyArray<SerializedTreeItem>;
	getConversationsSnapshot(): Promise<ReadonlyArray<ActiveConversationItem>>;
}

let currentPanel: vscode.WebviewPanel | undefined;

// Coalesces the preview re-derivation triggered by rapid selection toggles into
// a single (LLM-backed) refresh. Module-scoped because the panel is a singleton.
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
// Sections accumulated across a debounce window: toggling a file then a
// conversation must refresh the union (title+diffstat ∪ tokens), not just the
// last message's sections. Cleared when the debounced refresh fires.
const pendingSections = new Set<PreviewSection>();
const REFRESH_DEBOUNCE_MS = 400;

// CSP nonce: crypto-random, matching every other webview panel in the extension
// (see SummaryWebviewPanel / SidebarWebviewProvider / SettingsWebviewPanel …).
// A predictable (Math.random) nonce would weaken the injection guarantee the
// nonce exists to provide.
function makeNonce(): string {
	return randomBytes(16).toString("hex");
}

// The preview has four independently-derived sections. A selection toggle only
// invalidates the ones it actually feeds, so each message maps to the minimal
// set to recompute — recomputing more wastes work (an LLM title call) or shows
// stale data (a ticket that never refreshes).
type PreviewSection = "title" | "diffstat" | "tokens" | "ticket";

// Which preview sections a selection message invalidates. Returns [] for
// messages that change nothing derived (plan/note toggles: the ticket comes from
// reference rows only, and nothing else keys off plan/note selection).
function sectionsForMessage(m: { type?: string }): ReadonlyArray<PreviewSection> {
	switch (m?.type) {
		case "branch:toggleFileSelection":
			// Files are the LLM title's input and the diffstat's source.
			return ["title", "diffstat"];
		case "branch:toggleConversationSelection":
			// Conversations only feed the token meter. They are NOT a title input,
			// so regenerating the title here would re-run a non-deterministic LLM
			// call over an unchanged file set and flip the "Proposed title" for no
			// reason — exactly why plan toggles were excluded from the old refresh.
			return ["tokens"];
		case "branch:toggleReferenceSelection":
			// A reference row carries the "Detected ticket". findTicketInContext
			// honors isSelected===false, so deselecting the ticket-bearing reference
			// must refresh the ticket — but via a cheap lookup, not the LLM title.
			return ["ticket"];
		default:
			return [];
	}
}

export class NextMemoryPreviewPanel {
	/* v8 ignore start -- never invoked: the panel is a module-level singleton (currentPanel), so this private constructor exists only to prevent external `new` and is never called. */
	private constructor() {
		// Singleton — use NextMemoryPreviewPanel.show() instead.
	}
	/* v8 ignore stop */

	static async show(
		extensionUri: vscode.Uri,
		workspaceRoot: string,
		bridge: Bridge,
		sidebarProvider: SidebarBroadcastHost,
	): Promise<void> {
		const existed = !!currentPanel;
		if (!currentPanel) {
			const nonce = makeNonce();
			const panel = vscode.window.createWebviewPanel(
				"jollimemory.nextMemoryPreview",
				"Working Memory",
				vscode.ViewColumn.Active,
				{ enableScripts: true },
			);
			const codiconCssUri = panel.webview.asWebviewUri(
				vscode.Uri.joinPath(extensionUri, "assets", "codicons", "codicon.css"),
			);
			panel.webview.html = buildNextMemoryHtml(nonce, panel.webview.cspSource, codiconCssUri.toString());
			panel.webview.onDidReceiveMessage((msg: unknown) => {
				const m = msg as { type?: string; command?: string };
				if (m?.type === "command" && m.command === "jollimemory.regenerateNextMemoryTitle") {
					void NextMemoryPreviewPanel.pushProposedTitle(panel.webview, bridge, sidebarProvider);
					return;
				}
				if (m?.type === "ready") {
					// The panel's script has attached its message listener, so it is
					// now safe to push the preview:* sections. Gating on `ready`
					// (rather than an eager push from show()) mirrors how branch:*Data
					// is delivered and avoids the race where a message posted before
					// the listener exists is silently dropped.
					void NextMemoryPreviewPanel.refreshPreview(panel.webview, workspaceRoot, bridge, sidebarProvider);
					// Fall through: the sidebar data feeds (branch:*Data) also key off
					// this same `ready` via handleReady's broadcast to this target.
					sidebarProvider.handleOutbound(msg);
					return;
				}
				const sections = sectionsForMessage(m);
				if (sections.length > 0) {
					// Selection changed — forward it so the host updates its state,
					// then re-derive only the affected preview sections (debounced) so
					// the title / diffstat / token meter / ticket keep reflecting the
					// exact set the next commit will save.
					sidebarProvider.handleOutbound(msg);
					NextMemoryPreviewPanel.scheduleRefresh(panel.webview, workspaceRoot, bridge, sidebarProvider, sections);
					return;
				}
				// Every other message (the reused jollimemory.commitAI / addPlan /
				// addMarkdownNote / addTextSnippet command dispatches, plan/reference
				// toggles) is handled identically to the sidebar's own webview — same
				// host state, same handler, called directly since both run in this one
				// extension host process.
				sidebarProvider.handleOutbound(msg);
			});
			// Cache the webview reference. `panel.webview` is a getter that throws
			// "Webview is disposed" once the panel is torn down — and onDidDispose
			// fires exactly at teardown, so reading `panel.webview` *inside* the
			// dispose callback throws, aborting the callback before it clears
			// `currentPanel`. That left a disposed panel lingering as the singleton,
			// so the next Review click reveal()-ed a dead webview and silently did
			// nothing. Referencing the cached webview never touches the getter.
			// (Other webview panels don't hit this because their dispose callbacks
			// don't read the webview at all — this panel is the only one that must
			// unregister a broadcast target on dispose.)
			const webview = panel.webview;
			sidebarProvider.registerBroadcastTarget(webview);
			// Capture `panel`/`webview` (not the module `currentPanel`) so dispose
			// always unregisters THIS panel's webview and stays safe under
			// double-dispose; only clear the singleton if it still points here.
			panel.onDidDispose(() => {
				if (refreshTimer) {
					clearTimeout(refreshTimer);
					refreshTimer = undefined;
				}
				pendingSections.clear();
				sidebarProvider.unregisterBroadcastTarget(webview);
				if (currentPanel === panel) currentPanel = undefined;
			});
			currentPanel = panel;
		}
		currentPanel.reveal(vscode.ViewColumn.Active);

		// A brand-new panel primes its preview from the `ready` handshake above. A
		// re-show of an already-loaded webview won't re-fire `ready`, so push
		// directly here — the listener is already attached, no race.
		if (existed) {
			await NextMemoryPreviewPanel.refreshPreview(currentPanel.webview, workspaceRoot, bridge, sidebarProvider);
		}
	}

	/**
	 * Debounced, section-scoped refresh. Rapid checkbox toggling coalesces into a
	 * single refresh so we don't fire an LLM title regeneration per keystroke; the
	 * requested sections accumulate across the window so a file-then-conversation
	 * burst refreshes the union rather than only the last message's sections.
	 */
	private static scheduleRefresh(
		webview: vscode.Webview,
		workspaceRoot: string,
		bridge: Bridge,
		sidebarProvider: SidebarBroadcastHost,
		sections: ReadonlyArray<PreviewSection>,
	): void {
		for (const s of sections) pendingSections.add(s);
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			const due = new Set(pendingSections);
			pendingSections.clear();
			void NextMemoryPreviewPanel.refreshSections(webview, workspaceRoot, bridge, sidebarProvider, due);
		}, REFRESH_DEBOUNCE_MS);
	}

	/**
	 * Full refresh of every derived section — used on the initial `ready`
	 * handshake and on re-show, where nothing is cached yet. (The title push
	 * carries the ticket inline, so "ticket" is not requested separately here.)
	 */
	private static async refreshPreview(
		webview: vscode.Webview,
		workspaceRoot: string,
		bridge: Bridge,
		sidebarProvider: SidebarBroadcastHost,
	): Promise<void> {
		await NextMemoryPreviewPanel.refreshSections(
			webview,
			workspaceRoot,
			bridge,
			sidebarProvider,
			new Set(["title", "diffstat", "tokens"]),
		);
	}

	/**
	 * Re-derives and pushes only the requested preview:* sections.
	 *
	 * The branch is resolved once here and threaded into the title and diffstat
	 * pushes (for their "Target commit next on <branch>" line). Note the LLM title
	 * path (`generateCommitMessageForFiles`) resolves the branch a second time
	 * internally — the value passed here is used only for the display line, not the
	 * generation, so this does not de-duplicate that call.
	 *
	 * allSettled, not all: the feeds are independent, so one failing (e.g. a git
	 * error in the diffstat, a flaky conversation aggregator) must not reject the
	 * others — each posts its own message on success and simply leaves its section
	 * empty on failure. The helpers take the webview explicitly so they always
	 * target THIS panel and stay a safe no-op after dispose.
	 */
	private static async refreshSections(
		webview: vscode.Webview,
		workspaceRoot: string,
		bridge: Bridge,
		sidebarProvider: SidebarBroadcastHost,
		sections: ReadonlySet<PreviewSection>,
	): Promise<void> {
		const needsBranch = sections.has("title") || sections.has("diffstat");
		const branch = needsBranch ? await bridge.getCurrentBranch().catch(() => "") : "";
		const tasks: Array<Promise<void>> = [];
		if (sections.has("title")) {
			tasks.push(NextMemoryPreviewPanel.pushProposedTitle(webview, bridge, sidebarProvider, branch));
		}
		if (sections.has("diffstat")) {
			tasks.push(NextMemoryPreviewPanel.pushDiffstat(webview, workspaceRoot, sidebarProvider, branch));
		}
		if (sections.has("tokens")) {
			tasks.push(NextMemoryPreviewPanel.pushTokenStats(webview, sidebarProvider));
		}
		if (sections.has("ticket")) {
			tasks.push(NextMemoryPreviewPanel.pushTicket(webview, sidebarProvider));
		}
		await Promise.allSettled(tasks);
	}

	/**
	 * Repo-**relative** paths of the currently *selected* Working Memory files —
	 * the set `Commit Memory` will stage. Both the proposed title and the
	 * meta-strip diffstat are computed over exactly this set so the preview
	 * reflects what the next commit will save, not the current index.
	 *
	 * Uses the row's `description` (relativePath) — NOT `id` (the absolute
	 * `resourceUri.fsPath`). The paths flow into `generateCommitMessageForFiles`,
	 * which passes them to the LLM as `stagedFiles`; sending absolute paths would
	 * leak `/Users/<name>/…` workspace paths and usernames to the model. Falls
	 * back to `id` only if a row somehow lacks a relative path. Mirrors the file
	 * row's own toggle, which keys FilesStore.selectedPaths by `description || id`.
	 */
	private static selectedFilePaths(sidebarProvider: SidebarBroadcastHost): Array<string> {
		return sidebarProvider
			.getFilesSnapshot()
			.filter((f) => f.isSelected)
			.map((f) => f.description || f.id);
	}

	private static async pushProposedTitle(
		webview: vscode.Webview,
		bridge: Bridge,
		sidebarProvider: SidebarBroadcastHost,
		branch?: string,
	): Promise<void> {
		const ticket = findTicketInContext(sidebarProvider.getPlansSnapshot());
		const selectedPaths = NextMemoryPreviewPanel.selectedFilePaths(sidebarProvider);
		// Best-effort context for the "Target commit next on <branch>" line — a
		// branch-resolution failure must not block title generation. refreshPreview
		// resolves the branch once and passes it in; the standalone Regenerate
		// command calls without it, so fall back to resolving here.
		const resolvedBranch = branch ?? (await bridge.getCurrentBranch().catch(() => ""));
		try {
			const title = await bridge.generateCommitMessageForFiles(selectedPaths);
			void webview.postMessage({
				type: "preview:title",
				title,
				...(resolvedBranch ? { branch: resolvedBranch } : {}),
				...(ticket ? { ticket } : {}),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			void webview.postMessage({ type: "preview:title", error: message });
		}
	}

	/**
	 * Recomputes the "Detected ticket" from the currently-included reference rows
	 * and pushes it on its own `preview:ticket` message — no LLM. Fired when a
	 * reference is (de)selected, which changes the ticket but never the title.
	 * The client merges the ticket into the last title it rendered; omitting the
	 * `ticket` field (no reference selected) clears the line.
	 */
	private static async pushTicket(webview: vscode.Webview, sidebarProvider: SidebarBroadcastHost): Promise<void> {
		const ticket = findTicketInContext(sidebarProvider.getPlansSnapshot());
		void webview.postMessage({ type: "preview:ticket", ...(ticket ? { ticket } : {}) });
	}

	private static async pushDiffstat(
		webview: vscode.Webview,
		workspaceRoot: string,
		sidebarProvider: SidebarBroadcastHost,
		branch: string,
	): Promise<void> {
		const selectedPaths = NextMemoryPreviewPanel.selectedFilePaths(sidebarProvider);
		const stats = await getWorkingTreeDiffStats(selectedPaths, workspaceRoot);
		void webview.postMessage({ type: "preview:diffstat", ...stats, ...(branch ? { branch } : {}) });
	}

	private static async pushTokenStats(webview: vscode.Webview, sidebarProvider: SidebarBroadcastHost): Promise<void> {
		const conversations = await sidebarProvider.getConversationsSnapshot();
		const totals = await sumConversationTokens(
			conversations.filter((c) => c.isSelected).map((c) => ({ source: c.source, transcriptPath: c.transcriptPath })),
		);
		void webview.postMessage({ type: "preview:tokenStats", ...totals });
	}
}
