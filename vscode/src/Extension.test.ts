import { normalize } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ─────────────────────────────────────────────────────────

const { getWorkspaceRoot, resolveCLIPath } = vi.hoisted(() => ({
	getWorkspaceRoot: vi.fn(),
	resolveCLIPath: vi.fn(),
}));

const {
	info,
	warn,
	error,
	debug,
	initLogger,
	dispose: logDispose,
} = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	initLogger: vi.fn(),
	dispose: vi.fn(),
}));

const { mockNotifyApiKeySaveError } = vi.hoisted(() => ({
	mockNotifyApiKeySaveError: vi.fn(),
}));

const { isWorkerBusy } = vi.hoisted(() => ({
	isWorkerBusy: vi.fn(),
}));

const { loadConfig, getGlobalConfigDir, saveConfig, saveConfigScoped } =
	vi.hoisted(() => ({
		loadConfig: vi.fn(),
		getGlobalConfigDir: vi.fn(() => "/home/user/.jolli/jollimemory"),
		saveConfig: vi.fn(),
		saveConfigScoped: vi.fn(),
	}));

const {
	cleanupV1IfExpired,
	hasMigrationMeta,
	hasV1Branch,
	migrateV1toV3,
	writeMigrationMeta,
} = vi.hoisted(() => ({
	cleanupV1IfExpired: vi.fn(),
	hasMigrationMeta: vi.fn(),
	hasV1Branch: vi.fn(),
	migrateV1toV3: vi.fn(),
	writeMigrationMeta: vi.fn(),
}));

const {
	indexNeedsMigration,
	migrateIndexToV3,
	readPlanFromBranch,
	readNoteFromBranch,
} = vi.hoisted(() => ({
	indexNeedsMigration: vi.fn(),
	migrateIndexToV3: vi.fn(),
	readNoteFromBranch: vi.fn(),
	readPlanFromBranch: vi.fn(),
}));

const {
	addPlanToRegistry,
	getPlansDir,
	isPlanFromCurrentProject,
	listAvailablePlans,
	registerNewPlan,
} = vi.hoisted(() => ({
	addPlanToRegistry: vi.fn(),
	getPlansDir: vi.fn(() => "/home/user/.claude/plans"),
	// Default: attribution check passes (backward-compat for existing tests
	// that don't explicitly exercise the cross-project gate).
	isPlanFromCurrentProject: vi.fn(async () => true),
	listAvailablePlans: vi.fn(() => []),
	registerNewPlan: vi.fn(),
}));

const { formatShortRelativeDate } = vi.hoisted(() => ({
	formatShortRelativeDate: vi.fn(() => "2d ago"),
}));

const { getNotesDir } = vi.hoisted(() => ({
	getNotesDir: vi.fn(() => "/test/workspace/.jolli/jollimemory/notes"),
}));

const { homedir } = vi.hoisted(() => ({
	homedir: vi.fn(() => "/home/user"),
}));

const { existsSync, readFileSync } = vi.hoisted(() => ({
	existsSync: vi.fn(() => true),
	// Default: throw ENOENT for every read so parseSummaryFrontmatter's
	// readFileSync catch fires and returns null — matches the existing
	// openMemoryFile tests that pass non-existent paths. Individual tests
	// inside the parseSummaryFrontmatter describe block override per-call.
	readFileSync: vi.fn(() => {
		const err = new Error("ENOENT") as Error & { code: string };
		err.code = "ENOENT";
		throw err;
	}),
}));

const { buildClaudeCodeContext } = vi.hoisted(() => ({
	buildClaudeCodeContext: vi.fn(() => "mock recall context"),
}));

const { execSync, execFileSync } = vi.hoisted(() => ({
	// Mock git rev-parse --git-path calls used by resolveGitPath() in Extension.ts.
	// Returns realistic paths so HEAD and orphan-ref watchers are created in tests,
	// preserving the createFileSystemWatcher mock call order.
	execSync: vi.fn((cmd: string) => {
		if (cmd.includes("rev-parse --git-path HEAD")) {
			return Buffer.from("/test/workspace/.git/HEAD\n");
		}
		if (cmd.includes("rev-parse --git-path refs/heads/")) {
			return Buffer.from(
				"/test/workspace/.git/refs/heads/__jolli_orphan_branch__\n",
			);
		}
		throw new Error(`Unmocked exec: ${cmd}`);
	}),
	// Used by the no-git Initialize Git path. Default impl throws so unmocked
	// calls fail loudly; the no-git tests override .mockImplementation per case.
	execFileSync: vi.fn((bin: string, args: ReadonlyArray<string>) => {
		throw new Error(`Unmocked execFile: ${bin} ${args.join(" ")}`);
	}),
}));

// ─── Mock classes (hoisted so vi.mock factories can reference them) ─────────

const {
	mockStatusProvider,
	mockPlansProvider,
	mockFilesProvider,
	mockHistoryProvider,
	mockMemoriesProvider,
	MockFilesTreeProvider,
	MockHistoryTreeProvider,
	MockMemoriesTreeProvider,
	MockPlansTreeProvider,
	MockStatusTreeProvider,
	mockStatusBar,
	MockStatusBarManager,
	mockExcludeFilter,
	MockExcludeFilterManager,
	mockBridge,
	MockJolliMemoryBridge,
	mockCommitCommand,
	MockCommitCommand,
	mockPushCommand,
	MockPushCommand,
	mockSquashCommand,
	MockSquashCommand,
	MockSummaryWebviewPanel,
	MockSettingsWebviewPanel,
	MockNoteEditorWebviewPanel,
	mockAuthService,
	MockAuthService,
} = vi.hoisted(() => {
	function makeMockProvider() {
		return {
			refresh: vi.fn().mockResolvedValue(undefined),
			setEnabled: vi.fn(),
			setMigrating: vi.fn(),
			setWorkerBusy: vi.fn(),
			setHistoryProvider: vi.fn(),
			setExtensionOutdated: vi.fn(),
			dispose: vi.fn(),
			onDidChangeTreeData: vi.fn(),
			getVisibleFileCount: vi.fn(() => 0),
			getSelectedFiles: vi.fn(() => []),
			getExcludedCount: vi.fn(() => 0),
			toggleSelectAll: vi.fn().mockResolvedValue(undefined),
			onCheckboxToggle: vi.fn().mockResolvedValue(undefined),
			onCheckboxToggleBatch: vi.fn().mockResolvedValue(undefined),
			deselectPaths: vi.fn(),
			isMerged: false,
			getSelectionDebugInfo: vi.fn(() => ({ checkedHashes: [] })),
		};
	}

	const mockStatusProvider_ = makeMockProvider();
	const mockPlansProvider_ = makeMockProvider();
	const mockFilesProvider_ = makeMockProvider();
	const mockHistoryProvider_ = {
		...makeMockProvider(),
		serialize: vi.fn().mockResolvedValue([]),
		getMode: vi.fn(() => "empty" as const),
	};
	const mockMemoriesProvider_ = {
		...makeMockProvider(),
		setView: vi.fn(),
		setFilter: vi.fn().mockResolvedValue(undefined),
		getFilter: vi.fn(() => ""),
		loadMore: vi.fn().mockResolvedValue(undefined),
		ensureFirstLoad: vi.fn().mockResolvedValue(undefined),
		hasFirstLoaded: vi.fn(() => false),
	};

	const mockStatusBar_ = { update: vi.fn(), dispose: vi.fn() };

	const mockExcludeFilter_ = {
		load: vi.fn().mockResolvedValue(undefined),
		hasPatterns: vi.fn(() => false),
		isExcluded: vi.fn(() => false),
		toPatternsString: vi.fn(() => ""),
		setPatterns: vi.fn().mockResolvedValue(undefined),
	};

	const mockBridge_ = {
		enable: vi.fn().mockResolvedValue({ success: true }),
		disable: vi.fn().mockResolvedValue({ success: true }),
		getStatus: vi.fn().mockResolvedValue({ enabled: true }),
		getSummary: vi.fn().mockResolvedValue(null),
		// Cross-repo Timeline / Memory Bank lookup. Defaults to null so
		// existing tests that never assigned a return keep their "summary
		// missing" semantics; tests that exercise the rich panel set this
		// alongside (or instead of) getSummary depending on the call site.
		getSummaryAnyRepo: vi.fn().mockResolvedValue(null),
		// Provenance variant — viewMemorySummary uses this so the panel
		// can disable destructive actions for foreign-origin summaries.
		// Default sourceRepoName=null preserves the legacy "local panel"
		// semantics for tests that don't care about provenance.
		getSummaryAnyRepoWithSource: vi.fn().mockResolvedValue({
			summary: null,
			sourceRepoName: null,
			sourceRemoteUrl: null,
		}),
		listPlans: vi.fn().mockResolvedValue([]),
		removePlan: vi.fn().mockResolvedValue(undefined),
		listNotes: vi.fn().mockResolvedValue([]),
		removeNote: vi.fn().mockResolvedValue(undefined),
		saveNote: vi
			.fn()
			.mockResolvedValue({ id: "note-1", filePath: "/test/notes/note.md" }),
		unstageFiles: vi.fn().mockResolvedValue(undefined),
		discardFiles: vi.fn().mockResolvedValue(undefined),
		refreshHookPathsIfStale: vi.fn().mockResolvedValue(undefined),
		autoInstallForWorktree: vi.fn().mockResolvedValue(undefined),
		listSummaryEntries: vi
			.fn()
			.mockResolvedValue({ entries: [], totalCount: 0 }),
		invalidateEntriesCache: vi.fn(),
		getCurrentBranch: vi.fn().mockResolvedValue("main"),
		reloadStorage: vi.fn(),
	};

	const mockCommitCommand_ = { execute: vi.fn().mockResolvedValue(undefined) };
	const mockPushCommand_ = { execute: vi.fn().mockResolvedValue(undefined) };
	const mockSquashCommand_ = { execute: vi.fn().mockResolvedValue(undefined) };
	const mockAuthService_ = {
		handleAuthCallback: vi.fn().mockResolvedValue({ success: true }),
		signOut: vi.fn().mockResolvedValue(undefined),
		openSignInPage: vi.fn(),
		isSignedIn: vi.fn(() => false),
		refreshContextKey: vi.fn(),
	};

	return {
		mockStatusProvider: mockStatusProvider_,
		mockPlansProvider: mockPlansProvider_,
		mockFilesProvider: mockFilesProvider_,
		mockHistoryProvider: mockHistoryProvider_,
		mockMemoriesProvider: mockMemoriesProvider_,
		MockFilesTreeProvider: vi.fn(function MockFilesTreeProvider() {
			return mockFilesProvider_;
		}),
		MockHistoryTreeProvider: vi.fn(function MockHistoryTreeProvider() {
			return mockHistoryProvider_;
		}),
		MockMemoriesTreeProvider: vi.fn(function MockMemoriesTreeProvider() {
			return mockMemoriesProvider_;
		}),
		MockPlansTreeProvider: vi.fn(function MockPlansTreeProvider() {
			return mockPlansProvider_;
		}),
		MockStatusTreeProvider: vi.fn(function MockStatusTreeProvider() {
			return mockStatusProvider_;
		}),
		mockStatusBar: mockStatusBar_,
		MockStatusBarManager: vi.fn(function MockStatusBarManager() {
			return mockStatusBar_;
		}),
		mockExcludeFilter: mockExcludeFilter_,
		MockExcludeFilterManager: vi.fn(function MockExcludeFilterManager() {
			return mockExcludeFilter_;
		}),
		mockBridge: mockBridge_,
		MockJolliMemoryBridge: vi.fn(function MockJolliMemoryBridge() {
			return mockBridge_;
		}),
		mockCommitCommand: mockCommitCommand_,
		MockCommitCommand: vi.fn(function MockCommitCommand() {
			return mockCommitCommand_;
		}),
		mockPushCommand: mockPushCommand_,
		MockPushCommand: vi.fn(function MockPushCommand() {
			return mockPushCommand_;
		}),
		mockSquashCommand: mockSquashCommand_,
		MockSquashCommand: vi.fn(function MockSquashCommand() {
			return mockSquashCommand_;
		}),
		MockSummaryWebviewPanel: { show: vi.fn().mockResolvedValue(undefined) },
		MockSettingsWebviewPanel: {
			show: vi.fn(),
			notifyAuthChanged: vi.fn().mockResolvedValue(undefined),
		},
		MockNoteEditorWebviewPanel: { show: vi.fn() },
		mockAuthService: mockAuthService_,
		MockAuthService: vi.fn(function MockAuthService() {
			return mockAuthService_;
		}),
	};
});

// ─── Command map — captures registerCommand callbacks ───────────────────────

const commandMap = new Map<string, (...args: Array<unknown>) => unknown>();

// ─── SidebarWebviewProvider deps capture ──────────────────────────────────────

let sidebarDepsCaptured: unknown;

// ─── VSCode API mocks ─────────────────────────────────────────────────────────

const {
	showWarningMessage,
	showErrorMessage,
	showInformationMessage,
	showInputBox,
	showQuickPick,
	showTextDocument,
	showOpenDialog,
	createTreeView,
	registerWebviewViewProvider,
	createFileSystemWatcher,
	executeCommand,
	registerCommand,
	registerTextDocumentContentProvider,
	openTextDocument,
	onDidSaveTextDocument,
	checkboxCallbacks,
	visibilityCallbacks,
	openExternal,
} = vi.hoisted(() => {
	/** Stores callbacks keyed by tree view ID so tests can trigger checkbox events */
	const checkboxCallbacks_ = new Map<
		string,
		(...args: Array<unknown>) => unknown
	>();
	/** Stores callbacks keyed by tree view ID so tests can trigger visibility events */
	const visibilityCallbacks_ = new Map<
		string,
		(...args: Array<unknown>) => unknown
	>();

	return {
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showInputBox: vi.fn(),
		showQuickPick: vi.fn(),
		showTextDocument: vi.fn(),
		showOpenDialog: vi.fn(),
		createTreeView: vi.fn((id: string) => ({
			title: "",
			badge: undefined,
			description: undefined,
			onDidChangeCheckboxState: vi.fn(
				(cb: (...args: Array<unknown>) => unknown) => {
					checkboxCallbacks_.set(id, cb);
				},
			),
			onDidChangeVisibility: vi.fn(
				(cb: (...args: Array<unknown>) => unknown) => {
					visibilityCallbacks_.set(id, cb);
				},
			),
			dispose: vi.fn(),
		})),
		createFileSystemWatcher: vi.fn(() => ({
			// VSCode's Event<T> returns a Disposable when subscribed; match that
			// shape so code pushing the result into context.subscriptions gets a
			// usable object back.
			onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
			onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
			onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
			dispose: vi.fn(),
		})),
		executeCommand: vi.fn().mockResolvedValue(undefined),
		registerCommand: vi.fn(
			(_id: string, _cb: (...args: Array<unknown>) => unknown) => ({
				dispose: vi.fn(),
			}),
		),
		registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
		registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
		openTextDocument: vi.fn().mockResolvedValue({ uri: "mock-doc" }),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		checkboxCallbacks: checkboxCallbacks_,
		visibilityCallbacks: visibilityCallbacks_,
		openExternal: vi.fn().mockResolvedValue(true),
	};
});

// ─── vi.mock() calls ───────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
	execSync,
	execFileSync,
	// execFile is reached transitively through OrphanBranchStorage in the
	// rebuildKnowledgeBase command path. Tests don't exercise that path, so a
	// throwing stub is enough — it just needs to exist as an export.
	execFile: () => {
		throw new Error("execFile not mocked in Extension.test.ts");
	},
}));

vi.mock("vscode", () => ({
	TreeItem: class {},
	TreeItemCollapsibleState: { None: 0 },
	TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
	ThemeIcon: class {
		id: string;
		constructor(id: string) {
			this.id = id;
		}
	},
	EventEmitter: class {
		event = vi.fn();
		fire = vi.fn();
		dispose = vi.fn();
	},
	MarkdownString: class {
		value: string;
		constructor(value = "") {
			this.value = value;
		}
		isTrusted = false;
	},
	Uri: {
		file: vi.fn((p: string) => ({ fsPath: p, scheme: "file", with: vi.fn() })),
		from: vi.fn((parts: { scheme: string; path: string; query?: string }) => ({
			scheme: parts.scheme,
			path: parts.path,
			query: parts.query,
			toString: () =>
				`${parts.scheme}:${parts.path}${parts.query ? `?${parts.query}` : ""}`,
		})),
		parse: vi.fn((s: string) => ({
			toString: () => s,
			scheme: "jollimemory-plan",
		})),
	},
	RelativePattern: vi.fn(),
	window: {
		showWarningMessage,
		showErrorMessage,
		showInformationMessage,
		showInputBox,
		showQuickPick,
		showTextDocument,
		showOpenDialog,
		createTreeView,
		registerWebviewViewProvider,
		createOutputChannel: vi.fn(() => ({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		})),
		registerFileDecorationProvider: vi.fn(() => ({ dispose: vi.fn() })),
		registerUriHandler: vi.fn(() => ({ dispose: vi.fn() })),
		// Pass-through Progress mock — runs the user's callback so commands that
		// wrap work in `vscode.window.withProgress(...)` (e.g. SquashCommand's LLM
		// call) actually execute that work in tests instead of silently no-oping.
		withProgress: vi.fn(
			async (
				_options: unknown,
				task: (p: { report: (x: unknown) => void }) => Promise<unknown>,
			) => {
				return task({ report: vi.fn() });
			},
		),
	},
	ProgressLocation: { Notification: 15 },
	workspace: {
		registerTextDocumentContentProvider,
		createFileSystemWatcher,
		openTextDocument,
		onDidSaveTextDocument,
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
			update: vi.fn(),
		})),
	},
	commands: {
		executeCommand,
		registerCommand,
	},
	env: {
		clipboard: {
			writeText: vi.fn().mockResolvedValue(undefined),
		},
		openExternal,
		appName: "Visual Studio Code",
	},
}));

vi.mock("../../cli/src/core/SessionTracker.js", () => ({
	loadConfig,
	getGlobalConfigDir,
	saveConfig,
	saveConfigScoped,
}));

vi.mock("../../cli/src/core/SummaryMigration.js", () => ({
	cleanupV1IfExpired,
	hasMigrationMeta,
	hasV1Branch,
	migrateV1toV3,
	writeMigrationMeta,
}));

vi.mock("../../cli/src/core/SummaryStore.js", () => ({
	indexNeedsMigration,
	migrateIndexToV3,
	readNoteFromBranch,
	readPlanFromBranch,
}));

// Mock the KB folder-mode dependencies so the auto-migration path in `activate`
// and the rebuildKnowledgeBase command run with predictable, side-effect-free
// stand-ins. Each test that exercises those paths overrides the relevant helper
// via `vi.mocked(...).mockReturnValueOnce`.
vi.mock("../../cli/src/core/KBPathResolver.js", () => ({
	extractRepoName: vi.fn(() => "test-repo"),
	getRemoteUrl: vi.fn(() => null),
	resolveKBPath: vi.fn(() => "/test/kb"),
	resolveKbParent: vi.fn(() => "/test/kb-parent"),
	findFreshKBPath: vi.fn(() => "/test/kb-2"),
	initializeKBFolder: vi.fn(),
}));

const {
	mockMetadataManagerInstance,
	mockOrphanInstance,
	mockFolderStorageInstance,
	mockMigrationEngineInstance,
} = vi.hoisted(() => {
	const meta = {
		readMigrationState: vi.fn(() => null),
		readConfig: vi.fn(() => ({})),
		saveConfig: vi.fn(),
	};
	const orphan = { exists: vi.fn(async () => false) };
	const folder = { ensure: vi.fn(async () => undefined) };
	const engine = {
		runMigration: vi.fn(async () => ({
			status: "completed" as const,
			migratedEntries: 0,
			totalEntries: 0,
		})),
		runStaleChildCleanup: vi.fn(async () => ({
			status: "completed" as const,
			migratedEntries: 0,
			totalEntries: 0,
			staleChildCleanup: { completedAt: "2026-05-12T00:00:00Z" },
		})),
	};
	return {
		mockMetadataManagerInstance: meta,
		mockOrphanInstance: orphan,
		mockFolderStorageInstance: folder,
		mockMigrationEngineInstance: engine,
	};
});

vi.mock("../../cli/src/core/MetadataManager.js", () => ({
	MetadataManager: vi.fn(function MockMetadataManager() {
		return mockMetadataManagerInstance;
	}),
}));

vi.mock("../../cli/src/core/OrphanBranchStorage.js", () => ({
	OrphanBranchStorage: vi.fn(function MockOrphanBranchStorage() {
		return mockOrphanInstance;
	}),
}));

vi.mock("../../cli/src/core/FolderStorage.js", () => ({
	FolderStorage: vi.fn(function MockFolderStorage() {
		return mockFolderStorageInstance;
	}),
}));

vi.mock("../../cli/src/core/MigrationEngine.js", () => ({
	MigrationEngine: vi.fn(function MockMigrationEngine() {
		return mockMigrationEngineInstance;
	}),
}));

vi.mock("../../cli/src/Logger.js", () => ({
	ORPHAN_BRANCH: "jollimemory",
	createLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	})),
	getJolliMemoryDir: vi.fn((cwd: string) => `${cwd}/.jolli/jollimemory`),
}));

vi.mock("./commands/CommitCommand.js", () => ({
	CommitCommand: MockCommitCommand,
}));

vi.mock("./commands/PushCommand.js", () => ({
	PushCommand: MockPushCommand,
}));

vi.mock("./commands/SquashCommand.js", () => ({
	SquashCommand: MockSquashCommand,
}));

