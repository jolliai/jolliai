/**
 * Extension.ts — JolliMemory VSCode Extension Entry Point
 *
 * Wires together all providers, commands, and the status bar.
 * Called by VSCode when the extension activates (workspaceContains:.git).
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import {
	extractRepoName,
	getRemoteUrl,
	resolveKBPath,
} from "../../cli/src/core/KBPathResolver.js";
import {
	acquireLock,
	loadConfig,
	releaseLock,
} from "../../cli/src/core/SessionTracker.js";
import {
	cleanupV1IfExpired,
	hasMigrationMeta,
	hasV1Branch,
	migrateV1toV3,
	writeMigrationMeta,
} from "../../cli/src/core/SummaryMigration.js";
import {
	indexNeedsMigration,
	migrateIndexToV3,
	readNoteFromBranch,
	readPlanFromBranch,
} from "../../cli/src/core/SummaryStore.js";
import { ORPHAN_BRANCH } from "../../cli/src/Logger.js";
import type { StatusInfo } from "../../cli/src/Types.js";
import { CommitCommand } from "./commands/CommitCommand.js";
import { PushCommand } from "./commands/PushCommand.js";
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
	MemoriesTreeProvider,
	type MemoryItem,
} from "./providers/MemoriesTreeProvider.js";
import type { NoteItem, PlanItem } from "./providers/PlansTreeProvider.js";
import { PlansTreeProvider } from "./providers/PlansTreeProvider.js";
import { StatusTreeProvider } from "./providers/StatusTreeProvider.js";
import { AuthService } from "./services/AuthService.js";
import { KbFoldersService } from "./services/KbFoldersService.js";
import { CommitsStore } from "./stores/CommitsStore.js";
import { FilesStore } from "./stores/FilesStore.js";
import { MemoriesStore } from "./stores/MemoriesStore.js";
import { PlansStore } from "./stores/PlansStore.js";
import { StatusStore } from "./stores/StatusStore.js";
import { ExcludeFilterManager } from "./util/ExcludeFilterManager.js";
import { formatShortRelativeDate } from "./util/FormatUtils.js";
import { isWorkerBusy } from "./util/LockUtils.js";
import { initLogger, log } from "./util/Logger.js";
import { StatusBarManager } from "./util/StatusBarManager.js";
import { getWorkspaceRoot } from "./util/WorkspaceUtils.js";
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
 * rather than change events. Optionally subscribes to delete events when
 * `opts.delete` is true.
 */
