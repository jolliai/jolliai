import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockExecFileSync, mockExistsSync, mockReadFileSync, mockCreateInterface } = vi.hoisted(() => ({
	mockExecFileSync: vi.fn(),
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockCreateInterface: vi.fn(),
}));

const { mockQuestion } = vi.hoisted(() => ({
	mockQuestion: vi.fn((_q: string, cb: (a: string) => void) => cb("")),
}));

vi.mock("node:child_process", () => ({
	execFileSync: mockExecFileSync,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: mockExistsSync, readFileSync: mockReadFileSync };
});

vi.mock("node:readline", () => ({
	createInterface: mockCreateInterface,
}));

vi.mock("./core/SessionTracker.js", () => ({
	getGlobalConfigDir: vi.fn().mockReturnValue("/mock/global/config"),
	loadConfigFromDir: vi.fn().mockResolvedValue({}),
	saveConfigScoped: vi.fn().mockResolvedValue(undefined),
	ensureJolliMemoryDir: vi.fn().mockResolvedValue("/mock/jollimemory"),
	// Used by configure command
	loadConfig: vi.fn().mockResolvedValue({}),
	saveConfig: vi.fn().mockResolvedValue(undefined),
	// Used by doctor / clean commands
	isLockStale: vi.fn().mockResolvedValue(false),
	releaseLock: vi.fn().mockResolvedValue(undefined),
	loadAllSessions: vi.fn().mockResolvedValue([]),
	countActiveQueueEntries: vi.fn().mockResolvedValue(0),
	countStaleSessions: vi.fn().mockResolvedValue(0),
	countStaleQueueEntries: vi.fn().mockResolvedValue({ count: 0, size: 0 }),
	pruneStaleSessions: vi.fn().mockResolvedValue(0),
	pruneStaleQueueEntries: vi.fn().mockResolvedValue(0),
	checkStaleSquashPending: vi.fn().mockResolvedValue(null),
	deleteSquashPending: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./core/JolliApiUtils.js", async () => {
	const actual = await vi.importActual<typeof import("./core/JolliApiUtils.js")>("./core/JolliApiUtils.js");
	return {
		...actual,
		parseJolliApiKey: vi.fn().mockReturnValue(null),
	};
});

vi.mock("./install/DistPathResolver.js", () => ({
	compareSemver: (a: string, b: string) => {
		const pa = a.split(".").map(Number);
		const pb = b.split(".").map(Number);
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const d = (pa[i] ?? 0) - (pb[i] ?? 0);
			if (d !== 0) return d;
		}
		return 0;
	},
	readDistPathInfo: vi.fn().mockReturnValue(null),
	traverseDistPaths: vi.fn().mockReturnValue([]),
	migrateLegacyDistPath: vi.fn().mockResolvedValue(false),
	deriveSourceTag: vi.fn().mockReturnValue("cli"),
}));

vi.mock("open", () => ({
	default: vi.fn(),
}));

vi.mock("./auth/Login.js", () => ({
	browserLogin: vi.fn().mockResolvedValue(undefined),
}));

// Mock all dependencies
vi.mock("./install/Installer.js", () => ({
	install: vi.fn().mockResolvedValue({
		success: true,
		message: "OK",
		warnings: [],
		claudeSettingsPath: "/project/.claude/settings.json",
		gitHookPath: "/project/.git/hooks/post-commit",
	}),
	uninstall: vi.fn().mockResolvedValue({ success: true, message: "OK", warnings: [] }),
	getStatus: vi.fn().mockResolvedValue({
		enabled: false,
		claudeHookInstalled: false,
		gitHookInstalled: false,
		geminiHookInstalled: false,
		activeSessions: 0,
		mostRecentSession: null,
		summaryCount: 0,
		orphanBranch: "jollimemory/summaries/v3",
		sessionsBySource: {},
	}),
}));

vi.mock("./core/SummaryStore.js", () => ({
	listSummaries: vi.fn().mockResolvedValue([]),
	getSummary: vi.fn().mockResolvedValue(null),
	getSummaryCount: vi.fn().mockResolvedValue(0),
	indexNeedsMigration: vi.fn().mockResolvedValue(false),
	migrateIndexToV3: vi.fn().mockResolvedValue({ migrated: 0, skipped: 0 }),
	// Used by clean command
	getIndex: vi.fn().mockResolvedValue(null),
}));

vi.mock("./core/SummaryMigration.js", () => ({
	hasMigrationMeta: vi.fn().mockResolvedValue(false),
	migrateV1toV3: vi.fn().mockResolvedValue({ migrated: 0, skipped: 0 }),
	writeMigrationMeta: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./core/GitOps.js", () => ({
	getHeadCommitInfo: vi.fn().mockResolvedValue({
		hash: "abc123",
		message: "test",
		author: "John",
		date: "2026-02-19",
	}),
	// Used by clean command
	orphanBranchExists: vi.fn().mockResolvedValue(true),
	listFilesInBranch: vi.fn().mockResolvedValue([]),
	writeMultipleFilesToBranch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./core/SummaryExporter.js", () => ({
	exportSummaries: vi.fn().mockResolvedValue({
		outputDir: "/home/user/Documents/jollimemory/mock",
		filesWritten: 0,
		filesSkipped: 0,
		filesErrored: 0,
		totalSummaries: 0,
		indexPath: "/home/user/Documents/jollimemory/mock/index.md",
	}),
}));

