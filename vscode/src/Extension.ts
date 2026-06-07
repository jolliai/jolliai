/**
 * Extension.ts — JolliMemory VSCode Extension Entry Point
 *
 * Wires together all providers, commands, and the status bar.
 * Called by VSCode when the extension activates (workspaceContains:.git).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import * as vscode from "vscode";
import {
	conversationKey,
	setExcluded,
} from "../../cli/src/core/CommitSelectionStore.js";
import type { FolderStorage, ForceRegenerateResult } from "../../cli/src/core/FolderStorage.js";
import {
	extractRepoName,
	getRemoteUrl,
	resolveKbParent,
} from "../../cli/src/core/KBPathResolver.js";
import type { ManifestEntry } from "../../cli/src/core/KBTypes.js";
import { toForwardSlash } from "../../cli/src/core/PathUtils.js";
import {
	getGlobalConfigDir,
	loadConfig,
	saveConfigScoped,
} from "../../cli/src/core/SessionTracker.js";
import {
	cleanupV1IfExpired,
	hasMigrationMeta,
	hasV1Branch,
	migrateV1toV3,
	writeMigrationMeta,
} from "../../cli/src/core/SummaryMigration.js";
import { readNoteFromBranch, readPlanFromBranch } from "../../cli/src/core/SummaryStore.js";
import type { StorageProvider } from "../../cli/src/core/StorageProvider.js";
import { ORPHAN_BRANCH } from "../../cli/src/Logger.js";
import type { StatusInfo } from "../../cli/src/Types.js";
import { execFileSyncHidden } from "../../cli/src/util/Subprocess.js";
import { CommitCommand } from "./commands/CommitCommand.js";
import { PushCommand } from "./commands/PushCommand.js";
import {
	selectAllConversationsCommand,
	selectAllPlansAndNotesCommand,
} from "./commands/SelectAllSelection.js";
import { SquashCommand } from "./commands/SquashCommand.js";
import { getNotesDir } from "./core/NoteService.js";
import {
	addPlanToRegistry,
	getPlansDir,
	listAvailablePlans,
} from "./core/PlanService.js";
import { JolliMemoryBridge } from "./JolliMemoryBridge.js";
import type { FileItem } from "./providers/FilesTreeProvider.js";
import { FilesTreeProvider } from "./providers/FilesTreeProvider.js";
import {
	CommitFileDecorationProvider,
	type CommitFileItem,
	type CommitItem,
	HistoryTreeProvider,
} from "./providers/HistoryTreeProvider.js";
import {
	buildHoverFields,
	MemoriesTreeProvider,
	type MemoryItem,
} from "./providers/MemoriesTreeProvider.js";
import type {
	NoteItem,
	PlanItem,
	ReferenceItem,
} from "./providers/PlansTreeProvider.js";
import { PlansTreeProvider } from "./providers/PlansTreeProvider.js";
import { StatusTreeProvider } from "./providers/StatusTreeProvider.js";
import { ActiveSessionsProvider } from "./services/ActiveSessionsProvider.js";
import { AuthService } from "./services/AuthService.js";
import { KbFoldersService } from "./services/KbFoldersService.js";
import {
	readManualDisableFlag,
	writeManualDisableFlag,
} from "./services/ManualDisableFlag.js";
import { MemoryFileDecorationProvider } from "./services/MemoryFileDecorationProvider.js";
import { CommitsStore } from "./stores/CommitsStore.js";
import { FilesStore } from "./stores/FilesStore.js";
import { MemoriesStore } from "./stores/MemoriesStore.js";
import { PlansStore } from "./stores/PlansStore.js";
import { StatusStore } from "./stores/StatusStore.js";
import { activateSync } from "./sync/VsCodeSyncBootstrap.js";
import { ExcludeFilterManager } from "./util/ExcludeFilterManager.js";
import { formatShortRelativeDate } from "./util/FormatUtils.js";
import { isWorkerBusy } from "./util/LockUtils.js";
import { initLogger, log } from "./util/Logger.js";
import { StatusBarManager } from "./util/StatusBarManager.js";
import { getWorkspaceRoot } from "./util/WorkspaceUtils.js";
import { computeChangesBadge } from "./views/ChangesBadge.js";
import { NoteEditorWebviewPanel } from "./views/NoteEditorWebviewPanel.js";
import { SettingsWebviewPanel } from "./views/SettingsWebviewPanel.js";
import { SidebarWebviewProvider } from "./views/SidebarWebviewProvider.js";
import { buildClaudeCodeContext } from "./views/SummaryMarkdownBuilder.js";
import { SummaryWebviewPanel } from "./views/SummaryWebviewPanel.js";

// ─── Git URI helpers ──────────────────────────────────────────────────────────

/**
 * Converts a file URI to a `git:` scheme URI that the built-in git extension
 * resolves to the file content at the given ref.
 *
 * @param ref - Git ref string: "HEAD" for committed version, "" (empty) for index/staged version.
 */
function toGitUri(fileUri: vscode.Uri, ref: string): vscode.Uri {
	return fileUri.with({
		scheme: "git",
		query: JSON.stringify({ path: fileUri.fsPath, ref }),
	});
}

// Plan readonly preview uses TextDocumentContentProvider (registered in activate)

// ─── FileSystemWatcher helpers ────────────────────────────────────────────────

/**
 * Creates a FileSystemWatcher and subscribes `callback` to both create and
 * change events. Both are required on Windows, where git atomic renames (e.g.
 * `.git/HEAD.lock` → `.git/HEAD` during branch switch) fire as create events
 * rather than change events.
 */
function watchFile(
	base: string | vscode.Uri,
	pattern: string,
	callback: () => void,
): vscode.FileSystemWatcher {
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(base, pattern),
	);
	const wrap = (event: string) => () => {
		log.debug("watcher", `${pattern} ${event}`);
		callback();
	};
	watcher.onDidCreate(wrap("create"));
	watcher.onDidChange(wrap("change"));
	return watcher;
}

/**
 * Resolves the absolute filesystem path for a file inside git's data dir.
 *
 * `git rev-parse --git-path` handles both regular repos and worktrees:
 *   - Regular: `HEAD` → `<workspace>/.git/HEAD`
 *   - Worktree: `HEAD` → `<main-repo>/.git/worktrees/<name>/HEAD` (worktree-local)
 *   - Worktree: `refs/heads/foo` → `<main-repo>/.git/refs/heads/foo` (shared ref)
 *
 * Without this helper, watching `.git/HEAD` relative to workspaceRoot silently
 * fails in worktrees because `.git` is a pointer file, not a directory.
 */
function resolveGitPath(
	cwd: string,
	relativeToGitDir: string,
): string | undefined {
	try {
		const out = execFileSyncHidden(
			"git",
			["rev-parse", "--git-path", relativeToGitDir],
			{
				cwd,
				encoding: "utf-8",
			},
		).trim();
		return isAbsolute(out) ? out : resolve(cwd, out);
	} catch {
		return;
	}
}

/**
 * Parses the YAML-ish frontmatter that FolderStorage writes onto each on-disk
 * markdown copy of a commit summary (see FolderStorage.buildYamlFrontmatter).
 * Returns the embedded commit hash when the file represents a summary
 * (`type: commit`); returns null for plan/note copies, files without
 * frontmatter, and anything that fails to parse — the caller falls back to a
 * plain markdown preview in those cases.
 */
function parseSummaryFrontmatter(
	absPath: string,
): { commitHash: string } | null {
	let raw: string;
	try {
		raw = readFileSync(absPath, "utf-8");
	} catch {
		return null;
	}
	if (!raw.startsWith("---\n")) return null;
	const closing = raw.indexOf("\n---", 4);
	if (closing === -1) return null;
	const block = raw.slice(4, closing);
	let type: string | undefined;
	let commitHash: string | undefined;
	for (const line of block.split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const val = line.slice(idx + 1).trim();
		if (key === "type") type = val;
		else if (key === "commitHash") commitHash = val;
	}
	if (type !== "commit" || !commitHash) return null;
	return { commitHash };
}

/**
 * Resolve the branch that the revert command should pass to
 * `FolderStorage.forceRegenerateVisibleMarkdown` /
 * `regenerateVisiblePlan` / `regenerateVisibleNote`. Branch-agnostic across
 * all three manifest entry types — commit, plan, and note — so a single
 * helper is the single point where a silent `?? "main"` would otherwise
 * leak in.
 *
 * Order:
 *   1. `manifestEntry.source.branch` when present — the canonical record set by
 *      `FolderStorage.regenerateVisibleMarkdown` / `generatePlanMarkdown` /
 *      `generateNoteMarkdown` whenever the writer knows the branch (i.e.
 *      every call from `writeFiles` and the revert command itself, post-fix).
 *   2. Reverse-lookup of the first segment of `manifestEntry.path` against
 *      `branches.json` — handles legacy manifest entries written before the
 *      `source.branch` field was persisted, and any future writer that drops
 *      source but still places the file under a registered branchFolder.
 *
 * Returns null when neither lookup yields a branch (unregistered folder, or
 * the manifest entry has a malformed path). Callers must surface a warning
 * rather than fall back to "main" silently — that fallback is the bug this
 * helper exists to fix.
 */
function resolveBranch(folderStorage: FolderStorage, manifestEntry: ManifestEntry): string | null {
	if (manifestEntry.source?.branch) return manifestEntry.source.branch;
	const segments = manifestEntry.path.split("/");
	const folder = segments.length > 1 ? segments[0] : null;
	if (!folder) return null;
	return folderStorage.resolveBranchForFolder(folder);
}

/**
 * Human-readable hint for each `ForceRegenerateResult` failure reason —
 * the visible warning's trailing clause. Distinct strings let the user
 * tell whether the hidden source vanished, was corrupted, or whether the
 * edited visible file is held open by another process. Pre-fix the UI
 * unconditionally claimed "hidden source missing", which was misleading
 * for malformed-JSON and unlink-failure modes.
 */
function revertFailureHint(reason: "missing" | "malformed" | "unlinkFailed"): string {
	switch (reason) {
		case "missing":
			return "hidden source missing";
		case "malformed":
			return "hidden source is corrupt (JSON is unparseable)";
		case "unlinkFailed":
			return "could not overwrite the existing file (it may be locked by another process)";
	}
}

// Tracks Memory Bank summary `.md` files for which the divergence info
// message has already been shown in this session, so re-opening a
// known-diverged file does not re-pop the toast. Module-scoped — lifetime
// is the extension host process, matching the "once per session" contract
// stated in the user-facing message. Cleared implicitly on window reload.
const divergenceMessageShown = new Set<string>();

// ─── activate ─────────────────────────────────────────────────────────────────

/**
 * Commands the extension may receive in degraded mode (no workspace / no git).
 * Each gets a no-op stub so that command-palette invocations and any leftover
 * UI callers don't fail with "command not found". Kept in lockstep with the
 * `contributes.commands` list in package.json plus the small set of
 * programmatically-registered commands (`focusSidebar`, `saveAnthropicApiKey`)
 * that the sidebar webview / inline panels may dispatch into.
 */
const ALL_DECLARED_COMMANDS: ReadonlyArray<string> = [
	"jollimemory.enableJolliMemory",
	"jollimemory.disableJolliMemory",
	"jollimemory.refreshStatus",
	"jollimemory.refreshMemories",
	"jollimemory.openSettings",
	"jollimemory.refreshFiles",
	"jollimemory.refreshHistory",
	"jollimemory.refreshPlans",
	"jollimemory.commitAI",
	"jollimemory.squash",
	"jollimemory.pushBranch",
	"jollimemory.selectAllFiles",
	"jollimemory.selectAllCommits",
	"jollimemory.selectAllConversations",
	"jollimemory.selectAllPlansAndNotes",
	"jollimemory.searchMemories",
	"jollimemory.clearMemoryFilter",
	"jollimemory.loadMoreMemories",
	"jollimemory.discardSelectedChanges",
	"jollimemory.focusSidebar",
	"jollimemory.addPlan",
	"jollimemory.addMarkdownNote",
	"jollimemory.addTextSnippet",
	"jollimemory.signIn",
	"jollimemory.signOut",
	"jollimemory.saveAnthropicApiKey",
];

/**
 * Registers a SidebarWebviewProvider in degraded mode (no data providers, no
 * branch watcher) so the activity-bar icon renders the reason-specific CTA
 * banner — Open Folder for "no-workspace", Initialize Git for "no-git" —
 * instead of VSCode's "no view registered" placeholder.
 */
function registerDegradedSidebar(
	context: vscode.ExtensionContext,
	reason: "no-workspace" | "no-git",
): void {
	const provider = new SidebarWebviewProvider({
		executeCommand: (cmd, ...args) =>
			vscode.commands.executeCommand(cmd, ...args),
		getInitialState: () => ({
			enabled: false,
			authenticated: false,
			// In degraded mode (no workspace / no git) we never show the
			// onboarding panel — the degraded UI takes priority. Reporting
			// `configured: true` keeps the webview from gating on the
			// onboarding flow when there's nothing to onboard against yet.
			configured: true,
			activeTab: "status",
			kbMode: "folders",
			branchName: "",
			detached: false,
			degradedReason: reason,
		}),
		extensionUri: context.extensionUri,
	});
	context.subscriptions.push(
		provider,
		vscode.window.registerWebviewViewProvider(
			SidebarWebviewProvider.viewId,
			provider,
		),
	);
}