vi.mock("./core/PlanService.js", () => ({
	addPlanToRegistry,
	getPlansDir,
	isPlanFromCurrentProject,
	listAvailablePlans,
	registerNewPlan,
}));

vi.mock("./core/NoteService.js", () => ({
	getNotesDir,
}));

vi.mock("./util/FormatUtils.js", () => ({
	formatShortRelativeDate,
}));

vi.mock("./JolliMemoryBridge.js", () => ({
	JolliMemoryBridge: MockJolliMemoryBridge,
}));

vi.mock("./providers/FilesTreeProvider.js", () => ({
	FilesTreeProvider: MockFilesTreeProvider,
}));

vi.mock("./providers/HistoryTreeProvider.js", () => ({
	HistoryTreeProvider: MockHistoryTreeProvider,
	CommitFileDecorationProvider: vi.fn(),
}));

vi.mock("./providers/MemoriesTreeProvider.js", () => ({
	MemoriesTreeProvider: MockMemoriesTreeProvider,
}));

vi.mock("./providers/PlansTreeProvider.js", () => ({
	PlansTreeProvider: MockPlansTreeProvider,
}));

vi.mock("./providers/StatusTreeProvider.js", () => ({
	StatusTreeProvider: MockStatusTreeProvider,
}));

// Store mocks — keep activation watcher-index-order stable by preventing
// real FilesStore/other stores from creating FileSystemWatchers or making
// bridge calls during activation.
const {
	mockFilesStore,
	mockCommitsStore,
	mockPlansStore,
	mockMemoriesStore,
	mockStatusStore,
} = vi.hoisted(() => {
	function makeStoreMock() {
		return {
			getSnapshot: vi.fn(() => ({
				changeReason: "init",
				visibleCount: 0,
				visibleFiles: [],
				selectedFiles: [],
				isEmpty: true,
				isMerged: false,
				filter: "",
				entriesCount: 0,
				totalCount: 0,
				isMigrating: false,
				isEnabled: true,
			})),
			onChange: vi.fn(() => () => {
				/* unsubscribe */
			}),
			refresh: vi.fn().mockResolvedValue(undefined),
			applyCheckboxBatch: vi.fn(),
			applyExcludeFilterChange: vi.fn(),
			toggleSelectAll: vi.fn(),
			deselectPaths: vi.fn(),
			setEnabled: vi.fn(),
			setMigrating: vi.fn(),
			setWorkerBusy: vi.fn(),
			setExtensionOutdated: vi.fn(),
			setStatus: vi.fn(),
			setMainBranch: vi.fn(),
			getMainBranch: vi.fn(() => "main"),
			setFilter: vi.fn().mockResolvedValue(undefined),
			getFilter: vi.fn(() => ""),
			loadMore: vi.fn().mockResolvedValue(undefined),
			ensureFirstLoad: vi.fn().mockResolvedValue(undefined),
			hasFirstLoaded: vi.fn(() => false),
			onCheckboxToggle: vi.fn(),
			getSelectionDebugInfo: vi.fn(() => ({})),
			getCommitFiles: vi.fn().mockResolvedValue([]),
			getNotesDir: vi.fn(() => "/test/workspace/.jolli/jollimemory/notes"),
			refreshFromExternalNoteSave: vi.fn(),
			dispose: vi.fn(),
		};
	}
	const mockFilesStore = makeStoreMock();
	const mockCommitsStore = makeStoreMock();
	const mockPlansStore = makeStoreMock();
	const mockMemoriesStore = makeStoreMock();
	const mockStatusStore = makeStoreMock();
	return {
		mockFilesStore,
		mockCommitsStore,
		mockPlansStore,
		mockMemoriesStore,
		mockStatusStore,
	};
});

vi.mock("./stores/FilesStore.js", () => ({
	FilesStore: vi.fn(function FilesStore() {
		return mockFilesStore;
	}),
}));
vi.mock("./stores/CommitsStore.js", () => ({
	CommitsStore: vi.fn(function CommitsStore() {
		return mockCommitsStore;
	}),
}));
vi.mock("./stores/MemoriesStore.js", () => ({
	MemoriesStore: vi.fn(function MemoriesStore() {
		return mockMemoriesStore;
	}),
}));
vi.mock("./stores/PlansStore.js", () => ({
	PlansStore: vi.fn(function PlansStore() {
		return mockPlansStore;
	}),
}));
vi.mock("./stores/StatusStore.js", () => ({
	StatusStore: vi.fn(function StatusStore() {
		return mockStatusStore;
	}),
}));

vi.mock("./util/ExcludeFilterManager.js", () => ({
	ExcludeFilterManager: MockExcludeFilterManager,
}));

vi.mock("./util/LockUtils.js", () => ({
	isWorkerBusy,
}));

vi.mock("./util/Logger.js", () => ({
	initLogger,
	log: { info, warn, error, debug, dispose: logDispose },
}));

vi.mock("./util/StatusBarManager.js", () => ({
	StatusBarManager: MockStatusBarManager,
}));

vi.mock("./util/WorkspaceUtils.js", () => ({
	getWorkspaceRoot,
	resolveCLIPath,
}));

vi.mock("./views/SidebarWebviewProvider.js", () => ({
	SidebarWebviewProvider: class {
		static viewId = "jollimemory.mainView";
		constructor(deps: unknown) {
			sidebarDepsCaptured = deps;
		}
		resolveWebviewView() {}
		dispose() {}
		refreshKnowledgeBaseFolders() {}
		notifyEnabledChanged() {}
		notifyAuthChanged() {}
		notifyConfiguredChanged() {}
		setBadge() {}
		// Tracked via a shared vi.fn so saveAnthropicApiKey-error tests can
		// assert the failure-path message routing without needing access to
		// the constructed instance.
		notifyApiKeySaveError = mockNotifyApiKeySaveError;
	},
}));

vi.mock("./views/SummaryWebviewPanel.js", () => ({
	SummaryWebviewPanel: MockSummaryWebviewPanel,
}));

vi.mock("./views/SettingsWebviewPanel.js", () => ({
	SettingsWebviewPanel: MockSettingsWebviewPanel,
}));

vi.mock("./views/NoteEditorWebviewPanel.js", () => ({
	NoteEditorWebviewPanel: MockNoteEditorWebviewPanel,
}));

vi.mock("./views/SummaryMarkdownBuilder.js", () => ({
	buildClaudeCodeContext,
}));

vi.mock("./services/AuthService.js", () => ({
	AuthService: MockAuthService,
}));

const { readManualDisableFlag, writeManualDisableFlag } = vi.hoisted(() => ({
	readManualDisableFlag: vi.fn(async () => false),
	writeManualDisableFlag: vi.fn(async () => undefined),
}));

vi.mock("./services/ManualDisableFlag.js", () => ({
	readManualDisableFlag,
	writeManualDisableFlag,
}));

vi.mock("node:os", () => ({
	homedir,
}));

vi.mock("node:fs", () => ({
	existsSync,
	readFileSync,
}));

// ─── Import under test ─────────────────────────────────────────────────────

import * as vscode from "vscode";
import { activate, deactivate } from "./Extension.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Creates a minimal mock ExtensionContext. */
function makeContext(): vscode.ExtensionContext {
	return {
		subscriptions: [],
		extensionPath: "/mock/extension/path",
		extensionUri: vscode.Uri.file("/mock/extension/path"),
		globalState: {
			get: vi.fn(),
			update: vi.fn(),
			keys: vi.fn(() => []),
			setKeysForSync: vi.fn(),
		},
		workspaceState: {
			get: vi.fn(),
			update: vi.fn(),
			keys: vi.fn(() => []),
		},
		secrets: {
			get: vi.fn(),
			store: vi.fn(),
			delete: vi.fn(),
			onDidChange: vi.fn(),
		},
		storageUri: vscode.Uri.file("/mock/storage"),
		globalStorageUri: vscode.Uri.file("/mock/global-storage"),
		extensionMode: 1,
		environmentVariableCollection: {
			replace: vi.fn(),
			append: vi.fn(),
			prepend: vi.fn(),
			get: vi.fn(),
			forEach: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn(),
			[Symbol.iterator]: vi.fn(),
			persistent: true,
			description: "",
			getScoped: vi.fn(),
		} as unknown as vscode.GlobalEnvironmentVariableCollection,
		storagePath: "/mock/storage",
		globalStoragePath: "/mock/global-storage",
		logUri: vscode.Uri.file("/mock/log"),
		logPath: "/mock/log",
		asAbsolutePath: vi.fn((p: string) => `/mock/extension/path/${p}`),
		extension: {} as never,
		languageModelAccessInformation: {} as never,
	} as unknown as vscode.ExtensionContext;
}

/**
 * Retrieves a registered command callback from the command map.
 * The command map is populated by the mocked `commands.registerCommand`.
 */
