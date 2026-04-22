import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { savePluginSource, saveSquashPending } = vi.hoisted(() => ({
	savePluginSource: vi.fn(),
	saveSquashPending: vi.fn(),
}));

const { loadGlobalConfig } = vi.hoisted(() => ({
	loadGlobalConfig: vi.fn(),
}));

const { generateCommitMessage, generateSquashMessage } = vi.hoisted(() => ({
	generateCommitMessage: vi.fn(),
	generateSquashMessage: vi.fn(),
}));

const { exportSummaries } = vi.hoisted(() => ({
	exportSummaries: vi.fn(),
}));

const {
	getIndexEntryMap,
	getSummary,
	listSummaries,
	readNoteFromBranch,
	readPlanFromBranch,
	scanTreeHashAliases,
} = vi.hoisted(() => ({
	getIndexEntryMap: vi.fn(),
	getSummary: vi.fn(),
	listSummaries: vi.fn(),
	readNoteFromBranch: vi.fn().mockResolvedValue(null),
	readPlanFromBranch: vi.fn().mockResolvedValue(null),
	scanTreeHashAliases: vi.fn(),
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

const { detectPlans, ignorePlan } = vi.hoisted(() => ({
	detectPlans: vi.fn(),
	ignorePlan: vi.fn(),
}));

const {
	detectNotes,
	saveNote: saveNoteFn,
	removeNote: removeNoteFn,
} = vi.hoisted(() => ({
	detectNotes: vi.fn(),
	saveNote: vi.fn(),
	removeNote: vi.fn(),
}));

const { mergeCommitMessages } = vi.hoisted(() => ({
	mergeCommitMessages: vi.fn(),
}));

const { pushSummaryToLocal: corePushSummaryToLocal } = vi.hoisted(() => ({
	pushSummaryToLocal: vi.fn(),
}));

const { buildMarkdown } = vi.hoisted(() => ({
	buildMarkdown: vi.fn(),
}));

const { info, warn, error, debug } = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

const { existsSync, readFileSync } = vi.hoisted(() => ({
	existsSync: vi.fn(),
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
	savePluginSource,
	saveSquashPending,
}));

vi.mock("./util/WorkspaceUtils.js", () => ({
	loadGlobalConfig,
}));

vi.mock("../../cli/src/core/Summarizer.js", () => ({
	generateCommitMessage,
	generateSquashMessage,
}));

vi.mock("../../cli/src/core/SummaryExporter.js", () => ({
	exportSummaries,
}));

vi.mock("../../cli/src/core/SummaryStore.js", () => ({
	getIndexEntryMap,
	getSummary,
	listSummaries,
	readNoteFromBranch,
	readPlanFromBranch,
	scanTreeHashAliases,
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
	detectPlans,
	ignorePlan,
}));

vi.mock("./core/NoteService.js", () => ({
	detectNotes,
	saveNote: saveNoteFn,
	removeNote: removeNoteFn,
}));

vi.mock("./util/CommitMessageUtils.js", () => ({
	mergeCommitMessages,
}));

vi.mock("../../cli/src/core/LocalPusher.js", () => ({
	pushSummaryToLocal: corePushSummaryToLocal,
}));

vi.mock("../../cli/src/core/SummaryMarkdownBuilder.js", () => ({
	buildMarkdown,
}));

vi.mock("./util/Logger.js", () => ({
	log: { info, warn, error, debug },
}));

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
}));