export function activate(context: vscode.ExtensionContext): void {
	const rawRoot = getWorkspaceRoot();
	if (!rawRoot) {
		const noFolder = () =>
			vscode.window.showInformationMessage(
				"Please open a folder to use Jolli Memory.",
			);
		for (const cmd of ALL_DECLARED_COMMANDS) {
			context.subscriptions.push(
				vscode.commands.registerCommand(cmd, noFolder),
			);
		}
		// The webview "Open Folder" button dispatches the built-in
		// vscode.openFolder, which is always registered, so no extra command is
		// needed for the no-workspace CTA.
		registerDegradedSidebar(context, "no-workspace");
		return;
	}
	// Re-bind to a non-null typed const so closures defined below
	// inherit `string` (not `string | null`). `getWorkspaceRoot()`
	// returns `string | null`; the early-return narrows the outer
	// binding, but TS doesn't carry that narrowing into nested
	// functions, which is what caused the run of TS2345 errors before
	// this fix (P2 — restore typecheck).
	const workspaceRoot: string = rawRoot;

	// Check if git is initialized — if not, offer to init
	if (!existsSync(join(workspaceRoot, ".git"))) {
		const initGit = () => {
			try {
				execFileSyncHidden("git", ["init"], { cwd: workspaceRoot });
				return vscode.window
					.showInformationMessage(
						"Git initialized. Please reload the window to activate Jolli Memory.",
						"Reload",
					)
					.then((r) => {
						if (r === "Reload")
							vscode.commands.executeCommand("workbench.action.reloadWindow");
					});
			} catch (err) {
				vscode.window.showErrorMessage(
					`Failed to initialize git: ${(err as Error).message}`,
				);
			}
		};
		const noGit = () =>
			vscode.window
				.showWarningMessage(
					"This folder is not a git repository. Jolli Memory requires git.",
					"Initialize Git",
				)
				.then((choice) => {
					if (choice === "Initialize Git") void initGit();
				});
		for (const cmd of ALL_DECLARED_COMMANDS) {
			context.subscriptions.push(vscode.commands.registerCommand(cmd, noGit));
		}
		// Sidebar "Initialize Git" button dispatches this command directly —
		// skip the warning prompt the command-palette path shows because the
		// click itself is the explicit confirmation.
		context.subscriptions.push(
			vscode.commands.registerCommand("jollimemory.initGit", initGit),
		);
		registerDegradedSidebar(context, "no-git");
		return;
	}

	initLogger(workspaceRoot);
	log.info("activate", "Activating JolliMemory extension", {
		workspaceRoot,
		extensionPath: context.extensionPath,
	});

	// ── Core bridge ──────────────────────────────────────────────────────────
	// Bridge now calls Installer functions directly — no CLI subprocess needed.
	const bridge = new JolliMemoryBridge(workspaceRoot);

	// ── Memory Bank `.md` divergence decorator ───────────────────────────────
	// Adds a small `✎` badge to Memory Bank `.md` files that have been edited
	// on disk and now diverge from the orphan-branch system view. Declared at
	// activate() scope so the revert command (registered below) can call
	// `memoryFileDecorationProvider.refreshUri(uri)` to clear the badge
	// immediately after a successful revert.
	const memoryFileDecorationProvider = new MemoryFileDecorationProvider(
		bridge,
	);
	context.subscriptions.push(
		vscode.window.registerFileDecorationProvider(
			memoryFileDecorationProvider,
		),
		memoryFileDecorationProvider,
	);
	// TODO(memory-bank-edit-protection): wire KbFoldersService file-change
	// events to memoryFileDecorationProvider.refreshUri so the badge clears
	// immediately after a system write. Today the badge updates on the next
	// VS Code re-poll of decorations.

	// The "Revert Edits to System Version" explorer right-click menu
	// (declared in `package.json` contributes.menus.explorer/context) is
	// only gated by the `.md` filename. VS Code's `when` clause cannot
	// run an async per-row "is this in our manifest?" query, so any
	// context-key based gate ends up tracking `activeTextEditor` instead
	// of the right-clicked resource — which silently hides the menu when
	// users right-click a closed Memory Bank file in the explorer (the
	// main advertised workflow). We accept the inverse trade-off: the
	// menu may briefly appear on non-Memory-Bank `.md` files; the
	// `revertMemoryFileEdits` handler silently no-ops in that case.

	// ── Auth service ─────────────────────────────────────────────────────────
	const authService = new AuthService();

	// ── Plan readonly preview ────────────────────────────────────────────────
	// Committed plans are previewed in a rendered markdown WebView panel (read-only).
	// Content is read from the orphan branch on demand.
	// Plan preview uses a virtual document (TextDocumentContentProvider) + VSCode's
	// built-in markdown preview for proper rendering with syntax highlighting.
	const PLAN_SCHEME = "jollimemory-plan";
	const planContentProvider = new (class
		implements vscode.TextDocumentContentProvider
	{
		private contents = new Map<string, string>();
		private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
		readonly onDidChange = this._onDidChange.event;
		setContent(slug: string, content: string, uri: vscode.Uri): void {
			this.contents.set(slug, content);
			// Force VSCode to re-fetch content for cached virtual documents.
			this._onDidChange.fire(uri);
		}
		provideTextDocumentContent(uri: vscode.Uri): string {
			const slug = new URLSearchParams(uri.query).get("slug") ?? "";
			log.info(
				"cmd",
				`provideTextDocumentContent: slug="${slug}", found=${this.contents.has(slug)}`,
			);
			return this.contents.get(slug) ?? "# Plan not found";
		}
	})();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			PLAN_SCHEME,
			planContentProvider,
		),
	);

	async function showPlanPreview(
		slug: string,
		title: string,
		readStorage?: StorageProvider,
	): Promise<void> {
		// Threading `readStorage` so foreign-repo previews read the plan
		// body from the foreign FolderStorage. For local panels the
		// caller passes `undefined` and the helper falls through to the
		// workspace's default storage.
		const content = await readPlanFromBranch(
			slug,
			workspaceRoot,
			readStorage,
		);
		if (!content) {
			vscode.window.showErrorMessage(
				`Could not read plan "${slug}" from the orphan branch.`,
			);
			return;
		}
		const safeTitle = title.replace(/[/\\:*?"<>|#%&{}]/g, "-").substring(0, 80);
		// Uri.from() correctly separates query from path (Uri.parse treats ?key=val as path for opaque URIs).
		const uri = vscode.Uri.from({
			scheme: PLAN_SCHEME,
			path: `/${safeTitle}.md`,
			query: `slug=${encodeURIComponent(slug)}`,
		});
		// Set content and fire onDidChange to invalidate any cached virtual document.
		planContentProvider.setContent(slug, content, uri);
		// Load virtual document (triggers provideTextDocumentContent) without showing a raw text tab.
		await vscode.workspace.openTextDocument(uri);
		// Open only the rendered markdown preview.
		await vscode.commands.executeCommand("markdown.showPreview", uri);
	}

	// ── Note readonly preview ───────────────────────────────────────────────
	// Mirrors the plan preview above, but reads notes from the orphan branch.
	const NOTE_SCHEME = "jollimemory-note";
	const noteContentProvider = new (class
		implements vscode.TextDocumentContentProvider
	{
		private contents = new Map<string, string>();
		private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
		readonly onDidChange = this._onDidChange.event;
		setContent(id: string, content: string, uri: vscode.Uri): void {
			this.contents.set(id, content);
			this._onDidChange.fire(uri);
		}
		provideTextDocumentContent(uri: vscode.Uri): string {
			const id = new URLSearchParams(uri.query).get("id") ?? "";
			log.info(
				"cmd",
				`provideTextDocumentContent (note): id="${id}", found=${this.contents.has(id)}`,
			);
			return this.contents.get(id) ?? "# Note not found";
		}
	})();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			NOTE_SCHEME,
			noteContentProvider,
		),
	);

	async function showNotePreview(
		id: string,
		title: string,
		readStorage?: StorageProvider,
	): Promise<void> {
		// Mirrors showPlanPreview: foreign-repo note previews thread their
		// FolderStorage in so the body comes from the foreign repo's
		// `<kbRoot>/.jolli/notes/<id>.md` instead of the current workspace's
		// orphan branch (where it doesn't exist).
		const content = await readNoteFromBranch(id, workspaceRoot, readStorage);
		if (!content) {
			vscode.window.showErrorMessage(
				`Could not read note "${title}" from the orphan branch.`,
			);
			return;
		}
		const safeTitle = title.replace(/[/\\:*?"<>|#%&{}]/g, "-").substring(0, 80);
		const uri = vscode.Uri.from({
			scheme: NOTE_SCHEME,
			path: `/${safeTitle}.md`,
			query: `id=${encodeURIComponent(id)}`,
		});
		noteContentProvider.setContent(id, content, uri);
		await vscode.workspace.openTextDocument(uri);
		await vscode.commands.executeCommand("markdown.showPreview", uri);
	}

	// ── Add note helpers ─────────────────────────────────────────────────────

	/** Opens a file dialog to import a markdown file as a note. */
	async function addMarkdownNote(
		br: JolliMemoryBridge,
		store: PlansStore,
	): Promise<void> {
		const fileUri = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { Markdown: ["md"] },
			title: "Select a Markdown file to add as a note",
		});
		if (!fileUri || fileUri.length === 0) {
			return;
		}

		const noteInfo = await br.saveNote(
			undefined,
			"",
			fileUri[0].fsPath,
			"markdown",
		);
		await store.refresh();
		if (noteInfo.filePath) {
			const doc = await vscode.workspace.openTextDocument(noteInfo.filePath);
			await vscode.window.showTextDocument(doc);
		}
		log.info("cmd", `addMarkdownNote: created note ${noteInfo.id}`);
	}

	// ── Exclude filter ──────────────────────────────────────────────────────
	const excludeFilter = new ExcludeFilterManager();

	// ── Status bar ───────────────────────────────────────────────────────────
	const statusBar = new StatusBarManager();
	context.subscriptions.push({ dispose: () => statusBar.dispose() });

	// ── Stores (host-side state controllers) ────────────────────────────────
	// Stores own mutable state, watchers, and bridge calls. Providers /
	// commands / (future) WebView adapters are thin subscribers.
	// Constructed BEFORE `activateSync` because the orchestrator forwards
	// per-phase sync labels into the StatusStore (see `setSyncPhase`).
	const statusStore = new StatusStore(bridge, authService);

	// ── Memory Bank sync (manual always-on; auto gated by config.autoSyncEnabled — plan §0.7) ──
	// Activate eagerly but don't block extension activation on the result —
	// `activateSync` no-ops when sync is dormant (no Jolli sign-in). The
	// returned Promise<SyncRuntime> is captured so the Settings save
	// callback can call `reconcileAutoSync()` to start polling after a
	// mid-session `autoSyncEnabled` flip ON (plan §P2 fix).
	//
	// `kbInitPromise` is the gate that holds back the first sync round
	// until `initializeKBFolder()` has written `<localFolder>/<repo>/
	// .jolli/config.json`. Pre-fix the two ran concurrently — sync could
	// pull from a peer device first, then KBPathResolver would see the
	// pulled `<repo>/` dir without identity (config.json denied per
	// AllowList §1) and allocate `<repo>-2/`, splitting content. The
	// promise is constructed below alongside `initializeKB()`.
	let resolveKbInit!: () => void;
	const kbInitPromise = new Promise<void>((resolve) => {
		resolveKbInit = resolve;
	});
	const syncActivation = activateSync(
		context,
		statusBar,
		kbInitPromise,
		statusStore,
	).catch((e) => {
		log.warn("Memory Bank sync activation failed: %s", (e as Error).message);
		return null;
	});
	const memoriesStore = new MemoriesStore(bridge);
	const plansStore = new PlansStore(bridge, {
		workspaceRoot,
		plansDir: getPlansDir(),
		notesDir: getNotesDir(workspaceRoot),
	});
	const filesStore = new FilesStore(bridge, workspaceRoot, excludeFilter);
	const commitsStore = new CommitsStore(bridge);
	context.subscriptions.push(
		statusStore,
		memoriesStore,
		plansStore,
		filesStore,
		commitsStore,
	);

	// ── Tree providers (thin subscribers over stores) ────────────────────────
	const statusProvider = new StatusTreeProvider(statusStore);
	const memoriesProvider = new MemoriesTreeProvider(memoriesStore);
	const plansProvider = new PlansTreeProvider(plansStore, workspaceRoot);
	const filesProvider = new FilesTreeProvider(filesStore);
	const historyProvider = new HistoryTreeProvider(commitsStore);

	context.subscriptions.push(statusProvider);
	context.subscriptions.push(memoriesProvider);
	context.subscriptions.push(plansProvider);
	context.subscriptions.push(filesProvider);
	context.subscriptions.push(historyProvider);
	context.subscriptions.push(
		vscode.window.registerFileDecorationProvider(
			new CommitFileDecorationProvider(),
		),
	);

	// Tree views were removed in favor of the 3-tab sidebar webview below.
	// The five `*TreeProvider` instances above are kept as data sources only:
	// the sidebar reads them through `serialize()` / `onDidChangeTreeData`.

	// ── Sidebar webview (3-tab) ──────────────────────────────────────────────
	// Provides directory listing for the Folders tab in the sidebar webview.
	// The tree is rooted at the user's Memory Bank parent (`localFolder`) and
	// each direct child is a discovered repo — opening one project doesn't
	// hide memories from other projects, matching IntelliJ's Memory Bank tool
	// window. Identity of the current project (repo name + origin URL) is
	// passed through to KbFoldersService so it can mark the user's "home"
	// repo for the sidebar's auto-expand / highlight behavior.
	/* v8 ignore start -- cherry-picked sidebar wiring; covered indirectly via SidebarWebviewProvider tests; follow-up adds activate-level tests. */
	const sidebarRepoName = extractRepoName(workspaceRoot);
	const sidebarRemoteUrl = getRemoteUrl(workspaceRoot);
	// Initial resolution skips customKBPath because loadConfig() is async.
	// The async branch below re-resolves once config is loaded, and the
	// settings-save callback re-resolves whenever the user picks a new folder.
	let sidebarKbParent = resolveKbParent();
	// Forward-declared so KbFoldersService can post a refresh into the
	// sidebar when a background heal regenerates `.md` files. SidebarWebviewProvider
	// is constructed later in activate(); the ref is filled in then.
	let sidebarProviderRef: { refreshKnowledgeBaseFolders(): void } | undefined;
	const kbFoldersService = new KbFoldersService(
		() => ({
			kbParent: sidebarKbParent,
			currentRepoName: sidebarRepoName,
			currentRemoteUrl: sidebarRemoteUrl,
		}),
		(info) => {
			// Heal recovered files during this listChildren — the call itself
			// already awaited the heal so the recovered files are in the tree
			// it returned. But cached subtrees the webview is still showing
			// (sibling branches, repos under the same parent) need a redraw
			// so manifest-derived labels stay in sync. Cheap; refresh is a
			// single repaint.
			if (info.healed > 0) sidebarProviderRef?.refreshKnowledgeBaseFolders();
		},
	);

	// Re-resolves sidebarKbParent from the latest config and (if the path has
	// changed) tells the sidebar webview to drop its cached folder tree so the
	// next listing starts from the new parent. Returns true when the parent moved.
	async function refreshSidebarKbRoot(): Promise<boolean> {
		try {
			const cfg = await loadConfig();
			const customKBPath = (cfg as Record<string, unknown>).localFolder as
				| string
				| undefined;
			const next = resolveKbParent(customKBPath);
			if (next !== sidebarKbParent) {
				sidebarKbParent = next;
				return true;
			}
		} catch (err) {
			log.warn("activate", "refreshSidebarKbRoot failed", err);
		}
		return false;
	}

	// The Memory Bank header is the fixed root of the KB tree — individual
	// repos surface as its children, mirroring IntelliJ's "KB > <repo> > ..."
	// layout. The webview renders "Memory Bank" when no override is passed,
	// so no per-repo string is needed here.

	let currentBranchName = "";
	let currentBranchDetached = false;
	const branchChangeEmitter = new vscode.EventEmitter<void>();

	// Re-read the current branch name from git and notify subscribers if it
	// changed. Called once at activation and again from the HEAD watcher so
	// branch switches (regular and detached) update the sidebar tab label.
	// Without the HEAD-watcher re-call, currentBranchName would freeze at
	// activation time and drift out of sync with what `git branch --show-current`
	// reports — producing the "tab name doesn't match workspace branch" bug.
	const refreshBranchName = async (): Promise<void> => {
		try {
			const branch = await bridge.getCurrentBranch();
			const detached = branch === "HEAD";
			if (branch === currentBranchName && detached === currentBranchDetached) {
				return;
			}
			currentBranchName = branch;
			currentBranchDetached = detached;
			branchChangeEmitter.fire();
		} catch (err) {
			log.warn("refreshBranchName", "Failed to read current branch", {
				error: (err as Error).message,
			});
		}
	};

	void refreshBranchName();

	let currentEnabled = true;
	let currentAuthenticated = false;
	// Tracks whether the user has either signed in to Jolli or supplied an
	// Anthropic API key. Drives the onboarding-panel vs main-UI split. Updated
	// from statusStore.onChange so sign-in / sign-out / settings save / config
	// reload all converge on a single source of truth.
	let currentConfigured = false;

	// Deferred barrier that the SidebarWebviewProvider awaits before posting
	// the first `init` message. We resolve it once `initialLoad()` (which
	// includes statusStore.refresh) has finished, so currentConfigured /
	// currentAuthenticated / currentBranchName have all been corrected from
	// their pessimistic activate-time defaults. Without this gate the
	// webview would render against `configured = false` on reload and visibly
	// flash the onboarding panel before the real value arrives. Wrapped on
	// the consumer side with .catch so a failed initialLoad never traps the
	// webview in the loading placeholder.
	let resolveInitialStateReady: () => void = () => {
		// no-op until the real resolver replaces it
	};
	const initialStateReady = new Promise<void>((resolve) => {
		resolveInitialStateReady = resolve;
	});

	// Hoisted so selectAllConversationsCommand can reference it directly
	// in the command registration below without going through sidebarProvider.
	const activeSessionsProvider = new ActiveSessionsProvider({
		getWorkspaceCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
	});

	let sidebarProvider: SidebarWebviewProvider;
	sidebarProvider = new SidebarWebviewProvider({
		executeCommand: (cmd, ...args) =>
			vscode.commands.executeCommand(cmd, ...args),
		getInitialState: () => ({
			enabled: currentEnabled,
			authenticated: currentAuthenticated,
			configured: currentConfigured,
			activeTab: "branch",
			kbMode: "folders",
			branchName: currentBranchName,
			detached: currentBranchDetached,
			// Display name of the workspace's repo — feeds the left half of the
			// header breadcrumb. Without this the webview shows `(workspace)`
			// as a placeholder and `isViewingForeign()` can't compare repo
			// identity, so foreign-readonly chrome stays inactive even after
			// the user picks another repo from the dropdown.
			currentRepoName: sidebarRepoName,
		}),
		extensionUri: context.extensionUri,
		statusProvider: {
			serialize: () => statusProvider.serialize(),
			onDidChangeTreeData:
				statusProvider.onDidChangeTreeData.bind(statusProvider),
			getWorkerBusy: () => statusProvider.getWorkerBusy(),
			getSyncPhase: () => statusStore.getSnapshot().syncPhase,
		},
		memoriesProvider: {
			serialize: () => memoriesProvider.serialize(),
			onDidChangeTreeData:
				memoriesProvider.onDidChangeTreeData.bind(memoriesProvider),
		},
		plansProvider: {
			serialize: () => plansProvider.serialize(),
			onDidChangeTreeData:
				plansProvider.onDidChangeTreeData.bind(plansProvider),
		},
		filesProvider: {
			serialize: () => filesProvider.serialize(),
			onDidChangeTreeData:
				filesProvider.onDidChangeTreeData.bind(filesProvider),
		},
		historyProvider: {
			serialize: async () => historyProvider.serialize(),
			onDidChangeTreeData:
				historyProvider.onDidChangeTreeData.bind(historyProvider),
			getMode: historyProvider.getMode.bind(historyProvider),
		},
		kbFolders: kbFoldersService,
		// Breadcrumb dropdowns. The discoverRepos output carries `kbRoot` /
		// `dirName` fields that the webview doesn't need (selector key is
		// the configured repoName, with remoteUrl forwarded for cross-repo
		// PR lookups); flatten to RepoChoice here so SidebarMessages stays
		// the single source of truth for what crosses the wire.
		selection: {
			listRepos: () =>
				kbFoldersService.listRepos().map((r) => ({
					repoName: r.repoName,
					remoteUrl: r.remoteUrl ?? undefined,
					isCurrent: r.isCurrentRepo,
				})),
			listBranches: (repoName: string) =>
				kbFoldersService.listBranches(repoName),
			listBranchMemories: async (repoName: string, branchName: string) => {
				const entries = await bridge.listBranchMemories(repoName, branchName);
				return entries.map((e) => ({
					commitHash: e.commitHash,
					title: e.commitMessage.split("\n")[0] || e.commitHash.slice(0, 8),
					branch: e.branch,
					repoName: e.repoName ?? repoName,
					timestamp: Date.parse(e.commitDate || e.generatedAt) || 0,
					// Reuse the KB-tab Memories list builder so the foreign-mode
					// Branch panel renders an identical hover-card (message, time,
					// commit type, branch, stats, short hash).
					hover: buildHoverFields(e),
				}));
			},
		},
		// relPath's first segment is now a repo directory name under
		// <kbParent>; join'ing on kbParent gives back the absolute on-disk
		// path. Same shape as the IntelliJ Memory Bank tree.
		resolveKbAbs: (relPath) => join(sidebarKbParent, relPath),
		// Lets handleOpenFile light up the Folders-tab ✎ marker the moment a
		// user opens a `.md` that's been edited on disk — same sha256-vs-manifest
		// check the native MemoryFileDecorationProvider badge uses.
		isMemoryFileDivergedOnDisk: (abs) => bridge.isMemoryFileDivergedOnDisk(abs),
		// MemoriesStore was previously loaded via memoriesView.onDidChangeVisibility;
		// the webview replacement has no equivalent built-in event, so we plumb it
		// through SidebarWebviewProvider's `case "ready"` instead.
		onSidebarFirstVisible: () => {
			void memoriesStore.ensureFirstLoad();
		},
		branchWatcher: {
			current: () => ({
				name: currentBranchName,
				detached: currentBranchDetached,
			}),
			onChange: (cb) => {
				const disposable = branchChangeEmitter.event(() => {
					cb(currentBranchName, currentBranchDetached);
				});
				return { dispose: () => disposable.dispose() };
			},
		},
		applyFileCheckbox: (filePath, selected) =>
			filesStore.applyCheckboxBatch([[filePath, selected]]),
		applyCommitCheckbox: (hash, selected) =>
			commitsStore.onCheckboxToggle(hash, selected),
		applyConversationCheckbox: async (source, sessionId, selected) => {
			await setExcluded(
				workspaceRoot,
				"conversations",
				conversationKey(source, sessionId),
				!selected,
			);
			await sidebarProvider.refreshConversationsPanel();
		},
		applyPlanCheckbox: async (planId, selected) => {
			await setExcluded(workspaceRoot, "plans", planId, !selected);
			await plansProvider.refreshExclusions();
		},
		applyReferenceCheckbox: async (mapKey, selected) => {
			await setExcluded(workspaceRoot, "references", mapKey, !selected);
			await plansProvider.refreshExclusions();
		},
		applyNoteCheckbox: async (noteId, selected) => {
			await setExcluded(workspaceRoot, "notes", noteId, !selected);
			await plansProvider.refreshExclusions();
		},
		// Active Conversations source for the Branch tab (hoisted above so
		// selectAllConversationsCommand can reference it directly).
		activeSessionsProvider: activeSessionsProvider,
		initialStateReady,
	});
	sidebarProviderRef = sidebarProvider;
	context.subscriptions.push(
		sidebarProvider,
		vscode.window.registerWebviewViewProvider(
			SidebarWebviewProvider.viewId,
			sidebarProvider,
		),
		branchChangeEmitter,
	);

	// Wire the post-sync UI refresh now that `kbFoldersService` + `sidebarProvider`
	// exist. Sync rounds finish without VS Code's file watchers picking up the
	// `git pull` writes (the working tree mutation is invisible to webview
	// observers), so the Memory Bank tree view stays on its pre-sync listing
	// until something invalidates the cache and asks the webview to re-list.
	// `activateSync` ran earlier; the runtime stashes the callback and reuses
	// it for any orchestrator built later (eager or lazy).
	// Symlink popup gate REMOVED — the upstream `symlink_quarantine_failed`
	// round-terminal code was deleted in Phase 1 alongside `SymlinkSweep`.
	// Symlink defence now lives in stageVault's per-entry `symlinked`
	// canary (warn-logged with the offending path) and FolderStorage's
	// `safeAtomicWriteSync` (refuses to traverse a hostile intermediate
	// segment at write time). Neither path needs a one-shot user popup
	// because they don't terminate the round — sync continues with the
	// rogue entries excluded.
	void syncActivation.then((activation) => {
		if (!activation) return; // Sync activation failed; nothing to wire.
		activation.runtime.setOnRoundFinished((state, _result) => {
			// `refreshKnowledgeBaseFolders` covers both halves: it invalidates
			// `KbFoldersService`'s `cleanRepos` cache AND posts `kb:foldersReset`
			// to the webview so it re-lists from scratch. Fires for every
			// outcome — even `offline` rounds may have landed a partial pull
			// before failing.
			sidebarProvider.refreshKnowledgeBaseFolders();
			// Timeline / Memories views read `bridge.cachedRootEntries` —
			// without invalidating, a successful sync (which pulled new
			// summaries onto disk) keeps showing pre-sync data until the
			// next post-commit hook clears the cache. Refresh memoriesStore
			// too so the multi-repo aggregate picks up newly-pulled entries
			// from sibling repos.
			bridge.invalidateEntriesCache();
			if (memoriesStore.hasFirstLoaded()) {
				memoriesStore.refresh().catch(handleError("post-sync.memories"));
			}
			log.info("post-sync UI refresh fired (state=%s)", state);
		});
	});

	void loadConfig().then((cfg) => {
		currentAuthenticated = !!cfg?.authToken;
		sidebarProvider.notifyAuthChanged(currentAuthenticated);
	});

	// Keep `currentEnabled` and `currentConfigured` in lockstep with StatusStore
	// so the disabled banner and onboarding-panel vs main-UI split flip the
	// moment any underlying signal changes (enable/disable, sign-in/sign-out,
	// settings save, config reload). Routing both through the same store also
	// puts them under `initialStateReady`'s barrier — `initialLoad()` awaits
	// `statusStore.refresh()`, which fires this subscription, so the first
	// `init` message the webview receives reflects real state instead of the
	// optimistic activate-time defaults. Previously `currentEnabled` had its
	// own fire-and-forget `bridge.getStatus()` outside the barrier, which
	// could race the `init` and briefly flash the main UI before flipping to
	// disabled. Only fire `notify…` when the boolean actually changes to keep
	// webview round-trips minimal.
	context.subscriptions.push({
		dispose: statusStore.onChange((snap) => {
			const nextConfigured = snap.derived.signedIn || snap.derived.hasApiKey;
			if (nextConfigured !== currentConfigured) {
				currentConfigured = nextConfigured;
				sidebarProvider.notifyConfiguredChanged(nextConfigured);
			}
			if (snap.status && snap.status.enabled !== currentEnabled) {
				currentEnabled = snap.status.enabled;
				sidebarProvider.notifyEnabledChanged(snap.status.enabled);
			}
		}),
	});
	// Pick up customKBPath from config now that loadConfig() can run async.
	// Without this the sidebar would keep showing the default KB folder until
	// the user reopens VS Code, even after they've configured "Local Folder".
	void refreshSidebarKbRoot().then((moved) => {
		if (moved) sidebarProvider.refreshKnowledgeBaseFolders();
	});
	/* v8 ignore stop */

	// View-level UI subscriptions (historyView.title / memoriesView.description)
	// were dropped along with the tree views — the sidebar webview renders these
	// labels itself via its serialized snapshots.

	void vscode.commands.executeCommand(
		"setContext",
		"jollimemory.history.singleCommitMode",
		false,
	);

	// Set `jollimemory.enabled` optimistically to `true` IMMEDIATELY after tree views
	// are registered, before any async work begins. This prevents the "JolliMemory is
	// disabled" welcome content from flashing while initialLoad() and refreshStatusBar()
	// are still running. The actual value is corrected by refreshStatusBar() once the
	// bridge reports the real enabled state.
	void vscode.commands.executeCommand(
		"setContext",
		"jollimemory.enabled",
		true,
	);

	// ── Serialized KB initialization ────────────────────────────────────────
	// All three KB-related startup tasks (KB tree root, legacy migrations, KB
	// folder init + auto-migration) are serialized into one async function to
	// prevent race conditions from concurrent orphan branch and config access.
	async function initializeKB(): Promise<void> {
		// Dynamic imports are used throughout initializeKB because these cli/
		// modules depend on Node-only APIs (fs, child_process). Static imports
		// would cause esbuild to bundle them into the VS Code extension,
		// breaking the build in webview/browser contexts.

		// (KB tree-provider init removed — the sidebar webview computes its own
		// kbRoot synchronously via resolveKBPath() at activation time.)

		// 2. Run legacy migrations sequentially: orphan branch migration must
		// complete before flat index migration to prevent concurrent writes.
		// TODO(v1.0): Remove all migration code (migrateV1IfNeeded,
		// migrateIndexIfNeeded, cleanupV1IfExpired) once JolliMemory v1.0
		// ships — all users will be on v3 by then.
		await migrateV1IfNeeded(
			workspaceRoot,
			statusStore,
			commitsStore,
			filesStore,
		);
		await migrateIndexIfNeeded(
			bridge,
			statusStore,
			commitsStore,
			filesStore,
		);

		// V1 branch delayed cleanup: after migration, the v1 branch is retained
		// for 48 hours as a safety net. Check if the retention period has expired.
		await cleanupV1IfExpired(workspaceRoot);

		// 2.5. v3 → v4 → v5 unified schema migration. Idempotent — reads its own
		// state file on the orphan branch and skips when already completed; also
		// skips when no orphan branch exists yet (the first post-commit creates
		// it, and the next activate() picks the migration up). Runs in the
		// `initializeKB` sequence so the v1 → v3 conversion completes before v5
		// inspects summaries. Failure is non-fatal: next activate() retries.
		//
		// Wrapped in setMigrating(true/false) across all three stores so the
		// sidebar surfaces the existing "Migrating memories..." affordance
		// (StatusTreeProvider spinner, FilesTreeProvider / HistoryTreeProvider
		// hide-children) while v5 work is in flight. Mirrors the v1→v3 and
		// index-migration patterns above; user gets a unified "data being
		// upgraded" signal across panels without us inventing a new banner.
		const { migrateSchemaToV5, readSchemaV5State } = await import(
			"../../cli/src/core/SchemaV5Migration.js"
		);
		// Needed-check FIRST so the common already-migrated path doesn't flash the
		// "Migrating memories..." affordance every activate() (mirrors the v1→v3 /
		// index migrations, which gate their UI toggle on a check). A read error →
		// treat as unknown and let migrateSchemaToV5 (re-checks + short-circuits) decide.
		const v5State = await readSchemaV5State(workspaceRoot ?? undefined).catch(() => null);
		const v5Pending = v5State?.status !== "completed";
		if (v5Pending) {
			statusStore.setMigrating(true);
			commitsStore.setMigrating(true);
			filesStore.setMigrating(true);
		}
		try {
			// `?? undefined` because workspaceRoot is `string | null` here; the
			// value is non-null (we returned earlier when it was), the coercion
			// just satisfies tsc.
			if (!v5Pending) {
				log.info("activate", "Schema v5 migration already complete — skipping (no UI toggle)");
			} else {
				const v5Result = await migrateSchemaToV5(workspaceRoot ?? undefined);
				log.info(
					"activate",
					`Schema v5 migration: alreadyDone=${v5Result.alreadyDone} fresh=${v5Result.fresh} migrated=${v5Result.migrated} skipped=${v5Result.skipped}`,
				);
			}
		} catch (err) {
			log.warn(
				"activate",
				`Schema v5 migration failed (non-fatal): ${(err as Error).message}`,
			);
		} finally {
			// Always clear migration state — including on failure — so the
			// sidebar comes back to a usable state and the user can read the
			// "Not migrated" status / re-run via `jolli migrate`.
			if (v5Pending) {
				statusStore.setMigrating(false);
				commitsStore.setMigrating(false);
				filesStore.setMigrating(false);
			}
		}

		// 3. KB folder auto-initialization + migration
		// Creates the KB folder (~/Documents/jolli/{repoName}/) and auto-migrates
		// orphan branch data if migration hasn't been completed yet.
		try {
			const {
				extractRepoName,
				getRemoteUrl,
				resolveKBPath,
			} = await import("../../cli/src/core/KBPathResolver.js");
			const { MetadataManager } = await import(
				"../../cli/src/core/MetadataManager.js"
			);
			const { OrphanBranchStorage } = await import(
				"../../cli/src/core/OrphanBranchStorage.js"
			);
			const { FolderStorage } = await import(
				"../../cli/src/core/FolderStorage.js"
			);
			const { MigrationEngine } = await import(
				"../../cli/src/core/MigrationEngine.js"
			);
			const repoName = extractRepoName(workspaceRoot);
			const remoteUrl = getRemoteUrl(workspaceRoot);
			const config = await loadConfig();
			const customKBPath = (config as Record<string, unknown>).localFolder as
				| string
				| undefined;
			const kbRoot = resolveKBPath(repoName, remoteUrl, customKBPath);
			// NOTE: do NOT release the sync gate here. `.jolli/config.json`
			// is now on disk so the per-repo identity question is settled,
			// but the orphan→folder migration block below still writes
			// summaries/transcripts/plans/notes into `<kbRoot>` for
			// minutes on first install. Releasing here would let sync
			// `git add --all` half-written migration output. The gate is
			// released by the outer `finally` once the whole
			// `initializeKB()` body returns (including migration).

			// Auto-migrate if orphan branch has data but migration not completed.
			// Three entry points:
			//   (1) Fresh install of the folder-mode extension on a repo
			//       previously using orphan storage.
			//   (2) User manually wiped the KB folder (which also nukes
			//       migration.json, making readMigrationState() return null
			//       and forcing a re-migration).
			//   (3) Already-migrated user whose v1 migration completed before
			//       v3 stale-child cleanup shipped (or who only got 0.99.2's
			//       inverted leaf-only pass, which mistakenly deleted heads
			//       and kept hoisted children). runStaleChildCleanup is
			//       idempotent via state.staleChildCleanup.completedAt; we
			//       intentionally do NOT look at state.leafCleanup — that
			//       legacy flag tracked the inverted pass and must not block
			//       the corrective re-run.
			const orphan = new OrphanBranchStorage(workspaceRoot);
			if (await orphan.exists()) {
				const mm = new MetadataManager(join(kbRoot, ".jolli"));
				const migrationState = mm.readMigrationState();
				if (!migrationState || migrationState.status !== "completed") {
					const folder = new FolderStorage(kbRoot, mm);
					await folder.ensure();
					const engine = new MigrationEngine(orphan, folder, mm);
					const result = await engine.runMigration();
					log.info(
						"activate",
						`KB auto-migration: ${result.status} (${result.migratedEntries}/${result.totalEntries})`,
					);
					// Bust the bridge's read-storage cache. initializeKB is
					// fire-and-forget, so UI surfaces (Memories / Timeline)
					// can hit `getReadStorage()` BEFORE migration finishes —
					// at which point the folder lacks index.json and the C2
					// fallback caches an OrphanBranchStorage promise. Without
					// this reset, the cached fallback survives migration
					// completion and the session stays stuck on orphan reads
					// (cross-machine folder-synced rows stay invisible) until
					// a window reload or settings change.
					bridge.reloadStorage();
					// initializeKB is fire-and-forget (`void initializeKB()` below),
					// so the sidebar webview can resolve and request kb:expandFolder
					// before migration writes its first MD. Without an explicit
					// signal, the sidebar's first listing is empty and stays empty
					// until the user clicks Refresh — a UX bug that surfaces every
					// post-wipe reload. Push a reset so the client re-fetches once
					// migration's writes are on disk.
					sidebarProvider.refreshKnowledgeBaseFolders();
				} else {
					// Already migrated: run the stale-child reconcile on EVERY
					// activate (not gated on staleChildCleanup.completedAt — that
					// stamp now only retires the one-shot 0.99.2 head-regen inside
					// runStaleChildCleanup). The sweep deletes visible .md for
					// children hoisted on now-inactive / merged branches, which the
					// QueueWorker tail cleanup never revisits, so this is the only
					// place the "visible folder shows only heads" invariant
					// self-heals for dormant branches.
					const folder = new FolderStorage(kbRoot, mm);
					await folder.ensure();
					const engine = new MigrationEngine(orphan, folder, mm);
					const result = await engine.runStaleChildCleanup();
					log.info(
						"activate",
						`KB stale-child reconcile: swept=${result.swept} completedAt=${result.staleChildCleanup?.completedAt ?? "n/a"}`,
					);
					// Refresh ONLY when the sweep actually deleted files. A no-op
					// reconcile (the steady state after the first heal) must not
					// bust the storage cache or reset the sidebar tree — that would
					// collapse the user's expanded folders on every window reload.
					if (result.swept > 0) {
						bridge.reloadStorage();
						sidebarProvider.refreshKnowledgeBaseFolders();
					}
				}
			}
		} catch (err) {
			log.error("activate", "KB folder init/migration failed", err);
		}
	}

	// Always release the sync gate when `initializeKB()` exits, even via
	// error. Without this, a migration crash BEFORE `initializeKBFolder()`
	// would leave `kbInitPromise` pending forever and sync rounds would
	// hang indefinitely.
	//
	// Defense-in-depth watchdog: if `initializeKB()` ever returns a
	// Promise that never settles (or a future refactor breaks the
	// `.finally()` wiring), release the gate anyway after 60s. Promise
	// resolve is idempotent so calling `resolveKbInit()` from both arms
	// when both fire is safe. The cost of releasing early is one possibly
	// premature sync round; the cost of NOT releasing is sync hangs
	// forever — strict ordering.
	const kbInitWatchdog = setTimeout(() => {
		log.warn(
			"activate",
			"kbInitPromise watchdog fired after 60s — releasing sync gate; check initializeKB() for hangs",
		);
		resolveKbInit();
	}, 60_000);
	initializeKB().finally(() => {
		clearTimeout(kbInitWatchdog);
		resolveKbInit();
	});

	// ── sessions.json watcher ─────────────────────────────────────────────────
	// When sessions.json is created or updated (e.g. a new Claude Code session
	// starts or stops), the watcher triggers a refresh so the STATUS panel
	// reflects the current active session count without manual user action.
	const sessionsWatcher = watchFile(
		workspaceRoot,
		".jolli/jollimemory/sessions.json",
		() => {
			statusStore.refresh().catch(handleError("sessionsWatcher"));
			plansStore.refresh().catch(handleError("sessionsWatcher.plans"));
		},
	);
	context.subscriptions.push(sessionsWatcher);

	// Plans / Notes / plans.json watchers and new-plan registration are now
	// owned by PlansStore (see `src/stores/PlansStore.ts`).  The Store is
	// disposed via context.subscriptions above, which tears down all three
	// watchers in one shot.
	const notesDir = plansStore.getNotesDir();

	// ── External markdown note watcher ──────────────────────────────────────
	// Markdown notes now reference the user's original file (outside the notes
	// dir), so the notesDirWatcher above won't fire for them.  Subscribe to
	// onDidSaveTextDocument and trigger a debounced refresh when a registered
	// markdown note's source file is saved.
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(async (doc) => {
			if (!doc.fileName.endsWith(".md")) {
				return;
			}
			// Skip files inside the notes dir — already handled by notesDirWatcher
			if (doc.fileName.startsWith(notesDir)) {
				return;
			}
			try {
				const notes = await bridge.listNotes();
				const isNoteSource = notes.some(
					(n) => n.format === "markdown" && n.filePath === doc.fileName,
				);
				if (isNoteSource) {
					plansStore.refreshFromExternalNoteSave();
				}
			} catch {
				/* ignore — listNotes failure is non-critical here */
			}
		}),
	);

	// ── HEAD watcher ────────────────────────────────────────────────────────
	// When switching branches, ALL panels need to refresh: commits change,
	// git status changes, summary count changes, and plan visibility is branch-scoped.
	// Windows git uses atomic rename for branch switches (HEAD.lock → HEAD),
	// which fires as a create event — watchFile() subscribes to both create
	// and change so either event triggers the refresh.
	//
	// Worktree note: in a worktree, `.git` is a pointer file (not a directory),
	// and the actual HEAD lives at `<main>/.git/worktrees/<name>/HEAD`.
	// resolveGitPath() asks git itself for the correct absolute path so the
	// watcher works in both regular repos and worktrees.
	const headPath = resolveGitPath(workspaceRoot, "HEAD");
	if (headPath) {
		const headWatcher = watchFile(
			vscode.Uri.file(dirname(headPath)),
			"HEAD",
			() => {
				// Branch label is the only piece that doesn't read from a store —
				// re-fetch and emit through branchChangeEmitter so the Branch tab
				// label tracks the workspace's actual HEAD across branch switches
				// (regular + detached). The other refreshes drive the per-tab data
				// stores, which already key off "current branch" implicitly.
				void refreshBranchName();
				statusStore.refresh().catch(handleError("headWatcher.status"));
				plansStore.refresh().catch(handleError("headWatcher.plans"));
				filesStore.refresh().catch(handleError("headWatcher.files"));
				commitsStore.refresh().catch(handleError("headWatcher.history"));
			},
		);
		context.subscriptions.push(headWatcher);
	} else {
		log.warn(
			"activate",
			"Could not resolve git HEAD path — branch-switch auto-refresh disabled",
		);
	}

	// ── Orphan branch watcher ────────────────────────────────────────────────
	// When the post-commit hook writes a new summary to the orphan branch,
	// git's update-ref updates the ref file. Watch it to auto-refresh the
	// COMMITS panel so the "View Memory" icon appears promptly.
	// Orphan refs live in the common git dir (shared across worktrees), so
	// resolveGitPath() with --git-path returns the correct absolute location.
	const orphanRefPath = resolveGitPath(
		workspaceRoot,
		`refs/heads/${ORPHAN_BRANCH}`,
	);
	if (orphanRefPath) {
		const orphanRefWatcher = watchFile(
			vscode.Uri.file(dirname(orphanRefPath)),
			ORPHAN_BRANCH,
			() => {
				bridge.invalidateEntriesCache();
				commitsStore.refresh().catch(handleError("orphanRefWatcher"));
				// Lazy-load gate: if the user never opened Memories, do NOT silently
				// wake it up in the background (would trigger listSummaryEntries).
				if (memoriesStore.hasFirstLoaded()) {
					memoriesStore
						.refresh()
						.catch(handleError("orphanRefWatcher.memories"));
				}
			},
		);
		context.subscriptions.push(orphanRefWatcher);
	} else {
		log.warn(
			"activate",
			"Could not resolve orphan ref path — memory-finished auto-refresh disabled",
		);
	}

	// ── Worker lock file watcher ────────────────────────────────────────
	// When the post-commit Worker is running, it holds
	// `.jolli/jollimemory/worker.lock`. Disable Commit/Squash/Push buttons during
	// this time to prevent race conditions (Bug 3: squash commit while previous
	// Worker holds the lock).
	//
	// We deliberately watch only `worker.lock`, not the sibling
	// `orphan-write.lock`. The orphan-write mutex is held for milliseconds at a
	// time and exists to serialize concurrent orphan-branch writers; surfacing
	// it as "worker busy" would flicker buttons every time a background scan
	// writes a tree-hash alias. The split is the fix for the orphaned-queue-
	// entry bug; pre-split, both roles shared a single `lock` file.
	const lockWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(workspaceRoot, ".jolli/jollimemory/worker.lock"),
	);
	const setWorkerBusy = (busy: boolean) => {
		statusStore.setWorkerBusy(busy);
		void vscode.commands.executeCommand(
			"setContext",
			"jollimemory.workerBusy",
			busy,
		);
	};
	lockWatcher.onDidCreate(() => setWorkerBusy(true));
	lockWatcher.onDidChange(() => setWorkerBusy(true));
	lockWatcher.onDidDelete(() => {
		setWorkerBusy(false);
		// The orphan-ref file watcher should have already triggered a refresh when
		// storeSummary() called git update-ref, but on Windows the file-system
		// notification for .git/refs/ can be delayed or missed entirely. Refresh
		// the COMMITS panel here as a reliable fallback so the View Memory icon
		// appears as soon as the worker finishes.
		bridge.invalidateEntriesCache();
		commitsStore.refresh().catch(handleError("lockWatcher.onDidDelete"));
		if (memoriesStore.hasFirstLoaded()) {
			memoriesStore
				.refresh()
				.catch(handleError("lockWatcher.onDidDelete.memories"));
		}
		// Refresh PLANS panel so commit hash prefix appears after Worker associates plans.
		plansStore.refresh().catch(handleError("lockWatcher.onDidDelete.plans"));
		// Refresh CONVERSATIONS panel too — the worker advanced cursors for the
		// included sessions, so those rows should drop out immediately rather
		// than waiting up to 60s for the background poll. Excluded rows stay
		// because their cursors weren't touched (see QueueWorker
		// loadSessionTranscripts pre-read exclusion filter).
		sidebarProvider
			.refreshConversationsPanel()
			.catch(handleError("lockWatcher.onDidDelete.conversations"));
	});
	context.subscriptions.push(lockWatcher);
	// Check initial state — lock file might already exist on activation
	void isWorkerBusy(workspaceRoot).then(setWorkerBusy);

	// COMMITS title updates are handled by the commitsStore.onChange subscription
	// the sidebar webview wires up — no provider hook needed.

	// CHANGES badge — surfaces the visible (post-exclude) changed-file count
	// on the activity-bar icon. WebviewView shares the `.badge` API with
	// TreeView (VS Code 1.72+), so the wiring forwards filesStore.onChange.
	// The in-panel header is rendered by the webview itself, so only the
	// activity-bar surface — which the webview can't reach on its own — is
	// wired here. The "N files hidden" description override is intentionally
	// not restored: the count is already visible in SidebarHtmlBuilder's
	// in-panel header. Computation lives in `computeChangesBadge` so the
	// disabled / migrating gates stay in lockstep with FilesTreeProvider.
	function updateChangesBadge(): void {
		sidebarProvider.setBadge(computeChangesBadge(filesStore.getSnapshot()));
	}
	context.subscriptions.push({
		dispose: filesStore.onChange(updateChangesBadge),
	});
	updateChangesBadge();

	// ── Commands ─────────────────────────────────────────────────────────────
	const commitCommand = new CommitCommand(
		bridge,
		filesStore,
		commitsStore,
		statusStore,
		statusBar,
		workspaceRoot,
	);
	const squashCommand = new SquashCommand(
		bridge,
		commitsStore,
		filesStore,
		statusStore,
		statusBar,
		workspaceRoot,
	);
	const pushCommand = new PushCommand(
		bridge,
		commitsStore,
		filesStore,
		statusStore,
		statusBar,
		workspaceRoot,
	);

	// Shared resolver for the multi-source reference webview commands. The webview
	// may dispatch a mapKey that was removed between render and click — committed
	// away (commit deletes the entry) or hard-removed — and bridge.listReferences
	// returns only active references, so each command re-reads the list before
	// acting and surfaces a warning toast on miss instead of silently no-op'ing.
	const resolveReferenceForCommand = async (mapKey: string, cmdLabel: string) => {
		const references = await bridge.listReferences();
		const info = references.find((e) => e.mapKey === mapKey);
		if (!info) {
			log.warn(
				"cmd",
				`${cmdLabel}: mapKey ${mapKey} not found (likely archived or ignored after webview cached it)`,
			);
			vscode.window.showWarningMessage(
				`Reference ${mapKey} is no longer in the active panel — it may have been archived or ignored. Refresh and try again.`,
			);
		}
		return info;
	};

	context.subscriptions.push(
		// Settings → Migrate to Memory Bank. Re-runs the orphan→folder migration
		// into a fresh `-N`-suffixed folder, leaves the old folder's content on
		// disk, and "repoints" by archiving the old folder's repo identity so
		// the next resolveKBPath() picks the new one. Returns a structured
		// result instead of showing UI directly — SettingsWebviewPanel relays it
		// back into the webview's button state.
		vscode.commands.registerCommand(
			"jollimemory.rebuildKnowledgeBase",
			async (): Promise<{ ok: boolean; message: string }> => {
				try {
					const {
						extractRepoName,
						getRemoteUrl,
						initializeKBFolder,
						peekKBPath,
						findFreshKBPath,
					} = await import("../../cli/src/core/KBPathResolver.js");
					const { MetadataManager } = await import(
						"../../cli/src/core/MetadataManager.js"
					);
					const { OrphanBranchStorage } = await import(
						"../../cli/src/core/OrphanBranchStorage.js"
					);
					const { FolderStorage } = await import(
						"../../cli/src/core/FolderStorage.js"
					);
					const { MigrationEngine } = await import(
						"../../cli/src/core/MigrationEngine.js"
					);

					const repoName = extractRepoName(workspaceRoot);
					const remoteUrl = getRemoteUrl(workspaceRoot);
					const cfg = await loadConfig();
					const customKBPath = (cfg as Record<string, unknown>).localFolder as
						| string
						| undefined;

					const orphan = new OrphanBranchStorage(workspaceRoot);
					if (!(await orphan.exists())) {
						return {
							ok: false,
							message: "No git storage found — nothing to rebuild.",
						};
					}

					// Use the read-only `peekKBPath` for the "where would my old
					// folder be?" lookup — `resolveKBPath` would *claim* basePath
					// as a side effect on a pristine system, fooling the
					// `oldKbRoot !== newKbRoot` archive gate into archiving a
					// folder we just created (and writing data to `-2` instead).
					const oldKbRoot = peekKBPath(repoName, remoteUrl, customKBPath);
					const newKbRoot = findFreshKBPath(repoName, customKBPath);
					initializeKBFolder(newKbRoot, repoName, remoteUrl);

					const newMm = new MetadataManager(join(newKbRoot, ".jolli"));
					const folder = new FolderStorage(newKbRoot, newMm);
					await folder.ensure();
					const engine = new MigrationEngine(orphan, folder, newMm);
					const result = await engine.runMigration();

					// "Repoint": rewrite the old folder's identity so resolveKBPath()
					// no longer reuses it. Content files are untouched.
					if (oldKbRoot !== newKbRoot) {
						try {
							const oldMm = new MetadataManager(join(oldKbRoot, ".jolli"));
							const oldCfg = oldMm.readConfig();
							oldMm.saveConfig({
								...oldCfg,
								remoteUrl: undefined,
								repoName: `${repoName}-archived-${Date.now()}`,
							});
						} catch (err) {
							log.warn(
								"rebuildKnowledgeBase",
								`failed to archive old KB identity at ${oldKbRoot}`,
								err,
							);
						}
					}

					// Rebuild's new folder lives under the SAME Memory Bank parent
					// as the previous one (e.g. <localFolder>/<repo>-2/), so
					// refreshSidebarKbRoot would return moved=false and the KB tree
					// would still point at the archived directory until a window
					// reload. The per-repo kbRoot changed, even though the parent
					// did not — refresh + cache-invalidate unconditionally after a
					// successful rebuild so the tree picks up the new folder and
					// the multi-repo Memories aggregate drops entries discovered
					// against the now-archived identity.
					await refreshSidebarKbRoot();
					sidebarProvider.refreshKnowledgeBaseFolders();
					bridge.invalidateEntriesCache();
					if (memoriesStore.hasFirstLoaded()) {
						memoriesStore
							.refresh()
							.catch(handleError("rebuildKnowledgeBase.memories"));
					}

					if (result.status === "completed") {
						return {
							ok: true,
							message: `${result.migratedEntries} memories migrated to ${newKbRoot}`,
						};
					}
					return {
						ok: false,
						message: `Rebuild ${result.status}: ${result.migratedEntries}/${result.totalEntries} entries (${newKbRoot})`,
					};
				} catch (err) {
					return {
						ok: false,
						message: (err as Error).message,
					};
				}
			},
		),
		// Status panel
		// Beyond refreshing the status store + status bar, this also re-pulls
		// `bridge.getStatus()` (via refreshStatusBar's return value) and
		// `loadConfig()` to resync the sidebar shell's `currentEnabled` /
		// `currentAuthenticated` — those are only otherwise updated by
		// startup promises and the enable/disable/auth commands, so without
		// this any out-of-band change to hooks or auth would leave the
		// disabled panel / Sign In/Out chrome stale until reload.
		vscode.commands.registerCommand("jollimemory.refreshStatus", async () => {
			statusStore.refresh().catch(handleError("refreshStatus"));
			try {
				const status = await refreshStatusBar(
					bridge,
					memoriesStore,
					plansStore,
					filesStore,
					commitsStore,
					statusBar,
				);
				if (status.enabled !== currentEnabled) {
					currentEnabled = status.enabled;
					sidebarProvider.notifyEnabledChanged(status.enabled);
				}
				const cfg = await loadConfig();
				const nextAuth = !!cfg?.authToken;
				if (nextAuth !== currentAuthenticated) {
					currentAuthenticated = nextAuth;
					sidebarProvider.notifyAuthChanged(nextAuth);
				}
			} catch (err) {
				handleError("refreshStatus")(err);
			}
		}),

		// enableJolliMemory / disableJolliMemory: two commands with different icons,
		// conditionally shown via package.json `when` clauses using the
		// `jollimemory.enabled` context key (set by refreshStatusBar after each change).
		vscode.commands.registerCommand(
			"jollimemory.enableJolliMemory",
			async () => {
				log.info("cmd", "enableJolliMemory invoked");

				const result = await bridge.enable();
				if (!result.success) {
					log.error("cmd", "enable failed", { message: result.message });
					vscode.window.showErrorMessage(`Jolli Memory: ${result.message}`);
				} else {
					// Clear the opt-out so subsequent IDE restarts auto-enable as
					// usual. Done only on success — a failed install means the
					// previous (manuallyDisabled) state is still the user's intent.
					await writeManualDisableFlag(workspaceRoot, false);
					log.info("cmd", "enable succeeded — refreshing all panels");
					// ORDER MATTERS:
					//   1. refreshStatusBar flips every store's enabled flag
					//      to true based on bridge.getStatus().  Without this,
					//      PlansStore.refresh() would early-return because its
					//      enabled flag is still false from the prior disable.
					//   2. Then Promise.all pulls fresh data into all stores.
					// Serializing these two phases trades a small amount of
					// latency for correctness.
					const status = await refreshStatusBar(
						bridge,
						memoriesStore,
						plansStore,
						filesStore,
						commitsStore,
						statusBar,
					);
					currentEnabled = status.enabled;
					sidebarProvider.notifyEnabledChanged(status.enabled);
					// Memories is normally lazy-loaded: the initialLoad path and
					// cross-panel watchers gate on `memoriesStore.hasFirstLoaded()`
					// so passive triggers don't fetch listSummaryEntries before
					// the user has opened the panel. Enable is NOT a passive
					// trigger — it's an explicit user gesture that activates the
					// feature as a whole, so we refresh memories eagerly alongside
					// the other panels for consistent UX (otherwise description
					// counts lag and the panel would show a loading state on
					// first open).
					await Promise.all([
						statusStore.refresh(),
						memoriesStore.refresh(),
						plansStore.refresh(),
						filesStore.refresh(true),
						commitsStore.refresh(),
					]);
				}
			},
		),

		vscode.commands.registerCommand(
			"jollimemory.disableJolliMemory",
			async () => {
				log.info("cmd", "disableJolliMemory invoked");
				// Record the opt-out *before* the async uninstall so the user's
				// intent is durable even if Installer.uninstall() throws or fails.
				await writeManualDisableFlag(workspaceRoot, true);
				const result = await bridge.disable();
				if (!result.success) {
					log.error("cmd", "disable failed", { message: result.message });
					vscode.window.showErrorMessage(`Jolli Memory: ${result.message}`);
				} else {
					log.info("cmd", "disable succeeded");
					await statusStore.refresh();
					const status = await refreshStatusBar(
						bridge,
						memoriesStore,
						plansStore,
						filesStore,
						commitsStore,
						statusBar,
					);
					currentEnabled = status.enabled;
					sidebarProvider.notifyEnabledChanged(status.enabled);
				}
			},
		),

		vscode.commands.registerCommand("jollimemory.focusSidebar", () => {
			vscode.commands.executeCommand("jollimemory.mainView.focus");
		}),

		// Files panel
		vscode.commands.registerCommand("jollimemory.refreshFiles", () => {
			filesStore.refresh(true).catch(handleError("refreshFiles"));
			refreshStatusBar(
				bridge,
				memoriesStore,
				plansStore,
				filesStore,
				commitsStore,
				statusBar,
			);
		}),

		vscode.commands.registerCommand("jollimemory.selectAllFiles", () => {
			filesStore.toggleSelectAll();
		}),

		/* v8 ignore start -- command-bus glue: only the registered callback's body is uncovered (selectAllConversationsCommand / selectAllPlansAndNotesCommand have their own unit tests). Driving the registerCommand callback through unit tests needs a real vscode command bus */
		vscode.commands.registerCommand("jollimemory.selectAllConversations", () =>
			selectAllConversationsCommand({
				cwd: workspaceRoot,
				activeSessions: activeSessionsProvider,
				plansProvider,
				onChanged: () => sidebarProvider.refreshConversationsPanel(),
			}),
		),

		vscode.commands.registerCommand("jollimemory.selectAllPlansAndNotes", () =>
			selectAllPlansAndNotesCommand({
				cwd: workspaceRoot,
				activeSessions: activeSessionsProvider,
				plansProvider,
				onChanged: () => sidebarProvider.refreshPlansPanel(),
			}),
		),
		/* v8 ignore stop */

		vscode.commands.registerCommand("jollimemory.commitAI", () => {
			log.info("cmd", "commitAI invoked");
			commitCommand.execute().catch(handleError("commitAI"));
		}),

		// Open file content or diff when clicking a row in the Changes panel
		vscode.commands.registerCommand(
			"jollimemory.openFileChange",
			async (item: FileItem) => {
				const fileUri = vscode.Uri.file(item.fileStatus.absolutePath);
				const { statusCode, relativePath } = item.fileStatus;

				// Untracked or newly added files — just open them (no HEAD version to diff against)
				if (statusCode === "?" || statusCode === "A") {
					await vscode.window.showTextDocument(fileUri);
					return;
				}

				// Deleted files — show the HEAD version read-only
				if (statusCode === "D") {
					await vscode.window.showTextDocument(toGitUri(fileUri, "HEAD"), {
						preview: true,
					});
					return;
				}

				// Renamed files — at HEAD the content lives under the OLD path, so
				// the HEAD side of the diff must use `originalPath`. Using the new
				// path at HEAD reads a nonexistent blob and the editor fails to open.
				// (Copies aren't handled here: `git status --porcelain` never emits a
				// `C` status — copy detection only exists in git's diff path, which
				// the Commits-panel handler uses, not the working-tree `status` call.)
				if (statusCode === "R") {
					const { originalPath } = item.fileStatus;
					if (originalPath === undefined) {
						// Rename without a recorded source path: no reliable HEAD blob
						// to diff against, so just open the working-tree file.
						await vscode.window.showTextDocument(fileUri);
						return;
					}
					const oldFileUri = vscode.Uri.file(join(workspaceRoot, originalPath));
					await vscode.commands.executeCommand(
						"vscode.diff",
						toGitUri(oldFileUri, "HEAD"),
						fileUri,
						`${relativePath} (HEAD ↔ Working Tree)`,
					);
					return;
				}

				// Modified files — always diff against the working tree.
				// Staged vs working-tree content may diverge (edits after staging),
				// so showing the live file is the most useful default.
				const headUri = toGitUri(fileUri, "HEAD");
				await vscode.commands.executeCommand(
					"vscode.diff",
					headUri,
					fileUri,
					`${relativePath} (HEAD ↔ Working Tree)`,
				);
			},
		),

		// Open diff when clicking a file under a commit in the Commits panel
		vscode.commands.registerCommand(
			"jollimemory.openCommitFileChange",
			async (item: CommitFileItem) => {
				const { commitHash, relativePath, statusCode, oldPath } = item;
				const shortRef = commitHash.substring(0, 7);
				const fileUri = vscode.Uri.file(join(workspaceRoot, relativePath));

				// Added files — show the file at this commit (no parent version to diff against)
				if (statusCode === "A") {
					await vscode.window.showTextDocument(toGitUri(fileUri, commitHash), {
						preview: true,
					});
					return;
				}

				// Deleted files — show the file before deletion (parent commit)
				if (statusCode === "D") {
					await vscode.window.showTextDocument(
						toGitUri(fileUri, `${commitHash}~1`),
						{ preview: true },
					);
					return;
				}

				// Renamed files — left side uses old path, right side uses new path
				if (statusCode === "R" && oldPath) {
					const oldFileUri = vscode.Uri.file(join(workspaceRoot, oldPath));
					await vscode.commands.executeCommand(
						"vscode.diff",
						toGitUri(oldFileUri, `${commitHash}~1`),
						toGitUri(fileUri, commitHash),
						`${relativePath} (${shortRef}~1 ↔ ${shortRef})`,
					);
					return;
				}

				// Modified files — diff parent vs commit
				await vscode.commands.executeCommand(
					"vscode.diff",
					toGitUri(fileUri, `${commitHash}~1`),
					toGitUri(fileUri, commitHash),
					`${relativePath} (${shortRef}~1 ↔ ${shortRef})`,
				);
			},
		),

		// Discard changes
		vscode.commands.registerCommand(
			"jollimemory.discardFileChanges",
			async (item: FileItem) => {
				if (!item?.fileStatus) {
					return;
				}
				// Defense in depth: `bridge.discardFiles` dispatches on indexStatus +
				// worktreeStatus. A pre-fix bug routed `branch:discardFile` through
				// here with those columns dropped, causing every file to land in the
				// `git restore --staged --worktree` branch and silently failing for
				// untracked files (pathspec unknown to git) — observable as a stale
				// activity-bar badge. Surface the malformed shape immediately so any
				// future caller that strips the porcelain columns is loud-failed at
				// the boundary, not silently miscategorised inside the bridge.
				//
				// Porcelain v1 columns are always exactly one character (' ' or one
				// of the M/A/D/R/C/?/! status letters); checking length === 1 catches
				// both `undefined` and the empty-string fallback DOM readers fall
				// through to when an attribute is missing.
				if (
					typeof item.fileStatus.indexStatus !== "string" ||
					item.fileStatus.indexStatus.length !== 1 ||
					typeof item.fileStatus.worktreeStatus !== "string" ||
					item.fileStatus.worktreeStatus.length !== 1
				) {
					log.error(
						"cmd",
						`discardFileChanges rejected: fileStatus missing indexStatus / worktreeStatus for ${item.fileStatus.relativePath}`,
					);
					vscode.window.showErrorMessage(
						`Jolli Memory: Cannot discard "${item.fileStatus.relativePath}" — internal error (missing git status columns). Please report this.`,
					);
					return;
				}
				const { relativePath, statusCode } = item.fileStatus;
				const willDelete =
					statusCode === "?" || statusCode === "A" || statusCode === "R";
				const verb = willDelete ? "Delete" : "Discard";
				const detail = willDelete
					? `This will permanently delete "${relativePath}" from disk. This cannot be undone.`
					: `This will discard all changes to "${relativePath}". This cannot be undone.`;
				const choice = await vscode.window.showWarningMessage(
					`${verb} "${relativePath}"?`,
					{ modal: true, detail },
					verb,
				);
				if (choice !== verb) {
					return;
				}
				try {
					await bridge.discardFiles([item.fileStatus]);
					filesStore.deselectPaths([relativePath]);
					await filesStore.refresh(true);
					refreshStatusBar(
						bridge,
						memoriesStore,
						plansStore,
						filesStore,
						commitsStore,
						statusBar,
					);
				} catch (err: unknown) {
					/* v8 ignore start -- defensive: VSCode API and provider helpers reject with Error; retained for unexpected non-Error throws */
					const message = err instanceof Error ? err.message : String(err);
					/* v8 ignore stop */
					log.error(
						"cmd",
						`discardFileChanges failed for ${relativePath}: ${message}`,
					);
					vscode.window.showErrorMessage(
						`Jolli Memory: Failed to discard "${relativePath}": ${message}`,
					);
					// Refresh anyway — partial success possible (e.g. staged restore succeeded, disk delete failed)
					await filesStore.refresh(true);
				}
			},
		),

		vscode.commands.registerCommand(
			"jollimemory.discardSelectedChanges",
			async () => {
				const selectedFiles = filesStore.getSnapshot().selectedFiles;
				if (selectedFiles.length === 0) {
					vscode.window.showInformationMessage(
						"Jolli Memory: No files selected to discard.",
					);
					return;
				}
				const count = selectedFiles.length;
				const deletedFiles = selectedFiles.filter(
					(f) =>
						f.statusCode === "?" ||
						f.statusCode === "A" ||
						f.statusCode === "R",
				);
				const maxPreview = 10;
				const fileList = selectedFiles
					.slice(0, maxPreview)
					.map((f) => f.relativePath)
					.join("\n");
				const overflow =
					count > maxPreview ? `\n...and ${count - maxPreview} more` : "";
				const deleteWarning =
					deletedFiles.length > 0
						? `\n\n⚠ ${deletedFiles.length} file${deletedFiles.length !== 1 ? "s" : ""} will be permanently deleted from disk (new/untracked/renamed).`
						: "";
				const detail = `${fileList}${overflow}${deleteWarning}\n\nThis cannot be undone.`;
				const choice = await vscode.window.showWarningMessage(
					`Discard changes to ${count} selected file${count !== 1 ? "s" : ""}?`,
					{ modal: true, detail },
					"Discard All",
				);
				if (choice !== "Discard All") {
					return;
				}
				try {
					await bridge.discardFiles(selectedFiles);
					await filesStore.refresh(true);
					refreshStatusBar(
						bridge,
						memoriesStore,
						plansStore,
						filesStore,
						commitsStore,
						statusBar,
					);
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : String(err);
					log.error("cmd", `discardSelectedChanges failed: ${message}`);
					vscode.window.showErrorMessage(
						`Jolli Memory: Failed to discard selected changes: ${message}`,
					);
					// Refresh anyway — some files may have been discarded before the error
					await filesStore.refresh(true);
				}
			},
		),

		// Plans panel
		vscode.commands.registerCommand("jollimemory.refreshPlans", () => {
			plansStore.refresh().catch(handleError("refreshPlans"));
		}),

		vscode.commands.registerCommand(
			"jollimemory.editPlan",
			async (
				itemOrSlug: PlanItem | string,
				committedFlag?: boolean,
				titleHint?: string,
				// Foreign-provenance hint forwarded by SummaryWebviewPanel's
				// `previewPlan` dispatch. Non-null only when the source panel
				// itself is foreign — in that case we resolve the foreign
				// repo's FolderStorage so the rendered preview reads the
				// right plan body.
				foreignRepoName?: string | null,
				foreignRepoUrl?: string | null,
			) => {
				let slug: string;
				let committed: boolean;
				let planTitle: string;
				if (typeof itemOrSlug === "string") {
					slug = itemOrSlug;
					committed = committedFlag ?? false;
					planTitle = titleHint ?? slug;
				} else {
					slug = itemOrSlug.plan.slug;
					committed = !!itemOrSlug.plan.commitHash;
					planTitle = itemOrSlug.plan.title;
				}
				log.info("cmd", `editPlan invoked: ${slug} (committed=${committed})`);

				if (committed) {
					// Open rendered markdown preview (read-only). Foreign
					// panels supply repoName/url so we resolve the foreign
					// FolderStorage; local panels pass nulls and the preview
					// falls back to workspace-default storage.
					const readStorageResult = foreignRepoName
						? await bridge.createStorageForRepo(
								foreignRepoName,
								foreignRepoUrl ?? null,
							)
						: null;
					await showPlanPreview(
						slug,
						planTitle,
						readStorageResult?.storage,
					);
				} else {
					// Resolve filePath via the registry. PlanItem (tree click) carries
					// it directly; tooltip invocations pass only the slug, in which
					// case we fall back to bridge.listPlans(). No filePath at this
					// point means the registry is out of sync with the panel state —
					// surface that explicitly rather than silently opening a stale
					// ~/.claude/plans/<slug>.md that almost certainly does not exist.
					let filePath: string | undefined;
					if (typeof itemOrSlug !== "string") {
						filePath = itemOrSlug.plan.filePath;
					}
					if (!filePath) {
						const plans = await bridge.listPlans();
						filePath = plans.find((p) => p.slug === slug)?.filePath;
					}
					if (!filePath) {
						log.warn(
							"cmd",
							`editPlan: no filePath for slug ${slug} — registry may be stale`,
						);
						vscode.window.showWarningMessage(
							`Plan "${slug}" not found — refresh the PLANS panel and try again.`,
						);
						return;
					}
					// Mirror the existsSync guard in openPlanForPreview. Without it,
					// a stale registry entry whose underlying file has been deleted
					// fires openTextDocument → VSCode throws FileNotFound → command
					// handler swallows it → user clicks but nothing happens.
					if (!existsSync(filePath)) {
						log.warn(
							"cmd",
							`editPlan: file missing on disk for ${slug}: ${filePath}`,
						);
						vscode.window.showWarningMessage(
							`Plan "${slug}" file not found on disk: ${filePath}`,
						);
						return;
					}
					const doc = await vscode.workspace.openTextDocument(filePath);
					await vscode.window.showTextDocument(doc);
				}
			},
		),

		vscode.commands.registerCommand(
			"jollimemory.removePlan",
			async (itemOrSlug: PlanItem | string) => {
				const slug =
					typeof itemOrSlug === "string" ? itemOrSlug : itemOrSlug.plan.slug;
				log.info("cmd", `removePlan invoked: ${slug}`);
				await bridge.removePlan(slug);
				await plansStore.refresh();
			},
		),

		// Add commands — individual entries shown in the "+" dropdown submenu
		vscode.commands.registerCommand("jollimemory.addPlan", async () => {
			const currentPlans = await bridge.listPlans();
			const excludeSlugs = new Set(currentPlans.map((p) => p.slug));
			const available = listAvailablePlans(excludeSlugs);
			if (available.length === 0) {
				vscode.window.showInformationMessage(
					"No additional plans found in ~/.claude/plans/",
				);
				return;
			}
			const items = available.map((p) => ({
				label: p.title,
				description:
					p.mtimeMs > 0
						? formatShortRelativeDate(new Date(p.mtimeMs).toISOString())
						: "",
				slug: p.slug,
			}));
			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: "Select a plan to add",
			});
			if (!selected) {
				return;
			}
			await addPlanToRegistry(selected.slug, workspaceRoot);
			await plansStore.refresh();
			log.info("cmd", `addPlan: added ${selected.slug}`);
		}),

		vscode.commands.registerCommand("jollimemory.addMarkdownNote", async () => {
			await addMarkdownNote(bridge, plansStore);
		}),

		vscode.commands.registerCommand("jollimemory.addTextSnippet", () => {
			NoteEditorWebviewPanel.show(context.extensionUri, bridge, () =>
				plansStore.refresh(),
			);
		}),

		vscode.commands.registerCommand(
			"jollimemory.previewNote",
			async (
				id: string,
				title: string,
				// Same foreign-provenance hint as `jollimemory.editPlan`'s
				// committed branch above — supplied by the foreign panel so
				// the rendered note preview reads from the foreign
				// FolderStorage instead of the current workspace's storage.
				foreignRepoName?: string | null,
				foreignRepoUrl?: string | null,
			) => {
				const readStorageResult = foreignRepoName
					? await bridge.createStorageForRepo(
							foreignRepoName,
							foreignRepoUrl ?? null,
						)
					: null;
				await showNotePreview(id, title, readStorageResult?.storage);
			},
		),

		vscode.commands.registerCommand(
			"jollimemory.editNote",
			async (itemOrId: NoteItem | string) => {
				const noteId =
					typeof itemOrId === "string" ? itemOrId : itemOrId.note.id;
				const notes = await bridge.listNotes();
				const note = notes.find((n) => n.id === noteId);
				if (!note) {
					return;
				}

				// All notes are now file-backed — open in editor
				if (note.filePath) {
					const doc = await vscode.workspace.openTextDocument(note.filePath);
					await vscode.window.showTextDocument(doc);
				} else if (note.commitHash) {
					// Committed note without local file — show info
					vscode.window.showInformationMessage(
						`Note "${note.title}" is committed and read-only.`,
					);
				}
				log.info("cmd", `editNote: ${noteId}`);
			},
		),

		// ── Sidebar row-click preview commands ──────────────────────────────────
		// These differ from `editPlan` / `editNote` (used by the row's ✎ inline
		// button) which open the source file in an editor. They also differ
		// from `previewNote` (used by Summary panel) which only reads from the
		// orphan branch — a "snapshot at commit time" semantic. Sidebar wants
		// "current state" instead: prefer the local file (latest draft); fall
		// back to the orphan branch when only a committed copy exists.
		vscode.commands.registerCommand(
			"jollimemory.openPlanForPreview",
			async (slug: string) => {
				log.info("cmd", `openPlanForPreview: ${slug}`);
				// Look up plan info to know whether a committed snapshot exists.
				// PlansStore already holds the latest snapshot; no need to ask
				// the bridge. We prefer the registry's filePath so external paths
				// (e.g. docs/foo.md, E:\jm-docs\bar.md) render the on-disk file
				// rather than a missing ~/.claude/plans/<slug>.md.
				const snap = plansStore.getSnapshot();
				const plan = snap.merged.find(
					(e) => e.kind === "plan" && e.plan.slug === slug,
				);
				const planTitle = plan && plan.kind === "plan" ? plan.plan.title : slug;
				const localPath =
					plan && plan.kind === "plan" && plan.plan.filePath
						? plan.plan.filePath
						: undefined;
				if (localPath && existsSync(localPath)) {
					await vscode.commands.executeCommand(
						"markdown.showPreview",
						vscode.Uri.file(localPath),
					);
					return;
				}
				// No local file → fall back to the orphan-branch snapshot.
				await showPlanPreview(slug, planTitle);
			},
		),

		vscode.commands.registerCommand(
			"jollimemory.openNoteForPreview",
			async (noteId: string) => {
				log.info("cmd", `openNoteForPreview: ${noteId}`);
				const notes = await bridge.listNotes();
				const note = notes.find((n) => n.id === noteId);
				if (!note) {
					return;
				}
				if (note.filePath && existsSync(note.filePath)) {
					// Markdown notes preview natively; snippets (plain text in a
					// .md or other extension) render as plain text inside the
					// markdown preview, which is acceptable for read-only viewing.
					await vscode.commands.executeCommand(
						"markdown.showPreview",
						vscode.Uri.file(note.filePath),
					);
					return;
				}
				if (note.commitHash) {
					// Local file gone but a committed snapshot exists — read the
					// orphan-branch copy. Reuses the Summary-side preview helper.
					await showNotePreview(noteId, note.title);
					return;
				}
				vscode.window.showInformationMessage(
					`Note "${note.title}" has no readable content.`,
				);
			},
		),

		vscode.commands.registerCommand(
			"jollimemory.removeNote",
			async (itemOrId: NoteItem | string) => {
				const noteId =
					typeof itemOrId === "string" ? itemOrId : itemOrId.note.id;
				log.info("cmd", `removeNote invoked: ${noteId}`);
				await bridge.removeNote(noteId);
				await plansStore.refresh();
			},
		),

		// ── Multi-source reference commands ─────────────────────────────────────
		// All three accept either a ReferenceItem (from native tree) or a bare
		// mapKey string (from webview). The mapKey is "<source>:<nativeId>"
		// pre-archive or "<source>:<nativeId>-<shortHash>" post-archive. The
		// webview-originated mapKey is resolved through `resolveReferenceForCommand`
		// above so a stale cache hit becomes a warning toast, not a silent no-op.

		/* v8 ignore start -- reference command-bus glue: each registerCommand callback resolves a stale-mapKey-safe info and delegates to a bridge method that has its own unit tests. Exercising the registerCommand wrappers themselves needs a real vscode command bus */
		vscode.commands.registerCommand(
			"jollimemory.openReferenceInBrowser",
			async (itemOrKey: ReferenceItem | string) => {
				const mapKey =
					typeof itemOrKey === "string" ? itemOrKey : itemOrKey.reference.mapKey;
				log.info("cmd", `openReferenceInBrowser: ${mapKey}`);
				const info = await resolveReferenceForCommand(
					mapKey,
					"openReferenceInBrowser",
				);
				if (info) await bridge.openReferenceInBrowser(info);
			},
		),

		vscode.commands.registerCommand(
			"jollimemory.openReferenceMarkdown",
			async (itemOrKey: ReferenceItem | string) => {
				const mapKey =
					typeof itemOrKey === "string" ? itemOrKey : itemOrKey.reference.mapKey;
				log.info("cmd", `openReferenceMarkdown: ${mapKey}`);
				const info = await resolveReferenceForCommand(
					mapKey,
					"openReferenceMarkdown",
				);
				if (info) await bridge.openReferenceMarkdown(info);
			},
		),

		vscode.commands.registerCommand(
			"jollimemory.ignoreReference",
			async (itemOrKey: ReferenceItem | string) => {
				const mapKey =
					typeof itemOrKey === "string" ? itemOrKey : itemOrKey.reference.mapKey;
				log.info("cmd", `ignoreReference: ${mapKey}`);
				// Same stale-mapKey guard as the open commands: without this the
				// ReferenceService.removeReference "entry not found → silent return"
				// path would swallow the click with zero feedback.
				const info = await resolveReferenceForCommand(mapKey, "ignoreReference");
				if (!info) return;
				await bridge.removeReference(mapKey);
				await plansStore.refresh();
			},
		),
		/* v8 ignore stop */

		// History panel
		vscode.commands.registerCommand("jollimemory.refreshHistory", () => {
			commitsStore.refresh().catch(handleError("refreshHistory"));
		}),

		vscode.commands.registerCommand("jollimemory.selectAllCommits", () => {
			commitsStore.toggleSelectAll();
		}),

		vscode.commands.registerCommand("jollimemory.squash", () => {
			log.info("cmd", "squash invoked");
			squashCommand.execute().catch(handleError("squash"));
		}),

		vscode.commands.registerCommand("jollimemory.pushBranch", () => {
			log.info("cmd", "pushBranch invoked");
			pushCommand.execute().catch(handleError("pushBranch"));
		}),

		// Opens the Commit Memory in the "commit" panel slot — fired from the
		// Commits/history tree (CommitItem) and its tooltip command link.
		// Behaviour is unchanged from before the memory/commit split.
		//
		// No-summary case is intentionally silent: COMMITS rows for unsummarized
		// commits already render a `codicon-code` glyph (vs the tinted markdown
		// glyph for memory rows), so the absence is visible in the UI itself; an
		// extra information toast on every click was redundant noise. The same
		// "guard early, return silently" shape is used by openMemoryFile below
		// for empty paths. Sibling paths keep their notification on purpose:
		//   - viewMemorySummary (next handler) — surfacing reaches a real
		//     inconsistency (Memories list claimed a summary that's missing).
		//   - URI handler (further down) — external deep links to non-existent
		//     summaries are worth telling the user about.
		vscode.commands.registerCommand(
			"jollimemory.viewSummary",
			async (item: CommitItem | string) => {
				const hash = typeof item === "string" ? item : item.commit.hash;
				const summary = await bridge.getSummary(hash);
				if (!summary) return;
				// Local commits also read from the Memory Bank folder layer so
				// the detail-panel data path is uniform with foreign-repo
				// panels (and with the user-visible KB tree). Falls back to
				// null when the workspace has no KB folder yet — panel then
				// uses bridge-default reads.
				const readStorageResult =
					await bridge.createReadStorageForCurrentRepo();
				await SummaryWebviewPanel.show(
					summary,
					context.extensionUri,
					workspaceRoot,
					bridge,
					commitsStore.getMainBranch(),
					"commit",
					null,
					null,
					readStorageResult?.storage ?? null,
				);
			},
		),

		// Opens the Commit Memory in the "memory" panel slot — fired from the
		// Memories tree (MemoryItem) and its tooltip command link. The memory
		// slot is independent from the commit slot, so opening one never
		// disposes the other.
		vscode.commands.registerCommand(
			"jollimemory.viewMemorySummary",
			async (item: MemoryItem | string) => {
				const hash = typeof item === "string" ? item : item.entry.commitHash;
				const shortHash = hash.substring(0, 7);
				// Timeline view aggregates memories across every repo under the
				// Memory Bank parent (see JolliMemoryBridge.listSummaryEntries),
				// so a clicked row may belong to a non-current repo whose
				// summary lives in that repo's FolderStorage rather than the
				// current workspace's primary storage. getSummaryAnyRepoWith-
				// Source walks the same discovery list as the Timeline's data
				// fetch AND tells us which repo the summary came from — the
				// panel needs the provenance so it can disable destructive
				// actions (push/edit) when the summary is from a foreign repo,
				// since those handlers all write to `workspaceRoot`'s git/
				// orphan branch and would silently corrupt the wrong project.
				const { summary, sourceRepoName, sourceRemoteUrl } =
					await bridge.getSummaryAnyRepoWithSource(hash);
				if (!summary) {
					vscode.window.showInformationMessage(
						`Jolli Memory: No summary found for commit ${shortHash}.`,
					);
					return;
				}
				// Foreign hit → use the foreign FolderStorage; local hit →
				// fall back to the current workspace's FolderStorage. Either
				// way the panel reads transcripts/plans/notes from the
				// Memory Bank folder layer, not the dual-write primary.
				const readStorageResult = sourceRepoName
					? await bridge.createStorageForRepo(
							sourceRepoName,
							sourceRemoteUrl,
						)
					: await bridge.createReadStorageForCurrentRepo();
				await SummaryWebviewPanel.show(
					summary,
					context.extensionUri,
					workspaceRoot,
					bridge,
					commitsStore.getMainBranch(),
					"memory",
					sourceRepoName,
					sourceRemoteUrl,
					readStorageResult?.storage ?? null,
				);
			},
		),

		// Opens an arbitrary kbRoot-relative file in the editor, dispatched from the
		// sidebar's KB folder tree. Markdown files whose frontmatter identifies a
		// commit summary (`type: commit` + `commitHash:`) open in the rich KB
		// SummaryWebviewPanel — same UI as the Memories tab gets — so users keep
		// access to push, copy-as-recall-prompt, and the structured commit view.
		// Plain markdown (plans, notes, user-dropped files) falls back to the
		// built-in Markdown preview; non-`.md` files delegate to `vscode.open`.
		// Non-string / empty paths are ignored so the sidebar can post bad
		// payloads safely.
		vscode.commands.registerCommand(
			"jollimemory.openMemoryFile",
			async (absPath: string) => {
				if (typeof absPath !== "string" || absPath.length === 0) return;
				const uri = vscode.Uri.file(absPath);
				if (!absPath.toLowerCase().endsWith(".md")) {
					await vscode.commands.executeCommand("vscode.open", uri);
					return;
				}
				const meta = parseSummaryFrontmatter(absPath);
				if (meta) {
					// On-disk divergence gate: when the user has edited the
					// Markdown copy by hand, the JSON-derived SummaryWebviewPanel
					// view would silently disagree with what's on disk. Show a
					// one-shot info message offering revert, then fall through
					// to a plain markdown preview so the user sees their actual
					// edits instead of the stale system view.
					if (await bridge.isMemoryFileDivergedOnDisk(absPath)) {
						if (!divergenceMessageShown.has(absPath)) {
							divergenceMessageShown.add(absPath);
							const choice = await vscode.window.showInformationMessage(
								"This memory file has on-disk edits. System view is unavailable until reverted.",
								"Revert",
								"Dismiss",
							);
							if (choice === "Revert") {
								await vscode.commands.executeCommand(
									"jollimemory.revertMemoryFileEdits",
									absPath,
								);
								return;
							}
						}
						await vscode.commands.executeCommand(
							"markdown.showPreview",
							uri,
						);
						return;
					}

					// Memory Bank folder view shows every repo under the parent
					// (`localFolder`), so a clicked summary .md may belong to a
					// non-current repo. Use the provenance-bearing cross-repo
					// lookup so the rich SummaryWebviewPanel renders for
					// foreign-repo memories AND learns which repo the summary
					// came from. Without `sourceRepoName`, the panel would
					// allow destructive commands (push / edit / createPr) that
					// write to `workspaceRoot`'s git / orphan branch — silently
					// pushing a foreign repo's memory to the *current* repo's
					// Jolli Memory space, corrupting the wrong project.
					const { summary, sourceRepoName, sourceRemoteUrl } =
						await bridge.getSummaryAnyRepoWithSource(meta.commitHash);
					if (summary) {
						const readStorageResult = sourceRepoName
							? await bridge.createStorageForRepo(
									sourceRepoName,
									sourceRemoteUrl,
								)
							: await bridge.createReadStorageForCurrentRepo();
						await SummaryWebviewPanel.show(
							summary,
							context.extensionUri,
							workspaceRoot,
							bridge,
							commitsStore.getMainBranch(),
							"kb",
							sourceRepoName,
							sourceRemoteUrl,
							readStorageResult?.storage ?? null,
						);
						return;
					}
					// Frontmatter looked like a summary but the bridge couldn't
					// load it — fall through to markdown preview rather than
					// silently failing.
					log.warn(
						"cmd",
						`openMemoryFile: frontmatter for ${absPath} references commit ${meta.commitHash} but no summary found; falling back to markdown preview`,
					);
				}
				await vscode.commands.executeCommand("markdown.showPreview", uri);
			},
		),

		// Memory Bank `.md` edit-protection revert command. Restores the
		// visible Markdown copy from the hidden JSON source (orphan-branch-
		// derived) so the badge clears and the rich SummaryWebviewPanel /
		// plan / note preview comes back. Dispatched from:
		// 1. The "[Revert]" button on the on-disk-divergence info message
		//    surfaced by `openMemoryFile`.
		// 2. The right-click "Revert Edits to System Version" explorer menu
		//    (declared in package.json contributes.menus.explorer/context),
		//    which is gated only on the `.md` filename — the handler has to
		//    silently no-op when invoked on a non-Memory-Bank `.md` so the
		//    menu's broader gate doesn't produce noisy toasts on every
		//    misclick. Real failure modes (no branch / unrecognized entry
		//    type) still surface a warning.
		//
		// First arg is either:
		//   - a string absolute path (programmatic callers, [Revert] button,
		//     `jollimemory.revertMemoryFileByRelPath` wrapper);
		//   - a `vscode.Uri` (explorer/context menus always pass a Uri, not
		//     a string — see https://code.visualstudio.com/api/references/contribution-points#contributes.menus).
		// `instanceof vscode.Uri` is not portable across the test mock
		// (mocked as a plain object factory, not a class), so this duck-
		// types on `.fsPath` + `.scheme === "file"`. Non-file schemes
		// (virtual / remote) are rejected — a Memory Bank file always lives
		// on the local filesystem.
		vscode.commands.registerCommand(
			"jollimemory.revertMemoryFileEdits",
			async (arg: unknown) => {
				let absPath: string | undefined;
				if (typeof arg === "string") {
					if (arg.length > 0) absPath = arg;
				} else if (typeof arg === "object" && arg !== null && "fsPath" in arg && "scheme" in arg) {
					const uri = arg as { fsPath: unknown; scheme: unknown };
					if (uri.scheme === "file" && typeof uri.fsPath === "string" && uri.fsPath.length > 0) {
						absPath = uri.fsPath;
					}
				}
				if (!absPath) return;
				const resolved = await bridge.resolveMemoryFile(absPath);
				if (!resolved) return;
				const { folderStorage, manifestEntry } = resolved;
				// Outcome is normalised to FolderStorage's discriminated
				// `ForceRegenerateResult` so the failure branch below can
				// give the user a recovery hint matched to the actual
				// failure mode. Plan/note still return a plain boolean (no
				// equivalent malformed/unlink-failed split yet) so the
				// wrapper here promotes their false to `reason: "missing"`
				// — preserving today's user-facing message for those types
				// without claiming richer information than they actually
				// report.
				let result: ForceRegenerateResult;
				if (manifestEntry.type === "commit") {
					const branch = resolveBranch(folderStorage, manifestEntry);
					if (!branch) {
						vscode.window.showWarningMessage(
							`Memory Bank: cannot revert ${absPath} — manifest entry has no recorded branch and the path's folder is not a known branch mapping.`,
						);
						return;
					}
					// `forceRegenerateVisibleMarkdown` reads its title/body/date
					// fields from the hidden `summaries/<hash>.json`, not from
					// the entry we pass in (see FolderStorage.regenerateVisibleMarkdown).
					// `commitDate` / `generatedAt` on the entry are de-facto dead args
					// — but `?? ""` would fabricate a misleading "manifest is complete"
					// signal for future readers and silently mask manifest gaps.
					// Refuse instead, symmetric with plan/note.
					const generatedAt = manifestEntry.source?.generatedAt;
					if (!generatedAt) {
						vscode.window.showWarningMessage(
							`Memory Bank: cannot revert ${absPath} — manifest entry is missing source.generatedAt (manifest row is incomplete).`,
						);
						return;
					}
					result = await folderStorage.forceRegenerateVisibleMarkdown({
						commitHash: manifestEntry.fileId,
						commitMessage: manifestEntry.title ?? manifestEntry.fileId,
						commitDate: generatedAt,
						branch,
						generatedAt,
						parentCommitHash: null,
					});
				} else if (manifestEntry.type === "plan") {
					const slug = manifestEntry.fileId.replace(/^plan:/, "");
					const branch = resolveBranch(folderStorage, manifestEntry);
					if (!branch) {
						vscode.window.showWarningMessage(
							`Memory Bank: cannot revert ${absPath} — manifest entry has no recorded branch and the path's folder is not a known branch mapping.`,
						);
						return;
					}
					const ok = await folderStorage.regenerateVisiblePlan(slug, branch);
					result = ok ? { ok: true } : { ok: false, reason: "missing" };
				} else if (manifestEntry.type === "note") {
					const id = manifestEntry.fileId.replace(/^note:/, "");
					const branch = resolveBranch(folderStorage, manifestEntry);
					if (!branch) {
						vscode.window.showWarningMessage(
							`Memory Bank: cannot revert ${absPath} — manifest entry has no recorded branch and the path's folder is not a known branch mapping.`,
						);
						return;
					}
					const ok = await folderStorage.regenerateVisibleNote(id, branch);
					result = ok ? { ok: true } : { ok: false, reason: "missing" };
				} else {
					// Unknown manifest entry type — surface a distinct warning
					// instead of falling through to the misleading
					// "hidden source missing" branch below. Possible if a
					// future schema bump adds a new entry type and an older
					// extension build reads it before being upgraded.
					vscode.window.showWarningMessage(
						`Memory Bank: cannot revert ${absPath} — unrecognized manifest entry type '${manifestEntry.type}'.`,
					);
					return;
				}
				if (result.ok) {
					// Successful revert clears the "we already showed the
					// divergence info-message for this path" guard so the
					// next divergence on the same path can re-prompt. Also
					// prevents the Set from growing unbounded over a long
					// extension-host lifetime.
					divergenceMessageShown.delete(absPath);
					memoryFileDecorationProvider.refreshUri(
						vscode.Uri.file(absPath),
					);
					// Clear the KB folders tree's cached `isDiverged` for
					// this one path so the ✎ marker disappears without a
					// manual refresh. The decoration-provider refresh above
					// only covers VS Code's native file UIs; the
					// webview-rendered KB tree reads divergence from the
					// cached FolderNode and needs its own signal.
					//
					// A content revert touches one file's bytes, not the
					// tree's shape — so we send the targeted `kb:clearDiverged`
					// (single-row flag flip) rather than the heavyweight
					// `refreshKnowledgeBaseFolders` reset, which wipes the
					// client's folderCache and collapses every expanded branch
					// directory the user had open. relPath is absPath made
					// relative to the same kbParent `resolveKbAbs` joins from,
					// normalized to the forward-slash form the client keys
					// folderCache on; a non-Memory-Bank path no-ops client-side.
					sidebarProvider.clearKnowledgeBaseFolderDivergence(
						toForwardSlash(relative(sidebarKbParent, absPath)),
					);
					vscode.window.showInformationMessage(
						`Reverted to system version: ${absPath}`,
					);
				} else {
					vscode.window.showWarningMessage(
						`Memory Bank: revert failed for ${absPath} — ${revertFailureHint(result.reason)}.`,
					);
				}
			},
		),

		// Webview-facing variant of revertMemoryFileEdits. The Memory Bank
		// sidebar's right-click menu only knows kbRoot-relative paths
		// (FolderNode.relPath → data-path attribute), so we resolve here
		// using the same `join(sidebarKbParent, relPath)` expression
		// `resolveKbAbs` uses (line 851) — keeping the wrapper aligned with
		// config-change re-binds of sidebarKbParent. Bad input is dropped
		// silently, matching the abs-path command's defensive guard above.
		vscode.commands.registerCommand(
			"jollimemory.revertMemoryFileByRelPath",
			async (relPath: unknown) => {
				if (typeof relPath !== "string" || relPath.length === 0) return;
				const abs = join(sidebarKbParent, relPath);
				await vscode.commands.executeCommand(
					"jollimemory.revertMemoryFileEdits",
					abs,
				);
			},
		),

		// Accepts either a CommitItem or a plain hash string (from tooltip command link).
		vscode.commands.registerCommand(
			"jollimemory.copyCommitHash",
			(item: CommitItem | string) => {
				const hash = typeof item === "string" ? item : item.commit.hash;
				const shortHash =
					typeof item === "string"
						? item.substring(0, 7)
						: item.commit.shortHash;
				vscode.env.clipboard.writeText(hash).then(() => {
					vscode.window.showInformationMessage(
						`Jolli Memory: Copied ${shortHash} to clipboard.`,
					);
				});
			},
		),

		// ── Memories panel commands ──────────────────────────────────────────

		vscode.commands.registerCommand("jollimemory.refreshMemories", () => {
			// Explicit user-initiated refresh: drop the aggregated cross-repo
			// cache so a fresh discovery pass runs. Without this, writes made by
			// other IDE windows to neighbour repos under the same Memory Bank
			// parent (which don't move this workspace's orphan ref and don't
			// touch its lock file) only show up after a window reload.
			//
			// Also re-probe the read-storage fallback: a dual-write session
			// that initially fell back to OrphanBranchStorage because the
			// Memory Bank folder lacked `index.json` would otherwise keep
			// serving that cached instance forever once peer-sync repopulates
			// the folder.
			bridge.invalidateEntriesCache();
			bridge.reloadReadStorage();
			memoriesStore.refresh().catch(handleError("refreshMemories"));
		}),

		vscode.commands.registerCommand(
			"jollimemory.searchMemories",
			async (query?: unknown) => {
				const filter = typeof query === "string" ? query : "";
				await memoriesStore.setFilter(filter);
			},
		),

		vscode.commands.registerCommand("jollimemory.clearMemoryFilter", () => {
			memoriesStore.setFilter("").catch(handleError("clearMemoryFilter"));
		}),

		vscode.commands.registerCommand("jollimemory.loadMoreMemories", () => {
			memoriesStore.loadMore().catch(handleError("loadMoreMemories"));
		}),

		// Copy recall prompt to clipboard — accepts MemoryItem or plain hash string.
		// MemoryItem rows can come from any discovered repo (Memories tab is
		// cross-repo aggregated), so the detail-fetch walks the same discovery
		// list as listSummaryEntries — same reason viewMemorySummary above
		// uses getSummaryAnyRepo.
		vscode.commands.registerCommand(
			"jollimemory.copyRecallPrompt",
			async (item: MemoryItem | string) => {
				const hash = typeof item === "string" ? item : item.entry.commitHash;
				const summary = await bridge.getSummaryAnyRepo(hash);
				if (!summary) {
					vscode.window.showWarningMessage("No summary found for this commit.");
					return;
				}
				const context = buildClaudeCodeContext(summary);
				await vscode.env.clipboard.writeText(context);
				vscode.window.showInformationMessage(
					"Recall prompt copied \u2014 paste it into Claude Code.",
				);
			},
		),

		// Open in Claude Code via URI scheme. Same cross-repo reasoning as
		// copyRecallPrompt above — MemoryItem rows may belong to a non-current
		// repo discovered under the Memory Bank parent.
		vscode.commands.registerCommand(
			"jollimemory.openInClaudeCode",
			async (item: MemoryItem | string) => {
				const hash = typeof item === "string" ? item : item.entry.commitHash;
				const summary = await bridge.getSummaryAnyRepo(hash);
				if (!summary) {
					vscode.window.showWarningMessage("No summary found for this commit.");
					return;
				}
				const ctx = buildClaudeCodeContext(summary);
				const encoded = encodeURIComponent(ctx);
				const uri = vscode.Uri.parse(
					`vscode://anthropic.claude-code/open?prompt=${encoded}`,
				);
				await vscode.env.openExternal(uri);
			},
		),

		// Settings — accessible via the gear icon in the STATUS panel title bar.
		vscode.commands.registerCommand("jollimemory.openSettings", () => {
			log.info("cmd", "openSettings invoked");
			SettingsWebviewPanel.show(
				context.extensionUri,
				workspaceRoot,
				async () => {
					// Strict ordering fixes a pre-existing race: previously the exclude
					// filter was loaded in parallel with filesStore.refresh(), so
					// getChildren could run against the stale pattern set until load
					// completed.  Now: (1) load patterns, (2) recompute visible set
					// without re-querying git, (3) refresh the status panel.  We call
					// applyExcludeFilterChange() rather than refresh() to avoid an
					// unnecessary bridge.listFiles() roundtrip.
					try {
						await excludeFilter.load();
						filesStore.applyExcludeFilterChange();
						// storageMode / localFolder may have changed — recreate the
						// bridge's storage backend so subsequent reads (sidebar
						// memories, summary panels) hit the new mode/path without
						// requiring a window reload.
						bridge.reloadStorage();
						await statusStore.refresh();
						// Re-resolve the sidebar's KB root in case the user changed
						// "Local Folder". When it moves, drop the cached folder tree
						// so the next listing reads from the new path.
						const moved = await refreshSidebarKbRoot();
						if (moved) sidebarProvider.refreshKnowledgeBaseFolders();
						// If the user just turned auto-sync ON, start the polling
						// loop without requiring a Reload Window (plan §P2 fix).
						// `reconcileAutoSync` is idempotent — repeated calls after
						// the first start are no-ops.
						const activation = await syncActivation;
						await activation?.runtime.reconcileAutoSync().catch((e) => {
							/* v8 ignore start -- defensive log-and-continue: reconcileAutoSync handles its own errors internally; this catch only fires for unforeseen runtime exceptions (e.g. vscode API surface change), which the test fixture can't reproduce */
							log.warn(
								"reconcileAutoSync after settings save failed: %s",
								(e as Error).message,
							);
							/* v8 ignore stop */
						});
					} catch (err) {
						handleError("openSettings.save")(err as Error);
					}
				},
				authService,
			);
		}),

		// Inline onboarding API key save — wired from the sidebar's apikey-panel
		// (the user clicks "Configure API Key" → types a key → Save). Touches
		// only the apiKey field so we don't silently overwrite hooks /
		// integrations / exclude patterns the user may have configured by other
		// means. Successful save flips configured=true via statusStore.refresh,
		// which retires the apikey-panel through the existing
		// configured:changed plumbing — no explicit success ack needed here.
		// On failure we surface the message inline through
		// notifyApiKeySaveError so the user sees it without leaving the panel.
		//
		// Also writes `aiProvider: "anthropic"` because clicking the onboarding
		// "Configure Anthropic API key" button is the user's explicit choice of
		// provider — symmetric with the `aiProvider: "jolli"` write that
		// `saveAuthCredentials` does on Jolli sign-in. Without this, a user who
		// later signs in to Jolli (even briefly) and signs out would see the
		// dispatcher revert to Jolli-precedence on next config reload.
		vscode.commands.registerCommand(
			"jollimemory.saveAnthropicApiKey",
			async (rawKey: unknown) => {
				log.info("cmd", "saveAnthropicApiKey invoked");
				const key = typeof rawKey === "string" ? rawKey.trim() : "";
				if (key.length === 0) {
					sidebarProvider.notifyApiKeySaveError("API key cannot be empty.");
					return;
				}
				try {
					await saveConfigScoped(
						{ apiKey: key, aiProvider: "anthropic" },
						getGlobalConfigDir(),
					);
					await statusStore.refresh();
				} catch (err) {
					const message =
						err instanceof Error ? err.message : "Failed to save the API key.";
					log.error("cmd", `saveAnthropicApiKey failed: ${message}`);
					sidebarProvider.notifyApiKeySaveError(message);
				}
			},
		),

		// Auth — sign in / sign out via browser-based OAuth flow.
		vscode.commands.registerCommand("jollimemory.signIn", async () => {
			log.info("cmd", "signIn invoked");
			await authService.openSignInPage();
		}),

		vscode.commands.registerCommand("jollimemory.signOut", async () => {
			log.info("cmd", "signOut invoked");
			const choice = await vscode.window.showWarningMessage(
				"Sign out of Jolli?",
				{
					modal: true,
					detail:
						"This clears your local Jolli credentials and API key. You'll need to sign in again through your browser to push memories.",
				},
				"Sign Out",
			);
			if (choice !== "Sign Out") {
				log.info("cmd", "signOut cancelled by user");
				return;
			}
			await authService.signOut();
			currentAuthenticated = false;
			// Stop any active auto-sync polling loop now that credentials are
			// gone. `clearAuthCredentials` leaves `autoSyncEnabled` intact (so the
			// preference auto-resumes on next sign-in), and `reconcileAutoSync`
			// reads jolliApiKey alongside it — with the key missing, it routes
			// into the stop branch.
			const activation = await syncActivation;
			await activation?.runtime.reconcileAutoSync().catch((e) => {
				/* v8 ignore start -- defensive log-and-continue on signOut */
				log.warn(
					"reconcileAutoSync after signOut failed: %s",
					(e as Error).message,
				);
				/* v8 ignore stop */
			});
			sidebarProvider.notifyAuthChanged(false);
			statusStore.refresh().catch(handleError("signOut.refresh"));
			SettingsWebviewPanel.notifyAuthChanged().catch(
				handleError("signOut.notifySettings"),
			);
		}),
	);

	// ── URI handler ──────────────────────────────────────────────────────────
	// Two routes, dispatched on uri.path:
	//
	// 1. /auth-callback — OAuth code-exchange flow:
	//      <host-scheme>://jolli.jollimemory-vscode/auth-callback?code=<32-byte-hex>
	//      <host-scheme>://jolli.jollimemory-vscode/auth-callback?error=user_denied
	//    AuthService redeems the code via POST /api/auth/cli-exchange — the
	//    token itself never appears in the callback URL.
	//
	// 2. /summary/<fullHash> — open the SummaryWebviewPanel for a commit, fired
	//    from clickable links emitted by the jolli-search skill template (the
	//    chat renders them as `[Open in IDE](vscode://...)` style links). The
	//    full 40-char SHA is required so the panel matches one specific
	//    summary; we accept 7-40 hex chars to leave room for short-hash usage
	//    but reject anything else as a defensive measure.
	//
	// <host-scheme> is derived from vscode.env.appName (NOT uriScheme — forks
	// tend to leave that at the upstream "vscode" default even though they
	// register their own scheme at the OS level). See resolveUriScheme() in
	// AuthService.ts for the mapping. registerUriHandler runs regardless of
	// which scheme the OS dispatched — it covers every scheme.
	context.subscriptions.push(
		vscode.window.registerUriHandler({
			async handleUri(uri: vscode.Uri) {
				// Do NOT log `uri.toString()` or `uri.query` — the OAuth callback
				// carries the session token and Jolli API key, and the output
				// channel is persisted for the window lifetime (and often pasted
				// into bug reports). Log only non-sensitive URI parts.
				const paramCount = new URLSearchParams(uri.query).size;
				log.info(
					"uriHandler",
					`Received callback ${uri.scheme}://${uri.authority}${uri.path} (${paramCount} params)`,
				);

				if (uri.path === "/auth-callback") {
					const result = await authService.handleAuthCallback(uri);
					if (result.success) {
						currentAuthenticated = true;
						sidebarProvider.notifyAuthChanged(true);
						vscode.window.showInformationMessage(
							"Signed in to Jolli successfully.",
						);
						statusStore.refresh().catch(handleError("uriHandler.refresh"));
						SettingsWebviewPanel.notifyAuthChanged().catch(
							handleError("uriHandler.notifySettings"),
						);
						// Start auto-sync polling if the user already had
						// `autoSyncEnabled=true` from a prior session. Without this,
						// the orchestrator stays dormant until the next settings
						// save or window reload — mirroring the symmetric call
						// in the signOut handler above (line 2452).
						const activation = await syncActivation;
						await activation?.runtime
							.reconcileAutoSync()
							.catch(handleError("uriHandler.reconcileAutoSync"));
					} else {
						vscode.window.showErrorMessage(
							`Jolli sign-in failed: ${result.error}`,
						);
					}
					return;
				}

				// Full 40-char SHA required — `bridge.getSummary` / `getSummaryAnyRepo`
				// fall through to alias / tree-hash resolution for abbreviated input,
				// which silently resolves the wrong commit when two distinct commits
				// share the same tree (cherry-pick, identical re-commit, rebase). Same
				// hardening as `search --hashes` in cli/src/commands/SearchCommand.ts.
				//
				// Cross-repo: external deep links into vscode://…/summary/<sha> may
				// target a memory whose summary lives in a non-current repo under
				// the Memory Bank parent (e.g. a Slack link pasted while a different
				// workspace is open). Use the provenance-bearing cross-repo lookup
				// so the panel learns which repo the summary came from; without
				// `sourceRepoName`, destructive commands (push / edit / createPr)
				// would write to `workspaceRoot`'s git / orphan branch and silently
				// route the foreign repo's memory to the *current* repo's Jolli
				// Memory space.
				const summaryMatch = uri.path.match(/^\/summary\/([0-9a-f]{40})$/);
				if (summaryMatch) {
					const hash = summaryMatch[1];
					const shortHash = hash.substring(0, 7);
					const { summary, sourceRepoName, sourceRemoteUrl } =
						await bridge.getSummaryAnyRepoWithSource(hash);
					if (!summary) {
						vscode.window.showInformationMessage(
							`Jolli Memory: No summary found for commit ${shortHash}.`,
						);
						return;
					}
					const readStorageResult = sourceRepoName
						? await bridge.createStorageForRepo(
								sourceRepoName,
								sourceRemoteUrl,
							)
						: await bridge.createReadStorageForCurrentRepo();
					await SummaryWebviewPanel.show(
						summary,
						context.extensionUri,
						workspaceRoot,
						bridge,
						commitsStore.getMainBranch(),
						"commit",
						sourceRepoName,
						sourceRemoteUrl,
						readStorageResult?.storage ?? null,
					);
					return;
				}

				log.info("uriHandler", `Ignoring unknown URI path: ${uri.path}`);
			},
		}),
	);

	// Tree-view checkbox / visibility handlers were dropped along with the tree
	// views. Equivalent hooks now live in the sidebar wiring above:
	// - File checkbox: `applyFileCheckbox` callback on the SidebarWebviewProvider
	// - Commit checkbox: handled via the sidebar's per-row commit messages
	// - Memories lazy-load: `onSidebarFirstVisible` triggers ensureFirstLoad()

	// ── Initial data load ────────────────────────────────────────────────────
	// Resolve `initialStateReady` once initialLoad finishes (success OR error
	// path) so the sidebar webview never gets stuck in its loading
	// placeholder. initialLoad already swallows errors internally and
	// returns void, so a single .finally is enough to release the barrier.
	void initialLoad(
		bridge,
		excludeFilter,
		statusStore,
		plansStore,
		filesStore,
		commitsStore,
		memoriesStore,
		statusBar,
	).finally(() => {
		resolveInitialStateReady();
	});

	// ── Auto-refresh hook paths on version upgrade ────────────────────────────
	// VSCode installs each extension version into a versioned directory
	// (e.g. jolli.jollimemory-vscode-0.1.0 → 0.2.0). If JolliMemory is enabled
	// and the hook scripts point to the old directory, silently re-enable to
	// update the paths — no manual disable → enable step required.
	bridge
		.refreshHookPathsIfStale(context.extensionPath)
		.then(async (mismatch) => {
			log.debug("activate", "Hook path refresh check complete");

			// Warn if a newer version (e.g. global CLI) manages hooks
			if (mismatch) {
				statusStore.setExtensionOutdated(true);
				vscode.window.showWarningMessage(
					"Jolli Memory: A newer version is available. Please update the extension.",
				);
			}
			// Re-render the status panel to reflect any path refresh that just happened.
			await statusStore.refresh();
			await refreshStatusBar(
				bridge,
				memoriesStore,
				plansStore,
				filesStore,
				commitsStore,
				statusBar,
			);

			// Auto-install hooks for new worktrees when the project is already enabled.
			// If other worktrees have hooks installed but this one doesn't, silently
			// re-run enable so no manual step is required.
			const status = await bridge.getStatus();
			if (
				status.gitHookInstalled &&
				status.worktreeHooksInstalled === false &&
				status.enabledWorktrees !== undefined &&
				status.enabledWorktrees > 0
			) {
				log.info(
					"activate",
					"Project enabled but worktree hooks missing — auto-installing",
				);
				await bridge.autoInstallForWorktree();
				await statusStore.refresh();
				await refreshStatusBar(
					bridge,
					memoriesStore,
					plansStore,
					filesStore,
					commitsStore,
					statusBar,
				);
			}

			// Auto-enable on first run unless the user has explicitly opted out.
			// The opt-out is a marker file at
			// `<projectDir>/.jolli/jollimemory/disabled-by-user` (sibling of
			// sessions.json / cursors.json), so a fresh project / fresh worktree
			// has no marker → falsy → install.
			const manuallyDisabled = await readManualDisableFlag(workspaceRoot);
			if (!status.enabled && !manuallyDisabled) {
				log.info(
					"activate",
					"Auto-enabling Jolli Memory (no opt-out recorded)",
				);
				const enableResult = await bridge.enable();
				if (!enableResult.success) {
					/* v8 ignore start -- defensive: bridge.enable() failure during activate auto-enable; logs and continues so vscode never marks the extension unloadable */
					log.warn("activate", "Auto-enable failed", {
						message: enableResult.message,
					});
					/* v8 ignore stop */
				} else {
					await statusStore.refresh();
					const refreshed = await refreshStatusBar(
						bridge,
						memoriesStore,
						plansStore,
						filesStore,
						commitsStore,
						statusBar,
					);
					currentEnabled = refreshed.enabled;
					sidebarProvider.notifyEnabledChanged(refreshed.enabled);
				}
			}
		})
		.catch((err: unknown) => {
			log.error("activate", "Failed to refresh hook paths", err);
		});
}

