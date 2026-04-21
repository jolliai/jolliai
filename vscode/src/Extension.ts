/**
 * Extension.ts — JolliMemory VSCode Extension Entry Point
 *
 * Wires together all providers, commands, and the status bar.
 * Called by VSCode when the extension activates (workspaceContains:.git).
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import { acquireLock, releaseLock } from "../../cli/src/core/SessionTracker.js";
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
import { CommitCommand } from "./commands/CommitCommand.js";
import { ExportMemoriesCommand } from "./commands/ExportMemoriesCommand.js";
import { PushCommand } from "./commands/PushCommand.js";
import { SquashCommand } from "./commands/SquashCommand.js";
import { getNotesDir } from "./core/NoteService.js";
import {
	addPlanToRegistry,
	getPlansDir,
	isPlanFromCurrentProject,
	listAvailablePlans,
	registerNewPlan,
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
import { ExcludeFilterManager } from "./util/ExcludeFilterManager.js";
import { formatShortRelativeDate } from "./util/FormatUtils.js";
import { isWorkerBusy } from "./util/LockUtils.js";
import { initLogger, log } from "./util/Logger.js";
import { StatusBarManager } from "./util/StatusBarManager.js";
import { getWorkspaceRoot } from "./util/WorkspaceUtils.js";
import { NoteEditorWebviewPanel } from "./views/NoteEditorWebviewPanel.js";
import { SettingsWebviewPanel } from "./views/SettingsWebviewPanel.js";
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
 * Creates a debounced wrapper around a callback. Multiple invocations within
 * `ms` milliseconds collapse into a single trailing call. Multiple callers
 * that share the returned function share the same timer.
 */