vi.mock("./core/ContextCompiler.js", () => ({
	compileTaskContext: vi.fn().mockResolvedValue({
		branch: "feature/test",
		period: { start: "2026-03-28T10:00:00.000Z", end: "2026-03-28T10:00:00.000Z" },
		commitCount: 0,
		totalFilesChanged: 0,
		totalInsertions: 0,
		totalDeletions: 0,
		summaries: [],
		plans: [],
		notes: [],
		keyDecisions: [],
		stats: {
			topicCount: 0,
			planCount: 0,
			noteCount: 0,
			decisionCount: 0,
			topicTokens: 0,
			planTokens: 0,
			noteTokens: 0,
			decisionTokens: 0,
			transcriptTokens: 0,
			totalTokens: 0,
		},
	}),
	listBranchCatalog: vi.fn().mockResolvedValue({ type: "catalog", branches: [] }),
	renderContextMarkdown: vi.fn().mockReturnValue("# Task Context: feature/test\n"),
	DEFAULT_TOKEN_BUDGET: 30000,
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process.stdout, "write").mockImplementation(() => true);
vi.spyOn(process.stderr, "write").mockImplementation(() => true);

import { main } from "./Cli.js";
import { compileTaskContext, listBranchCatalog, renderContextMarkdown } from "./core/ContextCompiler.js";
import { loadConfigFromDir } from "./core/SessionTracker.js";
import { exportSummaries } from "./core/SummaryExporter.js";
import { hasMigrationMeta, migrateV1toV3 } from "./core/SummaryMigration.js";
import { getIndex, getSummary, indexNeedsMigration, listSummaries, migrateIndexToV3 } from "./core/SummaryStore.js";
import { getStatus, install, uninstall } from "./install/Installer.js";

describe("CLI", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = undefined;
		mockExecFileSync.mockReturnValue("/mock/project\n");
		// Default: dist-path does not exist (checkVersionMismatch is a no-op)
		mockExistsSync.mockReturnValue(false);
		mockCreateInterface.mockReturnValue({
			question: mockQuestion,
			close: vi.fn(),
		});
	});

	describe("help output", () => {
		it("should hide internal commands (migrate, export-prompt) from help", async () => {
			const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
				throw new Error("process.exit");
			}) as never);
			try {
				await main(["--help"]);
			} catch {
				// Commander calls process.exit after --help
			}
			const writes = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
			const helpOutput = writes.join("");
			// Should show visible commands
			expect(helpOutput).toContain("enable");
			expect(helpOutput).toContain("view");
			// Should NOT show hidden commands
			expect(helpOutput).not.toContain("migrate");
			expect(helpOutput).not.toContain("export-prompt");
			exitSpy.mockRestore();
		});
	});

	describe("enable command", () => {
		it("should call install", async () => {
			await main(["enable"]);
			expect(install).toHaveBeenCalled();
		});

		it("should set exit code on failure", async () => {
			vi.mocked(install).mockResolvedValueOnce({ success: false, message: "Failed", warnings: [] });
			await main(["enable"]);
			expect(process.exitCode).toBe(1);
		});

		it("should display actual hook paths on success", async () => {
			vi.mocked(install).mockResolvedValueOnce({
				success: true,
				message: "OK",
				warnings: [],
				claudeSettingsPath: "/my/project/.claude/settings.json",
				gitHookPath: "/repo/.git/hooks/post-commit",
			});
			await main(["enable"]);
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("/my/project/.claude/settings.json"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("/repo/.git/hooks/post-commit"));
		});

		it("should print warnings on success", async () => {
			vi.mocked(install).mockResolvedValueOnce({
				success: true,
				message: "OK",
				warnings: ["Existing hook found"],
			});
			await main(["enable"]);
			expect(console.warn).toHaveBeenCalled();
		});

		it("should pass cwd to install", async () => {
			await main(["enable", "--cwd", "/tmp/test-project"]);
			expect(vi.mocked(install)).toHaveBeenCalledWith("/tmp/test-project", { source: "cli" });
		});
	});

	describe("disable command", () => {
		it("should call uninstall", async () => {
			await main(["disable"]);
			expect(uninstall).toHaveBeenCalled();
		});

		it("should print success message on uninstall success", async () => {
			await main(["disable"]);
			expect(console.log).toHaveBeenCalledWith("\n  Jolli Memory disabled. Hooks removed.\n");
		});

		it("should set exit code on failure", async () => {
			vi.mocked(uninstall).mockResolvedValueOnce({ success: false, message: "Failed", warnings: [] });
			await main(["disable"]);
			expect(process.exitCode).toBe(1);
		});
	});

	describe("status command", () => {
		it("should call getStatus", async () => {
			await main(["status"]);
			expect(getStatus).toHaveBeenCalled();
		});

		it("should display active session info", async () => {
			vi.mocked(getStatus).mockResolvedValueOnce({
				enabled: true,
				claudeHookInstalled: true,
				gitHookInstalled: true,
				geminiHookInstalled: false,
				activeSessions: 2,
				mostRecentSession: { sessionId: "sess-123", transcriptPath: "/path", updatedAt: "now" },
				summaryCount: 5,
				orphanBranch: "jollimemory/summaries/v3",
				sessionsBySource: {},
			});
			await main(["status"]);
			expect(getStatus).toHaveBeenCalled();
		});

		it("should print raw JSON when --json is passed", async () => {
			const status = {
				enabled: true,
				claudeHookInstalled: true,
				gitHookInstalled: true,
				geminiHookInstalled: false,
				activeSessions: 2,
				mostRecentSession: { sessionId: "sess-123", transcriptPath: "/path", updatedAt: "now" },
				summaryCount: 5,
				orphanBranch: "jollimemory/summaries/v3",
				sessionsBySource: {},
			};
			vi.mocked(getStatus).mockResolvedValueOnce(status);

			await main(["status", "--json"]);
			expect(console.log).toHaveBeenCalledWith(JSON.stringify(status));
		});

		it("should show hooks description with detected integrations", async () => {
			vi.mocked(getStatus).mockResolvedValueOnce({
				enabled: true,
				claudeHookInstalled: true,
				gitHookInstalled: true,
				geminiHookInstalled: true,
				activeSessions: 1,
				mostRecentSession: null,
				summaryCount: 5,
				orphanBranch: "jollimemory/summaries/v3",
				sessionsBySource: {},
				codexDetected: true,
				geminiDetected: true,
			});

			await main(["status"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(
				calls.some(
					(s) =>
						s.includes("Hooks:") &&
						s.includes("3 Git") &&
						s.includes("2 Claude") &&
						s.includes("1 Gemini CLI"),
				),
			).toBe(true);
		});

		it("should show hooks as not installed when disabled", async () => {
			vi.mocked(getStatus).mockResolvedValueOnce({
				enabled: false,
				claudeHookInstalled: false,
				gitHookInstalled: false,
				geminiHookInstalled: false,
				activeSessions: 0,
				mostRecentSession: null,
				summaryCount: 0,
				orphanBranch: "jollimemory/summaries/v3",
				sessionsBySource: {},
			});

			await main(["status"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Hooks:") && s.includes("none installed"))).toBe(true);
		});

		it("should show hook runtime in hooks line when hookSource is present", async () => {
			vi.mocked(getStatus).mockResolvedValueOnce({
				enabled: true,
				claudeHookInstalled: true,
				gitHookInstalled: true,
				geminiHookInstalled: false,
				activeSessions: 1,
				mostRecentSession: null,
				summaryCount: 5,
				orphanBranch: "jollimemory/summaries/v3",
				sessionsBySource: {},
				hookSource: "cli",
				hookVersion: "1.0.0",
			});

			await main(["status"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Hook runtime:") && s.includes("cli@1.0.0"))).toBe(true);
		});

		describe("integration rows", () => {
			it("renders rows for all five integrations when detected, with session counts", async () => {
				vi.mocked(getStatus).mockResolvedValueOnce({
					enabled: true,
					claudeHookInstalled: true,
					gitHookInstalled: true,
					geminiHookInstalled: true,
					activeSessions: 10,
					mostRecentSession: null,
					summaryCount: 0,
					orphanBranch: "jollimemory/summaries/v3",
					claudeDetected: true,
					codexDetected: true,
					geminiDetected: true,
					openCodeDetected: true,
					cursorDetected: true,
					codexEnabled: true,
					geminiEnabled: true,
					openCodeEnabled: true,
					cursorEnabled: true,
					sessionsBySource: { claude: 3, codex: 2, gemini: 4, opencode: 1, cursor: 5 },
				});
				vi.mocked(loadConfigFromDir).mockResolvedValueOnce({ claudeEnabled: true });

				await main(["status"]);
				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Claude:") && s.includes("hook installed (3 sessions)"))).toBe(
					true,
				);
				expect(calls.some((s) => s.includes("Codex:") && s.includes("detected & enabled (2 sessions)"))).toBe(
					true,
				);
				expect(calls.some((s) => s.includes("Gemini:") && s.includes("hook installed (4 sessions)"))).toBe(
					true,
				);
				expect(calls.some((s) => s.includes("OpenCode:") && s.includes("detected & enabled (1 session)"))).toBe(
					true,
				);
				expect(calls.some((s) => s.includes("Cursor:") && s.includes("detected & enabled (5 sessions)"))).toBe(
					true,
				);
			});

			it("renders 'detected but disabled' when an integration is turned off in config", async () => {
				vi.mocked(getStatus).mockResolvedValueOnce({
					enabled: true,
					claudeHookInstalled: false,
					gitHookInstalled: true,
					geminiHookInstalled: false,
					activeSessions: 0,
					mostRecentSession: null,
					summaryCount: 0,
					orphanBranch: "jollimemory/summaries/v3",
					claudeDetected: true,
					codexDetected: true,
					openCodeDetected: true,
					cursorDetected: true,
					codexEnabled: false,
					openCodeEnabled: false,
					cursorEnabled: false,
					sessionsBySource: {},
				});
				vi.mocked(loadConfigFromDir).mockResolvedValueOnce({ claudeEnabled: false });

				await main(["status"]);
				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Claude:") && s.includes("detected but disabled"))).toBe(true);
				expect(calls.some((s) => s.includes("Codex:") && s.includes("detected but disabled"))).toBe(true);
				expect(calls.some((s) => s.includes("OpenCode:") && s.includes("detected but disabled"))).toBe(true);
				expect(calls.some((s) => s.includes("Cursor:") && s.includes("detected but disabled"))).toBe(true);
			});

			it("renders 'hook not installed' for Gemini when detected+enabled but the AfterAgent hook is missing", async () => {
				vi.mocked(getStatus).mockResolvedValueOnce({
					enabled: true,
					claudeHookInstalled: false,
					gitHookInstalled: true,
					geminiHookInstalled: false,
					activeSessions: 0,
					mostRecentSession: null,
					summaryCount: 0,
					orphanBranch: "jollimemory/summaries/v3",
					geminiDetected: true,
					geminiEnabled: true,
					sessionsBySource: {},
				});

				await main(["status"]);
				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Gemini:") && s.includes("hook not installed"))).toBe(true);
			});

			it("renders 'unavailable — <kind>' for OpenCode when openCodeScanError is present", async () => {
				vi.mocked(getStatus).mockResolvedValueOnce({
					enabled: true,
					claudeHookInstalled: false,
					gitHookInstalled: true,
					geminiHookInstalled: false,
					activeSessions: 0,
					mostRecentSession: null,
					summaryCount: 0,
					orphanBranch: "jollimemory/summaries/v3",
					openCodeDetected: true,
					openCodeEnabled: true,
					openCodeScanError: { kind: "corrupt", message: "database disk image is malformed" },
					sessionsBySource: {},
				});

				await main(["status"]);
				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("OpenCode:") && s.includes("unavailable — corrupt"))).toBe(true);
			});

			it("renders 'unavailable — <kind>' for Cursor when cursorScanError is present", async () => {
				vi.mocked(getStatus).mockResolvedValueOnce({
					enabled: true,
					claudeHookInstalled: false,
					gitHookInstalled: true,
					geminiHookInstalled: false,
					activeSessions: 0,
					mostRecentSession: null,
					summaryCount: 0,
					orphanBranch: "jollimemory/summaries/v3",
					cursorDetected: true,
					cursorEnabled: true,
					cursorScanError: { kind: "locked", message: "database is locked" },
					sessionsBySource: {},
				});

				await main(["status"]);
				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Cursor:") && s.includes("unavailable — locked"))).toBe(true);
			});

			it("does not print a row for an integration that was not detected", async () => {
				vi.mocked(getStatus).mockResolvedValueOnce({
					enabled: true,
					claudeHookInstalled: false,
					gitHookInstalled: true,
					geminiHookInstalled: false,
					activeSessions: 0,
					mostRecentSession: null,
					summaryCount: 0,
					orphanBranch: "jollimemory/summaries/v3",
					claudeDetected: false,
					codexDetected: false,
					geminiDetected: false,
					openCodeDetected: false,
					cursorDetected: false,
					sessionsBySource: {},
				});

				await main(["status"]);
				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => /^\s+Claude:/.test(s))).toBe(false);
				expect(calls.some((s) => /^\s+Codex:/.test(s))).toBe(false);
				expect(calls.some((s) => /^\s+Gemini:/.test(s))).toBe(false);
				expect(calls.some((s) => /^\s+OpenCode:/.test(s))).toBe(false);
				expect(calls.some((s) => /^\s+Cursor:/.test(s))).toBe(false);
			});
		});
	});

	describe("view command", () => {
		it("should show compact list by default using getIndex", async () => {
			await main(["view"]);
			expect(getIndex).toHaveBeenCalledWith(expect.any(String));
		});

		it("should view specific commit", async () => {
			await main(["view", "--commit", "abc123"]);
			expect(getSummary).toHaveBeenCalledWith("abc123", expect.any(String));
		});

		it("should accept custom count (compact list mode)", async () => {
			await main(["view", "--count", "10"]);
			expect(getIndex).toHaveBeenCalledWith(expect.any(String));
		});

		it("should print multi-topic summary details", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Fix bug",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 10,
				stats: { filesChanged: 3, insertions: 20, deletions: 5 },
				topics: [
					{
						title: "Fix email validation in login form",
						trigger: "Users submitted malformed emails",
						response: "Added regex check in LoginValidator.ts",
						decisions: "Used native regex to avoid extra dependency",
						todo: "Consider server-side validation too",
					},
				],
			});
			await main(["view", "--commit", "abc123def456"]);
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Summary:"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Fix email validation"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Why this change"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Decisions behind the code"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("What was implemented"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Todo"));
		});

		it("should print summary without todo when not present", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Refactor",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 5,
				stats: { filesChanged: 1, insertions: 10, deletions: 8 },
				topics: [
					{
						title: "Simplify session tracking logic",
						trigger: "Function was too long and hard to read",
						response: "Extracted helper functions from SessionTracker",
						decisions: "Kept all helpers in same file to avoid fragmentation",
					},
				],
			});
			await main(["view", "--commit", "abc123def456"]);
			// 'Todo:' line should NOT appear when todo is absent
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Todo:"))).toBe(false);
		});

		it("should suppress todo when value is a 'None' placeholder", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Refactor",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 5,
				stats: { filesChanged: 1, insertions: 10, deletions: 8 },
				topics: [
					{
						title: "Topic A",
						trigger: "Some trigger",
						response: "Some response",
						decisions: "Some decision",
						todo: "None.",
					},
					{
						title: "Topic B",
						trigger: "Some trigger",
						response: "Some response",
						decisions: "Some decision",
						todo: "none",
					},
				],
			});
			await main(["view", "--commit", "abc123def456"]);
			// 'Todo:' line should NOT appear for "None." or "none" placeholder values
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Todo:"))).toBe(false);
		});

		it("should aggregate topics from squash children without source headers", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "squash123",
				commitMessage: "Squash: two features",
				commitAuthor: "John",
				commitDate: "2026-02-20T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-20T00:00:05.000Z",
				children: [
					{
						version: 3,
						commitHash: "orig2",
						commitMessage: "Feature B",
						commitAuthor: "John",
						commitDate: "2026-02-19T00:00:00.000Z",
						branch: "main",
						generatedAt: "2026-02-19T00:00:05.000Z",
						transcriptEntries: 5,
						stats: { filesChanged: 2, insertions: 10, deletions: 3 },
						topics: [{ title: "Topic B", trigger: "Needed B", response: "Did B", decisions: "Chose Y" }],
					},
					{
						version: 3,
						commitHash: "orig1",
						commitMessage: "Feature A",
						commitAuthor: "John",
						commitDate: "2026-02-18T00:00:00.000Z",
						branch: "main",
						generatedAt: "2026-02-18T00:00:05.000Z",
						transcriptEntries: 3,
						stats: { filesChanged: 1, insertions: 5, deletions: 0 },
						topics: [{ title: "Topic A", trigger: "Needed A", response: "Did A", decisions: "Chose X" }],
					},
				],
			});
			await main(["view", "--commit", "squash123"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			// Topics from children are aggregated and printed
			expect(calls.some((s) => s.includes("Topic A"))).toBe(true);
			expect(calls.some((s) => s.includes("Topic B"))).toBe(true);
			// Source commit headers are not printed
			expect(calls.some((s) => s.includes("Sources:"))).toBe(false);
		});

		it("should print Type line when commitType is non-default", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Amend fix",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				commitType: "amend",
				commitSource: "plugin",
				transcriptEntries: 4,
				stats: { filesChanged: 1, insertions: 5, deletions: 2 },
				topics: [{ title: "Fix bug", trigger: "Bug found", response: "Fixed it", decisions: "Simple fix" }],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Commit Type:") && s.includes("amend via plugin"))).toBe(true);
		});

		it("should print default commit label when source is non-default but type is omitted", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Plugin commit",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				commitSource: "plugin",
				transcriptEntries: 4,
				stats: { filesChanged: 1, insertions: 5, deletions: 2 },
				topics: [{ title: "Add feature", trigger: "Requested", response: "Added", decisions: "Simple" }],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Commit Type: commit via plugin"))).toBe(true);
		});

		it("should print a non-default commit type without source suffix when source is default", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Revert commit",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				commitType: "revert",
				commitSource: "cli",
				transcriptEntries: 4,
				stats: { filesChanged: 1, insertions: 5, deletions: 2 },
				topics: [{ title: "Undo change", trigger: "Rollback", response: "Reverted", decisions: "Safer" }],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Commit Type: revert") && !s.includes("via"))).toBe(true);
		});

		it("should not print Type line when commitType is default commit+cli", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Normal commit",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				commitType: "commit",
				commitSource: "cli",
				transcriptEntries: 4,
				stats: { filesChanged: 1, insertions: 5, deletions: 2 },
				topics: [{ title: "Add feature", trigger: "Requested", response: "Added", decisions: "Simple" }],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Commit Type:"))).toBe(false);
		});

		it("should print Conversations line when conversationTurns is present", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Feature work",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 20,
				conversationTurns: 8,
				stats: { filesChanged: 3, insertions: 40, deletions: 10 },
				topics: [{ title: "Add feature", trigger: "Requested", response: "Added", decisions: "Simple" }],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Conversations:") && s.includes("8 turns"))).toBe(true);
		});

		it("should print category and importance in topic title", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Mixed work",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 10,
				stats: { filesChanged: 5, insertions: 30, deletions: 10 },
				topics: [
					{
						title: "Add dark mode",
						trigger: "User requested",
						response: "Implemented toggle",
						decisions: "Used CSS variables",
						category: "feature",
						importance: "major",
					},
					{
						title: "Update README",
						trigger: "Outdated docs",
						response: "Updated badges",
						decisions: "Used shields.io",
						category: "docs",
						importance: "minor",
					},
				],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Add dark mode") && s.includes("[feature]"))).toBe(true);
			expect(
				calls.some((s) => s.includes("Update README") && s.includes("[docs]") && s.includes("(minor)")),
			).toBe(true);
		});

		it("should print topics without minor suffix when importance is omitted", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Mixed work",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 10,
				stats: { filesChanged: 5, insertions: 30, deletions: 10 },
				topics: [
					{
						title: "Untyped topic",
						trigger: "User requested",
						response: "Implemented toggle",
						decisions: "Used CSS variables",
						category: "feature",
					},
				],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Untyped topic") && !s.includes("(minor)"))).toBe(true);
		});

		it("should sort topics with a minor item before a non-minor second argument branch is evaluated", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Mixed work",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 10,
				stats: { filesChanged: 5, insertions: 30, deletions: 10 },
				topics: [
					{
						title: "Minor docs",
						trigger: "Docs drifted",
						response: "Updated docs",
						decisions: "Kept it small",
						importance: "minor",
					},
					{
						title: "Major feature",
						trigger: "Requested",
						response: "Implemented",
						decisions: "Prioritized UX",
						importance: "major",
					},
				],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Major feature"))).toBe(true);
		});

		it("should print filesAffected when present", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Fix auth",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 6,
				stats: { filesChanged: 2, insertions: 15, deletions: 5 },
				topics: [
					{
						title: "Fix login validation",
						trigger: "Bug report",
						response: "Fixed regex",
						decisions: "Used native regex",
						filesAffected: ["src/LoginValidator.ts", "src/utils/Validation.ts"],
					},
				],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Files:") && s.includes("src/LoginValidator.ts"))).toBe(true);
		});

		it("should print llm metadata when present on a leaf summary", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Fix auth",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 6,
				stats: { filesChanged: 2, insertions: 15, deletions: 5 },
				llm: {
					model: "claude-sonnet-4-6",
					inputTokens: 321,
					outputTokens: 45,
					apiLatencyMs: 987,
					stopReason: "end_turn",
				},
				topics: [
					{
						title: "Fix login",
						trigger: "Bug report",
						response: "Fixed regex",
						decisions: "Used native regex",
					},
				],
			});

			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Model:") && s.includes("claude-sonnet-4-6"))).toBe(true);
		});

		it("should print Summaries as (none) when the summary has no topics", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Empty summary",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 0,
				stats: { filesChanged: 0, insertions: 0, deletions: 0 },
				topics: [],
			});

			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Summaries:") && s.includes("(none"))).toBe(true);
		});

		it("should print Duration as '1 day' for leaf node", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Single commit",
				commitAuthor: "John",
				commitDate: "2026-02-19T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-19T00:00:05.000Z",
				transcriptEntries: 4,
				stats: { filesChanged: 1, insertions: 5, deletions: 2 },
				topics: [{ title: "Fix bug", trigger: "Bug", response: "Fixed", decisions: "Simple" }],
			});
			await main(["view", "--commit", "abc123def456"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Duration:") && s.includes("1 day"))).toBe(true);
		});

		it("should print Duration with date range for squash tree", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "squash123",
				commitMessage: "Squash commit",
				commitAuthor: "John",
				commitDate: "2026-02-21T00:00:00.000Z",
				branch: "main",
				generatedAt: "2026-02-21T00:00:05.000Z",
				children: [
					{
						version: 3,
						commitHash: "bbb222",
						commitMessage: "Last commit",
						commitAuthor: "John",
						commitDate: "2026-02-21T10:00:00.000Z",
						branch: "main",
						generatedAt: "2026-02-21T10:00:05.000Z",
						transcriptEntries: 6,
						stats: { filesChanged: 2, insertions: 10, deletions: 3 },
						topics: [{ title: "Topic B", trigger: "T", response: "R", decisions: "D" }],
					},
					{
						version: 3,
						commitHash: "aaa111",
						commitMessage: "First commit",
						commitAuthor: "John",
						commitDate: "2026-02-18T10:00:00.000Z",
						branch: "main",
						generatedAt: "2026-02-18T10:00:05.000Z",
						transcriptEntries: 4,
						stats: { filesChanged: 1, insertions: 5, deletions: 2 },
						topics: [{ title: "Topic A", trigger: "T", response: "R", decisions: "D" }],
					},
				],
			});
			await main(["view", "--commit", "squash123"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			// 2 unique calendar days: Feb 18 and Feb 21
			expect(calls.some((s) => s.includes("Duration:") && s.includes("2 days"))).toBe(true);
			// Should contain a date range with em-dash
			expect(calls.some((s) => s.includes("Duration:") && s.includes("\u2014"))).toBe(true);
		});

		it("should print multiple summaries when listing recent", async () => {
			vi.mocked(listSummaries).mockResolvedValueOnce([
				{
					version: 3,
					commitHash: "hash1",
					commitMessage: "First",
					commitAuthor: "John",
					commitDate: "2026-02-18T00:00:00.000Z",
					branch: "main",
					generatedAt: "2026-02-18T00:00:05.000Z",
					transcriptEntries: 3,
					stats: { filesChanged: 1, insertions: 5, deletions: 0 },
					topics: [{ title: "Topic A", trigger: "Needed A", response: "Did A", decisions: "Chose X" }],
				},
				{
					version: 3,
					commitHash: "hash2",
					commitMessage: "Second",
					commitAuthor: "Jane",
					commitDate: "2026-02-19T00:00:00.000Z",
					branch: "main",
					generatedAt: "2026-02-19T00:00:05.000Z",
					transcriptEntries: 5,
					stats: { filesChanged: 2, insertions: 10, deletions: 3 },
					topics: [{ title: "Topic B", trigger: "Needed B", response: "Did B", decisions: "Chose Y" }],
				},
			]);
			await main(["view"]);
			expect(console.log).toHaveBeenCalled();
		});
	});

	describe("view command — compact list and numeric indexing", () => {
		it("should show compact list when index has root entries", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "aaa11111",
						parentCommitHash: null,
						commitMessage: "Fix login bug",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
						topicCount: 3,
						diffStats: { filesChanged: 5, insertions: 120, deletions: 30 },
					},
					{
						commitHash: "bbb22222",
						parentCommitHash: null,
						commitMessage: "Add feature X",
						commitDate: "2026-04-14T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-14T10:00:05Z",
						topicCount: 5,
						diffStats: { filesChanged: 12, insertions: 340, deletions: 50 },
					},
					{
						commitHash: "ccc33333",
						parentCommitHash: "aaa11111",
						commitMessage: "Child of aaa",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
					},
				],
			});
			await main(["view"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			// Should show compact list header
			expect(calls.some((s) => s.includes("Recent Memories"))).toBe(true);
			// Should show root entries but not children
			expect(calls.some((s) => s.includes("aaa11111"))).toBe(true);
			expect(calls.some((s) => s.includes("bbb22222"))).toBe(true);
			expect(calls.some((s) => s.includes("ccc33333"))).toBe(false);
		});

		it("should resolve numeric --commit index to correct root entry", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "latest111",
						parentCommitHash: null,
						commitMessage: "Latest",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
					},
					{
						commitHash: "second222",
						parentCommitHash: null,
						commitMessage: "Second",
						commitDate: "2026-04-14T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-14T10:00:05Z",
					},
				],
			});
			await main(["view", "--commit", "1"]);
			// Should look up the latest root entry by SHA
			expect(getSummary).toHaveBeenCalledWith("latest111", expect.any(String));
		});

		it("should resolve numeric --commit 2 to second most recent", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "latest111",
						parentCommitHash: null,
						commitMessage: "Latest",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
					},
					{
						commitHash: "second222",
						parentCommitHash: null,
						commitMessage: "Second",
						commitDate: "2026-04-14T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-14T10:00:05Z",
					},
				],
			});
			await main(["view", "--commit", "2"]);
			expect(getSummary).toHaveBeenCalledWith("second222", expect.any(String));
		});

		it("should show error when numeric index is out of range", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "only111",
						parentCommitHash: null,
						commitMessage: "Only entry",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
					},
				],
			});
			await main(["view", "--commit", "5"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("No summary at index #5"))).toBe(true);
		});

		it("should treat long numeric strings as SHA, not index", async () => {
			await main(["view", "--commit", "12345678901234"]);
			// Should be treated as SHA lookup, not numeric index
			expect(getSummary).toHaveBeenCalledWith("12345678901234", expect.any(String));
		});

		it("should show empty message when no summaries exist", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce(null);
			await main(["view"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("No summaries found"))).toBe(true);
		});

		it("should show hint line with jolli view --commit 1", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "aaa11111",
						parentCommitHash: null,
						commitMessage: "Entry",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
					},
				],
			});
			await main(["view"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("jolli view --commit 1"))).toBe(true);
		});

		it("should write summary to file with --output", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Test commit",
				commitAuthor: "John",
				commitDate: "2026-04-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-04-15T10:00:05Z",
				topics: [],
			});
			const os = await import("node:os");
			const outputPath = `${os.tmpdir()}/jolli-view-test.json`;
			await main(["view", "--commit", "abc123def456", "--output", outputPath, "--format", "json"]);
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(outputPath, "utf-8");
			expect(content).toContain('"commitHash"');
			await fs.unlink(outputPath);
		});

		it("should write compact list to file with --output (no --commit)", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "aaa11111",
						parentCommitHash: null,
						commitMessage: "Entry",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
						topicCount: 2,
						diffStats: { filesChanged: 3, insertions: 50, deletions: 10 },
					},
				],
			});
			const os = await import("node:os");
			const outputPath = `${os.tmpdir()}/jolli-view-list-test.json`;
			await main(["view", "--output", outputPath]);
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(outputPath, "utf-8");
			expect(content).toContain("aaa11111");
			await fs.unlink(outputPath);
		});

		it("should output compact list as JSON to stdout with --format json", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "aaa11111",
						parentCommitHash: null,
						commitMessage: "Entry",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
					},
				],
			});
			const chunks: Array<string> = [];
			const origWrite = process.stdout.write;
			process.stdout.write = ((chunk: string) => {
				chunks.push(chunk);
				return true;
			}) as typeof process.stdout.write;

			try {
				await main(["view", "--format", "json"]);
				expect(chunks.some((c) => c.includes("aaa11111"))).toBe(true);
			} finally {
				process.stdout.write = origWrite;
			}
		});

		it("should output JSON when --format json is used with --commit", async () => {
			const mockSummary = {
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Test",
				commitAuthor: "John",
				commitDate: "2026-04-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-04-15T10:00:05Z",
				topics: [],
			};
			vi.mocked(getSummary).mockResolvedValueOnce(mockSummary);

			await main(["view", "--commit", "abc123def456", "--format", "json"]);
			const writes = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
			expect(writes.some((c) => c.includes('"commitHash"'))).toBe(true);
		});

		it("should display squash badge in compact list", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "sqsh1111",
						parentCommitHash: null,
						commitMessage: "Squash commit",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
						commitType: "squash",
						diffStats: { filesChanged: 10, insertions: 200, deletions: 50 },
					},
				],
			});
			await main(["view"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("[squash]"))).toBe(true);
		});

		it("should handle entry with invalid date gracefully in compact list", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "bad0date",
						parentCommitHash: null,
						commitMessage: "Bad date entry",
						commitDate: "not-a-valid-date",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
					},
				],
			});
			await main(["view"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("bad0date"))).toBe(true);
		});

		it("should truncate long commit messages in compact list", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "long1111",
						parentCommitHash: null,
						commitMessage: "A".repeat(300),
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
					},
				],
			});
			await main(["view"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("..."))).toBe(true);
		});

		it("should handle entry without diffStats in compact list", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "nods1111",
						parentCommitHash: null,
						commitMessage: "No diff stats",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
					},
				],
			});
			await main(["view"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("nods1111"))).toBe(true);
		});

		it("should write compact list as markdown to file with --output --format md", async () => {
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "md_entry1",
						parentCommitHash: null,
						commitMessage: "Markdown entry",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
						topicCount: 2,
						diffStats: { filesChanged: 3, insertions: 50, deletions: 10 },
					},
				],
			});
			const os = await import("node:os");
			const outputPath = `${os.tmpdir()}/jolli-view-md-test.md`;
			await main(["view", "--output", outputPath, "--format", "md"]);
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(outputPath, "utf-8");
			// Valid GFM: must have header row + separator row before data rows.
			expect(content).toContain("| # | Hash |");
			expect(content).toContain("|---|---|");
			expect(content).toContain("md_entry");
			await fs.unlink(outputPath);
		});

		it("should render entries without topicCount as 0 in markdown table", async () => {
			// Regression: entries produced by older writers may omit topicCount.
			// Covers the `e.topicCount ?? 0` fallback branch in buildMarkdownTable.
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "nocount1",
						parentCommitHash: null,
						commitMessage: "No topic count",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
						// topicCount intentionally omitted
					},
				],
			});
			const os = await import("node:os");
			const outputPath = `${os.tmpdir()}/jolli-view-nocount.md`;
			await main(["view", "--output", outputPath, "--format", "md"]);
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(outputPath, "utf-8");
			// Missing topicCount should render as "0"
			expect(content).toMatch(/\| nocount1 \|.*\| 0 \|/);
			await fs.unlink(outputPath);
		});

		it("should default --output format to markdown when --format is absent", async () => {
			// Covers `options.format ?? "md"` fallback branch in the --commit + --output path.
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "abc123def456",
				commitMessage: "Default format",
				commitAuthor: "John",
				commitDate: "2026-04-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-04-15T10:00:05Z",
				topics: [],
			});
			const os = await import("node:os");
			const outputPath = `${os.tmpdir()}/jolli-view-default-fmt.md`;
			await main(["view", "--commit", "abc123def456", "--output", outputPath]);
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(outputPath, "utf-8");
			// Markdown (not JSON): must have the H1 commit message heading.
			expect(content).toContain("# Default format");
			await fs.unlink(outputPath);
		});

		it("should escape pipe chars and newlines in commit messages for GFM table safety", async () => {
			// Regression: commit subjects containing '|' (allowed by git) used to break table alignment.
			vi.mocked(getIndex).mockResolvedValueOnce({
				version: 3,
				entries: [
					{
						commitHash: "escme123",
						parentCommitHash: null,
						commitMessage: "Fix A | B conflict\nsecond line",
						commitDate: "2026-04-15T10:00:00Z",
						branch: "main",
						generatedAt: "2026-04-15T10:00:05Z",
						topicCount: 1,
					},
				],
			});
			const os = await import("node:os");
			const outputPath = `${os.tmpdir()}/jolli-view-md-escape.md`;
			await main(["view", "--output", outputPath, "--format", "md"]);
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(outputPath, "utf-8");
			// '|' must be backslash-escaped and newlines collapsed; the data row must stay on one line.
			expect(content).toContain("Fix A \\| B conflict second line");
			expect(content).not.toContain("Fix A | B conflict");
			await fs.unlink(outputPath);
		});

		it("should show 'No summary found' for unknown SHA", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce(null);
			await main(["view", "--commit", "unknown_sha"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("No summary found"))).toBe(true);
		});

		it("should show 'No summaries found' for --commit N when index is null (empty repo)", async () => {
			// Regression: numeric --commit used to silently exit when no summaries existed,
			// because resolveCommit returned null with no message and the digit-test guard
			// in the action handler skipped the fallback console.log.
			vi.mocked(getIndex).mockResolvedValueOnce(null);
			await main(["view", "--commit", "1"]);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("No summaries found"))).toBe(true);
		});

		it("should write full summary markdown to file with --output --format md", async () => {
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "file1234567890",
				commitMessage: "File output test",
				commitAuthor: "Alice",
				commitDate: "2026-04-15T10:00:00Z",
				branch: "main",
				generatedAt: "2026-04-15T10:00:05Z",
				topics: [{ title: "T", trigger: "t", response: "r", decisions: "d" }],
				stats: { filesChanged: 1, insertions: 5, deletions: 0 },
			});
			const os = await import("node:os");
			const outputPath = `${os.tmpdir()}/jolli-view-md-full.md`;
			await main(["view", "--commit", "file1234567890", "--output", outputPath, "--format", "md"]);
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(outputPath, "utf-8");
			expect(content).toContain("File output test");
			await fs.unlink(outputPath);
		});
	});

	// Note: "summarize" command tests removed — command was deleted (transcript cursor
	// positions are not recorded per-commit, making re-summarization unreliable).

	describe("migrate command", () => {
		it("should run both orphan branch and index migration and report results", async () => {
			vi.mocked(migrateV1toV3).mockResolvedValueOnce({ migrated: 5, skipped: 3 });
			vi.mocked(indexNeedsMigration).mockResolvedValueOnce(true);
			vi.mocked(migrateIndexToV3).mockResolvedValueOnce({ migrated: 8, skipped: 1 });

			await main(["migrate"]);

			expect(migrateV1toV3).toHaveBeenCalled();
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("5 summaries converted"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("3 summaries"));
			expect(migrateIndexToV3).toHaveBeenCalled();
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("8 index entries"));
		});

		it("should skip orphan branch migration when already done and still run index migration", async () => {
			vi.mocked(hasMigrationMeta).mockResolvedValueOnce(true);
			vi.mocked(indexNeedsMigration).mockResolvedValueOnce(true);
			vi.mocked(migrateIndexToV3).mockResolvedValueOnce({ migrated: 4, skipped: 0 });

			await main(["migrate"]);

			expect(migrateV1toV3).not.toHaveBeenCalled();
			expect(migrateIndexToV3).toHaveBeenCalled();
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("4 index entries"));
		});

		it("should report when no orphan branch summaries found and index already up to date", async () => {
			vi.mocked(migrateV1toV3).mockResolvedValueOnce({ migrated: 0, skipped: 0 });
			// indexNeedsMigration defaults to false in mock

			await main(["migrate"]);

			expect(migrateV1toV3).toHaveBeenCalled();
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No summaries found"));
			expect(migrateIndexToV3).not.toHaveBeenCalled();
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("already in v3 flat format"));
		});
	});

	describe("migrate command — additional branches", () => {
		it("should print 'No index entries found.' when index migration finds nothing", async () => {
			vi.mocked(hasMigrationMeta).mockResolvedValueOnce(true);
			vi.mocked(indexNeedsMigration).mockResolvedValueOnce(true);
			vi.mocked(migrateIndexToV3).mockResolvedValueOnce({ migrated: 0, skipped: 0 });

			await main(["migrate"]);

			expect(console.log).toHaveBeenCalledWith("  No index entries found.");
		});

		it("should write migration meta when only skipped summaries exist (no migrated)", async () => {
			vi.mocked(migrateV1toV3).mockResolvedValueOnce({ migrated: 0, skipped: 5 });
			vi.mocked(indexNeedsMigration).mockResolvedValueOnce(false);
			const { writeMigrationMeta } = await import("./core/SummaryMigration.js");

			await main(["migrate"]);

			expect(writeMigrationMeta).toHaveBeenCalled();
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("5 summaries"));
		});

		it("should report index skipped entries", async () => {
			vi.mocked(hasMigrationMeta).mockResolvedValueOnce(true);
			vi.mocked(indexNeedsMigration).mockResolvedValueOnce(true);
			vi.mocked(migrateIndexToV3).mockResolvedValueOnce({ migrated: 2, skipped: 3 });

			await main(["migrate"]);

			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("2 index entries"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("3 entries"));
		});
	});

	describe("export-prompt command", () => {
		it("prints a usage hint instead of dumping all templates when no flags are provided", async () => {
			await main(["export-prompt"]);

			// Default output is guidance text — dumping all templates to stdout
			// produces thousands of lines that overwhelm scrollback. Direct users
			// to either --action <key> for one or --output <dir> for all.
			const calls = (console.log as unknown as { mock: { calls: ReadonlyArray<ReadonlyArray<string>> } }).mock
				.calls;
			const combined = calls.map((c) => c.join(" ")).join("\n");
			expect(combined).toContain("--action");
			expect(combined).toContain("--output");
			expect(combined).toContain("Available actions:");
			// And explicitly NOT a template body
			expect(process.stdout.write).not.toHaveBeenCalledWith(expect.stringContaining("=== summarize"));
		});

		it("prints a single template when --action is provided", async () => {
			await main(["export-prompt", "--action", "translate"]);

			expect(process.stdout.write).toHaveBeenCalledWith(
				expect.stringContaining("Translate the following Markdown"),
			);
		});

		it("prints an error and exits when the action is unknown", async () => {
			await main(["export-prompt", "--action", "unknown-action"]);

			expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unknown action "unknown-action"'));
			expect(process.exitCode).toBe(1);
		});

		describe("--output", () => {
			let tmpDir: string;
			beforeEach(async () => {
				const { mkdtemp } = await import("node:fs/promises");
				const { tmpdir } = await import("node:os");
				const { join } = await import("node:path");
				tmpDir = await mkdtemp(join(tmpdir(), "jolli-export-prompt-"));
			});
			afterEach(async () => {
				const { rm } = await import("node:fs/promises");
				await rm(tmpDir, { recursive: true, force: true });
			});

			it("writes manifest.json + per-prompt .md files to the output directory", async () => {
				const { readFile, readdir } = await import("node:fs/promises");
				const { join } = await import("node:path");

				await main(["export-prompt", "--output", tmpDir]);

				const files = await readdir(tmpDir);
				expect(files).toContain("manifest.json");
				// Per-prompt .md files (one per action)
				expect(files).toContain("summarize.md");
				expect(files).toContain("commit-message.md");
				expect(files).toContain("translate.md");

				const manifestRaw = await readFile(join(tmpDir, "manifest.json"), "utf-8");
				const manifest = JSON.parse(manifestRaw) as {
					exportedAt: string;
					cliVersion: string;
					prompts: ReadonlyArray<{
						action: string;
						version: number;
						template: string;
						placeholders: ReadonlyArray<string>;
					}>;
				};

				// Schema sanity
				expect(manifest.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
				expect(manifest.cliVersion).toBeTruthy();
				// cliVersion must NOT leak the VSCode plugin's package.json version
				// when this CLI binary is shipped inside the VSCode bundle. The
				// build-time define `__CLI_PKG_VERSION__` is the canonical source —
				// validate that the value at minimum looks like a semver string and
				// is not the placeholder "unknown" the catch-all returns when both
				// the define and the package.json read fail.
				expect(manifest.cliVersion).not.toBe("unknown");
				expect(manifest.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
				expect(manifest.prompts.length).toBeGreaterThanOrEqual(6);

				// Each entry has the required fields and non-empty template
				for (const p of manifest.prompts) {
					expect(p.action).toBeTruthy();
					expect(p.version).toBeGreaterThan(0);
					expect(p.template.length).toBeGreaterThan(0);
					expect(Array.isArray(p.placeholders)).toBe(true);
				}

				// Placeholder extraction must cover spaced form too (matches fillTemplate).
				// Topic-count guidance is now embedded in the prompt text itself, so the
				// summarize template should NOT have a topicGuidance placeholder anymore —
				// only the standard input set: commit fields, conversation, diff.
				const summarize = manifest.prompts.find((p) => p.action === "summarize");
				expect(summarize?.placeholders).toContain("commitHash");
				expect(summarize?.placeholders).toContain("diff");
				expect(summarize?.placeholders).toContain("conversation");
				expect(summarize?.placeholders).not.toContain("topicGuidance");
			});

			it("emits per-prompt .md with frontmatter (action, version, placeholders)", async () => {
				const { readFile } = await import("node:fs/promises");
				const { join } = await import("node:path");

				await main(["export-prompt", "--output", tmpDir]);

				const md = await readFile(join(tmpDir, "translate.md"), "utf-8");
				expect(md).toMatch(/^---\naction: "translate"\n/);
				expect(md).toMatch(/version: \d+\n/);
				expect(md).toContain("placeholders:");
				expect(md).toContain("Translate the following Markdown");
			});

			it("filters to a single prompt when --action and --output both provided", async () => {
				const { readFile, readdir } = await import("node:fs/promises");
				const { join } = await import("node:path");

				await main(["export-prompt", "--action", "translate", "--output", tmpDir]);

				const files = await readdir(tmpDir);
				expect(files).toContain("manifest.json");
				expect(files).toContain("translate.md");
				// Other prompts should NOT have files written
				expect(files).not.toContain("summarize.md");
				expect(files).not.toContain("commit-message.md");

				const manifest = JSON.parse(await readFile(join(tmpDir, "manifest.json"), "utf-8")) as {
					prompts: ReadonlyArray<{ action: string }>;
				};
				expect(manifest.prompts).toHaveLength(1);
				expect(manifest.prompts[0].action).toBe("translate");
			});

			it("errors when --action is unknown even with --output", async () => {
				await main(["export-prompt", "--action", "no-such-action", "--output", tmpDir]);

				expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unknown action "no-such-action"'));
				expect(process.exitCode).toBe(1);
			});

			it("creates the output directory if it does not exist", async () => {
				const { stat } = await import("node:fs/promises");
				const { join } = await import("node:path");
				const nestedDir = join(tmpDir, "nested", "deep");

				await main(["export-prompt", "--output", nestedDir]);

				const s = await stat(nestedDir);
				expect(s.isDirectory()).toBe(true);
			});
		});
	});

	describe("recall command", () => {
		it("should output human-readable catalog text by default for --catalog", async () => {
			// Regression: --catalog used to unconditionally emit JSON, which was
			// the wrong default for a flag that is primarily used interactively.
			const catalog = {
				type: "catalog",
				branches: [
					{
						branch: "feature/auth",
						commitCount: 3,
						period: { start: "2026-03-28", end: "2026-03-30" },
						commitMessages: ["a", "b", "c"],
					},
				],
			};
			vi.mocked(listBranchCatalog).mockResolvedValueOnce(
				catalog as ReturnType<typeof listBranchCatalog> extends Promise<infer T> ? T : never,
			);

			await main(["recall", "--catalog", "--cwd", "/tmp/test"]);

			expect(listBranchCatalog).toHaveBeenCalledWith("/tmp/test");
			const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			// Human-readable output — must NOT be raw JSON
			expect(logged.some((l) => l.trim().startsWith("{"))).toBe(false);
			// Must include the branch name as part of the rendered text
			expect(logged.some((l) => l.includes("feature/auth"))).toBe(true);
		});

		it("should output JSON catalog when --catalog --format json is passed", async () => {
			const catalog = {
				type: "catalog",
				branches: [
					{
						branch: "feature/auth",
						commitCount: 3,
						period: { start: "2026-03-28", end: "2026-03-30" },
						commitMessages: ["a", "b", "c"],
					},
				],
			};
			vi.mocked(listBranchCatalog).mockResolvedValueOnce(
				catalog as ReturnType<typeof listBranchCatalog> extends Promise<infer T> ? T : never,
			);

			await main(["recall", "--catalog", "--format", "json", "--cwd", "/tmp/test"]);

			expect(listBranchCatalog).toHaveBeenCalledWith("/tmp/test");
			expect(console.log).toHaveBeenCalledWith(JSON.stringify(catalog, null, 2));
		});

		it("should output markdown context for an exact branch match", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/auth",
						commitCount: 2,
						period: { start: "2026-03-28", end: "2026-03-29" },
						commitMessages: ["a", "b"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/auth",
				period: { start: "2026-03-28", end: "2026-03-29" },
				commitCount: 2,
				totalFilesChanged: 5,
				totalInsertions: 100,
				totalDeletions: 20,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 0,
				},
			});
			vi.mocked(renderContextMarkdown).mockReturnValueOnce("# Task Context: feature/auth\nSome content");

			await main(["recall", "feature/auth", "--full", "--cwd", "/tmp/test"]);

			expect(compileTaskContext).toHaveBeenCalledWith(
				expect.objectContaining({ branch: "feature/auth" }),
				"/tmp/test",
			);
			expect(console.log).toHaveBeenCalledWith("# Task Context: feature/auth\nSome content");
		});

		it("should output JSON format when --format json is passed", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/auth",
						commitCount: 2,
						period: { start: "2026-03-28", end: "2026-03-29" },
						commitMessages: ["a"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/auth",
				period: { start: "2026-03-28", end: "2026-03-29" },
				commitCount: 2,
				totalFilesChanged: 5,
				totalInsertions: 100,
				totalDeletions: 20,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 1,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 50,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 50,
				},
			});
			vi.mocked(renderContextMarkdown).mockReturnValueOnce("# markdown");

			await main(["recall", "feature/auth", "--format", "json", "--cwd", "/tmp/test"]);

			const calls = vi.mocked(console.log).mock.calls;
			const jsonCall = calls.find(
				(c) =>
					(typeof c[0] === "string" && c[0].includes('"type":"recall"')) ||
					(typeof c[0] === "string" && c[0].includes('"type": "recall"')),
			);
			expect(jsonCall).toBeDefined();
		});

		it("should output error JSON when commitCount is 0", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/auth",
						commitCount: 1,
						period: { start: "2026-03-28", end: "2026-03-28" },
						commitMessages: ["a"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/auth",
				period: { start: "", end: "" },
				commitCount: 0,
				totalFilesChanged: 0,
				totalInsertions: 0,
				totalDeletions: 0,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 0,
				},
			});

			await main(["recall", "feature/auth", "--cwd", "/tmp/test"]);

			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No Jolli Memory records found"));
		});

		it("should return catalog with query when branch has no exact match", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/other",
						commitCount: 1,
						period: { start: "2026-03-28", end: "2026-03-28" },
						commitMessages: ["x"],
					},
				],
			});

			await main(["recall", "feature/nonexistent", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("No exact match");
			expect(output).toContain("feature/nonexistent");
		});

		it("should detect current branch when no argument given and return catalog if no match", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) return "feature/current\n";
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/other",
						commitCount: 1,
						period: { start: "2026-03-28", end: "2026-03-28" },
						commitMessages: ["x"],
					},
				],
			});

			await main(["recall", "--cwd", "/tmp/test"]);

			// Should call listBranchCatalog to check and return catalog with query
			expect(listBranchCatalog).toHaveBeenCalled();
		});

		it("should return error for no records when catalog is empty and no branch given", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) throw new Error("detached HEAD");
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({ type: "catalog", branches: [] });

			await main(["recall", "--cwd", "/tmp/test"]);

			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No Jolli Memory records found"));
		});

		it("should reject arguments with unsafe characters (human-readable by default)", async () => {
			await main(["recall", "branch;rm -rf /", "--cwd", "/tmp/test"]);

			expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid characters"));
			expect(process.exitCode).toBe(1);
		});

		it("should reject arguments with unsafe characters (JSON when --format json)", async () => {
			await main(["recall", "branch;rm -rf /", "--format", "json", "--cwd", "/tmp/test"]);

			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Invalid characters"));
		});

		it("should handle errors gracefully with human-readable output by default", async () => {
			vi.mocked(listBranchCatalog).mockRejectedValueOnce(new Error("disk error"));

			await main(["recall", "feature/auth", "--catalog", "--cwd", "/tmp/test"]);

			expect(console.error).toHaveBeenCalledWith(expect.stringContaining("disk error"));
			expect(process.exitCode).toBe(1);
		});

		it("should handle errors with JSON output when --format json", async () => {
			vi.mocked(listBranchCatalog).mockRejectedValueOnce(new Error("disk error"));

			await main(["recall", "feature/auth", "--catalog", "--format", "json", "--cwd", "/tmp/test"]);

			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("disk error"));
		});

		it("should handle non-Error throws in recall catch block", async () => {
			vi.mocked(listBranchCatalog).mockRejectedValueOnce("string error");

			await main(["recall", "feature/auth", "--catalog", "--cwd", "/tmp/test"]);

			expect(console.error).toHaveBeenCalledWith(expect.stringContaining("string error"));
		});

		it("should pass depth and budget options to compileTaskContext", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/auth",
						commitCount: 5,
						period: { start: "2026-03-28", end: "2026-03-30" },
						commitMessages: ["a"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/auth",
				period: { start: "2026-03-28", end: "2026-03-30" },
				commitCount: 3,
				totalFilesChanged: 10,
				totalInsertions: 200,
				totalDeletions: 50,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 0,
				},
			});
			vi.mocked(renderContextMarkdown).mockReturnValueOnce("# markdown");

			await main(["recall", "feature/auth", "--depth", "3", "--budget", "5000", "--cwd", "/tmp/test"]);

			expect(compileTaskContext).toHaveBeenCalledWith(
				expect.objectContaining({ depth: 3, tokenBudget: 5000 }),
				"/tmp/test",
			);
		});

		it("should pass --include-transcripts and --no-plans options", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/auth",
						commitCount: 1,
						period: { start: "2026-03-28", end: "2026-03-28" },
						commitMessages: ["a"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/auth",
				period: { start: "2026-03-28", end: "2026-03-28" },
				commitCount: 1,
				totalFilesChanged: 1,
				totalInsertions: 10,
				totalDeletions: 0,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 0,
				},
			});
			vi.mocked(renderContextMarkdown).mockReturnValueOnce("# md");

			await main(["recall", "feature/auth", "--include-transcripts", "--no-plans", "--cwd", "/tmp/test"]);

			expect(compileTaskContext).toHaveBeenCalledWith(
				expect.objectContaining({ includeTranscripts: true, includePlans: false }),
				"/tmp/test",
			);
		});

		it("should return catalog when branch has no exact match but current branch does exist", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) return "feature/current\n";
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/current",
						commitCount: 2,
						period: { start: "2026-03-28", end: "2026-03-29" },
						commitMessages: ["a", "b"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/current",
				period: { start: "2026-03-28", end: "2026-03-29" },
				commitCount: 2,
				totalFilesChanged: 5,
				totalInsertions: 100,
				totalDeletions: 20,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 0,
				},
			});
			vi.mocked(renderContextMarkdown).mockReturnValueOnce("# context md");

			await main(["recall", "--cwd", "/tmp/test"]);

			// Current branch matches, should compile context
			expect(compileTaskContext).toHaveBeenCalled();
		});

		it("should fallback to catalog when no branch and catalog is non-empty", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) throw new Error("detached");
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/old",
						commitCount: 1,
						period: { start: "2026-03-28", end: "2026-03-28" },
						commitMessages: ["x"],
					},
				],
			});

			await main(["recall", "--cwd", "/tmp/test"]);

			// Should output the catalog as JSON
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("feature/old"));
		});

		it("should accept 'context' as an alias for 'recall'", async () => {
			const catalog = {
				type: "catalog",
				branches: [
					{
						branch: "feature/alias-test",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["test alias"],
					},
				],
			};
			vi.mocked(listBranchCatalog).mockResolvedValueOnce(
				catalog as ReturnType<typeof listBranchCatalog> extends Promise<infer T> ? T : never,
			);

			await main(["context", "--catalog", "--format", "json", "--cwd", "/tmp/test"]);

			expect(listBranchCatalog).toHaveBeenCalledWith("/tmp/test");
			expect(console.log).toHaveBeenCalledWith(JSON.stringify(catalog, null, 2));
		});

		it("should output markdown (not JSON) when no exact match and format is not json", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/other",
						commitCount: 2,
						period: { start: "2026-04-01", end: "2026-04-02" },
						commitMessages: ["a", "b"],
					},
				],
			});

			await main(["recall", "feature/nonexistent", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("No exact match");
			expect(output).toContain("Recorded branches");
			// Should NOT be JSON
			expect(output).not.toMatch(/^\s*\{/);
		});

		it("should output markdown hint when empty repository and format is not json", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) throw new Error("detached HEAD");
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({ type: "catalog", branches: [] });

			await main(["recall", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("No Jolli Memory records found");
			expect(output).toContain("jolli enable");
			// Should NOT be JSON
			expect(output).not.toMatch(/^\s*\{/);
		});

		it("should output markdown catalog when no branch detected and catalog is non-empty (format not json)", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) throw new Error("detached");
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/recent",
						commitCount: 3,
						period: { start: "2026-04-01", end: "2026-04-03" },
						commitMessages: ["a", "b", "c"],
					},
				],
			});

			await main(["recall", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("Recorded branches");
			// Should NOT be JSON
			expect(output).not.toMatch(/^\s*\{/);
		});

		it("should output JSON catalog when no branch and format is json", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) throw new Error("detached");
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/x",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["x"],
					},
				],
			});

			await main(["recall", "--format", "json", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("");
			expect(JSON.parse(output)).toHaveProperty("branches");
		});

		it("should output JSON error when empty catalog and format is json", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) throw new Error("detached");
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({ type: "catalog", branches: [] });

			await main(["recall", "--format", "json", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("");
			const parsed = JSON.parse(output);
			expect(parsed.type).toBe("error");
			expect(parsed.message).toContain("No Jolli Memory records found");
		});

		it("should output JSON catalog with query when no exact match and format is json", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/other",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["x"],
					},
				],
			});

			await main(["recall", "feature/miss", "--format", "json", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("");
			const parsed = JSON.parse(output);
			expect(parsed.query).toBe("feature/miss");
			expect(parsed.branches).toHaveLength(1);
		});

		it("should output JSON error when outputRecall finds zero commits", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/auth",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["a"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/auth",
				period: { start: "2026-04-01", end: "2026-04-01" },
				commitCount: 0,
				totalFilesChanged: 0,
				totalInsertions: 0,
				totalDeletions: 0,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					noteTokens: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 0,
				},
			});

			await main(["recall", "feature/auth", "--format", "json", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("");
			const parsed = JSON.parse(output);
			expect(parsed.type).toBe("error");
			expect(parsed.message).toContain("No Jolli Memory records found");
		});
	});

	describe("export command", () => {
		it("should call exportSummaries with defaults", async () => {
			await main(["export"]);
			expect(exportSummaries).toHaveBeenCalledWith(
				expect.objectContaining({ commit: undefined, project: undefined }),
			);
		});

		it("should pass --commit option", async () => {
			await main(["export", "--commit", "abc123"]);
			expect(exportSummaries).toHaveBeenCalledWith(expect.objectContaining({ commit: "abc123" }));
		});

		it("should pass --project option", async () => {
			await main(["export", "--project", "my-project"]);
			expect(exportSummaries).toHaveBeenCalledWith(expect.objectContaining({ project: "my-project" }));
		});

		it("should display results when summaries are exported", async () => {
			vi.mocked(exportSummaries).mockResolvedValueOnce({
				outputDir: "/home/user/Documents/jollimemory/test",
				filesWritten: 3,
				filesSkipped: 2,
				filesErrored: 0,
				totalSummaries: 5,
				indexPath: "/home/user/Documents/jollimemory/test/index.md",
			});
			await main(["export"]);
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("New: 3"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Skipped: 2"));
			// Clean success: the "Errored:" segment should be omitted entirely.
			expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Errored:"));
			expect(process.exitCode).toBeUndefined();
		});

		it("should display message when no summaries found", async () => {
			await main(["export"]);
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No summaries found"));
		});

		it("should surface errored count and still report success on partial failure", async () => {
			vi.mocked(exportSummaries).mockResolvedValueOnce({
				outputDir: "/home/user/Documents/jollimemory/test",
				filesWritten: 3,
				filesSkipped: 1,
				filesErrored: 2,
				totalSummaries: 6,
				indexPath: "/home/user/Documents/jollimemory/test/index.md",
			});
			await main(["export"]);
			// Real files landed on disk, so the success path runs — but "Errored: 2" must
			// be visible so users do not silently trust a partially-failed export.
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Exported to"));
			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Errored: 2"));
			// Partial failure is not a hard error — exit code stays clean for scripts.
			expect(process.exitCode).toBeUndefined();
		});

		it("should fail with non-zero exit code when every write errors", async () => {
			vi.mocked(exportSummaries).mockResolvedValueOnce({
				outputDir: "/home/user/Documents/jollimemory/test",
				filesWritten: 0,
				filesSkipped: 4,
				filesErrored: 3,
				totalSummaries: 7,
				indexPath: "/home/user/Documents/jollimemory/test/index.md",
			});
			await main(["export"]);
			// Total failure: no "Exported to" success line — the user must not be
			// misled into thinking new files reached disk.
			expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Exported to"));
			expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Export failed"));
			expect(console.error).toHaveBeenCalledWith(expect.stringContaining("3 failed"));
			expect(console.error).toHaveBeenCalledWith(expect.stringContaining("4 already on disk"));
			expect(process.exitCode).toBe(1);
		});
	});

	describe("project dir fallback", () => {
		it("should fall back to process.cwd() when git root detection fails", async () => {
			vi.resetModules();
			mockExecFileSync.mockImplementation(() => {
				throw new Error("not a git repo");
			});
			const { main: freshMain } = await import("./Cli.js");

			await freshMain(["status"]);
			expect(getStatus).toHaveBeenCalledWith(process.cwd());
		});

		it("should resolve recall projectDir from git root when --cwd is omitted", async () => {
			await main(["recall", "--catalog"]);

			expect(listBranchCatalog).toHaveBeenCalledWith("/mock/project");
		});

		it("should parse process.argv when args are omitted", async () => {
			const originalArgv = process.argv;
			process.argv = ["node", "jollimemory", "status"];

			try {
				await main();
				expect(getStatus).toHaveBeenCalled();
			} finally {
				process.argv = originalArgv;
			}
		});
	});

	// ── checkVersionMismatch ────────────────────────────────────────────

	describe("checkVersionMismatch", () => {
		/**
		 * checkVersionMismatch runs at the top of main(), before commander parses.
		 * Since __PKG_VERSION__ is undefined in tests (VERSION = "dev"), we need
		 * vi.resetModules() + vi.stubGlobal() to re-import Cli with a real version.
		 */
		async function runWithVersion(cliVersion: string, distPathContent: string | null): Promise<void> {
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", cliVersion);

			// Parse the legacy-style `source=tag@ver\npath` test fixture into the
			// new per-source registry mock. checkVersionMismatch only reads
			// traverseDistPaths() now — legacy single-file fallback was removed
			// once migrateLegacyDistPath started deleting the old file.
			const { traverseDistPaths } = await import("./install/DistPathResolver.js");
			vi.mocked(traverseDistPaths).mockReset();

			if (distPathContent) {
				const m = distPathContent.match(/^source=([^@\n]+)(?:@([^\n]+))?\n(.+)$/);
				if (m?.[2]) {
					vi.mocked(traverseDistPaths).mockReturnValue([
						{ source: m[1], version: m[2], distDir: m[3], available: true },
					]);
				} else {
					vi.mocked(traverseDistPaths).mockReturnValue([]);
				}
			} else {
				vi.mocked(traverseDistPaths).mockReturnValue([]);
			}

			const { main: freshMain } = await import("./Cli.js");
			await freshMain(["status"]);
		}

		it("should warn when dist-paths version is higher than CLI version", async () => {
			await runWithVersion("0.1.0", "source=vscode-extension@0.2.0\n/ext/dist");

			const output = vi
				.mocked(process.stderr.write)
				.mock.calls.map((c) => String(c[0]))
				.join("");
			expect(output).toContain("A newer version of jolli is available");
			expect(output).toContain("npm update -g @jolli.ai/cli");
		});

		it("should not warn when versions match", async () => {
			await runWithVersion("1.0.0", "source=cli@1.0.0\n/global/dist");

			const calls = vi.mocked(process.stderr.write).mock.calls;
			const hasWarning = calls.some((c) => String(c[0]).includes("newer version"));
			expect(hasWarning).toBe(false);
		});

		it("should not warn when CLI version is higher", async () => {
			await runWithVersion("2.0.0", "source=vscode-extension@1.5.0\n/ext/dist");

			const calls = vi.mocked(process.stderr.write).mock.calls;
			const hasWarning = calls.some((c) => String(c[0]).includes("newer version"));
			expect(hasWarning).toBe(false);
		});

		it("should not warn when no sources are registered", async () => {
			await runWithVersion("1.0.0", null);

			const calls = vi.mocked(process.stderr.write).mock.calls;
			const hasWarning = calls.some((c) => String(c[0]).includes("newer version"));
			expect(hasWarning).toBe(false);
		});

		it("should not warn for source entry with no version (legacy content ignored)", async () => {
			await runWithVersion("1.0.0", "source=cli\n/global/dist");

			const calls = vi.mocked(process.stderr.write).mock.calls;
			const hasWarning = calls.some((c) => String(c[0]).includes("newer version"));
			expect(hasWarning).toBe(false);
		});

		it("should not throw when readFileSync fails", async () => {
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", "1.0.0");
			mockExistsSync.mockReturnValue(true);
			mockReadFileSync.mockImplementation(() => {
				throw new Error("EACCES");
			});

			const { main: freshMain } = await import("./Cli.js");
			// Should not throw — error is silently caught
			await expect(freshMain(["status"])).resolves.not.toThrow();
		});
	});

	// ── Enable: interactive API keys ──

	describe("enable and interactive prompts", () => {
		/** Helper: mock createInterface to simulate user typing answers in sequence. */
		function mockUserInput(...answers: string[]): void {
			let callIndex = 0;
			mockCreateInterface.mockReturnValue({
				question: (_prompt: string, cb: (answer: string) => void) => {
					cb(answers[callIndex++] ?? "");
				},
				close: vi.fn(),
			});
		}

		it("should install with global config", async () => {
			mockExistsSync.mockReturnValue(false);

			await main(["enable", "-y"]);

			expect(install).toHaveBeenCalledWith(expect.any(String), { source: "cli" });
		});

		it("should run promptSetup after install when interactive", async () => {
			// Choose "3" (skip), then skip Anthropic key
			mockUserInput("3", "");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

			try {
				await main(["enable"]);

				// promptSetup was reached — it printed the setup menu
				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("How would you like to use Jolli Memory"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			}
		});

		it("should save API keys and print confirmation when keys are entered interactively", async () => {
			const { saveConfigScoped } = await import("./core/SessionTracker.js");
			// Construct an on-allowlist key so the new validateJolliApiKey gate passes.
			const goodMeta = { t: "tenant1", u: "https://tenant1.jolli.ai" };
			const goodJolliKey = `sk-jol-${Buffer.from(JSON.stringify(goodMeta)).toString("base64url")}.secret`;
			// Choose "2" (manual Jolli API key), enter key, then enter Anthropic key
			mockUserInput("2", goodJolliKey, "sk-ant-test-key");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

			try {
				await main(["enable"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Jolli API Key:     saved"))).toBe(true);
				expect(calls.some((s) => s.includes("Anthropic API Key: saved"))).toBe(true);
				expect(calls.some((s) => s.includes("Configuration saved"))).toBe(true);
				expect(saveConfigScoped).toHaveBeenCalled();
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			}
		});

		it("should show 'configured' when credentials already exist", async () => {
			const { loadConfigFromDir } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfigFromDir).mockResolvedValueOnce({
				jolliApiKey: "jk_existing",
				apiKey: "sk-existing",
			});
			mockUserInput();
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

			try {
				await main(["enable"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				// When jolliApiKey exists, promptSetup shows key status and checks Anthropic
				expect(calls.some((s) => s.includes("Jolli API Key:") && s.includes("configured"))).toBe(true);
				expect(calls.some((s) => s.includes("Anthropic API Key:") && s.includes("configured"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			}
		});

		it("should display no-API-keys warning when setup is skipped", async () => {
			// Choose "3" (skip), then skip Anthropic key
			mockUserInput("3", "");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			const origKey = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;

			try {
				await main(["enable"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Skipped"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
				if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
			}
		});

		it("should default to browser login when Enter is pressed", async () => {
			const { browserLogin } = await import("./auth/Login.js");
			// Press Enter (empty string defaults to choice "1")
			mockUserInput("", "");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

			try {
				await main(["enable"]);

				expect(browserLogin).toHaveBeenCalled();
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			}
		});

		it("should use browser login when choice 1 is selected", async () => {
			const { browserLogin } = await import("./auth/Login.js");
			// Choose "1" (browser login), then skip Anthropic key
			mockUserInput("1", "");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

			try {
				await main(["enable"]);

				expect(browserLogin).toHaveBeenCalled();
				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Authenticated successfully"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			}
		});

		it("should handle browser login failure in enable flow", async () => {
			const { browserLogin } = await import("./auth/Login.js");
			vi.mocked(browserLogin).mockRejectedValueOnce(new Error("Port in use"));
			// Choose "1" (browser login), then skip Anthropic key
			mockUserInput("1", "");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			try {
				await main(["enable"]);

				const errorCalls = errorSpy.mock.calls.map((c) => String(c[0]));
				expect(errorCalls.some((s) => s.includes("Login failed"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
				errorSpy.mockRestore();
			}
		});

		it("should handle non-Error throw in browser login during enable flow", async () => {
			const { browserLogin } = await import("./auth/Login.js");
			vi.mocked(browserLogin).mockRejectedValueOnce("raw string rejection");
			// Choose "1" (browser login), then skip Anthropic key
			mockUserInput("1", "");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			try {
				await main(["enable"]);

				const errorCalls = errorSpy.mock.calls.map((c) => String(c[0]));
				expect(errorCalls.some((s) => s.includes("Login failed"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
				errorSpy.mockRestore();
			}
		});

		it("should show empty line when keys are saved after manual entry", async () => {
			const { loadConfigFromDir } = await import("./core/SessionTracker.js");
			// Construct an on-allowlist key so the new validateJolliApiKey gate passes.
			const goodMeta = { t: "tenant1", u: "https://tenant1.jolli.ai" };
			const goodJolliKey = `sk-jol-${Buffer.from(JSON.stringify(goodMeta)).toString("base64url")}.secret`;
			// Choose "2" (manual), enter Jolli key, enter Anthropic key
			mockUserInput("2", goodJolliKey, "sk-ant-test");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			// Mock the 3 calls to loadConfigFromDir:
			// 1. initial check in promptSetup (empty, show menu)
			// 2. after manual key entry, check for Anthropic key (has Jolli key now)
			// 3. final state check in promptAnthropicKey (has both keys)
			vi.mocked(loadConfigFromDir)
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({ jolliApiKey: goodJolliKey })
				.mockResolvedValueOnce({ jolliApiKey: goodJolliKey, apiKey: "sk-ant-test" });

			try {
				await main(["enable"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Jolli API Key:     saved"))).toBe(true);
				expect(calls.some((s) => s.includes("Anthropic API Key: saved"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			}
		});

		it("should show no-API-keys warning when manual key is skipped and no Anthropic key", async () => {
			// Choose "2" (manual), skip Jolli API key, skip Anthropic key
			mockUserInput("2", "", "");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			const origKey = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;

			try {
				await main(["enable"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("No API keys configured"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
				if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
			}
		});

		it("should show no-API-keys warning after browser login when only authToken is saved", async () => {
			// Simulates the partial-setup case: OAuth succeeds and an authToken is
			// saved, but backend key-generation fails so no jolliApiKey is set. The
			// warning must still appear since authToken alone can't drive summaries.
			const { loadConfigFromDir } = await import("./core/SessionTracker.js");
			// Choose "1" (browser login), then skip Anthropic key
			mockUserInput("1", "");
			mockExistsSync.mockReturnValue(false);
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			const origKey = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;
			// loadConfigFromDir calls: (1) initial in promptSetup — empty (show menu);
			// (2) after browserLogin — authToken only; (3) after Jolli setup in
			// promptSetup; (4) final state check in promptAnthropicKey.
			vi.mocked(loadConfigFromDir)
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({ authToken: "tok" })
				.mockResolvedValueOnce({ authToken: "tok" })
				.mockResolvedValueOnce({ authToken: "tok" });

			try {
				await main(["enable"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("No API keys configured"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
				if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
			}
		});
	});

	// ── Enable: additional branch coverage ────────────────────────────────

	describe("enable command — additional branches", () => {
		it("should display gemini settings path when geminiSettingsPath is returned", async () => {
			vi.mocked(install).mockResolvedValueOnce({
				success: true,
				message: "OK",
				warnings: [],
				claudeSettingsPath: "/project/.claude/settings.json",
				gitHookPath: "/project/.git/hooks/post-commit",
				geminiSettingsPath: "/project/.gemini/settings.json",
			});

			await main(["enable", "-y"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Gemini CLI hook") && s.includes(".gemini/settings.json"))).toBe(true);
		});

		it("should print warnings on enable failure", async () => {
			vi.mocked(install).mockResolvedValueOnce({
				success: false,
				message: "Install failed",
				warnings: ["Git hooks dir not found", "Claude settings missing"],
			});

			await main(["enable"]);

			expect(process.exitCode).toBe(1);
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Git hooks dir not found"));
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Claude settings missing"));
		});
	});

	// ── Status: additional branch coverage ────────────────────────────────

	describe("status command — Jolli Site display", () => {
		it("should display Jolli Site when jolliApiKey is configured", async () => {
			const { loadConfigFromDir } = await import("./core/SessionTracker.js");
			const { parseJolliApiKey } = await import("./core/JolliApiUtils.js");
			vi.mocked(loadConfigFromDir).mockResolvedValueOnce({ jolliApiKey: "jk_test_key" });
			vi.mocked(parseJolliApiKey).mockReturnValueOnce({
				u: "https://mysite.jolli.app",
				o: "my-org",
				t: "my-tenant",
			} as ReturnType<typeof parseJolliApiKey>);

			await main(["status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Jolli Site:") && s.includes("mysite.jolli.app"))).toBe(true);
		});

		it("should display hook runtime without version when version is unknown", async () => {
			vi.mocked(getStatus).mockResolvedValueOnce({
				enabled: true,
				claudeHookInstalled: true,
				gitHookInstalled: true,
				geminiHookInstalled: false,
				activeSessions: 0,
				mostRecentSession: null,
				summaryCount: 0,
				orphanBranch: "jollimemory/summaries/v3",
				hookSource: "vscode-extension",
				hookVersion: "unknown",
			});

			await main(["status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(
				calls.some((s) => s.includes("Hook runtime:") && s.includes("vscode-extension") && !s.includes("@")),
			).toBe(true);
		});
	});

	// ── checkVersionMismatch: additional branches ─────────────────────────

	describe("checkVersionMismatch — additional branches", () => {
		async function runWithVersion(cliVersion: string, distPathContent: string | null): Promise<void> {
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", cliVersion);

			// Parse the legacy-style `source=tag@ver\npath` test fixture into the
			// new per-source registry mock. No readDistPathInfo mock is needed:
			// checkVersionMismatch no longer reads the legacy single file.
			const { traverseDistPaths } = await import("./install/DistPathResolver.js");
			vi.mocked(traverseDistPaths).mockReset();

			if (distPathContent) {
				const m = distPathContent.match(/^source=([^@\n]+)(?:@([^\n]+))?\n(.+)$/);
				if (m?.[2]) {
					vi.mocked(traverseDistPaths).mockReturnValue([
						{ source: m[1], version: m[2], distDir: m[3], available: true },
					]);
				} else {
					vi.mocked(traverseDistPaths).mockReturnValue([]);
				}
			} else {
				vi.mocked(traverseDistPaths).mockReturnValue([]);
			}

			const { main: freshMain } = await import("./Cli.js");
			await freshMain(["status"]);
		}

		it("should not warn when dist-paths entry has no source= prefix", async () => {
			await runWithVersion("1.0.0", "some-random-content\n/path/to/dist");

			const calls = vi.mocked(process.stderr.write).mock.calls;
			const hasWarning = calls.some((c) => String(c[0]).includes("newer version"));
			expect(hasWarning).toBe(false);
		});

		it("should pick highest version across multiple registered sources", async () => {
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", "1.0.0");
			const { traverseDistPaths } = await import("./install/DistPathResolver.js");
			vi.mocked(traverseDistPaths).mockReset();
			// Mix of available + unavailable + sorted out-of-order; highest available is 2.5.0
			vi.mocked(traverseDistPaths).mockReturnValue([
				{ source: "cli", version: "1.0.0", distDir: "/cli", available: true },
				{ source: "cursor", version: "3.0.0", distDir: "/cursor", available: false },
				{ source: "vscode", version: "2.5.0", distDir: "/vscode", available: true },
				{ source: "windsurf", version: "0.5.0", distDir: "/ws", available: true },
			]);

			vi.mocked(process.stderr.write).mockClear();
			const { main: freshMain } = await import("./Cli.js");
			await freshMain(["status"]);

			const stderrOutput = vi
				.mocked(process.stderr.write)
				.mock.calls.map((c) => String(c[0]))
				.join("");
			expect(stderrOutput).toContain("A newer version of jolli is available");
		});
	});

	// ── configure command ───────────────────────────────────────────────
	describe("configure command", () => {
		it("should display empty config when nothing is set", async () => {
			const { loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfig).mockResolvedValueOnce({});

			await main(["configure"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("Jolli Memory Configuration");
			expect(output).toContain("(empty");
		});

		it("should display config with API keys masked", async () => {
			const { loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfig).mockResolvedValueOnce({
				apiKey: "sk-ant-verylongsecret12345",
				model: "claude-haiku-4-5",
				jolliApiKey: "sk-jol-verylongsecret12345",
			});

			await main(["configure"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("apiKey");
			expect(output).toContain("sk-ant"); // masked prefix
			expect(output).toContain("2345"); // masked suffix
			expect(output).not.toContain("verylongsecret"); // middle masked
			expect(output).toContain("claude-haiku-4-5");
		});

		it("should mask short secrets as ***", async () => {
			const { loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfig).mockResolvedValueOnce({ apiKey: "short" });

			await main(["configure"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("***");
		});

		it("should render array config values as comma-joined strings", async () => {
			const { loadConfig } = await import("./core/SessionTracker.js");
			// Use the cast through unknown so TS accepts an ad-hoc array-typed config entry.
			vi.mocked(loadConfig).mockResolvedValueOnce({
				excludePatterns: ["*.log", "dist/"],
			} as unknown as Awaited<ReturnType<typeof loadConfig>>);

			await main(["configure"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("*.log, dist/");
		});

		it("should set a config value with --set key=value", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");

			await main(["configure", "--set", "model=claude-sonnet-4-6"]);

			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-4-6" }));
		});

		it("should coerce numeric values for maxTokens", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");

			await main(["configure", "--set", "maxTokens=8192"]);

			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 8192 }));
		});

		it("should coerce boolean values for flag fields", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");

			await main(["configure", "--set", "codexEnabled=false"]);

			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ codexEnabled: false }));
		});

		it("should accept 'yes'/'1' as truthy for boolean fields", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");

			await main(["configure", "--set", "geminiEnabled=yes"]);

			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ geminiEnabled: true }));
		});

		it("should accept openCodeEnabled=true/false", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");

			await main(["configure", "--set", "openCodeEnabled=false"]);
			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ openCodeEnabled: false }));

			vi.mocked(saveConfig).mockClear();
			await main(["configure", "--set", "openCodeEnabled=true"]);
			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ openCodeEnabled: true }));
		});

		it("should reject openCodeEnabled with a non-boolean value", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await main(["configure", "--set", "openCodeEnabled=maybe"]);
				expect(saveConfig).not.toHaveBeenCalled();
				expect(process.exitCode).toBe(1);
				const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
				expect(errorOutput).toContain("openCodeEnabled");
				expect(errorOutput).toContain("true/false");
			} finally {
				errorSpy.mockRestore();
			}
		});

		it("--list-keys includes openCodeEnabled", async () => {
			await main(["configure", "--list-keys"]);
			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("openCodeEnabled");
			// Description should mention the Node version requirement — this is
			// the only config key that's runtime-gated and users deserve the hint.
			expect(output).toContain("Node 22.5+");
		});

		it("should accept cursorEnabled=true/false", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");

			await main(["configure", "--set", "cursorEnabled=false"]);
			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ cursorEnabled: false }));

			vi.mocked(saveConfig).mockClear();
			await main(["configure", "--set", "cursorEnabled=true"]);
			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ cursorEnabled: true }));
		});

		it("should reject cursorEnabled with a non-boolean value", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await main(["configure", "--set", "cursorEnabled=maybe"]);
				expect(saveConfig).not.toHaveBeenCalled();
				expect(process.exitCode).toBe(1);
				const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
				expect(errorOutput).toContain("cursorEnabled");
				expect(errorOutput).toContain("true/false");
			} finally {
				errorSpy.mockRestore();
			}
		});

		it("--list-keys includes cursorEnabled", async () => {
			await main(["configure", "--list-keys"]);
			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("cursorEnabled");
			// Description should mention the Node version requirement.
			expect(output).toContain("Node 22.5+");
		});

		it("should reject invalid --set format", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();

			await main(["configure", "--set", "invalidformat"]);

			expect(saveConfig).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		});

		it("should reject unknown config keys on --set", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();

			await main(["configure", "--set", "unknownKey=value"]);

			expect(saveConfig).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		});

		it("should reject invalid numeric value", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();

			await main(["configure", "--set", "maxTokens=not-a-number"]);

			expect(saveConfig).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		});

		it("should reject partially numeric value (parseInt trap)", async () => {
			// Regression: parseInt("8192abc") silently returned 8192.
			// Using Number() instead — Number("8192abc") === NaN — makes this fail validation.
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();
			process.exitCode = 0;

			await main(["configure", "--set", "maxTokens=8192abc"]);

			expect(saveConfig).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		});

		it("should reject non-integer numeric value", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();
			process.exitCode = 0;

			await main(["configure", "--set", "maxTokens=8192.5"]);

			expect(saveConfig).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		});

		it("should reject invalid boolean value", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();

			await main(["configure", "--set", "codexEnabled=maybe"]);

			expect(saveConfig).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		});

		it("should remove a config value with --remove key", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");

			await main(["configure", "--remove", "apiKey"]);

			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
		});

		it("should reject unknown config keys on --remove", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();

			await main(["configure", "--remove", "unknownKey"]);

			expect(saveConfig).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		});

		it("should reject invalid logLevel value", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();
			process.exitCode = 0;

			await main(["configure", "--set", "logLevel=banana"]);

			expect(saveConfig).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
		});

		it("should accept valid logLevel values", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");

			await main(["configure", "--set", "logLevel=debug"]);

			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ logLevel: "debug" }));
		});

		it("should coerce excludePatterns as comma-separated array", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");

			await main(["configure", "--set", "excludePatterns=*.log,dist/**,node_modules"]);

			expect(saveConfig).toHaveBeenCalledWith(
				expect.objectContaining({ excludePatterns: ["*.log", "dist/**", "node_modules"] }),
			);
		});

		it("should reject a jolliApiKey whose embedded origin is off the allowlist", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();

			// Build a real key whose embedded meta decodes to an off-allowlist origin —
			// mocking parseJolliApiKey wouldn't work here because validateJolliApiKey
			// calls into the same module (vi.mock doesn't intercept intra-module refs).
			const evilMeta = { t: "x", u: "https://evil.com" };
			const encoded = Buffer.from(JSON.stringify(evilMeta)).toString("base64url");
			const evilKey = `sk-jol-${encoded}.secretbytes`;

			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await main(["configure", "--set", `jolliApiKey=${evilKey}`]);
				expect(saveConfig).not.toHaveBeenCalled();
				expect(process.exitCode).toBe(1);
				const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
				expect(errorOutput).toContain("evil.com");
			} finally {
				errorSpy.mockRestore();
			}
		});

		it("should accept a jolliApiKey whose embedded origin is on the allowlist", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();

			const goodMeta = { t: "tenant1", u: "https://tenant1.jolli.ai" };
			const encoded = Buffer.from(JSON.stringify(goodMeta)).toString("base64url");
			const goodKey = `sk-jol-${encoded}.secretbytes`;

			await main(["configure", "--set", `jolliApiKey=${goodKey}`]);

			expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ jolliApiKey: goodKey }));
		});

		it("should reject a jolliApiKey that cannot be decoded (legacy no-meta shape)", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();
			// Default parseJolliApiKey mock returns null.

			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await main(["configure", "--set", "jolliApiKey=sk-jol-legacyhex32chars"]);
				expect(saveConfig).not.toHaveBeenCalled();
				expect(process.exitCode).toBe(1);
				const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
				expect(errorOutput).toContain("cannot be decoded");
			} finally {
				errorSpy.mockRestore();
			}
		});

		it("should reject a jolliApiKey that does not start with sk-jol-", async () => {
			const { saveConfig } = await import("./core/SessionTracker.js");
			vi.mocked(saveConfig).mockClear();

			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				await main(["configure", "--set", "jolliApiKey=sf-jol-garbage"]);
				expect(saveConfig).not.toHaveBeenCalled();
				expect(process.exitCode).toBe(1);
				const errorOutput = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
				expect(errorOutput).toContain("cannot be decoded");
			} finally {
				errorSpy.mockRestore();
			}
		});

		it("should list all config keys with --list-keys", async () => {
			await main(["configure", "--list-keys"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("apiKey");
			expect(output).toContain("logLevel");
			expect(output).toContain("excludePatterns");
			expect(output).toContain("Available config keys");
		});
	});

	// ── doctor command ──────────────────────────────────────────────────
	describe("doctor command", () => {
		async function runDoctor(
			args: string[] = ["doctor"],
			overrides: {
				gitHookInstalled?: boolean;
				claudeHookInstalled?: boolean;
				geminiHookInstalled?: boolean;
				lockStale?: boolean;
				activeQueue?: number;
				apiKey?: string;
				orphanBranch?: boolean;
				/** Per-source registry entries. Empty array = no sources registered. */
				distPaths?: Array<{ source: string; version: string; distDir: string; available: boolean }>;
			} = {},
		): Promise<string[]> {
			const { getStatus } = await import("./install/Installer.js");
			const { isLockStale, countActiveQueueEntries, loadConfig, loadAllSessions } = await import(
				"./core/SessionTracker.js"
			);
			const { orphanBranchExists } = await import("./core/GitOps.js");
			const { traverseDistPaths } = await import("./install/DistPathResolver.js");

			// Reset (prevent bleed-over from prior tests' mockResolvedValueOnce)
			vi.mocked(getStatus).mockReset();
			vi.mocked(isLockStale).mockReset();
			vi.mocked(countActiveQueueEntries).mockReset();
			vi.mocked(loadConfig).mockReset();
			vi.mocked(loadAllSessions).mockReset();
			vi.mocked(orphanBranchExists).mockReset();
			vi.mocked(traverseDistPaths).mockReset();

			vi.mocked(getStatus).mockResolvedValue({
				enabled: true,
				claudeHookInstalled: overrides.claudeHookInstalled ?? true,
				gitHookInstalled: overrides.gitHookInstalled ?? true,
				geminiHookInstalled: overrides.geminiHookInstalled ?? true,
				activeSessions: 0,
				mostRecentSession: null,
				summaryCount: 0,
				orphanBranch: "jollimemory/summaries/v3",
			});
			vi.mocked(isLockStale).mockResolvedValue(overrides.lockStale ?? false);
			vi.mocked(countActiveQueueEntries).mockResolvedValue(overrides.activeQueue ?? 0);
			vi.mocked(loadConfig).mockResolvedValue(overrides.apiKey ? { apiKey: overrides.apiKey } : {});
			vi.mocked(loadAllSessions).mockResolvedValue([]);
			vi.mocked(orphanBranchExists).mockResolvedValue(overrides.orphanBranch ?? true);
			// Default: one healthy `dist-paths/cli` entry. Tests can override.
			vi.mocked(traverseDistPaths).mockReturnValue(
				overrides.distPaths ?? [{ source: "cli", version: "0.97.12", distDir: "/mock/dist", available: true }],
			);

			vi.mocked(console.log).mockClear();
			await main(args);
			return vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
		}

		it("should print all-clear when system is healthy", async () => {
			const output = (await runDoctor(["doctor"], { apiKey: "sk-ant-configured" })).join("\n");

			expect(output).toContain("Jolli Memory Doctor");
			expect(output).toContain("✓ Git hooks");
			expect(output).toContain("✓ Lock file");
			expect(output).toContain("✓ Config");
			expect(output).toContain("✓ dist-paths/cli");
			expect(output).not.toContain("Run with --fix");
		});

		it("should flag missing Git hooks as fail", async () => {
			const output = (await runDoctor(["doctor"], { gitHookInstalled: false })).join("\n");
			expect(output).toContain("✗ Git hooks");
			expect(output).toContain("not installed");
		});

		it("should flag stuck lock file as fail", async () => {
			const output = (await runDoctor(["doctor"], { lockStale: true })).join("\n");
			expect(output).toContain("✗ Lock file");
			expect(output).toContain("stuck");
		});

		it("should flag high active queue as warn", async () => {
			const output = (await runDoctor(["doctor"], { activeQueue: 15 })).join("\n");
			expect(output).toContain("⚠ Git queue");
			expect(output).toContain("15 entries");
			expect(output).toContain("Worker may be stuck");
		});

		it("should flag missing API key as warn", async () => {
			// Scrub env var so the doctor's anthropic-env fallback doesn't mask this case.
			const original = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;
			try {
				const output = (await runDoctor()).join("\n");
				// Default mock has no apiKey → should be warn
				expect(output).toContain("⚠ Config");
				expect(output).toContain("no credentials");
			} finally {
				if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
			}
		});

		it("should accept ANTHROPIC_API_KEY env var as a valid credential source", async () => {
			const original = process.env.ANTHROPIC_API_KEY;
			process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
			try {
				const output = (await runDoctor()).join("\n");
				// No config apiKey, but env var is set → should be ok (via anthropic-env)
				expect(output).toContain("✓ Config");
				expect(output).toContain("ANTHROPIC_API_KEY env");
			} finally {
				if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
				else process.env.ANTHROPIC_API_KEY = original;
			}
		});

		it("should warn when orphan branch does not exist", async () => {
			const output = (await runDoctor(["doctor"], { orphanBranch: false, apiKey: "sk-ant-test" })).join("\n");
			expect(output).toContain("⚠ Orphan branch");
			expect(output).toContain("not yet created");
		});

		it("should flag missing dist-paths as fail", async () => {
			const output = (await runDoctor(["doctor"], { distPaths: [] })).join("\n");
			expect(output).toContain("✗ dist-paths");
		});

		it("should warn about stale dist-paths/<source> entries (path missing)", async () => {
			const output = (
				await runDoctor(["doctor"], {
					distPaths: [
						{ source: "cli", version: "0.97.5", distDir: "/cli/dist", available: true },
						{ source: "cursor", version: "0.96.0", distDir: "/missing/dist", available: false },
					],
				})
			).join("\n");
			expect(output).toContain("✓ dist-paths/cli");
			expect(output).toContain("⚠ dist-paths/cursor");
			expect(output).toContain("MISSING");
		});

		it("should auto-fix stale dist-paths entry when --fix is passed", async () => {
			const mockUnlink = vi.fn().mockResolvedValue(undefined);
			vi.doMock("node:fs/promises", async (importOriginal) => {
				const original = await importOriginal<typeof import("node:fs/promises")>();
				return { ...original, unlink: mockUnlink };
			});

			const output = (
				await runDoctor(["doctor", "--fix"], {
					distPaths: [{ source: "stale-src", version: "0.90.0", distDir: "/gone/dist", available: false }],
				})
			).join("\n");
			expect(output).toContain("Applying fixes");
			// The fixer function calls unlink to remove the stale entry
			vi.doUnmock("node:fs/promises");
		});

		it("should auto-fix stale lock when --fix is passed", async () => {
			const { releaseLock } = await import("./core/SessionTracker.js");
			vi.mocked(releaseLock).mockClear();

			const output = (await runDoctor(["doctor", "--fix"], { lockStale: true })).join("\n");

			expect(releaseLock).toHaveBeenCalled();
			expect(output).toContain("Applying fixes");
			expect(output).toContain("released");
		});

		it("should auto-reinstall missing hooks when --fix is passed", async () => {
			const { install } = await import("./install/Installer.js");
			vi.mocked(install).mockClear();
			vi.mocked(install).mockResolvedValueOnce({ success: true, message: "ok", warnings: [] });

			await runDoctor(["doctor", "--fix"], { gitHookInstalled: false });

			expect(install).toHaveBeenCalled();
		});

		it("should prompt user to run --fix when failures found without --fix", async () => {
			process.exitCode = 0;
			const output = (await runDoctor(["doctor"], { lockStale: true })).join("\n");
			expect(output).toContain("Run with --fix");
			// CI must see a non-zero exit code when doctor reports ✗.
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;
		});

		it("should NOT set exitCode when doctor reports only warnings", async () => {
			process.exitCode = 0;
			// Only warns (missing Claude hook is optional) — no failures.
			await runDoctor(["doctor"], { claudeHookInstalled: false, apiKey: "sk-ant-test" });
			expect(process.exitCode).toBe(0);
		});

		it("should set exitCode=1 when a --fix fixer throws", async () => {
			const { install } = await import("./install/Installer.js");
			vi.mocked(install).mockClear();
			// Simulate install failing — fixer contract is "throw on failure",
			// so we make install resolve with success=false which the fixer
			// converts to a thrown error.
			vi.mocked(install).mockResolvedValueOnce({ success: false, message: "disk full", warnings: [] });
			process.exitCode = 0;

			const output = (await runDoctor(["doctor", "--fix"], { gitHookInstalled: false })).join("\n");

			// Failed fixer must render with ✗ (not a false-positive ✓) and
			// its error message must be surfaced.
			expect(output).toContain("✗ Git hooks");
			expect(output).toContain("disk full");
			expect(output).toContain("1 fix failed");
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;
		});

		it("should set exitCode=1 when --fix runs but fail check has no fixer (Gap A)", async () => {
			// Regression: dist-path failure has no fixer — doctor --fix used to
			// skip it entirely and exit 0 despite the ✗.
			process.exitCode = 0;

			const output = (await runDoctor(["doctor", "--fix"], { distPaths: [], apiKey: "sk-ant-test" })).join("\n");

			expect(output).toContain("✗ dist-paths");
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;
		});

		it("should set exitCode=1 when --fix repairs some but unfixable failures remain (Gap B)", async () => {
			// Lock fixer succeeds; dist-path has no fixer and stays broken.
			const { releaseLock } = await import("./core/SessionTracker.js");
			vi.mocked(releaseLock).mockClear();
			process.exitCode = 0;

			const output = (
				await runDoctor(["doctor", "--fix"], {
					lockStale: true,
					distPaths: [],
					apiKey: "sk-ant-test",
				})
			).join("\n");

			expect(releaseLock).toHaveBeenCalled();
			expect(output).toContain("✗ dist-paths");
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;
		});

		it("should set exitCode=1 when --fix has nothing to fix but ✗ remains (Gap C)", async () => {
			// --fix passed, but the only failure is dist-path which has no fixer,
			// so fixesToApply is empty. Must still exit 1 — the ✗ is still there.
			const { install } = await import("./install/Installer.js");
			const { releaseLock } = await import("./core/SessionTracker.js");
			vi.mocked(install).mockClear();
			vi.mocked(releaseLock).mockClear();
			process.exitCode = 0;

			const output = (await runDoctor(["doctor", "--fix"], { distPaths: [], apiKey: "sk-ant-test" })).join("\n");

			// No "Applying fixes" because nothing to fix, but exitCode must still signal the fault.
			expect(output).not.toContain("Applying fixes");
			expect(output).toContain("✗ dist-paths");
			expect(install).not.toHaveBeenCalled();
			expect(releaseLock).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;
		});
	});

	// ── clean command ───────────────────────────────────────────────────
	describe("clean command", () => {
		async function runClean(
			args: string[] = ["clean"],
			overrides: {
				childHashes?: string[];
				orphanSummaries?: string[];
				orphanTranscripts?: string[];
				staleSessions?: number;
				staleQueue?: number;
				staleSquash?: boolean;
			} = {},
		): Promise<string[]> {
			const { getIndex } = await import("./core/SummaryStore.js");
			const { listFilesInBranch, writeMultipleFilesToBranch } = await import("./core/GitOps.js");
			const { countStaleSessions, countStaleQueueEntries, checkStaleSquashPending } = await import(
				"./core/SessionTracker.js"
			);

			// Reset mocks (clears prior mockResolvedValueOnce queues from other tests)
			vi.mocked(getIndex).mockReset();
			vi.mocked(listFilesInBranch).mockReset();
			vi.mocked(countStaleSessions).mockReset();
			vi.mocked(countStaleQueueEntries).mockReset();
			vi.mocked(checkStaleSquashPending).mockReset();
			vi.mocked(writeMultipleFilesToBranch).mockReset();

			if (overrides.childHashes && overrides.childHashes.length > 0) {
				vi.mocked(getIndex).mockResolvedValue({
					version: 3,
					entries: overrides.childHashes.map((h) => ({
						commitHash: h,
						parentCommitHash: "root",
						branch: "main",
						commitMessage: "test",
						commitDate: "2026-04-01T00:00:00.000Z",
						generatedAt: "2026-04-01T00:00:00.000Z",
					})),
				});
			} else {
				vi.mocked(getIndex).mockResolvedValue(null);
			}

			vi.mocked(listFilesInBranch)
				.mockResolvedValueOnce(overrides.orphanSummaries ?? [])
				.mockResolvedValueOnce(overrides.orphanTranscripts ?? []);
			vi.mocked(countStaleSessions).mockResolvedValue(overrides.staleSessions ?? 0);
			vi.mocked(countStaleQueueEntries).mockResolvedValue(overrides.staleQueue ?? 0);
			vi.mocked(checkStaleSquashPending).mockResolvedValue(overrides.staleSquash ?? false);
			vi.mocked(writeMultipleFilesToBranch).mockResolvedValue(undefined);

			vi.mocked(console.log).mockClear();
			await main(args);
			return vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
		}

		it("should report nothing to clean when all is current", async () => {
			const output = (await runClean()).join("\n");
			expect(output).toContain("Jolli Memory Clean");
			expect(output).toContain("Nothing to clean");
		});

		it("no longer scans or reports orphan summary/transcript files", async () => {
			// Under unified Hoist (schema v4) the per-child summary file is the
			// ONLY copy of original topics/recap (the embedded child gets stripped).
			// Transcripts have always been by-hash files. clean must not delete
			// either; the section is removed from the output entirely.
			const hash = "abc1234567890abcdef";
			const output = (
				await runClean(["clean", "--dry-run"], {
					childHashes: [hash],
					orphanSummaries: [`summaries/${hash}.json`],
					orphanTranscripts: [`transcripts/${hash}.json`],
				})
			).join("\n");

			expect(output).not.toContain("Orphan summaries:");
			expect(output).not.toContain("Orphan transcripts:");
			expect(output).toContain("Nothing to clean");
		});

		it("should detect stale sessions/queue/squash-pending", async () => {
			const output = (
				await runClean(["clean", "--dry-run"], {
					staleSessions: 3,
					staleQueue: 2,
					staleSquash: true,
				})
			).join("\n");

			expect(output).toContain("Stale sessions:       3 entries");
			expect(output).toContain("Stale Git queue:      2 entries");
			expect(output).toContain("Stale squash-pending: 1 file");
			expect(output).toContain("Would remove 6 items");
		});

		it("does not surface orphan summaries in the output", async () => {
			const childHash = "abc1111111111111111";
			const rootHash = "def2222222222222222";
			const output = (
				await runClean(["clean", "--dry-run"], {
					childHashes: [childHash],
					orphanSummaries: [`summaries/${childHash}.json`, `summaries/${rootHash}.json`],
				})
			).join("\n");

			expect(output).not.toContain("Orphan summaries:");
		});

		it("performs only the stale-data deletions when confirmed with --yes (no orphan files touched)", async () => {
			const { writeMultipleFilesToBranch } = await import("./core/GitOps.js");
			const { pruneStaleSessions, pruneStaleQueueEntries, deleteSquashPending } = await import(
				"./core/SessionTracker.js"
			);
			vi.mocked(writeMultipleFilesToBranch).mockClear();
			vi.mocked(pruneStaleSessions).mockResolvedValueOnce(2);
			vi.mocked(pruneStaleQueueEntries).mockResolvedValueOnce(1);

			const hash = "abc1234567890abcdef";
			const output = (
				await runClean(["clean", "--yes"], {
					// Even when callers stage orphan files, clean must not delete them.
					childHashes: [hash],
					orphanSummaries: [`summaries/${hash}.json`],
					staleSessions: 2,
					staleQueue: 1,
					staleSquash: true,
				})
			).join("\n");

			// The orphan-file deletion path (writeMultipleFilesToBranch with deletes)
			// is removed entirely. Stale data path is unchanged.
			expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
			expect(pruneStaleSessions).toHaveBeenCalled();
			expect(pruneStaleQueueEntries).toHaveBeenCalled();
			expect(deleteSquashPending).toHaveBeenCalled();
			expect(output).toContain("Removed");
		});

		it("should refuse to delete in non-TTY mode without --yes", async () => {
			// stdin.isTTY is false by default in the test setup. Without --yes,
			// clean must refuse rather than silently delete.
			const { writeMultipleFilesToBranch } = await import("./core/GitOps.js");
			const { pruneStaleSessions } = await import("./core/SessionTracker.js");
			vi.mocked(writeMultipleFilesToBranch).mockClear();
			vi.mocked(pruneStaleSessions).mockClear();
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			process.exitCode = 0;

			try {
				await runClean(["clean"], { staleSessions: 2 });

				const errorCalls = errorSpy.mock.calls.map((c) => String(c[0]));
				expect(errorCalls.some((s) => s.includes("non-interactive"))).toBe(true);
				expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
				expect(pruneStaleSessions).not.toHaveBeenCalled();
				expect(process.exitCode).toBe(1);
			} finally {
				errorSpy.mockRestore();
				process.exitCode = 0;
			}
		});

		it("should cancel when user declines interactive prompt", async () => {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			try {
				mockCreateInterface.mockReturnValueOnce({
					question: (_q: string, cb: (a: string) => void) => cb("n"),
					close: vi.fn(),
				});
				const { writeMultipleFilesToBranch } = await import("./core/GitOps.js");
				vi.mocked(writeMultipleFilesToBranch).mockClear();

				const output = (
					await runClean(["clean"], {
						staleSessions: 1,
					})
				).join("\n");

				expect(output).toContain("Aborted");
				expect(writeMultipleFilesToBranch).not.toHaveBeenCalled();
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
			}
		});

		it("should proceed when user confirms interactive prompt with 'y'", async () => {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			try {
				mockCreateInterface.mockReturnValueOnce({
					question: (_q: string, cb: (a: string) => void) => cb("y"),
					close: vi.fn(),
				});
				const { pruneStaleSessions } = await import("./core/SessionTracker.js");
				vi.mocked(pruneStaleSessions).mockResolvedValueOnce(1);

				const output = (await runClean(["clean"], { staleSessions: 1 })).join("\n");

				expect(output).toContain("Removed");
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
			}
		});
	});

	// ── recall command — --full and --output paths ──────────────────────
	describe("recall --full and --output", () => {
		beforeEach(() => {
			mockExecFileSync.mockReturnValue("/tmp/test-project\n");
		});

		it("should output full markdown when --full is passed", async () => {
			vi.mocked(listBranchCatalog).mockReset();
			vi.mocked(compileTaskContext).mockReset();
			vi.mocked(renderContextMarkdown).mockReset();
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/test",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["test"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/test",
				period: { start: "2026-04-01", end: "2026-04-01" },
				commitCount: 1,
				totalFilesChanged: 3,
				totalInsertions: 10,
				totalDeletions: 0,
				summaries: [
					{
						version: 3,
						commitHash: "abc1234567890abcdef",
						commitMessage: "test commit",
						commitAuthor: "tester",
						commitDate: "2026-04-01T00:00:00.000Z",
						branch: "feature/test",
						generatedAt: "2026-04-01T00:00:00.000Z",
						topics: [],
						children: [],
					},
				],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 5000,
				},
			});
			vi.mocked(renderContextMarkdown).mockReturnValueOnce("# Full Markdown Context");

			await main(["recall", "feature/test", "--full", "--cwd", "/tmp/test"]);

			expect(console.log).toHaveBeenCalledWith("# Full Markdown Context");
		});

		it("should default to short summary when no flags passed", async () => {
			vi.mocked(listBranchCatalog).mockReset();
			vi.mocked(compileTaskContext).mockReset();
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/test",
						commitCount: 2,
						period: { start: "2026-04-01", end: "2026-04-03" },
						commitMessages: ["a", "b"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/test",
				period: { start: "2026-04-01T00:00:00.000Z", end: "2026-04-03T00:00:00.000Z" },
				commitCount: 2,
				totalFilesChanged: 7,
				totalInsertions: 20,
				totalDeletions: 5,
				summaries: [
					{
						version: 3,
						commitHash: "aaaabbbbccccddddeeee",
						commitMessage: "Initial feature",
						commitAuthor: "dev",
						commitDate: "2026-04-01T00:00:00.000Z",
						branch: "feature/test",
						generatedAt: "2026-04-01T00:00:00.000Z",
						topics: [
							{
								title: "t1",
								category: "feature",
								importance: "major",
								trigger: "",
								response: "",
								decisions: "",
								todo: "",
							},
						],
						children: [],
					},
					{
						version: 3,
						commitHash: "bbbbccccddddeeeeffff",
						commitMessage: "Fix login email validation",
						commitAuthor: "dev",
						commitDate: "2026-04-03T00:00:00.000Z",
						branch: "feature/test",
						generatedAt: "2026-04-03T00:00:00.000Z",
						topics: [
							{
								title: "t2",
								category: "bugfix",
								importance: "major",
								trigger: "",
								response: "",
								decisions: "",
								todo: "",
							},
						],
						children: [],
					},
				],
				plans: [],
				notes: [],
				keyDecisions: [{ text: "Use JWT over sessions", commitHash: "aaaabbbbccccddddeeee" }],
				stats: {
					topicCount: 2,
					planCount: 0,
					noteCount: 0,
					decisionCount: 1,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 100,
				},
			});

			await main(["recall", "feature/test", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("feature/test");
			expect(output).toContain("2 commits");
			expect(output).toContain("Fix login email validation");
			expect(output).toContain("Topics:");
			expect(output).toContain("Key decisions:");
			expect(output).toContain("Files changed: 7");
			expect(output).toContain("Run with --full");
		});

		it("should write full context to file with --output", async () => {
			vi.mocked(listBranchCatalog).mockReset();
			vi.mocked(compileTaskContext).mockReset();
			vi.mocked(renderContextMarkdown).mockReset();
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/test",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["test"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/test",
				period: { start: "2026-04-01", end: "2026-04-01" },
				commitCount: 3,
				totalFilesChanged: 0,
				totalInsertions: 0,
				totalDeletions: 0,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 1234,
				},
			});
			vi.mocked(renderContextMarkdown).mockReturnValueOnce("# Context");

			const os = await import("node:os");
			const outputPath = `${os.tmpdir()}/jolli-recall-test.md`;

			await main(["recall", "feature/test", "--output", outputPath, "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			expect(output).toContain("Context written");
			expect(output).toContain("1,234 tokens");
			expect(output).toContain("3 commits");

			// Verify file exists and contains markdown
			const fs = await import("node:fs/promises");
			const content = await fs.readFile(outputPath, "utf-8");
			expect(content).toBe("# Context");
			await fs.unlink(outputPath);
		});

		it("should create nested parent directories for --output (no ENOENT)", async () => {
			// Regression: `--output some/nested/path.md` on a fresh repo used to
			// ENOENT because fs.writeFile does not create parent dirs. The tool
			// must now `mkdir -p` the parent automatically.
			vi.mocked(listBranchCatalog).mockReset();
			vi.mocked(compileTaskContext).mockReset();
			vi.mocked(renderContextMarkdown).mockReset();
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/test",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["test"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/test",
				period: { start: "2026-04-01", end: "2026-04-01" },
				commitCount: 1,
				totalFilesChanged: 0,
				totalInsertions: 0,
				totalDeletions: 0,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 1,
				},
			});
			vi.mocked(renderContextMarkdown).mockReturnValueOnce("# Nested");

			const os = await import("node:os");
			const path = await import("node:path");
			const fs = await import("node:fs/promises");
			// Guaranteed-not-to-exist nested path under tmpdir.
			const nestedRoot = path.join(os.tmpdir(), `jolli-recall-mkdir-${Date.now()}`);
			const outputPath = path.join(nestedRoot, "deep", "sub", "ctx.md");

			try {
				await main(["recall", "feature/test", "--output", outputPath, "--cwd", "/tmp/test"]);

				const content = await fs.readFile(outputPath, "utf-8");
				expect(content).toBe("# Nested");
			} finally {
				await fs.rm(nestedRoot, { recursive: true, force: true });
			}
		});
	});

	// ── auth commands ────────────────────────────────────────────────────
	describe("auth commands", () => {
		it("should show 'Not signed in' when no auth token", async () => {
			const { loadConfig } = await import("./core/SessionTracker.js");
			// loadAuthToken() calls loadConfig once, then the action calls loadConfig again
			vi.mocked(loadConfig).mockResolvedValueOnce({}).mockResolvedValueOnce({});

			await main(["auth", "status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Not signed in"))).toBe(true);
		});

		it("should show 'Signed in' when auth token exists", async () => {
			const { loadConfig } = await import("./core/SessionTracker.js");
			const configWithToken = { authToken: "test-token" };
			// loadAuthToken() calls loadConfig once, then the action calls loadConfig again
			vi.mocked(loadConfig).mockResolvedValueOnce(configWithToken).mockResolvedValueOnce(configWithToken);

			await main(["auth", "status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Signed in"))).toBe(true);
		});

		it("should show Jolli API Key configured in status", async () => {
			const { loadConfig } = await import("./core/SessionTracker.js");
			// loadAuthToken() calls loadConfig once, then the action calls loadConfig again
			const configWithKey = { jolliApiKey: "jk_test" };
			vi.mocked(loadConfig).mockResolvedValueOnce(configWithKey).mockResolvedValueOnce(configWithKey);

			await main(["auth", "status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Jolli API Key:  Configured"))).toBe(true);
		});

		it("should show 'Not configured' for missing Jolli API Key when signed in without it", async () => {
			// Partial-setup case: OAuth succeeded but no API key was generated.
			const { loadConfig } = await import("./core/SessionTracker.js");
			const partialConfig = { authToken: "tok" };
			vi.mocked(loadConfig).mockResolvedValueOnce(partialConfig).mockResolvedValueOnce(partialConfig);

			await main(["auth", "status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Jolli API Key:  Not configured"))).toBe(true);
		});

		it("should show no-credentials message when nothing configured", async () => {
			const { loadConfig } = await import("./core/SessionTracker.js");
			// loadAuthToken() calls loadConfig once, then the action calls loadConfig again
			vi.mocked(loadConfig).mockResolvedValueOnce({}).mockResolvedValueOnce({});
			const origKey = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;

			try {
				await main(["auth", "status"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("No credentials configured"))).toBe(true);
			} finally {
				if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
			}
		});

		it("should clear auth token on logout", async () => {
			const { saveConfig, loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfig).mockResolvedValueOnce({});
			vi.mocked(saveConfig).mockResolvedValueOnce(undefined);

			await main(["auth", "logout"]);

			expect(saveConfig).toHaveBeenCalledWith({ authToken: undefined });
		});

		it("should show API key reminder when Anthropic key remains after logout", async () => {
			const { saveConfig, loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfig).mockResolvedValueOnce({ apiKey: "sk-test" });
			vi.mocked(saveConfig).mockResolvedValueOnce(undefined);

			await main(["auth", "logout"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Auth token and Jolli API Key have been removed"))).toBe(true);
			expect(calls.some((s) => s.includes("Anthropic API Key"))).toBe(true);
		});

		it("should call browserLogin on auth login", async () => {
			const { browserLogin } = await import("./auth/Login.js");
			vi.mocked(browserLogin).mockResolvedValueOnce(undefined);

			await main(["auth", "login"]);

			// browserLogin receives the Jolli origin (not the full /login URL) —
			// it appends `/login` and the cli_callback params internally.
			expect(browserLogin).toHaveBeenCalledTimes(1);
			expect(browserLogin).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/[^/]+$/));
		});

		it("should report Jolli API Key saved when login yields jolliApiKey", async () => {
			const { browserLogin } = await import("./auth/Login.js");
			const { loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(browserLogin).mockResolvedValueOnce(undefined);
			// After a successful login, loadConfig sees the freshly-persisted jolliApiKey.
			vi.mocked(loadConfig).mockResolvedValueOnce({ jolliApiKey: "jk_test" });

			vi.mocked(console.log).mockClear();
			await main(["auth", "login"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Jolli API Key:") && s.includes("saved"))).toBe(true);
		});

		it("should handle login failure gracefully", async () => {
			const { browserLogin } = await import("./auth/Login.js");
			vi.mocked(browserLogin).mockRejectedValueOnce(new Error("Connection refused"));
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			try {
				await main(["auth", "login"]);

				expect(errorSpy).toHaveBeenCalledWith("\n  Login failed:", "Connection refused");
				expect(process.exitCode).toBe(1);
			} finally {
				errorSpy.mockRestore();
			}
		});

		it("should not show Anthropic Key in auth status (managed via configure)", async () => {
			const { loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfig)
				.mockResolvedValueOnce({ apiKey: "sk-ant-test" })
				.mockResolvedValueOnce({ apiKey: "sk-ant-test" });

			await main(["auth", "status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Anthropic"))).toBe(false);
		});

		it("should clear both authToken and jolliApiKey on logout", async () => {
			const { saveConfig, loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfig).mockResolvedValueOnce({ jolliApiKey: "jk_test" });
			vi.mocked(saveConfig).mockResolvedValueOnce(undefined);

			await main(["auth", "logout"]);

			expect(saveConfig).toHaveBeenCalledWith(
				expect.objectContaining({ authToken: undefined, jolliApiKey: undefined }),
			);
			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Auth token and Jolli API Key have been removed"))).toBe(true);
		});
	});

	// ── Status: falsy config branches ──────────────────────────────────
	describe("status command — falsy config branches", () => {
		it("should show 'Not signed in' when authToken is absent", async () => {
			const { loadConfigFromDir, loadConfig } = await import("./core/SessionTracker.js");
			// Return config without authToken from both the display-config load and loadAuthToken()'s load.
			vi.mocked(loadConfigFromDir).mockResolvedValueOnce({});
			vi.mocked(loadConfig).mockResolvedValueOnce({});

			await main(["status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Jolli Account:") && s.includes("Not signed in"))).toBe(true);
		});

		it("should show 'Signed in' when authToken is present in config", async () => {
			const { loadConfigFromDir, loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfigFromDir).mockResolvedValueOnce({ authToken: "tok_123" });
			// loadAuthToken() falls back to loadConfig() when JOLLI_AUTH_TOKEN is unset.
			vi.mocked(loadConfig).mockResolvedValueOnce({ authToken: "tok_123" });

			await main(["status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Jolli Account:") && s.includes("Signed in"))).toBe(true);
		});

		it("should show 'Signed in' when only JOLLI_AUTH_TOKEN env var is set (no authToken in config)", async () => {
			const { loadConfigFromDir, loadConfig } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfigFromDir).mockResolvedValueOnce({});
			vi.mocked(loadConfig).mockResolvedValueOnce({});
			const orig = process.env.JOLLI_AUTH_TOKEN;
			process.env.JOLLI_AUTH_TOKEN = "env_tok";

			try {
				await main(["status"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Jolli Account:") && s.includes("Signed in"))).toBe(true);
			} finally {
				if (orig !== undefined) {
					process.env.JOLLI_AUTH_TOKEN = orig;
				} else {
					delete process.env.JOLLI_AUTH_TOKEN;
				}
			}
		});

		it("should show 'Not configured' for Anthropic Key when neither config.apiKey nor env var is set", async () => {
			const { loadConfigFromDir } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfigFromDir).mockResolvedValueOnce({});
			const origKey = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;

			try {
				await main(["status"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Anthropic Key:") && s.includes("Not configured"))).toBe(true);
			} finally {
				if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
			}
		});

		it("should show 'Configured' for Anthropic Key when config.apiKey is set", async () => {
			const { loadConfigFromDir } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfigFromDir).mockResolvedValueOnce({ apiKey: "sk-ant-test123" });

			await main(["status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Anthropic Key:") && s.includes("Configured"))).toBe(true);
		});

		it("should show 'Configured' for Anthropic Key from ANTHROPIC_API_KEY env var", async () => {
			const { loadConfigFromDir } = await import("./core/SessionTracker.js");
			vi.mocked(loadConfigFromDir).mockResolvedValueOnce({});
			const origKey = process.env.ANTHROPIC_API_KEY;
			process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";

			try {
				await main(["status"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Anthropic Key:") && s.includes("Configured"))).toBe(true);
			} finally {
				if (origKey !== undefined) {
					process.env.ANTHROPIC_API_KEY = origKey;
				} else {
					delete process.env.ANTHROPIC_API_KEY;
				}
			}
		});
	});

	// ── Enable: browser login with jolliApiKey saved ──────────────────
	describe("enable — browser login saves jolliApiKey", () => {
		/** Helper: mock createInterface to simulate user typing answers in sequence. */
		function mockUserInput(...answers: string[]): void {
			let callIndex = 0;
			mockCreateInterface.mockReturnValue({
				question: (_prompt: string, cb: (answer: string) => void) => {
					cb(answers[callIndex++] ?? "");
				},
				close: vi.fn(),
			});
		}

		it("should show 'Jolli API Key: saved' when browserLogin results in jolliApiKey being saved", async () => {
			const { loadConfigFromDir } = await import("./core/SessionTracker.js");
			// Choose "1" (browser login), then skip Anthropic key
			mockUserInput("1", "");
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			// loadConfigFromDir calls:
			// 1. initial check in promptSetup — empty config (show menu)
			// 2. after browserLogin in handleBrowserLogin — jolliApiKey saved
			// 3. after Jolli setup in promptSetup (updated config with jolliApiKey)
			// 4. final state check in promptAnthropicKey (has jolliApiKey, checking Anthropic)
			vi.mocked(loadConfigFromDir)
				.mockResolvedValueOnce({})
				.mockResolvedValueOnce({ jolliApiKey: "jk_from_login" })
				.mockResolvedValueOnce({ jolliApiKey: "jk_from_login" })
				.mockResolvedValueOnce({ jolliApiKey: "jk_from_login" });

			try {
				await main(["enable"]);

				const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
				expect(calls.some((s) => s.includes("Jolli API Key:     saved"))).toBe(true);
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
			}
		});
	});

	// ── Recall: fallback to resolveProjectDir when --cwd omitted ────────
	describe("recall — resolveProjectDir fallback", () => {
		it("should use resolveProjectDir when --cwd is not provided", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-toplevel")) return "/mock/project\n";
				if (a.includes("--show-current")) return "feature/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockReset();
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({ type: "catalog", branches: [] });

			await main(["recall", "--catalog"]);

			// listBranchCatalog should be called with the resolved project dir
			expect(listBranchCatalog).toHaveBeenCalled();
		});

		it("should write output to a bare filename without creating parent dir (parent='.')", async () => {
			// Exercises the `parent !== "."` falsy branch at line 211.
			// dirname("bare-output.md") returns "." — the mkdir should be skipped.
			vi.mocked(listBranchCatalog).mockReset();
			vi.mocked(compileTaskContext).mockReset();
			vi.mocked(renderContextMarkdown).mockReset();
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/test",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["test"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/test",
				period: { start: "2026-04-01", end: "2026-04-01" },
				commitCount: 1,
				totalFilesChanged: 0,
				totalInsertions: 0,
				totalDeletions: 0,
				summaries: [],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 0,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 10,
				},
			});
			vi.mocked(renderContextMarkdown).mockReturnValueOnce("# Bare");

			const fs = await import("node:fs/promises");
			// Use a bare filename (no directory prefix), so dirname returns "."
			const outputPath = `jolli-recall-bare-${Date.now()}.md`;

			try {
				await main(["recall", "feature/test", "--output", outputPath, "--cwd", "/tmp/test"]);

				const content = await fs.readFile(outputPath, "utf-8");
				expect(content).toBe("# Bare");
			} finally {
				await fs.unlink(outputPath).catch(() => {});
			}
		});
	});

	// ── Recall: topic without category ──────────────────────────────────
	describe("recall — topics without category in short summary", () => {
		it("should skip topics without a category in the short summary counts", async () => {
			vi.mocked(listBranchCatalog).mockReset();
			vi.mocked(compileTaskContext).mockReset();
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/test",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["test"],
					},
				],
			});
			vi.mocked(compileTaskContext).mockResolvedValueOnce({
				branch: "feature/test",
				period: { start: "2026-04-01T00:00:00.000Z", end: "2026-04-01T00:00:00.000Z" },
				commitCount: 1,
				totalFilesChanged: 2,
				totalInsertions: 5,
				totalDeletions: 1,
				summaries: [
					{
						version: 3,
						commitHash: "aaa1111111111111111",
						commitMessage: "topic test",
						commitAuthor: "dev",
						commitDate: "2026-04-01T00:00:00.000Z",
						branch: "feature/test",
						generatedAt: "2026-04-01T00:00:00.000Z",
						topics: [
							{
								title: "no-category topic",
								// No category field — exercises the falsy branch at line 116
								importance: "minor",
								trigger: "",
								response: "",
								decisions: "",
								todo: "",
							},
							{
								title: "with-category topic",
								category: "refactor",
								importance: "major",
								trigger: "",
								response: "",
								decisions: "",
								todo: "",
							},
						],
						children: [],
					},
				],
				plans: [],
				notes: [],
				keyDecisions: [],
				stats: {
					topicCount: 2,
					planCount: 0,
					noteCount: 0,
					decisionCount: 0,
					topicTokens: 0,
					planTokens: 0,
					noteTokens: 0,
					decisionTokens: 0,
					transcriptTokens: 0,
					totalTokens: 50,
				},
			});

			await main(["recall", "feature/test", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			// Only the topic with category should appear in the "Topics:" line
			expect(output).toContain("Topics:");
			expect(output).toContain("1 refactor");
			// The no-category topic should NOT appear in the Topics line
			expect(output).not.toContain("no-category");
		});
	});

	// ── Clean: parentCommitHash branch ──────────────────────────────────
	describe("clean — index entries with parentCommitHash", () => {
		it("does not scan or report orphan summary files even when child entries exist", async () => {
			const { countStaleSessions, countStaleQueueEntries, checkStaleSquashPending } = await import(
				"./core/SessionTracker.js"
			);
			vi.mocked(countStaleSessions).mockReset();
			vi.mocked(countStaleQueueEntries).mockReset();
			vi.mocked(checkStaleSquashPending).mockReset();
			vi.mocked(countStaleSessions).mockResolvedValue(0);
			vi.mocked(countStaleQueueEntries).mockResolvedValue(0);
			vi.mocked(checkStaleSquashPending).mockResolvedValue(false);

			vi.mocked(console.log).mockClear();
			await main(["clean", "--dry-run"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			// Output should never mention orphan summary/transcript files; clean
			// no longer touches them after the unified Hoist refactor.
			expect(output).not.toContain("Orphan summaries:");
			expect(output).not.toContain("Orphan transcripts:");
		});
	});

	// ── Auth: non-Error throw on login ──────────────────────────────────
	describe("auth — non-Error throw on login", () => {
		it("should handle non-Error throw in auth login", async () => {
			const { browserLogin } = await import("./auth/Login.js");
			vi.mocked(browserLogin).mockRejectedValueOnce("raw string error");
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			try {
				await main(["auth", "login"]);

				expect(errorSpy).toHaveBeenCalledWith("\n  Login failed:", "raw string error");
				expect(process.exitCode).toBe(1);
			} finally {
				errorSpy.mockRestore();
			}
		});
	});

	// ── Clean: index with no parentCommitHash entries ───────────────────
	describe("clean — index entries without parentCommitHash", () => {
		it("should report zero orphan files when index entries have no parentCommitHash", async () => {
			const { getIndex } = await import("./core/SummaryStore.js");
			const { listFilesInBranch } = await import("./core/GitOps.js");
			const { countStaleSessions, countStaleQueueEntries, checkStaleSquashPending } = await import(
				"./core/SessionTracker.js"
			);

			vi.mocked(getIndex).mockReset();
			vi.mocked(listFilesInBranch).mockReset();
			vi.mocked(countStaleSessions).mockReset();
			vi.mocked(countStaleQueueEntries).mockReset();
			vi.mocked(checkStaleSquashPending).mockReset();

			// Index with entries but none having parentCommitHash
			vi.mocked(getIndex).mockResolvedValue({
				version: 3,
				entries: [
					{
						commitHash: "aaa1111111111111111",
						parentCommitHash: null,
						branch: "main",
						commitMessage: "standalone commit",
						commitDate: "2026-04-01T00:00:00.000Z",
						generatedAt: "2026-04-01T00:00:00.000Z",
					},
					{
						commitHash: "bbb2222222222222222",
						parentCommitHash: null,
						branch: "main",
						commitMessage: "another standalone",
						commitDate: "2026-04-02T00:00:00.000Z",
						generatedAt: "2026-04-02T00:00:00.000Z",
					},
				],
			});

			vi.mocked(listFilesInBranch).mockResolvedValue([]);
			vi.mocked(countStaleSessions).mockResolvedValue(0);
			vi.mocked(countStaleQueueEntries).mockResolvedValue(0);
			vi.mocked(checkStaleSquashPending).mockResolvedValue(false);

			vi.mocked(console.log).mockClear();
			await main(["clean", "--dry-run"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			// clean no longer scans for orphan summaries/transcripts; the section
			// is removed from the output regardless of index shape.
			expect(output).not.toContain("Orphan summaries:");
			expect(output).toContain("Nothing to clean");
		});
	});

	// ── Doctor: auto-fix stale dist-path entry ──────────────────────────
	describe("doctor — fix stale dist-path entry", () => {
		it("should remove stale dist-path entry when --fix is passed", async () => {
			const os = await import("node:os");
			const path = await import("node:path");
			const fs = await import("node:fs/promises");

			// Create a real temp dir to act as globalDir so the fixer's unlink succeeds
			const tmpGlobalDir = path.join(os.tmpdir(), `jolli-doctor-fix-${Date.now()}`);
			const distPathsDir = path.join(tmpGlobalDir, "dist-paths");
			await fs.mkdir(distPathsDir, { recursive: true });
			await fs.writeFile(path.join(distPathsDir, "old-ext"), "stale-entry", "utf-8");

			const { getGlobalConfigDir } = await import("./core/SessionTracker.js");
			vi.mocked(getGlobalConfigDir).mockReturnValue(tmpGlobalDir);

			const { getStatus } = await import("./install/Installer.js");
			const { isLockStale, countActiveQueueEntries, loadConfig, loadAllSessions } = await import(
				"./core/SessionTracker.js"
			);
			const { orphanBranchExists } = await import("./core/GitOps.js");
			const { traverseDistPaths } = await import("./install/DistPathResolver.js");

			vi.mocked(getStatus).mockReset();
			vi.mocked(isLockStale).mockReset();
			vi.mocked(countActiveQueueEntries).mockReset();
			vi.mocked(loadConfig).mockReset();
			vi.mocked(loadAllSessions).mockReset();
			vi.mocked(orphanBranchExists).mockReset();
			vi.mocked(traverseDistPaths).mockReset();

			vi.mocked(getStatus).mockResolvedValue({
				enabled: true,
				claudeHookInstalled: true,
				gitHookInstalled: true,
				geminiHookInstalled: true,
				activeSessions: 0,
				mostRecentSession: null,
				summaryCount: 0,
				orphanBranch: "jollimemory/summaries/v3",
			});
			vi.mocked(isLockStale).mockResolvedValue(false);
			vi.mocked(countActiveQueueEntries).mockResolvedValue(0);
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-ant-test" });
			vi.mocked(loadAllSessions).mockResolvedValue([]);
			vi.mocked(orphanBranchExists).mockResolvedValue(true);
			// One stale (unavailable) dist-path entry
			vi.mocked(traverseDistPaths).mockReturnValue([
				{ source: "old-ext", version: "0.95.0", distDir: "/missing/dist", available: false },
			]);

			vi.mocked(console.log).mockClear();

			try {
				await main(["doctor", "--fix"]);

				const output = vi
					.mocked(console.log)
					.mock.calls.map((c) => String(c[0]))
					.join("\n");
				expect(output).toContain("Applying fixes");
				expect(output).toContain("removed stale entry");
			} finally {
				// Restore default globalDir mock and clean up temp dir
				vi.mocked(getGlobalConfigDir).mockReturnValue("/mock/global/config");
				await fs.rm(tmpGlobalDir, { recursive: true, force: true });
			}
		});
	});

	describe("interactive enable flow", () => {
		const origIsTTY = process.stdin.isTTY;

		beforeEach(() => {
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		});

		afterEach(() => {
			Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
		});

		it("should skip prompts for already-configured API keys", async () => {
			vi.mocked(loadConfigFromDir).mockResolvedValueOnce({ jolliApiKey: "existing", apiKey: "existing" });

			await main(["enable", "--cwd", "/tmp/test-project"]);

			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("configured"));
			expect(mockQuestion).not.toHaveBeenCalled();
		});
	});

	describe("enable command — additional branches", () => {
		it("should print non-interactive config guide with --yes flag", async () => {
			await main(["enable", "--yes", "--cwd", "/tmp/test-project"]);

			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Configure API keys"));
		});

		it("should print gemini settings path when present", async () => {
			vi.mocked(install).mockResolvedValueOnce({
				success: true,
				message: "OK",
				warnings: [],
				geminiSettingsPath: "/home/user/.gemini/settings.json",
			});

			await main(["enable", "--cwd", "/tmp/test-project"]);

			expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Gemini CLI hook"));
		});

		it("should print warnings on enable failure", async () => {
			vi.mocked(install).mockResolvedValueOnce({
				success: false,
				message: "Cannot install",
				warnings: ["Git hook conflict"],
			});

			await main(["enable", "--cwd", "/tmp/test-project"]);

			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Git hook conflict"));
			expect(process.exitCode).toBe(1);
		});
	});

	describe("status command — additional branches", () => {
		it("should omit version suffix when hookVersion is 'unknown'", async () => {
			vi.mocked(getStatus).mockResolvedValueOnce({
				enabled: true,
				claudeHookInstalled: true,
				gitHookInstalled: true,
				geminiHookInstalled: false,
				activeSessions: 0,
				mostRecentSession: null,
				summaryCount: 0,
				orphanBranch: "jollimemory/summaries/v3",
				sessionsBySource: {},
				hookSource: "cli",
				hookVersion: "unknown",
			});

			await main(["status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Hook runtime:") && s.includes("cli") && !s.includes("@unknown"))).toBe(
				true,
			);
		});

		it("should show hook runtime without version when hookVersion is absent", async () => {
			vi.mocked(getStatus).mockResolvedValueOnce({
				enabled: true,
				claudeHookInstalled: true,
				gitHookInstalled: true,
				geminiHookInstalled: false,
				activeSessions: 0,
				mostRecentSession: null,
				summaryCount: 0,
				orphanBranch: "jollimemory/summaries/v3",
				sessionsBySource: {},
				hookSource: "vscode-extension",
			});

			await main(["status"]);

			const calls = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			expect(calls.some((s) => s.includes("Hook runtime:") && s.includes("vscode-extension"))).toBe(true);
		});
	});

	describe("recall command — JSON format branches", () => {
		it("should output JSON catalog with query when no exact match and format is json", async () => {
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/other",
						commitCount: 1,
						period: { start: "2026-04-01", end: "2026-04-01" },
						commitMessages: ["x"],
					},
				],
			});

			await main(["recall", "feature/nonexistent", "--format", "json", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			const parsed = JSON.parse(output);
			expect(parsed.query).toBe("feature/nonexistent");
			expect(parsed.branches).toHaveLength(1);
		});

		it("should output JSON error when catalog is empty and no branch detected", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) throw new Error("detached HEAD");
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({ type: "catalog", branches: [] });

			await main(["recall", "--format", "json", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			const parsed = JSON.parse(output);
			expect(parsed.type).toBe("error");
		});

		it("should output JSON catalog when no branch detected and catalog is non-empty", async () => {
			mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
				const a = args as string[];
				if (a.includes("--show-current")) throw new Error("detached");
				if (a.includes("--show-toplevel")) return "/tmp/test\n";
				return "";
			});
			vi.mocked(listBranchCatalog).mockResolvedValueOnce({
				type: "catalog",
				branches: [
					{
						branch: "feature/old",
						commitCount: 1,
						period: { start: "2026-03-28", end: "2026-03-28" },
						commitMessages: ["x"],
					},
				],
			});

			await main(["recall", "--format", "json", "--cwd", "/tmp/test"]);

			const output = vi
				.mocked(console.log)
				.mock.calls.map((c) => String(c[0]))
				.join("\n");
			const parsed = JSON.parse(output);
			expect(parsed.branches).toHaveLength(1);
		});
	});
});