// ─── deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
	log.info("deactivate", "Jolli Memory extension deactivating");
	log.dispose();
	// VSCode disposes context.subscriptions automatically
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Loads all panels on activation, initializes the exclude filter, and sets up
 * the status bar and context keys.
 */
function initialLoad(
	bridge: JolliMemoryBridge,
	excludeFilter: ExcludeFilterManager,
	statusStore: StatusStore,
	plansStore: PlansStore,
	filesStore: FilesStore,
	commitsStore: CommitsStore,
	memoriesStore: MemoriesStore,
	statusBar: StatusBarManager,
): Promise<void> {
	log.info("initialLoad", "Loading all panels");
	// Load the exclude filter FIRST so the initial file list is already filtered.
	// If loaded in parallel with filesStore.refresh(), the tree briefly shows
	// all files (including excluded ones) before the filter kicks in.
	return excludeFilter
		.load()
		.then(() =>
			Promise.all([
				statusStore.refresh(),
				plansStore.refresh(),
				filesStore.refresh(),
				commitsStore.refresh(),
			]),
		)
		.then(async () => {
			log.info("initialLoad", "All panels loaded — updating status bar");
			// filesView.description is now driven by filesStore.onChange
			// (updateFilesViewUI in activate), so no one-shot sync here.
			await refreshStatusBar(
				bridge,
				memoriesStore,
				plansStore,
				filesStore,
				commitsStore,
				statusBar,
			);
		})
		.catch((err: unknown) => {
			log.error("initialLoad", "Failed to load panels", err);
		});
}