function watchFile(
	base: string | vscode.Uri,
	pattern: string,
	callback: () => void,
	opts?: { delete?: boolean },
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
	if (opts?.delete) {
		watcher.onDidDelete(wrap("delete"));
	}
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
		const out = execSync(`git rev-parse --git-path ${relativeToGitDir}`, {
			cwd,
		})
			.toString()
			.trim();
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

// ─── activate ─────────────────────────────────────────────────────────────────

/**
 * Names of every command declared in package.json. The two degraded paths
 * (no workspace, no git) need to register a no-op for each one so command-
 * palette invocations don't fail with "command not found"; lifting the list
 * to a constant keeps the two branches in lockstep.
 */
const ALL_DECLARED_COMMANDS: ReadonlyArray<string> = [
	"jollimemory.enableJolliMemory",
	"jollimemory.disableJolliMemory",
	"jollimemory.refreshStatus",
	"jollimemory.refreshMemories",
	"jollimemory.migrateToKnowledgeBase",
	"jollimemory.openSettings",
	"jollimemory.refreshFiles",
	"jollimemory.refreshHistory",
	"jollimemory.refreshPlans",
	"jollimemory.commitAI",
	"jollimemory.squash",
	"jollimemory.pushBranch",
	"jollimemory.pushToJolli",
	"jollimemory.selectAllFiles",
	"jollimemory.selectAllCommits",
	"jollimemory.searchMemories",
	"jollimemory.clearMemoryFilter",
	"jollimemory.loadMoreMemories",
	"jollimemory.viewMemorySummary",
	"jollimemory.viewSummary",
	"jollimemory.copyCommitHash",
	"jollimemory.copyRecallPrompt",
	"jollimemory.openFileChange",
	"jollimemory.openCommitFileChange",
	"jollimemory.discardFileChanges",
	"jollimemory.discardSelectedChanges",
	"jollimemory.focusSidebar",
	"jollimemory.addPlan",
	"jollimemory.editPlan",
	"jollimemory.removePlan",
	"jollimemory.addMarkdownNote",
	"jollimemory.addTextSnippet",
	"jollimemory.editNote",
	"jollimemory.removeNote",
	"jollimemory.openMemoryFile",
	"jollimemory.openInClaudeCode",
	"jollimemory.signIn",
	"jollimemory.signOut",
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
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
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

	// Check if git is initialized — if not, offer to init
	if (!existsSync(join(workspaceRoot, ".git"))) {
		const initGit = () => {
			try {
				execFileSync("git", ["init"], { cwd: workspaceRoot });
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

	async function showPlanPreview(slug: string, title: string): Promise<void> {
		const content = await readPlanFromBranch(slug, workspaceRoot);
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

	async function showNotePreview(id: string, title: string): Promise<void> {
		const content = await readNoteFromBranch(id, workspaceRoot);
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
	const statusStore = new StatusStore(bridge, authService);
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
	const plansProvider = new PlansTreeProvider(plansStore);
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
	// kbRoot resolution mirrors HEAD's KBPathResolver flow so the sidebar reads
	// from the same on-disk location that auto-migration / FolderStorage write
	// to (~/Documents/jolli/<repoName>/), not the legacy hardcoded path used in
	// the original 828991c4 commit.
	/* v8 ignore start -- cherry-picked sidebar wiring; covered indirectly via SidebarWebviewProvider tests; follow-up adds activate-level tests. */
	const sidebarRepoName = extractRepoName(workspaceRoot);
	const sidebarRemoteUrl = getRemoteUrl(workspaceRoot);
	// Initial resolution skips customKBPath because loadConfig() is async.
	// The async branch below re-resolves once config is loaded, and the
	// settings-save callback re-resolves whenever the user picks a new folder.
	let sidebarKbRoot = resolveKBPath(sidebarRepoName, sidebarRemoteUrl);
	const kbFoldersService = new KbFoldersService(() => sidebarKbRoot);

	// Re-resolves sidebarKbRoot from the latest config and (if the path has
	// changed) tells the sidebar webview to drop its cached folder tree so the
	// next listing starts from the new root. Returns true when the root moved.
	async function refreshSidebarKbRoot(): Promise<boolean> {
		try {
			const cfg = await loadConfig();
			const customKBPath = (cfg as Record<string, unknown>).localFolder as
				| string
				| undefined;
			const next = resolveKBPath(
				sidebarRepoName,
				sidebarRemoteUrl,
				customKBPath,
			);
			if (next !== sidebarKbRoot) {
				sidebarKbRoot = next;
				return true;
			}
		} catch (err) {
			log.warn("activate", "refreshSidebarKbRoot failed", err);
		}
		return false;
	}

	// Display name for the repo-root header in the sidebar's KB tree (mirrors
	// IntelliJ's KBExplorerPanel repo node). Identical to `sidebarRepoName`
	// because cli's `extractRepoName` is the single source of truth for both
	// the on-disk path and the UI label — opening a worktree shows e.g.
	// "jolliai" (origin URL basename) instead of the worktree directory name.
	const kbRepoFolder = sidebarRepoName;

	let currentBranchName = "";
	let currentBranchDetached = false;
	const branchChangeEmitter = new vscode.EventEmitter<void>();

	void bridge.getCurrentBranch().then((branch) => {
		currentBranchName = branch;
		currentBranchDetached = branch === "HEAD";
		branchChangeEmitter.fire();
	});

	let currentEnabled = true;
	let currentAuthenticated = false;

	const sidebarProvider = new SidebarWebviewProvider({
		executeCommand: (cmd, ...args) =>
			vscode.commands.executeCommand(cmd, ...args),
		getInitialState: () => ({
			enabled: currentEnabled,
			authenticated: currentAuthenticated,
			activeTab: "branch",
			kbMode: "folders",
			branchName: currentBranchName,
			detached: currentBranchDetached,
			kbRepoFolder,
		}),
		extensionUri: context.extensionUri,
		statusProvider: {
			serialize: () => statusProvider.serialize(),
			onDidChangeTreeData:
				statusProvider.onDidChangeTreeData.bind(statusProvider),
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
		resolveKbAbs: (relPath) => join(sidebarKbRoot, relPath),
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
	});
	context.subscriptions.push(
		sidebarProvider,
		vscode.window.registerWebviewViewProvider(
			SidebarWebviewProvider.viewId,
			sidebarProvider,
		),
		branchChangeEmitter,
	);

	void bridge.getStatus().then((s) => {
		currentEnabled = s.enabled;
		sidebarProvider.notifyEnabledChanged(s.enabled);
	});
	void loadConfig().then((cfg) => {
		currentAuthenticated = !!cfg?.authToken;
		sidebarProvider.notifyAuthChanged(currentAuthenticated);
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
			workspaceRoot,
			statusStore,
			commitsStore,
			filesStore,
		);

		// V1 branch delayed cleanup: after migration, the v1 branch is retained
		// for 48 hours as a safety net. Check if the retention period has expired.
		await cleanupV1IfExpired(workspaceRoot);

		// 3. KB folder auto-initialization + migration
		// Creates the KB folder (~/Documents/jolli/{repoName}/) and auto-migrates
		// orphan branch data if migration hasn't been completed yet.
		try {
			const {
				extractRepoName,
				getRemoteUrl,
				initializeKBFolder,
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
			initializeKBFolder(kbRoot, repoName, remoteUrl);

			// Auto-migrate if orphan branch has data but migration not completed.
			// This covers two real-world entry points: (1) fresh install of the
			// folder-mode extension on a repo previously using orphan storage, and
			// (2) the user manually wiped the KB folder (which also nukes
			// migration.json, making readMigrationState() return null and forcing
			// a re-migration).
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
					// initializeKB is fire-and-forget (`void initializeKB()` below),
					// so the sidebar webview can resolve and request kb:expandFolder
					// before migration writes its first MD. Without an explicit
					// signal, the sidebar's first listing is empty and stays empty
					// until the user clicks Refresh — a UX bug that surfaces every
					// post-wipe reload. Push a reset so the client re-fetches once
					// migration's writes are on disk.
					sidebarProvider.refreshKnowledgeBaseFolders();
				}
			}
		} catch (err) {
			log.error("activate", "KB folder init/migration failed", err);
		}
	}

	void initializeKB();

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

	// ── Lock file watcher ────────────────────────────────────────────────
	// When the post-commit Worker is running, it holds .jolli/jollimemory/lock.
	// Disable Commit/Squash/Push buttons during this time to prevent race conditions
	// (Bug 3: squash commit while previous Worker holds the lock).
	const lockWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(workspaceRoot, ".jolli/jollimemory/lock"),
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
	});
	context.subscriptions.push(lockWatcher);
	// Check initial state — lock file might already exist on activation
	void isWorkerBusy(workspaceRoot).then(setWorkerBusy);

	// COMMITS title updates are handled by the commitsStore.onChange subscription
	// registered near the createTreeView calls above — no provider hook needed.

	// (filesView.badge / .description hooks removed — the sidebar's Files tab
	// renders its own header text from the serialized snapshot.)

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
	context.subscriptions.push(
		// Standalone orphan→folder migration. Triggered from settings or external
		// plugins; not tied to a tree view. Surfaces the same MigrationEngine
		// flow the activate() path runs automatically when the orphan branch has
		// data but migration hasn't been completed.
		vscode.commands.registerCommand(
			"jollimemory.migrateToKnowledgeBase",
			async () => {
				try {
					const {
						extractRepoName,
						getRemoteUrl,
						initializeKBFolder,
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
					const cfg = await loadConfig();
					const customKBPath = (cfg as Record<string, unknown>).localFolder as
						| string
						| undefined;
					const kbRoot = resolveKBPath(repoName, remoteUrl, customKBPath);
					initializeKBFolder(kbRoot, repoName, remoteUrl);

					const orphan = new OrphanBranchStorage(workspaceRoot);
					if (!(await orphan.exists())) {
						vscode.window.showInformationMessage(
							"No git storage found — nothing to migrate.",
						);
						return;
					}

					const mm = new MetadataManager(join(kbRoot, ".jolli"));
					const folder = new FolderStorage(kbRoot, mm);
					await folder.ensure();
					const engine = new MigrationEngine(orphan, folder, mm);

					await vscode.window.withProgress(
						{
							location: vscode.ProgressLocation.Notification,
							title: "Migrating to Memory Bank...",
						},
						async (progress) => {
							const result = await engine.runMigration((migrated, total) => {
								progress.report({
									message: `${migrated}/${total}`,
									increment: (1 / total) * 100,
								});
							});
							if (result.status === "completed") {
								vscode.window.showInformationMessage(
									`Migration completed: ${result.migratedEntries} memories migrated to ${kbRoot}`,
								);
							} else {
								vscode.window.showWarningMessage(
									`Migration ${result.status}: ${result.migratedEntries}/${result.totalEntries} entries`,
								);
							}
						},
					);
				} catch (err) {
					vscode.window.showErrorMessage(
						`Migration failed: ${(err as Error).message}`,
					);
				}
			},
		),
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
						resolveKBPath,
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

					const oldKbRoot = resolveKBPath(repoName, remoteUrl, customKBPath);
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

					const moved = await refreshSidebarKbRoot();
					if (moved) sidebarProvider.refreshKnowledgeBaseFolders(kbRepoFolder);

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
		vscode.commands.registerCommand("jollimemory.refreshStatus", () => {
			statusStore.refresh().catch(handleError("refreshStatus"));
			refreshStatusBar(
				bridge,
				memoriesStore,
				plansStore,
				filesStore,
				commitsStore,
				statusBar,
			);
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

				// Modified / renamed files — always diff against the working tree.
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
					// Open rendered markdown preview (read-only) from orphan branch
					await showPlanPreview(slug, planTitle);
				} else {
					// Open source file for editing
					const filePath = join(homedir(), ".claude", "plans", `${slug}.md`);
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
			async (id: string, title: string) => {
				await showNotePreview(id, title);
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
				// the bridge.
				const snap = plansStore.getSnapshot();
				const plan = snap.merged.find(
					(e) => e.kind === "plan" && e.plan.slug === slug,
				);
				const planTitle = plan && plan.kind === "plan" ? plan.plan.title : slug;
				const localPath = join(homedir(), ".claude", "plans", `${slug}.md`);
				if (existsSync(localPath)) {
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
		vscode.commands.registerCommand(
			"jollimemory.viewSummary",
			async (item: CommitItem | string) => {
				const hash = typeof item === "string" ? item : item.commit.hash;
				const shortHash = hash.substring(0, 7);
				const summary = await bridge.getSummary(hash);
				if (!summary) {
					vscode.window.showInformationMessage(
						`Jolli Memory: No summary found for commit ${shortHash}.`,
					);
					return;
				}
				await SummaryWebviewPanel.show(
					summary,
					context.extensionUri,
					workspaceRoot,
					"commit",
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
				const summary = await bridge.getSummary(hash);
				if (!summary) {
					vscode.window.showInformationMessage(
						`Jolli Memory: No summary found for commit ${shortHash}.`,
					);
					return;
				}
				await SummaryWebviewPanel.show(
					summary,
					context.extensionUri,
					workspaceRoot,
					"memory",
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
					const summary = await bridge.getSummary(meta.commitHash);
					if (summary) {
						await SummaryWebviewPanel.show(
							summary,
							context.extensionUri,
							workspaceRoot,
							"kb",
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
		vscode.commands.registerCommand(
			"jollimemory.copyRecallPrompt",
			async (item: MemoryItem | string) => {
				const hash = typeof item === "string" ? item : item.entry.commitHash;
				const summary = await bridge.getSummary(hash);
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

		// Open in Claude Code via URI scheme
		vscode.commands.registerCommand(
			"jollimemory.openInClaudeCode",
			async (item: MemoryItem | string) => {
				const hash = typeof item === "string" ? item : item.entry.commitHash;
				const summary = await bridge.getSummary(hash);
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
					} catch (err) {
						handleError("openSettings.save")(err as Error);
					}
				},
			);
		}),

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
			sidebarProvider.notifyAuthChanged(false);
			statusStore.refresh().catch(handleError("signOut.refresh"));
		}),
	);

	// ── URI handler ──────────────────────────────────────────────────────────
	// Receives the OAuth callback after browser-based login/signup.
	// URI format: <host-scheme>://jolli.jollimemory-vscode/auth-callback?token=...&jolli_api_key=...
	// <host-scheme> is derived from vscode.env.appName (NOT uriScheme — forks
	// tend to leave that at the upstream "vscode" default even though they
	// register their own scheme at the OS level). See resolveUriScheme() in
	// AuthService.ts for the mapping. This handler runs regardless of which
	// scheme the OS dispatched — registerUriHandler covers every scheme.
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
				const result = await authService.handleAuthCallback(uri);
				if (result.success) {
					currentAuthenticated = true;
					sidebarProvider.notifyAuthChanged(true);
					vscode.window.showInformationMessage(
						"Signed in to Jolli successfully.",
					);
					statusStore.refresh().catch(handleError("uriHandler.refresh"));
				} else {
					vscode.window.showErrorMessage(
						`Jolli sign-in failed: ${result.error}`,
					);
				}
			},
		}),
	);

	// Tree-view checkbox / visibility handlers were dropped along with the tree
	// views. Equivalent hooks now live in the sidebar wiring above:
	// - File checkbox: `applyFileCheckbox` callback on the SidebarWebviewProvider
	// - Commit checkbox: handled via the sidebar's per-row commit messages
	// - Memories lazy-load: `onSidebarFirstVisible` triggers ensureFirstLoad()

	// ── Initial data load ────────────────────────────────────────────────────
	initialLoad(
		bridge,
		excludeFilter,
		statusStore,
		plansStore,
		filesStore,
		commitsStore,
		memoriesStore,
		statusBar,
	);

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
): void {
	log.info("initialLoad", "Loading all panels");
	// Load the exclude filter FIRST so the initial file list is already filtered.
	// If loaded in parallel with filesStore.refresh(), the tree briefly shows
	// all files (including excluded ones) before the filter kicks in.
	excludeFilter
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
 * enabled state on the files/history providers from the current bridge state.
 *
 * - The context key drives the conditional icon in the Status panel title bar.
 * - Syncing the provider enabled flag makes them return [] when disabled,
 *   which triggers the viewsWelcome placeholder in the Files and History panels.
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

	// Propagate the enabled flag to providers so their panels show the
	// viewsWelcome placeholder (empty list) when JolliMemory is disabled.
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
 * Uses the shared worker lock (`acquireLock`) so it never runs concurrently with the
 * post-commit hook Worker writing to the orphan branch.
 *
 * Sets all providers to "migrating" state and refreshes them afterward.
 */
async function migrateIndexIfNeeded(
	cwd: string,
	statusStore: StatusStore,
	commitsStore: CommitsStore,
	filesStore: FilesStore,
): Promise<void> {
	try {
		// Early-return so that no-op cases (most activations) skip the expensive
		// commitsStore.refresh() and migration-state toggling below.
		const needsMigration = await indexNeedsMigration(cwd);
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

		// Acquire the shared worker lock to prevent concurrent orphan branch writes
		const lockAcquired = await acquireLock(cwd);
		if (!lockAcquired) {
			log.warn(
				"migrate",
				"Could not acquire worker lock for index migration — deferring",
			);
			return;
		}

		try {
			const { migrated, skipped } = await migrateIndexToV3(cwd);
			log.info(
				"migrate",
				`Index migration complete: ${migrated} entries migrated, ${skipped} skipped`,
			);
		} finally {
			await releaseLock(cwd);
		}
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