vi.mock("node:fs", () => ({
	existsSync,
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
			// the same @jolli/cli core version.
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

	describe("stageFiles() — single file", () => {
		it("runs git add for the given path", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.stageFiles(["src/main.ts"]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["add", "--", "src/main.ts"],
				{ cwd: TEST_CWD, encoding: "utf8" },
				expect.any(Function),
			);
		});
	});

	describe("stageFiles()", () => {
		it("runs git add with multiple paths", async () => {
			mockExecFileSuccess("");
			const bridge = makeBridge();

			await bridge.stageFiles(["a.ts", "b.ts"]);

			expect(execFileMock).toHaveBeenCalledWith(
				"git",
				["add", "--", "a.ts", "b.ts"],
				{ cwd: TEST_CWD, encoding: "utf8" },
				expect.any(Function),
			);
		});

		it("does nothing when paths array is empty", async () => {
			const bridge = makeBridge();

			await bridge.stageFiles([]);

			expect(execFileMock).not.toHaveBeenCalled();
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
			// 3) getStagedFilePaths (tryExecGit for diff --cached --name-only)
			mockExecFileSuccess("src/a.ts\nsrc/b.ts\n");
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

			expect(listSummaries).toHaveBeenCalledWith(10, TEST_CWD);
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

			expect(getSummary).toHaveBeenCalledWith("abc", TEST_CWD);
			expect(result).toEqual({ commitHash: "abc", topics: [] });
		});

		it("returns null when summary is not found", async () => {
			getSummary.mockResolvedValue(null);
			const bridge = makeBridge();

			const result = await bridge.getSummary("nonexistent");

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
		it("splits lines and filters blanks", async () => {
			mockExecFileSuccess("src/a.ts\n\nsrc/b.ts\n");
			const bridge = makeBridge();

			const paths = await bridge.getStagedFilePaths();

			expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
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

			expect(getIndexEntryMap).toHaveBeenCalledWith(TEST_CWD);
			expect(result.entries.map((e) => e.commitHash)).toEqual([
				"bbb",
				"ccc",
				"aaa",
			]);
			expect(result.totalCount).toBe(3);
		});

		it("filters out entries with parentCommitHash", async () => {
			const root = makeEntry("aaa", "2025-01-01T00:00:00Z", "root", "main");
			const child = makeEntry(
				"bbb",
				"2025-01-02T00:00:00Z",
				"child",
				"main",
				"aaa",
			);
			getIndexEntryMap.mockResolvedValue(
				new Map([
					["aaa", root],
					["bbb", child],
				]),
			);

			const bridge = makeBridge();
			const result = await bridge.listSummaryEntries(10);

			expect(result.entries).toHaveLength(1);
			expect(result.entries[0].commitHash).toBe("aaa");
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

	describe("exportMemories", () => {
		beforeEach(() => {
			exportSummaries.mockReset();
		});

		it("forwards the workspace cwd to exportSummaries and returns its result", async () => {
			const expected = {
				outputDir: "/home/user/Documents/jollimemory/repo",
				filesWritten: 3,
				filesSkipped: 1,
				totalSummaries: 4,
				indexPath: "/home/user/Documents/jollimemory/repo/index.md",
			};
			exportSummaries.mockResolvedValue(expected);
			const bridge = new JolliMemoryBridge("/workspace/repo");

			const result = await bridge.exportMemories();

			expect(exportSummaries).toHaveBeenCalledWith({ cwd: "/workspace/repo" });
			expect(result).toBe(expected);
		});
	});

	describe("pushSummaryToLocal", () => {
		const HASH = "abc123def456";
		const FOLDER = "/output/memories";

		const fakeSummary = {
			version: 1,
			commitHash: HASH,
			commitMessage: "feat: add widgets",
			commitAuthor: "Test User",
			commitDate: "2025-06-01T12:00:00Z",
			branch: "feature/widgets",
			generatedAt: "2025-06-01T12:05:00Z",
			plans: [
				{
					slug: "plan-one",
					title: "Plan One",
					editCount: 2,
					addedAt: "2025-06-01T10:00:00Z",
					updatedAt: "2025-06-01T11:00:00Z",
				},
			],
			notes: [
				{
					id: "note-1",
					title: "Note One",
					format: "markdown" as const,
					content: "note snapshot",
					addedAt: "2025-06-01T10:00:00Z",
					updatedAt: "2025-06-01T11:00:00Z",
				},
			],
		};

		const planInfo: import("./Types.js").PlanInfo = {
			slug: "plan-one",
			filename: "plan-one.md",
			filePath: "/plans/plan-one.md",
			title: "Plan One",
			lastModified: "2025-06-01T11:00:00Z",
			addedAt: "2025-06-01T10:00:00Z",
			updatedAt: "2025-06-01T11:00:00Z",
			branch: "feature/widgets",
			editCount: 2,
			commitHash: HASH,
		};

		const noteInfoWithPath: import("./Types.js").NoteInfo = {
			id: "note-1",
			title: "Note One",
			format: "markdown",
			lastModified: "2025-06-01T11:00:00Z",
			addedAt: "2025-06-01T10:00:00Z",
			updatedAt: "2025-06-01T11:00:00Z",
			branch: "feature/widgets",
			commitHash: HASH,
			filename: "note-1.md",
			filePath: "/notes/note-1.md",
		};

		const noteInfoWithoutPath: import("./Types.js").NoteInfo = {
			id: "note-2",
			title: "Note Two (snippet)",
			format: "snippet",
			lastModified: "2025-06-01T11:00:00Z",
			addedAt: "2025-06-01T10:00:00Z",
			updatedAt: "2025-06-01T11:00:00Z",
			branch: "feature/widgets",
			commitHash: HASH,
		};

		beforeEach(() => {
			getSummary.mockReset();
			detectPlans.mockReset();
			detectNotes.mockReset();
			readFileSync.mockReset();
			buildMarkdown.mockReset();
			corePushSummaryToLocal.mockReset();
			readPlanFromBranch.mockReset().mockResolvedValue(null);
			readNoteFromBranch.mockReset().mockResolvedValue(null);
		});

		it("loads summary/plans/notes and delegates to core pushSummaryToLocal with translated satellites", async () => {
			getSummary.mockResolvedValue(fakeSummary);
			detectPlans.mockResolvedValue([planInfo]);
			detectNotes.mockResolvedValue([noteInfoWithPath, noteInfoWithoutPath]);
			readFileSync.mockImplementation((path: string) => {
				if (path === "/plans/plan-one.md") {
					return "# Plan One\nPlan body";
				}
				if (path === "/notes/note-1.md") {
					return "# Note One\nNote body";
				}
				throw new Error(`unexpected readFileSync call: ${path}`);
			});
			buildMarkdown.mockReturnValue("# Summary Markdown");
			const pushResult = {
				summaryPath: "/output/memories/abc123de-feat-add-widgets.md",
				satellitePaths: [
					"/output/memories/Plans & Notes/plan-one.md",
					"/output/memories/Plans & Notes/note-1.md",
				],
				indexPath: "/output/memories/index.md",
			};
			corePushSummaryToLocal.mockResolvedValue(pushResult);

			const bridge = makeBridge();
			const result = await bridge.pushSummaryToLocal(HASH, FOLDER);

			expect(result).toBe(pushResult);

			// Verify buildMarkdown was called with the summary
			expect(buildMarkdown).toHaveBeenCalledWith(fakeSummary);

			// Verify core pushSummaryToLocal was called with correct options
			expect(corePushSummaryToLocal).toHaveBeenCalledTimes(1);
			const callArgs = corePushSummaryToLocal.mock.calls[0][0];
			expect(callArgs.folder).toBe(FOLDER);
			expect(callArgs.summary).toBe(fakeSummary);
			expect(callArgs.summaryMarkdown).toBe("# Summary Markdown");

			// Satellites: 1 plan + 1 note (the note without filePath is skipped)
			expect(callArgs.satellites).toHaveLength(2);
			expect(callArgs.satellites[0]).toEqual({
				slug: "plan-one",
				title: "Plan One",
				content: "# Plan One\nPlan body",
				jolliUrl: undefined,
			});
			expect(callArgs.satellites[1]).toEqual({
				slug: "note-1",
				title: "Note One",
				content: "# Note One\nNote body",
				jolliUrl: undefined,
			});
		});

		it("throws when no summary exists for the given hash", async () => {
			getSummary.mockResolvedValue(null);

			const bridge = makeBridge();
			await expect(bridge.pushSummaryToLocal(HASH, FOLDER)).rejects.toThrow(
				`No summary found for commit ${HASH}`,
			);

			// Should not proceed to load plans/notes or call core push
			expect(detectPlans).not.toHaveBeenCalled();
			expect(corePushSummaryToLocal).not.toHaveBeenCalled();
		});

		it("populates jolliUrl on satellites from summary.plans[].jolliPlanDocUrl and summary.notes[].jolliNoteDocUrl", async () => {
			const summaryWithUrls = {
				...fakeSummary,
				plans: [
					{
						slug: "plan-one",
						title: "Plan One",
						editCount: 2,
						addedAt: "2025-06-01T10:00:00Z",
						updatedAt: "2025-06-01T11:00:00Z",
						jolliPlanDocUrl: "https://jolli.ai/doc/abc",
					},
					{
						slug: "plan-no-match",
						title: "Plan No Match",
						editCount: 1,
						addedAt: "2025-06-01T10:00:00Z",
						updatedAt: "2025-06-01T11:00:00Z",
						jolliPlanDocUrl: "https://jolli.ai/doc/orphan",
					},
				],
				notes: [
					{
						id: "note-1",
						title: "Note One",
						format: "markdown" as const,
						content: "snap",
						addedAt: "2025-06-01T10:00:00Z",
						updatedAt: "2025-06-01T11:00:00Z",
						jolliNoteDocUrl: "https://jolli.ai/doc/note-abc",
					},
					{
						id: "note-no-match",
						title: "Note No Match",
						format: "markdown" as const,
						content: "snap2",
						addedAt: "2025-06-01T10:00:00Z",
						updatedAt: "2025-06-01T11:00:00Z",
						jolliNoteDocUrl: "https://jolli.ai/doc/note-orphan",
					},
				],
			};

			// plan-one matches; plan-no-match has no PlanInfo returned by listPlans
			const planWithoutUrl: import("./Types.js").PlanInfo = {
				slug: "plan-unref",
				filename: "plan-unref.md",
				filePath: "/plans/plan-unref.md",
				title: "Plan Unref",
				lastModified: "2025-06-01T11:00:00Z",
				addedAt: "2025-06-01T10:00:00Z",
				updatedAt: "2025-06-01T11:00:00Z",
				branch: "feature/widgets",
				editCount: 1,
				commitHash: HASH,
			};

			// note-1 matches; note-no-match has no NoteInfo for this commit
			const noteWithoutUrl: import("./Types.js").NoteInfo = {
				id: "note-unref",
				title: "Note Unref",
				format: "markdown",
				lastModified: "2025-06-01T11:00:00Z",
				addedAt: "2025-06-01T10:00:00Z",
				updatedAt: "2025-06-01T11:00:00Z",
				branch: "feature/widgets",
				commitHash: HASH,
				filename: "note-unref.md",
				filePath: "/notes/note-unref.md",
			};

			getSummary.mockResolvedValue(summaryWithUrls);
			detectPlans.mockResolvedValue([planInfo, planWithoutUrl]);
			detectNotes.mockResolvedValue([noteInfoWithPath, noteWithoutUrl]);
			readFileSync.mockImplementation((path: string) => {
				if (path === "/plans/plan-one.md") {
					return "# Plan One\nPlan body";
				}
				if (path === "/plans/plan-unref.md") {
					return "# Plan Unref\nUnref body";
				}
				if (path === "/notes/note-1.md") {
					return "# Note One\nNote body";
				}
				if (path === "/notes/note-unref.md") {
					return "# Note Unref\nUnref body";
				}
				throw new Error(`unexpected readFileSync call: ${path}`);
			});
			buildMarkdown.mockReturnValue("# md");
			corePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/out/s.md",
				satellitePaths: [],
				indexPath: "/out/index.md",
			});

			const bridge = makeBridge();
			await bridge.pushSummaryToLocal(HASH, FOLDER);

			const callArgs = corePushSummaryToLocal.mock.calls[0][0];
			expect(callArgs.satellites).toHaveLength(4);

			// plan-one has a matching PlanReference with jolliPlanDocUrl
			expect(callArgs.satellites[0]).toEqual(
				expect.objectContaining({
					slug: "plan-one",
					jolliUrl: "https://jolli.ai/doc/abc",
				}),
			);

			// plan-unref has no matching PlanReference in the summary → jolliUrl is undefined
			expect(callArgs.satellites[1]).toEqual(
				expect.objectContaining({
					slug: "plan-unref",
					jolliUrl: undefined,
				}),
			);

			// note-1 has a matching NoteReference with jolliNoteDocUrl
			expect(callArgs.satellites[2]).toEqual(
				expect.objectContaining({
					slug: "note-1",
					jolliUrl: "https://jolli.ai/doc/note-abc",
				}),
			);

			// note-unref has no matching NoteReference in the summary → jolliUrl is undefined
			expect(callArgs.satellites[3]).toEqual(
				expect.objectContaining({
					slug: "note-unref",
					jolliUrl: undefined,
				}),
			);
		});

		it("handles summary with undefined plans and notes (old format)", async () => {
			const oldFormatSummary = {
				version: 1,
				commitHash: HASH,
				commitMessage: "feat: old format",
				commitAuthor: "Test User",
				commitDate: "2025-06-01T12:00:00Z",
				branch: "feature/old",
				generatedAt: "2025-06-01T12:05:00Z",
				// plans and notes are undefined (older CommitSummary records)
			};
			getSummary.mockResolvedValue(oldFormatSummary);
			detectPlans.mockResolvedValue([]);
			detectNotes.mockResolvedValue([]);
			buildMarkdown.mockReturnValue("# md");
			corePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/out/s.md",
				satellitePaths: [],
				indexPath: "/out/index.md",
			});

			const bridge = makeBridge();
			await bridge.pushSummaryToLocal(HASH, FOLDER);

			const callArgs = corePushSummaryToLocal.mock.calls[0][0];
			// No plans/notes → empty satellites and empty URL maps (no crash)
			expect(callArgs.satellites).toHaveLength(0);
		});

		it("skips notes without filePath when not in summary and orphan branch returns null", async () => {
			getSummary.mockResolvedValue(fakeSummary);
			detectPlans.mockResolvedValue([]);
			// noteInfoWithoutPath has id "note-2" which is not in fakeSummary.notes
			detectNotes.mockResolvedValue([noteInfoWithoutPath]);
			readNoteFromBranch.mockResolvedValue(null);
			buildMarkdown.mockReturnValue("# md");
			corePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/out/s.md",
				satellitePaths: [],
				indexPath: "/out/index.md",
			});

			const bridge = makeBridge();
			await bridge.pushSummaryToLocal(HASH, FOLDER);

			const callArgs = corePushSummaryToLocal.mock.calls[0][0];
			expect(callArgs.satellites).toHaveLength(0);
			expect(readFileSync).not.toHaveBeenCalled();
		});

		it("reads archived plans from orphan branch when filePath is empty", async () => {
			const archivedPlan: import("./Types.js").PlanInfo = {
				slug: "archived-plan",
				filename: "archived-plan.md",
				filePath: "", // committed/archived plans have empty filePath
				title: "Archived Plan",
				lastModified: "2025-06-01T11:00:00Z",
				addedAt: "2025-06-01T10:00:00Z",
				updatedAt: "2025-06-01T11:00:00Z",
				branch: "feature/widgets",
				editCount: 1,
				commitHash: HASH,
			};
			getSummary.mockResolvedValue(fakeSummary);
			detectPlans.mockResolvedValue([archivedPlan]);
			detectNotes.mockResolvedValue([]);
			readPlanFromBranch.mockResolvedValue(
				"# Archived Plan\nContent from orphan branch",
			);
			buildMarkdown.mockReturnValue("# md");
			corePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/out/s.md",
				satellitePaths: [],
				indexPath: "/out/index.md",
			});

			const bridge = makeBridge();
			await bridge.pushSummaryToLocal(HASH, FOLDER);

			expect(readPlanFromBranch).toHaveBeenCalledWith(
				"archived-plan",
				TEST_CWD,
			);
			expect(readFileSync).not.toHaveBeenCalled();
			const callArgs = corePushSummaryToLocal.mock.calls[0][0];
			expect(callArgs.satellites).toHaveLength(1);
			expect(callArgs.satellites[0].content).toBe(
				"# Archived Plan\nContent from orphan branch",
			);
		});

		it("includes snippet note content from summary inline when filePath is absent", async () => {
			const summaryWithSnippet = {
				...fakeSummary,
				notes: [
					{
						id: "snippet-1",
						title: "Snippet Note",
						format: "snippet" as const,
						content: "inline snippet content",
						addedAt: "2025-06-01T10:00:00Z",
						updatedAt: "2025-06-01T11:00:00Z",
					},
				],
			};
			const snippetNoteInfo: import("./Types.js").NoteInfo = {
				id: "snippet-1",
				title: "Snippet Note",
				format: "snippet",
				lastModified: "2025-06-01T11:00:00Z",
				addedAt: "2025-06-01T10:00:00Z",
				updatedAt: "2025-06-01T11:00:00Z",
				branch: "feature/widgets",
				commitHash: HASH,
				// no filePath — archived snippet
			};
			getSummary.mockResolvedValue(summaryWithSnippet);
			detectPlans.mockResolvedValue([]);
			detectNotes.mockResolvedValue([snippetNoteInfo]);
			buildMarkdown.mockReturnValue("# md");
			corePushSummaryToLocal.mockResolvedValue({
				summaryPath: "/out/s.md",
				satellitePaths: [],
				indexPath: "/out/index.md",
			});

			const bridge = makeBridge();
			await bridge.pushSummaryToLocal(HASH, FOLDER);

			// Should NOT call readNoteFromBranch — snippet content is inline
			expect(readNoteFromBranch).not.toHaveBeenCalled();
			expect(readFileSync).not.toHaveBeenCalled();
			const callArgs = corePushSummaryToLocal.mock.calls[0][0];
			expect(callArgs.satellites).toHaveLength(1);
			expect(callArgs.satellites[0].content).toBe("inline snippet content");
		});
	});
});