/**
 * Refreshes the status bar, the `jollimemory.enabled` context key, and the
 * enabled state on the data-source stores from the current bridge state.
 *
 * - The context key drives the conditional icon in the Status panel title bar.
 * - Syncing the store enabled flag makes them serve [] when disabled, so the
 *   sidebar webview's Branch tab sections (Plans / Changes / Commits) and the
 *   Memory Bank tab render their empty-state copy from `SidebarEmptyMessages`.
 */
async function refreshStatusBar(
	bridge: JolliMemoryBridge,
	memoriesStore: MemoriesStore,
	plansStore: PlansStore,
	filesStore: FilesStore,
	commitsStore: CommitsStore,
	statusBar: StatusBarManager,
): Promise<StatusInfo> {
	const status = await bridge.getStatus();

	statusBar.update(status.enabled);

	// Propagate the enabled flag to the stores so the webview's data feed is
	// empty when JolliMemory is disabled — the webview then renders its own
	// empty-state copy via `SidebarEmptyMessages`.
	memoriesStore.setEnabled(status.enabled);
	plansStore.setEnabled(status.enabled);
	filesStore.setEnabled(status.enabled);
	commitsStore.setEnabled(status.enabled);

	// Update the context key so package.json `when` clauses show the correct icon.
	await vscode.commands.executeCommand(
		"setContext",
		"jollimemory.enabled",
		status.enabled,
	);

	return status;
}

