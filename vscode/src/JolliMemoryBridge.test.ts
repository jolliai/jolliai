import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { loadConfig, savePluginSource, saveSquashPending } = vi.hoisted(() => ({
	loadConfig: vi.fn().mockResolvedValue({}),
	savePluginSource: vi.fn(),
	saveSquashPending: vi.fn(),
}));

const { discoverRepos } = vi.hoisted(() => ({
	discoverRepos: vi.fn().mockReturnValue([]),
}));

const { extractRepoName, getRemoteUrl, resolveKbParent } = vi.hoisted(() => ({
	extractRepoName: vi.fn().mockReturnValue("test-repo"),
	getRemoteUrl: vi.fn().mockReturnValue(null),
	resolveKbParent: vi.fn().mockReturnValue("/mock/home/Documents/jolli"),
}));

const {
	MockFolderStorage,
	MockMetadataManager,
	mockIsUserEditedOnDisk,
	mockFindByPath,
	mockFolderReadFile,
	mockFolderIsDirty,
} = vi.hoisted(() => {
	const isUserEditedOnDisk = vi.fn();
	const findByPath = vi.fn();
	// Shared across every MockFolderStorage instance so a single test
	// override (`mockFolderReadFile.mockResolvedValueOnce(null)` /
	// `mockFolderIsDirty.mockReturnValueOnce(true)`) flips the C2
	// folder-empty fallback or the shadow-dirty fallback for all
	// instances created during that test.
	const mockFolderReadFile = vi.fn();
	const mockFolderIsDirty = vi.fn().mockReturnValue(false);
	return {
		MockFolderStorage: class {
			readonly readFile = mockFolderReadFile;
			readonly isDirty = mockFolderIsDirty;
			constructor(
				public readonly rootPath: string,
				public readonly mm: unknown,
			) {}
			isUserEditedOnDisk(
				absPath: string,
				manifestFingerprint: string | undefined,
			): boolean {
				return isUserEditedOnDisk(absPath, manifestFingerprint);
			}
		},
		MockMetadataManager: class {
			constructor(public readonly dir: string) {}
			findByPath(relPath: string): unknown {
				return findByPath(relPath);
			}
			// `resolveKBPath` now claims identity in-place by calling
			// `MetadataManager.ensure()` + `readConfig()` + `saveConfig()` (the work
			// that used to live in `initializeKBFolder`). The tests in this file
			// don't exercise that side-effect; provide no-op shims so the real
			// `resolveKBPath` doesn't throw when it hits this mocked class.
			ensure(): void {}
			readConfig(): Record<string, unknown> {
				return { version: 1, sortOrder: "date" };
			}
			saveConfig(): void {}
		},
		mockIsUserEditedOnDisk: isUserEditedOnDisk,
		mockFindByPath: findByPath,
		mockFolderReadFile,
		mockFolderIsDirty,
	};
});

const { loadGlobalConfig } = vi.hoisted(() => ({
	loadGlobalConfig: vi.fn(),
}));

const { generateCommitMessage, generateSquashMessage } = vi.hoisted(() => ({
	generateCommitMessage: vi.fn(),
	generateSquashMessage: vi.fn(),
}));

const {
	deleteNoteVisibleArtifact,
	deletePlanVisibleArtifact,
	getIndexEntryMap,
	getSummary,
	getTranscriptHashes,
	indexNeedsMigration,
	listSummaries,
	migrateIndexToV3,
	readTranscript,
	readTranscriptsForCommits,
	saveTranscriptsBatch,
	scanTreeHashAliases,
	storeReferences,
	storeNotes,
	storePlans,
	storeSummary,
} = vi.hoisted(() => ({
	deleteNoteVisibleArtifact: vi.fn(),
	deletePlanVisibleArtifact: vi.fn(),
	getIndexEntryMap: vi.fn(),
	getSummary: vi.fn(),
	getTranscriptHashes: vi.fn(),
	indexNeedsMigration: vi.fn(),
	listSummaries: vi.fn(),
	migrateIndexToV3: vi.fn(),
	readTranscript: vi.fn(),
	readTranscriptsForCommits: vi.fn(),
	saveTranscriptsBatch: vi.fn(),
	scanTreeHashAliases: vi.fn(),
	storeReferences: vi.fn(),
	storeNotes: vi.fn(),
	storePlans: vi.fn(),
	storeSummary: vi.fn(),
}));

const { loadRegenerateContext, regenerateSummary } = vi.hoisted(() => ({
	loadRegenerateContext: vi.fn(),
	regenerateSummary: vi.fn(),
}));

const { getDiffStats } = vi.hoisted(() => ({
	getDiffStats: vi.fn(),
}));

const {
	readDistPathInfo: mockReadDistPathInfo,
	resolveDistPath: mockResolveDistPath,
	traverseDistPaths: mockTraverseDistPaths,
	deriveSourceTag: mockDeriveSourceTag,
} = vi.hoisted(() => ({
	readDistPathInfo: vi.fn(),
	resolveDistPath: vi.fn(),
	traverseDistPaths: vi.fn().mockReturnValue([]),
	deriveSourceTag: vi.fn().mockReturnValue("vscode"),
}));

const { installerInstall, installerUninstall, installerGetStatus } = vi.hoisted(
	() => ({
		installerInstall: vi.fn(),
		installerUninstall: vi.fn(),
		installerGetStatus: vi.fn(),
	}),
);

const { archivePlanForCommit, detectPlans, removePlan } = vi.hoisted(() => ({
	archivePlanForCommit: vi.fn(),
	detectPlans: vi.fn(),
	removePlan: vi.fn(),
}));

const {
	archiveNoteForCommit,
	detectNotes,
	saveNote: saveNoteFn,
	removeNote: removeNoteFn,
} = vi.hoisted(() => ({
	archiveNoteForCommit: vi.fn(),
	detectNotes: vi.fn(),
	saveNote: vi.fn(),
	removeNote: vi.fn(),
}));

const { mergeCommitMessages } = vi.hoisted(() => ({
	mergeCommitMessages: vi.fn(),
}));

const { info, warn, error, debug } = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

const { existsSync, lstatSync, readFileSync } = vi.hoisted(() => ({
	existsSync: vi.fn(),
	lstatSync: vi.fn(),
	readFileSync: vi.fn(),
}));

const { resolveGitHooksDir } = vi.hoisted(() => ({
	resolveGitHooksDir: vi.fn().mockResolvedValue("/mock/hooks"),
}));

const { mockHomedir } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue("/mock/home"),
}));

const { lstat, mkdir, rm, unlink, writeFile } = vi.hoisted(() => ({
	lstat: vi.fn(),
	mkdir: vi.fn(),
	rm: vi.fn(),
	unlink: vi.fn(),
	writeFile: vi.fn(),
}));

const { readManualDisableFlag } = vi.hoisted(() => ({
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
}));

/**
 * Mock for node:child_process execFile.
 * promisify wraps this into a function returning Promise<{stdout, stderr}>.
 * The mock signature must match the callback-based execFile:
 *   execFile(cmd, args, options, callback)
 *
 * Responses are queued FIFO via `mockImplementationOnce` (see
 * `mockExecFileSuccess`/`mockExecFileError`): each call consumes the next
 * stubbed response in order, so a test's mocks must be arranged in the exact
 * order the code under test invokes git.
 */
const execFileMock = vi.hoisted(() => {
	const fn = vi.fn();
	return fn;
});

// ── vi.mock calls ────────────────────────────────────────────────────────────

vi.mock("../../cli/src/core/SessionTracker.js", () => ({
	loadConfig,
	savePluginSource,
	saveSquashPending,
}));

vi.mock("../../cli/src/core/KBRepoDiscoverer.js", () => ({
	discoverRepos,
}));

vi.mock("../../cli/src/core/KBPathResolver.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../cli/src/core/KBPathResolver.js")
		>();
	return {
		...actual,
		extractRepoName,
		getRemoteUrl,
		resolveKbParent,
		// Stub: identity-claiming side-effects of `resolveKBPath` /
		// `initializeKBFolder` reach into MetadataManager, which is mocked
		// to a class with no-op methods (see `MockMetadataManager`). The
		// stub here keeps `initializeKBFolder` a no-op for any callers that
		// still invoke it directly (Migrate / Repoint paths); `resolveKBPath`
		// itself uses the original implementation so the path-computation
		// logic exercised by these tests is real.
		initializeKBFolder: () => {},
	};
});

vi.mock("../../cli/src/core/FolderStorage.js", () => ({
	FolderStorage: MockFolderStorage,
}));

vi.mock("../../cli/src/core/MetadataManager.js", () => ({
	MetadataManager: MockMetadataManager,
}));

vi.mock("./util/WorkspaceUtils.js", () => ({
	loadGlobalConfig,
}));

vi.mock("../../cli/src/core/Summarizer.js", () => ({
	generateCommitMessage,
	generateSquashMessage,
}));

vi.mock("../../cli/src/core/SummaryStore.js", () => ({
	deleteNoteVisibleArtifact,
	deletePlanVisibleArtifact,
	getIndexEntryMap,
	getSummary,
	getTranscriptHashes,
	indexNeedsMigration,
	listSummaries,
	migrateIndexToV3,
	readTranscript,
	readTranscriptsForCommits,
	saveTranscriptsBatch,
	scanTreeHashAliases,
	storeReferences,
	storeNotes,
	storePlans,
	storeSummary,
}));

vi.mock("../../cli/src/core/RegenerateContext.js", () => ({
	loadRegenerateContext,
}));

vi.mock("../../cli/src/core/Regenerator.js", () => ({
	regenerateSummary,
}));

vi.mock("../../cli/src/core/GitOps.js", () => ({
	getDiffStats,
	resolveGitHooksDir,
}));

vi.mock("../../cli/src/install/DistPathResolver.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../cli/src/install/DistPathResolver.js")
		>();
	return {
		compareSemver: actual.compareSemver,
		readDistPathInfo: mockReadDistPathInfo,
		resolveDistPath: mockResolveDistPath,
		traverseDistPaths: mockTraverseDistPaths,
		deriveSourceTag: mockDeriveSourceTag,
	};
});

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir };
});

vi.mock("../../cli/src/install/Installer.js", () => ({
	install: installerInstall,
	uninstall: installerUninstall,
	getStatus: installerGetStatus,
}));

vi.mock("../../cli/src/Logger.js", () => ({
	ORPHAN_BRANCH: "jollimemory",
	createLogger: vi.fn(() => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	})),
	setLogDir: vi.fn(),
}));

vi.mock("./core/PlanService.js", () => ({
	archivePlanForCommit,
	detectPlans,
	removePlan,
}));

vi.mock("./core/NoteService.js", () => ({
	archiveNoteForCommit,
	detectNotes,
	saveNote: saveNoteFn,
	removeNote: removeNoteFn,
}));

// ReferenceService imports `vscode` at module top level; mock at the module
// boundary so the test runner doesn't crash with "Cannot find package vscode".
vi.mock("./core/ReferenceService.js", () => ({
	detectReferences: vi.fn().mockResolvedValue([]),
	removeReference: vi.fn().mockResolvedValue(undefined),
	openReferenceInBrowser: vi.fn().mockResolvedValue(true),
	openReferenceMarkdown: vi.fn().mockResolvedValue(undefined),
	previewReferenceMarkdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./util/CommitMessageUtils.js", () => ({
	mergeCommitMessages,
}));

vi.mock("./util/Logger.js", () => ({
	log: { info, warn, error, debug },
}));

vi.mock("./services/ManualDisableFlag.js", () => ({
	readManualDisableFlag,
}));

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
}));

vi.mock("node:fs", () => ({
	existsSync,
	lstatSync,
	readFileSync,
}));

vi.mock("node:fs/promises", () => ({
	lstat,
	mkdir,
	rm,
	unlink,
	writeFile,
}));

// ── Import under test (after mocks) ─────────────────────────────────────────

import { JolliMemoryBridge } from "./JolliMemoryBridge.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_CWD = "/test/repo";

function makeBridge(): JolliMemoryBridge {
	return new JolliMemoryBridge(TEST_CWD);
}

/**
 * Configures execFileMock to succeed with given stdout for the next call.
 * The mock uses the callback-style signature that promisify expects.
 */
function mockExecFileSuccess(stdout: string, stderr = ""): void {
	execFileMock.mockImplementationOnce(
		(
			_cmd: string,
			_args: Array<string>,
			_opts: unknown,
			callback: (err: null, result: { stdout: string; stderr: string }) => void,
		) => {
			callback(null, { stdout, stderr });
		},
	);
}

function mockExecFileSuccessRaw(stdout: unknown, stderr = ""): void {
	execFileMock.mockImplementationOnce(
		(
			_cmd: string,
			_args: Array<string>,
			_opts: unknown,
			callback: (
				err: null,
				result: { stdout: unknown; stderr: string },
			) => void,
		) => {
			callback(null, { stdout, stderr });
		},
	);
}

/**
 * Configures execFileMock to fail with an error for the next call.
 */
function mockExecFileError(message: string, stderr?: string): void {
	execFileMock.mockImplementationOnce(
		(
			_cmd: string,
			_args: Array<string>,
			_opts: unknown,
			callback: (err: Error & { stderr?: string }) => void,
		) => {
			const err = new Error(message) as Error & { stderr?: string };
			if (stderr !== undefined) {
				err.stderr = stderr;
			}
			callback(err);
		},
	);
}