function debounced(callback: () => void, ms: number): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return () => {
		clearTimeout(timer);
		timer = setTimeout(callback, ms);
	};
}

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
// ─── activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		log.warn("activate", "No workspace root found — skipping activation");
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
		provider: PlansTreeProvider,
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
		await provider.refresh();
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

	// ── Tree providers ───────────────────────────────────────────────────────
	const statusProvider = new StatusTreeProvider(bridge, authService);
	const memoriesProvider = new MemoriesTreeProvider(bridge);
	const plansProvider = new PlansTreeProvider(bridge);
	const filesProvider = new FilesTreeProvider(
		bridge,
		workspaceRoot,
		excludeFilter,
	);
	const historyProvider = new HistoryTreeProvider(bridge);
	statusProvider.setHistoryProvider(historyProvider);

	context.subscriptions.push(plansProvider);
	context.subscriptions.push(filesProvider);
	context.subscriptions.push(historyProvider);
	context.subscriptions.push(
		vscode.window.registerFileDecorationProvider(
			new CommitFileDecorationProvider(),
		),
	);

	// Register tree views FIRST so providers are available before context keys
	// trigger `when` clause re-evaluation (which may cause VSCode to query tree data).
	const statusView = vscode.window.createTreeView("jollimemory.statusView", {
		treeDataProvider: statusProvider,
		showCollapseAll: false,
	});

	const memoriesView = vscode.window.createTreeView(
		"jollimemory.memoriesView",
		{
			treeDataProvider: memoriesProvider,
			showCollapseAll: false,
		},
	);

	const plansView = vscode.window.createTreeView("jollimemory.plansView", {
		treeDataProvider: plansProvider,
		showCollapseAll: false,
	});

	const filesView = vscode.window.createTreeView("jollimemory.filesView", {
		treeDataProvider: filesProvider,
		showCollapseAll: false,
		canSelectMany: false,
		// checkboxes require vscode 1.80+
	});

	const historyView = vscode.window.createTreeView("jollimemory.historyView", {
		treeDataProvider: historyProvider,
		showCollapseAll: true,
		canSelectMany: false,
	});

	context.subscriptions.push(
		statusView,
		memoriesView,
		plansView,
		filesView,
		historyView,
	);
	memoriesProvider.setView(memoriesView);
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

	// Run migrations sequentially: orphan branch migration must complete before
	// flat index migration to prevent concurrent writes to the same orphan branch.
	// TODO(v1.0): Remove all migration code (migrateV1IfNeeded, migrateIndexIfNeeded,
	// cleanupV1IfExpired) once JolliMemory v1.0 ships — all users will be on v3 by then.
	void (async () => {
		await migrateV1IfNeeded(
			workspaceRoot,
			statusProvider,
			historyProvider,
			filesProvider,
		);
		await migrateIndexIfNeeded(
			workspaceRoot,
			statusProvider,
			historyProvider,
			filesProvider,
		);
	})();

	// V1 branch delayed cleanup: after migration, the v1 branch is retained for
	// 48 hours as a safety net. Check if the retention period has expired and delete.
	void cleanupV1IfExpired(workspaceRoot);

	// ── sessions.json watcher ─────────────────────────────────────────────────
	// When sessions.json is created or updated (e.g. a new Claude Code session
	// starts or stops), the watcher triggers a refresh so the STATUS panel
	// reflects the current active session count without manual user action.
	const sessionsWatcher = watchFile(
		workspaceRoot,
		".jolli/jollimemory/sessions.json",
		() => {
			statusProvider.refresh().catch(handleError("sessionsWatcher"));
			plansProvider.refresh().catch(handleError("sessionsWatcher.plans"));
		},
	);
	context.subscriptions.push(sessionsWatcher);

	// ── Plans directory watcher ──────────────────────────────────────────────
	// Watch ~/.claude/plans/*.md for changes to auto-refresh the PLANS panel.
	const plansDir = getPlansDir();
	const debouncedPlansRefresh = debounced(
		() => plansProvider.refresh().catch(handleError("plansDirWatcher")),
		500,
	);
	const plansDirWatcher = watchFile(
		vscode.Uri.file(plansDir),
		"*.md",
		debouncedPlansRefresh,
		{ delete: true },
	);
	context.subscriptions.push(plansDirWatcher);

	// Event-driven registration: when a NEW .md file appears in ~/.claude/plans/,
	// register it into plans.json immediately so the panel shows it without
	// waiting for a turn boundary or StopHook transcript scan.
	//
	// Historical files: VSCode's FileSystemWatcher only fires onDidCreate for
	// files created AFTER subscription, so pre-existing plans from prior
	// sessions are naturally excluded — no startup directory scan needed.
	//
	// Cross-project isolation: `~/.claude/plans/` is GLOBAL, so the OS delivers
	// every create event to every VS Code instance subscribed to it. To avoid
	// registering a foreign project's plan into this project, we gate
	// registerNewPlan behind isPlanFromCurrentProject(), which confirms the
	// absolute path appears in THIS project's transcripts. If no transcript
	// match is found (foreign write, or transcript not yet flushed), StopHook
	// will handle the case at turn end with its own transcript-based
	// attribution.
	//
	// Events are chained through `registerQueue` to serialize the
	// load-modify-save sequences of back-to-back registrations (Claude may
	// emit multiple file creations in one turn). Without this, two concurrent
	// registerNewPlan calls could each read the registry before either writes,
	// and the later save would overwrite the earlier slug.
	let registerQueue: Promise<void> = Promise.resolve();
	context.subscriptions.push(
		plansDirWatcher.onDidCreate((uri) => {
			const filename = basename(uri.fsPath);
			if (!filename.endsWith(".md")) {
				return;
			}
			const slug = filename.slice(0, -3);
			registerQueue = registerQueue
				.then(async () => {
					if (!(await isPlanFromCurrentProject(uri.fsPath, workspaceRoot))) {
						return;
					}
					await registerNewPlan(slug, workspaceRoot);
				})
				.catch((err) => handleError("plansDirWatcher.register")(err as Error));
		}),
	);

	// plans.json watcher — catches StopHook writes, registerNewPlan writes from
	// the onDidCreate handler above, and any other out-of-band registry update.
	// Safe from infinite refresh: registerNewPlan is idempotent (no-op when the
	// slug already exists), and detectPlans only writes for orphan cleanup
	// (also one-shot). The 500ms debounce absorbs any transient fan-out.
	const plansJsonWatcher = watchFile(
		workspaceRoot,
		".jolli/jollimemory/plans.json",
		debouncedPlansRefresh,
	);
	context.subscriptions.push(plansJsonWatcher);

	// ── Notes directory watcher ─────────────────────────────────────────────
	// Watch .jolli/jollimemory/notes/*.md for snippet file changes. The
	// debounced callback is also invoked from the onDidSaveTextDocument handler
	// below for external markdown notes — both sources share the same timer.
	const notesDir = getNotesDir(workspaceRoot);
	const debouncedNotesRefresh = debounced(
		() => plansProvider.refresh().catch(handleError("notesDirWatcher")),
		500,
	);
	const notesDirWatcher = watchFile(
		vscode.Uri.file(notesDir),
		"*.md",
		debouncedNotesRefresh,
		{ delete: true },
	);
	context.subscriptions.push(notesDirWatcher);

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
					debouncedNotesRefresh();
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
				statusProvider.refresh().catch(handleError("headWatcher.status"));
				plansProvider.refresh().catch(handleError("headWatcher.plans"));
				filesProvider.refresh().catch(handleError("headWatcher.files"));
				historyProvider.refresh().catch(handleError("headWatcher.history"));
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
				historyProvider.refresh().catch(handleError("orphanRefWatcher"));
				memoriesProvider
					.refresh()
					.catch(handleError("orphanRefWatcher.memories"));
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
		statusProvider.setWorkerBusy(busy);
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
		historyProvider.refresh().catch(handleError("lockWatcher.onDidDelete"));
		memoriesProvider
			.refresh()
			.catch(handleError("lockWatcher.onDidDelete.memories"));
		// Refresh PLANS panel so commit hash prefix appears after Worker associates plans.
		plansProvider.refresh().catch(handleError("lockWatcher.onDidDelete.plans"));
	});
	context.subscriptions.push(lockWatcher);
	// Check initial state — lock file might already exist on activation
	void isWorkerBusy(workspaceRoot).then(setWorkerBusy);

	// COMMITS panel: update title when merged state changes.
	historyProvider.onDidChangeTreeData(() => {
		historyView.title = historyProvider.isMerged
			? "COMMITS (merged — read-only history)"
			: "COMMITS";
	});

	// CHANGES panel: badge (number on activity bar icon) + tooltip.
	// historyView intentionally has no badge — the activity bar icon number
	// reflects only the changed-file count, not commits.
	function updateFilesBadge(): void {
		const visible = filesProvider.getVisibleFileCount();
		const selected = filesProvider.getSelectedFiles().length;
		const tooltip = `${visible} changed file${visible !== 1 ? "s" : ""}, ${selected} selected`;
		filesView.badge = visible > 0 ? { value: visible, tooltip } : undefined;
	}
	filesProvider.onDidChangeTreeData(updateFilesBadge);

	// ── Commands ─────────────────────────────────────────────────────────────
	const commitCommand = new CommitCommand(
		bridge,
		filesProvider,
		historyProvider,
		statusProvider,
		statusBar,
		workspaceRoot,
	);
	const squashCommand = new SquashCommand(
		bridge,
		historyProvider,
		filesProvider,
		statusProvider,
		statusBar,
		workspaceRoot,
	);
	const pushCommand = new PushCommand(
		bridge,
		historyProvider,
		filesProvider,
		statusProvider,
		statusBar,
		workspaceRoot,
	);
	const exportMemoriesCommand = new ExportMemoriesCommand(bridge);

	context.subscriptions.push(
		// Status panel
		vscode.commands.registerCommand("jollimemory.refreshStatus", () => {
			statusProvider.refresh().catch(handleError("refreshStatus"));
			refreshStatusBar(
				bridge,
				memoriesProvider,
				plansProvider,
				filesProvider,
				historyProvider,
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
					// Refresh all panels so the latest file and commit data is shown
					// immediately after enabling — don't rely on stale pre-enable data.
					// Reorder the file list since this is a fresh enable.
					await Promise.all([
						statusProvider.refresh(),
						memoriesProvider.refresh(),
						filesProvider.refresh(true),
						historyProvider.refresh(),
					]);
					await refreshStatusBar(
						bridge,
						memoriesProvider,
						plansProvider,
						filesProvider,
						historyProvider,
						statusBar,
					);
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
					await statusProvider.refresh();
					await refreshStatusBar(
						bridge,
						memoriesProvider,
						plansProvider,
						filesProvider,
						historyProvider,
						statusBar,
					);
				}
			},
		),

		vscode.commands.registerCommand("jollimemory.focusSidebar", () => {
			vscode.commands.executeCommand("jollimemory.memoriesView.focus");
		}),

		// Files panel
		vscode.commands.registerCommand("jollimemory.refreshFiles", () => {
			filesProvider.refresh(true).catch(handleError("refreshFiles"));
			refreshStatusBar(
				bridge,
				memoriesProvider,
				plansProvider,
				filesProvider,
				historyProvider,
				statusBar,
			);
		}),

		vscode.commands.registerCommand("jollimemory.selectAllFiles", () => {
			filesProvider.toggleSelectAll();
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
					filesProvider.deselectPaths([relativePath]);
					await filesProvider.refresh(true);
					refreshStatusBar(
						bridge,
						memoriesProvider,
						plansProvider,
						filesProvider,
						historyProvider,
						statusBar,
					);
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : String(err);
					log.error(
						"cmd",
						`discardFileChanges failed for ${relativePath}: ${message}`,
					);
					vscode.window.showErrorMessage(
						`Jolli Memory: Failed to discard "${relativePath}": ${message}`,
					);
					// Refresh anyway — partial success possible (e.g. staged restore succeeded, disk delete failed)
					await filesProvider.refresh(true);
				}
			},
		),

		vscode.commands.registerCommand(
			"jollimemory.discardSelectedChanges",
			async () => {
				const selectedFiles = filesProvider.getSelectedFiles();
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
					await filesProvider.refresh(true);
					refreshStatusBar(
						bridge,
						memoriesProvider,
						plansProvider,
						filesProvider,
						historyProvider,
						statusBar,
					);
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : String(err);
					log.error("cmd", `discardSelectedChanges failed: ${message}`);
					vscode.window.showErrorMessage(
						`Jolli Memory: Failed to discard selected changes: ${message}`,
					);
					// Refresh anyway — some files may have been discarded before the error
					await filesProvider.refresh(true);
				}
			},
		),

		// Plans panel
		vscode.commands.registerCommand("jollimemory.refreshPlans", () => {
			plansProvider.refresh().catch(handleError("refreshPlans"));
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
			async (item: PlanItem) => {
				log.info("cmd", `removePlan invoked: ${item.plan.slug}`);
				await bridge.removePlan(item.plan.slug);
				await plansProvider.refresh();
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
			await plansProvider.refresh();
			log.info("cmd", `addPlan: added ${selected.slug}`);
		}),

		vscode.commands.registerCommand("jollimemory.addMarkdownNote", async () => {
			await addMarkdownNote(bridge, plansProvider);
		}),

		vscode.commands.registerCommand("jollimemory.addTextSnippet", () => {
			NoteEditorWebviewPanel.show(context.extensionUri, bridge, () =>
				plansProvider.refresh(),
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

		vscode.commands.registerCommand(
			"jollimemory.removeNote",
			async (item: NoteItem) => {
				log.info("cmd", `removeNote invoked: ${item.note.id}`);
				await bridge.removeNote(item.note.id);
				await plansProvider.refresh();
			},
		),

		// History panel
		vscode.commands.registerCommand("jollimemory.refreshHistory", () => {
			historyProvider.refresh().catch(handleError("refreshHistory"));
		}),

		vscode.commands.registerCommand("jollimemory.selectAllCommits", () => {
			historyProvider.toggleSelectAll();
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

		vscode.commands.registerCommand("jollimemory.exportMemories", () => {
			log.info("cmd", "exportMemories invoked");
			// ExportMemoriesCommand.execute() handles its own errors (logs + user-facing toast)
			// and never rejects, so no .catch is needed.
			exportMemoriesCommand.execute();
		}),

		vscode.commands.registerCommand("jollimemory.refreshMemories", () => {
			memoriesProvider.refresh().catch(handleError("refreshMemories"));
		}),

		vscode.commands.registerCommand("jollimemory.searchMemories", async () => {
			const input = await vscode.window.showInputBox({
				prompt: "Filter memories by commit message or branch name",
				placeHolder: "e.g. biome, auth, JOLLI-280...",
				value: memoriesProvider.getFilter(),
			});
			if (input !== undefined) {
				await memoriesProvider.setFilter(input);
			}
		}),

		vscode.commands.registerCommand("jollimemory.clearMemoryFilter", () => {
			memoriesProvider.setFilter("").catch(handleError("clearMemoryFilter"));
		}),

		vscode.commands.registerCommand("jollimemory.loadMoreMemories", () => {
			memoriesProvider.loadMore().catch(handleError("loadMoreMemories"));
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
			SettingsWebviewPanel.show(context.extensionUri, workspaceRoot, () => {
				// Refresh status panel and exclude filter after settings are saved
				statusProvider.refresh().catch(handleError("openSettings.refresh"));
				excludeFilter.load().catch(handleError("openSettings.excludeFilter"));
				filesProvider.refresh().catch(handleError("openSettings.filesRefresh"));
			});
		}),

		// Auth — sign in / sign out via browser-based OAuth flow.
		vscode.commands.registerCommand("jollimemory.signIn", async () => {
			log.info("cmd", "signIn invoked");
			await authService.openSignInPage();
		}),

		vscode.commands.registerCommand("jollimemory.signOut", async () => {
			log.info("cmd", "signOut invoked");
			await authService.signOut();
			statusProvider.refresh().catch(handleError("signOut.refresh"));
		}),
	);

	// ── URI handler ──────────────────────────────────────────────────────────
	// Receives the OAuth callback after browser-based login/signup.
	// URI format: vscode://jolli.jollimemory-vscode/auth-callback?token=...&jolli_api_key=...
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
					vscode.window.showInformationMessage(
						"Signed in to Jolli successfully.",
					);
					statusProvider.refresh().catch(handleError("uriHandler.refresh"));
				} else {
					vscode.window.showErrorMessage(
						`Jolli sign-in failed: ${result.error}`,
					);
				}
			},
		}),
	);

	// Handle file checkbox toggle from the tree view (pure in-memory — no git ops).
	// Badge is updated directly here instead of via _onDidChangeTreeData.fire(),
	// which would cause a full tree rebuild, panel flicker, and focus-border jump.
	// refreshStatusBar is intentionally omitted — checkbox toggles do not change
	// the enabled/disabled state, so re-querying status would only cause needless
	// tree rebuilds in sibling panels.
	filesView.onDidChangeCheckboxState((e) => {
		const items = e.items.map(
			([item, state]) =>
				[
					item as FileItem,
					state === vscode.TreeItemCheckboxState.Checked,
				] as const,
		);
		filesProvider.onCheckboxToggleBatch(items);
		updateFilesBadge();
	});

	// Handle commit checkbox toggle from the tree view.
	// Guard: only process CommitItem nodes (which have a `commit` property).
	// CommitFileItem nodes have no checkboxes but could theoretically arrive here.
	historyView.onDidChangeCheckboxState((e) => {
		for (const [item, state] of e.items) {
			if ("commit" in item && item.commit) {
				historyProvider.onCheckboxToggle(
					item as CommitItem,
					state === vscode.TreeItemCheckboxState.Checked,
				);
			}
		}
	});

	// ── Memories panel: lazy-load on first visibility ─────────────────────────
	// Defer orphan-branch index read until the panel is actually visible.
	// This keeps the activation critical path fast (~0ms overhead).
	let memoriesLazyLoaded = false;
	memoriesView.onDidChangeVisibility((e) => {
		if (e.visible && !memoriesLazyLoaded) {
			memoriesLazyLoaded = true;
			memoriesProvider.refresh().catch(handleError("memoriesView.lazyLoad"));
		}
	});

	// ── Initial data load ────────────────────────────────────────────────────
	initialLoad(
		bridge,
		excludeFilter,
		statusProvider,
		plansProvider,
		filesProvider,
		filesView,
		historyProvider,
		memoriesProvider,
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
				statusProvider.setExtensionOutdated(true);
				vscode.window.showWarningMessage(
					"Jolli Memory: A newer version is available. Please update the extension.",
				);
			}
			// Re-render the status panel to reflect any path refresh that just happened.
			await statusProvider.refresh();
			await refreshStatusBar(
				bridge,
				memoriesProvider,
				plansProvider,
				filesProvider,
				historyProvider,
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
				await statusProvider.refresh();
				await refreshStatusBar(
					bridge,
					memoriesProvider,
					plansProvider,
					filesProvider,
					historyProvider,
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
	statusProvider: StatusTreeProvider,
	plansProvider: PlansTreeProvider,
	filesProvider: FilesTreeProvider,
	filesView: vscode.TreeView<FileItem>,
	historyProvider: HistoryTreeProvider,
	memoriesProvider: MemoriesTreeProvider,
	statusBar: StatusBarManager,
): void {
	log.info("initialLoad", "Loading all panels");
	// Load the exclude filter FIRST so the initial file list is already filtered.
	// If loaded in parallel with filesProvider.refresh(), the tree briefly shows
	// all files (including excluded ones) before the filter kicks in.
	excludeFilter
		.load()
		.then(() =>
			Promise.all([
				statusProvider.refresh(),
				plansProvider.refresh(),
				filesProvider.refresh(),
				historyProvider.refresh(),
			]),
		)
		.then(async () => {
			log.info("initialLoad", "All panels loaded — updating status bar");
			// Set initial context key and description from persisted filter state
			syncExcludeFilterUI(filesProvider, filesView);
			await refreshStatusBar(
				bridge,
				memoriesProvider,
				plansProvider,
				filesProvider,
				historyProvider,
				statusBar,
			);
		})
		.catch((err: unknown) => {
			log.error("initialLoad", "Failed to load panels", err);
		});
}

/**
 * Syncs the exclude filter UI state: updates the tree view description
 * to show how many files are currently hidden by the exclude filter.
 */
function syncExcludeFilterUI(
	filesProvider: FilesTreeProvider,
	filesView: vscode.TreeView<FileItem>,
): void {
	const excludedCount = filesProvider.getExcludedCount();
	filesView.description =
		excludedCount > 0
			? `${excludedCount} file${excludedCount === 1 ? "" : "s"} hidden`
			: undefined;
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
	memoriesProvider: MemoriesTreeProvider,
	plansProvider: PlansTreeProvider,
	filesProvider: FilesTreeProvider,
	historyProvider: HistoryTreeProvider,
	statusBar: StatusBarManager,
): Promise<void> {
	const status = await bridge.getStatus();

	statusBar.update(status.enabled);

	// Propagate the enabled flag to providers so their panels show the
	// viewsWelcome placeholder (empty list) when JolliMemory is disabled.
	memoriesProvider.setEnabled(status.enabled);
	plansProvider.setEnabled(status.enabled);
	filesProvider.setEnabled(status.enabled);
	historyProvider.setEnabled(status.enabled);

	// Update the context key so package.json `when` clauses show the correct icon.
	await vscode.commands.executeCommand(
		"setContext",
		"jollimemory.enabled",
		status.enabled,
	);
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
	statusProvider: StatusTreeProvider,
	historyProvider: HistoryTreeProvider,
	filesProvider: FilesTreeProvider,
): Promise<void> {
	try {
		// Early-return so that no-op cases (most activations) skip the expensive
		// historyProvider.refresh() and migration-state toggling below.
		const needsMigration = await indexNeedsMigration(cwd);
		if (!needsMigration) {
			return;
		}
	} catch (err: unknown) {
		log.error("migrate", "Index migration check failed", err);
		return;
	}

	// Show migration state in all panels
	statusProvider.setMigrating(true);
	historyProvider.setMigrating(true);
	filesProvider.setMigrating(true);

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
		statusProvider.setMigrating(false);
		historyProvider.setMigrating(false);
		filesProvider.setMigrating(false);

		// Refresh providers so history reflects the migrated data
		await Promise.all([statusProvider.refresh(), historyProvider.refresh()]);
	}
}

/**
 * Migrates legacy v1 summaries to v3 tree format if a v1 orphan branch exists.
 * Sets all providers to "migrating" state during the operation, then refreshes
 * status and history providers afterwards so counts are correct.
 */
async function migrateV1IfNeeded(
	cwd: string,
	statusProvider: StatusTreeProvider,
	historyProvider: HistoryTreeProvider,
	filesProvider: FilesTreeProvider,
): Promise<void> {
	try {
		// Early-return so that no-op cases (most activations) skip the expensive
		// historyProvider.refresh() and migration-state toggling below.
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
	statusProvider.setMigrating(true);
	historyProvider.setMigrating(true);
	filesProvider.setMigrating(true);

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
		statusProvider.setMigrating(false);
		historyProvider.setMigrating(false);
		filesProvider.setMigrating(false);

		// Refresh providers so counts reflect the migrated data.
		await Promise.all([statusProvider.refresh(), historyProvider.refresh()]);
	}
}