/**
 * Returns an error handler that shows a VSCode error message.
 */
/**
 * Resolves the user's Memory Bank folder for the current workspace and
/* `revealMemoryBankFolder` REMOVED — its only caller was the deleted
 * `symlink_quarantine_failed` popup (SymlinkPopupGate). The new symlink
 * defences in stageVault / safeAtomicWriteSync don't surface a one-shot
 * popup, so the helper has no consumer. If a future feature needs an
 * "open vault in file manager" action, it can be re-added then. */

function handleError(commandName: string): (err: unknown) => void {
	return (err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		log.error("cmd", `${commandName} failed: ${message}`, err);
		vscode.window.showErrorMessage(`Jolli Memory (${commandName}): ${message}`);
	};
}

/**
 * Migrates the index.json from v1 format (top-level-only entries) to v3 flat format
 * (every tree node has its own entry with `parentCommitHash`). Runs once after the
 * v1 orphan branch migration and on subsequent activations until the index is at v3.
 *
 * `migrateIndexToV3` acquires `orphan-write.lock` internally so it never races
 * with the post-commit hook Worker or any background scan writing to the orphan
 * branch.
 *
 * Sets all providers to "migrating" state and refreshes them afterward.
 */
async function migrateIndexIfNeeded(
	bridge: JolliMemoryBridge,
	statusStore: StatusStore,
	commitsStore: CommitsStore,
	filesStore: FilesStore,
): Promise<void> {
	try {
		// Early-return so that no-op cases (most activations) skip the expensive
		// commitsStore.refresh() and migration-state toggling below.
		const needsMigration = await bridge.indexNeedsMigration();
		if (!needsMigration) {
			return;
		}
	} catch (err: unknown) {
		log.error("migrate", "Index migration check failed", err);
		return;
	}

	// Show migration state in all panels
	statusStore.setMigrating(true);
	commitsStore.setMigrating(true);
	filesStore.setMigrating(true);

	try {
		log.info("migrate", "Index v1 detected — migrating to v3 flat format");

		const { migrated, skipped } = await bridge.migrateIndexToV3();
		log.info(
			"migrate",
			`Index migration complete: ${migrated} entries migrated, ${skipped} skipped`,
		);
	} catch (err: unknown) {
		log.error("migrate", "Index v1 → v3 migration failed", err);
	} finally {
		// Clear migration state regardless of success/failure
		statusStore.setMigrating(false);
		commitsStore.setMigrating(false);
		filesStore.setMigrating(false);

		// Refresh providers so history reflects the migrated data
		await Promise.all([statusStore.refresh(), commitsStore.refresh()]);
	}
}