function getRegisteredCommand(
	id: string,
): (...args: Array<unknown>) => unknown {
	// Access the internal map from the hoisted scope
	const cmd = commandMap.get(id);
	if (!cmd) {
		throw new Error(`Command "${id}" was not registered`);
	}
	return cmd;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Extension", () => {
	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks();
		commandMap.clear();
		checkboxCallbacks.clear();
		visibilityCallbacks.clear();
		sidebarDepsCaptured = undefined;

		// Populate the local commandMap from the hoisted closure
		registerCommand.mockImplementation(
			(id: string, cb: (...args: Array<unknown>) => unknown) => {
				commandMap.set(id, cb);
				return { dispose: vi.fn() };
			},
		);

		// Default: workspace exists and CLI is found
		getWorkspaceRoot.mockReturnValue("/test/workspace");
		resolveCLIPath.mockReturnValue("/mock/extension/path/dist/Cli.js");

		// Default: no migrations needed
		hasV1Branch.mockResolvedValue(false);
		hasMigrationMeta.mockResolvedValue(false);
		indexNeedsMigration.mockResolvedValue(false);
		cleanupV1IfExpired.mockResolvedValue(undefined);
		isWorkerBusy.mockResolvedValue(false);
		loadConfig.mockResolvedValue({});

		// Reset provider mocks to defaults
		for (const p of [
			mockStatusProvider,
			mockPlansProvider,
			mockFilesProvider,
			mockHistoryProvider,
		]) {
			p.refresh.mockResolvedValue(undefined);
			p.setEnabled.mockClear();
			p.setMigrating.mockClear();
			p.setWorkerBusy.mockClear();
		}
		mockMemoriesStore.refresh.mockResolvedValue(undefined);
		mockMemoriesStore.setEnabled.mockClear();
		mockMemoriesProvider.setView.mockClear();
		mockBridge.getStatus.mockResolvedValue({ enabled: true });
		mockBridge.enable.mockResolvedValue({ success: true });
		mockBridge.disable.mockResolvedValue({ success: true });
		mockBridge.refreshHookPathsIfStale.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// ── activate: early returns ───────────────────────────────────────────

	describe("activate — no workspace root", () => {
		it("registers no-op commands and returns early", () => {
			getWorkspaceRoot.mockReturnValue(undefined);
			const ctx = makeContext();

			activate(ctx);

			// Should register stub commands so buttons don't throw "command not found"
			expect(registerCommand).toHaveBeenCalled();
			expect(ctx.subscriptions.length).toBeGreaterThan(0);
		});
	});

	describe("activate — resolveCLIPath no longer affects activation", () => {
		it("still registers commands without showing a warning", () => {
			resolveCLIPath.mockReturnValue(undefined);
			const ctx = makeContext();

			activate(ctx);

			expect(showWarningMessage).not.toHaveBeenCalled();
			expect(registerCommand).toHaveBeenCalled();
			expect(MockJolliMemoryBridge).toHaveBeenCalledWith("/test/workspace");
		});
	});

	describe("activate — resolveGitPath failure (git-less workspace)", () => {
		it("warns but keeps activating when rev-parse --git-path fails", () => {
			// Throw for all resolveGitPath queries → both HEAD and orphan-ref watchers
			// skip creation, hitting the `else` branches that log auto-refresh-disabled warnings.
			execSync.mockImplementation(() => {
				throw new Error("not a git repo");
			});
			const ctx = makeContext();

			activate(ctx);

			const warnCalls = warn.mock.calls.map((c) => c.join(" "));
			expect(
				warnCalls.some((s) => s.includes("Could not resolve git HEAD path")),
			).toBe(true);
			expect(
				warnCalls.some((s) => s.includes("Could not resolve orphan ref path")),
			).toBe(true);
			// Activation still registers commands
			expect(registerCommand).toHaveBeenCalled();
		});

		it("resolves non-absolute git-paths against cwd", () => {
			// Returns a relative path → covers the `isAbsolute(out) ? out : resolve(cwd, out)` right branch.
			execSync.mockImplementation((cmd: string) => {
				if (cmd.includes("rev-parse --git-path HEAD")) {
					return Buffer.from(".git/HEAD\n");
				}
				if (cmd.includes("rev-parse --git-path refs/heads/")) {
					return Buffer.from(".git/refs/heads/__jolli_orphan_branch__\n");
				}
				throw new Error(`Unmocked exec: ${cmd}`);
			});
			const ctx = makeContext();

			activate(ctx);

			// Activation should succeed even with relative git paths
			expect(registerCommand).toHaveBeenCalled();
		});
	});

	// ── activate: normal activation ───────────────────────────────────────

	describe("activate — normal activation", () => {
		it("creates providers and pushes disposables to context.subscriptions", () => {
			const ctx = makeContext();

			activate(ctx);

			// Providers are now constructed with their backing Store (one
			// positional argument), not the bridge directly.  The store mocks
			// are thin — we just assert the provider constructors were called
			// and context subscriptions accumulated.
			expect(MockStatusTreeProvider).toHaveBeenCalled();
			expect(MockPlansTreeProvider).toHaveBeenCalled();
			expect(MockFilesTreeProvider).toHaveBeenCalled();
			expect(MockHistoryTreeProvider).toHaveBeenCalled();
			expect(MockMemoriesTreeProvider).toHaveBeenCalled();
			expect(ctx.subscriptions.length).toBeGreaterThan(0);
		});

		it("creates StatusBarManager", () => {
			const ctx = makeContext();

			activate(ctx);

			expect(MockStatusBarManager).toHaveBeenCalled();
		});

		it("disposes the status bar via the subscription wrapper", () => {
			const ctx = makeContext();

			activate(ctx);
			for (const subscription of ctx.subscriptions) {
				subscription.dispose?.();
			}

			expect(mockStatusBar.dispose).toHaveBeenCalled();
		});

		it("creates CommitCommand, PushCommand, and SquashCommand", () => {
			const ctx = makeContext();

			activate(ctx);

			// Commands are now constructed with stores (not providers).
			expect(MockCommitCommand).toHaveBeenCalledWith(
				mockBridge,
				mockFilesStore,
				mockCommitsStore,
				mockStatusStore,
				mockStatusBar,
				"/test/workspace",
			);
			expect(MockSquashCommand).toHaveBeenCalled();
			expect(MockPushCommand).toHaveBeenCalled();
		});

		it("registers a webview view provider for the main sidebar view", () => {
			const ctx = makeContext();

			activate(ctx);

			expect(registerWebviewViewProvider).toHaveBeenCalledWith(
				"jollimemory.mainView",
				expect.any(Object),
			);
		});

		it("wires applyFileCheckbox to filesStore.applyCheckboxBatch", () => {
			const ctx = makeContext();

			activate(ctx);

			expect(sidebarDepsCaptured.applyFileCheckbox).toBeDefined();
			sidebarDepsCaptured.applyFileCheckbox("src/foo.ts", true);
			expect(mockFilesStore.applyCheckboxBatch).toHaveBeenCalledWith([
				["src/foo.ts", true],
			]);
		});

		it("registers all expected commands", () => {
			const ctx = makeContext();

			activate(ctx);

			const expectedCommands = [
				"jollimemory.refreshStatus",
				"jollimemory.enableJolliMemory",
				"jollimemory.disableJolliMemory",
				"jollimemory.focusSidebar",
				"jollimemory.refreshMemories",
				"jollimemory.searchMemories",
				"jollimemory.clearMemoryFilter",
				"jollimemory.loadMoreMemories",
				"jollimemory.copyRecallPrompt",
				"jollimemory.openInClaudeCode",
				"jollimemory.refreshFiles",
				"jollimemory.selectAllFiles",
				"jollimemory.commitAI",
				"jollimemory.openFileChange",
				"jollimemory.openCommitFileChange",
				"jollimemory.refreshPlans",
				"jollimemory.editPlan",
				"jollimemory.removePlan",
				"jollimemory.addPlan",
				"jollimemory.addMarkdownNote",
				"jollimemory.addTextSnippet",
				"jollimemory.editNote",
				"jollimemory.removeNote",
				"jollimemory.refreshHistory",
				"jollimemory.selectAllCommits",
				"jollimemory.squash",
				"jollimemory.pushBranch",
				"jollimemory.viewSummary",
				"jollimemory.viewMemorySummary",
				"jollimemory.copyCommitHash",
				"jollimemory.openSettings",
			];

			for (const cmd of expectedCommands) {
				expect(
					commandMap.has(cmd),
					`Expected command "${cmd}" to be registered`,
				).toBe(true);
			}
		});

		it("registers a TextDocumentContentProvider for plan previews", () => {
			const ctx = makeContext();

			activate(ctx);

			expect(registerTextDocumentContentProvider).toHaveBeenCalledWith(
				"jollimemory-plan",
				expect.any(Object),
			);
		});

		it("sets initial context keys", () => {
			const ctx = makeContext();

			activate(ctx);

			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.history.singleCommitMode",
				false,
			);
			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.enabled",
				true,
			);
		});

		it("creates ExcludeFilterManager", () => {
			const ctx = makeContext();

			activate(ctx);

			expect(MockExcludeFilterManager).toHaveBeenCalled();
		});

		it("creates file system watchers", () => {
			const ctx = makeContext();

			activate(ctx);

			// With PlansStore / FilesStore / CommitsStore mocked, Extension.ts
			// owns only: sessions.json, .git/HEAD, orphan ref, lock file — 4 at minimum.
			// (The plans* and notes* watchers now live inside PlansStore; the git
			// index + workspace/** watchers live inside FilesStore.)
			expect(createFileSystemWatcher).toHaveBeenCalled();
			expect(createFileSystemWatcher.mock.calls.length).toBeGreaterThanOrEqual(
				4,
			);
		});

		it("calls cleanupV1IfExpired on activation", async () => {
			const ctx = makeContext();

			activate(ctx);
			await vi.waitFor(() => {
				expect(cleanupV1IfExpired).toHaveBeenCalledWith("/test/workspace");
			});
		});

		it("checks initial worker busy state", () => {
			const ctx = makeContext();

			activate(ctx);

			expect(isWorkerBusy).toHaveBeenCalledWith("/test/workspace");
		});

		it("calls bridge.refreshHookPathsIfStale with extension path", () => {
			const ctx = makeContext();

			activate(ctx);

			expect(mockBridge.refreshHookPathsIfStale).toHaveBeenCalledWith(
				"/mock/extension/path",
			);
		});
	});

	// ── activate: migration logic ─────────────────────────────────────────

	describe("activate — migration", () => {
		it("runs V1 migration when V1 branch exists and not yet migrated", async () => {
			hasV1Branch.mockResolvedValue(true);
			hasMigrationMeta.mockResolvedValue(false);
			migrateV1toV3.mockResolvedValue({ migrated: 5, skipped: 1 });

			const ctx = makeContext();
			activate(ctx);

			// Allow async migration to complete
			await vi.waitFor(() => {
				expect(migrateV1toV3).toHaveBeenCalledWith("/test/workspace");
			});

			expect(writeMigrationMeta).toHaveBeenCalledWith("/test/workspace");
			expect(mockStatusStore.setMigrating).toHaveBeenCalledWith(true);
			expect(mockStatusStore.setMigrating).toHaveBeenCalledWith(false);
		});

		it("skips V1 migration when already migrated", async () => {
			hasV1Branch.mockResolvedValue(true);
			hasMigrationMeta.mockResolvedValue(true);

			const ctx = makeContext();
			activate(ctx);

			// Allow async work to settle
			await vi.waitFor(() => {
				expect(hasMigrationMeta).toHaveBeenCalled();
			});

			expect(migrateV1toV3).not.toHaveBeenCalled();
		});

		it("runs index migration when needed", async () => {
			indexNeedsMigration.mockResolvedValue(true);
			migrateIndexToV3.mockResolvedValue({ migrated: 3, skipped: 0 });

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(migrateIndexToV3).toHaveBeenCalledWith("/test/workspace");
			});

			// migrateIndexToV3 acquires `orphan-write.lock` internally; the
			// extension no longer wraps the call in an outer lock acquisition.
			expect(mockCommitsStore.setMigrating).toHaveBeenCalledWith(true);
			expect(mockCommitsStore.setMigrating).toHaveBeenCalledWith(false);
		});
	});

	// ── KB folder auto-init / v3 stale-child cleanup on activate ─────────────
	//
	// Regression coverage for two related bugs:
	//   (1) Users whose v1 KB migration had already completed before v2 leaf
	//       cleanup shipped never had the backlog drained — runLeafCleanup
	//       was only invoked at the tail of runMigration, and runMigration
	//       only ran when migration state was missing or non-completed.
	//   (2) Worse, the 0.99.2 leaf-only algorithm was inverted under v4
	//       Hoist semantics — it kept hoisted stale children and deleted
	//       heads. So even when leafCleanup did run, it broke disk state.
	// The activate path now invokes runStaleChildCleanup independently for
	// the already-completed branch. State key is `staleChildCleanup`. The
	// legacy `leafCleanup.completedAt` flag is intentionally NOT consulted —
	// 0.99.2 users must re-run the corrective pass.
	describe("activate — KB v3 stale-child cleanup", () => {
		beforeEach(() => {
			mockOrphanInstance.exists.mockReset();
			mockMigrationEngineInstance.runMigration.mockReset();
			mockMigrationEngineInstance.runMigration.mockResolvedValue({
				status: "completed",
				migratedEntries: 0,
				totalEntries: 0,
			});
			mockMigrationEngineInstance.runStaleChildCleanup.mockReset();
			mockMigrationEngineInstance.runStaleChildCleanup.mockResolvedValue({
				status: "completed",
				migratedEntries: 0,
				totalEntries: 0,
				staleChildCleanup: { completedAt: "2026-05-12T00:00:00Z" },
			});
			mockMetadataManagerInstance.readMigrationState.mockReset();
		});

		it("runs runStaleChildCleanup when v1 migration is completed but staleChildCleanup has never run", async () => {
			mockOrphanInstance.exists.mockResolvedValue(true);
			mockMetadataManagerInstance.readMigrationState.mockReturnValue({
				status: "completed",
				totalEntries: 5,
				migratedEntries: 5,
			});

			activate(makeContext());

			await vi.waitFor(() => {
				expect(
					mockMigrationEngineInstance.runStaleChildCleanup,
				).toHaveBeenCalledTimes(1);
			});
			expect(mockMigrationEngineInstance.runMigration).not.toHaveBeenCalled();
		});

		it("skips runStaleChildCleanup when staleChildCleanup.completedAt is already set", async () => {
			mockOrphanInstance.exists.mockResolvedValue(true);
			mockMetadataManagerInstance.readMigrationState.mockReturnValue({
				status: "completed",
				totalEntries: 5,
				migratedEntries: 5,
				staleChildCleanup: { completedAt: "2026-05-01T00:00:00Z" },
			});

			activate(makeContext());

			// Give activate's fire-and-forget initializeKB() a chance to settle.
			await vi.waitFor(() => {
				expect(mockOrphanInstance.exists).toHaveBeenCalled();
			});
			expect(
				mockMigrationEngineInstance.runStaleChildCleanup,
			).not.toHaveBeenCalled();
			expect(mockMigrationEngineInstance.runMigration).not.toHaveBeenCalled();
		});

		it("still runs runStaleChildCleanup even when the legacy 0.99.2 leafCleanup.completedAt is set (corrective re-run)", async () => {
			// Critical regression: 0.99.2 users carry leafCleanup.completedAt
			// from the inverted pass. They must NOT be short-circuited — the
			// new step has to run to undo the damage.
			mockOrphanInstance.exists.mockResolvedValue(true);
			mockMetadataManagerInstance.readMigrationState.mockReturnValue({
				status: "completed",
				totalEntries: 5,
				migratedEntries: 5,
				leafCleanup: { completedAt: "2026-05-12T10:00:00Z" },
			});

			activate(makeContext());

			await vi.waitFor(() => {
				expect(
					mockMigrationEngineInstance.runStaleChildCleanup,
				).toHaveBeenCalledTimes(1);
			});
		});

		it("runs full runMigration (not runStaleChildCleanup) on fresh install with no migration state", async () => {
			mockOrphanInstance.exists.mockResolvedValue(true);
			mockMetadataManagerInstance.readMigrationState.mockReturnValue(null);

			activate(makeContext());

			await vi.waitFor(() => {
				expect(mockMigrationEngineInstance.runMigration).toHaveBeenCalledTimes(
					1,
				);
			});
			expect(
				mockMigrationEngineInstance.runStaleChildCleanup,
			).not.toHaveBeenCalled();
		});

		it("does nothing when orphan branch does not exist", async () => {
			mockOrphanInstance.exists.mockResolvedValue(false);
			mockMetadataManagerInstance.readMigrationState.mockReturnValue({
				status: "completed",
				totalEntries: 5,
				migratedEntries: 5,
			});

			activate(makeContext());

			await vi.waitFor(() => {
				expect(mockOrphanInstance.exists).toHaveBeenCalled();
			});
			expect(mockMigrationEngineInstance.runMigration).not.toHaveBeenCalled();
			expect(
				mockMigrationEngineInstance.runStaleChildCleanup,
			).not.toHaveBeenCalled();
		});
	});

	// ── Command handlers ────────────────────────────────────────────────

	describe("command handlers", () => {
		let ctx: vscode.ExtensionContext;

		beforeEach(() => {
			ctx = makeContext();
			activate(ctx);
		});

		describe("enableJolliMemory", () => {
			it("calls bridge.enable and refreshes all panels on success", async () => {
				// Reset call counters (including setEnabled) seeded by activation's
				// initialLoad so the ordering assertion below only observes the
				// enable command's invocation sequence.
				mockStatusStore.refresh.mockClear();
				mockPlansStore.refresh.mockClear();
				mockPlansStore.setEnabled.mockClear();
				mockMemoriesStore.refresh.mockClear();
				mockFilesStore.refresh.mockClear();
				mockCommitsStore.refresh.mockClear();

				const handler = getRegisteredCommand("jollimemory.enableJolliMemory");
				await handler();

				expect(mockBridge.enable).toHaveBeenCalled();
				expect(mockStatusStore.refresh).toHaveBeenCalled();
				expect(mockFilesStore.refresh).toHaveBeenCalledWith(true);
				expect(mockCommitsStore.refresh).toHaveBeenCalled();
				// Regression: disable clears plansStore data; enable must
				// refetch so the panel is not stuck empty until a watcher fires.
				expect(mockPlansStore.refresh).toHaveBeenCalled();
				expect(mockMemoriesStore.refresh).toHaveBeenCalled();

				// Ordering guard: `plansStore.setEnabled(true)` (called inside
				// refreshStatusBar) MUST run before `plansStore.refresh()`,
				// otherwise the real PlansStore.refresh() early-returns while
				// disabled and the panel stays blank.  Use Vitest's global
				// invocation counter to catch a future re-reorder.
				const setEnabledFirstInvocation =
					mockPlansStore.setEnabled.mock.invocationCallOrder[0];
				const refreshFirstInvocation =
					mockPlansStore.refresh.mock.invocationCallOrder[0];
				expect(setEnabledFirstInvocation).toBeDefined();
				expect(refreshFirstInvocation).toBeDefined();
				expect(setEnabledFirstInvocation).toBeLessThan(refreshFirstInvocation);
			});

			it("shows error message when enable fails", async () => {
				mockBridge.enable.mockResolvedValue({
					success: false,
					message: "git not found",
				});
				const handler = getRegisteredCommand("jollimemory.enableJolliMemory");
				await handler();

				expect(showErrorMessage).toHaveBeenCalledWith(
					"Jolli Memory: git not found",
				);
			});

			it("clears the manually-disabled marker on enable success", async () => {
				writeManualDisableFlag.mockClear();
				const handler = getRegisteredCommand("jollimemory.enableJolliMemory");
				await handler();

				expect(writeManualDisableFlag).toHaveBeenCalledWith(
					"/test/workspace",
					false,
				);
			});
		});

		describe("disableJolliMemory", () => {
			it("calls bridge.disable and refreshes status on success", async () => {
				const handler = getRegisteredCommand("jollimemory.disableJolliMemory");
				await handler();

				expect(mockBridge.disable).toHaveBeenCalled();
				expect(mockStatusStore.refresh).toHaveBeenCalled();
			});

			it("shows error message when disable fails", async () => {
				mockBridge.disable.mockResolvedValue({
					success: false,
					message: "permission denied",
				});
				const handler = getRegisteredCommand("jollimemory.disableJolliMemory");
				await handler();

				expect(showErrorMessage).toHaveBeenCalledWith(
					"Jolli Memory: permission denied",
				);
			});

			it("writes the manually-disabled marker before disabling", async () => {
				writeManualDisableFlag.mockClear();
				const handler = getRegisteredCommand("jollimemory.disableJolliMemory");
				await handler();

				expect(writeManualDisableFlag).toHaveBeenCalledWith(
					"/test/workspace",
					true,
				);
			});

			it("writes the manually-disabled marker even when bridge.disable fails", async () => {
				mockBridge.disable.mockResolvedValue({
					success: false,
					message: "permission denied",
				});
				writeManualDisableFlag.mockClear();
				const handler = getRegisteredCommand("jollimemory.disableJolliMemory");
				await handler();

				// The opt-out is recorded *before* the async uninstall so it
				// survives a failed Installer.uninstall().
				expect(writeManualDisableFlag).toHaveBeenCalledWith(
					"/test/workspace",
					true,
				);
			});
		});

		describe("refreshStatus", () => {
			it("refreshes the status provider", () => {
				const handler = getRegisteredCommand("jollimemory.refreshStatus");
				handler();

				expect(mockStatusStore.refresh).toHaveBeenCalled();
			});
		});

		describe("refreshFiles", () => {
			it("refreshes the files provider with reorder flag", () => {
				const handler = getRegisteredCommand("jollimemory.refreshFiles");
				handler();

				expect(mockFilesStore.refresh).toHaveBeenCalledWith(true);
			});
		});

		describe("selectAllFiles", () => {
			it("calls filesProvider.toggleSelectAll", () => {
				const handler = getRegisteredCommand("jollimemory.selectAllFiles");
				handler();

				expect(mockFilesStore.toggleSelectAll).toHaveBeenCalled();
			});
		});

		describe("selectAllCommits", () => {
			it("calls historyProvider.toggleSelectAll", () => {
				const handler = getRegisteredCommand("jollimemory.selectAllCommits");
				handler();

				expect(mockCommitsStore.toggleSelectAll).toHaveBeenCalled();
			});
		});

		describe("commitAI", () => {
			it("calls commitCommand.execute", () => {
				const handler = getRegisteredCommand("jollimemory.commitAI");
				handler();

				expect(mockCommitCommand.execute).toHaveBeenCalled();
			});
		});

		describe("squash", () => {
			it("calls squashCommand.execute", () => {
				const handler = getRegisteredCommand("jollimemory.squash");
				handler();

				expect(mockSquashCommand.execute).toHaveBeenCalled();
			});
		});

		describe("pushBranch", () => {
			it("calls pushCommand.execute", () => {
				const handler = getRegisteredCommand("jollimemory.pushBranch");
				handler();

				expect(mockPushCommand.execute).toHaveBeenCalled();
			});
		});

		describe("focusSidebar", () => {
			it("executes the focus command", () => {
				const handler = getRegisteredCommand("jollimemory.focusSidebar");
				handler();

				expect(executeCommand).toHaveBeenCalledWith(
					"jollimemory.mainView.focus",
				);
			});
		});

		describe("viewSummary (commit panel)", () => {
			it("opens the webview panel in the commit slot when summary exists", async () => {
				const summary = { hash: "abc123", content: "summary text" };
				mockBridge.getSummary.mockResolvedValue(summary);

				const handler = getRegisteredCommand("jollimemory.viewSummary");
				await handler({
					commit: { hash: "abc1234567890", shortHash: "abc1234" },
				});

				expect(mockBridge.getSummary).toHaveBeenCalledWith("abc1234567890");
				expect(MockSummaryWebviewPanel.show).toHaveBeenCalledWith(
					summary,
					expect.anything(),
					"/test/workspace",
					mockBridge,
					expect.any(String),
					"commit",
				);
			});

			it("silently returns when no summary is found (no toast, no panel)", async () => {
				// Product decision: clicking a COMMITS row whose commit has no
				// summary is a non-event — the row's `codicon-code` glyph (vs
				// the tinted markdown glyph for memory rows) already conveys
				// the absence visually, so a follow-up information toast on
				// every click was redundant noise. The viewMemorySummary path
				// (next describe) intentionally keeps its toast because hitting
				// no-summary there indicates a real Memories↔bridge mismatch.
				mockBridge.getSummary.mockResolvedValue(null);

				const handler = getRegisteredCommand("jollimemory.viewSummary");
				await handler({
					commit: { hash: "abc1234567890", shortHash: "abc1234" },
				});

				expect(showInformationMessage).not.toHaveBeenCalled();
				expect(MockSummaryWebviewPanel.show).not.toHaveBeenCalled();
			});

			it("accepts a plain hash string instead of CommitItem", async () => {
				// Pinned because the sidebar webview dispatches the command
				// with a bare hash via `branch:openCommit`, not a CommitItem;
				// regressing the string branch would break every commit-row
				// click. The no-summary path is silent (see test above).
				mockBridge.getSummary.mockResolvedValue(null);

				const handler = getRegisteredCommand("jollimemory.viewSummary");
				await handler("abc1234567890");

				expect(mockBridge.getSummary).toHaveBeenCalledWith("abc1234567890");
				expect(showInformationMessage).not.toHaveBeenCalled();
				expect(MockSummaryWebviewPanel.show).not.toHaveBeenCalled();
			});
		});

		describe("viewMemorySummary (memory panel)", () => {
			// Note: viewMemorySummary now uses getSummaryAnyRepoWithSource (NOT
			// getSummary) because Timeline view aggregates memories across all
			// repos under the Memory Bank parent. Pinning the call to the
			// provenance variant so a future refactor that reverts to single-
			// repo getSummary doesn't silently regress non-current-repo
			// Timeline clicks back to the "No summary found" toast bug. The
			// `sourceRepoName` field is plumbed through to SummaryWebviewPanel
			// so destructive actions can be disabled for foreign-origin
			// summaries.
			it("opens the webview panel in the memory slot for a local MemoryItem", async () => {
				const summary = { hash: "def456", content: "memory summary" };
				mockBridge.getSummaryAnyRepoWithSource.mockResolvedValue({
					summary,
					sourceRepoName: null,
					sourceRemoteUrl: null,
				});

				const handler = getRegisteredCommand("jollimemory.viewMemorySummary");
				await handler({ entry: { commitHash: "def4567890abc" } });

				expect(mockBridge.getSummaryAnyRepoWithSource).toHaveBeenCalledWith(
					"def4567890abc",
				);
				expect(MockSummaryWebviewPanel.show).toHaveBeenCalledWith(
					summary,
					expect.anything(),
					"/test/workspace",
					mockBridge,
					expect.any(String),
					"memory",
					null,
					null,
				);
			});

			it("accepts a plain hash string from a tooltip command link", async () => {
				const summary = { hash: "ghi789", content: "memory summary" };
				mockBridge.getSummaryAnyRepoWithSource.mockResolvedValue({
					summary,
					sourceRepoName: null,
					sourceRemoteUrl: null,
				});

				const handler = getRegisteredCommand("jollimemory.viewMemorySummary");
				await handler("ghi7890123456");

				expect(mockBridge.getSummaryAnyRepoWithSource).toHaveBeenCalledWith(
					"ghi7890123456",
				);
				expect(MockSummaryWebviewPanel.show).toHaveBeenCalledWith(
					summary,
					expect.anything(),
					"/test/workspace",
					mockBridge,
					expect.any(String),
					"memory",
					null,
					null,
				);
			});

			it("passes sourceRepoName and sourceRemoteUrl through to the panel for foreign-origin memories", async () => {
				// End-to-end pinning of provenance plumbing: a Memory Bank
				// cross-repo lookup found the summary in `other-repo` AND
				// captured its remote URL. The panel needs both — repoName
				// gates destructive commands, remoteUrl powers the read-only
				// `gh pr view --repo` query for the PR section. A regression
				// dropping either breaks a different user-facing surface.
				const summary = { hash: "xyz999", content: "foreign memory" };
				mockBridge.getSummaryAnyRepoWithSource.mockResolvedValue({
					summary,
					sourceRepoName: "other-repo",
					sourceRemoteUrl: "https://github.com/other/repo.git",
				});

				const handler = getRegisteredCommand("jollimemory.viewMemorySummary");
				await handler({ entry: { commitHash: "xyz9999999999" } });

				expect(MockSummaryWebviewPanel.show).toHaveBeenCalledWith(
					summary,
					expect.anything(),
					"/test/workspace",
					mockBridge,
					expect.any(String),
					"memory",
					"other-repo",
					"https://github.com/other/repo.git",
				);
			});

			it("shows info message when no summary is found in any discovered repo", async () => {
				mockBridge.getSummaryAnyRepoWithSource.mockResolvedValue({
					summary: null,
					sourceRepoName: null,
				});

				const handler = getRegisteredCommand("jollimemory.viewMemorySummary");
				await handler({ entry: { commitHash: "def4567890abc" } });

				expect(showInformationMessage).toHaveBeenCalledWith(
					"Jolli Memory: No summary found for commit def4567.",
				);
			});
		});

		describe("copyCommitHash", () => {
			it("copies the hash from a CommitItem to clipboard", () => {
				const handler = getRegisteredCommand("jollimemory.copyCommitHash");
				handler({ commit: { hash: "abc1234567890", shortHash: "abc1234" } });

				expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
					"abc1234567890",
				);
			});

			it("accepts a plain hash string", () => {
				const handler = getRegisteredCommand("jollimemory.copyCommitHash");
				handler("abc1234567890");

				expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
					"abc1234567890",
				);
			});
		});

		describe("openSettings", () => {
			it("registers the openSettings command", () => {
				const handler = getRegisteredCommand("jollimemory.openSettings");
				expect(handler).toBeDefined();
			});

			it("invokes SettingsWebviewPanel.show and runs the race-fix sequence on save", async () => {
				const handler = getRegisteredCommand("jollimemory.openSettings");
				handler();

				// 4th arg is the AuthService — passed so the panel can resolve
				// signed-in state for the AI Summary / Sync provider cards.
				expect(MockSettingsWebviewPanel.show).toHaveBeenCalledWith(
					expect.anything(),
					"/test/workspace",
					expect.any(Function),
					expect.anything(),
				);

				// Activation already called filesStore.refresh / statusStore.refresh
				// via initialLoad.  Clear those so the save-callback assertions
				// below only observe the saveCallback's effects.
				mockFilesStore.refresh.mockClear();
				mockFilesStore.applyExcludeFilterChange.mockClear();
				mockStatusStore.refresh.mockClear();
				mockExcludeFilter.load.mockClear();

				const saveCallback = MockSettingsWebviewPanel.show.mock
					.calls[0]?.[2] as () => void;
				saveCallback();

				// Verify the documented ordering: load() → applyExcludeFilterChange
				// → statusStore.refresh.  This is the race-fix for the old parallel
				// behaviour where getChildren could run against stale patterns.
				await vi.waitFor(() => {
					expect(mockExcludeFilter.load).toHaveBeenCalled();
					expect(mockFilesStore.applyExcludeFilterChange).toHaveBeenCalled();
					expect(mockStatusStore.refresh).toHaveBeenCalled();
				});

				// Critical guard: the save path must NOT call filesStore.refresh —
				// re-querying the bridge is unnecessary and masked the race.
				expect(mockFilesStore.refresh).not.toHaveBeenCalled();
			});
		});

		describe("refreshPlans", () => {
			it("refreshes the plans provider", () => {
				const handler = getRegisteredCommand("jollimemory.refreshPlans");
				handler();

				expect(mockPlansStore.refresh).toHaveBeenCalled();
			});
		});

		describe("refreshHistory", () => {
			it("refreshes the history provider", () => {
				const handler = getRegisteredCommand("jollimemory.refreshHistory");
				handler();

				expect(mockCommitsStore.refresh).toHaveBeenCalled();
			});
		});

		describe("addTextSnippet", () => {
			it("opens NoteEditorWebviewPanel", async () => {
				const handler = getRegisteredCommand("jollimemory.addTextSnippet");
				await handler();

				expect(MockNoteEditorWebviewPanel.show).toHaveBeenCalled();
			});

			it("invokes the refresh callback passed to NoteEditorWebviewPanel.show", async () => {
				// Capture the onSaved callback and invoke it so the lambda body (which
				// calls plansStore.refresh()) is actually executed — otherwise that
				// arrow function reports as never called in coverage.
				let savedCb: (() => unknown) | undefined;
				MockNoteEditorWebviewPanel.show.mockImplementation(
					(_uri: unknown, _bridge: unknown, cb: () => unknown) => {
						savedCb = cb;
					},
				);

				const handler = getRegisteredCommand("jollimemory.addTextSnippet");
				await handler();

				expect(savedCb).toBeDefined();
				mockPlansStore.refresh.mockClear();
				savedCb?.();
				expect(mockPlansStore.refresh).toHaveBeenCalled();
			});
		});

		describe("previewNote", () => {
			it("opens markdown preview when note content is found", async () => {
				readNoteFromBranch.mockResolvedValue("# My Note\nContent here");
				const handler = getRegisteredCommand("jollimemory.previewNote");

				await handler("note-1", "My Note");

				expect(readNoteFromBranch).toHaveBeenCalledWith(
					"note-1",
					"/test/workspace",
				);
				expect(openTextDocument).toHaveBeenCalled();
				expect(executeCommand).toHaveBeenCalledWith(
					"markdown.showPreview",
					expect.anything(),
				);
			});

			it("shows error when note content is null", async () => {
				readNoteFromBranch.mockResolvedValue(null);
				const handler = getRegisteredCommand("jollimemory.previewNote");

				await handler("note-1", "My Note");

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Could not read note"),
				);
				expect(openTextDocument).not.toHaveBeenCalled();
			});

			it("provides cached content for note preview virtual documents", async () => {
				readNoteFromBranch.mockResolvedValue("# Note content");
				const handler = getRegisteredCommand("jollimemory.previewNote");
				await handler("note-1", "My Note");

				// Note content provider is the second registered provider (index 1)
				const provider = registerTextDocumentContentProvider.mock
					.calls[1]?.[1] as
					| {
							provideTextDocumentContent: (uri: { query: string }) => string;
					  }
					| undefined;
				expect(provider).toBeDefined();
				expect(
					provider?.provideTextDocumentContent({ query: "id=note-1" }),
				).toBe("# Note content");
				expect(
					provider?.provideTextDocumentContent({ query: "id=missing" }),
				).toBe("# Note not found");
				expect(provider?.provideTextDocumentContent({ query: "" })).toBe(
					"# Note not found",
				);
			});
		});

		describe("removePlan", () => {
			it("calls bridge.removePlan and refreshes plans provider", async () => {
				const handler = getRegisteredCommand("jollimemory.removePlan");
				await handler({ plan: { slug: "my-plan" } });

				expect(mockBridge.removePlan).toHaveBeenCalledWith("my-plan");
				expect(mockPlansStore.refresh).toHaveBeenCalled();
			});

			it("accepts string slug as fallback", async () => {
				const handler = getRegisteredCommand("jollimemory.removePlan");
				await handler("my-plan-slug");

				expect(mockBridge.removePlan).toHaveBeenCalledWith("my-plan-slug");
				expect(mockPlansStore.refresh).toHaveBeenCalled();
			});
		});

		describe("editPlan", () => {
			it("opens markdown preview for committed plans", async () => {
				readPlanFromBranch.mockResolvedValue("# Plan content");

				const handler = getRegisteredCommand("jollimemory.editPlan");
				await handler({
					plan: { slug: "my-plan", title: "My Plan", commitHash: "abc123" },
				});

				expect(readPlanFromBranch).toHaveBeenCalledWith(
					"my-plan",
					"/test/workspace",
				);
			});

			it("provides cached content for plan preview virtual documents", async () => {
				readPlanFromBranch.mockResolvedValue("# Plan content");

				const handler = getRegisteredCommand("jollimemory.editPlan");
				await handler({
					plan: { slug: "my-plan", title: "My/Plan", commitHash: "abc123" },
				});

				const provider = registerTextDocumentContentProvider.mock
					.calls[0]?.[1] as
					| {
							provideTextDocumentContent: (uri: { query: string }) => string;
					  }
					| undefined;
				expect(provider).toBeDefined();
				expect(
					provider?.provideTextDocumentContent({ query: "slug=my-plan" }),
				).toBe("# Plan content");
				expect(
					provider?.provideTextDocumentContent({ query: "slug=missing" }),
				).toBe("# Plan not found");
				expect(provider?.provideTextDocumentContent({ query: "" })).toBe(
					"# Plan not found",
				);
			});

			it("opens source file for uncommitted plans using filePath from PlanItem", async () => {
				const handler = getRegisteredCommand("jollimemory.editPlan");
				await handler({
					plan: {
						slug: "my-plan",
						title: "My Plan",
						commitHash: undefined,
						filePath: normalize("/home/user/.claude/plans/my-plan.md"),
					},
				});

				expect(openTextDocument).toHaveBeenCalledWith(
					normalize("/home/user/.claude/plans/my-plan.md"),
				);
			});

			it("opens external-path plan using filePath from PlanItem", async () => {
				// External plan: filePath is an arbitrary absolute path outside ~/.claude/plans/
				const handler = getRegisteredCommand("jollimemory.editPlan");
				await handler({
					plan: {
						slug: "foo-plan",
						title: "External Foo",
						commitHash: undefined,
						filePath: normalize("/repo/docs/foo-plan.md"),
					},
				});

				expect(openTextDocument).toHaveBeenCalledWith(
					normalize("/repo/docs/foo-plan.md"),
				);
			});

			it("falls back to bridge.listPlans() when invoked with bare slug", async () => {
				mockBridge.listPlans.mockResolvedValue([
					{
						slug: "my-plan",
						filePath: normalize("/home/user/.claude/plans/my-plan.md"),
					},
				]);

				const handler = getRegisteredCommand("jollimemory.editPlan");
				await handler("my-plan", false, "My Plan");

				expect(mockBridge.listPlans).toHaveBeenCalled();
				expect(openTextDocument).toHaveBeenCalledWith(
					normalize("/home/user/.claude/plans/my-plan.md"),
				);
			});

			it("uses default committed and title values when only a slug is provided", async () => {
				mockBridge.listPlans.mockResolvedValue([
					{
						slug: "my-plan",
						filePath: normalize("/home/user/.claude/plans/my-plan.md"),
					},
				]);

				const handler = getRegisteredCommand("jollimemory.editPlan");
				await handler("my-plan");

				expect(openTextDocument).toHaveBeenCalledWith(
					normalize("/home/user/.claude/plans/my-plan.md"),
				);
			});

			it("warns and returns when filePath cannot be resolved", async () => {
				mockBridge.listPlans.mockResolvedValue([]);

				const handler = getRegisteredCommand("jollimemory.editPlan");
				await handler("missing-from-registry");

				expect(openTextDocument).not.toHaveBeenCalled();
				expect(showWarningMessage).toHaveBeenCalledWith(
					expect.stringContaining("missing-from-registry"),
				);
			});

			it("shows error when committed plan content is not found", async () => {
				readPlanFromBranch.mockResolvedValue(null);

				const handler = getRegisteredCommand("jollimemory.editPlan");
				await handler({
					plan: {
						slug: "missing-plan",
						title: "Missing",
						commitHash: "abc123",
					},
				});

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Could not read plan"),
				);
			});
		});

		describe("addPlan", () => {
			it("shows info message when no available plans exist", async () => {
				mockBridge.listPlans.mockResolvedValue([]);
				listAvailablePlans.mockReturnValue([]);

				const handler = getRegisteredCommand("jollimemory.addPlan");
				await handler();

				expect(showInformationMessage).toHaveBeenCalledWith(
					"No additional plans found in ~/.claude/plans/",
				);
				expect(addPlanToRegistry).not.toHaveBeenCalled();
			});

			it("adds selected plan to registry and refreshes when user selects a plan", async () => {
				mockBridge.listPlans.mockResolvedValue([{ slug: "existing-plan" }]);
				listAvailablePlans.mockReturnValue([
					{ slug: "new-plan", title: "New Plan", mtimeMs: 1700000000000 },
				]);
				showQuickPick.mockResolvedValue({
					label: "New Plan",
					description: "2d ago",
					slug: "new-plan",
				});

				const handler = getRegisteredCommand("jollimemory.addPlan");
				await handler();

				expect(listAvailablePlans).toHaveBeenCalledWith(
					new Set(["existing-plan"]),
				);
				expect(addPlanToRegistry).toHaveBeenCalledWith(
					"new-plan",
					"/test/workspace",
				);
				expect(mockPlansStore.refresh).toHaveBeenCalled();
			});

			it("does nothing when user cancels the quick pick", async () => {
				mockBridge.listPlans.mockResolvedValue([]);
				listAvailablePlans.mockReturnValue([
					{ slug: "some-plan", title: "Some Plan", mtimeMs: 1700000000000 },
				]);
				showQuickPick.mockResolvedValue(undefined);

				const refreshCountBefore = mockPlansStore.refresh.mock.calls.length;
				const handler = getRegisteredCommand("jollimemory.addPlan");
				await handler();

				expect(addPlanToRegistry).not.toHaveBeenCalled();
				// refresh should not have been called again after the handler
				expect(mockPlansStore.refresh.mock.calls.length).toBe(
					refreshCountBefore,
				);
			});

			it("uses empty description for plans with mtimeMs of 0", async () => {
				mockBridge.listPlans.mockResolvedValue([]);
				listAvailablePlans.mockReturnValue([
					{ slug: "zero-plan", title: "Zero Plan", mtimeMs: 0 },
				]);
				showQuickPick.mockResolvedValue(undefined);

				const handler = getRegisteredCommand("jollimemory.addPlan");
				await handler();

				expect(showQuickPick).toHaveBeenCalledWith(
					[{ label: "Zero Plan", description: "", slug: "zero-plan" }],
					{ placeHolder: "Select a plan to add" },
				);
			});
		});

		describe("addMarkdownNote", () => {
			it("returns early when user cancels the file dialog", async () => {
				showOpenDialog.mockResolvedValue(undefined);

				const handler = getRegisteredCommand("jollimemory.addMarkdownNote");
				await handler();

				expect(mockBridge.saveNote).not.toHaveBeenCalled();
			});

			it("returns early when user selects no files", async () => {
				showOpenDialog.mockResolvedValue([]);

				const handler = getRegisteredCommand("jollimemory.addMarkdownNote");
				await handler();

				expect(mockBridge.saveNote).not.toHaveBeenCalled();
			});

			it("saves note and opens the file when a markdown file is selected", async () => {
				showOpenDialog.mockResolvedValue([
					{ fsPath: "/home/user/docs/my-note.md" },
				]);
				mockBridge.saveNote.mockResolvedValue({
					id: "note-abc",
					filePath: "/test/notes/my-note.md",
				});

				const handler = getRegisteredCommand("jollimemory.addMarkdownNote");
				await handler();

				expect(mockBridge.saveNote).toHaveBeenCalledWith(
					undefined,
					"",
					"/home/user/docs/my-note.md",
					"markdown",
				);
				expect(mockPlansStore.refresh).toHaveBeenCalled();
				expect(openTextDocument).toHaveBeenCalledWith("/test/notes/my-note.md");
				expect(showTextDocument).toHaveBeenCalled();
			});

			it("does not open document when saved note has no filePath", async () => {
				showOpenDialog.mockResolvedValue([
					{ fsPath: "/home/user/docs/note.md" },
				]);
				mockBridge.saveNote.mockResolvedValue({
					id: "note-xyz",
					filePath: undefined,
				});

				const handler = getRegisteredCommand("jollimemory.addMarkdownNote");
				await handler();

				expect(mockBridge.saveNote).toHaveBeenCalled();
				expect(mockPlansStore.refresh).toHaveBeenCalled();
				expect(openTextDocument).not.toHaveBeenCalled();
			});
		});

		describe("editNote", () => {
			it("opens file in editor when note has a filePath (NoteItem argument)", async () => {
				const note = {
					id: "note-1",
					title: "My Note",
					filePath: "/test/notes/my-note.md",
					commitHash: null,
					format: "markdown",
					lastModified: "2024-01-01T00:00:00Z",
					addedAt: "2024-01-01T00:00:00Z",
					updatedAt: "2024-01-01T00:00:00Z",
					branch: "main",
				};
				mockBridge.listNotes.mockResolvedValue([note]);

				const handler = getRegisteredCommand("jollimemory.editNote");
				await handler({ note });

				expect(mockBridge.listNotes).toHaveBeenCalled();
				expect(openTextDocument).toHaveBeenCalledWith("/test/notes/my-note.md");
				expect(showTextDocument).toHaveBeenCalled();
			});

			it("accepts a string ID and finds the note", async () => {
				const note = {
					id: "note-str",
					title: "String Note",
					filePath: "/test/notes/string-note.md",
					commitHash: null,
					format: "markdown",
					lastModified: "2024-01-01T00:00:00Z",
					addedAt: "2024-01-01T00:00:00Z",
					updatedAt: "2024-01-01T00:00:00Z",
					branch: "main",
				};
				mockBridge.listNotes.mockResolvedValue([note]);

				const handler = getRegisteredCommand("jollimemory.editNote");
				await handler("note-str");

				expect(openTextDocument).toHaveBeenCalledWith(
					"/test/notes/string-note.md",
				);
				expect(showTextDocument).toHaveBeenCalled();
			});

			it("returns early when note is not found", async () => {
				mockBridge.listNotes.mockResolvedValue([]);

				const handler = getRegisteredCommand("jollimemory.editNote");
				await handler({ note: { id: "missing-note" } });

				expect(openTextDocument).not.toHaveBeenCalled();
				expect(showTextDocument).not.toHaveBeenCalled();
			});

			it("does nothing special for note without filePath and without commitHash", async () => {
				const note = {
					id: "note-no-path",
					title: "Orphan Note",
					filePath: undefined,
					commitHash: null,
					format: "snippet",
					lastModified: "2024-01-01T00:00:00Z",
					addedAt: "2024-01-01T00:00:00Z",
					updatedAt: "2024-01-01T00:00:00Z",
					branch: "main",
				};
				mockBridge.listNotes.mockResolvedValue([note]);

				const handler = getRegisteredCommand("jollimemory.editNote");
				await handler({ note });

				expect(openTextDocument).not.toHaveBeenCalled();
				expect(showInformationMessage).not.toHaveBeenCalled();
			});

			it("shows info message for committed note without filePath", async () => {
				const note = {
					id: "note-committed",
					title: "Committed Note",
					filePath: undefined,
					commitHash: "abc123",
					format: "markdown",
					lastModified: "2024-01-01T00:00:00Z",
					addedAt: "2024-01-01T00:00:00Z",
					updatedAt: "2024-01-01T00:00:00Z",
					branch: "main",
				};
				mockBridge.listNotes.mockResolvedValue([note]);

				const handler = getRegisteredCommand("jollimemory.editNote");
				await handler({ note });

				expect(openTextDocument).not.toHaveBeenCalled();
				expect(showInformationMessage).toHaveBeenCalledWith(
					'Note "Committed Note" is committed and read-only.',
				);
			});
		});

		describe("removeNote", () => {
			it("calls bridge.removeNote and refreshes plans provider", async () => {
				const handler = getRegisteredCommand("jollimemory.removeNote");
				await handler({ note: { id: "note-to-remove" } });

				expect(mockBridge.removeNote).toHaveBeenCalledWith("note-to-remove");
				expect(mockPlansStore.refresh).toHaveBeenCalled();
			});

			it("accepts string noteId as fallback", async () => {
				const handler = getRegisteredCommand("jollimemory.removeNote");
				await handler("note-id-123");

				expect(mockBridge.removeNote).toHaveBeenCalledWith("note-id-123");
				expect(mockPlansStore.refresh).toHaveBeenCalled();
			});
		});

		// ── searchMemories command ──────────────────────────────────────────

		describe("searchMemories", () => {
			it("applies filter directly when called with a string query", async () => {
				const handler = getRegisteredCommand("jollimemory.searchMemories");
				await handler("biome");

				expect(mockMemoriesStore.setFilter).toHaveBeenCalledWith("biome");
				expect(showInputBox).not.toHaveBeenCalled();
			});

			it("clears the filter when called with no argument", async () => {
				const handler = getRegisteredCommand("jollimemory.searchMemories");
				await handler();

				expect(mockMemoriesStore.setFilter).toHaveBeenCalledWith("");
				expect(showInputBox).not.toHaveBeenCalled();
			});

			it("clears the filter when called with an empty string", async () => {
				const handler = getRegisteredCommand("jollimemory.searchMemories");
				await handler("");

				expect(mockMemoriesStore.setFilter).toHaveBeenCalledWith("");
				expect(showInputBox).not.toHaveBeenCalled();
			});

			it("treats non-string args as no-arg", async () => {
				const handler = getRegisteredCommand("jollimemory.searchMemories");
				await handler(42);

				expect(mockMemoriesStore.setFilter).toHaveBeenCalledWith("");
				expect(showInputBox).not.toHaveBeenCalled();
			});
		});

		// ── clearMemoryFilter command ───────────────────────────────────────

		describe("clearMemoryFilter", () => {
			it("calls memoriesProvider.setFilter with empty string", () => {
				const handler = getRegisteredCommand("jollimemory.clearMemoryFilter");
				handler();

				expect(mockMemoriesStore.setFilter).toHaveBeenCalledWith("");
			});
		});

		// ── refreshMemories command ─────────────────────────────────────────

		describe("refreshMemories", () => {
			it("calls memoriesProvider.refresh", () => {
				const handler = getRegisteredCommand("jollimemory.refreshMemories");
				handler();

				expect(mockMemoriesStore.refresh).toHaveBeenCalled();
			});
		});

		// ── loadMoreMemories command ────────────────────────────────────────

		describe("loadMoreMemories", () => {
			it("calls memoriesProvider.loadMore", () => {
				const handler = getRegisteredCommand("jollimemory.loadMoreMemories");
				handler();

				expect(mockMemoriesStore.loadMore).toHaveBeenCalled();
			});
		});

		// ── copyRecallPrompt command ────────────────────────────────────────

		describe("copyRecallPrompt", () => {
			// Pinned to getSummaryAnyRepo: MemoryItem rows can come from any
			// discovered repo under the Memory Bank parent (Memories tab is
			// cross-repo aggregated via listSummaryEntries), so a click on a
			// non-current-repo row must walk the same discovery list. Reverting
			// to getSummary would silently regress those rows to "No summary
			// found", the same bug pattern caught for viewMemorySummary.
			it("copies recall prompt to clipboard when summary exists (MemoryItem)", async () => {
				const summary = { hash: "abc123", content: "summary text" };
				mockBridge.getSummaryAnyRepo.mockResolvedValue(summary);

				const handler = getRegisteredCommand("jollimemory.copyRecallPrompt");
				await handler({ entry: { commitHash: "abc1234567890" } });

				expect(mockBridge.getSummaryAnyRepo).toHaveBeenCalledWith(
					"abc1234567890",
				);
				expect(buildClaudeCodeContext).toHaveBeenCalledWith(summary);
				expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
					"mock recall context",
				);
				expect(showInformationMessage).toHaveBeenCalledWith(
					expect.stringContaining("Recall prompt copied"),
				);
			});

			it("copies recall prompt to clipboard when given a plain hash string", async () => {
				const summary = { hash: "def456", content: "other summary" };
				mockBridge.getSummaryAnyRepo.mockResolvedValue(summary);

				const handler = getRegisteredCommand("jollimemory.copyRecallPrompt");
				await handler("def4567890abc");

				expect(mockBridge.getSummaryAnyRepo).toHaveBeenCalledWith(
					"def4567890abc",
				);
				expect(buildClaudeCodeContext).toHaveBeenCalledWith(summary);
				expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
					"mock recall context",
				);
			});

			it("shows warning when summary is not found", async () => {
				mockBridge.getSummaryAnyRepo.mockResolvedValue(null);

				const handler = getRegisteredCommand("jollimemory.copyRecallPrompt");
				await handler({ entry: { commitHash: "missing123" } });

				expect(showWarningMessage).toHaveBeenCalledWith(
					"No summary found for this commit.",
				);
				expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
			});
		});

		// ── openInClaudeCode command ────────────────────────────────────────

		describe("openInClaudeCode", () => {
			// Same cross-repo reasoning as copyRecallPrompt above — pinned to
			// getSummaryAnyRepo so non-current-repo MemoryItem clicks don't
			// silently regress to "No summary found".
			it("opens external URI when summary exists (MemoryItem)", async () => {
				const summary = { hash: "abc123", content: "summary text" };
				mockBridge.getSummaryAnyRepo.mockResolvedValue(summary);

				const handler = getRegisteredCommand("jollimemory.openInClaudeCode");
				await handler({ entry: { commitHash: "abc1234567890" } });

				expect(mockBridge.getSummaryAnyRepo).toHaveBeenCalledWith(
					"abc1234567890",
				);
				expect(buildClaudeCodeContext).toHaveBeenCalledWith(summary);
				expect(openExternal).toHaveBeenCalled();
			});

			it("accepts a plain hash string for openInClaudeCode", async () => {
				const summary = { hash: "def789", content: "text" };
				mockBridge.getSummaryAnyRepo.mockResolvedValue(summary);

				const handler = getRegisteredCommand("jollimemory.openInClaudeCode");
				await handler("def7891234567890");

				expect(mockBridge.getSummaryAnyRepo).toHaveBeenCalledWith(
					"def7891234567890",
				);
				expect(openExternal).toHaveBeenCalled();
			});

			it("shows warning when summary is not found", async () => {
				mockBridge.getSummaryAnyRepo.mockResolvedValue(null);

				const handler = getRegisteredCommand("jollimemory.openInClaudeCode");
				await handler({ entry: { commitHash: "missing456" } });

				expect(showWarningMessage).toHaveBeenCalledWith(
					"No summary found for this commit.",
				);
				expect(openExternal).not.toHaveBeenCalled();
			});
		});

		// ── previewNote command ─────────────────────────────────────────────

		describe("previewNote", () => {
			it("shows rendered markdown preview from orphan branch", async () => {
				readNoteFromBranch.mockResolvedValue("# My Note Content");

				const handler = getRegisteredCommand("jollimemory.previewNote");
				await handler("note-123", "My Note");

				expect(readNoteFromBranch).toHaveBeenCalledWith(
					"note-123",
					"/test/workspace",
				);
				expect(executeCommand).toHaveBeenCalledWith(
					"markdown.showPreview",
					expect.anything(),
				);
			});

			it("shows error when note content is not found on orphan branch", async () => {
				readNoteFromBranch.mockResolvedValue(null);

				const handler = getRegisteredCommand("jollimemory.previewNote");
				await handler("note-missing", "Missing Note");

				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("Could not read note"),
				);
			});

			it("provides cached note content for note preview virtual documents", async () => {
				readNoteFromBranch.mockResolvedValue("# Note content");

				const handler = getRegisteredCommand("jollimemory.previewNote");
				await handler("note-abc", "My Note");

				// Note content provider is the second registered provider (index 1)
				const calls = registerTextDocumentContentProvider.mock.calls as Array<
					Array<unknown>
				>;
				const provider = calls[1]?.[1] as
					| {
							provideTextDocumentContent: (uri: { query: string }) => string;
					  }
					| undefined;
				expect(provider).toBeDefined();
				expect(
					provider?.provideTextDocumentContent({ query: "id=note-abc" }),
				).toBe("# Note content");
				expect(
					provider?.provideTextDocumentContent({ query: "id=missing" }),
				).toBe("# Note not found");
				expect(provider?.provideTextDocumentContent({ query: "" })).toBe(
					"# Note not found",
				);
			});
		});

		// ── openMemoryFile command ──────────────────────────────────────────
		describe("openMemoryFile", () => {
			it("opens .md files in the rendered markdown preview", async () => {
				const handler = getRegisteredCommand("jollimemory.openMemoryFile");
				await handler("/abs/path/to/memo.md");

				expect(executeCommand).toHaveBeenCalledWith(
					"markdown.showPreview",
					expect.anything(),
				);
			});

			it("falls through to vscode.open for non-markdown files", async () => {
				const handler = getRegisteredCommand("jollimemory.openMemoryFile");
				await handler("/abs/path/to/data.json");

				expect(executeCommand).toHaveBeenCalledWith(
					"vscode.open",
					expect.anything(),
				);
				expect(executeCommand).not.toHaveBeenCalledWith(
					"markdown.showPreview",
					expect.anything(),
				);
			});

			it("ignores empty / non-string paths without throwing", async () => {
				const handler = getRegisteredCommand("jollimemory.openMemoryFile");
				await handler("");
				await handler(undefined as unknown as string);
				expect(executeCommand).not.toHaveBeenCalledWith(
					"markdown.showPreview",
					expect.anything(),
				);
				expect(executeCommand).not.toHaveBeenCalledWith(
					"vscode.open",
					expect.anything(),
				);
			});

			// ── parseSummaryFrontmatter coverage via openMemoryFile ───────────
			// parseSummaryFrontmatter is an internal helper invoked from
			// openMemoryFile for every clicked .md. The earlier tests above
			// pass non-existent paths so readFileSync (mocked to throw ENOENT
			// by default) trips the catch and the function returns null on
			// path-1 (markdown preview fallthrough). The block below stubs
			// readFileSync per-test to drive the remaining parser branches:
			//   - valid `type: commit` summary → rich SummaryWebviewPanel
			//   - opening `---` but no closing → null → fallthrough
			//   - missing leading `---\n` → null → fallthrough
			//   - line without `:` → continue (silently skipped)
			//   - `type: plan` (non-commit) → null → fallthrough
			//   - `type: commit` without commitHash → null → fallthrough
			//   - cross-repo bridge miss → fallthrough (not a hard error)
			describe("parseSummaryFrontmatter (via openMemoryFile)", () => {
				afterEach(() => {
					readFileSync.mockReset();
					// Restore the default ENOENT throw so unrelated tests in
					// later blocks (e.g. openMemoryFile's existing trio above
					// — wait, those run earlier in source order, but vitest's
					// shared mock state still benefits from a clean baseline).
					readFileSync.mockImplementation(() => {
						const err = new Error("ENOENT") as Error & { code: string };
						err.code = "ENOENT";
						throw err;
					});
				});

				it("opens the rich SummaryWebviewPanel for a valid type:commit summary frontmatter", async () => {
					readFileSync.mockReturnValueOnce(
						`---\ntype: commit\ncommitHash: abc123def456789\nignored\nbranch: main\n---\n# Body\n`,
					);
					const summary = { commitHash: "abc123def456789", topics: [] };
					mockBridge.getSummaryAnyRepoWithSource.mockResolvedValueOnce({
						summary,
						sourceRepoName: null,
						sourceRemoteUrl: null,
					});

					const handler = getRegisteredCommand("jollimemory.openMemoryFile");
					await handler("/fake/summary.md");

					expect(mockBridge.getSummaryAnyRepoWithSource).toHaveBeenCalledWith(
						"abc123def456789",
					);
					expect(MockSummaryWebviewPanel.show).toHaveBeenCalledWith(
						summary,
						expect.anything(),
						"/test/workspace",
						mockBridge,
						expect.any(String),
						"kb",
						null,
						null,
					);
					expect(executeCommand).not.toHaveBeenCalledWith(
						"markdown.showPreview",
						expect.anything(),
					);
				});

				it("falls through to markdown preview when frontmatter has opening --- but no closing fence", async () => {
					readFileSync.mockReturnValueOnce(
						`---\ntype: commit\ncommitHash: deadbeef\n`,
					);

					const handler = getRegisteredCommand("jollimemory.openMemoryFile");
					await handler("/fake/unclosed.md");

					expect(mockBridge.getSummaryAnyRepo).not.toHaveBeenCalled();
					expect(executeCommand).toHaveBeenCalledWith(
						"markdown.showPreview",
						expect.anything(),
					);
				});

				it("falls through to markdown preview when the file lacks the leading --- fence", async () => {
					readFileSync.mockReturnValueOnce(`# Just a heading\nbody text\n`);

					const handler = getRegisteredCommand("jollimemory.openMemoryFile");
					await handler("/fake/no-fm.md");

					expect(mockBridge.getSummaryAnyRepo).not.toHaveBeenCalled();
					expect(executeCommand).toHaveBeenCalledWith(
						"markdown.showPreview",
						expect.anything(),
					);
				});

				it("silently skips frontmatter lines that don't contain ':' (no parse error)", async () => {
					// A colonless line must be tolerated — early YAML writers
					// sometimes left dangling blank-ish lines in the block.
					readFileSync.mockReturnValueOnce(
						`---\ntype: commit\nbogus-line-without-colon\ncommitHash: 1234567890abcdef\n---\n`,
					);
					mockBridge.getSummaryAnyRepoWithSource.mockResolvedValueOnce({
						summary: { commitHash: "1234567890abcdef", topics: [] },
						sourceRepoName: null,
					});

					const handler = getRegisteredCommand("jollimemory.openMemoryFile");
					await handler("/fake/stray.md");

					// Parser ignored the colonless line and still found commitHash.
					expect(mockBridge.getSummaryAnyRepoWithSource).toHaveBeenCalledWith(
						"1234567890abcdef",
					);
				});

				it("falls through to markdown preview when type is not 'commit' (plan / note copies)", async () => {
					readFileSync.mockReturnValueOnce(
						`---\ntype: plan\ncommitHash: 1234567890abcdef\n---\nplan body\n`,
					);

					const handler = getRegisteredCommand("jollimemory.openMemoryFile");
					await handler("/fake/plan.md");

					expect(mockBridge.getSummaryAnyRepo).not.toHaveBeenCalled();
					expect(executeCommand).toHaveBeenCalledWith(
						"markdown.showPreview",
						expect.anything(),
					);
				});

				it("falls through to markdown preview when commitHash is missing under type:commit", async () => {
					readFileSync.mockReturnValueOnce(
						`---\ntype: commit\nbranch: main\n---\nbody\n`,
					);

					const handler = getRegisteredCommand("jollimemory.openMemoryFile");
					await handler("/fake/no-hash.md");

					expect(mockBridge.getSummaryAnyRepo).not.toHaveBeenCalled();
					expect(executeCommand).toHaveBeenCalledWith(
						"markdown.showPreview",
						expect.anything(),
					);
				});

				it("falls through to markdown preview when bridge returns null for the embedded hash", async () => {
					// Frontmatter parsed fine, but the cross-repo lookup couldn't
					// find the JSON summary (file deleted, repo wiped, etc.) —
					// the user still sees their content via plain preview rather
					// than a hard error toast.
					readFileSync.mockReturnValueOnce(
						`---\ntype: commit\ncommitHash: ffffffff00000000\n---\n`,
					);
					mockBridge.getSummaryAnyRepoWithSource.mockResolvedValueOnce({
						summary: null,
						sourceRepoName: null,
					});

					const handler = getRegisteredCommand("jollimemory.openMemoryFile");
					await handler("/fake/orphan.md");

					expect(mockBridge.getSummaryAnyRepoWithSource).toHaveBeenCalledWith(
						"ffffffff00000000",
					);
					expect(MockSummaryWebviewPanel.show).not.toHaveBeenCalled();
					expect(executeCommand).toHaveBeenCalledWith(
						"markdown.showPreview",
						expect.anything(),
					);
				});

				it("passes sourceRepoName through to the panel for foreign-origin Memory Bank entries", async () => {
					// Memory Bank cross-repo provenance: when the clicked .md
					// belongs to a non-current repo (KBRepoDiscoverer aggregates
					// every repo under the localFolder parent), the panel must
					// learn about it so destructive commands (push / edit /
					// createPr) are disabled — their handlers all write to
					// `workspaceRoot`'s git / orphan branch and would silently
					// corrupt the wrong project's Jolli Memory space. Same
					// provenance contract pinned in the viewMemorySummary test
					// block above; this entry point is independent of that one.
					readFileSync.mockReturnValueOnce(
						`---\ntype: commit\ncommitHash: deadbeefcafef00d\n---\nfrom-other-repo\n`,
					);
					const summary = { commitHash: "deadbeefcafef00d", topics: [] };
					mockBridge.getSummaryAnyRepoWithSource.mockResolvedValueOnce({
						summary,
						sourceRepoName: "other-repo",
						sourceRemoteUrl: "https://github.com/other/repo.git",
					});

					const handler = getRegisteredCommand("jollimemory.openMemoryFile");
					await handler("/fake/foreign-repo-summary.md");

					expect(mockBridge.getSummaryAnyRepoWithSource).toHaveBeenCalledWith(
						"deadbeefcafef00d",
					);
					expect(MockSummaryWebviewPanel.show).toHaveBeenCalledWith(
						summary,
						expect.anything(),
						"/test/workspace",
						mockBridge,
						expect.any(String),
						"kb",
						"other-repo",
						"https://github.com/other/repo.git",
					);
					expect(executeCommand).not.toHaveBeenCalledWith(
						"markdown.showPreview",
						expect.anything(),
					);
				});
			});
		});
	});

	// ── refreshStatusBar ──────────────────────────────────────────────

	describe("refreshStatusBar", () => {
		it("updates status bar and providers with enabled status during activation", async () => {
			mockBridge.getStatus.mockResolvedValue({ enabled: true });

			const ctx = makeContext();
			activate(ctx);

			// refreshStatusBar is called during initialLoad
			await vi.waitFor(() => {
				expect(mockStatusBar.update).toHaveBeenCalledWith(true);
			});

			expect(mockMemoriesStore.setEnabled).toHaveBeenCalledWith(true);
			expect(mockPlansStore.setEnabled).toHaveBeenCalledWith(true);
			expect(mockFilesStore.setEnabled).toHaveBeenCalledWith(true);
			expect(mockCommitsStore.setEnabled).toHaveBeenCalledWith(true);
			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.enabled",
				true,
			);
		});

		it("propagates disabled status to all providers", async () => {
			mockBridge.getStatus.mockResolvedValue({ enabled: false });

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(mockStatusBar.update).toHaveBeenCalledWith(false);
			});

			expect(mockMemoriesStore.setEnabled).toHaveBeenCalledWith(false);
			expect(mockPlansStore.setEnabled).toHaveBeenCalledWith(false);
			expect(mockFilesStore.setEnabled).toHaveBeenCalledWith(false);
			expect(mockCommitsStore.setEnabled).toHaveBeenCalledWith(false);
			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.enabled",
				false,
			);
		});
	});

	// ── handleError ───────────────────────────────────────────────────

	describe("handleError", () => {
		let ctx: vscode.ExtensionContext;

		beforeEach(() => {
			ctx = makeContext();
			activate(ctx);
		});

		it("shows error message with Error.message when a command handler rejects with an Error", async () => {
			mockStatusStore.refresh.mockRejectedValueOnce(
				new Error("refresh failed"),
			);

			const handler = getRegisteredCommand("jollimemory.refreshStatus");
			handler(); // fire-and-forget, uses .catch(handleError(...))

			await vi.waitFor(() => {
				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("refresh failed"),
				);
			});
		});

		it("shows stringified message when a command handler rejects with a non-Error", async () => {
			mockStatusStore.refresh.mockRejectedValueOnce("some string error");

			const handler = getRegisteredCommand("jollimemory.refreshStatus");
			handler();

			await vi.waitFor(() => {
				expect(showErrorMessage).toHaveBeenCalledWith(
					expect.stringContaining("some string error"),
				);
			});
		});
	});

	// ── migration error paths ─────────────────────────────────────────

	describe("migration error handling", () => {
		it("logs error and clears migrating state when V1 migration throws", async () => {
			hasV1Branch.mockResolvedValue(true);
			hasMigrationMeta.mockResolvedValue(false);
			migrateV1toV3.mockRejectedValue(new Error("disk full"));

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(error).toHaveBeenCalledWith(
					"migrate",
					"V1 → V3 migration failed",
					expect.any(Error),
				);
			});

			// Migration state should be cleared in finally block
			expect(mockStatusStore.setMigrating).toHaveBeenCalledWith(false);
			expect(mockCommitsStore.setMigrating).toHaveBeenCalledWith(false);
			expect(mockFilesStore.setMigrating).toHaveBeenCalledWith(false);

			// Providers should still be refreshed in finally block
			expect(mockStatusStore.refresh).toHaveBeenCalled();
			expect(mockCommitsStore.refresh).toHaveBeenCalled();
		});

		it("logs error and clears migrating state when index migration throws", async () => {
			indexNeedsMigration.mockResolvedValue(true);
			migrateIndexToV3.mockRejectedValue(new Error("corrupt index"));

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(error).toHaveBeenCalledWith(
					"migrate",
					"Index v1 → v3 migration failed",
					expect.any(Error),
				);
			});

			expect(mockStatusStore.setMigrating).toHaveBeenCalledWith(false);
			expect(mockCommitsStore.setMigrating).toHaveBeenCalledWith(false);
			expect(mockFilesStore.setMigrating).toHaveBeenCalledWith(false);
		});
	});

	// ── migration check throw paths ──────────────────────────────────

	describe("migration check failures", () => {
		it("logs error when indexNeedsMigration itself throws", async () => {
			indexNeedsMigration.mockRejectedValue(new Error("git error"));
			const ctx = makeContext();
			activate(ctx);
			await vi.waitFor(() => {
				expect(error).toHaveBeenCalledWith(
					"migrate",
					"Index migration check failed",
					expect.any(Error),
				);
			});
			expect(migrateIndexToV3).not.toHaveBeenCalled();
		});

		it("logs error when hasV1Branch throws during V1 migration check", async () => {
			hasV1Branch.mockRejectedValue(new Error("git error"));
			const ctx = makeContext();
			activate(ctx);
			await vi.waitFor(() => {
				expect(error).toHaveBeenCalledWith(
					"migrate",
					"V1 migration check failed",
					expect.any(Error),
				);
			});
			expect(migrateV1toV3).not.toHaveBeenCalled();
		});

		it("logs error when hasMigrationMeta throws during V1 migration check", async () => {
			hasV1Branch.mockResolvedValue(true);
			hasMigrationMeta.mockRejectedValue(new Error("read error"));
			const ctx = makeContext();
			activate(ctx);
			await vi.waitFor(() => {
				expect(error).toHaveBeenCalledWith(
					"migrate",
					"V1 migration check failed",
					expect.any(Error),
				);
			});
			expect(migrateV1toV3).not.toHaveBeenCalled();
		});
	});

	// ── copyCommitHash — showInformationMessage in .then() ────────────

	describe("copyCommitHash — information message", () => {
		let ctx: vscode.ExtensionContext;

		beforeEach(() => {
			ctx = makeContext();
			activate(ctx);
		});

		it("shows information message with short hash after copying a plain string", async () => {
			const handler = getRegisteredCommand("jollimemory.copyCommitHash");
			handler("abc1234567890");

			// The handler calls clipboard.writeText().then(...), so we need to flush the microtask
			await vi.waitFor(() => {
				expect(showInformationMessage).toHaveBeenCalledWith(
					"Jolli Memory: Copied abc1234 to clipboard.",
				);
			});
		});

		it("shows information message with short hash after copying from CommitItem", async () => {
			const handler = getRegisteredCommand("jollimemory.copyCommitHash");
			handler({ commit: { hash: "def9876543210", shortHash: "def9876" } });

			await vi.waitFor(() => {
				expect(showInformationMessage).toHaveBeenCalledWith(
					"Jolli Memory: Copied def9876 to clipboard.",
				);
			});
		});
	});

	// NOTE: filesView.onDidChangeCheckboxState, historyView.onDidChangeCheckboxState,
	// and memoriesView.onDidChangeVisibility tests were removed in Task 8.
	// The 5 tree views were replaced by a single SidebarWebviewProvider (jollimemory.mainView).
	// These callbacks will be re-wired via webview messages in later phases.

	describe("watcher callbacks", () => {
		let ctx: vscode.ExtensionContext;

		beforeEach(() => {
			ctx = makeContext();
			activate(ctx);
		});

		it("refreshes history and plans when the worker lock is deleted", async () => {
			const lockWatcher = createFileSystemWatcher.mock.results[3]?.value;
			const onDelete = lockWatcher?.onDidDelete.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;

			expect(onDelete).toBeDefined();
			onDelete?.();

			await vi.waitFor(() => {
				expect(mockStatusStore.setWorkerBusy).toHaveBeenCalledWith(false);
				expect(mockCommitsStore.refresh).toHaveBeenCalled();
				expect(mockPlansStore.refresh).toHaveBeenCalled();
			});
			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.workerBusy",
				false,
			);
		});

		it("marks the worker busy when the lock watcher is created or changed", () => {
			const lockWatcher = createFileSystemWatcher.mock.results[3]?.value;
			const onCreate = lockWatcher?.onDidCreate.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const onChange = lockWatcher?.onDidChange.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;

			onCreate?.();
			onChange?.();

			expect(mockStatusStore.setWorkerBusy).toHaveBeenCalledWith(true);
			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.workerBusy",
				true,
			);
		});

		it("refreshes status and plans when sessions watcher fires", async () => {
			const sessionsWatcher = createFileSystemWatcher.mock.results[0]?.value;
			const onCreate = sessionsWatcher?.onDidCreate.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const onChange = sessionsWatcher?.onDidChange.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;

			expect(onCreate).toBeDefined();
			expect(onChange).toBeDefined();

			onCreate?.();
			onChange?.();

			await vi.waitFor(() => {
				expect(mockStatusStore.refresh).toHaveBeenCalled();
				expect(mockPlansStore.refresh).toHaveBeenCalled();
			});
		});

		// Plans watchers (plansDir, plansJson, notesDir) and the registerNewPlan
		// event pipeline have moved into PlansStore.  See PlansStore.test.ts
		// for the replacement coverage; the legacy tests below are superseded.

		it.skip("moved to PlansStore — debounces plans directory watcher refreshes", async () => {
			vi.useFakeTimers();
			const plansWatcher = createFileSystemWatcher.mock.results[1]?.value;
			const onCreate = plansWatcher?.onDidCreate.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const onChange = plansWatcher?.onDidChange.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const onDelete = plansWatcher?.onDidDelete.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const refreshCallsBefore = mockPlansStore.refresh.mock.calls.length;

			onCreate?.();
			onChange?.();
			onDelete?.();
			expect(mockPlansStore.refresh.mock.calls.length).toBe(refreshCallsBefore);

			vi.advanceTimersByTime(499);
			expect(mockPlansStore.refresh.mock.calls.length).toBe(refreshCallsBefore);

			vi.advanceTimersByTime(1);
			await vi.runAllTicks();
			expect(mockPlansStore.refresh.mock.calls.length).toBe(
				refreshCallsBefore + 1,
			);
			vi.useRealTimers();
		});

		it.skip("moved to PlansStore — registers a new plan when plansDirWatcher.onDidCreate fires for a .md file", async () => {
			const plansWatcher = createFileSystemWatcher.mock.results[1]?.value;
			const onCreate = plansWatcher?.onDidCreate.mock.calls[1]?.[0] as
				| ((uri: { fsPath: string }) => void)
				| undefined;
			expect(onCreate).toBeDefined();
			registerNewPlan.mockClear();
			isPlanFromCurrentProject.mockClear();
			isPlanFromCurrentProject.mockResolvedValueOnce(true);

			onCreate?.({ fsPath: "/home/user/.claude/plans/fresh-slug.md" });

			await vi.waitFor(() => {
				expect(registerNewPlan).toHaveBeenCalledWith(
					"fresh-slug",
					"/test/workspace",
				);
			});
			expect(isPlanFromCurrentProject).toHaveBeenCalledWith(
				"/home/user/.claude/plans/fresh-slug.md",
				"/test/workspace",
			);
		});

		it.skip("moved to PlansStore — does NOT register a plan when transcript attribution fails (cross-project leak guard)", async () => {
			const plansWatcher = createFileSystemWatcher.mock.results[1]?.value;
			const onCreate = plansWatcher?.onDidCreate.mock.calls[1]?.[0] as
				| ((uri: { fsPath: string }) => void)
				| undefined;
			registerNewPlan.mockClear();
			isPlanFromCurrentProject.mockClear();
			isPlanFromCurrentProject.mockResolvedValueOnce(false);

			onCreate?.({ fsPath: "/home/user/.claude/plans/foreign-plan.md" });

			await vi.waitFor(() => {
				expect(isPlanFromCurrentProject).toHaveBeenCalled();
			});
			expect(registerNewPlan).not.toHaveBeenCalled();
		});

		it.skip("moved to PlansStore — skips non-.md files in plansDirWatcher.onDidCreate", async () => {
			const plansWatcher = createFileSystemWatcher.mock.results[1]?.value;
			const onCreate = plansWatcher?.onDidCreate.mock.calls[1]?.[0] as
				| ((uri: { fsPath: string }) => void)
				| undefined;
			registerNewPlan.mockClear();

			onCreate?.({ fsPath: "/home/user/.claude/plans/not-a-plan.txt" });
			await Promise.resolve();

			expect(registerNewPlan).not.toHaveBeenCalled();
		});

		it.skip("moved to PlansStore — serializes back-to-back registrations so later events cannot clobber earlier writes", async () => {
			const plansWatcher = createFileSystemWatcher.mock.results[1]?.value;
			const onCreate = plansWatcher?.onDidCreate.mock.calls[1]?.[0] as
				| ((uri: { fsPath: string }) => void)
				| undefined;
			registerNewPlan.mockClear();

			onCreate?.({ fsPath: "/home/user/.claude/plans/first.md" });
			onCreate?.({ fsPath: "/home/user/.claude/plans/second.md" });

			await vi.waitFor(() => {
				expect(registerNewPlan).toHaveBeenCalledTimes(2);
			});
			expect(registerNewPlan.mock.calls[0]).toEqual([
				"first",
				"/test/workspace",
			]);
			expect(registerNewPlan.mock.calls[1]).toEqual([
				"second",
				"/test/workspace",
			]);
		});

		it.skip("moved to PlansStore — swallows errors from registerNewPlan without crashing the extension", async () => {
			const plansWatcher = createFileSystemWatcher.mock.results[1]?.value;
			const onCreate = plansWatcher?.onDidCreate.mock.calls[1]?.[0] as
				| ((uri: { fsPath: string }) => void)
				| undefined;
			registerNewPlan.mockRejectedValueOnce(new Error("registry write failed"));

			onCreate?.({ fsPath: "/home/user/.claude/plans/err.md" });

			await vi.waitFor(() => {
				expect(registerNewPlan).toHaveBeenCalledWith("err", "/test/workspace");
			});
		});

		it.skip("moved to PlansStore — refreshes plans panel (debounced) when plans.json is written", async () => {
			vi.useFakeTimers();
			const plansJsonWatcher = createFileSystemWatcher.mock.results[2]?.value;
			const onCreate = plansJsonWatcher?.onDidCreate.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const onChange = plansJsonWatcher?.onDidChange.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const refreshCallsBefore = mockPlansStore.refresh.mock.calls.length;

			// Simulate StopHook writing plans.json (triggers change) and first-time
			// creation (triggers create). Both feed into the same debounced callback.
			onCreate?.();
			onChange?.();
			expect(mockPlansStore.refresh.mock.calls.length).toBe(refreshCallsBefore);

			vi.advanceTimersByTime(499);
			expect(mockPlansStore.refresh.mock.calls.length).toBe(refreshCallsBefore);

			vi.advanceTimersByTime(1);
			await vi.runAllTicks();
			expect(mockPlansStore.refresh.mock.calls.length).toBe(
				refreshCallsBefore + 1,
			);
			vi.useRealTimers();
		});

		it.skip("moved to PlansStore — debounces notes directory watcher refreshes", async () => {
			vi.useFakeTimers();
			const notesWatcher = createFileSystemWatcher.mock.results[3]?.value;
			const onCreate = notesWatcher?.onDidCreate.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const onChange = notesWatcher?.onDidChange.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const onDelete = notesWatcher?.onDidDelete.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const refreshCallsBefore = mockPlansStore.refresh.mock.calls.length;

			onCreate?.();
			onChange?.();
			onDelete?.();
			expect(mockPlansStore.refresh.mock.calls.length).toBe(refreshCallsBefore);

			vi.advanceTimersByTime(499);
			expect(mockPlansStore.refresh.mock.calls.length).toBe(refreshCallsBefore);

			vi.advanceTimersByTime(1);
			await vi.runAllTicks();
			expect(mockPlansStore.refresh.mock.calls.length).toBe(
				refreshCallsBefore + 1,
			);
			vi.useRealTimers();
		});

		it("notifies plansStore when an external markdown note is saved", async () => {
			const saveCallback = onDidSaveTextDocument.mock.calls[0]?.[0] as
				| ((doc: { fileName: string }) => Promise<void>)
				| undefined;
			expect(saveCallback).toBeDefined();

			// Mock bridge.listNotes to return a markdown note at an external path
			mockBridge.listNotes.mockResolvedValue([
				{
					id: "ext-md",
					title: "External",
					format: "markdown",
					filePath: "/user/docs/readme.md",
				},
			]);

			// Save the external markdown file — the handler should short-circuit
			// when the notes dir prefix does not match and then resolve without
			// throwing.  Actual debounce + refresh behaviour is covered by
			// PlansStore tests.
			await expect(
				saveCallback?.({ fileName: "/user/docs/readme.md" }),
			).resolves.toBeUndefined();
		});

		it("does not refresh sidebar when a non-note markdown file is saved", async () => {
			vi.useFakeTimers();
			const saveCallback = onDidSaveTextDocument.mock.calls[0]?.[0] as
				| ((doc: { fileName: string }) => Promise<void>)
				| undefined;

			mockBridge.listNotes.mockResolvedValue([
				{
					id: "ext-md",
					title: "External",
					format: "markdown",
					filePath: "/user/docs/readme.md",
				},
			]);
			const refreshCallsBefore = mockPlansStore.refresh.mock.calls.length;

			// Save a different .md file — should NOT trigger refresh
			await saveCallback?.({ fileName: "/user/docs/other.md" });
			vi.advanceTimersByTime(500);
			await vi.runAllTicks();

			expect(mockPlansStore.refresh.mock.calls.length).toBe(refreshCallsBefore);
			vi.useRealTimers();
		});

		it("skips markdown files inside the notes dir (handled by file watcher)", async () => {
			const saveCallback = onDidSaveTextDocument.mock.calls[0]?.[0] as
				| ((doc: { fileName: string }) => Promise<void>)
				| undefined;
			mockBridge.listNotes.mockClear();

			await saveCallback?.({
				fileName: "/test/workspace/.jolli/jollimemory/notes/my-note.md",
			});

			expect(mockBridge.listNotes).not.toHaveBeenCalled();
		});

		it("skips non-markdown file saves without calling listNotes", async () => {
			const saveCallback = onDidSaveTextDocument.mock.calls[0]?.[0] as
				| ((doc: { fileName: string }) => Promise<void>)
				| undefined;
			mockBridge.listNotes.mockClear();

			await saveCallback?.({ fileName: "/user/code/app.ts" });

			expect(mockBridge.listNotes).not.toHaveBeenCalled();
		});

		it("skips files inside the notes directory", async () => {
			const saveCallback = onDidSaveTextDocument.mock.calls[0]?.[0] as
				| ((doc: { fileName: string }) => Promise<void>)
				| undefined;
			mockBridge.listNotes.mockClear();

			// Save a file inside the notes dir — should short-circuit before calling listNotes
			await saveCallback?.({
				fileName: "/test/workspace/.jolli/jollimemory/notes/existing.md",
			});

			expect(mockBridge.listNotes).not.toHaveBeenCalled();
		});

		it("silently catches when listNotes throws during onDidSaveTextDocument", async () => {
			const saveCallback = onDidSaveTextDocument.mock.calls[0]?.[0] as
				| ((doc: { fileName: string }) => Promise<void>)
				| undefined;
			mockBridge.listNotes.mockRejectedValueOnce(new Error("git error"));

			// Should not throw — the catch block silently swallows the error
			await expect(
				saveCallback?.({ fileName: "/external/file.md" }),
			).resolves.toBeUndefined();
		});

		it("wires HEAD watcher to refresh callback", () => {
			// HEAD watcher calls store.refresh directly now; store instances
			// are mocked separately from providers, so we only assert the
			// watcher callbacks are registered and runnable without throwing.
			const headWatcher = createFileSystemWatcher.mock.results[1]?.value;
			const onChange = headWatcher?.onDidChange.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const onCreate = headWatcher?.onDidCreate.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			expect(onChange).toBeDefined();
			expect(onCreate).toBeDefined();
			expect(() => onChange?.()).not.toThrow();
			expect(() => onCreate?.()).not.toThrow();
		});

		it("HEAD watcher re-reads bridge.getCurrentBranch so branch label tracks branch switches", async () => {
			// Activation called getCurrentBranch once at startup. After a HEAD
			// change (branch switch / detached checkout), the watcher MUST call
			// it again — otherwise currentBranchName freezes at the activation
			// value and the Branch tab label drifts out of sync with the
			// workspace's actual HEAD.
			const callsBefore = mockBridge.getCurrentBranch.mock.calls.length;
			const headWatcher = createFileSystemWatcher.mock.results[1]?.value;
			const onChange = headWatcher?.onDidChange.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			expect(onChange).toBeDefined();
			onChange?.();
			// Allow the queued microtask (refreshBranchName is async) to flush.
			await Promise.resolve();
			expect(mockBridge.getCurrentBranch.mock.calls.length).toBeGreaterThan(
				callsBefore,
			);
		});

		it("wires orphan branch watcher to refresh callback", () => {
			const orphanWatcher = createFileSystemWatcher.mock.results[2]?.value;
			const onCreate = orphanWatcher?.onDidCreate.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			const onChange = orphanWatcher?.onDidChange.mock.calls[0]?.[0] as
				| (() => void)
				| undefined;
			expect(onCreate).toBeDefined();
			expect(onChange).toBeDefined();
			expect(() => onCreate?.()).not.toThrow();
			expect(() => onChange?.()).not.toThrow();
		});

		// History title now updates via `commitsStore.onChange` in Extension.ts;
		// the `isMerged` flag lives on the snapshot.  Direct unit coverage for
		// this wiring has moved to the CommitsStore tests.
	});

	// Badge-update behaviour is now driven by `filesStore.onChange` →
	// `updateFilesBadge()` inside Extension.ts.  The data-shaping logic
	// (pluralisation, 0-case) is covered by Store / DataService unit tests;
	// Extension.ts wiring is verified indirectly by activation not throwing.

	// filesView.description ("N files hidden") is now driven by
	// filesStore.onChange via updateFilesViewUI() in Extension.ts.  Data
	// shaping (pluralisation / 0-case / clear-on-zero) is unit-tested against
	// snapshot values directly; the store subscription wiring is verified
	// indirectly by activation not throwing.

	// ── openFileChange command ────────────────────────────────────────

	describe("openFileChange command", () => {
		let ctx: vscode.ExtensionContext;

		beforeEach(() => {
			ctx = makeContext();
			// Make Uri.file return objects with a working `with` method for toGitUri
			vi.mocked(vscode.Uri.file).mockImplementation(
				(p: string) =>
					({
						fsPath: p,
						scheme: "file",
						with: vi.fn((change: { scheme: string; query: string }) => ({
							fsPath: p,
							scheme: change.scheme,
							query: change.query,
						})),
					}) as never,
			);
			activate(ctx);
		});

		it("opens the file directly for untracked files (statusCode '?')", async () => {
			const handler = getRegisteredCommand("jollimemory.openFileChange");
			await handler({
				fileStatus: {
					absolutePath: "/repo/new.ts",
					statusCode: "?",
					indexStatus: "?",
					worktreeStatus: "?",
					isSelected: false,
					relativePath: "new.ts",
				},
			});

			expect(showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: "/repo/new.ts" }),
			);
		});

		it("opens the file directly for added files (statusCode 'A')", async () => {
			const handler = getRegisteredCommand("jollimemory.openFileChange");
			await handler({
				fileStatus: {
					absolutePath: "/repo/added.ts",
					statusCode: "A",
					indexStatus: "A",
					worktreeStatus: " ",
					isSelected: false,
					relativePath: "added.ts",
				},
			});

			expect(showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ fsPath: "/repo/added.ts" }),
			);
		});

		it("shows HEAD version for deleted files (statusCode 'D')", async () => {
			const handler = getRegisteredCommand("jollimemory.openFileChange");
			await handler({
				fileStatus: {
					absolutePath: "/repo/gone.ts",
					statusCode: "D",
					indexStatus: "D",
					worktreeStatus: " ",
					isSelected: false,
					relativePath: "gone.ts",
				},
			});

			expect(showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ scheme: "git" }),
				{
					preview: true,
				},
			);
		});

		it("opens diff between HEAD and Working Tree for modified files", async () => {
			const handler = getRegisteredCommand("jollimemory.openFileChange");
			await handler({
				fileStatus: {
					absolutePath: "/repo/mod.ts",
					statusCode: "M",
					indexStatus: "M",
					worktreeStatus: " ",
					isSelected: true,
					relativePath: "mod.ts",
				},
			});

			expect(executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.objectContaining({ scheme: "git" }), // HEAD
				expect.objectContaining({ scheme: "file" }), // Working tree
				"mod.ts (HEAD ↔ Working Tree)",
			);
		});

		it("opens diff between HEAD and Working Tree for modified unstaged files", async () => {
			const handler = getRegisteredCommand("jollimemory.openFileChange");
			await handler({
				fileStatus: {
					absolutePath: "/repo/mod.ts",
					statusCode: "M",
					indexStatus: " ",
					worktreeStatus: "M",
					isSelected: false,
					relativePath: "mod.ts",
				},
			});

			expect(executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.objectContaining({ scheme: "git" }), // HEAD
				expect.objectContaining({ fsPath: "/repo/mod.ts", scheme: "file" }), // Working Tree
				"mod.ts (HEAD ↔ Working Tree)",
			);
		});
	});

	// ── openCommitFileChange command ─────────────────────────────────

	describe("openCommitFileChange command", () => {
		let ctx: vscode.ExtensionContext;

		beforeEach(() => {
			ctx = makeContext();
			vi.mocked(vscode.Uri.file).mockImplementation(
				(p: string) =>
					({
						fsPath: p,
						scheme: "file",
						with: vi.fn((change: { scheme: string; query: string }) => ({
							fsPath: p,
							scheme: change.scheme,
							query: change.query,
						})),
					}) as never,
			);
			activate(ctx);
		});

		it("shows file at commit ref for added files (statusCode 'A')", async () => {
			const handler = getRegisteredCommand("jollimemory.openCommitFileChange");
			await handler({
				commitHash: "abc1234567890",
				relativePath: "src/New.ts",
				statusCode: "A",
			});

			expect(showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ scheme: "git" }),
				{
					preview: true,
				},
			);
		});

		it("shows file at parent ref for deleted files (statusCode 'D')", async () => {
			const handler = getRegisteredCommand("jollimemory.openCommitFileChange");
			await handler({
				commitHash: "abc1234567890",
				relativePath: "src/Gone.ts",
				statusCode: "D",
			});

			expect(showTextDocument).toHaveBeenCalledWith(
				expect.objectContaining({ scheme: "git" }),
				{
					preview: true,
				},
			);
		});

		it("opens two-pane diff for modified files", async () => {
			const handler = getRegisteredCommand("jollimemory.openCommitFileChange");
			await handler({
				commitHash: "abc1234567890",
				relativePath: "src/Mod.ts",
				statusCode: "M",
			});

			expect(executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.objectContaining({ scheme: "git" }), // parent
				expect.objectContaining({ scheme: "git" }), // commit
				"src/Mod.ts (abc1234~1 ↔ abc1234)",
			);
		});

		it("opens two-pane diff with old/new paths for renamed files", async () => {
			const handler = getRegisteredCommand("jollimemory.openCommitFileChange");
			await handler({
				commitHash: "abc1234567890",
				relativePath: "src/New.ts",
				statusCode: "R",
				oldPath: "src/Old.ts",
			});

			expect(executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.objectContaining({ scheme: "git" }), // old path at parent
				expect.objectContaining({ scheme: "git" }), // new path at commit
				"src/New.ts (abc1234~1 ↔ abc1234)",
			);
		});

		it("falls through to modified diff when rename has no oldPath", async () => {
			const handler = getRegisteredCommand("jollimemory.openCommitFileChange");
			await handler({
				commitHash: "abc1234567890",
				relativePath: "src/File.ts",
				statusCode: "R",
				// no oldPath
			});

			expect(executeCommand).toHaveBeenCalledWith(
				"vscode.diff",
				expect.objectContaining({ scheme: "git" }),
				expect.objectContaining({ scheme: "git" }),
				"src/File.ts (abc1234~1 ↔ abc1234)",
			);
		});
	});

	// ── discardFileChanges ──────────────────────────────────────────

	describe("discardFileChanges command", () => {
		it("discards a single file after confirmation", async () => {
			showWarningMessage.mockResolvedValue("Discard");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			await handler({
				fileStatus: {
					absolutePath: "/repo/file.ts",
					relativePath: "file.ts",
					statusCode: "M",
					indexStatus: " ",
					worktreeStatus: "M",
					isSelected: true,
				},
			});

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("file.ts"),
				expect.objectContaining({ modal: true }),
				"Discard",
			);
			expect(mockBridge.discardFiles).toHaveBeenCalledWith([
				expect.objectContaining({ relativePath: "file.ts" }),
			]);
			expect(mockFilesStore.deselectPaths).toHaveBeenCalledWith(["file.ts"]);
			expect(mockFilesStore.refresh).toHaveBeenCalledWith(true);
		});

		it("does nothing when user cancels confirmation", async () => {
			showWarningMessage.mockResolvedValue(undefined);
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			await handler({
				fileStatus: {
					absolutePath: "/repo/file.ts",
					relativePath: "file.ts",
					statusCode: "M",
					indexStatus: " ",
					worktreeStatus: "M",
					isSelected: false,
				},
			});

			expect(mockBridge.discardFiles).not.toHaveBeenCalled();
		});

		it("uses 'Delete' verb for untracked files", async () => {
			showWarningMessage.mockResolvedValue("Delete");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			await handler({
				fileStatus: {
					absolutePath: "/repo/new.ts",
					relativePath: "new.ts",
					statusCode: "?",
					indexStatus: "?",
					worktreeStatus: "?",
					isSelected: false,
				},
			});

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("Delete"),
				expect.objectContaining({ modal: true }),
				"Delete",
			);
			expect(mockBridge.discardFiles).toHaveBeenCalled();
		});

		it("uses 'Delete' verb for added files", async () => {
			showWarningMessage.mockResolvedValue("Delete");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			await handler({
				fileStatus: {
					absolutePath: "/repo/added.ts",
					relativePath: "added.ts",
					statusCode: "A",
					indexStatus: "A",
					worktreeStatus: " ",
					isSelected: false,
				},
			});

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("Delete"),
				expect.objectContaining({
					modal: true,
					detail: expect.stringContaining("permanently delete"),
				}),
				"Delete",
			);
			expect(mockBridge.discardFiles).toHaveBeenCalled();
		});

		it("uses 'Delete' verb for renamed files", async () => {
			showWarningMessage.mockResolvedValue("Delete");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			await handler({
				fileStatus: {
					absolutePath: "/repo/new.ts",
					relativePath: "new.ts",
					statusCode: "R",
					indexStatus: "R",
					worktreeStatus: " ",
					originalPath: "old.ts",
					isSelected: false,
				},
			});

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("Delete"),
				expect.objectContaining({
					modal: true,
					detail: expect.stringContaining("permanently delete"),
				}),
				"Delete",
			);
			expect(mockBridge.discardFiles).toHaveBeenCalled();
		});

		it("shows error message and refreshes panel when discard fails", async () => {
			showWarningMessage.mockResolvedValue("Discard");
			mockBridge.discardFiles.mockRejectedValueOnce(new Error("git failed"));
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			await handler({
				fileStatus: {
					absolutePath: "/repo/file.ts",
					relativePath: "file.ts",
					statusCode: "M",
					indexStatus: " ",
					worktreeStatus: "M",
					isSelected: false,
				},
			});

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("git failed"),
			);
			expect(mockFilesStore.refresh).toHaveBeenCalledWith(true);
		});

		it("returns early when called with no item (null guard)", async () => {
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			// Call with undefined — should hit the `if (!item?.fileStatus)` guard
			await handler(undefined);

			expect(showWarningMessage).not.toHaveBeenCalled();
			expect(mockBridge.discardFiles).not.toHaveBeenCalled();
		});

		it("returns early when called with item missing fileStatus", async () => {
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			// Call with an object that has no fileStatus property
			await handler({});

			expect(showWarningMessage).not.toHaveBeenCalled();
			expect(mockBridge.discardFiles).not.toHaveBeenCalled();
		});

		it("rejects malformed fileStatus where indexStatus / worktreeStatus are empty strings", async () => {
			// DOM readers fall through to '' when an attribute is missing.
			// Porcelain v1 columns are always exactly one character — the
			// length===1 check rejects both undefined and '' so a future
			// webview-side regression that drops one of the data-* attrs
			// surfaces the same loud error.
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			await handler({
				fileStatus: {
					absolutePath: "/repo/file.ts",
					relativePath: "file.ts",
					statusCode: "M",
					indexStatus: "",
					worktreeStatus: "",
				},
			});

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining('Cannot discard "file.ts" — internal error'),
			);
			expect(mockBridge.discardFiles).not.toHaveBeenCalled();
		});

		it("rejects malformed fileStatus that is missing indexStatus / worktreeStatus", async () => {
			// Defense in depth: bridge.discardFiles dispatches on the raw
			// porcelain columns. A previous version of branch:discardFile only
			// forwarded statusCode, which silently routed every file (including
			// untracked) into the `git restore --staged --worktree` branch and
			// failed without surfacing — the activity-bar badge then showed the
			// pre-discard count even though the user had "discarded" the file.
			// The guard makes any future caller that strips the columns loud-fail
			// at the boundary with an error toast, rather than corrupting state.
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand("jollimemory.discardFileChanges");

			await handler({
				fileStatus: {
					absolutePath: "/repo/untracked.ts",
					relativePath: "untracked.ts",
					statusCode: "?",
					// intentionally missing indexStatus / worktreeStatus
				},
			});

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining(
					'Cannot discard "untracked.ts" — internal error',
				),
			);
			expect(showWarningMessage).not.toHaveBeenCalled();
			expect(mockBridge.discardFiles).not.toHaveBeenCalled();
		});
	});

	// ── discardSelectedChanges ──────────────────────────────────────

	describe("discardSelectedChanges command", () => {
		it("discards all selected files after confirmation", async () => {
			const selectedFiles = [
				{
					absolutePath: "/repo/a.ts",
					relativePath: "a.ts",
					statusCode: "M",
					indexStatus: " ",
					worktreeStatus: "M",
					isSelected: true,
				},
				{
					absolutePath: "/repo/b.ts",
					relativePath: "b.ts",
					statusCode: "M",
					indexStatus: "M",
					worktreeStatus: " ",
					isSelected: true,
				},
			];
			mockFilesStore.getSnapshot.mockReturnValue({
				selectedFiles,
				files: selectedFiles,
				visibleFiles: selectedFiles,
				excludedCount: 0,
				visibleCount: selectedFiles.length,
				isEmpty: false,
				isEnabled: true,
				isMigrating: false,
				changeReason: "refresh",
			});
			showWarningMessage.mockResolvedValue("Discard All");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand(
				"jollimemory.discardSelectedChanges",
			);

			await handler();

			expect(mockBridge.discardFiles).toHaveBeenCalledWith(selectedFiles);
			expect(mockFilesStore.refresh).toHaveBeenCalledWith(true);
		});

		it("shows info message when no files are selected", async () => {
			mockFilesStore.getSnapshot.mockReturnValue({
				selectedFiles: [],
				files: [],
				visibleFiles: [],
				excludedCount: 0,
				visibleCount: 0,
				isEmpty: false,
				isEnabled: true,
				isMigrating: false,
				changeReason: "refresh",
			});
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand(
				"jollimemory.discardSelectedChanges",
			);

			await handler();

			expect(showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("No files selected"),
			);
			expect(mockBridge.discardFiles).not.toHaveBeenCalled();
		});

		it("warns about files that will be deleted in batch confirmation", async () => {
			const selectedFiles = [
				{
					absolutePath: "/repo/mod.ts",
					relativePath: "mod.ts",
					statusCode: "M",
					indexStatus: " ",
					worktreeStatus: "M",
					isSelected: true,
				},
				{
					absolutePath: "/repo/new.ts",
					relativePath: "new.ts",
					statusCode: "?",
					indexStatus: "?",
					worktreeStatus: "?",
					isSelected: true,
				},
				{
					absolutePath: "/repo/added.ts",
					relativePath: "added.ts",
					statusCode: "A",
					indexStatus: "A",
					worktreeStatus: " ",
					isSelected: true,
				},
				{
					absolutePath: "/repo/renamed.ts",
					relativePath: "renamed.ts",
					statusCode: "R",
					indexStatus: "R",
					worktreeStatus: " ",
					originalPath: "original.ts",
					isSelected: true,
				},
			];
			mockFilesStore.getSnapshot.mockReturnValue({
				selectedFiles,
				files: selectedFiles,
				visibleFiles: selectedFiles,
				excludedCount: 0,
				visibleCount: selectedFiles.length,
				isEmpty: false,
				isEnabled: true,
				isMigrating: false,
				changeReason: "refresh",
			});
			showWarningMessage.mockResolvedValue("Discard All");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand(
				"jollimemory.discardSelectedChanges",
			);

			await handler();

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("4 selected files"),
				expect.objectContaining({
					modal: true,
					detail: expect.stringContaining(
						"3 files will be permanently deleted",
					),
				}),
				"Discard All",
			);
		});

		it("uses singular 'file' when only 1 file will be deleted", async () => {
			const selectedFiles = [
				{
					absolutePath: "/repo/new.ts",
					relativePath: "new.ts",
					statusCode: "?",
					indexStatus: "?",
					worktreeStatus: "?",
					isSelected: true,
				},
			];
			mockFilesStore.getSnapshot.mockReturnValue({
				selectedFiles,
				files: selectedFiles,
				visibleFiles: selectedFiles,
				excludedCount: 0,
				visibleCount: selectedFiles.length,
				isEmpty: false,
				isEnabled: true,
				isMigrating: false,
				changeReason: "refresh",
			});
			showWarningMessage.mockResolvedValue("Discard All");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand(
				"jollimemory.discardSelectedChanges",
			);

			await handler();

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("1 selected file?"),
				expect.objectContaining({
					modal: true,
					detail: expect.stringContaining("1 file will be permanently deleted"),
				}),
				"Discard All",
			);
		});

		it("handles non-Error rejection in discardSelectedChanges", async () => {
			mockFilesStore.getSnapshot.mockReturnValue({
				selectedFiles: [
					{
						absolutePath: "/repo/a.ts",
						relativePath: "a.ts",
						statusCode: "M",
						indexStatus: " ",
						worktreeStatus: "M",
						isSelected: true,
					},
				],
				files: [
					{
						absolutePath: "/repo/a.ts",
						relativePath: "a.ts",
						statusCode: "M",
						indexStatus: " ",
						worktreeStatus: "M",
						isSelected: true,
					},
				],
				visibleFiles: [
					{
						absolutePath: "/repo/a.ts",
						relativePath: "a.ts",
						statusCode: "M",
						indexStatus: " ",
						worktreeStatus: "M",
						isSelected: true,
					},
				],
				excludedCount: 0,
				visibleCount: 0,
				isEmpty: false,
				isEnabled: true,
				isMigrating: false,
				changeReason: "refresh",
			});
			showWarningMessage.mockResolvedValue("Discard All");
			mockBridge.discardFiles.mockRejectedValueOnce("raw string error");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand(
				"jollimemory.discardSelectedChanges",
			);

			await handler();

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("raw string error"),
			);
		});

		it("does nothing when user cancels confirmation", async () => {
			mockFilesStore.getSnapshot.mockReturnValue({
				selectedFiles: [
					{
						absolutePath: "/repo/a.ts",
						relativePath: "a.ts",
						statusCode: "M",
						indexStatus: " ",
						worktreeStatus: "M",
						isSelected: true,
					},
				],
				files: [
					{
						absolutePath: "/repo/a.ts",
						relativePath: "a.ts",
						statusCode: "M",
						indexStatus: " ",
						worktreeStatus: "M",
						isSelected: true,
					},
				],
				visibleFiles: [
					{
						absolutePath: "/repo/a.ts",
						relativePath: "a.ts",
						statusCode: "M",
						indexStatus: " ",
						worktreeStatus: "M",
						isSelected: true,
					},
				],
				excludedCount: 0,
				visibleCount: 0,
				isEmpty: false,
				isEnabled: true,
				isMigrating: false,
				changeReason: "refresh",
			});
			showWarningMessage.mockResolvedValue(undefined);
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand(
				"jollimemory.discardSelectedChanges",
			);

			await handler();

			expect(mockBridge.discardFiles).not.toHaveBeenCalled();
		});

		it("refreshes panel even on partial failure", async () => {
			mockFilesStore.getSnapshot.mockReturnValue({
				selectedFiles: [
					{
						absolutePath: "/repo/a.ts",
						relativePath: "a.ts",
						statusCode: "M",
						indexStatus: " ",
						worktreeStatus: "M",
						isSelected: true,
					},
				],
				files: [
					{
						absolutePath: "/repo/a.ts",
						relativePath: "a.ts",
						statusCode: "M",
						indexStatus: " ",
						worktreeStatus: "M",
						isSelected: true,
					},
				],
				visibleFiles: [
					{
						absolutePath: "/repo/a.ts",
						relativePath: "a.ts",
						statusCode: "M",
						indexStatus: " ",
						worktreeStatus: "M",
						isSelected: true,
					},
				],
				excludedCount: 0,
				visibleCount: 0,
				isEmpty: false,
				isEnabled: true,
				isMigrating: false,
				changeReason: "refresh",
			});
			showWarningMessage.mockResolvedValue("Discard All");
			mockBridge.discardFiles.mockRejectedValueOnce(new Error("partial fail"));
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand(
				"jollimemory.discardSelectedChanges",
			);

			await handler();

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("partial fail"),
			);
			expect(mockFilesStore.refresh).toHaveBeenCalledWith(true);
		});

		it("shows overflow indicator when more than 10 files are selected", async () => {
			const selectedFiles = Array.from({ length: 12 }, (_, i) => ({
				absolutePath: `/repo/file${i}.ts`,
				relativePath: `file${i}.ts`,
				statusCode: "M" as const,
				indexStatus: " " as const,
				worktreeStatus: "M" as const,
				isSelected: true,
			}));
			mockFilesStore.getSnapshot.mockReturnValue({
				selectedFiles,
				files: selectedFiles,
				visibleFiles: selectedFiles,
				excludedCount: 0,
				visibleCount: selectedFiles.length,
				isEmpty: false,
				isEnabled: true,
				isMigrating: false,
				changeReason: "refresh",
			});
			showWarningMessage.mockResolvedValue("Discard All");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand(
				"jollimemory.discardSelectedChanges",
			);

			await handler();

			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("12 selected files"),
				expect.objectContaining({
					modal: true,
					detail: expect.stringContaining("...and 2 more"),
				}),
				"Discard All",
			);
		});

		it("uses singular form for single selected file and single deleted file", async () => {
			const selectedFiles = [
				{
					absolutePath: "/repo/new.ts",
					relativePath: "new.ts",
					statusCode: "?" as const,
					indexStatus: "?" as const,
					worktreeStatus: "?" as const,
					isSelected: true,
				},
			];
			mockFilesStore.getSnapshot.mockReturnValue({
				selectedFiles,
				files: selectedFiles,
				visibleFiles: selectedFiles,
				excludedCount: 0,
				visibleCount: selectedFiles.length,
				isEmpty: false,
				isEnabled: true,
				isMigrating: false,
				changeReason: "refresh",
			});
			showWarningMessage.mockResolvedValue("Discard All");
			const ctx = makeContext();
			activate(ctx);
			const handler = getRegisteredCommand(
				"jollimemory.discardSelectedChanges",
			);

			await handler();

			expect(showWarningMessage).toHaveBeenCalledWith(
				// singular "file" (not "files")
				expect.stringContaining("1 selected file?"),
				expect.objectContaining({
					modal: true,
					// singular "file" in delete warning
					detail: expect.stringContaining("1 file will be permanently deleted"),
				}),
				"Discard All",
			);
		});
	});

	// ── hook path refresh error ──────────────────────────────────────

	describe("hook path refresh error", () => {
		it("auto-installs hooks when shared git hooks exist but current worktree hooks are missing", async () => {
			mockBridge.getStatus.mockResolvedValue({
				enabled: true,
				gitHookInstalled: true,
				worktreeHooksInstalled: false,
				enabledWorktrees: 2,
			});

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(mockBridge.autoInstallForWorktree).toHaveBeenCalled();
			});
		});

		it("skips auto-install when worktree hooks are already installed", async () => {
			mockBridge.getStatus.mockResolvedValue({
				enabled: true,
				gitHookInstalled: true,
				worktreeHooksInstalled: true,
				enabledWorktrees: 2,
			});
			mockBridge.autoInstallForWorktree.mockClear();

			const ctx = makeContext();
			activate(ctx);

			// Wait for the async refresh chain to complete
			await vi.waitFor(() => {
				expect(mockStatusStore.refresh).toHaveBeenCalled();
			});
			expect(mockBridge.autoInstallForWorktree).not.toHaveBeenCalled();
		});

		it("skips auto-install when enabledWorktrees is 0", async () => {
			mockBridge.getStatus.mockResolvedValue({
				enabled: true,
				gitHookInstalled: true,
				worktreeHooksInstalled: false,
				enabledWorktrees: 0,
			});
			mockBridge.autoInstallForWorktree.mockClear();

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(mockStatusStore.refresh).toHaveBeenCalled();
			});
			expect(mockBridge.autoInstallForWorktree).not.toHaveBeenCalled();
		});

		it("skips auto-install when enabledWorktrees is undefined", async () => {
			mockBridge.getStatus.mockResolvedValue({
				enabled: true,
				gitHookInstalled: true,
				worktreeHooksInstalled: false,
				enabledWorktrees: undefined,
			});
			mockBridge.autoInstallForWorktree.mockClear();

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(mockStatusStore.refresh).toHaveBeenCalled();
			});
			expect(mockBridge.autoInstallForWorktree).not.toHaveBeenCalled();
		});

		// Auto-enable on activate: a fresh workspace with no opt-out should
		// install hooks transparently. The opt-out is a marker file
		// (`<projectDir>/.jolli/jollimemory/disabled-by-user`) that survives
		// across IDE restarts AND project moves, since it's project-scoped
		// rather than bound to VS Code's per-machine workspaceState.
		describe("auto-enable on activate", () => {
			it("calls bridge.enable when status.enabled=false and no opt-out recorded", async () => {
				mockBridge.getStatus.mockResolvedValue({
					enabled: false,
					gitHookInstalled: false,
					worktreeHooksInstalled: false,
				});
				mockBridge.enable.mockClear();
				readManualDisableFlag.mockResolvedValue(false);

				const ctx = makeContext();
				activate(ctx);

				await vi.waitFor(() => {
					expect(mockBridge.enable).toHaveBeenCalled();
				});
			});

			it("does NOT call bridge.enable when the manually-disabled marker is present", async () => {
				mockBridge.getStatus.mockResolvedValue({
					enabled: false,
					gitHookInstalled: false,
					worktreeHooksInstalled: false,
				});
				mockBridge.enable.mockClear();
				readManualDisableFlag.mockResolvedValue(true);

				const ctx = makeContext();
				activate(ctx);

				await vi.waitFor(() => {
					expect(mockStatusStore.refresh).toHaveBeenCalled();
				});
				expect(mockBridge.enable).not.toHaveBeenCalled();
			});

			it("does NOT call bridge.enable when status.enabled is already true", async () => {
				mockBridge.getStatus.mockResolvedValue({
					enabled: true,
					gitHookInstalled: true,
					worktreeHooksInstalled: true,
				});
				mockBridge.enable.mockClear();

				const ctx = makeContext();
				activate(ctx);

				await vi.waitFor(() => {
					expect(mockStatusStore.refresh).toHaveBeenCalled();
				});
				expect(mockBridge.enable).not.toHaveBeenCalled();
			});
		});

		it("logs error when refreshHookPathsIfStale rejects", async () => {
			mockBridge.refreshHookPathsIfStale.mockRejectedValue(
				new Error("hook path error"),
			);

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(error).toHaveBeenCalledWith(
					"activate",
					"Failed to refresh hook paths",
					expect.any(Error),
				);
			});
		});

		it("sets extension outdated and shows warning when refreshHookPathsIfStale returns mismatch", async () => {
			mockBridge.refreshHookPathsIfStale.mockResolvedValue(
				"newer-version-path",
			);

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(mockStatusStore.setExtensionOutdated).toHaveBeenCalledWith(true);
				expect(showWarningMessage).toHaveBeenCalledWith(
					"Jolli Memory: A newer version is available. Please update the extension.",
				);
			});
		});
	});

	// ── initialLoad error ────────────────────────────────────────────

	describe("initialLoad error", () => {
		it("logs error when excludeFilter.load rejects", async () => {
			mockExcludeFilter.load.mockRejectedValue(new Error("load failed"));

			const ctx = makeContext();
			activate(ctx);

			await vi.waitFor(() => {
				expect(error).toHaveBeenCalledWith(
					"initialLoad",
					"Failed to load panels",
					expect.any(Error),
				);
			});
		});
	});

	// ── Auth commands ────────────────────────────────────────────────────

	describe("signIn command", () => {
		it("calls authService.openSignInPage", () => {
			activate(makeContext());

			const handler = getRegisteredCommand("jollimemory.signIn");
			handler();

			expect(mockAuthService.openSignInPage).toHaveBeenCalled();
		});
	});

	describe("signOut command", () => {
		it("prompts for confirmation and signs out when user confirms", async () => {
			showWarningMessage.mockResolvedValueOnce("Sign Out");
			activate(makeContext());

			const handler = getRegisteredCommand("jollimemory.signOut");
			await handler();

			expect(showWarningMessage).toHaveBeenCalledWith(
				"Sign out of Jolli?",
				expect.objectContaining({ modal: true }),
				"Sign Out",
			);
			expect(mockAuthService.signOut).toHaveBeenCalled();
			expect(mockStatusStore.refresh).toHaveBeenCalled();
		});

		it("does nothing when user cancels the confirmation", async () => {
			showWarningMessage.mockResolvedValueOnce(undefined);
			activate(makeContext());

			const handler = getRegisteredCommand("jollimemory.signOut");
			await handler();

			expect(showWarningMessage).toHaveBeenCalled();
			expect(mockAuthService.signOut).not.toHaveBeenCalled();
		});
	});

	describe("saveAnthropicApiKey command", () => {
		// Sidebar onboarding inline-input save path. The success branch is
		// implicit: saveConfigScoped + statusStore.refresh make `configured`
		// flip true, which triggers the existing configured:changed channel.
		// We don't post an explicit success ack — only failures post
		// apikey:saveError so the panel can re-enable Save and show inline.

		it("registers the saveAnthropicApiKey command", () => {
			activate(makeContext());
			const handler = getRegisteredCommand("jollimemory.saveAnthropicApiKey");
			expect(handler).toBeDefined();
		});

		it("saves apiKey + aiProvider:'anthropic' and refreshes statusStore on success", async () => {
			activate(makeContext());
			saveConfigScoped.mockResolvedValueOnce(undefined);
			mockStatusStore.refresh.mockClear();

			const handler = getRegisteredCommand("jollimemory.saveAnthropicApiKey");
			await handler("sk-ant-test-key");

			// The update is scoped to apiKey + aiProvider — no hooks /
			// integrations / etc. get rewritten. This is the contract that lets
			// us bypass the full Settings webview without losing user-set
			// fields elsewhere. `aiProvider: "anthropic"` is part of the
			// onboarding contract: clicking the "Configure Anthropic API key"
			// button declares provider intent, symmetric with the Jolli
			// sign-in path that writes `aiProvider: "jolli"`.
			expect(saveConfigScoped).toHaveBeenCalledWith(
				{ apiKey: "sk-ant-test-key", aiProvider: "anthropic" },
				"/home/user/.jolli/jollimemory",
			);
			// statusStore.refresh re-derives `configured` from
			// signedIn || hasApiKey, so it must run after save to flip the
			// onboarding panel away. Without this the panel stays open.
			expect(mockStatusStore.refresh).toHaveBeenCalled();
			// Success path is implicit — no explicit error post.
			expect(mockNotifyApiKeySaveError).not.toHaveBeenCalled();
		});

		it("trims surrounding whitespace before saving (paste-with-newline tolerance)", async () => {
			activate(makeContext());
			saveConfigScoped.mockResolvedValueOnce(undefined);

			const handler = getRegisteredCommand("jollimemory.saveAnthropicApiKey");
			await handler("  sk-ant-pasted  \n");

			expect(saveConfigScoped).toHaveBeenCalledWith(
				{ apiKey: "sk-ant-pasted", aiProvider: "anthropic" },
				expect.any(String),
			);
		});

		it("rejects empty input without touching disk and surfaces inline error", async () => {
			activate(makeContext());
			const handler = getRegisteredCommand("jollimemory.saveAnthropicApiKey");
			await handler("   ");

			// No write attempt — we don't want an empty-string apiKey on disk
			// even transiently, since downstream code may treat empty-string
			// differently from undefined.
			expect(saveConfigScoped).not.toHaveBeenCalled();
			expect(mockNotifyApiKeySaveError).toHaveBeenCalledWith(
				"API key cannot be empty.",
			);
		});

		it("rejects non-string input (defensive against malformed webview message) without saving", async () => {
			activate(makeContext());
			const handler = getRegisteredCommand("jollimemory.saveAnthropicApiKey");
			await handler(42 as unknown);

			expect(saveConfigScoped).not.toHaveBeenCalled();
			expect(mockNotifyApiKeySaveError).toHaveBeenCalled();
		});

		it("posts apikey:saveError with the error message when saveConfigScoped throws", async () => {
			activate(makeContext());
			saveConfigScoped.mockRejectedValueOnce(new Error("EROFS: read-only fs"));

			const handler = getRegisteredCommand("jollimemory.saveAnthropicApiKey");
			await handler("sk-ant-real-key");

			// We don't assert on mockStatusStore.refresh here because the
			// activation path (initialLoad / hook-path refresh) calls it
			// asynchronously and races with this test. The contract that
			// matters — and that the user actually observes — is that the
			// failure surfaces through notifyApiKeySaveError so the panel
			// can re-enable Save and show the inline error.
			expect(mockNotifyApiKeySaveError).toHaveBeenCalledWith(
				"EROFS: read-only fs",
			);
		});
	});

	describe("URI handler", () => {
		it("registers a URI handler on activation", () => {
			const ctx = makeContext();
			activate(ctx);

			const registerUriHandler = (
				vscode.window as unknown as {
					registerUriHandler: ReturnType<typeof vi.fn>;
				}
			).registerUriHandler;
			expect(registerUriHandler).toHaveBeenCalledTimes(1);
		});

		it("calls authService.handleAuthCallback on URI and shows success", async () => {
			const ctx = makeContext();
			activate(ctx);

			const registerUriHandler = (
				vscode.window as unknown as {
					registerUriHandler: ReturnType<typeof vi.fn>;
				}
			).registerUriHandler;
			const handler = registerUriHandler.mock.calls[0]?.[0] as {
				handleUri: (uri: unknown) => Promise<void>;
			};
			expect(handler).toBeDefined();

			const mockUri = {
				path: "/auth-callback",
				query: "code=abc123",
				toString: () =>
					"vscode://jolli.jollimemory-vscode/auth-callback?code=abc123",
			};
			await handler.handleUri(mockUri);

			expect(mockAuthService.handleAuthCallback).toHaveBeenCalledWith(mockUri);
			expect(showInformationMessage).toHaveBeenCalledWith(
				"Signed in to Jolli successfully.",
			);
			expect(mockStatusStore.refresh).toHaveBeenCalled();
		});

		it("shows error message on failed auth callback", async () => {
			mockAuthService.handleAuthCallback.mockResolvedValueOnce({
				success: false,
				error: "No authorization code received",
			});

			const ctx = makeContext();
			activate(ctx);

			const registerUriHandler = (
				vscode.window as unknown as {
					registerUriHandler: ReturnType<typeof vi.fn>;
				}
			).registerUriHandler;
			const handler = registerUriHandler.mock.calls[0]?.[0] as {
				handleUri: (uri: unknown) => Promise<void>;
			};

			const mockUri = {
				path: "/auth-callback",
				query: "",
				toString: () => "vscode://jolli.jollimemory-vscode/auth-callback",
			};
			await handler.handleUri(mockUri);

			expect(showErrorMessage).toHaveBeenCalledWith(
				"Jolli sign-in failed: No authorization code received",
			);
		});

		describe("/summary/<hash> route", () => {
			// Helper: install the handler and return it for a focused assertion.
			function getHandler() {
				const ctx = makeContext();
				activate(ctx);
				const registerUriHandler = (
					vscode.window as unknown as {
						registerUriHandler: ReturnType<typeof vi.fn>;
					}
				).registerUriHandler;
				return registerUriHandler.mock.calls[0]?.[0] as {
					handleUri: (uri: unknown) => Promise<void>;
				};
			}

			// Cross-repo: external deep links may target a memory whose summary
			// lives in a non-current repo under the Memory Bank parent, so the
			// URI handler walks the same aggregated view the Memories tab uses
			// (getSummaryAnyRepoWithSource) — pinned here for the same reason
			// as the copyRecallPrompt / openInClaudeCode handlers above, with
			// the provenance variant so the panel can disable destructive
			// actions for foreign-origin summaries.
			it("opens SummaryWebviewPanel in commit slot when the summary exists", async () => {
				const summary = { hash: "abc1234", content: "summary text" };
				mockBridge.getSummaryAnyRepoWithSource.mockResolvedValueOnce({
					summary,
					sourceRepoName: null,
					sourceRemoteUrl: null,
				});

				const handler = getHandler();
				await handler.handleUri({
					path: "/summary/0123456789abcdef0123456789abcdef01234567",
					query: "",
					toString: () =>
						"vscode://jolli.jollimemory-vscode/summary/0123456789abcdef0123456789abcdef01234567",
				});

				expect(mockBridge.getSummaryAnyRepoWithSource).toHaveBeenCalledWith(
					"0123456789abcdef0123456789abcdef01234567",
				);
				expect(MockSummaryWebviewPanel.show).toHaveBeenCalledWith(
					summary,
					expect.anything(),
					"/test/workspace",
					expect.anything(), // bridge
					"main", // mainBranch from mocked CommitsStore.getMainBranch()
					"commit",
					null,
					null,
				);
				// Summary route must NOT trigger the OAuth path.
				expect(mockAuthService.handleAuthCallback).not.toHaveBeenCalled();
			});

			it("shows info message when no summary is found", async () => {
				mockBridge.getSummaryAnyRepoWithSource.mockResolvedValueOnce({
					summary: null,
					sourceRepoName: null,
					sourceRemoteUrl: null,
				});

				const handler = getHandler();
				await handler.handleUri({
					path: "/summary/0123456789abcdef0123456789abcdef01234567",
					query: "",
					toString: () =>
						"vscode://jolli.jollimemory-vscode/summary/0123456789abcdef0123456789abcdef01234567",
				});

				expect(showInformationMessage).toHaveBeenCalledWith(
					"Jolli Memory: No summary found for commit 0123456.",
				);
				expect(MockSummaryWebviewPanel.show).not.toHaveBeenCalled();
			});

			it("passes sourceRepoName through to the panel for foreign-origin deep links", async () => {
				// External deep links (Slack message, browser bookmark) may land
				// on a SHA whose summary lives in a non-current repo under the
				// Memory Bank parent. Same provenance contract as
				// viewMemorySummary / openMemoryFile: without `sourceRepoName`
				// the panel would let the user click Push to Jolli, which
				// pushes the foreign repo's memory to the *current* repo's
				// Jolli Memory space, corrupting the wrong project.
				const summary = { hash: "abc1234", content: "foreign summary" };
				mockBridge.getSummaryAnyRepoWithSource.mockResolvedValueOnce({
					summary,
					sourceRepoName: "other-repo",
					sourceRemoteUrl: "https://github.com/other/repo.git",
				});

				const handler = getHandler();
				await handler.handleUri({
					path: "/summary/0123456789abcdef0123456789abcdef01234567",
					query: "",
					toString: () =>
						"vscode://jolli.jollimemory-vscode/summary/0123456789abcdef0123456789abcdef01234567",
				});

				expect(MockSummaryWebviewPanel.show).toHaveBeenCalledWith(
					summary,
					expect.anything(),
					"/test/workspace",
					expect.anything(), // bridge
					"main",
					"commit",
					"other-repo",
					"https://github.com/other/repo.git",
				);
			});

			it("rejects abbreviated hashes (must be a full 40-char SHA)", async () => {
				// `bridge.getSummaryAnyRepoWithSource` (and the current-repo
				// `getSummary` it falls back to) walks alias / tree-hash
				// resolution for non-direct hits, which silently resolves the
				// wrong commit when two distinct commits share the same tree
				// (cherry-pick, identical re-commit). Same hardening as
				// `search --hashes`.
				const handler = getHandler();
				await handler.handleUri({
					path: "/summary/abc1234",
					query: "",
					toString: () => "vscode://jolli.jollimemory-vscode/summary/abc1234",
				});

				expect(mockBridge.getSummaryAnyRepoWithSource).not.toHaveBeenCalled();
				expect(MockSummaryWebviewPanel.show).not.toHaveBeenCalled();
			});

			it("ignores malformed hash (rejects non-hex / wrong length)", async () => {
				const handler = getHandler();
				await handler.handleUri({
					path: "/summary/NOT-A-HASH",
					query: "",
					toString: () =>
						"vscode://jolli.jollimemory-vscode/summary/NOT-A-HASH",
				});

				expect(mockBridge.getSummary).not.toHaveBeenCalled();
				expect(MockSummaryWebviewPanel.show).not.toHaveBeenCalled();
				expect(mockAuthService.handleAuthCallback).not.toHaveBeenCalled();
			});

			it("ignores unknown URI paths", async () => {
				const handler = getHandler();
				await handler.handleUri({
					path: "/something-else",
					query: "",
					toString: () => "vscode://jolli.jollimemory-vscode/something-else",
				});

				expect(mockBridge.getSummary).not.toHaveBeenCalled();
				expect(MockSummaryWebviewPanel.show).not.toHaveBeenCalled();
				expect(mockAuthService.handleAuthCallback).not.toHaveBeenCalled();
			});
		});
	});

	// ── deactivate ──────────────────────────────────────────────────────

	describe("deactivate", () => {
		it("can be called without error", () => {
			expect(() => deactivate()).not.toThrow();
		});

		it("logs deactivation and disposes the logger", () => {
			deactivate();

			expect(info).toHaveBeenCalledWith(
				"deactivate",
				"Jolli Memory extension deactivating",
			);
			expect(logDispose).toHaveBeenCalled();
		});
	});

	// ── Coverage backfill: noFolder fallback dialog ───────────────────────
	describe("activate — no workspace root: noFolder commands prompt user", () => {
		// Reset existsSync impl between tests (other test groups override it).
		beforeEach(() => {
			existsSync.mockReset();
			existsSync.mockImplementation(() => true);
		});

		it("invoking a registered no-op command shows the 'open a folder' info message", () => {
			getWorkspaceRoot.mockReturnValue(undefined);
			const ctx = makeContext();
			activate(ctx);

			const handler = commandMap.get("jollimemory.commitAI");
			expect(handler).toBeDefined();
			handler?.();

			expect(showInformationMessage).toHaveBeenCalledWith(
				"Please open a folder to use Jolli Memory.",
			);
		});
	});

	// ── Coverage backfill: workspace lacks a `.git` directory ──────────────
	describe("activate — no .git in workspace: noGit + Initialize Git prompt", () => {
		afterEach(() => {
			// Restore default so subsequent describe blocks see existsSync returning true.
			existsSync.mockReset();
			existsSync.mockImplementation(() => true);
		});

		// `existsSync` is also called for many other files inside activate (plan
		// previews etc). Override only for the `.git` lookup so the rest of the
		// activate path behaves as the default mock implementations expect.
		function stubGitMissing(): void {
			existsSync.mockImplementation((p: unknown) => {
				const s = String(p);
				if (
					s.endsWith("/.git") ||
					s.endsWith("\\.git") ||
					s === "/test/workspace/.git"
				) {
					return false;
				}
				return true;
			});
		}

		it("registers a noGit no-op for every command and shows the prompt when invoked", async () => {
			stubGitMissing();
			showWarningMessage.mockResolvedValueOnce(undefined); // user dismisses
			const ctx = makeContext();
			activate(ctx);

			expect(commandMap.size).toBeGreaterThan(0);
			const handler = commandMap.get("jollimemory.commitAI");
			expect(handler).toBeDefined();
			await handler?.();
			await new Promise((r) => setTimeout(r, 0));
			expect(showWarningMessage).toHaveBeenCalledWith(
				expect.stringContaining("not a git repository"),
				"Initialize Git",
			);
		});

		it("when user picks 'Initialize Git' and init succeeds, prompts to reload", async () => {
			stubGitMissing();
			showWarningMessage.mockResolvedValueOnce("Initialize Git");
			showInformationMessage.mockResolvedValueOnce("Reload");
			execFileSync.mockImplementation(
				(bin: string, args: ReadonlyArray<string>) => {
					if (bin === "git" && args[0] === "init") return Buffer.from("");
					throw new Error(`Unmocked execFile: ${bin} ${args.join(" ")}`);
				},
			);
			const ctx = makeContext();
			activate(ctx);

			await commandMap.get("jollimemory.commitAI")?.();
			// promise chain inside noGit needs a few microtask flushes
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));

			expect(execFileSync).toHaveBeenCalledWith(
				"git",
				["init"],
				expect.objectContaining({ cwd: "/test/workspace" }),
			);
			expect(showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("Git initialized"),
				"Reload",
			);
			expect(executeCommand).toHaveBeenCalledWith(
				"workbench.action.reloadWindow",
			);
		});

		it("when user picks 'Initialize Git' but init fails, surfaces an error message", async () => {
			stubGitMissing();
			showWarningMessage.mockResolvedValueOnce("Initialize Git");
			execFileSync.mockImplementation(
				(bin: string, args: ReadonlyArray<string>) => {
					if (bin === "git" && args[0] === "init") {
						throw new Error("permission denied");
					}
					throw new Error(`Unmocked execFile: ${bin} ${args.join(" ")}`);
				},
			);
			const ctx = makeContext();
			activate(ctx);

			await commandMap.get("jollimemory.commitAI")?.();
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Failed to initialize git"),
			);
		});

		it("when user dismisses the reload prompt, does not call reloadWindow", async () => {
			stubGitMissing();
			showWarningMessage.mockResolvedValueOnce("Initialize Git");
			showInformationMessage.mockResolvedValueOnce(undefined);
			execFileSync.mockImplementation(
				(bin: string, args: ReadonlyArray<string>) => {
					if (bin === "git" && args[0] === "init") return Buffer.from("");
					throw new Error(`Unmocked execFile: ${bin} ${args.join(" ")}`);
				},
			);
			const ctx = makeContext();
			activate(ctx);

			await commandMap.get("jollimemory.commitAI")?.();
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));

			const cmds = executeCommand.mock.calls.map((c) => c[0]);
			expect(cmds).not.toContain("workbench.action.reloadWindow");
		});
	});

	// ── Coverage backfill: row-click preview commands ──────────────────────
	describe("openPlanForPreview / openNoteForPreview", () => {
		beforeEach(() => {
			existsSync.mockReset();
			existsSync.mockImplementation(() => true);
		});

		it("opens the local plan file via markdown.showPreview when it exists", async () => {
			const ctx = makeContext();
			activate(ctx);

			mockPlansStore.getSnapshot.mockReturnValueOnce({
				merged: [
					{
						kind: "plan",
						plan: {
							slug: "my-plan",
							title: "My Plan",
							filePath: "/home/user/.claude/plans/my-plan.md",
						},
					},
				],
				changeReason: "init",
			} as never);
			existsSync.mockImplementationOnce(() => true);

			const handler = getRegisteredCommand("jollimemory.openPlanForPreview");
			await handler("my-plan");

			expect(executeCommand).toHaveBeenCalledWith(
				"markdown.showPreview",
				expect.objectContaining({ fsPath: expect.stringContaining("my-plan") }),
			);
		});

		it("opens an external-path plan via its registry filePath", async () => {
			const ctx = makeContext();
			activate(ctx);

			mockPlansStore.getSnapshot.mockReturnValueOnce({
				merged: [
					{
						kind: "plan",
						plan: {
							slug: "foo-plan",
							title: "External Foo",
							filePath: "/repo/docs/foo-plan.md",
						},
					},
				],
				changeReason: "init",
			} as never);
			existsSync.mockImplementationOnce(() => true);

			const handler = getRegisteredCommand("jollimemory.openPlanForPreview");
			await handler("foo-plan");

			expect(executeCommand).toHaveBeenCalledWith(
				"markdown.showPreview",
				expect.objectContaining({
					fsPath: expect.stringContaining("foo-plan.md"),
				}),
			);
		});

		// Exercises the fallback to the orphan-branch snapshot when the local plan
		// file isn't on disk. Plans without a matching snapshot fall through to
		// `slug` as the preview title.
		it("falls back to the orphan-branch snapshot when the local plan file is gone", async () => {
			const ctx = makeContext();
			activate(ctx);

			mockPlansStore.getSnapshot.mockReturnValueOnce({
				merged: [],
				changeReason: "init",
			} as never);
			existsSync.mockImplementationOnce(() => false);
			readPlanFromBranch.mockResolvedValueOnce("# Plan body");

			const handler = getRegisteredCommand("jollimemory.openPlanForPreview");
			await handler("orphan-only");

			expect(readPlanFromBranch).toHaveBeenCalledWith(
				"orphan-only",
				"/test/workspace",
			);
		});

		it("shows an error when the orphan snapshot read also fails", async () => {
			const ctx = makeContext();
			activate(ctx);

			mockPlansStore.getSnapshot.mockReturnValueOnce({
				merged: [],
				changeReason: "init",
			} as never);
			existsSync.mockImplementationOnce(() => false);
			readPlanFromBranch.mockResolvedValueOnce(null);

			const handler = getRegisteredCommand("jollimemory.openPlanForPreview");
			await handler("missing-everywhere");

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Could not read plan"),
			);
		});

		it("opens the local note file via markdown.showPreview when it exists", async () => {
			const ctx = makeContext();
			activate(ctx);

			mockBridge.listNotes.mockResolvedValueOnce([
				{ id: "n-1", title: "N", filePath: "/abs/n.md", commitHash: null },
			] as never);
			existsSync.mockImplementationOnce(() => true);

			const handler = getRegisteredCommand("jollimemory.openNoteForPreview");
			await handler("n-1");

			expect(executeCommand).toHaveBeenCalledWith(
				"markdown.showPreview",
				expect.objectContaining({ fsPath: "/abs/n.md" }),
			);
		});

		it("falls back to the orphan-branch snapshot when only commitHash is available", async () => {
			const ctx = makeContext();
			activate(ctx);

			mockBridge.listNotes.mockResolvedValueOnce([
				{
					id: "n-1",
					title: "Committed Note",
					filePath: undefined,
					commitHash: "abc",
				},
			] as never);
			readNoteFromBranch.mockResolvedValueOnce("# Note body");

			const handler = getRegisteredCommand("jollimemory.openNoteForPreview");
			await handler("n-1");

			expect(readNoteFromBranch).toHaveBeenCalledWith("n-1", "/test/workspace");
		});

		it("shows an info message when neither local file nor commitHash is available", async () => {
			const ctx = makeContext();
			activate(ctx);

			mockBridge.listNotes.mockResolvedValueOnce([
				{ id: "n-1", title: "Empty", filePath: undefined, commitHash: null },
			] as never);

			const handler = getRegisteredCommand("jollimemory.openNoteForPreview");
			await handler("n-1");

			expect(showInformationMessage).toHaveBeenCalledWith(
				expect.stringContaining("has no readable content"),
			);
		});

		it("returns silently when the note id does not exist in listNotes", async () => {
			const ctx = makeContext();
			activate(ctx);

			mockBridge.listNotes.mockResolvedValueOnce([] as never);
			showInformationMessage.mockClear();
			showErrorMessage.mockClear();

			const handler = getRegisteredCommand("jollimemory.openNoteForPreview");
			await expect(handler("does-not-exist")).resolves.toBeUndefined();
			expect(showInformationMessage).not.toHaveBeenCalledWith(
				expect.stringContaining("has no readable content"),
			);
		});
	});

	// ── Coverage backfill: rebuildKnowledgeBase command ────────────────────
	describe("rebuildKnowledgeBase command (success/partial/error paths)", () => {
		beforeEach(() => {
			existsSync.mockReset();
			existsSync.mockImplementation(() => true);
			mockOrphanInstance.exists.mockReset();
			mockOrphanInstance.exists.mockResolvedValue(true);
			mockMigrationEngineInstance.runMigration.mockReset();
			mockMigrationEngineInstance.runMigration.mockResolvedValue({
				status: "completed",
				migratedEntries: 5,
				totalEntries: 5,
			});
			mockMetadataManagerInstance.readConfig.mockReset();
			mockMetadataManagerInstance.readConfig.mockReturnValue({});
			mockMetadataManagerInstance.saveConfig.mockClear();
		});

		it("returns ok when rebuild migration completes", async () => {
			activate(makeContext());
			const handler = getRegisteredCommand("jollimemory.rebuildKnowledgeBase");
			const result = (await handler()) as { ok: boolean; message: string };
			expect(result.ok).toBe(true);
			expect(result.message).toContain("memories migrated");
			// "Repoint": old KB identity is rewritten so resolveKBPath stops reusing it.
			expect(mockMetadataManagerInstance.saveConfig).toHaveBeenCalled();
		});

		it("returns not-ok with No git storage found when orphan branch is missing", async () => {
			mockOrphanInstance.exists.mockResolvedValueOnce(false);
			activate(makeContext());
			const handler = getRegisteredCommand("jollimemory.rebuildKnowledgeBase");
			const result = (await handler()) as { ok: boolean; message: string };
			expect(result.ok).toBe(false);
			expect(result.message).toContain("No git storage");
		});

		it("returns not-ok when rebuild migration is only partial", async () => {
			mockMigrationEngineInstance.runMigration.mockResolvedValueOnce({
				status: "partial",
				migratedEntries: 1,
				totalEntries: 3,
			});
			activate(makeContext());
			const handler = getRegisteredCommand("jollimemory.rebuildKnowledgeBase");
			const result = (await handler()) as { ok: boolean; message: string };
			expect(result.ok).toBe(false);
			expect(result.message).toContain("Rebuild partial");
		});

		it("warns but still completes when archiving the old KB identity throws", async () => {
			mockMetadataManagerInstance.readConfig.mockImplementationOnce(() => {
				throw new Error("read failed");
			});
			activate(makeContext());
			const handler = getRegisteredCommand("jollimemory.rebuildKnowledgeBase");
			const result = (await handler()) as { ok: boolean; message: string };
			expect(result.ok).toBe(true);
		});

		it("returns not-ok when the migration itself throws", async () => {
			mockMigrationEngineInstance.runMigration.mockRejectedValueOnce(
				new Error("fs error"),
			);
			activate(makeContext());
			const handler = getRegisteredCommand("jollimemory.rebuildKnowledgeBase");
			const result = (await handler()) as { ok: boolean; message: string };
			expect(result.ok).toBe(false);
			expect(result.message).toBe("fs error");
		});
	});

	// ── Coverage backfill: misc trivial command paths ──────────────────────
	describe("trivial command paths", () => {
		beforeEach(() => {
			existsSync.mockReset();
			existsSync.mockImplementation(() => true);
		});

		it("openSettings save callback surfaces errors via handleError when excludeFilter.load throws", async () => {
			activate(makeContext());
			const handler = getRegisteredCommand("jollimemory.openSettings");
			handler();

			// SettingsWebviewPanel.show was invoked with a save callback as 3rd arg.
			const showCalls = MockSettingsWebviewPanel.show.mock.calls as [
				unknown,
				unknown,
				() => Promise<void>,
			][];
			expect(showCalls.length).toBeGreaterThan(0);
			const saveCb = showCalls[showCalls.length - 1][2];

			mockExcludeFilter.load.mockRejectedValueOnce(new Error("disk full"));
			await saveCb();

			// handleError logs via the shared `log.error`; the test just verifies
			// the callback didn't throw and an error was logged.
			expect(error).toHaveBeenCalled();
		});
	});
});
