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

const { MockFolderStorage, MockMetadataManager } = vi.hoisted(() => ({
	MockFolderStorage: class {
		constructor(
			public readonly rootPath: string,
			public readonly mm: unknown,
		) {}
	},
	MockMetadataManager: class {
		constructor(public readonly dir: string) {}
	},
}));

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
	listSummaries,
	saveTranscriptsBatch,
	scanTreeHashAliases,
	storeLinearIssues,
	storeNotes,
	storePlans,
	storeSummary,
} = vi.hoisted(() => ({
	deleteNoteVisibleArtifact: vi.fn(),
	deletePlanVisibleArtifact: vi.fn(),
	getIndexEntryMap: vi.fn(),
	getSummary: vi.fn(),
	listSummaries: vi.fn(),
	saveTranscriptsBatch: vi.fn(),
	scanTreeHashAliases: vi.fn(),
	storeLinearIssues: vi.fn(),
	storeNotes: vi.fn(),
	storePlans: vi.fn(),
	storeSummary: vi.fn(),
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

const { archivePlanForCommit, detectPlans, ignorePlan } = vi.hoisted(() => ({
	archivePlanForCommit: vi.fn(),
	detectPlans: vi.fn(),
	ignorePlan: vi.fn(),
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

/**
 * Mock for node:child_process execFile.
 * promisify wraps this into a function returning Promise<{stdout, stderr}>.
 * The mock signature must match the callback-based execFile:
 *   execFile(cmd, args, options, callback)
 *
 * Uses an argument-matching approach: each stubbed response is keyed by a
 * matcher that inspects (cmd, args) so the order of concurrent calls
 * (e.g. inside Promise.all) does not matter.
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
	listSummaries,
	saveTranscriptsBatch,
	scanTreeHashAliases,
	storeLinearIssues,
	storeNotes,
	storePlans,
	storeSummary,
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
	ignorePlan,
}));

vi.mock("./core/NoteService.js", () => ({
	archiveNoteForCommit,
	detectNotes,
	saveNote: saveNoteFn,
	removeNote: removeNoteFn,
}));

vi.mock("./core/LinearIssueService.js", () => ({
	detectLinearIssues: vi.fn().mockResolvedValue([]),
	setLinearIssueIgnored: vi.fn().mockResolvedValue(undefined),
	openLinearIssueInBrowser: vi.fn().mockResolvedValue(true),
	openLinearIssueMarkdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./util/CommitMessageUtils.js", () => ({
	mergeCommitMessages,
}));

vi.mock("./util/Logger.js", () => ({
	log: { info, warn, error, debug },
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
		scanTreeHashAliases.mockResolvedValue(false);
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
			expect(installerGetStatus).toHaveBeenCalledWith(TEST_CWD);
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenNthCalledWith(
				2,
				"git",
				["rm", "--cached", "--ignore-unmatch", "--", "b.ts"],
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenNthCalledWith(
				2,
				"git",
				["rm", "--cached", "--ignore-unmatch", "--", "ignored-and-gone.ts"],
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--", "old.ts"],
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--", "old.ts"],
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
				expect.any(Function),
			);
			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["restore", "--", "unstaged.ts"],
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
				expect.any(Function),
			);
		});
	});

	// ── listSummaries / getSummary ───────────────────────────────────────

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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
				{ cwd: TEST_CWD, encoding: "utf8" },
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
		it("delegates to ignorePlan", async () => {
			ignorePlan.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.removePlan("test-slug");

			expect(ignorePlan).toHaveBeenCalledWith("test-slug", TEST_CWD);
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
		it("forwards the Bridge's storage to SummaryStore.storeSummary", async () => {
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
			);
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

	describe("storeLinearIssues()", () => {
		it("forwards the Bridge's storage to SummaryStore.storeLinearIssues", async () => {
			storeLinearIssues.mockResolvedValue(undefined);
			const bridge = makeBridge();

			await bridge.storeLinearIssues(
				[{ archivedKey: "PROJ-1-abcd1234", content: "# Issue" }],
				"msg",
			);

			expect(storeLinearIssues).toHaveBeenCalledWith(
				[{ archivedKey: "PROJ-1-abcd1234", content: "# Issue" }],
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

	// ── Linear issues ────────────────────────────────────────────────────

	describe("Linear issue bridge methods", () => {
		it("listLinearIssues() delegates to detectLinearIssues", async () => {
			const { detectLinearIssues } = await import(
				"./core/LinearIssueService.js"
			);
			const issues = [{ kind: "linearissue", ticketId: "PROJ-1" }];
			(detectLinearIssues as ReturnType<typeof vi.fn>).mockResolvedValue(
				issues,
			);
			const bridge = makeBridge();

			const result = await bridge.listLinearIssues();

			expect(detectLinearIssues).toHaveBeenCalledWith(TEST_CWD);
			expect(result).toEqual(issues);
		});

		it("ignoreLinearIssue() delegates to setLinearIssueIgnored with mapKey + true", async () => {
			const { setLinearIssueIgnored } = await import(
				"./core/LinearIssueService.js"
			);
			(setLinearIssueIgnored as ReturnType<typeof vi.fn>).mockResolvedValue(
				undefined,
			);
			const bridge = makeBridge();

			await bridge.ignoreLinearIssue("PROJ-1528");

			expect(setLinearIssueIgnored).toHaveBeenCalledWith(
				TEST_CWD,
				"PROJ-1528",
				true,
			);
		});

		it("openLinearIssue() delegates to openLinearIssueInBrowser", async () => {
			const { openLinearIssueInBrowser } = await import(
				"./core/LinearIssueService.js"
			);
			(openLinearIssueInBrowser as ReturnType<typeof vi.fn>).mockResolvedValue(
				true,
			);
			const info = {
				kind: "linearissue",
				url: "https://linear.app/x/PROJ-1",
			} as unknown as Parameters<typeof bridge.openLinearIssue>[0];
			const bridge = makeBridge();

			const result = await bridge.openLinearIssue(info);

			expect(openLinearIssueInBrowser).toHaveBeenCalledWith(info);
			expect(result).toBe(true);
		});

		it("openLinearIssueMarkdown() delegates to openLinearIssueMarkdown impl", async () => {
			const { openLinearIssueMarkdown } = await import(
				"./core/LinearIssueService.js"
			);
			(openLinearIssueMarkdown as ReturnType<typeof vi.fn>).mockResolvedValue(
				undefined,
			);
			const info = {
				kind: "linearissue",
				sourcePath: "/x.md",
			} as unknown as Parameters<typeof bridge.openLinearIssueMarkdown>[0];
			const bridge = makeBridge();

			await bridge.openLinearIssueMarkdown(info);

			expect(openLinearIssueMarkdown).toHaveBeenCalledWith(info);
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
			// git log — empty
			mockExecFileSuccess("\n");

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toEqual([]);
			expect(result.isMerged).toBe(false);
		});

		it("returns local mainBranch when only the local fallback ref exists", async () => {
			mockExecFileSuccess("feature/test\n");
			mockExecFileError("origin missing");
			mockExecFileError("upstream missing");
			mockExecFileSuccess("mainhash\n");
			mockExecFileSuccess("headhash\n");
			mockExecFileSuccess("mergebase\n");
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

		it("uses findBranchCreationPoint 'Created from' entry when branch is merged", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/merged\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash — returns same as merge-base (merged)
			mockExecFileSuccess("mergebase456\n");
			// merge-base — equals HEAD, triggers merged mode
			mockExecFileSuccess("mergebase456\n");
			// findBranchCreationPoint: reflog show
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

		it("uses findBranchCreationPoint oldest entry fallback when no 'Created from'", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/merged\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash — same as merge-base
			mockExecFileSuccess("mergebase456\n");
			// merge-base
			mockExecFileSuccess("mergebase456\n");
			// findBranchCreationPoint: reflog without "Created from"
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
			// findBranchCreationPoint: valid reflog
			mockExecFileSuccess("aaa111 branch: Created from main\n");
			// getCurrentUserName — returns empty string (git config not set)
			mockExecFileError("no user.name set");

			const bridge = makeBridge();
			const result = await bridge.listBranchCommits("main");

			expect(result.commits).toEqual([]);
			expect(result.isMerged).toBe(false);
		});

		it("returns empty when findBranchCreationPoint gets empty reflog (merged branch)", async () => {
			// getCurrentBranch
			mockExecFileSuccess("feature/merged\n");
			// resolveHistoryBaseRef: refExists for origin/main
			mockExecFileSuccess("abc\n");
			// getHEADHash — same as merge-base
			mockExecFileSuccess("mergebase456\n");
			// merge-base
			mockExecFileSuccess("mergebase456\n");
			// findBranchCreationPoint: empty reflog
			mockExecFileError("no reflog");

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
				expect(scanTreeHashAliases).toHaveBeenCalledWith(
					["commitHash1"],
					TEST_CWD,
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
});