/**
 * Migrates legacy v1 summaries to v3 tree format if a v1 orphan branch exists.
 * Sets all providers to "migrating" state during the operation, then refreshes
 * status and history providers afterwards so counts are correct.
 */
async function migrateV1IfNeeded(
	cwd: string,
	statusStore: StatusStore,
	commitsStore: CommitsStore,
	filesStore: FilesStore,
): Promise<void> {
	try {
		// Early-return so that no-op cases (most activations) skip the expensive
		// commitsStore.refresh() and migration-state toggling below.
		const v1Exists = await hasV1Branch(cwd);
		if (!v1Exists) {
			return;
		}

		// Skip if migration already completed (v1 is just being retained for 48h)
		const alreadyMigrated = await hasMigrationMeta(cwd);
		if (alreadyMigrated) {
			log.info(
				"migrate",
				"V1 branch exists but migration already completed — skipping",
			);
			return;
		}
	} catch (err: unknown) {
		log.error("migrate", "V1 migration check failed", err);
		return;
	}

	// Show migration state in all panels
	statusStore.setMigrating(true);
	commitsStore.setMigrating(true);
	filesStore.setMigrating(true);

	try {
		log.info(
			"migrate",
			"V1 orphan branch detected — migrating to v3 tree format",
		);
		const { migrated, skipped } = await migrateV1toV3(cwd);
		log.info(
			"migrate",
			`Migration complete: ${migrated} migrated, ${skipped} skipped`,
		);

		// Record migration timestamp; v1 branch is retained for 48h as a safety net
		await writeMigrationMeta(cwd);
		log.info(
			"migrate",
			"Migration metadata written — v1 branch retained for 48h",
		);
	} catch (err: unknown) {
		log.error("migrate", "V1 → V3 migration failed", err);
	} finally {
		// Clear migration state regardless of success/failure.
		statusStore.setMigrating(false);
		commitsStore.setMigrating(false);
		filesStore.setMigrating(false);

		// Refresh providers so counts reflect the migrated data.
		await Promise.all([statusStore.refresh(), commitsStore.refresh()]);
	}
}