describe("JolliMemoryBridge", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockHomedir.mockReturnValue("/mock/home");
		resolveGitHooksDir.mockResolvedValue("/mock/hooks");
		loadGlobalConfig.mockResolvedValue({
			apiKey: "test-key",
			model: "claude-3",
		});
		// SessionTracker.loadConfig is read by StorageFactory.createStorage AND
		// by listSummaryEntries (for the localFolder lookup). Default to an
		// empty config so storageMode falls back to "dual-write" and there's no
		// custom Memory Bank path.
		loadConfig.mockResolvedValue({});
		// Multi-repo helpers used by listSummaryEntries. Default to "no other
		// repos discoverable" so existing single-repo tests keep their narrow
		// expectations; cross-repo cases override per-test.
		discoverRepos.mockReturnValue([]);
		extractRepoName.mockReturnValue("test-repo");
		getRemoteUrl.mockReturnValue(null);
		resolveKbParent.mockReturnValue("/mock/home/Documents/jolli");
		savePluginSource.mockResolvedValue(undefined);
		saveSquashPending.mockResolvedValue(undefined);
		installerInstall.mockResolvedValue({
			success: true,
			message: "Hooks installed successfully",
		});
		installerUninstall.mockResolvedValue({
			success: true,
			message: "Hooks removed",
		});
		installerGetStatus.mockResolvedValue({
			enabled: true,
			claudeHookInstalled: true,
			gitHookInstalled: true,
			geminiHookInstalled: false,
			activeSessions: 2,
			mostRecentSession: "abc123",
			summaryCount: 5,
			orphanBranch: "jollimemory",
			codexDetected: false,
			geminiDetected: false,
		});
		mkdir.mockResolvedValue(undefined);
		writeFile.mockResolvedValue(undefined);
		// vi.resetAllMocks() above wipes the hoisted default; re-establish it so
		// refreshHookPathsIfStale's manual-disable gate reads a real `false` (not a
		// bare undefined that only works because it's falsy).
		readManualDisableFlag.mockResolvedValue(false);
		scanTreeHashAliases.mockResolvedValue(false);
		// Default: folder has an index — every test that doesn't care
		// about the C2 fallback gets a non-null result and createReadStorage
		// returns FolderStorage. Tests pinning the fallback override with
		// `mockFolderReadFile.mockResolvedValueOnce(null)`.
		mockFolderReadFile.mockResolvedValue("{}");
		// Default: folder shadow is clean. Tests pinning the shadow-dirty
		// fallback override with `mockFolderIsDirty.mockReturnValueOnce(true)`.
		mockFolderIsDirty.mockReturnValue(false);
	});

	// ── Constructor ──────────────────────────────────────────────────────

	describe("constructor", () => {
		it("stores cwd and exposes it as a public property", () => {
			const bridge = makeBridge();
			expect(bridge.cwd).toBe(TEST_CWD);
		});
	});

	// ── enable / disable ─────────────────────────────────────────────────

	describe("enable()", () => {
		it("calls Installer.install and returns success", async () => {
			const bridge = makeBridge();

			const result = await bridge.enable();

			expect(result).toEqual({
				success: true,
				message: "Hooks installed successfully",
			});
			expect(installerInstall).toHaveBeenCalledWith(TEST_CWD, {
				source: "vscode-extension",
			});
		});

		it("returns failure when Installer.install fails", async () => {
			installerInstall.mockResolvedValue({
				success: false,
				message: "hook write error",
			});
			const bridge = makeBridge();

			const result = await bridge.enable();

			expect(result).toEqual({ success: false, message: "hook write error" });
		});

		it("falls back to a default message when Installer.install returns none", async () => {
			installerInstall.mockResolvedValue({
				success: false,
				message: undefined,
			});
			const bridge = makeBridge();
			const result = await bridge.enable();

			expect(result).toEqual({ success: false, message: "enabled" });
		});
	});

	describe("autoInstallForWorktree()", () => {
		it("calls install for the current working directory", async () => {
			const bridge = makeBridge();

			await bridge.autoInstallForWorktree();

			expect(installerInstall).toHaveBeenCalledWith(TEST_CWD, {
				source: "vscode-extension",
			});
		});
	});

	describe("disable()", () => {
		it("calls Installer.uninstall and returns success", async () => {
			const bridge = makeBridge();

			const result = await bridge.disable();

			expect(result).toEqual({ success: true, message: "Hooks removed" });
			expect(installerUninstall).toHaveBeenCalledWith(TEST_CWD);
		});

		it("falls back to 'disabled' message when uninstall returns no message", async () => {
			installerUninstall.mockResolvedValue({
				success: true,
				message: undefined,
			});
			const bridge = makeBridge();

			const result = await bridge.disable();

			expect(result).toEqual({ success: true, message: "disabled" });
		});
	});

	// ── refreshHookPathsIfStale ──────────────────────────────────────────

	describe("refreshHookPathsIfStale()", () => {
		it("skips re-enable entirely when the repo is manually disabled (upgrade must not clobber the opt-out)", async () => {
			readManualDisableFlag.mockResolvedValue(true);
			// A stale/missing own dist-path would normally force a re-enable; the
			// manual-disable gate must short-circuit before that.
			existsSync.mockImplementation(
				(p: string) => !String(p).includes("settings.local.json"),
			);
			mockDeriveSourceTag.mockReturnValue("vscode");
			mockTraverseDistPaths.mockReturnValue([]);
			const bridge = makeBridge();

			const result = await bridge.refreshHookPathsIfStale("/ext/v2.0.0");

			expect(installerInstall).not.toHaveBeenCalled();
			expect(result).toBeUndefined();
		});

		it("re-enables when own dist-paths/<self> entry is missing", async () => {
			existsSync.mockImplementation(
				(p: string) => !String(p).includes("settings.local.json"),
			);
			mockDeriveSourceTag.mockReturnValue("vscode");
			// No entries → re-enable to register fresh
			mockTraverseDistPaths.mockReturnValue([]);
			const bridge = makeBridge();

			await bridge.refreshHookPathsIfStale("/ext/v2.0.0");

			expect(installerInstall).toHaveBeenCalledWith(TEST_CWD, {
				source: "vscode-extension",
			});
		});

		it("re-enables when own dist-paths/<self> entry points to a missing dist dir", async () => {
			existsSync.mockImplementation(
				(p: string) => !String(p).includes("settings.local.json"),
			);
			mockDeriveSourceTag.mockReturnValue("vscode");
			mockTraverseDistPaths.mockReturnValue([
				{
					source: "vscode",
					version: "1.0.0",
					distDir: "/deleted/dist",
					available: false,
				},
			]);
			const bridge = makeBridge();

			await bridge.refreshHookPathsIfStale("/ext/v2.0.0");

			expect(installerInstall).toHaveBeenCalledWith(TEST_CWD, {
				source: "vscode-extension",
			});
		});

		it("does nothing when own entry exists and is available", async () => {
			vi.stubGlobal("__PKG_VERSION__", "1.0.0");
			existsSync.mockImplementation(
				(p: string) => !String(p).includes("settings.local.json"),
			);
			mockDeriveSourceTag.mockReturnValue("vscode");
			mockTraverseDistPaths.mockReturnValue([
				{
					source: "vscode",
					version: "1.0.0",
					distDir: "/ext/v1.0.0/dist",
					available: true,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.refreshHookPathsIfStale("/ext/v1.0.0");

			expect(installerInstall).not.toHaveBeenCalled();
			expect(result).toBeUndefined();
			vi.stubGlobal("__PKG_VERSION__", undefined);
		});

		it("returns version mismatch when another source has a higher version", async () => {
			vi.stubGlobal("__PKG_VERSION__", "0.5.0");
			existsSync.mockImplementation(
				(p: string) => !String(p).includes("settings.local.json"),
			);
			mockDeriveSourceTag.mockReturnValue("vscode");
			// Own entry registered against the current extensionPath (`/ext/v0.5.0/dist`) so
			// the path-staleness check passes and we fall through to the version comparison.
			mockTraverseDistPaths.mockReturnValue([
				{
					source: "vscode",
					version: "0.5.0",
					distDir: "/ext/v0.5.0/dist",
					available: true,
				},
				{
					source: "cli",
					version: "1.0.0",
					distDir: "/cli/dist",
					available: true,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.refreshHookPathsIfStale("/ext/v0.5.0");

			expect(result).toEqual({
				resolvedVersion: "1.0.0",
				extensionVersion: "0.5.0",
				source: "cli",
			});
			vi.stubGlobal("__PKG_VERSION__", undefined);
		});

		it("re-enables when own entry points to a different install of the same IDE", async () => {
			// Regression: VSCode extension 0.97.5 → 0.97.6 upgrade. The old 0.97.5
			// versioned dir still exists on disk (VSCode cleans it up lazily), so
			// `available` is still true, but `distDir` is for the outdated install.
			// Version-only comparison would miss this because both releases can bundle
			// the same @jolli.ai/cli core version.
			vi.stubGlobal("__PKG_VERSION__", "0.97.4");
			existsSync.mockImplementation(
				(p: string) => !String(p).includes("settings.local.json"),
			);
			mockDeriveSourceTag.mockReturnValue("vscode");
			mockTraverseDistPaths.mockReturnValue([
				{
					source: "vscode",
					version: "0.97.4",
					distDir:
						"/home/.vscode/extensions/jolli.jollimemory-vscode-0.97.5/dist",
					available: true,
				},
			]);
			const bridge = makeBridge();

			await bridge.refreshHookPathsIfStale(
				"/home/.vscode/extensions/jolli.jollimemory-vscode-0.97.6",
			);

			expect(installerInstall).toHaveBeenCalledWith(TEST_CWD, {
				source: "vscode-extension",
			});
			vi.stubGlobal("__PKG_VERSION__", undefined);
		});

		it("returns undefined when extension version equals the highest registered version", async () => {
			vi.stubGlobal("__PKG_VERSION__", "1.0.0");
			existsSync.mockImplementation(
				(p: string) => !String(p).includes("settings.local.json"),
			);
			mockDeriveSourceTag.mockReturnValue("vscode");
			mockTraverseDistPaths.mockReturnValue([
				{
					source: "vscode",
					version: "1.0.0",
					distDir: "/ext/dist",
					available: true,
				},
				{
					source: "cli",
					version: "1.0.0",
					distDir: "/cli/dist",
					available: true,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.refreshHookPathsIfStale("/ext");

			expect(result).toBeUndefined();
			vi.stubGlobal("__PKG_VERSION__", undefined);
		});

		it("returns undefined when extension version is higher than other sources", async () => {
			vi.stubGlobal("__PKG_VERSION__", "2.0.0");
			existsSync.mockImplementation(
				(p: string) => !String(p).includes("settings.local.json"),
			);
			mockDeriveSourceTag.mockReturnValue("vscode");
			mockTraverseDistPaths.mockReturnValue([
				{
					source: "vscode",
					version: "2.0.0",
					distDir: "/ext/dist",
					available: true,
				},
				{
					source: "cli",
					version: "1.0.0",
					distDir: "/cli/dist",
					available: true,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.refreshHookPathsIfStale("/ext");

			expect(result).toBeUndefined();
			vi.stubGlobal("__PKG_VERSION__", undefined);
		});

		// ── Legacy hook detection ──

		it("re-enables via legacy detection when settings.local.json has old-format hooks", async () => {
			// settings.local.json has StopHook but no "dist-path" → legacy
			existsSync.mockImplementation((p: string) =>
				String(p).includes("settings.local.json"),
			);
			readFileSync.mockReturnValue(
				'{"hooks":{"Stop":[{"command":"node /old/path/StopHook.js"}]}}',
			);
			const bridge = makeBridge();

			await bridge.refreshHookPathsIfStale("/ext/v2.0.0");

			expect(installerInstall).toHaveBeenCalledWith(TEST_CWD, {
				source: "vscode-extension",
			});
		});

		it("detects legacy hooks via PostCommitHook keyword (not just StopHook)", async () => {
			existsSync.mockImplementation((p: string) =>
				String(p).includes("settings.local.json"),
			);
			readFileSync.mockReturnValue(
				'{"hooks":{"PostCommit":[{"command":"node /old/PostCommitHook.js"}]}}',
			);
			installerGetStatus.mockResolvedValue({});
			const bridge = makeBridge();

			await bridge.refreshHookPathsIfStale("/ext/v2.0.0");

			expect(installerInstall).toHaveBeenCalledWith(TEST_CWD, {
				source: "vscode-extension",
			});
		});

		it("triggers re-install during legacy migration when scope is not present", async () => {
			existsSync.mockImplementation((p: string) =>
				String(p).includes("settings.local.json"),
			);
			readFileSync.mockReturnValue(
				'{"hooks":{"Stop":[{"command":"node /old/path/StopHook.js"}]}}',
			);
			installerGetStatus.mockResolvedValue({});
			const bridge = makeBridge();

			await bridge.refreshHookPathsIfStale("/ext/v2.0.0");

			expect(installerInstall).toHaveBeenCalledWith(TEST_CWD, {
				source: "vscode-extension",
			});
		});
	});

	// ── getStatus ────────────────────────────────────────────────────────

	describe("getStatus()", () => {
		it("returns status from Installer.getStatus", async () => {
			const bridge = makeBridge();

			const status = await bridge.getStatus();

			expect(status.enabled).toBe(true);
			expect(status.activeSessions).toBe(2);
			expect(status.summaryCount).toBe(5);
			expect(installerGetStatus).toHaveBeenCalledWith(TEST_CWD, expect.anything());
		});

		it("returns safe default when Installer.getStatus throws", async () => {
			installerGetStatus.mockRejectedValue(new Error("status failed"));
			const bridge = makeBridge();

			const status = await bridge.getStatus();

			expect(status.enabled).toBe(false);
			expect(status.activeSessions).toBe(0);
			expect(status.orphanBranch).toBe("jollimemory");
		});
	});

	// ── listFiles ────────────────────────────────────────────────────────

	describe("listFiles()", () => {
		it("parses git status -z output into FileStatus array", async () => {
			mockExecFileSuccess("M  src/main.ts\0?? newfile.ts\0A  added.ts\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(3);
			expect(files[0]).toEqual({
				absolutePath: join(TEST_CWD, "src/main.ts"),
				relativePath: "src/main.ts",
				statusCode: "M",
				indexStatus: "M",
				worktreeStatus: " ",
				isSelected: false,
			});
			expect(files[1]).toEqual({
				absolutePath: join(TEST_CWD, "newfile.ts"),
				relativePath: "newfile.ts",
				statusCode: "?",
				indexStatus: "?",
				worktreeStatus: "?",
				isSelected: false,
			});
			expect(files[2]).toEqual({
				absolutePath: join(TEST_CWD, "added.ts"),
				relativePath: "added.ts",
				statusCode: "A",
				indexStatus: "A",
				worktreeStatus: " ",
				isSelected: false,
			});
		});

		it("returns empty array when git status returns nothing", async () => {
			// tryExecGit returns "" on error
			mockExecFileError("git not found");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toEqual([]);
		});

		it("handles rename entries with original path in next NUL segment", async () => {
			// -z rename format: "R  new.ts\0old.ts\0"
			mockExecFileSuccess("R  new.ts\0old.ts\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(1);
			expect(files[0].relativePath).toBe("new.ts");
			expect(files[0].originalPath).toBe("old.ts");
			expect(files[0].indexStatus).toBe("R");
			expect(files[0].worktreeStatus).toBe(" ");
		});

		it("handles copy entries with original path in next NUL segment", async () => {
			// -z copy format: "C  copy.ts\0original.ts\0"
			mockExecFileSuccess("C  copy.ts\0original.ts\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(1);
			expect(files[0].relativePath).toBe("copy.ts");
			expect(files[0].originalPath).toBe("original.ts");
			expect(files[0].indexStatus).toBe("C");
		});

		it("requests -uall so untracked dirs are expanded into files (no directory rows in CHANGES)", async () => {
			// Default `git status` collapses an untracked-only directory into one
			// `?? docs/` line. The sidebar renders that as a "file" with a `?`
			// status — the bug reported when a fresh `docs/` tree appeared in the
			// CHANGES list as a single directory row. -uall forces git to expand
			// directories into individual untracked file rows.
			mockExecFileSuccess("");
			const bridge = makeBridge();
			await bridge.listFiles();
			const args = execFileMock.mock.calls[0]?.[1] as ReadonlyArray<string>;
			expect(args).toContain("-uall");
		});

		it("drops directory-shaped entries (trailing slash) defensively", async () => {
			// Belt-and-suspenders against a future git mode (or user
			// status.showUntrackedFiles config) that emits a directory entry
			// despite -uall. The CHANGES list is files-only by design, so any
			// path ending with "/" must not be rendered as a row.
			mockExecFileSuccess("?? docs/\0M  src/main.ts\0?? .hidden/\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(1);
			expect(files[0].relativePath).toBe("src/main.ts");
		});

		it("handles paths with spaces verbatim (no quoting in -z mode)", async () => {
			mockExecFileSuccess("M  path with spaces.ts\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(1);
			expect(files[0].relativePath).toBe("path with spaces.ts");
		});

		it("handles UTF-8 paths verbatim (no escaping in -z mode)", async () => {
			mockExecFileSuccess("M  src/文档.ts\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(1);
			expect(files[0].relativePath).toBe("src/文档.ts");
		});

		it("handles rename with paths containing ' -> ' without ambiguity", async () => {
			// This would be ambiguous in line-based mode but is safe with -z
			mockExecFileSuccess("R  dest.ts\0a -> b.ts\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(1);
			expect(files[0].relativePath).toBe("dest.ts");
			expect(files[0].originalPath).toBe("a -> b.ts");
		});

		it("treats unstaged modifications correctly", async () => {
			mockExecFileSuccess(" M unstaged.ts\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(1);
			expect(files[0].isSelected).toBe(false);
			expect(files[0].statusCode).toBe("M");
		});

		it("skips empty trailing segment from final NUL", async () => {
			mockExecFileSuccess("M  valid.ts\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(1);
			expect(files[0].relativePath).toBe("valid.ts");
		});

		it("handles mixed renames and normal entries", async () => {
			mockExecFileSuccess("M  mod.ts\0R  new.ts\0old.ts\0?? untracked.ts\0");
			const bridge = makeBridge();

			const files = await bridge.listFiles();

			expect(files).toHaveLength(3);
			expect(files[0].relativePath).toBe("mod.ts");
			expect(files[1].relativePath).toBe("new.ts");
			expect(files[1].originalPath).toBe("old.ts");
			expect(files[2].relativePath).toBe("untracked.ts");
		});
	});

	// ── listCommitFiles ─────────────────────────────────────────────────

	describe("listCommitFiles()", () => {
		it("parses normal status lines (M, A, D)", async () => {
			mockExecFileSuccess(
				"abc123\nM\tsrc/Foo.ts\nA\tsrc/Bar.ts\nD\tsrc/Old.ts\n",
			);
			const bridge = makeBridge();

			const files = await bridge.listCommitFiles("abc123");

			expect(files).toHaveLength(3);
			expect(files[0]).toEqual({ relativePath: "src/Foo.ts", statusCode: "M" });
			expect(files[1]).toEqual({ relativePath: "src/Bar.ts", statusCode: "A" });
			expect(files[2]).toEqual({ relativePath: "src/Old.ts", statusCode: "D" });
		});

		it("parses rename lines and strips similarity percentage", async () => {
			mockExecFileSuccess("abc123\nR100\tsrc/Old.ts\tsrc/New.ts\n");
			const bridge = makeBridge();

			const files = await bridge.listCommitFiles("abc123");

			expect(files).toHaveLength(1);
			expect(files[0]).toEqual({
				relativePath: "src/New.ts",
				statusCode: "R",
				oldPath: "src/Old.ts",
			});
		});

		it("skips the commit hash header line emitted by --root", async () => {
			// Root commit: first line is the hash (no tab), remaining lines are files
			mockExecFileSuccess("abc123\nA\tREADME.md\nA\tpackage.json\n");
			const bridge = makeBridge();

			const files = await bridge.listCommitFiles("abc123");

			expect(files).toHaveLength(2);
			expect(files[0].relativePath).toBe("README.md");
			expect(files[1].relativePath).toBe("package.json");
		});

		it("handles Windows CRLF line endings", async () => {
			mockExecFileSuccess("abc123\r\nM\tsrc/Foo.ts\r\n");
			const bridge = makeBridge();

			const files = await bridge.listCommitFiles("abc123");

			expect(files).toHaveLength(1);
			expect(files[0].relativePath).toBe("src/Foo.ts");
		});

		it("returns empty array when git command fails", async () => {
			mockExecFileError("git not found");
			const bridge = makeBridge();

			const files = await bridge.listCommitFiles("abc123");

			expect(files).toEqual([]);
		});

		it("returns empty array when output is empty", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			const files = await bridge.listCommitFiles("abc123");

			expect(files).toEqual([]);
		});

		it("skips blank lines in output", async () => {
			mockExecFileSuccess("abc123\n\nM\tsrc/Foo.ts\n\n");
			const bridge = makeBridge();

			const files = await bridge.listCommitFiles("abc123");

			expect(files).toHaveLength(1);
			expect(files[0].relativePath).toBe("src/Foo.ts");
		});

		it("handles partial rename similarity (e.g. R075)", async () => {
			mockExecFileSuccess("abc123\nR075\tsrc/Old.ts\tsrc/New.ts\n");
			const bridge = makeBridge();

			const files = await bridge.listCommitFiles("abc123");

			expect(files).toHaveLength(1);
			expect(files[0].statusCode).toBe("R");
			expect(files[0].oldPath).toBe("src/Old.ts");
			expect(files[0].relativePath).toBe("src/New.ts");
		});

		it("lists files for merge commits — only first-parent block", async () => {
			// -m emits one diff block per parent.  The parser must stop after the
			// first block so files from the second parent don't leak in.
			mockExecFileSuccess(
				"abc123\nM\tsrc/Merged.ts\nA\tsrc/Feature.ts\nabc123\nA\tsrc/FromMain.ts\nM\tsrc/Merged.ts\n",
			);
			const bridge = makeBridge();

			const files = await bridge.listCommitFiles("abc123");

			expect(files).toHaveLength(2);
			expect(files[0]).toEqual({
				relativePath: "src/Merged.ts",
				statusCode: "M",
			});
			expect(files[1]).toEqual({
				relativePath: "src/Feature.ts",
				statusCode: "A",
			});
		});
	});

	// ── stageFile / stageFiles ───────────────────────────────────────────

	// Helper: a Stats-like sentinel. `lstatSync(..., { throwIfNoEntry: false })`
	// returns a real `fs.Stats` for any filesystem entry (including dangling
	// symlinks); tests only care that the return is !== undefined.
	const STATS_PRESENT = {} as unknown as ReturnType<typeof lstatSync>;

	describe("stageFiles() — default mode (restore semantics)", () => {
		// Default mode (no opts) is what CommitCommand.ts:200 and
		// SquashCommand.ts:205 use to reinstate pre-flow staging. Contract:
		// "just run git add and let it fail loudly" so the rejection surfaces
		// the existing "previously-staged files could not be re-staged"
		// warning.

		it("runs plain git add with all paths and no existence check", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.stageFiles(["a.ts", "b.ts"]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["add", "--", "a.ts", "b.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledTimes(1);
			// No fs lookups in default mode — contract lock for restore callers.
			expect(lstatSync).not.toHaveBeenCalled();
			expect(existsSync).not.toHaveBeenCalled();
		});

		it("propagates git add rejection unchanged (preserves restore warning)", async () => {
			mockExecFileError(
				"fatal: pathspec 'ignored-and-gone.ts' did not match any files",
			);
			const bridge = makeBridge();

			await expect(bridge.stageFiles(["ignored-and-gone.ts"])).rejects.toThrow(
				/did not match any files/,
			);
		});

		it("does nothing when paths array is empty", async () => {
			const bridge = makeBridge();

			await bridge.stageFiles([]);

			expect(execFileMock).not.toHaveBeenCalled();
		});
	});

	describe("stageFiles() — allowMissing mode (AI-commit selection)", () => {
		it("runs git add with multiple paths when all exist", async () => {
			lstatSync.mockReturnValue(STATS_PRESENT);
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.stageFiles(["a.ts", "b.ts"], { allowMissing: true });

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["add", "--", "a.ts", "b.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledTimes(1);
		});

		it("runs git rm --cached --ignore-unmatch when all paths are missing", async () => {
			lstatSync.mockReturnValue(undefined);
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.stageFiles(["a.ts", "b.ts"], { allowMissing: true });

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["rm", "--cached", "--ignore-unmatch", "--", "a.ts", "b.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledTimes(1);
		});

		it("partitions mixed paths and runs git add before git rm --cached", async () => {
			lstatSync.mockImplementation((p: string) =>
				p === join(TEST_CWD, "a.ts") ? STATS_PRESENT : undefined,
			);
			mockExecFileSuccess(""); // for git add
			mockExecFileSuccess(""); // for git rm --cached
			const bridge = makeBridge();

			await bridge.stageFiles(["a.ts", "b.ts"], { allowMissing: true });

			expect(execFileMock).toHaveBeenNthCalledWith(
				1,
				"git",
				["add", "--", "a.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenNthCalledWith(
				2,
				"git",
				["rm", "--cached", "--ignore-unmatch", "--", "b.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("routes the reported scenario (gitignored + deleted) to git rm --cached", async () => {
			// Selection contains a path that `git add` would reject because it
			// is gitignored and deleted from the worktree — simulated here by
			// lstatSync returning undefined for that path. The partition logic
			// must route it to `git rm --cached`, not `git add`.
			lstatSync.mockImplementation((p: string) =>
				p === join(TEST_CWD, "ignored-and-gone.ts") ? undefined : STATS_PRESENT,
			);
			mockExecFileSuccess(""); // git add for the healthy path
			mockExecFileSuccess(""); // git rm --cached for the problem path
			const bridge = makeBridge();

			await expect(
				bridge.stageFiles(["healthy.ts", "ignored-and-gone.ts"], {
					allowMissing: true,
				}),
			).resolves.toBeUndefined();

			expect(execFileMock).toHaveBeenNthCalledWith(
				1,
				"git",
				["add", "--", "healthy.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenNthCalledWith(
				2,
				"git",
				["rm", "--cached", "--ignore-unmatch", "--", "ignored-and-gone.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("routes a dangling symlink to git add, not git rm --cached", async () => {
			// Regression lock for P2: fs.existsSync follows symlinks and returns
			// false for a dangling link. lstatSync, which we use, returns a
			// Stats object for any fs entry (including dangling links) —
			// matching what `git add` actually accepts.
			lstatSync.mockReturnValue(STATS_PRESENT);
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.stageFiles(["dangling-link"], { allowMissing: true });

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["add", "--", "dangling-link"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledTimes(1);
		});

		it("calls lstatSync with join(cwd, path) and throwIfNoEntry: false", async () => {
			lstatSync.mockReturnValue(STATS_PRESENT);
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.stageFiles(["src/main.ts"], { allowMissing: true });

			expect(lstatSync).toHaveBeenCalledWith(join(TEST_CWD, "src/main.ts"), {
				throwIfNoEntry: false,
			});
		});

		it("propagates git add rejection and does not invoke git rm --cached", async () => {
			lstatSync.mockReturnValue(STATS_PRESENT);
			mockExecFileError("add failed");
			const bridge = makeBridge();

			await expect(
				bridge.stageFiles(["a.ts"], { allowMissing: true }),
			).rejects.toThrow("add failed");
			expect(execFileMock).toHaveBeenCalledTimes(1);
		});

		it("propagates git rm --cached rejection even though git add already succeeded", async () => {
			lstatSync.mockImplementation((p: string) =>
				p === join(TEST_CWD, "a.ts") ? STATS_PRESENT : undefined,
			);
			mockExecFileSuccess(""); // git add succeeds
			mockExecFileError("rm failed"); // git rm --cached rejects
			const bridge = makeBridge();

			await expect(
				bridge.stageFiles(["a.ts", "b.ts"], { allowMissing: true }),
			).rejects.toThrow("rm failed");
			expect(execFileMock).toHaveBeenCalledTimes(2);
		});

		it("does nothing when paths array is empty", async () => {
			const bridge = makeBridge();

			await bridge.stageFiles([], { allowMissing: true });

			expect(execFileMock).not.toHaveBeenCalled();
			expect(lstatSync).not.toHaveBeenCalled();
		});
	});

	// ── unstageFile / unstageFiles ───────────────────────────────────────

	describe("unstageFiles() — single file", () => {
		it("runs git restore --staged for the given path", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.unstageFiles(["src/main.ts"]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--", "src/main.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});
	});

	describe("unstageFiles()", () => {
		it("runs git restore --staged with multiple paths", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.unstageFiles(["a.ts", "b.ts"]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--", "a.ts", "b.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("does nothing when paths array is empty", async () => {
			const bridge = makeBridge();

			await bridge.unstageFiles([]);

			expect(execFileMock).not.toHaveBeenCalled();
		});
	});

	// ── discardFiles ────────────────────────────────────────────────────

	describe("discardFiles()", () => {
		function makeFileStatus(
			relativePath: string,
			indexStatus: string,
			worktreeStatus: string,
			originalPath?: string,
		) {
			const hasIndexEntry = indexStatus !== " " && indexStatus !== "?";
			const statusCode = hasIndexEntry ? indexStatus : worktreeStatus;
			return {
				absolutePath: `${TEST_CWD}/${relativePath}`,
				relativePath,
				statusCode,
				indexStatus,
				worktreeStatus,
				...(originalPath ? { originalPath } : {}),
				isSelected: false,
			};
		}

		beforeEach(() => {
			lstat.mockReset();
			unlink.mockReset();
			rm.mockReset();
		});

		it("restores worktree for unstaged modification ( M)", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("file.ts", " ", "M")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--", "file.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("restores staged+worktree for staged-only modification (M )", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("file.ts", "M", " ")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--worktree", "--", "file.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("restores staged+worktree for staged+unstaged modification (MM)", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("file.ts", "M", "M")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--worktree", "--", "file.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("restores worktree for unstaged deletion ( D)", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("file.ts", " ", "D")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--", "file.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("restores staged+worktree for staged deletion (D )", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("file.ts", "D", " ")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--worktree", "--", "file.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("unstages and removes added file (A )", async () => {
			mockExecFileSuccess(""); // git restore --staged
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("new.ts", "A", " ")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--", "new.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(unlink).toHaveBeenCalledWith(`${TEST_CWD}/new.ts`);
		});

		it("unstages and removes added+modified file (AM)", async () => {
			mockExecFileSuccess(""); // git restore --staged
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("new.ts", "A", "M")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--", "new.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(unlink).toHaveBeenCalledWith(`${TEST_CWD}/new.ts`);
		});

		it("removes untracked file (??)", async () => {
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("untracked.ts", "?", "?")]);

			expect(execFileMock).not.toHaveBeenCalled();
			expect(lstat).toHaveBeenCalledWith(`${TEST_CWD}/untracked.ts`);
			expect(unlink).toHaveBeenCalledWith(`${TEST_CWD}/untracked.ts`);
		});

		it("removes untracked directory with rm recursive (??)", async () => {
			lstat.mockResolvedValue({ isDirectory: () => true });
			rm.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("new-folder", "?", "?")]);

			expect(lstat).toHaveBeenCalledWith(`${TEST_CWD}/new-folder`);
			expect(rm).toHaveBeenCalledWith(`${TEST_CWD}/new-folder`, {
				recursive: true,
			});
			expect(unlink).not.toHaveBeenCalled();
		});

		it("unstages and removes copied file (C )", async () => {
			mockExecFileSuccess(""); // git restore --staged
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([
				makeFileStatus("copy.ts", "C", " ", "original.ts"),
			]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--", "copy.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(unlink).toHaveBeenCalledWith(`${TEST_CWD}/copy.ts`);
		});

		it("handles rename by unstaging both paths, restoring old, removing new (R )", async () => {
			mockExecFileSuccess(""); // git restore --staged -- new.ts old.ts
			mockExecFileSuccess(""); // git restore -- old.ts
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("new.ts", "R", " ", "old.ts")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--", "new.ts", "old.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--", "old.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(unlink).toHaveBeenCalledWith(`${TEST_CWD}/new.ts`);
		});

		it("handles rename without originalPath by unstaging only new path and skipping restore (R )", async () => {
			mockExecFileSuccess(""); // git restore --staged -- new.ts
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("new.ts", "R", " ")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--", "new.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			// Should NOT call git restore -- (worktree restore, without --staged)
			const restoreCalls = execFileMock.mock.calls.filter(
				(c: Array<unknown>) =>
					(c[1] as Array<string>)[0] === "restore" &&
					!(c[1] as Array<string>).includes("--staged"),
			);
			expect(restoreCalls).toHaveLength(0);
			expect(unlink).toHaveBeenCalledWith(`${TEST_CWD}/new.ts`);
		});

		it("handles rename+edit by unstaging both paths, restoring old, removing new (RM)", async () => {
			mockExecFileSuccess(""); // git restore --staged -- new.ts old.ts
			mockExecFileSuccess(""); // git restore -- old.ts
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("new.ts", "R", "M", "old.ts")]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--", "new.ts", "old.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--", "old.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("ignores ENOENT when file already gone on lstat", async () => {
			const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			lstat.mockRejectedValue(enoent);
			const bridge = makeBridge();

			await expect(
				bridge.discardFiles([makeFileStatus("gone.ts", "?", "?")]),
			).resolves.toBeUndefined();
		});

		it("ignores ENOENT when file already gone on unlink", async () => {
			const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockRejectedValue(enoent);
			const bridge = makeBridge();

			await expect(
				bridge.discardFiles([makeFileStatus("gone.ts", "?", "?")]),
			).resolves.toBeUndefined();
		});

		it("re-throws non-ENOENT errors", async () => {
			const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
			lstat.mockRejectedValue(eperm);
			const bridge = makeBridge();

			await expect(
				bridge.discardFiles([makeFileStatus("locked.ts", "?", "?")]),
			).rejects.toThrow("EPERM");
		});

		it("handles rename without originalPath (unstages only new path, skips restore)", async () => {
			mockExecFileSuccess(""); // git restore --staged -- new.ts (single path)
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([makeFileStatus("new.ts", "R", " ")]);

			// Only the new path should be unstaged (no second path)
			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--", "new.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			// No separate restore for old path
			expect(execFileMock).toHaveBeenCalledTimes(1);
			expect(unlink).toHaveBeenCalledWith(`${TEST_CWD}/new.ts`);
		});

		it("batches mixed status types into grouped git calls", async () => {
			mockExecFileSuccess(""); // git restore --staged --worktree (for staged M)
			mockExecFileSuccess(""); // git restore -- (for unstaged M)
			lstat.mockResolvedValue({ isDirectory: () => false });
			unlink.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.discardFiles([
				makeFileStatus("staged.ts", "M", " "),
				makeFileStatus("unstaged.ts", " ", "M"),
				makeFileStatus("new.ts", "?", "?"),
			]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--staged", "--worktree", "--", "staged.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--", "unstaged.ts"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
			expect(unlink).toHaveBeenCalledWith(`${TEST_CWD}/new.ts`);
		});

		it("does nothing for empty file list", async () => {
			const bridge = makeBridge();

			await bridge.discardFiles([]);

			expect(execFileMock).not.toHaveBeenCalled();
			expect(unlink).not.toHaveBeenCalled();
		});
	});

	// ── generateCommitMessage ────────────────────────────────────────────

	describe("generateCommitMessage()", () => {
		it("loads config, staged diff, branch and calls Summarizer", async () => {
			// Promise.all fires: diff --cached, getCurrentBranch, loadGlobalConfig (not execFile)
			// 1) staged diff (tryExecGit for diff --cached)
			mockExecFileSuccess("diff --cached output\n");
			// 2) getCurrentBranch (tryExecGit for rev-parse --abbrev-ref HEAD)
			mockExecFileSuccess("feature/test\n");
			// 3) getStagedFilePaths (tryExecGit for diff --cached -z --name-only)
			mockExecFileSuccess("src/a.ts\0src/b.ts\0");
			generateCommitMessage.mockResolvedValue("feat: add feature");

			const bridge = makeBridge();
			const result = await bridge.generateCommitMessage();

			expect(result).toBe("feat: add feature");
			expect(generateCommitMessage).toHaveBeenCalledWith({
				stagedDiff: expect.any(String),
				branch: "feature/test",
				stagedFiles: ["src/a.ts", "src/b.ts"],
				config: { apiKey: "test-key", model: "claude-3" },
			});
		});
	});

	// ── generateCommitMessageForFiles ────────────────────────────────────

	describe("generateCommitMessageForFiles()", () => {
		it("summarizes the selected files' working-tree diff (HEAD), not the index", async () => {
			// 1) getCurrentBranch (rev-parse --abbrev-ref HEAD)
			mockExecFileSuccess("feature/test\n");
			// 2) working-tree diff of the selected paths (git diff HEAD -- <paths>)
			mockExecFileSuccess("diff HEAD output\n");
			// 3) untracked probe among the selection — none here.
			mockExecFileSuccess("");
			generateCommitMessage.mockResolvedValue("feat: selected");

			const bridge = makeBridge();
			const result = await bridge.generateCommitMessageForFiles(["src/a.ts", "src/b.ts"]);

			expect(result).toBe("feat: selected");
			expect(generateCommitMessage).toHaveBeenCalledWith({
				stagedDiff: expect.any(String),
				branch: "feature/test",
				stagedFiles: ["src/a.ts", "src/b.ts"],
				config: { apiKey: "test-key", model: "claude-3" },
			});
			const diffCall = execFileMock.mock.calls.find(
				(c) => Array.isArray(c[1]) && (c[1] as ReadonlyArray<string>).includes("diff"),
			);
			expect(diffCall?.[1]).toEqual(["-c", "core.quotepath=false", "diff", "HEAD", "--", "src/a.ts", "src/b.ts"]);
		});

		it("includes untracked selected files as full 'new file' additions (git diff HEAD omits them)", async () => {
			// A selection made entirely of a brand-new file: `git diff HEAD` is empty
			// for it, but Commit Memory would stage + commit it, so the title preview
			// must see its content via `git diff --no-index /dev/null <file>`.
			mockExecFileSuccess("feature/test\n"); // getCurrentBranch
			mockExecFileSuccess(""); // git diff HEAD -- new.ts (untracked → empty)
			mockExecFileSuccess("new.ts\n"); // git ls-files --others -- new.ts
			// `git diff --no-index` exits 1 when it finds a diff → execGit rejects, but
			// the diff rides on the error's stdout (Node execFile behavior).
			const NEW_FILE_DIFF =
				"diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+hello\n";
			execFileMock.mockImplementationOnce(
				(
					_cmd: string,
					_args: Array<string>,
					_opts: unknown,
					callback: (err: Error & { stdout?: string }) => void,
				) => {
					const err = new Error("exit 1") as Error & { stdout?: string };
					err.stdout = NEW_FILE_DIFF;
					callback(err);
				},
			);
			generateCommitMessage.mockResolvedValue("feat: add new.ts");

			const result = await makeBridge().generateCommitMessageForFiles(["new.ts"]);

			expect(result).toBe("feat: add new.ts");
			expect(generateCommitMessage).toHaveBeenCalledWith(
				expect.objectContaining({ stagedDiff: NEW_FILE_DIFF, stagedFiles: ["new.ts"] }),
			);
			// The untracked probe and the --no-index render both ran with the expected args.
			const lsFilesCall = execFileMock.mock.calls.find(
				(c) => Array.isArray(c[1]) && (c[1] as ReadonlyArray<string>).includes("ls-files"),
			);
			expect(lsFilesCall?.[1]).toEqual([
				"-c",
				"core.quotepath=false",
				"ls-files",
				"--others",
				"--exclude-standard",
				"--",
				"new.ts",
			]);
			const noIndexCall = execFileMock.mock.calls.find(
				(c) => Array.isArray(c[1]) && (c[1] as ReadonlyArray<string>).includes("--no-index"),
			);
			expect(noIndexCall?.[1]).toEqual([
				"-c",
				"core.quotepath=false",
				"diff",
				"--no-index",
				"--",
				"/dev/null",
				"new.ts",
			]);
		});

		it("combines tracked changes with untracked additions when the selection mixes both", async () => {
			mockExecFileSuccess("feature/test\n"); // getCurrentBranch
			mockExecFileSuccess("TRACKED-DIFF\n"); // git diff HEAD -- tracked.ts new.ts
			mockExecFileSuccess("new.ts\n"); // ls-files --others → only new.ts is untracked
			execFileMock.mockImplementationOnce(
				(
					_cmd: string,
					_args: Array<string>,
					_opts: unknown,
					callback: (err: Error & { stdout?: string }) => void,
				) => {
					const err = new Error("exit 1") as Error & { stdout?: string };
					err.stdout = "UNTRACKED-DIFF\n";
					callback(err);
				},
			);
			generateCommitMessage.mockResolvedValue("feat: mix");

			await makeBridge().generateCommitMessageForFiles(["tracked.ts", "new.ts"]);

			// Tracked diff first, then the synthesized untracked addition, concatenated.
			expect(generateCommitMessage).toHaveBeenCalledWith(
				expect.objectContaining({ stagedDiff: "TRACKED-DIFF\nUNTRACKED-DIFF\n" }),
			);
		});

		it("passes an empty diff and never calls git diff when nothing is selected", async () => {
			// Only getCurrentBranch runs; an empty selection short-circuits the diff.
			mockExecFileSuccess("feature/test\n");
			generateCommitMessage.mockResolvedValue("chore: none");

			await makeBridge().generateCommitMessageForFiles([]);

			expect(generateCommitMessage).toHaveBeenCalledWith(
				expect.objectContaining({ stagedDiff: "", stagedFiles: [] }),
			);
			const diffCall = execFileMock.mock.calls.find(
				(c) => Array.isArray(c[1]) && (c[1] as ReadonlyArray<string>)[0] === "diff",
			);
			expect(diffCall).toBeUndefined();
		});
	});

	// ── commit ───────────────────────────────────────────────────────────

	describe("commit()", () => {
		it("saves plugin source, commits, and returns new hash", async () => {
			// git commit -m
			mockExecFileSuccess("");
			// getHEADHash (git rev-parse HEAD)
			mockExecFileSuccess("abc123def456\n");

			const bridge = makeBridge();
			const hash = await bridge.commit("feat: new feature");

			expect(savePluginSource).toHaveBeenCalledWith(TEST_CWD);
			expect(hash).toBe("abc123def456");
		});

		it("omits -s when dcoSignoff is false (default)", async () => {
			mockExecFileSuccess(""); // commit
			mockExecFileSuccess("abc\n"); // rev-parse

			await makeBridge().commit("feat: x");

			const args = execFileMock.mock.calls[0]?.[1] as ReadonlyArray<string>;
			expect(args).toEqual(["commit", "-m", "feat: x"]);
		});

		it("inserts -s into commit args when dcoSignoff is true", async () => {
			loadConfig.mockResolvedValue({ dcoSignoff: true });
			mockExecFileSuccess(""); // commit
			mockExecFileSuccess("abc\n"); // rev-parse

			await makeBridge().commit("feat: x");

			const args = execFileMock.mock.calls[0]?.[1] as ReadonlyArray<string>;
			expect(args).toEqual(["commit", "-s", "-m", "feat: x"]);
		});
	});

	// ── amendCommit ──────────────────────────────────────────────────────

	describe("amendCommit()", () => {
		it("writes plugin-source, amends commit, and returns new hash", async () => {
			// getHEADHash before amend
			mockExecFileSuccess("oldHash123\n");
			// git commit --amend -m
			mockExecFileSuccess("");
			// getHEADHash after amend
			mockExecFileSuccess("newHash456\n");

			const bridge = makeBridge();
			const hash = await bridge.amendCommit("fix: updated message");

			expect(savePluginSource).toHaveBeenCalledWith(TEST_CWD);
			// amend-pending.json is no longer written — post-rewrite handles amend detection
			expect(hash).toBe("newHash456");
		});

		it("omits -s when dcoSignoff is false (default)", async () => {
			mockExecFileSuccess("old\n");
			mockExecFileSuccess(""); // amend
			mockExecFileSuccess("new\n");

			await makeBridge().amendCommit("fix: x");

			const args = execFileMock.mock.calls[1]?.[1] as ReadonlyArray<string>;
			expect(args).toEqual(["commit", "--amend", "-m", "fix: x"]);
		});

		it("inserts -s into amend args when dcoSignoff is true", async () => {
			loadConfig.mockResolvedValue({ dcoSignoff: true });
			mockExecFileSuccess("old\n");
			mockExecFileSuccess(""); // amend
			mockExecFileSuccess("new\n");

			await makeBridge().amendCommit("fix: x");

			const args = execFileMock.mock.calls[1]?.[1] as ReadonlyArray<string>;
			expect(args).toEqual(["commit", "--amend", "-s", "-m", "fix: x"]);
		});
	});

	// ── amendCommitNoEdit ───────────────────────────────────────────────

	describe("amendCommitNoEdit()", () => {
		it("writes plugin-source, amends commit without changing message, and returns new hash", async () => {
			// getHEADHash before amend
			mockExecFileSuccess("oldHash123\n");
			// git commit --amend --no-edit
			mockExecFileSuccess("");
			// getHEADHash after amend
			mockExecFileSuccess("newHash456\n");

			const bridge = makeBridge();
			const hash = await bridge.amendCommitNoEdit();

			expect(savePluginSource).toHaveBeenCalledWith(TEST_CWD);
			// amend-pending.json is no longer written — post-rewrite handles amend detection
			expect(hash).toBe("newHash456");
		});

		it("omits -s when dcoSignoff is false (default)", async () => {
			mockExecFileSuccess("old\n");
			mockExecFileSuccess(""); // amend --no-edit
			mockExecFileSuccess("new\n");

			await makeBridge().amendCommitNoEdit();

			const args = execFileMock.mock.calls[1]?.[1] as ReadonlyArray<string>;
			expect(args).toEqual(["commit", "--amend", "--no-edit"]);
		});

		it("inserts -s into amend --no-edit args when dcoSignoff is true", async () => {
			loadConfig.mockResolvedValue({ dcoSignoff: true });
			mockExecFileSuccess("old\n");
			mockExecFileSuccess(""); // amend --no-edit
			mockExecFileSuccess("new\n");

			await makeBridge().amendCommitNoEdit();

			const args = execFileMock.mock.calls[1]?.[1] as ReadonlyArray<string>;
			expect(args).toEqual(["commit", "--amend", "-s", "--no-edit"]);
		});
	});

	// ── isHeadPushed ─────────────────────────────────────────────────────

	describe("isHeadPushed()", () => {
		it("returns true when HEAD is not in the unpushed list", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolvePushBaseRef → rev-parse @{upstream}
			mockExecFileSuccess("origin/feature/test\n");
			// refExists → rev-parse --verify
			mockExecFileSuccess("abc123\n");
			// getHEADHash
			mockExecFileSuccess("abc123\n");
			// rev-list (unpushed) — empty means HEAD is pushed
			mockExecFileSuccess("\n");

			const bridge = makeBridge();
			const result = await bridge.isHeadPushed();

			expect(result).toBe(true);
		});

		it("returns false when HEAD is in the unpushed list", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolvePushBaseRef → rev-parse @{upstream}
			mockExecFileSuccess("origin/feature/test\n");
			// refExists → rev-parse --verify
			mockExecFileSuccess("def456\n");
			// getHEADHash
			mockExecFileSuccess("abc123\n");
			// rev-list (unpushed) — HEAD is in the list
			mockExecFileSuccess("abc123\n");

			const bridge = makeBridge();
			const result = await bridge.isHeadPushed();

			expect(result).toBe(false);
		});

		it("returns false when no push base ref exists", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolvePushBaseRef → rev-parse @{upstream} fails
			mockExecFileError("no upstream");
			// refExists for origin/feature/test — fails
			mockExecFileError("not found");

			const bridge = makeBridge();
			const result = await bridge.isHeadPushed();

			expect(result).toBe(false);
		});
	});

	// ── getAmendSafety ───────────────────────────────────────────────────

	describe("getAmendSafety()", () => {
		// Call order: getHEADHash → getCurrentBranch → refExists(origin/main) →
		// merge-base → findBranchCreationPoint (reflog) → [merge-base --is-ancestor
		// when the creation point differs from the merge-base] → log %ae →
		// config user.email.

		it("reports own work when the branch was cut from main and the author matches", async () => {
			mockExecFileSuccess("head1111\n"); // getHEADHash
			mockExecFileSuccess("feature/x\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("mergebase7\n"); // merge-base — differs from HEAD
			// reflog: created from main at the merge-base → creationPoint == merge-base
			mockExecFileSuccess("mergebase7 branch: Created from main\n");
			mockExecFileSuccess("Me@Example.com\n"); // author (different case — must still match)
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			expect(result).toEqual({
				hasOwnCommits: true,
				headAuthoredByCurrentUser: true,
			});
		});

		it("flags no own commits when HEAD equals the mainline merge-base", async () => {
			mockExecFileSuccess("samehash0\n"); // getHEADHash
			mockExecFileSuccess("fix/foo\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("samehash0\n"); // merge-base === HEAD
			mockExecFileSuccess("samehash0 branch: Created from main\n"); // reflog → creationPoint == merge-base
			mockExecFileSuccess("me@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			expect(result.hasOwnCommits).toBe(false);
			expect(result.headAuthoredByCurrentUser).toBe(true);
		});

		it("flags no own commits for a fresh branch cut from a non-main base (release fork)", async () => {
			// hotfix/x cut from release/1.0 at E; HEAD is still E (zero own commits).
			mockExecFileSuccess("E0000000\n"); // getHEADHash (HEAD = E)
			mockExecFileSuccess("hotfix/x\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("C0000000\n"); // merge-base with main = C
			mockExecFileSuccess("E0000000 branch: Created from release/1.0\n"); // reflog → creationPoint = E
			mockExecFileSuccess(""); // is-ancestor E HEAD → exit 0 (still behind HEAD) → keep E
			mockExecFileSuccess(""); // is-ancestor C E → exit 0 (downstream) → base = E
			mockExecFileSuccess("me@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			// base == E == HEAD → no own commits, even though E is ahead of main.
			expect(result.hasOwnCommits).toBe(false);
		});

		it("reports own work once the release-fork branch has its own commit", async () => {
			// hotfix/x cut from release/1.0 at E, now with own commit F on top.
			mockExecFileSuccess("F0000000\n"); // getHEADHash (HEAD = F)
			mockExecFileSuccess("hotfix/x\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("C0000000\n"); // merge-base with main = C
			mockExecFileSuccess("E0000000 branch: Created from release/1.0\n"); // reflog → creationPoint = E
			mockExecFileSuccess(""); // is-ancestor E HEAD → behind HEAD → keep E
			mockExecFileSuccess(""); // is-ancestor C E → downstream → base = E
			mockExecFileSuccess("me@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			// base == E != F → own commit exists → amend allowed.
			expect(result.hasOwnCommits).toBe(true);
		});

		it("skips the reflog fork point on detached HEAD and uses the mainline merge-base", async () => {
			mockExecFileSuccess("head1111\n"); // getHEADHash
			mockExecFileSuccess("HEAD\n"); // getCurrentBranch → detached
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("mergebase7\n"); // merge-base
			// findBranchCreationPoint bails out for "HEAD" → no reflog call,
			// resolveOwnCommitsBase returns the merge-base directly.
			mockExecFileSuccess("me@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			// base == merge-base (mergebase7) != HEAD → own work, no reflog consulted.
			expect(result.hasOwnCommits).toBe(true);
		});

		it("falls back to the mainline merge-base when the reflog is unavailable", async () => {
			mockExecFileSuccess("head1111\n"); // getHEADHash
			mockExecFileSuccess("feature/x\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("mergebase7\n"); // merge-base
			mockExecFileSuccess("\n"); // reflog empty → creationPoint undefined → use merge-base
			mockExecFileSuccess("me@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			// base == merge-base (mergebase7) != HEAD → own work.
			expect(result.hasOwnCommits).toBe(true);
		});

		it("keeps the mainline merge-base when the creation point is not downstream of it", async () => {
			mockExecFileSuccess("head1111\n"); // getHEADHash
			mockExecFileSuccess("feature/x\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("mergebase7\n"); // merge-base
			mockExecFileSuccess("other000 branch: Created from somewhere\n"); // reflog → creationPoint = other000
			mockExecFileSuccess(""); // is-ancestor other000 HEAD → behind HEAD (P1 guard passes)
			mockExecFileError("not downstream"); // is-ancestor mergebase7 other000 → exit 1 → keep merge-base
			mockExecFileSuccess("me@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			// base == mergebase7 != HEAD → own work.
			expect(result.hasOwnCommits).toBe(true);
		});

		it("rejects a stale creation point that is no longer an ancestor of HEAD (reset onto another branch)", async () => {
			// feature cut from develop (D1), then `git reset --hard release` → HEAD = R1.
			// The reflog still says "Created from develop", but D1 is no longer behind HEAD.
			mockExecFileSuccess("R1111111\n"); // getHEADHash (HEAD = R1, release tip)
			mockExecFileSuccess("feature\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("M1111111\n"); // merge-base with main = M1
			mockExecFileSuccess("D1111111 branch: Created from develop\n"); // reflog → stale creationPoint = D1
			mockExecFileError("not an ancestor"); // is-ancestor D1 HEAD → exit 1 → stale → fall back to M1
			mockExecFileSuccess("me@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			// The stale D1 is rejected; base falls back to the mainline merge-base M1.
			const guardCall = execFileMock.mock.calls.find(
				(c) =>
					Array.isArray(c[1]) &&
					c[1][1] === "--is-ancestor" &&
					c[1][2] === "D1111111" &&
					c[1][3] === "HEAD",
			);
			expect(guardCall).toBeDefined();
			// Falls back to M1 (≠ HEAD); the downstream check on D1 is never reached.
			expect(result.hasOwnCommits).toBe(true);
			const downstreamCall = execFileMock.mock.calls.find(
				(c) =>
					Array.isArray(c[1]) &&
					c[1][1] === "--is-ancestor" &&
					c[1][3] === "D1111111",
			);
			expect(downstreamCall).toBeUndefined();
		});

		it("ignores a guessed oldest reflog entry when no explicit creation record survives (P2)", async () => {
			// Single-commit branch whose "Created from" reflog entry has expired;
			// the oldest surviving entry is the branch's own first commit F1.
			mockExecFileSuccess("F1111111\n"); // getHEADHash (HEAD = F1)
			mockExecFileSuccess("feature\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("M1111111\n"); // merge-base with main = M1
			// reflog has entries but NO "branch: Created from" → requireExplicit → undefined.
			mockExecFileSuccess("F1111111 commit: my first commit\n");
			mockExecFileSuccess("me@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			// base degrades to M1 (not the guessed F1), so the lone commit still
			// counts as own work and amend stays available.
			expect(result.hasOwnCommits).toBe(true);
		});

		it("uses the reflog creation point directly when the mainline is unresolvable (master default)", async () => {
			// master-default repo: origin/main, upstream/main, main all missing.
			mockExecFileSuccess("E0000000\n"); // getHEADHash (HEAD = E)
			mockExecFileSuccess("hotfix/x\n"); // getCurrentBranch
			mockExecFileError("no origin/main"); // refExists origin/main
			mockExecFileError("no upstream/main"); // refExists upstream/main
			mockExecFileError("no main"); // refExists main → resolveHistoryBaseRef returns "main"
			mockExecFileError("no merge base"); // merge-base HEAD main → "" (mergeBaseMain unresolvable)
			mockExecFileSuccess("E0000000 branch: Created from release/1.0\n"); // reflog → creationPoint = E
			mockExecFileSuccess(""); // is-ancestor E HEAD → behind HEAD (P1 guard passes)
			mockExecFileSuccess("me@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			// mergeBaseMain == "" → use creationPoint E directly; E == HEAD → no own commits.
			expect(result.hasOwnCommits).toBe(false);
		});

		it("flags a foreign author when HEAD email differs from user.email", async () => {
			mockExecFileSuccess("head1111\n"); // getHEADHash
			mockExecFileSuccess("feature/x\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("mergebase7\n"); // merge-base
			mockExecFileSuccess("mergebase7 branch: Created from main\n"); // reflog → creationPoint == merge-base
			mockExecFileSuccess("colleague@example.com\n"); // author
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			expect(result.hasOwnCommits).toBe(true);
			expect(result.headAuthoredByCurrentUser).toBe(false);
		});

		it("treats an empty HEAD author email as not the current user", async () => {
			mockExecFileSuccess("head1111\n"); // getHEADHash
			mockExecFileSuccess("feature/x\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("mergebase7\n"); // merge-base
			mockExecFileSuccess("mergebase7 branch: Created from main\n"); // reflog
			mockExecFileSuccess("\n"); // author email empty
			mockExecFileSuccess("me@example.com\n"); // user.email

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			expect(result.headAuthoredByCurrentUser).toBe(false);
		});

		it("treats an empty user.email as not the current user", async () => {
			mockExecFileSuccess("head1111\n"); // getHEADHash
			mockExecFileSuccess("feature/x\n"); // getCurrentBranch
			mockExecFileSuccess("base9999\n"); // refExists origin/main
			mockExecFileSuccess("mergebase7\n"); // merge-base
			mockExecFileSuccess("mergebase7 branch: Created from main\n"); // reflog
			mockExecFileSuccess("someone@example.com\n"); // author
			mockExecFileSuccess("\n"); // user.email empty

			const bridge = makeBridge();
			const result = await bridge.getAmendSafety("main");

			expect(result.headAuthoredByCurrentUser).toBe(false);
		});
	});

	// ── isHeadSharedWithOtherBranch ──────────────────────────────────────

	describe("isHeadSharedWithOtherBranch()", () => {
		// Call order: for-each-ref --contains=HEAD → [getCurrentBranch →
		// @{upstream}] (only when the ref list is non-empty).

		it("returns false when only the current branch and its upstream contain HEAD", async () => {
			mockExecFileSuccess(
				"refs/heads/feature\nrefs/remotes/origin/feature\n",
			); // for-each-ref
			mockExecFileSuccess("feature\n"); // getCurrentBranch
			mockExecFileSuccess("origin/feature\n"); // @{upstream}

			const bridge = makeBridge();
			expect(await bridge.isHeadSharedWithOtherBranch()).toBe(false);
		});

		it("returns true when another branch contains HEAD", async () => {
			mockExecFileSuccess(
				"refs/heads/feature\nrefs/remotes/origin/release/1.0\n",
			); // for-each-ref
			mockExecFileSuccess("feature\n"); // getCurrentBranch
			mockExecFileSuccess("origin/feature\n"); // @{upstream}

			const bridge = makeBridge();
			expect(await bridge.isHeadSharedWithOtherBranch()).toBe(true);
		});

		it("returns false when no ref contains HEAD", async () => {
			mockExecFileSuccess("\n"); // for-each-ref → empty (no branch/upstream lookups)

			const bridge = makeBridge();
			expect(await bridge.isHeadSharedWithOtherBranch()).toBe(false);
		});

		it("ignores the current branch when it has no upstream", async () => {
			mockExecFileSuccess("refs/heads/feature\n"); // for-each-ref → only current branch
			mockExecFileSuccess("feature\n"); // getCurrentBranch
			mockExecFileError("no upstream"); // @{upstream} fails → no upstream ref

			const bridge = makeBridge();
			expect(await bridge.isHeadSharedWithOtherBranch()).toBe(false);
		});

		it("ignores the current branch's pushed copy even without tracking (push without -u)", async () => {
			// `git push origin feature` (no -u): origin/feature contains HEAD but
			// @{upstream} is unset — the origin/<branch> fallback must exclude it.
			mockExecFileSuccess("refs/heads/feature\nrefs/remotes/origin/feature\n"); // for-each-ref
			mockExecFileSuccess("feature\n"); // getCurrentBranch
			mockExecFileError("no upstream"); // @{upstream} fails (no tracking)

			const bridge = makeBridge();
			expect(await bridge.isHeadSharedWithOtherBranch()).toBe(false);
		});

		it("treats a detached HEAD reachable from a branch as shared", async () => {
			mockExecFileSuccess("refs/heads/main\n"); // for-each-ref → main contains HEAD
			mockExecFileSuccess("HEAD\n"); // getCurrentBranch → detached
			mockExecFileError("no upstream"); // @{upstream} fails

			const bridge = makeBridge();
			// No current-branch ref to exclude → main counts as another branch.
			expect(await bridge.isHeadSharedWithOtherBranch()).toBe(true);
		});
	});

	// ── generateSquashMessage ────────────────────────────────────────────

	describe("generateSquashMessage()", () => {
		it("collects commit messages and calls mergeCommitMessages", async () => {
			// git log for hash1
			mockExecFileSuccess("fix: first change\n");
			// git log for hash2
			mockExecFileSuccess("fix: second change\n");
			mergeCommitMessages.mockReturnValue("fix: first change; second change");

			const bridge = makeBridge();
			const result = await bridge.generateSquashMessage(["hash1", "hash2"]);

			expect(result).toBe("fix: first change; second change");
			expect(mergeCommitMessages).toHaveBeenCalledWith([
				"fix: first change",
				"fix: second change",
			]);
		});

		it("skips empty messages", async () => {
			mockExecFileSuccess("fix: only change\n");
			mockExecFileSuccess("\n");
			mergeCommitMessages.mockReturnValue("fix: only change");

			const bridge = makeBridge();
			await bridge.generateSquashMessage(["hash1", "hash2"]);

			expect(mergeCommitMessages).toHaveBeenCalledWith(["fix: only change"]);
		});
	});

	// ── generateSquashMessageWithLLM ─────────────────────────────────────

	describe("generateSquashMessageWithLLM()", () => {
		it("calls generateSquashMessage from Summarizer with commit data", async () => {
			// git log for hash1
			mockExecFileSuccess("fix: first\n");
			getSummary.mockResolvedValueOnce({
				ticketId: "PROJ-100",
				topics: [{ title: "Topic A", trigger: "code change" }],
			});
			// git log for hash2
			mockExecFileSuccess("fix: second\n");
			getSummary.mockResolvedValueOnce(null);
			// rev-list --count (total branch commits)
			mockExecFileSuccess("2\n");
			generateSquashMessage.mockResolvedValue(
				"Fixes PROJ-100: first and second",
			);

			const bridge = makeBridge();
			const result = await bridge.generateSquashMessageWithLLM([
				"hash1",
				"hash2",
			]);

			expect(result).toBe("Fixes PROJ-100: first and second");
			expect(generateSquashMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					ticketId: "PROJ-100",
					isFullSquash: true,
					config: { apiKey: "test-key", model: "claude-3" },
				}),
			);
		});

		it("falls back to string-merge when no API key is configured", async () => {
			loadGlobalConfig.mockResolvedValue({ apiKey: "", model: "claude-3" });
			// git log for hash1
			mockExecFileSuccess("fix: fallback\n");
			mergeCommitMessages.mockReturnValue("fix: fallback");

			const bridge = makeBridge();
			const result = await bridge.generateSquashMessageWithLLM(["hash1"]);

			expect(result).toBe("fix: fallback");
			expect(generateSquashMessage).not.toHaveBeenCalled();
		});

		it("uses the LLM path for the Local Agent provider without any API key", async () => {
			// Local Agent generates through the agent tool's own login — a key-only
			// gate would silently drop the LLM squash path. resolveLlmCredentialSource
			// honors the choice, so generateSquashMessage must still be called.
			loadGlobalConfig.mockResolvedValue({ aiProvider: "local-agent", model: "claude-3" });
			// git log for hash1
			mockExecFileSuccess("fix: local agent\n");
			getSummary.mockResolvedValueOnce(null);
			// rev-list --count
			mockExecFileSuccess("1\n");
			generateSquashMessage.mockResolvedValue("squashed via local agent");

			const bridge = makeBridge();
			const result = await bridge.generateSquashMessageWithLLM(["hash1"]);

			expect(result).toBe("squashed via local agent");
			expect(generateSquashMessage).toHaveBeenCalled();
		});

		it("uses (no message) fallback when commit message is empty", async () => {
			// git log for hash1 returns empty message
			mockExecFileSuccess("\n");
			getSummary.mockResolvedValueOnce(null);
			// rev-list --count
			mockExecFileSuccess("1\n");
			generateSquashMessage.mockResolvedValue("squashed");

			const bridge = makeBridge();
			await bridge.generateSquashMessageWithLLM(["hash1"]);

			// The commits array should contain "(no message)" for the empty msg
			expect(generateSquashMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					commits: [expect.objectContaining({ message: "(no message)" })],
				}),
			);
		});

		it("falls back to string-merge when LLM call fails", async () => {
			// git log for hash1
			mockExecFileSuccess("fix: llm fail\n");
			getSummary.mockResolvedValueOnce(null);
			// rev-list --count
			mockExecFileSuccess("1\n");
			generateSquashMessage.mockRejectedValue(new Error("API error"));
			// Fallback: git log for hash1 again
			mockExecFileSuccess("fix: llm fail\n");
			mergeCommitMessages.mockReturnValue("fix: llm fail");

			const bridge = makeBridge();
			const result = await bridge.generateSquashMessageWithLLM(["hash1"]);

			expect(result).toBe("fix: llm fail");
		});

		it("falls back to string-merge when LLM rejects with a non-Error value", async () => {
			mockExecFileSuccess("fix: string fail\n");
			getSummary.mockResolvedValueOnce(null);
			mockExecFileSuccess("1\n");
			generateSquashMessage.mockRejectedValue("plain failure");
			mockExecFileSuccess("fix: string fail\n");
			mergeCommitMessages.mockReturnValue("fix: string fail");

			const bridge = makeBridge();
			const result = await bridge.generateSquashMessageWithLLM(["hash1"]);

			expect(result).toBe("fix: string fail");
			expect(warn).toHaveBeenCalledWith(
				"bridge",
				"LLM squash message failed, falling back: plain failure",
			);
		});
	});

	// ── squashCommits ────────────────────────────────────────────────────

	describe("squashCommits()", () => {
		it("resets to fork point, commits, and returns new hash", async () => {
			// getHEADHash (head before squash)
			mockExecFileSuccess("headBefore\n");
			// rev-parse oldest^ (fork point)
			mockExecFileSuccess("forkPoint\n");
			// git reset --soft forkPoint
			mockExecFileSuccess("");
			// git commit -m
			mockExecFileSuccess("");
			// getHEADHash (new hash)
			mockExecFileSuccess("newSquashHash\n");

			const bridge = makeBridge();
			const hash = await bridge.squashCommits(
				["oldest", "newest"],
				"squash message",
			);

			expect(savePluginSource).toHaveBeenCalledWith(TEST_CWD);
			expect(saveSquashPending).toHaveBeenCalledWith(
				["oldest", "newest"],
				"forkPoint",
				TEST_CWD,
			);
			expect(hash).toBe("newSquashHash");
		});

		it("handles empty hashes and still completes the squash flow", async () => {
			mockExecFileSuccess("headBefore\n");
			mockExecFileSuccess("forkPoint\n");
			mockExecFileSuccess("");
			mockExecFileSuccess("");
			mockExecFileSuccess("newSquashHash\n");

			const bridge = makeBridge();
			const hash = await bridge.squashCommits([], "squash message");

			expect(hash).toBe("newSquashHash");
			expect(saveSquashPending).toHaveBeenCalledWith([], "forkPoint", TEST_CWD);
		});

		it("omits -s on the squash commit when dcoSignoff is false (default)", async () => {
			mockExecFileSuccess("headBefore\n");
			mockExecFileSuccess("forkPoint\n");
			mockExecFileSuccess(""); // reset --soft
			mockExecFileSuccess(""); // commit
			mockExecFileSuccess("newSquashHash\n");

			await makeBridge().squashCommits(["oldest", "newest"], "msg");

			const commitArgs = execFileMock.mock
				.calls[3]?.[1] as ReadonlyArray<string>;
			expect(commitArgs).toEqual(["commit", "-m", "msg"]);
		});

		it("inserts -s into the squash commit args when dcoSignoff is true", async () => {
			loadConfig.mockResolvedValue({ dcoSignoff: true });
			mockExecFileSuccess("headBefore\n");
			mockExecFileSuccess("forkPoint\n");
			mockExecFileSuccess(""); // reset --soft
			mockExecFileSuccess(""); // commit
			mockExecFileSuccess("newSquashHash\n");

			await makeBridge().squashCommits(["oldest", "newest"], "msg");

			const commitArgs = execFileMock.mock
				.calls[3]?.[1] as ReadonlyArray<string>;
			expect(commitArgs).toEqual(["commit", "-s", "-m", "msg"]);
		});
	});

	// ── squashAndPush ────────────────────────────────────────────────────

	describe("squashAndPush()", () => {
		it("squashes then force pushes", async () => {
			// squashCommits calls (5 execFile calls)
			mockExecFileSuccess("headBefore\n");
			mockExecFileSuccess("forkPoint\n");
			mockExecFileSuccess("");
			mockExecFileSuccess("");
			mockExecFileSuccess("newHash\n");
			// execPush: getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// execPush: rev-parse @{upstream}
			mockExecFileSuccess("origin/feature/test\n");
			// execPush: git push --force-with-lease
			mockExecFileSuccess("");

			const bridge = makeBridge();
			const hash = await bridge.squashAndPush(
				["oldest", "newest"],
				"squash msg",
			);

			expect(hash).toBe("newHash");
		});
	});

	// ── pushCurrentBranch / forcePush ────────────────────────────────────

	describe("pushCurrentBranch()", () => {
		it("pushes with -u origin when no upstream is set", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/new\n");
			// rev-parse @{upstream} — fails (no upstream), tryExecGit returns ""
			mockExecFileError("no upstream");
			// upstreamRef is empty → else branch → git push -u origin feature/new
			mockExecFileSuccess("");

			const bridge = makeBridge();
			await bridge.pushCurrentBranch();

			expect(execFileMock).toHaveBeenLastCalledWith(
				"git",
				["push", "-u", "origin", "feature/new"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("pushes with -u origin when upstream tracks a different branch", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// rev-parse @{upstream} → "origin/main" → remoteBranch = "main" != "feature/test"
			mockExecFileSuccess("origin/main\n");
			// git push -u origin feature/test
			mockExecFileSuccess("");

			const bridge = makeBridge();
			await bridge.pushCurrentBranch();

			expect(execFileMock).toHaveBeenLastCalledWith(
				"git",
				["push", "-u", "origin", "feature/test"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("pushes normally when upstream tracks same-named branch", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// rev-parse @{upstream} → "origin/feature/test" → remoteBranch = "feature/test" matches branch
			mockExecFileSuccess("origin/feature/test\n");
			// git push (normal, no -u)
			mockExecFileSuccess("");

			const bridge = makeBridge();
			await bridge.pushCurrentBranch();

			expect(execFileMock).toHaveBeenLastCalledWith(
				"git",
				["push"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});
	});

	describe("forcePush()", () => {
		it("pushes with --force-with-lease", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// rev-parse @{upstream} → "origin/feature/test" → remoteBranch matches
			mockExecFileSuccess("origin/feature/test\n");
			// git push --force-with-lease
			mockExecFileSuccess("");

			const bridge = makeBridge();
			await bridge.forcePush();

			expect(execFileMock).toHaveBeenLastCalledWith(
				"git",
				["push", "--force-with-lease"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});
	});

	// ── listSummaries / getSummary ───────────────────────────────────────

	describe("createReadStorage (mode selection)", () => {
		// The bridge's read-storage selector picks FolderStorage in
		// dual-write mode only when the folder is BOTH initialized
		// (index.json exists) AND clean (`shadow-status.json` absent).
		// `DualWriteStorage.writeFiles` marks the folder dirty on any
		// shadow write failure, so a dirty marker indicates the folder
		// view is stale relative to the orphan branch. Falling back to
		// orphan in that state mirrors the existing folder-empty fallback
		// (C2 in {@link createReadStorage}'s doc): trust orphan whenever
		// the folder isn't a complete, current picture.

		it("returns FolderStorage when folder has index AND is clean (baseline)", async () => {
			listSummaries.mockResolvedValue([]);
			const bridge = makeBridge();

			await bridge.listSummaries(10);

			expect(listSummaries).toHaveBeenCalledTimes(1);
			const storageArg = listSummaries.mock.calls[0][2];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("falls back to OrphanBranchStorage when folder is dirty (shadow write failed)", async () => {
			// Without this fallback the bridge would still hand FolderStorage
			// to getSummary / listSummaries / regenerate context after a
			// shadow write failure — surfacing stale or missing memories
			// while the orphan branch holds the fresh authoritative copy.
			mockFolderIsDirty.mockReturnValue(true);
			listSummaries.mockResolvedValue([]);
			const bridge = makeBridge();

			await bridge.listSummaries(10);

			const storageArg = listSummaries.mock.calls[0][2];
			expect(storageArg).not.toBeInstanceOf(MockFolderStorage);
		});

		it("still falls back to orphan when folder lacks index, regardless of dirty marker", async () => {
			// The two fallback signals are independent and either is
			// sufficient. Lock the C2 (no-index) path's existing behavior
			// in place so future refactors that move the isDirty check
			// don't accidentally make the no-index path depend on cleanliness.
			mockFolderReadFile.mockResolvedValueOnce(null);
			mockFolderIsDirty.mockReturnValue(false);
			listSummaries.mockResolvedValue([]);
			const bridge = makeBridge();

			await bridge.listSummaries(10);

			const storageArg = listSummaries.mock.calls[0][2];
			expect(storageArg).not.toBeInstanceOf(MockFolderStorage);
		});
	});

	describe("listSummaries()", () => {
		it("fetches summary list entries then loads full summaries", async () => {
			listSummaries.mockResolvedValue([
				{ commitHash: "aaa" },
				{ commitHash: "bbb" },
			]);
			getSummary.mockResolvedValueOnce({ commitHash: "aaa", topics: [] });
			getSummary.mockResolvedValueOnce(null);

			const bridge = makeBridge();
			const summaries = await bridge.listSummaries(10);

			expect(listSummaries).toHaveBeenCalledWith(
				10,
				TEST_CWD,
				expect.anything(),
			);
			// Only non-null summaries are returned
			expect(summaries).toHaveLength(1);
			expect(summaries[0].commitHash).toBe("aaa");
		});
	});

	describe("getSummary()", () => {
		it("delegates to SummaryStore.getSummary", async () => {
			getSummary.mockResolvedValue({ commitHash: "abc", topics: [] });
			const bridge = makeBridge();

			const result = await bridge.getSummary("abc");

			expect(getSummary).toHaveBeenCalledWith(
				"abc",
				TEST_CWD,
				expect.anything(),
			);
			expect(result).toEqual({ commitHash: "abc", topics: [] });
		});

		it("returns null when summary is not found", async () => {
			getSummary.mockResolvedValue(null);
			const bridge = makeBridge();

			const result = await bridge.getSummary("nonexistent");

			expect(result).toBeNull();
		});
	});

	describe("getSummaryAnyRepo()", () => {
		// Counterpart to listSummaryEntries' multi-repo aggregation: the
		// Timeline view shows memories from every discovered repo, so the
		// detail-fetch path that runs on row-click must also walk every
		// repo. Without this, foreign-repo Timeline rows would surface a
		// "No summary found for commit XXX" toast even though the data
		// exists one folder over.

		it("fast-paths to current-repo storage when the summary lives there", async () => {
			const own = { commitHash: "aaa", topics: [] };
			getSummary.mockResolvedValueOnce(own);
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepo("aaa");

			expect(result).toEqual(own);
			// Discovery must not run when the fast path already returned a hit
			// — needlessly walking foreign FolderStorages on every click would
			// flood IO on users with many Memory Bank repos.
			expect(discoverRepos).not.toHaveBeenCalled();
		});

		it("falls back to a non-current repo's FolderStorage when the current repo lacks the summary", async () => {
			const foreign = { commitHash: "bbb", topics: [] };
			// 1st call (current repo, primary storage) → null.
			// 2nd call (foreign FolderStorage) → the summary.
			getSummary.mockResolvedValueOnce(null).mockResolvedValueOnce(foreign);
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/home-repo",
					repoName: "home-repo",
					dirName: "home-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/other-repo",
					repoName: "other-repo",
					dirName: "other-repo",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepo("bbb");

			expect(result).toEqual(foreign);
			// The foreign lookup must be wired through a FolderStorage instance
			// (NOT the bridge's primary storage), so the call shape on the
			// fallback path differs from the current-repo fast path.
			expect(getSummary).toHaveBeenLastCalledWith(
				"bbb",
				undefined,
				expect.anything(),
			);
		});

		it("returns null when no repo under the Memory Bank parent has the summary", async () => {
			getSummary.mockResolvedValue(null);
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/home-repo",
					repoName: "home-repo",
					dirName: "home-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/other-repo",
					repoName: "other-repo",
					dirName: "other-repo",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepo("zzz");

			expect(result).toBeNull();
		});

		it("swallows per-repo errors and keeps scanning the remaining repos", async () => {
			const foreign = { commitHash: "ccc", topics: [] };
			// Current: null. First foreign: throws. Second foreign: hit.
			// The loop must NOT abort on the throw — partial outages on one
			// FolderStorage shouldn't hide summaries that DO exist elsewhere.
			getSummary
				.mockResolvedValueOnce(null)
				.mockRejectedValueOnce(new Error("ENOENT: stat .jolli"))
				.mockResolvedValueOnce(foreign);
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/home",
					repoName: "home",
					dirName: "home",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/broken",
					repoName: "broken",
					dirName: "broken",
					remoteUrl: null,
					isCurrentRepo: false,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/healthy",
					repoName: "healthy",
					dirName: "healthy",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepo("ccc");

			expect(result).toEqual(foreign);
		});
	});

	describe("getSummaryAnyRepoWithSource()", () => {
		// Provenance variant of getSummaryAnyRepo. The panel uses this to
		// know whether a summary lived in the current workspace's primary
		// storage (sourceRepoName=null → safe to edit) or in a foreign repo
		// (sourceRepoName=<repo> → read-only, destructive commands blocked).
		// Without provenance the panel could load a foreign-origin summary
		// and then accept push/edit messages that write to the WRONG repo.

		it("returns sourceRepoName=null and sourceRemoteUrl=null when the summary lives in the current repo", async () => {
			const own = { commitHash: "aaa", topics: [] };
			getSummary.mockResolvedValueOnce(own);
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepoWithSource("aaa");

			expect(result.summary).toEqual(own);
			// null is the load-bearing signal here — non-null would silently
			// flip the panel to read-only even though the summary is local.
			expect(result.sourceRepoName).toBeNull();
			expect(result.sourceRemoteUrl).toBeNull();
			expect(discoverRepos).not.toHaveBeenCalled();
		});

		it("returns sourceRepoName and sourceRemoteUrl from the foreign DiscoveredRepo when the summary falls through", async () => {
			const foreign = { commitHash: "bbb", topics: [] };
			getSummary.mockResolvedValueOnce(null).mockResolvedValueOnce(foreign);
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/home-repo",
					repoName: "home-repo",
					dirName: "home-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/other-repo",
					repoName: "other-repo",
					dirName: "other-repo",
					// remoteUrl is the load-bearing field for the new PR-section
					// foreign path: the panel hands it to PrCommentService which
					// pins gh to `--repo <url>`. A regression that dropped this
					// field would silently fall back to querying the current
					// workspace's PR (data leak), so we pin the propagation here.
					remoteUrl: "https://github.com/other/repo.git",
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepoWithSource("bbb");

			expect(result.summary).toEqual(foreign);
			expect(result.sourceRepoName).toBe("other-repo");
			expect(result.sourceRemoteUrl).toBe("https://github.com/other/repo.git");
		});

		it("returns sourceRepoName=null and sourceRemoteUrl=null when no repo has the summary", async () => {
			getSummary.mockResolvedValue(null);
			discoverRepos.mockReturnValue([]);
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepoWithSource("zzz");

			expect(result.summary).toBeNull();
			expect(result.sourceRepoName).toBeNull();
			expect(result.sourceRemoteUrl).toBeNull();
		});

		it("returns nulls when discovery throws (covers outer-catch swallow)", async () => {
			// Provenance must degrade to "no answer" rather than bubble — the panel
			// invokes this on every commit click, and a thrown error would crash
			// the webview message loop. Force the outer-catch via discoverRepos.
			getSummary.mockResolvedValueOnce(null);
			discoverRepos.mockImplementationOnce(() => {
				throw new Error("kb parent unreadable");
			});
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepoWithSource("zzz");

			expect(result.summary).toBeNull();
			expect(result.sourceRepoName).toBeNull();
			expect(result.sourceRemoteUrl).toBeNull();
		});

		it("logs and continues when one foreign repo's getSummary throws (covers per-repo catch)", async () => {
			// Per-repo failures must not abort the scan — the loop continues so
			// the next repo can still hit. Mirrors how listSummaryEntries handles
			// a single broken FolderStorage shadow.
			const foreign = { commitHash: "xxx", topics: [] };
			getSummary
				.mockResolvedValueOnce(null) // current repo miss
				.mockRejectedValueOnce(new Error("broken shadow")) // foreign #1 throws
				.mockResolvedValueOnce(foreign); // foreign #2 hits
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/broken",
					repoName: "broken",
					dirName: "broken",
					remoteUrl: null,
					isCurrentRepo: false,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/good",
					repoName: "good",
					dirName: "good",
					remoteUrl: "https://github.com/good/repo.git",
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepoWithSource("xxx");

			expect(result.summary).toEqual(foreign);
			expect(result.sourceRepoName).toBe("good");
		});

		it("formats non-Error per-repo throws via String(err) (covers inner catch's String branch)", async () => {
			// Pin the bare-string-reject arm in the per-repo catch — same shape
			// as the Error variant above but exercises the String(err) fallback.
			const foreign = { commitHash: "yyy", topics: [] };
			getSummary
				.mockResolvedValueOnce(null)
				.mockRejectedValueOnce("bare-string-shadow")
				.mockResolvedValueOnce(foreign);
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/broken",
					repoName: "broken",
					dirName: "broken",
					remoteUrl: null,
					isCurrentRepo: false,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/good",
					repoName: "good",
					dirName: "good",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepoWithSource("yyy");

			expect(result.summary).toEqual(foreign);
		});

		it("formats non-Error outer-discovery throws via String(err) (covers outer catch's String branch)", async () => {
			getSummary.mockResolvedValueOnce(null);
			discoverRepos.mockImplementationOnce(() => {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw "bare-string outer";
			});
			const bridge = makeBridge();

			const result = await bridge.getSummaryAnyRepoWithSource("zzz");

			expect(result.summary).toBeNull();
		});
	});

	describe("createStorageForRepo()", () => {
		// Foreign-mode read-path enabler: SummaryWebviewPanel.show passes
		// `sourceRepoName` + `sourceRemoteUrl` back through this factory to
		// obtain a FolderStorage rooted at the foreign repo's `.jolli/`
		// directory. Without this every read in the panel (transcripts,
		// plans, notes) goes through `this.cwd`'s storage and returns empty
		// for cross-repo summaries — the symptom reported as "All
		// Conversations is empty when viewing another repo".

		it("returns FolderStorage + kbRoot for a foreign DiscoveredRepo matched by repoName", async () => {
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/cur",
					repoName: "cur",
					dirName: "cur",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/other",
					repoName: "other",
					dirName: "other",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.createStorageForRepo("other", null);

			expect(result).not.toBeNull();
			expect(result?.kbRoot).toBe("/mock/home/Documents/jolli/other");
			// MockFolderStorage records the rootPath it was constructed with —
			// proves the panel's reads will hit the foreign kbRoot, not cwd.
			expect((result?.storage as { rootPath: string }).rootPath).toBe(
				"/mock/home/Documents/jolli/other",
			);
		});

		it("prefers remoteUrl match over repoName when both have a remote", async () => {
			// Two foreign repos with the same repoName but different remotes —
			// folder renames can produce this; remoteUrl is the stable identity.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/a",
					repoName: "shared",
					dirName: "a",
					remoteUrl: "https://github.com/owner-a/shared.git",
					isCurrentRepo: false,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/b",
					repoName: "shared",
					dirName: "b",
					remoteUrl: "https://github.com/owner-b/shared.git",
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.createStorageForRepo(
				"shared",
				"https://github.com/owner-b/shared.git",
			);

			expect(result?.kbRoot).toBe("/mock/home/Documents/jolli/b");
		});

		it("matches a foreign repo when the caller's canonical remote differs only by .git from the raw local remote", async () => {
			// The bank keeps the raw git remote (`.git` suffix) while a shared-branch import
			// passes the backend's normalized form. A strict === missed this and dropped the
			// foreign display-only path into the sandbox; canonical comparison recovers it.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/foreign",
					repoName: "foreignrepo",
					dirName: "foreign",
					remoteUrl: "https://github.com/acme/foreign.git",
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.createStorageForRepo("acmeforeign", "https://github.com/acme/foreign");

			expect(result?.kbRoot).toBe("/mock/home/Documents/jolli/foreign");
		});

		it("returns null when no DiscoveredRepo matches (foreign entry has neither matching name nor remote)", async () => {
			// Two-repo scan covering both early-skip branches of the loop:
			// (1) the currentRepo continue and (2) the `!urlMatches &&
			// !nameMatches` continue for a foreign whose identity doesn't
			// match the requested target. Without the second entry the loop
			// short-circuits on `isCurrentRepo` and never exercises the
			// identity-comparison branch.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/cur",
					repoName: "cur",
					dirName: "cur",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/elsewhere",
					repoName: "elsewhere",
					dirName: "elsewhere",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.createStorageForRepo("missing", null);

			expect(result).toBeNull();
		});

		it("skips the currentRepo entry (factory is foreign-only)", async () => {
			// The factory exists to enable foreign-mode reads. Returning the
			// current repo's storage here would be a silent no-op against the
			// caller's intent (and could shadow a real foreign match later).
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/cur",
					repoName: "cur",
					dirName: "cur",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.createStorageForRepo("cur", null);

			expect(result).toBeNull();
		});

		it("returns null and does not throw when discovery itself errors", async () => {
			discoverRepos.mockImplementationOnce(() => {
				throw new Error("kb parent unreadable");
			});
			const bridge = makeBridge();

			const result = await bridge.createStorageForRepo("anything", null);

			expect(result).toBeNull();
		});
	});

	describe("createReadStorageForCurrentRepo()", () => {
		// Same FolderStorage factory as createStorageForRepo, but routes to
		// the CURRENT workspace's KB folder instead of a foreign one. The
		// SummaryWebviewPanel passes the result as `readStorage` for ALL
		// detail panels (local + foreign) so the visible "All Conversations
		// / plans / notes" data uniformly reads from the Memory Bank folder
		// layer rather than the dual-write primary (orphan branch). Without
		// this, local commits' detail panels would still read from the
		// orphan branch (DualWriteStorage.readFile delegates to primary),
		// diverging from how foreign-repo panels render.

		it("returns FolderStorage + kbRoot for the matching currentRepo entry", async () => {
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/cur",
					repoName: "cur",
					dirName: "cur",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/other",
					repoName: "other",
					dirName: "other",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.createReadStorageForCurrentRepo();

			expect(result).not.toBeNull();
			expect(result?.kbRoot).toBe("/mock/home/Documents/jolli/cur");
			expect((result?.storage as { rootPath: string }).rootPath).toBe(
				"/mock/home/Documents/jolli/cur",
			);
			// Identity fields: SharedBranchImporter verifies the current repo IS the
			// share's repo before writing into its bank.
			expect(result?.repoName).toBe("cur");
			expect(result?.remoteUrl).toBeNull();
		});

		it("returns null when no DiscoveredRepo is flagged isCurrentRepo", async () => {
			// Happens on a fresh repo whose KB folder hasn't been created
			// yet (no `.jolli/config.json` under any kbParent subfolder).
			// Caller must fall back to a null-storage code path rather than
			// silently reading from a foreign repo's storage.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/other",
					repoName: "other",
					dirName: "other",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.createReadStorageForCurrentRepo();

			expect(result).toBeNull();
		});

		it("returns null and does not throw when discovery itself errors", async () => {
			discoverRepos.mockImplementationOnce(() => {
				throw new Error("kb parent unreadable");
			});
			const bridge = makeBridge();

			const result = await bridge.createReadStorageForCurrentRepo();

			expect(result).toBeNull();
		});

		// orphan-only users have no folder shadow — reading from one would
		// surface stale leftovers or blanks. The webview must fall back to
		// the active StorageProvider (orphan branch) so transcripts / plans
		// / notes stay coherent with the system of record.
		it("returns null when storageMode is 'orphan' (no folder shadow)", async () => {
			loadConfig.mockResolvedValueOnce({ storageMode: "orphan" });
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/cur",
					repoName: "cur",
					dirName: "cur",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.createReadStorageForCurrentRepo();

			expect(result).toBeNull();
		});
	});

	// ── Git utility methods ──────────────────────────────────────────────

	describe("getCurrentUserName()", () => {
		it("returns the trimmed git user.name", async () => {
			mockExecFileSuccess("John Doe\n");
			const bridge = makeBridge();

			const name = await bridge.getCurrentUserName();

			expect(name).toBe("John Doe");
		});

		it("returns empty string when git config fails", async () => {
			mockExecFileError("config not set");
			const bridge = makeBridge();

			const name = await bridge.getCurrentUserName();

			expect(name).toBe("");
		});
	});

	describe("getCurrentBranch()", () => {
		it("returns the current branch name", async () => {
			mockExecFileSuccess("feature/my-branch\n");
			const bridge = makeBridge();

			const branch = await bridge.getCurrentBranch();

			expect(branch).toBe("feature/my-branch");
		});

		it("returns HEAD when rev-parse fails", async () => {
			mockExecFileError("not a git repo");
			const bridge = makeBridge();

			const branch = await bridge.getCurrentBranch();

			expect(branch).toBe("HEAD");
		});
	});

	describe("getHEADMessage()", () => {
		it("returns the trimmed HEAD commit message", async () => {
			mockExecFileSuccess("feat: latest change\n");
			const bridge = makeBridge();

			const msg = await bridge.getHEADMessage();

			expect(msg).toBe("feat: latest change");
		});
	});

	describe("getHEADHash()", () => {
		it("returns the trimmed HEAD hash", async () => {
			mockExecFileSuccess("abc123def456789\n");
			const bridge = makeBridge();

			const hash = await bridge.getHEADHash();

			expect(hash).toBe("abc123def456789");
		});

		it("throws when git rev-parse fails", async () => {
			mockExecFileError("not a git repo");
			const bridge = makeBridge();

			await expect(bridge.getHEADHash()).rejects.toThrow("not a git repo");
		});
	});

	describe("getStagedFilePaths()", () => {
		it("splits NUL-separated output and filters the trailing empty entry", async () => {
			// Real git -z output has a trailing NUL after every record, so the
			// mock includes it.
			mockExecFileSuccess("src/a.ts\0src/b.ts\0");
			const bridge = makeBridge();

			const paths = await bridge.getStagedFilePaths();

			expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["diff", "--cached", "-z", "--name-only"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("returns unicode paths verbatim (no octal quoting)", async () => {
			// Regression lock for the bundled fix: without `-z`, git
			// would emit `"fo\303\266.ts"` for this filename, which later breaks
			// the re-stage round-trip.
			mockExecFileSuccess("foö.ts\0");
			const bridge = makeBridge();

			const paths = await bridge.getStagedFilePaths();

			expect(paths).toEqual(["foö.ts"]);
		});

		it("returns an empty array when no files are staged", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			const paths = await bridge.getStagedFilePaths();

			expect(paths).toEqual([]);
		});
	});

	describe("index helpers", () => {
		it("restoreIndexTree reads the tree back into the index", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.restoreIndexTree("tree123");

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["read-tree", "tree123"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});

		it("resetIndex performs a mixed reset", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.resetIndex();

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["reset"],
				{ cwd: TEST_CWD, encoding: "utf8", windowsHide: true },
				expect.any(Function),
			);
		});
	});

	// ── Plans ────────────────────────────────────────────────────────────

	describe("listPlans()", () => {
		it("delegates to detectPlans", async () => {
			const plans: Array<unknown> = [{ slug: "test-plan", title: "Test" }];
			detectPlans.mockResolvedValue(plans);
			const bridge = makeBridge();

			const result = await bridge.listPlans();

			expect(detectPlans).toHaveBeenCalledWith(TEST_CWD);
			expect(result).toEqual(plans);
		});
	});

	describe("removePlan()", () => {
		it("delegates to removePlan", async () => {
			removePlan.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.removePlan("test-slug");

			expect(removePlan).toHaveBeenCalledWith("test-slug", TEST_CWD);
		});
	});

	describe("cleanupVisiblePlanArtifact()", () => {
		it("passes the Bridge's storage instance through to deletePlanVisibleArtifact", async () => {
			// Reason: SummaryStore wrappers fall back to `new OrphanBranchStorage(cwd)`
			// when no storage is passed, which silently no-ops (no `deletePlanVisible`
			// method). The Bridge must thread its DualWriteStorage in so the visible
			// `<branch>/plan--<slug>.md` actually gets deleted.
			deletePlanVisibleArtifact.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.cleanupVisiblePlanArtifact("my-plan", "feature/x");

			expect(deletePlanVisibleArtifact).toHaveBeenCalledWith(
				"my-plan",
				"feature/x",
				TEST_CWD,
				expect.objectContaining({
					readFile: expect.any(Function),
					writeFiles: expect.any(Function),
				}),
			);
		});
	});

	// ── Notes ─────────────────────────────────────────────────────────────

	describe("listNotes()", () => {
		it("delegates to detectNotes", async () => {
			const notes = [{ id: "note-1", title: "Note 1" }];
			detectNotes.mockResolvedValue(notes);
			const bridge = makeBridge();

			const result = await bridge.listNotes();

			expect(detectNotes).toHaveBeenCalledWith(TEST_CWD);
			expect(result).toEqual(notes);
		});
	});

	describe("saveNote()", () => {
		it("delegates to saveNote with cwd", async () => {
			const noteInfo = { id: "new-note", title: "New Note" };
			saveNoteFn.mockResolvedValue(noteInfo);
			const bridge = makeBridge();

			const result = await bridge.saveNote(
				"note-id",
				"Title",
				"Content",
				"snippet",
			);

			expect(saveNoteFn).toHaveBeenCalledWith(
				"note-id",
				"Title",
				"Content",
				"snippet",
				TEST_CWD,
			);
			expect(result).toEqual(noteInfo);
		});
	});

	describe("removeNote()", () => {
		it("delegates to removeNote", async () => {
			removeNoteFn.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.removeNote("note-id");

			expect(removeNoteFn).toHaveBeenCalledWith("note-id", TEST_CWD);
		});
	});

	describe("cleanupVisibleNoteArtifact()", () => {
		it("passes the Bridge's storage instance through to deleteNoteVisibleArtifact", async () => {
			deleteNoteVisibleArtifact.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.cleanupVisibleNoteArtifact("note-42", "main");

			expect(deleteNoteVisibleArtifact).toHaveBeenCalledWith(
				"note-42",
				"main",
				TEST_CWD,
				expect.objectContaining({
					readFile: expect.any(Function),
					writeFiles: expect.any(Function),
				}),
			);
		});
	});

	// ── Storage-threaded writers ─────────────────────────────────────────
	// Every wrapper must forward the Bridge's DualWriteStorage as the trailing
	// `storage` arg — otherwise the underlying SummaryStore writer falls back
	// to `resolveStorage(undefined, cwd)` (= a fresh `OrphanBranchStorage`) and
	// the Memory Bank folder never gets the write.

	const storageShape = expect.objectContaining({
		readFile: expect.any(Function),
		writeFiles: expect.any(Function),
	});

	describe("storeSummary()", () => {
		it("forwards the Bridge's storage to SummaryStore.storeSummary and threads a FolderStorage readStorage in dual-write mode", async () => {
			// readStorage is the load-bearing protection against folder-only
			// peer-synced rows being silently dropped: SummaryStore.storeSummary
			// uses it to union the existing index/catalog base across both
			// backends before the dual-write rewrites them. Mock the call to
			// land both arguments so a regression that drops the 6th param
			// (or aliases it to the write storage) surfaces here.
			storeSummary.mockResolvedValue(undefined);
			const bridge = makeBridge();
			const summary = {
				version: 3,
				commitHash: "abc1",
				commitMessage: "test",
				commitDate: "2026-05-18T00:00:00Z",
				branch: "main",
				generatedAt: "2026-05-18T00:00:01Z",
			} as never;

			await bridge.storeSummary(summary, true);

			expect(storeSummary).toHaveBeenCalledWith(
				summary,
				TEST_CWD,
				true,
				undefined,
				storageShape,
				expect.any(MockFolderStorage),
			);
		});

		it("does not pass a FolderStorage readStorage in orphan-only mode", async () => {
			// Orphan-only users have no folder shadow to protect — readStorage
			// must be an OrphanBranchStorage (not a FolderStorage) so the union
			// path inside SummaryStore.storeSummary is a no-op against the same
			// backend. Pinning this protects the legacy mode from accidentally
			// reading the (empty) folder layout.
			loadConfig.mockResolvedValue({ storageMode: "orphan" });
			storeSummary.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.storeSummary({ commitHash: "abc1" } as never, true);

			const lastCall = storeSummary.mock.calls.at(-1);
			expect(lastCall?.[5]).toBeDefined();
			expect(lastCall?.[5]).not.toBeInstanceOf(MockFolderStorage);
		});
	});

	describe("regenerate methods route through read storage", () => {
		it("loadRegenerateContext hands a FolderStorage to RegenerateContext.loadRegenerateContext in dual-write mode", async () => {
			// `loadRegenerateContext` aggregates transcript / plan / note /
			// linear-issue counts that drive the confirm dialog. In dual-write
			// mode it must read via the folder shadow so that peer-synced
			// artifacts (e.g. transcripts persisted on another machine) surface
			// in the dialog. The previous wiring used `getStorage()` which is
			// a `DualWriteStorage` whose `readFile` is pinned to the orphan
			// primary, masking those rows.
			loadRegenerateContext.mockResolvedValue({
				entryCount: 0,
				sessionCount: 0,
				sources: [],
				humanTurns: 0,
				plansCount: 0,
				notesCount: 0,
				referenceCountsBySource: {},
			});
			const bridge = makeBridge();

			await bridge.loadRegenerateContext({ commitHash: "abc" } as never);

			expect(loadRegenerateContext).toHaveBeenCalledTimes(1);
			const [, , storageArg] = loadRegenerateContext.mock.calls[0];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("regenerateSummary hands a FolderStorage to Regenerator.regenerateSummary in dual-write mode", async () => {
			// Same rationale as `loadRegenerateContext`: the LLM input needs
			// transcripts/plans/notes/linear archives from the folder shadow
			// when those rows haven't reached the orphan branch yet — pulling
			// them via `getStorage()` (DualWriteStorage → primary) would feed
			// the LLM an empty or stale conversation.
			regenerateSummary.mockResolvedValue({ updated: {}, result: {} });
			const bridge = makeBridge();

			await bridge.regenerateSummary(
				{ commitHash: "abc" } as never,
				{} as never,
			);

			expect(regenerateSummary).toHaveBeenCalledTimes(1);
			const [, , , storageArg] = regenerateSummary.mock.calls[0];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});
	});

	describe("storePlans()", () => {
		it("forwards the Bridge's storage to SummaryStore.storePlans", async () => {
			storePlans.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.storePlans(
				[{ slug: "p1", content: "# Plan" }],
				"msg",
				"feature/x",
			);

			expect(storePlans).toHaveBeenCalledWith(
				[{ slug: "p1", content: "# Plan" }],
				"msg",
				TEST_CWD,
				"feature/x",
				storageShape,
			);
		});
	});

	describe("storeNotes()", () => {
		it("forwards the Bridge's storage to SummaryStore.storeNotes", async () => {
			storeNotes.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.storeNotes([{ id: "n1", content: "# Note" }], "msg");

			expect(storeNotes).toHaveBeenCalledWith(
				[{ id: "n1", content: "# Note" }],
				"msg",
				TEST_CWD,
				undefined,
				storageShape,
			);
		});
	});

	describe("saveTranscriptsBatch()", () => {
		it("forwards the Bridge's storage to SummaryStore.saveTranscriptsBatch", async () => {
			saveTranscriptsBatch.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.saveTranscriptsBatch([], ["hash1"]);

			expect(saveTranscriptsBatch).toHaveBeenCalledWith(
				[],
				["hash1"],
				TEST_CWD,
				storageShape,
			);
		});
	});

	describe("getSummaryIndexEntryMap()", () => {
		it("forwards the Bridge's storage to SummaryStore.getIndexEntryMap", async () => {
			const fakeMap = new Map();
			getIndexEntryMap.mockResolvedValue(fakeMap);
			const bridge = makeBridge();

			const result = await bridge.getSummaryIndexEntryMap();

			expect(result).toBe(fakeMap);
			// Read path uses FolderStorage (not DualWriteStorage); storage
			// identity is pinned in the "current-repo reads" describe below.
			expect(getIndexEntryMap).toHaveBeenCalledWith(TEST_CWD, expect.any(Object));
		});
	});

	describe("getTranscriptHashes()", () => {
		it("forwards the Bridge's storage to SummaryStore.getTranscriptHashes", async () => {
			const fakeSet = new Set(["hash1", "hash2"]);
			getTranscriptHashes.mockResolvedValue(fakeSet);
			const bridge = makeBridge();

			const result = await bridge.getTranscriptHashes();

			expect(result).toBe(fakeSet);
			expect(getTranscriptHashes).toHaveBeenCalledWith(TEST_CWD, storageShape);
		});
	});

	describe("readTranscript()", () => {
		it("forwards the Bridge's storage to SummaryStore.readTranscript", async () => {
			readTranscript.mockResolvedValue(null);
			const bridge = makeBridge();

			const result = await bridge.readTranscript("deadbeef");

			expect(result).toBeNull();
			expect(readTranscript).toHaveBeenCalledWith(
				"deadbeef",
				TEST_CWD,
				storageShape,
			);
		});
	});

	describe("readTranscriptsForCommits()", () => {
		it("forwards the Bridge's storage to SummaryStore.readTranscriptsForCommits", async () => {
			const fakeMap = new Map();
			readTranscriptsForCommits.mockResolvedValue(fakeMap);
			const bridge = makeBridge();

			const result = await bridge.readTranscriptsForCommits(["a", "b"]);

			expect(result).toBe(fakeMap);
			expect(readTranscriptsForCommits).toHaveBeenCalledWith(
				["a", "b"],
				TEST_CWD,
				storageShape,
			);
		});
	});

	describe("indexNeedsMigration()", () => {
		it("forwards the Bridge's storage to SummaryStore.indexNeedsMigration", async () => {
			indexNeedsMigration.mockResolvedValue(true);
			const bridge = makeBridge();

			const result = await bridge.indexNeedsMigration();

			expect(result).toBe(true);
			expect(indexNeedsMigration).toHaveBeenCalledWith(TEST_CWD, storageShape);
		});
	});

	describe("migrateIndexToV3()", () => {
		it("forwards the Bridge's storage to SummaryStore.migrateIndexToV3", async () => {
			migrateIndexToV3.mockResolvedValue({ migrated: 2, skipped: 1 });
			const bridge = makeBridge();

			const result = await bridge.migrateIndexToV3();

			expect(result).toEqual({ migrated: 2, skipped: 1 });
			expect(migrateIndexToV3).toHaveBeenCalledWith(TEST_CWD, storageShape);
		});
	});

	describe("archivePlanForCommit()", () => {
		it("forwards the Bridge's storage to PlanService.archivePlanForCommit", async () => {
			archivePlanForCommit.mockResolvedValue(null);
			const bridge = makeBridge();

			await bridge.archivePlanForCommit("plan-a", "deadbeef");

			expect(archivePlanForCommit).toHaveBeenCalledWith(
				"plan-a",
				"deadbeef",
				TEST_CWD,
				storageShape,
			);
		});
	});

	describe("archiveNoteForCommit()", () => {
		it("forwards the Bridge's storage to NoteService.archiveNoteForCommit", async () => {
			archiveNoteForCommit.mockResolvedValue(null);
			const bridge = makeBridge();

			await bridge.archiveNoteForCommit("note-1", "deadbeef");

			expect(archiveNoteForCommit).toHaveBeenCalledWith(
				"note-1",
				"deadbeef",
				TEST_CWD,
				storageShape,
			);
		});
	});

	// ── Multi-source references ──────────────────────────────────────────

	describe("Entity bridge methods", () => {
		it("listReferences() delegates to detectReferences", async () => {
			const { detectReferences } = await import("./core/ReferenceService.js");
			const entities = [
				{ kind: "reference", source: "jira", nativeId: "KAN-5" },
			];
			(detectReferences as ReturnType<typeof vi.fn>).mockResolvedValue(entities);
			const bridge = makeBridge();

			const result = await bridge.listReferences();

			expect(detectReferences).toHaveBeenCalledWith(TEST_CWD);
			expect(result).toEqual(entities);
		});

		it("removeReference() delegates to removeReference with mapKey", async () => {
			const { removeReference } = await import("./core/ReferenceService.js");
			(removeReference as ReturnType<typeof vi.fn>).mockResolvedValue(
				undefined,
			);
			const bridge = makeBridge();

			await bridge.removeReference("github:owner/repo#42");

			expect(removeReference).toHaveBeenCalledWith(
				TEST_CWD,
				"github:owner/repo#42",
			);
		});

		it("openReferenceInBrowser() delegates to openReferenceInBrowser impl", async () => {
			const { openReferenceInBrowser } = await import("./core/ReferenceService.js");
			(openReferenceInBrowser as ReturnType<typeof vi.fn>).mockResolvedValue(
				true,
			);
			const info = {
				kind: "reference",
				source: "linear",
				url: "https://linear.app/x/PROJ-1",
			} as unknown as Parameters<typeof bridge.openReferenceInBrowser>[0];
			const bridge = makeBridge();

			const result = await bridge.openReferenceInBrowser(info);

			expect(openReferenceInBrowser).toHaveBeenCalledWith(info);
			expect(result).toBe(true);
		});

		it("openReferenceMarkdown() delegates to openReferenceMarkdown impl", async () => {
			const { openReferenceMarkdown } = await import("./core/ReferenceService.js");
			(openReferenceMarkdown as ReturnType<typeof vi.fn>).mockResolvedValue(
				undefined,
			);
			const info = {
				kind: "reference",
				source: "notion",
				sourcePath: "/x.md",
			} as unknown as Parameters<typeof bridge.openReferenceMarkdown>[0];
			const bridge = makeBridge();

			await bridge.openReferenceMarkdown(info);

			expect(openReferenceMarkdown).toHaveBeenCalledWith(info);
		});

		it("previewReferenceMarkdown() delegates to previewReferenceMarkdown impl", async () => {
			const { previewReferenceMarkdown } = await import(
				"./core/ReferenceService.js"
			);
			(previewReferenceMarkdown as ReturnType<typeof vi.fn>).mockResolvedValue(
				undefined,
			);
			const info = {
				kind: "reference",
				source: "notion",
				sourcePath: "/x.md",
			} as unknown as Parameters<typeof bridge.previewReferenceMarkdown>[0];
			const bridge = makeBridge();

			await bridge.previewReferenceMarkdown(info);

			expect(previewReferenceMarkdown).toHaveBeenCalledWith(info);
		});
	});

	// ── listBranchCommits ────────────────────────────────────────────────

	describe("listBranchCommits()", () => {
		it("parses commits from git log output", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("headhash123\n");
			// merge-base
			mockExecFileSuccess("mergebase456\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: empty reflog → keep main merge-base
			mockExecFileSuccess("\n");
			// git log
			const logEntry = `commitHash1\x00fix: test change\x00John Doe\x00john@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);
			// resolvePushBaseRef: rev-parse @{upstream}
			mockExecFileSuccess("origin/feature/test\n");
			// refExists for upstream
			mockExecFileSuccess("def\n");
			// rev-list (unpushed)
			mockExecFileSuccess("commitHash1\n");

			getIndexEntryMap.mockResolvedValue(
				new Map([
					[
						"commitHash1",
						{
							commitHash: "commitHash1",
							parentCommitHash: null,
							commitType: "commit",
							commitMessage: "fix: test change",
							commitDate: "2025-03-15T10:00:00Z",
							branch: "feature/test",
							generatedAt: "2025-03-15T10:00:00Z",
							topicCount: 1,
							diffStats: { filesChanged: 2, insertions: 10, deletions: 3 },
						},
					],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.isMerged).toBe(false);
			expect(result.commits).toHaveLength(1);
			expect(result.commits[0].hash).toBe("commitHash1");
			expect(result.commits[0].message).toBe("fix: test change");
			expect(result.commits[0].author).toBe("John Doe");
			expect(result.commits[0].topicCount).toBe(1);
			expect(result.commits[0].insertions).toBe(10);
			expect(result.commits[0].deletions).toBe(3);
			expect(result.commits[0].filesChanged).toBe(2);
			expect(result.commits[0].isPushed).toBe(false);
			expect(result.commits[0].hasSummary).toBe(true);
		});

		it("returns empty result when merge-base fails", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolveHistoryBaseRef: refExists for origin/main fails
			mockExecFileError("not found");
			// refExists for upstream/main fails
			mockExecFileError("not found");
			// refExists for main fails
			mockExecFileError("not found");
			// getHEADHash
			mockExecFileSuccess("headhash\n");
			// merge-base fails
			mockExecFileError("no merge base");

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toEqual([]);
			expect(result.isMerged).toBe(false);
		});

		it("returns empty when log output is empty", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("headhash\n");
			// merge-base
			mockExecFileSuccess("mergebase\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: empty reflog → keep main merge-base
			mockExecFileSuccess("\n");
			// git log — empty
			mockExecFileSuccess("\n");

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toEqual([]);
			expect(result.isMerged).toBe(false);
		});

		it("excludes the base branch's commits for a fresh branch cut from a non-main base (release fork)", async () => {
			// hotfix/x cut from release/1.0 at E; HEAD is still E (zero own commits).
			mockExecFileSuccess("hotfix/x\n"); // getCurrentBranch
			mockExecFileSuccess("abc\n"); // resolveHistoryBaseRef → origin/main
			mockExecFileSuccess("E0000000\n"); // getHEADHash (HEAD = E)
			mockExecFileSuccess("C0000000\n"); // merge-base with main = C (≠ HEAD → not merged)
			mockExecFileSuccess("E0000000 branch: Created from release/1.0\n"); // reflog → creationPoint = E
			mockExecFileSuccess(""); // is-ancestor E HEAD → behind HEAD (P1 guard)
			mockExecFileSuccess(""); // is-ancestor C E → downstream → base = E
			mockExecFileSuccess("\n"); // git log E..E → empty (nothing of its own)

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			// D and E belong to release/1.0, not to hotfix/x.
			expect(result.commits).toEqual([]);
			expect(result.isMerged).toBe(false);
		});

		it("lists only the branch's own commits past the release fork point, not the base branch's", async () => {
			// hotfix/x cut from release/1.0 at E, with its own commit F on top.
			mockExecFileSuccess("hotfix/x\n"); // getCurrentBranch
			mockExecFileSuccess("abc\n"); // resolveHistoryBaseRef → origin/main
			mockExecFileSuccess("F0000000\n"); // getHEADHash (HEAD = F)
			mockExecFileSuccess("C0000000\n"); // merge-base with main = C
			mockExecFileSuccess("E0000000 branch: Created from release/1.0\n"); // reflog → creationPoint = E
			mockExecFileSuccess(""); // is-ancestor E HEAD → behind HEAD (P1 guard)
			mockExecFileSuccess(""); // is-ancestor C E → downstream → base = E
			const logEntry = `F0000000\x00fix: hotfix work\x00Me\x00me@example.com\x002026-06-20T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry); // git log E..HEAD → only F
			mockExecFileError("no upstream"); // resolvePushBaseRef @{upstream}
			mockExecFileError("no origin branch"); // refExists origin/hotfix/x
			getIndexEntryMap.mockResolvedValue(new Map());
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 1,
				insertions: 2,
				deletions: 0,
			});
			scanTreeHashAliases.mockResolvedValue(false);

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toHaveLength(1);
			expect(result.commits[0].hash).toBe("F0000000");
			// The git log range must start at the fork point E, not the main merge-base C.
			const logCall = execFileMock.mock.calls.find(
				(c) => Array.isArray(c[1]) && c[1].includes("E0000000..HEAD"),
			);
			expect(logCall).toBeDefined();
			// And it must NOT fall back to the main merge-base C (the old behavior
			// that would surface release/1.0's D and E).
			const usedMainBase = execFileMock.mock.calls.some(
				(c) => Array.isArray(c[1]) && c[1].includes("C0000000..HEAD"),
			);
			expect(usedMainBase).toBe(false);
		});

		it("returns local mainBranch when only the local fallback ref exists", async () => {
			mockExecFileSuccess("feature/test\n");
			mockExecFileError("origin missing");
			mockExecFileError("upstream missing");
			mockExecFileSuccess("mainhash\n");
			mockExecFileSuccess("headhash\n");
			mockExecFileSuccess("mergebase\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: empty reflog → keep main merge-base
			mockExecFileSuccess("\n");
			const logEntry = `commitHash1\x00feat: local fallback\x00User\x00user@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);
			mockExecFileError("no upstream");
			mockExecFileError("no origin branch");
			getIndexEntryMap.mockResolvedValue(new Map());
			// getDiffStats returns zeroes internally when git diff fails (e.g. no parent)
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 0,
				insertions: 0,
				deletions: 0,
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toHaveLength(1);
			expect(result.commits[0].filesChanged).toBe(0);
			expect(result.commits[0].insertions).toBe(0);
			expect(result.commits[0].deletions).toBe(0);
		});

		it("uses resolveMergedHistory 'Created from' entry as the base when branch is merged", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/merged\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash — returns same as merge-base (merged)
			mockExecFileSuccess("mergebase456\n");
			// merge-base — equals HEAD, triggers merged mode
			mockExecFileSuccess("mergebase456\n");
			// resolveMergedHistory: reflog has own commits + explicit "Created from"
			mockExecFileSuccess(
				"ccc333 commit: third commit\nbbb222 commit: second commit\naaa111 branch: Created from main\n",
			);
			// getCurrentUserName
			mockExecFileSuccess("John Doe\n");
			// git log (with --author filter)
			const logEntry = `commitHash1\x00fix: merged change\x00John Doe\x00john@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);

			getIndexEntryMap.mockResolvedValue(new Map());
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 1,
				insertions: 5,
				deletions: 0,
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.isMerged).toBe(true);
			expect(result.commits).toHaveLength(1);
			expect(result.commits[0].hash).toBe("commitHash1");
		});

		it("uses resolveMergedHistory oldest-entry base fallback when reflog has no 'Created from'", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/merged\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash — same as merge-base
			mockExecFileSuccess("mergebase456\n");
			// merge-base
			mockExecFileSuccess("mergebase456\n");
			// resolveMergedHistory: own commits but no "Created from" → base = oldest entry
			mockExecFileSuccess(
				"ccc333 commit: third\nbbb222 commit: second\naaa111 commit: first\n",
			);
			// getCurrentUserName
			mockExecFileSuccess("Jane Doe\n");
			// git log
			const logEntry = `commitHash2\x00feat: fallback\x00Jane Doe\x00jane@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);

			getIndexEntryMap.mockResolvedValue(new Map());
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 1,
				insertions: 2,
				deletions: 0,
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.isMerged).toBe(true);
			expect(result.commits).toHaveLength(1);
			// Base must be the oldest reflog entry (aaa111), not a guessed merge-base.
			const logCall = execFileMock.mock.calls.find(
				(c) => Array.isArray(c[1]) && c[1].includes("aaa111..HEAD"),
			);
			expect(logCall).toBeDefined();
		});

		it("treats an amend-only merged branch as having own work (the 'amend when no commit' case)", async () => {
			// A branch whose only own work is an amended commit: the reflog op is
			// `commit (amend):`, never a plain `commit:`. hasOwnCommit must still be
			// true (the `\b` after "commit" matches the "(amend)" variant), so the
			// merged history is listed rather than emptied.
			mockExecFileSuccess("feature/amended\n"); // getCurrentBranch
			mockExecFileSuccess("abc\n"); // resolveHistoryBaseRef → origin/main
			mockExecFileSuccess("mergebase456\n"); // getHEADHash
			mockExecFileSuccess("mergebase456\n"); // merge-base == HEAD → merged mode
			// resolveMergedHistory: amend + initial ops, explicit "Created from"
			mockExecFileSuccess(
				"ddd444 commit (amend): reworded\n" +
					"ccc333 commit (initial): first\n" +
					"aaa111 branch: Created from main\n",
			);
			mockExecFileSuccess("Amy Mender\n"); // getCurrentUserName
			const logEntry = `commitHash9\x00fix: amended change\x00Amy Mender\x00amy@example.com\x002026-06-23T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry); // git log --author

			getIndexEntryMap.mockResolvedValue(new Map());
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 1,
				insertions: 3,
				deletions: 1,
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.isMerged).toBe(true);
			expect(result.commits).toHaveLength(1);
			expect(result.commits[0].hash).toBe("commitHash9");
		});

		it("includes commitType when summary has non-'commit' type (e.g. amend, squash)", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("headhash123\n");
			// merge-base
			mockExecFileSuccess("mergebase456\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: empty reflog → keep main merge-base
			mockExecFileSuccess("\n");
			// git log
			const logEntry = `commitHash1\x00fix: amend\x00John Doe\x00john@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);
			// resolvePushBaseRef: rev-parse @{upstream}
			mockExecFileSuccess("origin/feature/test\n");
			// refExists for upstream
			mockExecFileSuccess("def\n");
			// rev-list (unpushed)
			mockExecFileSuccess("commitHash1\n");

			getIndexEntryMap.mockResolvedValue(
				new Map([
					[
						"commitHash1",
						{
							commitHash: "commitHash1",
							parentCommitHash: null,
							commitType: "amend",
							commitMessage: "fix: amend",
							commitDate: "2025-03-15T10:00:00Z",
							branch: "feature/test",
							generatedAt: "2025-03-15T10:00:00Z",
							topicCount: 0,
							diffStats: { filesChanged: 1, insertions: 1, deletions: 0 },
						},
					],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits[0].commitType).toBe("amend");
		});

		it("returns empty when getCurrentUserName returns empty in merged mode", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/merged\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash — same as merge-base
			mockExecFileSuccess("mergebase456\n");
			// merge-base
			mockExecFileSuccess("mergebase456\n");
			// resolveMergedHistory: reflog has an own commit → has own work, so it
			// proceeds to getCurrentUserName (rather than short-circuiting empty).
			mockExecFileSuccess(
				"bbb222 commit: own work\naaa111 branch: Created from main\n",
			);
			// getCurrentUserName — returns empty string (git config not set)
			mockExecFileError("no user.name set");

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toEqual([]);
			expect(result.isMerged).toBe(false);
		});

		it("returns empty when resolveMergedHistory gets empty reflog (merged branch)", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/merged\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash — same as merge-base
			mockExecFileSuccess("mergebase456\n");
			// merge-base
			mockExecFileSuccess("mergebase456\n");
			// resolveMergedHistory: empty reflog → undefined → empty panel
			mockExecFileError("no reflog");

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toEqual([]);
			expect(result.isMerged).toBe(false);
		});

		it("returns empty for a merged branch that never committed its own work (created-from-main + rebase sync)", async () => {
			// The #226 regression case: branch created from main, then `git rebase
			// main` after one of *your own* commits had merged into main. HEAD is now
			// main's tip (fully contained in main), the branch has zero own commits,
			// yet the rebased-in commit is authored by you. It must NOT be listed —
			// it belongs to main, not to this branch.
			// X0000000 / M0000000 are opaque sentinels (the test only cares that the
			// reflog has no `commit` op, not their hex-ness).
			mockExecFileSuccess("fix/synced-to-main\n"); // getCurrentBranch
			mockExecFileSuccess("abc\n"); // resolveHistoryBaseRef → origin/main
			mockExecFileSuccess("X0000000\n"); // getHEADHash (HEAD = X = origin/main tip)
			mockExecFileSuccess("X0000000\n"); // merge-base == HEAD → merged mode
			// resolveMergedHistory: reflog has only creation + rebase, no `commit:` op.
			mockExecFileSuccess(
				"X0000000 rebase (finish): refs/heads/fix/synced-to-main onto X0000000\n" +
					"M0000000 branch: Created from main\n",
			);

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			// No own commits → empty panel, and never reaches getCurrentUserName/log.
			expect(result.commits).toEqual([]);
			expect(result.isMerged).toBe(false);
		});

		it("returns empty for a merged detached HEAD (no branch reflog)", async () => {
			mockExecFileSuccess("HEAD\n"); // getCurrentBranch → detached
			mockExecFileSuccess("abc\n"); // resolveHistoryBaseRef → origin/main
			mockExecFileSuccess("deadbeef\n"); // getHEADHash
			mockExecFileSuccess("deadbeef\n"); // merge-base == HEAD → merged mode
			// resolveMergedHistory bails out for "HEAD" before any reflog read.

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toEqual([]);
			expect(result.isMerged).toBe(false);
		});

		it("fires scanTreeHashAliases and logs when aliases are found for unmatched commits", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("headhash123\n");
			// merge-base
			mockExecFileSuccess("mergebase456\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: empty reflog → keep main merge-base
			mockExecFileSuccess("\n");
			// git log — one commit
			const logEntry = `commitHash1\x00fix: test\x00John\x00john@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);
			// resolvePushBaseRef: rev-parse @{upstream}
			mockExecFileSuccess("origin/feature/test\n");
			// refExists for upstream
			mockExecFileSuccess("def\n");
			// rev-list (unpushed)
			mockExecFileSuccess("\n");

			// commitHash1 is NOT in indexEntryMap → it's an unmatched hash
			getIndexEntryMap.mockResolvedValue(new Map());
			// scanTreeHashAliases returns true → triggers log.info
			scanTreeHashAliases.mockResolvedValue(true);

			// Fallback: getDiffStats for commits not in index
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 1,
				insertions: 1,
				deletions: 0,
			});

			const bridge = makeBridge();
			await bridge.listBranchCommits("main");

			// Wait for the fire-and-forget promise to resolve
			await vi.waitFor(() => {
				// (hashes, cwd, writeStorage, readStorage). 4-arg shape:
				// preflight reads via readStorage, lock-held re-read + alias
				// write use writeStorage. See JolliMemoryBridge.readStoragePromise.
				expect(scanTreeHashAliases).toHaveBeenCalledWith(
					["commitHash1"],
					TEST_CWD,
					expect.anything(),
					expect.anything(),
				);
				expect(info).toHaveBeenCalledWith(
					"commits",
					"Tree hash aliases found — panel refresh recommended",
				);
			});
		});

		it("resolvePushBaseRef uses origin/<branch> fallback when upstream ref does not resolve", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("headhash\n");
			// merge-base
			mockExecFileSuccess("mergebase\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: empty reflog → keep main merge-base
			mockExecFileSuccess("\n");
			// git log
			const logEntry = `commitHash1\x00feat: test\x00User\x00user@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);
			// resolvePushBaseRef: rev-parse @{upstream} returns a ref
			mockExecFileSuccess("origin/main\n");
			// refExists for that upstream ref — fails (stale)
			mockExecFileError("not found");
			// refExists for origin/feature/test — succeeds
			mockExecFileSuccess("def\n");
			// rev-list (unpushed) — commit is pushed
			mockExecFileSuccess("\n");

			getIndexEntryMap.mockResolvedValue(new Map());
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 1,
				insertions: 1,
				deletions: 0,
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toHaveLength(1);
			// Commit should be pushed (not in unpushed list)
			expect(result.commits[0].isPushed).toBe(true);
		});

		it("resolvePushBaseRef returns undefined when neither upstream nor origin/branch exists", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/new-branch\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("headhash\n");
			// merge-base
			mockExecFileSuccess("mergebase\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: empty reflog → keep main merge-base
			mockExecFileSuccess("\n");
			// git log
			const logEntry = `commitHash1\x00feat: new\x00Test User\x00test@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);
			// resolvePushBaseRef: rev-parse @{upstream} — fails
			mockExecFileError("no upstream");
			// refExists for origin/feature/new-branch — fails
			mockExecFileError("not found");

			getIndexEntryMap.mockResolvedValue(new Map());
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 1,
				insertions: 1,
				deletions: 0,
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			// All commits should be marked as not pushed (pushBaseRef is undefined → all unpushed)
			expect(result.commits).toHaveLength(1);
			expect(result.commits[0].isPushed).toBe(false);
		});
	});

	// ── getBranchPrStats / resolveBranchDeltaBase ────────────────────

	describe("getBranchPrStats()", () => {
		it("uses the plain merge-base for a branch cut directly from main", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/x\n");
			// resolveHistoryBaseRef → refExists origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash — differs from merge-base, so NOT merged mode
			mockExecFileSuccess("HEAD0000\n");
			// merge-base
			mockExecFileSuccess("BASE0000\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: no reflog entry
			mockExecFileSuccess("\n");
			// getDiffStats (mocked)
			getDiffStats.mockResolvedValueOnce({ insertions: 3, deletions: 1, filesChanged: 2 });
			// git diff --name-status
			mockExecFileSuccess("M\tsrc/foo.ts\nA\tsrc/bar.ts\n");

			const bridge = makeBridge();
			const result = await bridge.getBranchPrStats("main");

			expect(result.insertions).toBe(3);
			expect(result.deletions).toBe(1);
			expect(result.filesChanged).toBe(2);
			expect(result.files).toHaveLength(2);
			expect(result.files[0]).toEqual({ path: "src/foo.ts", dir: "src", status: "M" });
			expect(result.files[1]).toEqual({ path: "src/bar.ts", dir: "src", status: "A" });
		});

		it("uses the refined creation-point base for a branch cut from release/* (resolveOwnCommitsBase path)", async () => {
			// Scenario: hotfix/x cut from release/1.0 at commit E.
			// Plain merge-base with main = C; creation point = E (downstream of C).
			// resolveBranchDeltaBase should return E, not C.
			// getCurrentBranch
			mockExecFileSuccess("hotfix/x\n");
			// resolveHistoryBaseRef → refExists origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash (HEAD = F, a commit past E)
			mockExecFileSuccess("F0000000\n");
			// merge-base with main = C (≠ HEAD → not merged mode)
			mockExecFileSuccess("C0000000\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: explicit creation entry
			mockExecFileSuccess("E0000000 branch: Created from release/1.0\n");
			// isAncestor E HEAD → true (E is ancestor of F)
			mockExecFileSuccess("");
			// isAncestor C E → true (C is ancestor of E, i.e. E is downstream of C)
			mockExecFileSuccess("");
			// getDiffStats called with E0000000 as base
			getDiffStats.mockResolvedValueOnce({ insertions: 5, deletions: 2, filesChanged: 3 });
			// git diff --name-status from E
			mockExecFileSuccess("M\tsrc/hotfix.ts\n");

			const bridge = makeBridge();
			const result = await bridge.getBranchPrStats("main");

			// Verify getDiffStats was called with the refined base (E), not the coarse C
			expect(getDiffStats).toHaveBeenCalledWith("E0000000", "HEAD", expect.any(String));
			expect(result.insertions).toBe(5);
			expect(result.deletions).toBe(2);
			expect(result.filesChanged).toBe(3);
			expect(result.files).toHaveLength(1);
			expect(result.files[0].path).toBe("src/hotfix.ts");
		});

		it("returns zeros when no merge-base exists", async () => {
			// getCurrentBranch
			mockExecFileSuccess("orphan-branch\n");
			// resolveHistoryBaseRef → all refExists fail
			mockExecFileError("not found");
			mockExecFileError("not found");
			mockExecFileError("not found");
			// getHEADHash
			mockExecFileSuccess("HEAD0000\n");
			// merge-base fails (no common ancestor)
			mockExecFileError("no merge base");

			const bridge = makeBridge();
			const result = await bridge.getBranchPrStats("main");

			expect(result).toEqual({ insertions: 0, deletions: 0, filesChanged: 0, files: [] });
		});

		it("uses the creation point as base in merged mode when the branch has own commits", async () => {
			// Branch fully merged: plain merge-base equals HEAD.
			// resolveBranchDeltaBase routes through resolveMergedHistory; with an
			// own `commit` reflog op present (hasOwnCommit=true) it returns the
			// creation-point hash so the diffstat covers the branch's own work.
			// getCurrentBranch
			mockExecFileSuccess("feature/merged\n");
			// resolveHistoryBaseRef → refExists origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("HEAD1111\n");
			// merge-base === HEAD → merged mode
			mockExecFileSuccess("HEAD1111\n");
			// resolveMergedHistory reflog: creation entry (base) + an own `commit`
			// op (hasOwnCommit=true). Commit-line hash must be lowercase hex to
			// match the /^[0-9a-f]+ commit\b/ own-commit detector.
			mockExecFileSuccess(
				"create00 branch: Created from main\ndeadbeef commit: did real work\n",
			);
			// getDiffStats called with create00 as base
			getDiffStats.mockResolvedValueOnce({ insertions: 7, deletions: 3, filesChanged: 4 });
			// git diff --name-status
			mockExecFileSuccess("A\tsrc/new.ts\n");

			const bridge = makeBridge();
			const result = await bridge.getBranchPrStats("main");

			expect(getDiffStats).toHaveBeenCalledWith("create00", "HEAD", expect.any(String));
			expect(result.insertions).toBe(7);
		});

		it("returns zeros in merged mode for a sync-only branch with NO own commits (E1: matches empty memory list)", async () => {
			// A created-from-main + rebased branch (HEAD ⊆ main, no own `commit`
			// reflog op) must yield empty stats — same hasOwnCommit gate that
			// listBranchCommits applies — so PR-stats and the memory list agree.
			// getCurrentBranch
			mockExecFileSuccess("feature/sync\n");
			// resolveHistoryBaseRef → refExists origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("HEAD3333\n");
			// merge-base === HEAD → merged mode
			mockExecFileSuccess("HEAD3333\n");
			// resolveMergedHistory reflog: ONLY a creation entry + a rebase move,
			// no `commit` op → hasOwnCommit=false → resolveBranchDeltaBase undefined.
			mockExecFileSuccess(
				"create00 branch: Created from main\nHEAD3333 rebase (finish): returning to refs/heads/feature/sync\n",
			);

			const bridge = makeBridge();
			const result = await bridge.getBranchPrStats("main");

			expect(result).toEqual({ insertions: 0, deletions: 0, filesChanged: 0, files: [] });
		});

		it("returns zeros when in merged mode but the reflog is empty (creation point unavailable)", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/old\n");
			// resolveHistoryBaseRef → refExists origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("HEAD2222\n");
			// merge-base === HEAD → merged mode
			mockExecFileSuccess("HEAD2222\n");
			// resolveMergedHistory: empty reflog → returns undefined
			mockExecFileSuccess("\n");

			const bridge = makeBridge();
			const result = await bridge.getBranchPrStats("main");

			expect(result).toEqual({ insertions: 0, deletions: 0, filesChanged: 0, files: [] });
		});
	});

	// ── getBranchDiffBase / readFileAtRef ────────────────────────────

	describe("getBranchDiffBase()", () => {
		it("returns the refined delta base commit for a branch cut directly from main", async () => {
			// Same resolveBranchDeltaBase sequence as getBranchPrStats' first case,
			// but without the diffstat/name-status calls — this method only resolves
			// the base so the diff's left side matches the header counts.
			// getCurrentBranch
			mockExecFileSuccess("feature/x\n");
			// resolveHistoryBaseRef → refExists origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash (≠ merge-base → not merged mode)
			mockExecFileSuccess("HEAD0000\n");
			// merge-base
			mockExecFileSuccess("BASE0000\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: no reflog entry
			mockExecFileSuccess("\n");

			const bridge = makeBridge();
			expect(await bridge.getBranchDiffBase("main")).toBe("BASE0000");
		});

		it("returns undefined when no merge-base exists (nothing to diff)", async () => {
			// getCurrentBranch
			mockExecFileSuccess("orphan-branch\n");
			// resolveHistoryBaseRef → all refExists fail
			mockExecFileError("not found");
			mockExecFileError("not found");
			mockExecFileError("not found");
			// getHEADHash
			mockExecFileSuccess("HEAD0000\n");
			// merge-base fails (no common ancestor)
			mockExecFileError("no merge base");

			const bridge = makeBridge();
			expect(await bridge.getBranchDiffBase("main")).toBeUndefined();
		});
	});

	describe("readFileAtRef()", () => {
		it("returns the file's contents at the given ref via `git show <ref>:<path>`", async () => {
			mockExecFileSuccess("line1\nline2\n");
			const bridge = makeBridge();
			const content = await bridge.readFileAtRef("BASE0000", "src/foo.ts");
			expect(content).toBe("line1\nline2\n");
			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["show", "BASE0000:src/foo.ts"],
				expect.objectContaining({ maxBuffer: 16 * 1024 * 1024 }),
				expect.any(Function),
			);
		});

		it("returns an empty string when the path does not exist at the ref (added/deleted file)", async () => {
			mockExecFileError("fatal: path 'src/added.ts' does not exist in 'BASE0000'");
			const bridge = makeBridge();
			expect(await bridge.readFileAtRef("BASE0000", "src/added.ts")).toBe("");
		});
	});

	// ── listBranchMemories ──────────────────────────────────────────

	describe("listBranchMemories()", () => {
		function makeEntry(
			hash: string,
			date: string,
			msg: string,
			branch: string,
			parent?: string,
		) {
			return {
				commitHash: hash,
				commitDate: date,
				commitMessage: msg,
				branch,
				parentCommitHash: parent ?? null,
				topicCount: 1,
			};
		}

		it("dedupes commitAliases that point to the same head — alias from rebase-pick must not double-count", async () => {
			// Regression: getIndexEntryMap registers each entry under BOTH its
			// canonical commitHash and every alias from index.commitAliases.
			// A real-world observation: alias `8d8ac10f → c5801c12` (rebase-pick
			// produced the alias) made `map.values()` yield the c5801c12 entry
			// twice, so listBranchMemories returned [c5801c12, c5801c12, af74e2cb]
			// and the sidebar rendered three rows for two heads. Fix: dedup by
			// commitHash, mirroring listSummaryEntries.
			const head1 = makeEntry(
				"aaa",
				"2025-01-01T00:00:00Z",
				"First head",
				"main",
			);
			const head2 = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"Second head",
				"main",
			);
			// Simulate the Map shape returned by getIndexEntryMap when commitAliases
			// is present: an alias key `aliasaaa` points to the SAME entry object
			// as `aaa`. Both keys enumerate via `.values()`.
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", head1],
					["aliasaaa", head1], // alias for aaa
					["bbb", head2],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listBranchMemories("test-repo", "main");
			expect(result.map((e) => e.commitHash).sort()).toEqual(["aaa", "bbb"]);
			expect(result).toHaveLength(2);
		});

		it("returns only v4 Hoist heads (parent=null) on the named branch", async () => {
			// `aaa` is the live head (parent=null). `bbb` is a hoisted older
			// version (parent=aaa). Under v4 Hoist semantics the head surfaces;
			// `bbb` is internal history that lives inside aaa.children[].
			const head = makeEntry("aaa", "2025-01-01T00:00:00Z", "head", "main");
			const hoisted = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"hoisted older version",
				"main",
				"aaa",
			);
			const other = makeEntry(
				"ccc",
				"2025-01-03T00:00:00Z",
				"other branch",
				"feature",
			);
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", head],
					["bbb", hoisted],
					["ccc", other],
				]),
			);

			const bridge = makeBridge();
			// Pass the mocked currentRepoName ("test-repo") so listBranchMemories
			// routes through the workspace-storage branch — that path uses the
			// already-mocked getIndexEntryMap. Foreign routing goes through
			// discoverRepos (which is mocked to []), so foreign callers would
			// short-circuit before reaching the index.
			const result = await bridge.listBranchMemories("test-repo", "main");
			expect(result.map((e) => e.commitHash)).toEqual(["aaa"]);
		});

		it("returns [] when getIndexEntryMap rejects (covers outer try/catch swallow)", async () => {
			// Sidebar callers must never throw out of this method — a transient
			// storage failure should hide rows for that branch, not crash the
			// panel. Pins the catch arm that downgrades to []+log.
			getIndexEntryMap.mockRejectedValueOnce(new Error("storage offline"));

			const bridge = makeBridge();
			const result = await bridge.listBranchMemories("test-repo", "main");

			expect(result).toEqual([]);
		});

		it("formats non-Error getIndexEntryMap rejections via String(err) (covers entries catch's String branch)", async () => {
			// IO libs occasionally reject with bare strings or response objects;
			// the catch must still log and downgrade to [] instead of crashing.
			getIndexEntryMap.mockRejectedValueOnce("raw-string-error");

			const bridge = makeBridge();
			const result = await bridge.listBranchMemories("test-repo", "main");

			expect(result).toEqual([]);
		});

		it("returns [] when foreign repo resolution throws (covers foreign-discovery catch)", async () => {
			// Foreign-routed listBranchMemories has its own pre-storage try block
			// (loadConfig → discoverRepos). A discoverRepos failure must not bubble
			// into the panel; this test pins the warn+return branch.
			discoverRepos.mockImplementationOnce(() => {
				throw new Error("disk read failed");
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchMemories("foreign-repo", "main");

			expect(result).toEqual([]);
		});

		it("formats non-Error foreign-discovery throws via String(err) (covers foreign catch's String branch)", async () => {
			discoverRepos.mockImplementationOnce(() => {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw "bare-string foreign error";
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchMemories("foreign-repo", "main");

			expect(result).toEqual([]);
		});

		it("resolves foreign repo storage and returns its branch heads (covers foreign-storage construction)", async () => {
			// Foreign-routed listBranchMemories must instantiate a fresh
			// FolderStorage pointed at the discovered repo's kbRoot — without
			// this, multi-repo Memory Bank installs can never list heads from
			// a non-workspace repo. Pins the success-path lines that construct
			// MetadataManager + FolderStorage and zero out cwd.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/foreign-repo",
					repoName: "foreign-repo",
					dirName: "foreign-repo",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const head = makeEntry(
				"foreignhead",
				"2025-04-01T00:00:00Z",
				"foreign head",
				"main",
			);
			getIndexEntryMap.mockResolvedValueOnce(
				new Map([["foreignhead", head]]),
			);

			const bridge = makeBridge();
			const result = await bridge.listBranchMemories("foreign-repo", "main");

			expect(result.map((e) => e.commitHash)).toEqual(["foreignhead"]);
			// cwd must be cleared so getIndexEntryMap reads via the foreign
			// FolderStorage rather than the workspace's active storage.
			expect(getIndexEntryMap).toHaveBeenCalledWith(
				undefined,
				expect.any(MockFolderStorage),
			);
		});
	});

	// ── resolveCommitMeta (tested indirectly via listBranchCommits) ──────

	describe("resolveCommitMeta edge cases", () => {
		/** Sets up the common git mocks to reach the per-commit resolution logic with a single commit. */
		function setupSingleCommitMocks(): void {
			// getCurrentBranch
			mockExecFileSuccess("feature/test\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash
			mockExecFileSuccess("headhash\n");
			// merge-base
			mockExecFileSuccess("mergebase\n");
			// resolveOwnCommitsBase → findBranchCreationPoint: empty reflog → keep main merge-base
			mockExecFileSuccess("\n");
			// git log — one commit
			const logEntry = `commitHash1\x00feat: test\x00User\x00user@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);
			// resolvePushBaseRef: rev-parse @{upstream}
			mockExecFileSuccess("origin/feature/test\n");
			// refExists for upstream
			mockExecFileSuccess("def\n");
			// rev-list (unpushed)
			mockExecFileSuccess("commitHash1\n");
		}

		it("reads topicCount from entry when diffStats is present but topicCount is missing", async () => {
			setupSingleCommitMocks();
			// Entry has diffStats but no topicCount (should default to 0)
			getIndexEntryMap.mockResolvedValue(
				new Map([
					[
						"commitHash1",
						{
							commitHash: "commitHash1",
							parentCommitHash: null,
							commitMessage: "feat: test",
							commitDate: "2025-03-15T10:00:00Z",
							branch: "feature/test",
							generatedAt: "2025-03-15T10:00:00Z",
							diffStats: { filesChanged: 3, insertions: 20, deletions: 5 },
						},
					],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits[0].topicCount).toBe(0);
			expect(result.commits[0].filesChanged).toBe(3);
		});

		it("normalizes commitType 'commit' to undefined", async () => {
			setupSingleCommitMocks();
			getIndexEntryMap.mockResolvedValue(
				new Map([
					[
						"commitHash1",
						{
							commitHash: "commitHash1",
							parentCommitHash: null,
							commitType: "commit",
							commitMessage: "feat: test",
							commitDate: "2025-03-15T10:00:00Z",
							branch: "feature/test",
							generatedAt: "2025-03-15T10:00:00Z",
							diffStats: { filesChanged: 1, insertions: 1, deletions: 0 },
						},
					],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits[0].commitType).toBeUndefined();
		});

		it("falls back to getDiffStats when entry exists without diffStats", async () => {
			setupSingleCommitMocks();
			// Entry has topicCount but no diffStats (legacy entry)
			getIndexEntryMap.mockResolvedValue(
				new Map([
					[
						"commitHash1",
						{
							commitHash: "commitHash1",
							parentCommitHash: null,
							commitMessage: "feat: test",
							commitDate: "2025-03-15T10:00:00Z",
							branch: "feature/test",
							generatedAt: "2025-03-15T10:00:00Z",
							topicCount: 5,
						},
					],
				]),
			);
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 2,
				insertions: 8,
				deletions: 1,
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits[0].topicCount).toBe(5);
			expect(result.commits[0].filesChanged).toBe(2);
			expect(result.commits[0].insertions).toBe(8);
		});

		it("returns zeroes when entry is undefined and git diff has no parent", async () => {
			setupSingleCommitMocks();
			getIndexEntryMap.mockResolvedValue(new Map());
			// getDiffStats returns zeroes internally when git diff fails (e.g. first commit)
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 0,
				insertions: 0,
				deletions: 0,
			});

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits[0].topicCount).toBe(0);
			expect(result.commits[0].filesChanged).toBe(0);
			expect(result.commits[0].insertions).toBe(0);
			expect(result.commits[0].deletions).toBe(0);
		});
	});

	// ── generateSquashMessageWithLLM: rev-list count failure ─────────────

	describe("generateSquashMessageWithLLM() rev-list count failure", () => {
		it("falls back to hashes.length when rev-list --count fails", async () => {
			// git log for hash1
			mockExecFileSuccess("fix: count fail\n");
			getSummary.mockResolvedValueOnce(null);
			// rev-list --count fails (catch block at line 689)
			mockExecFileError("rev-list failed");
			generateSquashMessage.mockResolvedValue("Fixes: count fail");

			const bridge = makeBridge();
			const result = await bridge.generateSquashMessageWithLLM(["hash1"]);

			expect(result).toBe("Fixes: count fail");
			// isFullSquash should be true because hashes.length (1) >= totalBranchCommits (fallback 1)
			expect(generateSquashMessage).toHaveBeenCalledWith(
				expect.objectContaining({ isFullSquash: true }),
			);
		});

		it("falls back to hashes.length when trimming the count output throws", async () => {
			mockExecFileSuccess("fix: trim fail\n");
			getSummary.mockResolvedValueOnce(null);
			mockExecFileSuccessRaw({
				trim() {
					throw new Error("trim failed");
				},
			});
			generateSquashMessage.mockResolvedValue("Fixes: trim fail");

			const bridge = makeBridge();
			const result = await bridge.generateSquashMessageWithLLM(["hash1"]);

			expect(result).toBe("Fixes: trim fail");
			expect(generateSquashMessage).toHaveBeenCalledWith(
				expect.objectContaining({ isFullSquash: true }),
			);
		});
	});

	// ── saveIndexTree ────────────────────────────────────────────────────

	describe("saveIndexTree()", () => {
		it("returns tree SHA when no unmerged files", async () => {
			// diff --name-only --diff-filter=U returns empty (no unmerged)
			mockExecFileSuccess("");
			// write-tree returns the tree SHA
			mockExecFileSuccess("abc123def456\n");

			const bridge = makeBridge();
			const sha = await bridge.saveIndexTree();
			expect(sha).toBe("abc123def456");
		});

		it("stages unmerged files then returns tree SHA", async () => {
			// diff --name-only --diff-filter=U returns unmerged files
			mockExecFileSuccess("a.ts\nb.ts\n");
			// git add -- a.ts b.ts
			mockExecFileSuccess("");
			// write-tree returns the tree SHA
			mockExecFileSuccess("def789\n");

			const bridge = makeBridge();
			const sha = await bridge.saveIndexTree();
			expect(sha).toBe("def789");
		});
	});

	// ── getSummaryIndexEntryMap ─────────────────────────────────────────────

	describe("getSummaryIndexEntryMap()", () => {
		it("delegates to the SummaryStore primitive with the bridge's cwd + storage", async () => {
			// The Bridge guarantees this read is routed through its own
			// `DualWriteStorage`, so a re-mounted KB folder doesn't surface a
			// stale OrphanBranchStorage view to the SummaryWebviewPanel's
			// stale-commit guard. Verify the delegation goes through the
			// mocked primitive with both args.
			const sample = new Map([
				[
					"abc123",
					{
						commitHash: "abc123",
						commitDate: "2026-01-01T00:00:00Z",
						commitMessage: "m",
						parentCommitHash: null,
						branch: "main",
						topicCount: 1,
					},
				],
			]);
			getIndexEntryMap.mockResolvedValue(sample);
			const bridge = makeBridge();
			const result = await bridge.getSummaryIndexEntryMap();
			expect(result).toBe(sample);
			expect(getIndexEntryMap).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(Object),
			);
		});
	});

	// ── listSummaryEntries ──────────────────────────────────────────────────

	describe("listSummaryEntries()", () => {
		function makeEntry(
			hash: string,
			date: string,
			msg: string,
			branch: string,
			parent?: string,
		) {
			return {
				commitHash: hash,
				commitDate: date,
				commitMessage: msg,
				branch,
				parentCommitHash: parent ?? null,
				topicCount: 1,
			};
		}

		it("reads from getIndexEntryMap, deduplicates, and sorts by date descending", async () => {
			const e1 = makeEntry("aaa", "2025-01-01T00:00:00Z", "first", "main");
			const e2 = makeEntry("bbb", "2025-01-03T00:00:00Z", "third", "main");
			const e3 = makeEntry("ccc", "2025-01-02T00:00:00Z", "second", "dev");
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", e1],
					["bbb", e2],
					["ccc", e3],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			expect(getIndexEntryMap).toHaveBeenCalledWith(
				TEST_CWD,
				expect.anything(),
			);
			expect(result.entries.map((e) => e.commitHash)).toEqual([
				"bbb",
				"ccc",
				"aaa",
			]);
			expect(result.totalCount).toBe(3);
		});

		it("filters hoisted older versions out, surfacing only the head", async () => {
			// `aaa` is the live head (parent=null). `bbb` was hoisted into
			// aaa.children[] by squash/amend — it represents an older version
			// of the same commit. Display surfaces the head, hides bbb.
			const head = makeEntry("aaa", "2025-01-01T00:00:00Z", "head", "main");
			const hoisted = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"hoisted older version",
				"main",
				"aaa",
			);
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", head],
					["bbb", hoisted],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			// New semantics (v4 Hoist): heads only. `aaa` is the head, `bbb`
			// hides as internal history under aaa.children[].
			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].commitHash).toBe("aaa");
		});

		it("surfaces every parent=null head on a branch regardless of cross-branch parent pointers", async () => {
			// Two independent heads, one on each branch. The head test is
			// strictly per-entry (parentCommitHash == null), so branch labels
			// and stray cross-branch parent pointers don't change the result.
			const xHead = makeEntry(
				"aaa",
				"2025-01-01T00:00:00Z",
				"X head",
				"feature-x",
			);
			const yHead = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"Y head",
				"feature-y",
			);
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", xHead],
					["bbb", yHead],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			expect(result.entries.map((e) => e.commitHash).sort()).toEqual([
				"aaa",
				"bbb",
			]);
		});

		it("does NOT surface an entry whose parent is missing from the index (semantics change vs old leaf filter)", async () => {
			// Only the hoisted child remains; its head was dropped from the
			// index (corrupt/partial state). The old ChainLeafFilter treated
			// this as "dangling parent → root → leaf" and surfaced it. The
			// v4 Hoist head test is stricter: parentCommitHash has a non-null
			// value, so this is categorically not a head. Reflecting that
			// honestly is more useful than papering over corrupt state.
			const orphanedChild = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"orphan child",
				"main",
				"aaa",
			);
			getIndexEntryMap.mockResolvedValue(new Map([["bbb", orphanedChild]]));

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);
			expect(result.entries).toHaveLength(0);
		});

		it("deduplicates aliases with the same commitHash", async () => {
			const entry = makeEntry("aaa", "2025-01-01T00:00:00Z", "msg", "main");
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", entry],
					["alias-aaa", entry],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			expect(result.entries).toHaveLength(1);
		});

		it("uses cache on second call without re-reading getIndexEntryMap", async () => {
			const entry = makeEntry("aaa", "2025-01-01T00:00:00Z", "msg", "main");
			getIndexEntryMap.mockResolvedValue(new Map([["aaa", entry]]));

			const bridge = makeBridge();
			await bridge.listSummaryEntries(10);
			await bridge.listSummaryEntries(10);

			expect(getIndexEntryMap).toHaveBeenCalledTimes(1);
		});

		it("filters by commitMessage (case-insensitive)", async () => {
			const e1 = makeEntry(
				"aaa",
				"2025-01-01T00:00:00Z",
				"Fix Auth Bug",
				"main",
			);
			const e2 = makeEntry("bbb", "2025-01-02T00:00:00Z", "Add feature", "dev");
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", e1],
					["bbb", e2],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10, 0, "auth");

			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].commitHash).toBe("aaa");
			expect(result.totalCount).toBe(1);
		});

		it("filters by branch name (case-insensitive)", async () => {
			const e1 = makeEntry(
				"aaa",
				"2025-01-01T00:00:00Z",
				"msg1",
				"feature/PROJ-123",
			);
			const e2 = makeEntry("bbb", "2025-01-02T00:00:00Z", "msg2", "main");
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", e1],
					["bbb", e2],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10, 0, "proj");

			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].commitHash).toBe("aaa");
		});

		it("applies offset and count for pagination", async () => {
			const entries = [
				makeEntry("aaa", "2025-01-03T00:00:00Z", "a", "main"),
				makeEntry("bbb", "2025-01-02T00:00:00Z", "b", "main"),
				makeEntry("ccc", "2025-01-01T00:00:00Z", "c", "main"),
			];
			getIndexEntryMap.mockResolvedValue(
				new Map(entries.map((e) => [e.commitHash, e])),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(1, 1);

			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].commitHash).toBe("bbb");
			expect(result.totalCount).toBe(3);
		});

		it("returns empty entries when offset exceeds available entries", async () => {
			const entry = makeEntry("aaa", "2025-01-01T00:00:00Z", "msg", "main");
			getIndexEntryMap.mockResolvedValue(new Map([["aaa", entry]]));

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10, 100);

			expect(result.entries).toHaveLength(0);
			expect(result.totalCount).toBe(1);
		});

		// ── Multi-repo aggregation ───────────────────────────────────────────
		// listSummaryEntries discovers every repo under the Memory Bank parent
		// (mirroring IntelliJ's Memory Bank view) and merges their indexes so
		// the user sees memories from all projects, not just the workspace
		// they happen to have open.

		it("tags current-repo entries with the current repoName", async () => {
			extractRepoName.mockReturnValue("home-repo");
			const e = makeEntry("aaa", "2025-01-01T00:00:00Z", "msg", "main");
			getIndexEntryMap.mockResolvedValue(new Map([["aaa", e]]));

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			expect(result.entries[0]?.repoName).toBe("home-repo");
		});

		it("merges entries from every discovered repo and tags each with its repoName", async () => {
			extractRepoName.mockReturnValue("home-repo");
			// Current repo: entry "aaa"
			const ownEntry = makeEntry("aaa", "2025-01-01T00:00:00Z", "own", "main");
			getIndexEntryMap.mockResolvedValueOnce(new Map([["aaa", ownEntry]]));
			// Other repo: entry "bbb" — getIndexEntryMap is also called for the
			// foreign FolderStorage; the second mockResolvedValueOnce wires its
			// return value.
			const foreignEntry = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"foreign",
				"dev",
			);
			getIndexEntryMap.mockResolvedValueOnce(new Map([["bbb", foreignEntry]]));

			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/home-repo",
					repoName: "home-repo",
					dirName: "home-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/other-repo",
					repoName: "other-repo",
					dirName: "other-repo",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			const tagged = new Map(
				result.entries.map((e) => [e.commitHash, e.repoName]),
			);
			expect(tagged.get("aaa")).toBe("home-repo");
			expect(tagged.get("bbb")).toBe("other-repo");
			// Sorted newest-first across repos: bbb (Jan 2) before aaa (Jan 1).
			expect(result.entries.map((e) => e.commitHash)).toEqual(["bbb", "aaa"]);
		});

		it("filter matches against repoName, mirroring IntelliJ's search behaviour", async () => {
			extractRepoName.mockReturnValue("home-repo");
			// Current repo: a commit with no message/branch match for "marketing".
			getIndexEntryMap.mockResolvedValueOnce(
				new Map([
					[
						"aaa",
						makeEntry("aaa", "2025-01-01T00:00:00Z", "unrelated", "main"),
					],
				]),
			);
			// Foreign repo "marketing-site": message/branch don't mention it,
			// but the repoName itself does — IntelliJ surfaces this match.
			getIndexEntryMap.mockResolvedValueOnce(
				new Map([
					["bbb", makeEntry("bbb", "2025-01-02T00:00:00Z", "fix link", "main")],
				]),
			);
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/home-repo",
					repoName: "home-repo",
					dirName: "home-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/marketing-site",
					repoName: "marketing-site",
					dirName: "marketing-site",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10, 0, "marketing");

			expect(result.entries).toHaveLength(1);
			expect(result.entries[0]?.commitHash).toBe("bbb");
		});

		it("skips the current repo when iterating discovered repos to avoid double-counting", async () => {
			extractRepoName.mockReturnValue("home-repo");
			const entry = makeEntry("aaa", "2025-01-01T00:00:00Z", "msg", "main");
			getIndexEntryMap.mockResolvedValue(new Map([["aaa", entry]]));

			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/home-repo",
					repoName: "home-repo",
					dirName: "home-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			// getIndexEntryMap is called exactly once — for the current repo
			// via primary storage. The foreign-repo branch sees the
			// isCurrentRepo flag and skips before constructing a second
			// FolderStorage.
			expect(getIndexEntryMap).toHaveBeenCalledTimes(1);
			expect(result.entries).toHaveLength(1);
		});
	});

	// ── listSummaryEntries — error paths ────────────────────────────────────

	describe("listSummaryEntries() — error paths", () => {
		// Both the current-repo path and the foreign-repo loop wrap their
		// getIndexEntryMap calls in try/catch with `instanceof Error ?
		// .message : String(err)` log coercion. Without dedicated tests
		// these warn arms (and especially the String(err) fallback) sit
		// uncovered, and a future refactor that turns the log helper into
		// `.message` would crash on any non-Error rejection — IO libs are
		// notorious for throwing raw strings / response objects.

		it("logs and skips entries when current-repo getIndexEntryMap throws an Error", async () => {
			getIndexEntryMap.mockRejectedValueOnce(new Error("EACCES: orphan ref"));
			const bridge = makeBridge();

			const result = await bridge.listSummaryEntries(10);

			expect(result.entries).toEqual([]);
			expect(result.totalCount).toBe(0);
		});

		it("logs and skips entries when current-repo getIndexEntryMap throws a non-Error", async () => {
			getIndexEntryMap.mockRejectedValueOnce("raw-string-error");
			const bridge = makeBridge();

			const result = await bridge.listSummaryEntries(10);

			expect(result.entries).toEqual([]);
		});

		it("logs but keeps scanning siblings when a foreign-repo getIndexEntryMap throws", async () => {
			extractRepoName.mockReturnValue("home-repo");
			// Current repo loads cleanly.
			getIndexEntryMap.mockResolvedValueOnce(
				new Map([
					[
						"aaa",
						{
							commitHash: "aaa",
							commitDate: "2025-01-01T00:00:00Z",
							commitMessage: "own",
							branch: "main",
							parentCommitHash: null,
							topicCount: 1,
						},
					],
				]),
			);
			// First foreign repo throws Error → covers L1367 Error arm.
			getIndexEntryMap.mockRejectedValueOnce(new Error("foreign EACCES"));
			// Second foreign throws a string → covers L1370 String(err) arm.
			getIndexEntryMap.mockRejectedValueOnce("raw-foreign-string");
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/home-repo",
					repoName: "home-repo",
					dirName: "home-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/broken",
					repoName: "broken",
					dirName: "broken",
					remoteUrl: null,
					isCurrentRepo: false,
				},
				{
					kbRoot: "/mock/home/Documents/jolli/raw-throw",
					repoName: "raw-throw",
					dirName: "raw-throw",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.listSummaryEntries(10);

			// Current-repo entry survives even though both siblings failed.
			expect(result.entries.map((e) => e.commitHash)).toEqual(["aaa"]);
		});

		it("logs but degrades gracefully when discoverRepos itself throws", async () => {
			extractRepoName.mockReturnValue("home-repo");
			// Current repo loads cleanly so we can prove the outer catch is
			// what stops the foreign-loop, not a missing fast-path.
			getIndexEntryMap.mockResolvedValueOnce(
				new Map([
					[
						"aaa",
						{
							commitHash: "aaa",
							commitDate: "2025-01-01T00:00:00Z",
							commitMessage: "own",
							branch: "main",
							parentCommitHash: null,
							topicCount: 1,
						},
					],
				]),
			);
			discoverRepos.mockImplementation(() => {
				throw new Error("scandir broke");
			});
			const bridge = makeBridge();

			const result = await bridge.listSummaryEntries(10);

			expect(result.entries.map((e) => e.commitHash)).toEqual(["aaa"]);
		});

		it("filter against repoName tolerates entries with no repoName tag (falls back to '')", async () => {
			// Repeatable scenario: extractRepoName returns undefined on a
			// repo whose .git is detached / has no working tree label. The
			// merged entry then has `repoName: undefined`, and the filter's
			// `(e.repoName ?? "").toLowerCase().includes(...)` must coerce
			// without crashing. Pin the `?? ""` arm.
			extractRepoName.mockReturnValue(undefined);
			getIndexEntryMap.mockResolvedValueOnce(
				new Map([
					[
						"aaa",
						{
							commitHash: "aaa",
							commitDate: "2025-01-01T00:00:00Z",
							commitMessage: "irrelevant",
							branch: "main",
							parentCommitHash: null,
							topicCount: 1,
						},
					],
				]),
			);
			const bridge = makeBridge();

			const result = await bridge.listSummaryEntries(10, 0, "marketing");
			// No repoName, no message/branch match → filtered out, no crash.
			expect(result.entries).toEqual([]);
		});
	});

	// ── reloadStorage ───────────────────────────────────────────────────────

	describe("reloadStorage()", () => {
		it("is callable and clears the internal storage cache without throwing", async () => {
			// Settings-save callback invokes this after the user changes
			// `storageMode` or `localFolder` so subsequent reads hit the right
			// backend without a window reload. The method only nullifies a
			// private storagePromise — no observable return — so the test
			// asserts the contract that matters here: it doesn't throw and
			// follow-up operations against the bridge still work.
			const bridge = makeBridge();
			expect(() => bridge.reloadStorage()).not.toThrow();
			// Follow-up call must still resolve normally (no use-after-clear
			// crash from a half-reset state).
			getIndexEntryMap.mockResolvedValueOnce(new Map());
			const result = await bridge.listSummaryEntries(10);
			expect(result.entries).toEqual([]);
		});
	});

	// ── invalidateEntriesCache ──────────────────────────────────────────────

	describe("invalidateEntriesCache()", () => {
		it("forces re-read from getIndexEntryMap on next listSummaryEntries call", async () => {
			const entry = {
				commitHash: "aaa",
				commitDate: "2025-01-01T00:00:00Z",
				commitMessage: "msg",
				branch: "main",
				parentCommitHash: null,
				topicCount: 1,
			};
			getIndexEntryMap.mockResolvedValue(new Map([["aaa", entry]]));

			const bridge = makeBridge();
			await bridge.listSummaryEntries(10);
			expect(getIndexEntryMap).toHaveBeenCalledTimes(1);

			bridge.invalidateEntriesCache();
			await bridge.listSummaryEntries(10);
			expect(getIndexEntryMap).toHaveBeenCalledTimes(2);
		});
	});

	// ── isMemoryFileDivergedOnDisk ──────────────────────────────────────────

	describe("isMemoryFileDivergedOnDisk()", () => {
		// Drives the divergence banner, decoration provider, and revert command.
		// The bridge owns the cross-repo discovery walk (mirrors
		// getSummaryAnyRepoWithSource) and delegates the actual fingerprint
		// compare to FolderStorage.isUserEditedOnDisk on the matching kbRoot.

		it("returns true when the on-disk file diverges from the manifest fingerprint", async () => {
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			mockFindByPath.mockReturnValueOnce({
				fileId: "f1",
				path: "main/edited-abc12345.md",
				fingerprint: "old-fp",
			});
			// Storage's helper says "yes, sha256 differs" — bridge must forward.
			mockIsUserEditedOnDisk.mockReturnValueOnce(true);
			const bridge = makeBridge();

			const result = await bridge.isMemoryFileDivergedOnDisk(
				"/mock/home/Documents/jolli/test-repo/main/edited-abc12345.md",
			);

			expect(result).toBe(true);
			// relPath must be the kbRoot-relative portion; passing the absolute
			// path here would silently miss every manifest entry and flip the
			// whole subsystem to "never diverged".
			expect(mockFindByPath).toHaveBeenCalledWith("main/edited-abc12345.md");
			// The bridge MUST hand the manifest's fingerprint to the storage
			// helper — using `undefined` would short-circuit to false and the
			// divergence banner would never fire.
			expect(mockIsUserEditedOnDisk).toHaveBeenCalledWith(
				"/mock/home/Documents/jolli/test-repo/main/edited-abc12345.md",
				"old-fp",
			);
		});

		it("returns false when the on-disk file matches the manifest fingerprint", async () => {
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			mockFindByPath.mockReturnValueOnce({
				fileId: "f1",
				path: "main/clean-abc12345.md",
				fingerprint: "same-fp",
			});
			mockIsUserEditedOnDisk.mockReturnValueOnce(false);
			const bridge = makeBridge();

			const result = await bridge.isMemoryFileDivergedOnDisk(
				"/mock/home/Documents/jolli/test-repo/main/clean-abc12345.md",
			);

			expect(result).toBe(false);
		});

		it("returns false when absPath is not under any known kbRoot", async () => {
			// Decoration provider asks about every VS Code file URI it sees;
			// files outside the Memory Bank must never be flagged as diverged.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.isMemoryFileDivergedOnDisk(
				"/some/random/path/elsewhere.md",
			);

			expect(result).toBe(false);
			// Critical guard: we must never even attempt a manifest lookup
			// when the path falls outside every discovered kbRoot — doing so
			// would risk a relPath that begins with `..` slipping into the
			// manifest and matching the wrong entry.
			expect(mockFindByPath).not.toHaveBeenCalled();
			expect(mockIsUserEditedOnDisk).not.toHaveBeenCalled();
		});

		it("returns false when the manifest has no entry for the relative path (legacy / unknown file)", async () => {
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			mockFindByPath.mockReturnValueOnce(undefined);
			const bridge = makeBridge();

			const result = await bridge.isMemoryFileDivergedOnDisk(
				"/mock/home/Documents/jolli/test-repo/main/unknown-aaaaaaaa.md",
			);

			expect(result).toBe(false);
			expect(mockIsUserEditedOnDisk).not.toHaveBeenCalled();
		});

		it("swallows discovery errors and returns false (covers outer-catch)", async () => {
			// Decoration provider invokes this on every file URI it sees; a
			// thrown error would crash the VS Code window's file-decoration
			// pipeline. Force the outer-catch via discoverRepos throwing.
			discoverRepos.mockImplementationOnce(() => {
				throw new Error("kb parent unreadable");
			});
			const bridge = makeBridge();

			const result = await bridge.isMemoryFileDivergedOnDisk(
				"/mock/home/Documents/jolli/test-repo/main/edited-abc12345.md",
			);

			expect(result).toBe(false);
		});

		it("handles a kbRoot that already ends with the path separator", async () => {
			// Exercises the truthy branch of the `endsWith("/")` ternary so
			// neither half of the prefix-construction is dead code.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo/",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			mockFindByPath.mockReturnValueOnce({
				fileId: "f1",
				path: "main/edited-abc12345.md",
				fingerprint: "old-fp",
			});
			mockIsUserEditedOnDisk.mockReturnValueOnce(true);
			const bridge = makeBridge();

			const result = await bridge.isMemoryFileDivergedOnDisk(
				"/mock/home/Documents/jolli/test-repo/main/edited-abc12345.md",
			);

			expect(result).toBe(true);
		});

		it("converts Windows backslash absPaths to forward-slash relPaths for the manifest lookup", async () => {
			// Regression: on Windows, `vscode.TextEditor.document.uri.fsPath` is
			// backslash-separated, but FolderStorage writes manifest entries with
			// literal forward slashes (`${branchFolder}/${fileName}`). The bridge
			// must normalize separators before handing `relPath` to MetadataManager
			// or every Memory Bank file silently fails to flag as diverged — the
			// decoration badge, divergence toast, and revert menu all no-op.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "C:\\Users\\flyer\\Documents\\jolli\\test-repo",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			mockFindByPath.mockReturnValueOnce({
				fileId: "f1",
				path: "main/edited-abc12345.md",
				fingerprint: "old-fp",
			});
			mockIsUserEditedOnDisk.mockReturnValueOnce(true);
			const bridge = makeBridge();

			const result = await bridge.isMemoryFileDivergedOnDisk(
				"C:\\Users\\flyer\\Documents\\jolli\\test-repo\\main\\edited-abc12345.md",
			);

			expect(result).toBe(true);
			expect(mockFindByPath).toHaveBeenCalledWith("main/edited-abc12345.md");
		});

		it("preserves original casing in relPath so manifest entries with uppercase branch names still match", async () => {
			// Regression: deriving relPath from `normalizePathForCompare(absPath)`
			// would lowercase the branch name on darwin/win32 (both flagged
			// case-insensitive in PathUtils.normalizePathForCompare) and miss
			// manifest entries for branches like `Fix-Badge-Count`.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			mockFindByPath.mockReturnValueOnce({
				fileId: "f1",
				path: "Fix-Badge-Count/edited-abc12345.md",
				fingerprint: "old-fp",
			});
			mockIsUserEditedOnDisk.mockReturnValueOnce(true);
			const bridge = makeBridge();

			const result = await bridge.isMemoryFileDivergedOnDisk(
				"/mock/home/Documents/jolli/test-repo/Fix-Badge-Count/edited-abc12345.md",
			);

			expect(result).toBe(true);
			expect(mockFindByPath).toHaveBeenCalledWith(
				"Fix-Badge-Count/edited-abc12345.md",
			);
		});

		it("formats non-Error discovery throws via String(err) in the warning log", async () => {
			// `err instanceof Error ? err.message : String(err)` — the
			// String(err) branch is only hit when something non-Error is
			// thrown (e.g. a bare string in legacy code paths).
			discoverRepos.mockImplementationOnce(() => {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw "bare string error";
			});
			const bridge = makeBridge();

			const result = await bridge.isMemoryFileDivergedOnDisk(
				"/mock/home/Documents/jolli/test-repo/main/edited-abc12345.md",
			);

			expect(result).toBe(false);
		});
	});

	// ── resolveMemoryFile ───────────────────────────────────────────────────

	describe("resolveMemoryFile()", () => {
		// Used by the revert command to dispatch to the right regenerate helper
		// based on the manifest entry's `type`. Returns { folderStorage,
		// manifestEntry } on hit, null on any miss / error.

		it("returns the FolderStorage and manifest entry when the file is under a known kbRoot", async () => {
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			const entry = {
				fileId: "f1",
				path: "main/edited-abc12345.md",
				type: "commit",
				fingerprint: "old-fp",
				title: "Edited",
			};
			mockFindByPath.mockReturnValueOnce(entry);
			const bridge = makeBridge();

			const result = await bridge.resolveMemoryFile(
				"/mock/home/Documents/jolli/test-repo/main/edited-abc12345.md",
			);

			expect(result).not.toBeNull();
			expect(result?.manifestEntry).toBe(entry);
			expect(result?.folderStorage).toBeDefined();
			expect(mockFindByPath).toHaveBeenCalledWith("main/edited-abc12345.md");
		});

		it("returns null when absPath is not under any known kbRoot", async () => {
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.resolveMemoryFile(
				"/some/random/path/elsewhere.md",
			);

			expect(result).toBeNull();
			expect(mockFindByPath).not.toHaveBeenCalled();
		});

		it("returns null when the manifest has no entry for the relative path", async () => {
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			mockFindByPath.mockReturnValueOnce(undefined);
			const bridge = makeBridge();

			const result = await bridge.resolveMemoryFile(
				"/mock/home/Documents/jolli/test-repo/main/unknown-aaaaaaaa.md",
			);

			expect(result).toBeNull();
		});

		it("swallows discovery errors and returns null (covers outer-catch)", async () => {
			discoverRepos.mockImplementationOnce(() => {
				throw new Error("kb parent unreadable");
			});
			const bridge = makeBridge();

			const result = await bridge.resolveMemoryFile(
				"/mock/home/Documents/jolli/test-repo/main/edited-abc12345.md",
			);

			expect(result).toBeNull();
		});

		it("formats non-Error discovery throws via String(err) in the warning log", async () => {
			discoverRepos.mockImplementationOnce(() => {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw "bare string error";
			});
			const bridge = makeBridge();

			const result = await bridge.resolveMemoryFile(
				"/mock/home/Documents/jolli/test-repo/main/edited-abc12345.md",
			);

			expect(result).toBeNull();
		});

		it("handles a kbRoot that already ends with the path separator", async () => {
			// The bridge appends `sep` only when missing; this test exercises the
			// "already ends with sep" branch of the ternary at the top of the
			// repos loop.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/test-repo/",
					repoName: "test-repo",
					dirName: "test-repo",
					remoteUrl: null,
					isCurrentRepo: true,
				},
			]);
			mockFindByPath.mockReturnValueOnce({
				fileId: "f1",
				path: "main/edited-abc12345.md",
				type: "commit",
				fingerprint: "old-fp",
			});
			const bridge = makeBridge();

			const result = await bridge.resolveMemoryFile(
				"/mock/home/Documents/jolli/test-repo/main/edited-abc12345.md",
			);

			expect(result).not.toBeNull();
		});
	});

	// ── Current-repo read path (workspace-repo storage routing) ────────────
	//
	// Invariant: for `dual-write` (default) and `folder` storageMode, every
	// workspace-repo READ (Memories, Timeline, branch-memories, single-
	// summary, branch-history index lookup) flows through a FolderStorage
	// rooted at `<localFolder>/<repo>/`. Reading via `DualWriteStorage`
	// would silently miss any row written to the folder by anything other
	// than this device's local commits (Memory Bank sync, external
	// migration, sibling IDE on the same folder) because its `readFile`
	// is pinned to the orphan-branch primary.
	//
	// For `orphan` mode (no folder data on disk) reads stay on the orphan
	// branch — same path as 0.98 and earlier.
	//
	// For `dual-write` mode when folder has no index yet (fresh install
	// before migration, or folder wiped), reads fall back to orphan so
	// the panel keeps showing data instead of "no memories yet".
	describe("current-repo reads use FolderStorage (sync-visibility regression)", () => {
		it("listSummaryEntries hands a FolderStorage to getIndexEntryMap in dual-write mode (default)", async () => {
			getIndexEntryMap.mockResolvedValue(new Map());
			const bridge = makeBridge();

			await bridge.listSummaryEntries(10);

			expect(getIndexEntryMap).toHaveBeenCalled();
			// The storage argument is the load-bearing assertion: a
			// DualWriteStorage / OrphanBranchStorage would silently skip
			// sync-pulled rows because their reads come from the orphan
			// branch in the workspace repo, which sync never updates.
			const [, storageArg] = getIndexEntryMap.mock.calls[0];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("listSummaryEntries falls back to legacy storage in orphan mode (no folder data on disk)", async () => {
			loadConfig.mockResolvedValue({ storageMode: "orphan" });
			getIndexEntryMap.mockResolvedValue(new Map());
			const bridge = makeBridge();

			await bridge.listSummaryEntries(10);

			const [, storageArg] = getIndexEntryMap.mock.calls[0];
			// Orphan-only users never wrote folder data, so flipping their
			// reads to FolderStorage would return empty across the board.
			// Their behavior must stay unchanged.
			expect(storageArg).not.toBeInstanceOf(MockFolderStorage);
		});

		it("listSummaryEntries uses FolderStorage in folder-only storage mode", async () => {
			loadConfig.mockResolvedValue({ storageMode: "folder" });
			getIndexEntryMap.mockResolvedValue(new Map());
			const bridge = makeBridge();

			await bridge.listSummaryEntries(10);

			const [, storageArg] = getIndexEntryMap.mock.calls[0];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("getSummary hands a FolderStorage to SummaryStore.getSummary in dual-write mode", async () => {
			getSummary.mockResolvedValue({ commitHash: "abc", topics: [] });
			const bridge = makeBridge();

			await bridge.getSummary("abc");

			const [hashArg, , storageArg] = getSummary.mock.calls[0];
			expect(hashArg).toBe("abc");
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("getSummaryIndexEntryMap hands a FolderStorage to getIndexEntryMap in dual-write mode", async () => {
			getIndexEntryMap.mockResolvedValue(new Map());
			const bridge = makeBridge();

			await bridge.getSummaryIndexEntryMap();

			const [, storageArg] = getIndexEntryMap.mock.calls[0];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("listBranchCommits hands a FolderStorage to getIndexEntryMap (peer commits become hasSummary=true)", async () => {
			// Full pipeline so listBranchCommits runs to its index lookup.
			mockExecFileSuccess("feature/test\n"); // getCurrentBranch
			mockExecFileSuccess("abc\n"); // resolveHistoryBaseRef
			mockExecFileSuccess("headhash123\n"); // getHEADHash
			mockExecFileSuccess("mergebase456\n"); // merge-base
			mockExecFileSuccess("\n"); // resolveOwnCommitsBase → empty reflog → keep main merge-base
			const logEntry = `commitHash1\x00fix: test change\x00John Doe\x00john@example.com\x002025-03-15T10:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry); // git log
			mockExecFileSuccess("origin/feature/test\n"); // upstream rev-parse
			mockExecFileSuccess("def\n"); // refExists upstream
			mockExecFileSuccess("\n"); // rev-list unpushed (empty)
			getIndexEntryMap.mockResolvedValue(
				new Map([
					[
						"commitHash1",
						{
							commitHash: "commitHash1",
							parentCommitHash: null,
							commitType: "commit",
							commitMessage: "fix: test change",
							commitDate: "2025-03-15T10:00:00Z",
							branch: "feature/test",
							generatedAt: "2025-03-15T10:00:00Z",
							topicCount: 1,
							diffStats: { filesChanged: 2, insertions: 10, deletions: 3 },
						},
					],
				]),
			);
			const bridge = makeBridge();

			const result = await bridge.listBranchCommits("main");

			expect(result.commits[0].hasSummary).toBe(true);
			const [, storageArg] = getIndexEntryMap.mock.calls[0];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("listBranchCommits routes scanTreeHashAliases with (writeStorage, readStorage) so alias writes still dual-write", async () => {
			// Background alias scan: reads from the folder (so post-sync
			// peer commits don't get queued as 'unmatched' merely because
			// orphan is stale), writes through the bridge's DualWriteStorage
			// so the alias lands in both backends.
			mockExecFileSuccess("feature/test\n");
			mockExecFileSuccess("abc\n");
			mockExecFileSuccess("headhash123\n");
			mockExecFileSuccess("mergebase456\n");
			mockExecFileSuccess("\n"); // resolveOwnCommitsBase → empty reflog → keep main merge-base
			// Two commits in log; only one is in the index, so the other
			// becomes an unmatched candidate that triggers the scan.
			const logEntry =
				`matched\x00fix\x00A\x00a@x\x002025-03-15T10:00:00Z\x00\x00\n` +
				`unmatched\x00wip\x00A\x00a@x\x002025-03-15T11:00:00Z\x00\x00\n`;
			mockExecFileSuccess(logEntry);
			mockExecFileSuccess("origin/feature/test\n");
			mockExecFileSuccess("def\n");
			mockExecFileSuccess("\n");
			getIndexEntryMap.mockResolvedValue(
				new Map([
					[
						"matched",
						{
							commitHash: "matched",
							parentCommitHash: null,
							commitType: "commit",
							commitMessage: "fix",
							commitDate: "2025-03-15T10:00:00Z",
							branch: "feature/test",
							generatedAt: "2025-03-15T10:00:00Z",
							topicCount: 1,
							diffStats: { filesChanged: 1, insertions: 1, deletions: 0 },
						},
					],
				]),
			);
			// Unmatched falls through to git diff for stats — stub the
			// fallback so resolveCommitMeta doesn't choke.
			getDiffStats.mockResolvedValueOnce({
				filesChanged: 0,
				insertions: 0,
				deletions: 0,
			});
			scanTreeHashAliases.mockResolvedValue(false);
			const bridge = makeBridge();

			await bridge.listBranchCommits("main");

			// Wait one microtask flush for the fire-and-forget scan.
			await new Promise((resolve) => setImmediate(resolve));

			expect(scanTreeHashAliases).toHaveBeenCalledTimes(1);
			const [hashesArg, cwdArg, writeStorageArg, readStorageArg] =
				scanTreeHashAliases.mock.calls[0];
			expect(hashesArg).toEqual(["unmatched"]);
			expect(cwdArg).toBe(TEST_CWD);
			// Write path stays on DualWriteStorage so aliases land on both
			// backends — flipping this to FolderStorage would orphan the
			// alias from the orphan branch and break orphan-only readers.
			expect(writeStorageArg).not.toBeInstanceOf(MockFolderStorage);
			// Read path uses FolderStorage so the candidate set reflects
			// post-sync index state, not the stale workspace orphan branch.
			expect(readStorageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("falls back to OrphanBranchStorage in dual-write mode when folder lacks an index", async () => {
			// Folder has no index.json on disk: fresh install before
			// migration ran, or the user wiped the Memory Bank folder.
			// Routing reads through FolderStorage would render "no
			// memories" while the orphan branch still holds the user's
			// data. The fallback keeps the panel showing real data.
			mockFolderReadFile.mockResolvedValueOnce(null);
			getIndexEntryMap.mockResolvedValue(new Map());
			const bridge = makeBridge();

			await bridge.listSummaryEntries(10);

			const [, storageArg] = getIndexEntryMap.mock.calls[0];
			expect(storageArg).not.toBeInstanceOf(MockFolderStorage);
		});

		it("listSummaries hands a FolderStorage to SummaryStore.listSummaries in dual-write mode", async () => {
			listSummaries.mockResolvedValue([]);
			const bridge = makeBridge();

			await bridge.listSummaries(10);

			const [, , storageArg] = listSummaries.mock.calls[0];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("listBranchMemories hands a FolderStorage to getIndexEntryMap for the current repo", async () => {
			getIndexEntryMap.mockResolvedValue(new Map());
			const bridge = makeBridge();

			await bridge.listBranchMemories("test-repo", "main");

			const [, storageArg] = getIndexEntryMap.mock.calls[0];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("generateSquashMessageWithLLM reads summaries via FolderStorage in dual-write mode", async () => {
			// git log for hash1
			mockExecFileSuccess("fix: x\n");
			getSummary.mockResolvedValueOnce({ topics: [] });
			// rev-list --count
			mockExecFileSuccess("1\n");
			generateSquashMessage.mockResolvedValue("squashed");
			const bridge = makeBridge();

			await bridge.generateSquashMessageWithLLM(["hash1"]);

			// Without folder-routed reads, a row only present in the folder
			// (e.g. peer-synced) would surface here as `null` from getSummary
			// and silently lose its topics in the merged prompt.
			const [, , storageArg] = getSummary.mock.calls[0];
			expect(storageArg).toBeInstanceOf(MockFolderStorage);
		});

		it("createReadStorage defaults unknown storageMode values to OrphanBranchStorage (matches StorageFactory)", async () => {
			// A config typo or future-mode value (e.g. `duallwrite`) used to
			// land write on orphan (StorageFactory.default) but read on folder
			// (createReadStorage's `if mode==="orphan"` else folder). That
			// asymmetry made the panel show "no memories" while the orphan
			// branch silently received writes — a baffling failure mode. The
			// switch now matches StorageFactory's default → orphan, so both
			// sides agree on unknown modes.
			loadConfig.mockResolvedValue({ storageMode: "duallwrite-typo" });
			getIndexEntryMap.mockResolvedValue(new Map());
			const bridge = makeBridge();

			await bridge.listSummaryEntries(10);

			const [, storageArg] = getIndexEntryMap.mock.calls[0];
			expect(storageArg).not.toBeInstanceOf(MockFolderStorage);
		});

		it("reloadReadStorage() re-probes the dual-write folder-empty fallback so peer-synced rows become visible after refresh", async () => {
			// First read finds the folder empty (e.g. fresh install before
			// migration completed) and caches an OrphanBranchStorage fallback.
			// The user then triggers a peer sync that populates the folder,
			// and clicks the Memories refresh action — which calls both
			// `invalidateEntriesCache()` and `reloadReadStorage()`. The next
			// read must re-probe and switch to FolderStorage instead of
			// serving the cached fallback forever. The pairing mirrors
			// Extension.ts's `jollimemory.refreshMemories` handler.
			mockFolderReadFile.mockResolvedValueOnce(null);
			getIndexEntryMap.mockResolvedValue(new Map());
			const bridge = makeBridge();

			await bridge.listSummaryEntries(10);
			const [, firstStorageArg] = getIndexEntryMap.mock.calls[0];
			expect(firstStorageArg).not.toBeInstanceOf(MockFolderStorage);

			// Peer sync drops index.json into the folder; refresh button drops
			// both the aggregated entries cache and the readStorage cache so
			// the next read re-probes the fallback decision.
			mockFolderReadFile.mockResolvedValue('{"version":3,"entries":[]}');
			bridge.invalidateEntriesCache();
			bridge.reloadReadStorage();

			await bridge.listSummaryEntries(10);
			const lastCall = getIndexEntryMap.mock.calls.at(-1);
			expect(lastCall?.[1]).toBeInstanceOf(MockFolderStorage);
		});

		it("reloadReadStorage() keeps the write-storage cache hot (only readStorage is dropped)", async () => {
			// Refresh button should not churn the write-storage pipeline — only
			// the read-storage cache. Verifies the asymmetry between
			// `reloadStorage()` (drops both) and `reloadReadStorage()` (drops
			// only the read side) so a future bug that conflates them surfaces.
			storeSummary.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.storeSummary({ commitHash: "a" } as never, true);
			const firstWriteStorage = storeSummary.mock.calls[0][4];

			bridge.reloadReadStorage();

			await bridge.storeSummary({ commitHash: "b" } as never, true);
			const secondWriteStorage = storeSummary.mock.calls[1][4];
			expect(secondWriteStorage).toBe(firstWriteStorage);
		});

		it("reloadStorage() alone clears the entries cache so the next read re-resolves storage", async () => {
			// First read under dual-write picks FolderStorage.
			getIndexEntryMap.mockResolvedValue(new Map());
			const bridge = makeBridge();
			await bridge.listSummaryEntries(10);
			const [, firstStorageArg] = getIndexEntryMap.mock.calls[0];
			expect(firstStorageArg).toBeInstanceOf(MockFolderStorage);

			// Settings flips storageMode to orphan and calls reloadStorage()
			// only — NO manual invalidateEntriesCache(). That call alone
			// must be enough to make the next read re-resolve, otherwise
			// the entries-cache short-circuit silently keeps the old data
			// alive after a mode flip.
			loadConfig.mockResolvedValue({ storageMode: "orphan" });
			bridge.reloadStorage();

			await bridge.listSummaryEntries(10);
			const [, secondStorageArg] =
				getIndexEntryMap.mock.calls[getIndexEntryMap.mock.calls.length - 1];
			expect(secondStorageArg).not.toBeInstanceOf(MockFolderStorage);
		});

		it("rejected createReadStorage promise resets so the next read retries", async () => {
			// loadConfig itself never rejects in production (SessionTracker
			// swallows internally) — but the cache-reset guarantee matters
			// for any future helper that can throw mid-init (e.g. a
			// migration probe). Pin it now via a transient loadConfig
			// rejection so a regression in `.catch(() => { ... = null })`
			// would surface here as "second call also fails".
			//
			// Routed through getSummary (no internal catch) so the rejection
			// surfaces; listSummaryEntries swallows step-1 errors and would
			// mask whatever the cache state was.
			loadConfig.mockRejectedValueOnce(new Error("transient"));
			getSummary.mockResolvedValue({ commitHash: "abc", topics: [] });
			const bridge = makeBridge();

			await expect(bridge.getSummary("abc")).rejects.toThrow("transient");

			// Without the cache reset, this second call would await the
			// cached rejected promise and throw "transient" again — the
			// user would be permanently stuck on the transient error until
			// reloadStorage().
			await expect(bridge.getSummary("abc")).resolves.toEqual({
				commitHash: "abc",
				topics: [],
			});
		});
	});

	// ── Coverage-completion cases ─────────────────────────────────────────
	describe("coverage completion", () => {
		it("getDiscoveryCached serves a cached hit within the TTL (no second discoverRepos scan)", async () => {
			// Two calls on the same bridge within DISCOVERY_CACHE_TTL_MS must
			// reuse the cached {cfg, repos} — the second call returns from the
			// cache branch instead of re-running loadConfig + discoverRepos.
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/other",
					repoName: "other",
					dirName: "other",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			await bridge.createStorageForRepo("other", null);
			await bridge.createStorageForRepo("other", null);

			// Cache hit on the second call → discovery ran exactly once.
			expect(discoverRepos).toHaveBeenCalledTimes(1);
		});

		it("getStorage resets its cached promise and rethrows when createStorage rejects", async () => {
			// The write-storage factory (StorageFactory.createStorage) rejects
			// when KB path resolution throws. getStorage's `.catch` must null out
			// `storagePromise` and rethrow so the failure surfaces and a later
			// call can retry rather than await a permanently-rejected promise.
			// `createFolderStorage` (inside StorageFactory.createStorage) calls
			// the mocked `extractRepoName`; throwing there rejects createStorage.
			extractRepoName.mockImplementationOnce(() => {
				throw new Error("kb boom");
			});

			const bridge = makeBridge();
			await expect(bridge.indexNeedsMigration()).rejects.toThrow("kb boom");

			// Cache was reset → the next call retries with a healthy resolver.
			indexNeedsMigration.mockResolvedValueOnce(false);
			await expect(bridge.indexNeedsMigration()).resolves.toBe(false);
		});

		it("findBranchCreationPoint falls back to the oldest reflog entry when no explicit creation record exists (non-strict caller)", async () => {
			// The non-`requireExplicit` fallback: with no "branch: Created from"
			// entry, guess the oldest surviving reflog entry's hash.
			mockExecFileSuccess(
				"aaa1111 commit: recent work\nbbb2222 checkout: moving from main\nccc3333 reset: older move\n",
			);
			const bridge = makeBridge();
			// biome-ignore lint/suspicious/noExplicitAny: exercising a private method's non-strict fallback
			const result = await (bridge as any).findBranchCreationPoint("feature/x");
			expect(result).toBe("ccc3333");
		});

		it("inspectForcePushSafety wires execGit into the pure divergence probe", async () => {
			// getCurrentBranch → the ForcePushSafety helper runs fetch + two
			// rev-list --count via the injected `(args) => execGit(...)` runner.
			mockExecFileSuccess("feature/x\n"); // getCurrentBranch
			mockExecFileSuccess(""); // fetch origin feature/x
			mockExecFileSuccess("2\n"); // rev-list HEAD..origin/feature/x
			mockExecFileSuccess("0\n"); // rev-list origin/feature/x..HEAD

			const bridge = makeBridge();
			const result = await bridge.inspectForcePushSafety();

			expect(result).toEqual({
				branch: "feature/x",
				remoteOnly: 2,
				localOnly: 0,
				behindOnly: true,
			});
		});

		it("listBranchMemories returns [] when a foreign repo is not among the discovered repos", async () => {
			// Foreign route with a successful discovery that simply doesn't
			// contain the requested repo → `!target` guard returns [].
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/other",
					repoName: "other",
					dirName: "other",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.listBranchMemories("foreign-repo", "main");
			expect(result).toEqual([]);
		});

		it("listSummaryEntries filter evaluates the empty-string fallback for an entry with no repoName", async () => {
			// A discovered (foreign) repo whose repoName is undefined pushes
			// entries with `repoName: undefined`; a non-matching filter forces
			// evaluation of the `(e.repoName ?? "")` fallback arm.
			getIndexEntryMap.mockResolvedValueOnce(new Map()); // step 1: current repo empty
			getIndexEntryMap.mockResolvedValueOnce(
				new Map([
					[
						"aaa",
						{
							commitHash: "aaa",
							commitDate: "2025-01-01T00:00:00Z",
							commitMessage: "hello",
							branch: "main",
							parentCommitHash: null,
							topicCount: 1,
						},
					],
				]),
			);
			discoverRepos.mockReturnValue([
				{
					kbRoot: "/mock/home/Documents/jolli/x",
					// biome-ignore lint/suspicious/noExplicitAny: exercising the undefined-repoName fallback
					repoName: undefined as any,
					dirName: "x",
					remoteUrl: null,
					isCurrentRepo: false,
				},
			]);
			const bridge = makeBridge();

			const result = await bridge.listSummaryEntries(10, 0, "zzz");
			expect(result.entries).toEqual([]);
			expect(result.totalCount).toBe(0);
		});

		it("storeReferences resolves write storage and delegates to SummaryStore.storeReferences", async () => {
			storeReferences.mockResolvedValue(undefined);
			const bridge = makeBridge();

			const refs = [
				{
					archivedKey: "linear/ABC-1",
					source: "linear" as never,
					content: "# note",
				},
			];
			await bridge.storeReferences(refs, "commit message", "feature/x");

			expect(storeReferences).toHaveBeenCalledWith(
				refs,
				"commit message",
				TEST_CWD,
				"feature/x",
				expect.anything(),
			);
		});

		it("getCurrentUserEmail returns the trimmed git config value", async () => {
			mockExecFileSuccess("flyer@example.com\n");
			const bridge = makeBridge();

			const email = await bridge.getCurrentUserEmail();
			expect(email).toBe("flyer@example.com");
		});

		it("getBranchPrStats parses rename, CRLF and top-level rows from --name-status", async () => {
			// Drives parseDiffNameStatus through: a rename status ("R100" → "R",
			// picking parts[2] as the new path), CRLF line endings, and a
			// top-level file (no slash → empty dir).
			mockExecFileSuccess("feature/x\n"); // getCurrentBranch
			mockExecFileSuccess("abc\n"); // resolveHistoryBaseRef → refExists origin/main
			mockExecFileSuccess("HEAD0000\n"); // getHEADHash (≠ merge-base → not merged)
			mockExecFileSuccess("BASE0000\n"); // merge-base
			mockExecFileSuccess("\n"); // findBranchCreationPoint: no reflog
			getDiffStats.mockResolvedValueOnce({
				insertions: 1,
				deletions: 0,
				filesChanged: 2,
			});
			// name-status: rename (3 parts) with CRLF, plus a top-level add.
			mockExecFileSuccess("R100\tsrc/old.ts\tsrc/new.ts\r\nA\tREADME.md\r\n");

			const bridge = makeBridge();
			const result = await bridge.getBranchPrStats("main");

			expect(result.files).toEqual([
				// Rename retains the base-side path so the per-file diff opens correctly.
				{ path: "src/new.ts", dir: "src", status: "R", oldPath: "src/old.ts" },
				{ path: "README.md", dir: "", status: "A" },
			]);
		});
	});
});
