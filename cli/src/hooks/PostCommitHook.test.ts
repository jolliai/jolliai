import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process so launchWorker's spawn() does not spawn real processes
vi.mock("node:child_process", () => ({
	spawn: vi.fn().mockReturnValue({ unref: vi.fn(), pid: 9999 }),
	execSync: vi.fn(),
}));

vi.mock("../core/StorageFactory.js", () => ({
	createStorage: vi.fn().mockResolvedValue({
		readFile: vi.fn().mockResolvedValue(null),
		writeFiles: vi.fn().mockResolvedValue(undefined),
		listFiles: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(true),
		ensure: vi.fn().mockResolvedValue(undefined),
	}),
}));

// Mock all dependencies
vi.mock("../core/GitOps.js", () => ({
	getCommitInfo: vi.fn(),
	getHeadHash: vi.fn(),
	getParentHash: vi.fn(),
	getDiffContent: vi.fn(),
	getDiffStats: vi.fn(),
	getCurrentBranch: vi.fn(),
	getLastReflogAction: vi.fn(),
	readFileFromBranch: vi.fn(),
	getProjectRootDir: vi.fn().mockImplementation((cwd: string) => Promise.resolve(cwd)),
}));

vi.mock("../core/SessionTracker.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/SessionTracker.js")>();
	return {
		loadAllSessions: vi.fn(),
		loadCursorForTranscript: vi.fn(),
		saveCursor: vi.fn(),
		loadConfig: vi.fn(),
		acquireLock: vi.fn(),
		releaseLock: vi.fn(),
		loadSquashPending: vi.fn(),
		deleteSquashPending: vi.fn(),
		loadPluginSource: vi.fn(),
		deletePluginSource: vi.fn(),
		loadPlansRegistry: vi.fn().mockResolvedValue({ version: 1, plans: {} }),
		savePlansRegistry: vi.fn().mockResolvedValue(undefined),
		associatePlanWithCommit: vi.fn(),
		associateNoteWithCommit: vi.fn(),
		filterSessionsByEnabledIntegrations: actual.filterSessionsByEnabledIntegrations,
		// Queue functions (new)
		dequeueAllGitOperations: vi.fn(),
		deleteQueueEntry: vi.fn(),
		enqueueGitOperation: vi.fn(),
		isLockHeld: vi.fn(),
	};
});

vi.mock("../core/TranscriptReader.js", () => ({
	readTranscript: vi.fn(),
	buildMultiSessionContext: vi.fn(),
}));

vi.mock("../core/Summarizer.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/Summarizer.js")>();
	return {
		generateSummary: vi.fn(),
		// runSquashPipeline / handleAmendPipeline call these. Mock the LLM-touching
		// path; mechanicalConsolidate runs as the fallback. extractTicketIdFromMessage
		// and formatSourceCommitsForSquash are pure helpers -- use real impl.
		generateSquashConsolidation: vi.fn().mockResolvedValue(null),
		mechanicalConsolidate: actual.mechanicalConsolidate,
		extractTicketIdFromMessage: actual.extractTicketIdFromMessage,
		formatSourceCommitsForSquash: actual.formatSourceCommitsForSquash,
	};
});

vi.mock("../core/SummaryStore.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/SummaryStore.js")>();
	return {
		storeSummary: vi.fn(),
		getSummary: vi.fn(),
		mergeManyToOne: vi.fn(),
		migrateOneToOne: vi.fn(),
		storePlans: vi.fn(),
		storeNotes: vi.fn(),
		setActiveStorage: vi.fn(),
		resolveStorage: vi.fn(),
		// Keep real implementations for pure tree-transform helpers.
		stripFunctionalMetadata: actual.stripFunctionalMetadata,
		resolveEffectiveTopics: actual.resolveEffectiveTopics,
		expandSourcesForConsolidation: actual.expandSourcesForConsolidation,
	};
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn().mockReturnValue(false),
		readFileSync: vi.fn().mockReturnValue(""),
	};
});

vi.mock("../core/CodexSessionDiscoverer.js", () => ({
	discoverCodexSessions: vi.fn().mockResolvedValue([]),
	isCodexInstalled: vi.fn().mockResolvedValue(true),
}));

vi.mock("../core/OpenCodeSessionDiscoverer.js", () => ({
	discoverOpenCodeSessions: vi.fn().mockResolvedValue([]),
	isOpenCodeInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/OpenCodeTranscriptReader.js", () => ({
	readOpenCodeTranscript: vi.fn().mockResolvedValue({
		entries: [],
		newCursor: { transcriptPath: "", lineNumber: 0, updatedAt: "" },
		totalLinesRead: 0,
	}),
}));

vi.mock("../core/CursorDetector.js", () => ({
	isCursorInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/CursorSessionDiscoverer.js", () => ({
	discoverCursorSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/CursorTranscriptReader.js", () => ({
	readCursorTranscript: vi.fn().mockResolvedValue({
		entries: [],
		newCursor: { transcriptPath: "", lineNumber: 0, updatedAt: "" },
		totalLinesRead: 0,
	}),
}));

vi.mock("../core/GeminiTranscriptReader.js", () => ({
	readGeminiTranscript: vi.fn().mockResolvedValue({
		entries: [],
		newCursor: { transcriptPath: "", lineNumber: 0, updatedAt: "" },
		totalLinesRead: 0,
	}),
}));

vi.mock("../core/CopilotDetector.js", () => ({
	isCopilotInstalled: vi.fn().mockResolvedValue(false),
	getCopilotDbPath: vi.fn().mockReturnValue("/mock/.copilot/session-store.db"),
}));

vi.mock("../core/CopilotSessionDiscoverer.js", () => ({
	discoverCopilotSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/CopilotChatDetector.js", () => ({
	isCopilotChatInstalled: vi.fn().mockResolvedValue(false),
	getCopilotChatStorageDir: vi.fn().mockReturnValue("/mock/Code/User/globalStorage/github.copilot-chat"),
}));

vi.mock("../core/CopilotChatSessionDiscoverer.js", () => ({
	discoverCopilotChatSessions: vi.fn().mockResolvedValue([]),
	scanCopilotChatSessions: vi.fn().mockResolvedValue({ sessions: [] }),
}));

vi.mock("../core/CopilotChatTranscriptReader.js", () => ({
	readCopilotChatTranscript: vi.fn().mockResolvedValue({
		entries: [],
		newCursor: { transcriptPath: "", lineNumber: 0, updatedAt: "" },
		totalLinesRead: 0,
	}),
}));

vi.mock("../core/CopilotTranscriptReader.js", () => ({
	readCopilotTranscript: vi.fn().mockResolvedValue({
		entries: [],
		newCursor: { transcriptPath: "", lineNumber: 0, updatedAt: "" },
		totalLinesRead: 0,
	}),
}));

vi.mock("../core/TranscriptParser.js", () => ({
	getParserForSource: vi.fn().mockReturnValue({ parseLine: vi.fn() }),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { discoverCodexSessions, isCodexInstalled } from "../core/CodexSessionDiscoverer.js";
import { readGeminiTranscript } from "../core/GeminiTranscriptReader.js";
import {
	getCommitInfo,
	getCurrentBranch,
	getDiffContent,
	getDiffStats,
	getProjectRootDir,
	readFileFromBranch,
} from "../core/GitOps.js";
import { discoverOpenCodeSessions, isOpenCodeInstalled } from "../core/OpenCodeSessionDiscoverer.js";
import { readOpenCodeTranscript } from "../core/OpenCodeTranscriptReader.js";
import {
	acquireLock,
	associateNoteWithCommit,
	associatePlanWithCommit,
	deleteQueueEntry,
	dequeueAllGitOperations,
	loadAllSessions,
	loadConfig,
	loadCursorForTranscript,
	loadPlansRegistry,
	loadSquashPending,
	releaseLock,
	saveCursor,
	savePlansRegistry,
} from "../core/SessionTracker.js";
import type { SummaryResult } from "../core/Summarizer.js";
import { generateSummary } from "../core/Summarizer.js";
import { getSummary, mergeManyToOne, migrateOneToOne, storeSummary } from "../core/SummaryStore.js";
import { buildMultiSessionContext, readTranscript } from "../core/TranscriptReader.js";
import type { CommitSummary } from "../Types.js";
import { runWorker } from "./PostCommitHook.js";

/** Creates a minimal mock SummaryResult (returned by generateSummary) */
function createMockResult(): SummaryResult {
	return {
		transcriptEntries: 1,
		llm: { model: "test-model", inputTokens: 100, outputTokens: 50, apiLatencyMs: 1000, stopReason: "end_turn" },
		stats: { filesChanged: 2, insertions: 10, deletions: 5 },
		topics: [
			{
				title: "Fix authentication",
				trigger: "Users getting logged out",
				response: "Refactored session handling",
				decisions: "Use JWT tokens",
			},
		],
	};
}

/** Creates a minimal mock CommitSummary (returned by getSummary from the store) */
function createMockSummary(hash = "abc123"): CommitSummary {
	return {
		version: 3,
		commitHash: hash,
		commitMessage: "Fix bug",
		commitAuthor: "John",
		commitDate: "2026-02-19T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-02-19T00:00:00.000Z",
		transcriptEntries: 1,
		stats: { filesChanged: 2, insertions: 10, deletions: 5 },
		topics: [
			{
				title: "Fix authentication",
				trigger: "Users getting logged out",
				response: "Refactored session handling",
				decisions: "Use JWT tokens",
			},
		],
	};
}

/** Sets up mocks for a complete successful pipeline run with a single session */
/** Default queue entry for a normal commit */
const DEFAULT_COMMIT_OP = {
	op: {
		type: "commit" as const,
		commitHash: "abc123",
		commitSource: "cli" as const,
		createdAt: "2026-02-19T00:00:00.000Z",
	},
	filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-abc123.json",
};

function setupFullPipeline(): void {
	// readFileFromBranch returns null by default (no stored files to log)
	vi.mocked(readFileFromBranch).mockResolvedValue(null);
	// Queue returns one commit entry, then empty on second call (drain loop stops)
	vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([DEFAULT_COMMIT_OP]).mockResolvedValue([]);
	vi.mocked(deleteQueueEntry).mockResolvedValue(undefined);
	vi.mocked(getCommitInfo).mockResolvedValue({
		hash: "abc123",
		message: "Fix bug",
		author: "John",
		date: "2026-02-19",
	});
	vi.mocked(loadAllSessions).mockResolvedValue([
		{
			sessionId: "sess-1",
			transcriptPath: "/path/to/transcript.jsonl",
			updatedAt: "2026-02-19",
		},
	]);
	vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
	vi.mocked(readTranscript).mockResolvedValue({
		entries: [{ role: "human", content: "Fix the bug" }],
		newCursor: { transcriptPath: "/path/to/transcript.jsonl", lineNumber: 10, updatedAt: "2026-02-19" },
		totalLinesRead: 10,
	});
	vi.mocked(buildMultiSessionContext).mockReturnValue("[Human]: Fix the bug");
	vi.mocked(getCurrentBranch).mockResolvedValue("main");
	vi.mocked(getDiffContent).mockResolvedValue("diff content");
	vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 2, insertions: 10, deletions: 5 });
	vi.mocked(loadConfig).mockResolvedValue({});
	vi.mocked(discoverCodexSessions).mockResolvedValue([]);
	// Explicitly reset isCodexInstalled to true — vi.clearAllMocks() does not reset implementations,
	// so a prior test that sets this to false could bleed into subsequent tests.
	vi.mocked(isCodexInstalled).mockResolvedValue(true);
	vi.mocked(generateSummary).mockResolvedValue(createMockResult());
}

describe("PostCommitHook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Default: lock can be acquired
		vi.mocked(acquireLock).mockResolvedValue(true);
		vi.mocked(releaseLock).mockResolvedValue();
		// Default: empty config (prevents undefined access after loadConfig)
		vi.mocked(loadConfig).mockResolvedValue({});
		// Default: no Codex sessions (prevent undefined.length crash)
		vi.mocked(discoverCodexSessions).mockResolvedValue([]);
		// Default: Codex is installed (reset between tests since mockClear doesn't reset implementations)
		vi.mocked(isCodexInstalled).mockResolvedValue(true);
		// Default: empty queue (individual tests or setupFullPipeline set their own entries)
		vi.mocked(dequeueAllGitOperations).mockResolvedValue([]);
		vi.mocked(deleteQueueEntry).mockResolvedValue(undefined);
	});

	// Note: rebase skip is now handled in postCommitEntry(), not runWorker().
	// See PostRewriteHook.test.ts for rebase enqueue tests.

	it("should run the full pipeline successfully", async () => {
		setupFullPipeline();

		await runWorker("/test/project");

		expect(acquireLock).toHaveBeenCalled();
		expect(getCommitInfo).toHaveBeenCalledWith("abc123", "/test/project");
		expect(loadAllSessions).toHaveBeenCalled();
		expect(readTranscript).toHaveBeenCalled();
		expect(buildMultiSessionContext).toHaveBeenCalled();
		expect(generateSummary).toHaveBeenCalled();
		expect(storeSummary).toHaveBeenCalled();
		expect(saveCursor).toHaveBeenCalled();
		expect(releaseLock).toHaveBeenCalled();
	});

	it("should mark summaries as plugin-sourced when queue entry has commitSource:plugin", async () => {
		setupFullPipeline();
		// Override queue to return a plugin-sourced commit entry
		vi.mocked(dequeueAllGitOperations)
			.mockReset()
			.mockResolvedValueOnce([
				{
					op: { ...DEFAULT_COMMIT_OP.op, commitSource: "plugin" as const },
					filePath: DEFAULT_COMMIT_OP.filePath,
				},
			])
			.mockResolvedValue([]);

		await runWorker("/test/project");

		expect(storeSummary).toHaveBeenCalledWith(
			expect.objectContaining({ commitSource: "plugin" }),
			"/test/project",
			false,
			expect.anything(),
		);
	});

	it("should label cherry-pick commits with the correct commitType", async () => {
		setupFullPipeline();
		// Override queue to return a cherry-pick entry
		vi.mocked(dequeueAllGitOperations)
			.mockReset()
			.mockResolvedValueOnce([
				{
					op: { ...DEFAULT_COMMIT_OP.op, type: "cherry-pick" as const },
					filePath: DEFAULT_COMMIT_OP.filePath,
				},
			])
			.mockResolvedValue([]);

		await runWorker("/test/project");

		expect(storeSummary).toHaveBeenCalledWith(
			expect.objectContaining({ commitType: "cherry-pick" }),
			"/test/project",
			false,
			expect.anything(),
		);
	});

	it("should label revert commits with the correct commitType", async () => {
		setupFullPipeline();
		// Override queue to return a revert entry
		vi.mocked(dequeueAllGitOperations)
			.mockReset()
			.mockResolvedValueOnce([
				{
					op: { ...DEFAULT_COMMIT_OP.op, type: "revert" as const },
					filePath: DEFAULT_COMMIT_OP.filePath,
				},
			])
			.mockResolvedValue([]);

		await runWorker("/test/project");

		expect(storeSummary).toHaveBeenCalledWith(
			expect.objectContaining({ commitType: "revert" }),
			"/test/project",
			false,
			expect.anything(),
		);
	});

	it("should skip when no active sessions but also no diff changes (guard)", async () => {
		vi.mocked(getCommitInfo).mockResolvedValue({
			hash: "abc123",
			message: "Fix bug",
			author: "John",
			date: "2026-02-19",
		});
		vi.mocked(loadSquashPending).mockResolvedValue(null);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
		vi.mocked(getDiffContent).mockResolvedValue("");
		vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });
		vi.mocked(getCurrentBranch).mockResolvedValue("main");

		await runWorker("/test/project");

		expect(generateSummary).not.toHaveBeenCalled();
		expect(releaseLock).toHaveBeenCalled();
	});

	it("should generate summary when no sessions but diff is non-empty (Part A fix)", async () => {
		vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([DEFAULT_COMMIT_OP]).mockResolvedValue([]);
		vi.mocked(getCommitInfo).mockResolvedValue({
			hash: "abc123",
			message: "Fix bug",
			author: "John",
			date: "2026-02-19",
		});
		vi.mocked(loadSquashPending).mockResolvedValue(null);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(getDiffContent).mockResolvedValue("diff --git a/file.ts\n+changed line");
		vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 5, deletions: 2 });
		vi.mocked(getCurrentBranch).mockResolvedValue("main");
		vi.mocked(buildMultiSessionContext).mockReturnValue("");
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(generateSummary).mockResolvedValue(createMockResult());

		await runWorker("/test/project");

		// Should still generate summary even with no sessions (diff is non-empty)
		expect(generateSummary).toHaveBeenCalled();
		expect(storeSummary).toHaveBeenCalled();
	});

	it("should generate summary when sessions have no new entries but diff is non-empty (Part A fix)", async () => {
		vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([DEFAULT_COMMIT_OP]).mockResolvedValue([]);
		vi.mocked(getCommitInfo).mockResolvedValue({
			hash: "abc123",
			message: "Fix bug",
			author: "John",
			date: "2026-02-19",
		});
		vi.mocked(loadSquashPending).mockResolvedValue(null);
		vi.mocked(loadAllSessions).mockResolvedValue([
			{ sessionId: "sess-1", transcriptPath: "/path/1.jsonl", updatedAt: "2026-02-19" },
		]);
		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
		vi.mocked(readTranscript).mockResolvedValue({
			entries: [],
			newCursor: { transcriptPath: "/path/1.jsonl", lineNumber: 0, updatedAt: "2026-02-19" },
			totalLinesRead: 0,
		});
		vi.mocked(getDiffContent).mockResolvedValue("diff content with changes");
		vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 3, insertions: 20, deletions: 10 });
		vi.mocked(getCurrentBranch).mockResolvedValue("main");
		vi.mocked(buildMultiSessionContext).mockReturnValue("");
		vi.mocked(loadConfig).mockResolvedValue({});
		vi.mocked(generateSummary).mockResolvedValue(createMockResult());

		await runWorker("/test/project");

		// transcript=0 but diff non-empty → should generate summary
		expect(generateSummary).toHaveBeenCalled();
		expect(storeSummary).toHaveBeenCalled();
		expect(saveCursor).toHaveBeenCalled();
	});

	it("should skip when no new transcript entries across all sessions AND no diff changes", async () => {
		vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([DEFAULT_COMMIT_OP]).mockResolvedValue([]);
		vi.mocked(getCommitInfo).mockResolvedValue({
			hash: "abc123",
			message: "Fix bug",
			author: "John",
			date: "2026-02-19",
		});
		vi.mocked(loadSquashPending).mockResolvedValue(null);
		vi.mocked(loadAllSessions).mockResolvedValue([
			{ sessionId: "sess-1", transcriptPath: "/path/1.jsonl", updatedAt: "2026-02-19" },
		]);
		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
		vi.mocked(readTranscript).mockResolvedValue({
			entries: [],
			newCursor: { transcriptPath: "/path/1.jsonl", lineNumber: 0, updatedAt: "2026-02-19" },
			totalLinesRead: 0,
		});
		vi.mocked(getDiffContent).mockResolvedValue("");
		vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });
		vi.mocked(getCurrentBranch).mockResolvedValue("main");

		await runWorker("/test/project");

		expect(generateSummary).not.toHaveBeenCalled();
		// Cursor should still be saved even when no entries
		expect(saveCursor).toHaveBeenCalled();
	});

	it("should skip when lock cannot be acquired", async () => {
		vi.mocked(acquireLock).mockResolvedValue(false);

		await runWorker("/test/project");

		expect(getCommitInfo).not.toHaveBeenCalled();
		expect(releaseLock).not.toHaveBeenCalled();
	});

	it("should release lock even on pipeline error", async () => {
		vi.mocked(getCommitInfo).mockRejectedValue(new Error("git failed"));

		await runWorker("/test/project");

		expect(releaseLock).toHaveBeenCalled();
	});

	// Note: rebase skip and amend-polling tests removed — these behaviors are now
	// in postCommitEntry() (rebase/amend detection) not in runWorker().

	it("should retry API call on first failure and succeed", async () => {
		setupFullPipeline();

		// First API call fails, second succeeds
		vi.mocked(generateSummary)
			.mockRejectedValueOnce(new Error("API error"))
			.mockResolvedValueOnce(createMockResult());

		const workerPromise = runWorker("/test/project");
		await vi.advanceTimersByTimeAsync(2500);
		await workerPromise;

		expect(generateSummary).toHaveBeenCalledTimes(2);
		expect(storeSummary).toHaveBeenCalled();
	});

	it("should store fallback summary with empty topics on double API failure", async () => {
		setupFullPipeline();

		vi.mocked(generateSummary)
			.mockRejectedValueOnce(new Error("API error 1"))
			.mockRejectedValueOnce(new Error("API error 2"));

		const workerPromise = runWorker("/test/project");
		await vi.advanceTimersByTimeAsync(2500);
		await workerPromise;

		expect(generateSummary).toHaveBeenCalledTimes(2);
		// After double failure, a metadata-only summary is stored so squash/rebase
		// merges never hit missing source summaries. Topics are empty and
		// stopReason is "error" to distinguish from a genuine LLM response.
		expect(storeSummary).toHaveBeenCalledTimes(1);
		const storedSummary = vi.mocked(storeSummary).mock.calls[0][0] as CommitSummary;
		expect(storedSummary.topics).toEqual([]);
		expect(storedSummary.llm?.stopReason).toBe("error");
	});

	it("should handle first commit (diff failure fallback)", async () => {
		setupFullPipeline();

		vi.mocked(getDiffContent).mockRejectedValue(new Error("bad revision"));
		vi.mocked(getDiffStats).mockRejectedValue(new Error("bad revision"));

		await runWorker("/test/project");

		expect(generateSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				diff: expect.stringContaining("First commit"),
			}),
		);
		expect(storeSummary).toHaveBeenCalled();
	});

	it("should pass per-transcript cursor to readTranscript", async () => {
		setupFullPipeline();
		const existingCursor = { transcriptPath: "/path/to/transcript.jsonl", lineNumber: 50, updatedAt: "2026-02-19" };
		vi.mocked(loadCursorForTranscript).mockResolvedValue(existingCursor);

		await runWorker("/test/project");

		expect(loadCursorForTranscript).toHaveBeenCalledWith("/path/to/transcript.jsonl", "/test/project");
		// 4th arg is beforeTimestamp (from queue entry's createdAt)
		expect(readTranscript).toHaveBeenCalledWith(
			"/path/to/transcript.jsonl",
			existingCursor,
			expect.anything(),
			expect.any(String),
		);
	});

	it("should pass config to generateSummary", async () => {
		setupFullPipeline();

		await runWorker("/test/project");

		expect(generateSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				config: expect.objectContaining({}),
			}),
		);
	});

	it("should handle multiple sessions and merge their transcripts", async () => {
		setupFullPipeline();

		// Two sessions with different transcripts
		vi.mocked(loadAllSessions).mockResolvedValue([
			{ sessionId: "sess-1", transcriptPath: "/path/1.jsonl", updatedAt: "2026-02-19" },
			{ sessionId: "sess-2", transcriptPath: "/path/2.jsonl", updatedAt: "2026-02-19" },
		]);

		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);

		// Each transcript returns entries
		vi.mocked(readTranscript)
			.mockResolvedValueOnce({
				entries: [{ role: "human", content: "dark mode" }],
				newCursor: { transcriptPath: "/path/1.jsonl", lineNumber: 5, updatedAt: "2026-02-19" },
				totalLinesRead: 5,
			})
			.mockResolvedValueOnce({
				entries: [{ role: "human", content: "fix login" }],
				newCursor: { transcriptPath: "/path/2.jsonl", lineNumber: 3, updatedAt: "2026-02-19" },
				totalLinesRead: 3,
			});

		vi.mocked(buildMultiSessionContext).mockReturnValue("merged context");

		await runWorker("/test/project");

		// Should read both transcripts
		expect(readTranscript).toHaveBeenCalledTimes(2);

		// Should save cursors for both transcripts
		expect(saveCursor).toHaveBeenCalledTimes(2);

		// Should call buildMultiSessionContext with both session transcripts
		expect(buildMultiSessionContext).toHaveBeenCalledWith([
			expect.objectContaining({ sessionId: "sess-1" }),
			expect.objectContaining({ sessionId: "sess-2" }),
		]);

		// Should use total entries from both sessions
		expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({ transcriptEntries: 2 }));
	});

	it("should skip Codex discovery when codexEnabled is false", async () => {
		setupFullPipeline();
		vi.mocked(loadConfig).mockResolvedValue({ codexEnabled: false });

		await runWorker("/test/project");

		expect(discoverCodexSessions).not.toHaveBeenCalled();
	});

	it("should filter out Gemini sessions when geminiEnabled is false", async () => {
		setupFullPipeline();
		vi.mocked(loadConfig).mockResolvedValue({ geminiEnabled: false });
		vi.mocked(loadAllSessions).mockResolvedValue([
			{ sessionId: "claude-1", transcriptPath: "/path/claude.jsonl", updatedAt: "2026-02-19", source: "claude" },
			{ sessionId: "gemini-1", transcriptPath: "/path/gemini.jsonl", updatedAt: "2026-02-19", source: "gemini" },
		]);
		vi.mocked(readTranscript).mockResolvedValue({
			entries: [{ role: "human", content: "claude only" }],
			newCursor: { transcriptPath: "/path/claude.jsonl", lineNumber: 1, updatedAt: "2026-02-19" },
			totalLinesRead: 1,
		});

		await runWorker("/test/project");

		expect(readTranscript).toHaveBeenCalledTimes(1);
		expect(readTranscript).toHaveBeenCalledWith("/path/claude.jsonl", null, expect.anything(), expect.any(String));
	});

	it("should skip sessions with no new entries but still save their cursors", async () => {
		setupFullPipeline();

		vi.mocked(loadAllSessions).mockResolvedValue([
			{ sessionId: "sess-1", transcriptPath: "/path/1.jsonl", updatedAt: "2026-02-19" },
			{ sessionId: "sess-2", transcriptPath: "/path/2.jsonl", updatedAt: "2026-02-19" },
		]);

		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);

		// First session has entries, second is empty
		vi.mocked(readTranscript)
			.mockResolvedValueOnce({
				entries: [{ role: "human", content: "has entries" }],
				newCursor: { transcriptPath: "/path/1.jsonl", lineNumber: 5, updatedAt: "2026-02-19" },
				totalLinesRead: 5,
			})
			.mockResolvedValueOnce({
				entries: [],
				newCursor: { transcriptPath: "/path/2.jsonl", lineNumber: 0, updatedAt: "2026-02-19" },
				totalLinesRead: 0,
			});

		vi.mocked(buildMultiSessionContext).mockReturnValue("context");

		await runWorker("/test/project");

		// buildMultiSessionContext should only receive the session with entries
		expect(buildMultiSessionContext).toHaveBeenCalledWith([expect.objectContaining({ sessionId: "sess-1" })]);

		// Both cursors should be saved
		expect(saveCursor).toHaveBeenCalledTimes(2);
	});

	it("should merge squash summaries when processing a squash queue entry", async () => {
		const squashOp = {
			op: {
				type: "squash" as const,
				commitHash: "newHash123",
				sourceHashes: ["oldHash1", "oldHash2"],
				commitSource: "cli" as const,
				createdAt: "2026-02-19T00:00:00.000Z",
			},
			filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash1.json",
		};
		vi.mocked(dequeueAllGitOperations).mockReset().mockResolvedValueOnce([squashOp]).mockResolvedValue([]);
		vi.mocked(getCommitInfo).mockResolvedValue({
			hash: "newHash123",
			message: "Merge feature",
			author: "John",
			date: "2026-02-19",
		});
		vi.mocked(getSummary)
			.mockResolvedValueOnce(createMockSummary("oldHash1"))
			.mockResolvedValueOnce(createMockSummary("oldHash2"));
		vi.mocked(mergeManyToOne).mockResolvedValue({ orphanedDocIds: [] });

		await runWorker("/test/project");

		// Should merge existing summaries instead of calling LLM
		expect(mergeManyToOne).toHaveBeenCalled();
		// LLM should NOT be called for squash
		expect(generateSummary).not.toHaveBeenCalled();
		expect(loadAllSessions).not.toHaveBeenCalled();
	});

	it("should skip squash when no source summaries found", async () => {
		const squashOp = {
			op: {
				type: "squash" as const,
				commitHash: "newHash123",
				sourceHashes: ["unknownHash1"],
				commitSource: "cli" as const,
				createdAt: "2026-02-19T00:00:00.000Z",
			},
			filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash1.json",
		};
		vi.mocked(dequeueAllGitOperations).mockReset().mockResolvedValueOnce([squashOp]).mockResolvedValue([]);
		vi.mocked(getCommitInfo).mockResolvedValue({
			hash: "newHash123",
			message: "Merge feature",
			author: "John",
			date: "2026-02-19",
		});
		vi.mocked(getSummary).mockResolvedValue(null);

		await runWorker("/test/project");

		expect(mergeManyToOne).not.toHaveBeenCalled();
		expect(generateSummary).not.toHaveBeenCalled();
	});

	it("should log todo field when topic includes a todo item", async () => {
		setupFullPipeline();

		// Return a record where one topic has a todo field (covers the if (topic.todo) branch)
		vi.mocked(generateSummary).mockResolvedValue({
			...createMockResult(),
			topics: [
				{
					title: "Fix authentication",
					trigger: "Users getting logged out",
					response: "Refactored session handling",
					decisions: "Use JWT tokens",
					todo: "Follow up on token refresh edge case",
				},
			],
		});

		await runWorker("/test/project");

		expect(storeSummary).toHaveBeenCalled();
	});
});

describe("queue-driven Worker", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.mocked(acquireLock).mockResolvedValue(true);
		vi.mocked(releaseLock).mockResolvedValue();
	});

	it("processes a commit queue entry through the full LLM pipeline", async () => {
		setupFullPipeline();

		await runWorker("/test/project");
		await vi.advanceTimersByTimeAsync(0);

		expect(dequeueAllGitOperations).toHaveBeenCalled();
		expect(getCommitInfo).toHaveBeenCalledWith("abc123", "/test/project");
		expect(generateSummary).toHaveBeenCalled();
		expect(deleteQueueEntry).toHaveBeenCalledWith(DEFAULT_COMMIT_OP.filePath);
		// Leaf commits persist diffStats on the CommitSummary equal to the actual
		// `git diff {hash}^..{hash}` result (mocked to {2, 10, 5} in setupFullPipeline).
		// For leaves this value equals `stats`, but diffStats is the canonical
		// field the display layer reads via resolveDiffStats.
		const summaryArg = vi.mocked(storeSummary).mock.calls[0][0] as CommitSummary;
		expect(summaryArg.diffStats).toEqual({ filesChanged: 2, insertions: 10, deletions: 5 });
	});

	it("exits gracefully when queue is empty", async () => {
		vi.mocked(dequeueAllGitOperations).mockResolvedValue([]);

		await runWorker("/test/project");
		await vi.advanceTimersByTimeAsync(0);

		expect(generateSummary).not.toHaveBeenCalled();
	});

	it("exits without processing when lock cannot be acquired", async () => {
		vi.mocked(acquireLock).mockResolvedValue(false);
		vi.mocked(dequeueAllGitOperations).mockResolvedValue([DEFAULT_COMMIT_OP]);

		await runWorker("/test/project");
		await vi.advanceTimersByTimeAsync(0);

		expect(dequeueAllGitOperations).not.toHaveBeenCalled();
		expect(generateSummary).not.toHaveBeenCalled();
	});

	it("deletes queue entry even when processing fails", async () => {
		setupFullPipeline();
		vi.mocked(generateSummary).mockRejectedValue(new Error("API error"));

		const workerPromise = runWorker("/test/project");
		// Advance past retry delay (RETRY_DELAY_MS = 2000ms)
		await vi.advanceTimersByTimeAsync(5000);
		await workerPromise;

		expect(deleteQueueEntry).toHaveBeenCalledWith(DEFAULT_COMMIT_OP.filePath);
	});

	it("processes multiple queue entries in order", async () => {
		setupFullPipeline();
		const secondOp = {
			op: {
				type: "commit" as const,
				commitHash: "def456",
				commitSource: "cli" as const,
				createdAt: "2026-02-19T00:01:00.000Z",
			},
			filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567891-def456.json",
		};
		// Reset and re-mock queue to return both entries
		vi.mocked(dequeueAllGitOperations)
			.mockReset()
			.mockResolvedValueOnce([DEFAULT_COMMIT_OP, secondOp])
			.mockResolvedValue([]);
		vi.mocked(getCommitInfo)
			.mockReset()
			.mockResolvedValueOnce({ hash: "abc123", message: "Fix bug", author: "John", date: "2026-02-19" })
			.mockResolvedValueOnce({ hash: "def456", message: "Add feature", author: "John", date: "2026-02-19" });

		await runWorker("/test/project");
		await vi.advanceTimersByTimeAsync(0);

		expect(deleteQueueEntry).toHaveBeenCalledTimes(2);
		expect(generateSummary).toHaveBeenCalledTimes(2);
	});

	// ─── Codex session integration ────────────────────────────────────────────

	describe("Codex session discovery", () => {
		it("merges Codex sessions with Claude sessions and calls generateSummary", async () => {
			setupFullPipeline();

			// Add a Codex session via discoverCodexSessions
			vi.mocked(discoverCodexSessions).mockResolvedValue([
				{
					sessionId: "codex-sess-1",
					transcriptPath: "/codex/transcript.jsonl",
					updatedAt: "2026-02-19",
					source: "codex",
				},
			]);

			// readTranscript is called twice (Claude + Codex)
			vi.mocked(readTranscript)
				.mockResolvedValueOnce({
					entries: [{ role: "human", content: "Claude message" }],
					newCursor: { transcriptPath: "/path/to/transcript.jsonl", lineNumber: 10, updatedAt: "2026-02-19" },
					totalLinesRead: 10,
				})
				.mockResolvedValueOnce({
					entries: [{ role: "human", content: "Codex message" }],
					newCursor: { transcriptPath: "/codex/transcript.jsonl", lineNumber: 5, updatedAt: "2026-02-19" },
					totalLinesRead: 5,
				});

			await runWorker("/test/project");
			await vi.advanceTimersByTimeAsync(0);

			expect(readTranscript).toHaveBeenCalledTimes(2);
			expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({ transcriptEntries: 2 }));
		});

		it("skips Codex discovery when codexEnabled is false", async () => {
			setupFullPipeline();
			vi.mocked(loadConfig).mockResolvedValue({ codexEnabled: false });

			await runWorker("/test/project");
			await vi.advanceTimersByTimeAsync(0);

			expect(isCodexInstalled).not.toHaveBeenCalled();
			expect(discoverCodexSessions).not.toHaveBeenCalled();
			expect(generateSummary).toHaveBeenCalled();
		});

		it("skips Codex discovery when Codex is not installed", async () => {
			setupFullPipeline();
			vi.mocked(isCodexInstalled).mockResolvedValue(false);

			await runWorker("/test/project");
			await vi.advanceTimersByTimeAsync(0);

			expect(isCodexInstalled).toHaveBeenCalled();
			expect(discoverCodexSessions).not.toHaveBeenCalled();
			expect(generateSummary).toHaveBeenCalled();
		});

		it("works with only Codex sessions and no Claude sessions", async () => {
			setupFullPipeline();
			vi.mocked(loadAllSessions).mockResolvedValue([]);
			vi.mocked(discoverCodexSessions).mockResolvedValue([
				{
					sessionId: "codex-only",
					transcriptPath: "/codex/only.jsonl",
					updatedAt: "2026-02-19",
					source: "codex",
				},
			]);
			vi.mocked(readTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Codex only message" }],
				newCursor: { transcriptPath: "/codex/only.jsonl", lineNumber: 3, updatedAt: "2026-02-19" },
				totalLinesRead: 3,
			});

			await runWorker("/test/project");
			// Allow all pending microtasks and timers to flush
			await vi.advanceTimersByTimeAsync(100);

			expect(generateSummary).toHaveBeenCalled();
		});
	});

	// ─── Gemini session gating ────────────────────────────────────────────────

	describe("Gemini session gating", () => {
		it("filters out Gemini sessions when geminiEnabled is false", async () => {
			setupFullPipeline();
			vi.mocked(loadConfig).mockResolvedValue({ geminiEnabled: false });
			// loadAllSessions returns a mix of Claude and Gemini sessions
			vi.mocked(loadAllSessions).mockResolvedValue([
				{
					sessionId: "claude-sess",
					transcriptPath: "/claude/transcript.jsonl",
					updatedAt: "2026-02-19",
				},
				{
					sessionId: "gemini-sess",
					transcriptPath: "/gemini/session.json",
					updatedAt: "2026-02-19",
					source: "gemini",
				},
			]);

			await runWorker("/test/project");
			await vi.advanceTimersByTimeAsync(100);

			// Gemini transcript reader should NOT be called
			expect(readGeminiTranscript).not.toHaveBeenCalled();
			// Claude transcript should still be read
			expect(readTranscript).toHaveBeenCalled();
			expect(generateSummary).toHaveBeenCalled();
		});

		it("includes Gemini sessions when geminiEnabled is not false", async () => {
			setupFullPipeline();
			vi.mocked(loadConfig).mockResolvedValue({});
			vi.mocked(loadAllSessions).mockResolvedValue([
				{
					sessionId: "gemini-sess",
					transcriptPath: "/gemini/session.json",
					updatedAt: "2026-02-19",
					source: "gemini",
				},
			]);
			vi.mocked(readGeminiTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Gemini message" }],
				newCursor: { transcriptPath: "/gemini/session.json", lineNumber: 5, updatedAt: "2026-02-19" },
				totalLinesRead: 5,
			});

			await runWorker("/test/project");
			await vi.advanceTimersByTimeAsync(100);

			expect(readGeminiTranscript).toHaveBeenCalled();
			expect(generateSummary).toHaveBeenCalled();
		});
	});

	// ─── Rebase-pick queue entry ───────────────────────────────────────────────

	describe("rebase-pick queue entry", () => {
		it("migrates summary 1:1 when source summary exists", async () => {
			const rebasePickOp = {
				op: {
					type: "rebase-pick" as const,
					commitHash: "newHash",
					sourceHashes: ["oldHash"],
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([rebasePickOp]).mockResolvedValue([]);
			vi.mocked(getSummary).mockResolvedValue(createMockSummary("oldHash"));
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Rebased commit",
				author: "John",
				date: "2026-02-19",
			});

			await runWorker("/test/project");

			expect(migrateOneToOne).toHaveBeenCalledWith(
				expect.objectContaining({ commitHash: "oldHash" }),
				expect.objectContaining({ hash: "newHash" }),
				"/test/project",
				expect.objectContaining({ commitType: "rebase" }),
			);
			expect(generateSummary).not.toHaveBeenCalled();
		});

		it("skips migration when source summary is missing", async () => {
			const rebasePickOp = {
				op: {
					type: "rebase-pick" as const,
					commitHash: "newHash",
					sourceHashes: ["missing"],
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([rebasePickOp]).mockResolvedValue([]);
			vi.mocked(getSummary).mockResolvedValue(null);

			await runWorker("/test/project");

			expect(migrateOneToOne).not.toHaveBeenCalled();
			expect(getCommitInfo).not.toHaveBeenCalled();
		});

		it("forwards commitSource from the queue entry into migrateOneToOne", async () => {
			// The queue entry's commitSource (e.g. "plugin") must reach the
			// migrated summary; squash and amend already do this — rebase-pick
			// must too.
			const rebasePickOp = {
				op: {
					type: "rebase-pick" as const,
					commitHash: "newHash",
					sourceHashes: ["oldHash"],
					commitSource: "plugin" as const,
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([rebasePickOp]).mockResolvedValue([]);
			vi.mocked(getSummary).mockResolvedValue(createMockSummary("oldHash"));
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Rebased commit",
				author: "John",
				date: "2026-02-19",
			});

			await runWorker("/test/project");

			expect(migrateOneToOne).toHaveBeenCalledWith(
				expect.objectContaining({ commitHash: "oldHash" }),
				expect.objectContaining({ hash: "newHash" }),
				"/test/project",
				expect.objectContaining({ commitType: "rebase", commitSource: "plugin" }),
			);
		});
	});

	// ─── Rebase-squash queue entry ─────────────────────────────────────────────

	describe("rebase-squash queue entry", () => {
		it("merges summaries N:1 when all source summaries exist", async () => {
			const rebaseSquashOp = {
				op: {
					type: "rebase-squash" as const,
					commitHash: "newHash",
					sourceHashes: ["hash1", "hash2"],
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([rebaseSquashOp]).mockResolvedValue([]);
			vi.mocked(getSummary)
				.mockResolvedValueOnce(createMockSummary("hash1"))
				.mockResolvedValueOnce(createMockSummary("hash2"));
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Rebase squashed commit",
				author: "John",
				date: "2026-02-19",
			});
			vi.mocked(mergeManyToOne).mockResolvedValue({ orphanedDocIds: [] });

			await runWorker("/test/project");

			expect(mergeManyToOne).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ commitHash: "hash1" }),
					expect.objectContaining({ commitHash: "hash2" }),
				]),
				expect.objectContaining({ hash: "newHash" }),
				"/test/project",
				expect.objectContaining({ commitType: "squash" }),
				// runSquashPipeline passes a 5th `consolidated` arg to mergeManyToOne.
				expect.objectContaining({ topics: expect.any(Array) }),
			);
			expect(generateSummary).not.toHaveBeenCalled();
		});

		it("merges only available summaries when some sources are missing", async () => {
			const rebaseSquashOp = {
				op: {
					type: "rebase-squash" as const,
					commitHash: "newHash",
					sourceHashes: ["hash1", "hash2", "hash3"],
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([rebaseSquashOp]).mockResolvedValue([]);
			vi.mocked(getSummary)
				.mockResolvedValueOnce(createMockSummary("hash1"))
				.mockResolvedValueOnce(null) // hash2 missing
				.mockResolvedValueOnce(createMockSummary("hash3"));
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Rebase squashed commit",
				author: "John",
				date: "2026-02-19",
			});
			vi.mocked(mergeManyToOne).mockResolvedValue({ orphanedDocIds: [] });

			await runWorker("/test/project");

			// Should merge with only the 2 available summaries; the 5th arg is the
			// consolidated topics/recap built by runSquashPipeline.
			expect(mergeManyToOne).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ commitHash: "hash1" }),
					expect.objectContaining({ commitHash: "hash3" }),
				]),
				expect.objectContaining({ hash: "newHash" }),
				"/test/project",
				expect.anything(),
				expect.objectContaining({ topics: expect.any(Array) }),
			);
			// Verify exactly 2 summaries were passed (not 3)
			const summariesArg = vi.mocked(mergeManyToOne).mock.calls[0][0];
			expect(summariesArg).toHaveLength(2);
		});

		it("skips merge when all source summaries are missing", async () => {
			const rebaseSquashOp = {
				op: {
					type: "rebase-squash" as const,
					commitHash: "newHash",
					sourceHashes: ["hash1", "hash2"],
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([rebaseSquashOp]).mockResolvedValue([]);
			vi.mocked(getSummary).mockResolvedValue(null);

			await runWorker("/test/project");

			expect(mergeManyToOne).not.toHaveBeenCalled();
		});
	});

	// ─── Amend queue entry ────────────────────────────────────────────────────

	describe("amend queue entry", () => {
		const AMEND_OP = {
			op: {
				type: "amend" as const,
				commitHash: "newHash",
				sourceHashes: ["oldHash"],
				commitSource: "cli" as const,
				createdAt: "2026-02-19T00:00:00.000Z",
			},
			filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
		};

		/** Sets up mocks for the amend pipeline with LLM call (non-empty diff) */
		function setupAmendPipeline(opts?: {
			hasOldSummary?: boolean;
			hasTranscript?: boolean;
			hasDiff?: boolean;
		}): void {
			const hasOldSummary = opts?.hasOldSummary ?? true;
			const hasTranscript = opts?.hasTranscript ?? true;
			const hasDiff = opts?.hasDiff ?? true;

			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([AMEND_OP]).mockResolvedValue([]);
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Amended commit",
				author: "John",
				date: "2026-02-19",
			});
			vi.mocked(getSummary).mockResolvedValue(hasOldSummary ? createMockSummary("oldHash") : null);
			vi.mocked(loadConfig).mockResolvedValue({});
			vi.mocked(loadAllSessions).mockResolvedValue(
				hasTranscript
					? [{ sessionId: "sess-1", transcriptPath: "/path/to/transcript.jsonl", updatedAt: "2026-02-19" }]
					: [],
			);
			vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
			vi.mocked(readTranscript).mockResolvedValue(
				hasTranscript
					? {
							entries: [{ role: "human", content: "Amend the commit" }],
							newCursor: {
								transcriptPath: "/path/to/transcript.jsonl",
								lineNumber: 10,
								updatedAt: "2026-02-19",
							},
							totalLinesRead: 10,
						}
					: {
							entries: [],
							newCursor: {
								transcriptPath: "/path/to/transcript.jsonl",
								lineNumber: 0,
								updatedAt: "2026-02-19",
							},
							totalLinesRead: 0,
						},
			);
			vi.mocked(buildMultiSessionContext).mockReturnValue(hasTranscript ? "[Human]: Amend the commit" : "");
			vi.mocked(getCurrentBranch).mockResolvedValue("feature-branch");
			vi.mocked(getDiffContent).mockResolvedValue(hasDiff ? "diff content" : "");
			vi.mocked(getDiffStats).mockResolvedValue(
				hasDiff
					? { filesChanged: 1, insertions: 5, deletions: 2 }
					: { filesChanged: 0, insertions: 0, deletions: 0 },
			);
			vi.mocked(discoverCodexSessions).mockResolvedValue([]);
			vi.mocked(isCodexInstalled).mockResolvedValue(true);
			vi.mocked(generateSummary).mockResolvedValue(createMockResult());
		}

		it("runs LLM pipeline and stores summary with old summary as child", async () => {
			setupAmendPipeline({ hasOldSummary: true });

			await runWorker("/test/project");

			expect(generateSummary).toHaveBeenCalled();
			expect(storeSummary).toHaveBeenCalledWith(
				expect.objectContaining({
					commitHash: "newHash",
					commitType: "amend",
					children: expect.arrayContaining([expect.objectContaining({ commitHash: "oldHash" })]),
				}),
				"/test/project",
				false,
				expect.anything(),
			);
			// The amend root carries diffStats so the display layer can read the
			// real integer `git diff {newHash}^..{newHash}` instead of aggregating
			// delta + children.stats (today's over-counting behavior).
			const summaryArg = vi.mocked(storeSummary).mock.calls[0][0] as CommitSummary;
			expect(summaryArg.diffStats).toBeDefined();
		});

		it("amend diffStats is the full commit diff (Scenario 1 second getDiffStats call)", async () => {
			setupAmendPipeline({ hasOldSummary: true });
			// Override getDiffStats to distinguish the two production calls:
			// 1st call = delta (fromRef=oldHash, toRef=newHash) — used by the LLM
			// 2nd call = full commit diff (newHash^..newHash) — persisted as diffStats
			vi.mocked(getDiffStats)
				.mockResolvedValueOnce({ filesChanged: 1, insertions: 3, deletions: 1 }) // delta
				.mockResolvedValueOnce({ filesChanged: 5, insertions: 120, deletions: 40 }); // full

			await runWorker("/test/project");

			const summaryArg = vi.mocked(storeSummary).mock.calls[0][0] as CommitSummary;
			// `diffStats` is the full commit diff for display — sourced from the
			// 2nd getDiffStats call inserted by this refactor.
			expect(summaryArg.diffStats).toEqual({ filesChanged: 5, insertions: 120, deletions: 40 });
			// `stats` is whatever the LLM's SummaryResult carried (mock provides a
			// fixed 2/10/5 via createMockResult). It is NOT the diffStats.
			expect(summaryArg.stats).not.toEqual(summaryArg.diffStats);
		});

		it("creates fresh leaf node when no old summary exists", async () => {
			setupAmendPipeline({ hasOldSummary: false });

			await runWorker("/test/project");

			expect(generateSummary).toHaveBeenCalled();
			// storeSummary should be called without children (fresh leaf)
			const summaryArg = vi.mocked(storeSummary).mock.calls[0][0] as CommitSummary;
			expect(summaryArg.commitHash).toBe("newHash");
			expect(summaryArg.children).toBeUndefined();
		});

		it("skips LLM but migrates index for message-only amend (no diff, no transcript)", async () => {
			setupAmendPipeline({ hasOldSummary: true, hasTranscript: false, hasDiff: false });
			// Second getDiffStats call (for `{newHash}^..{newHash}` integral) returns
			// a non-zero number — the full commit has a diff even though the message-only
			// amend DELTA is empty. This is the key correctness invariant the plan
			// calls out for the message-only branch.
			vi.mocked(getDiffStats)
				.mockResolvedValueOnce({ filesChanged: 0, insertions: 0, deletions: 0 }) // delta = empty
				.mockResolvedValueOnce({ filesChanged: 3, insertions: 70, deletions: 15 }); // integral

			await runWorker("/test/project");

			// LLM should NOT be called for a message-only amend
			expect(generateSummary).not.toHaveBeenCalled();
			// storeSummary should still be called for index migration
			expect(storeSummary).toHaveBeenCalledWith(
				expect.objectContaining({
					commitHash: "newHash",
					commitType: "amend",
					children: expect.arrayContaining([expect.objectContaining({ commitHash: "oldHash" })]),
				}),
				"/test/project",
			);
			// The message-only amend ALSO writes diffStats (the full commit diff) on
			// the migrated summary, so display code doesn't fall back to recursive
			// aggregation of children. This was previously missed — see plan.
			const summaryArg = vi.mocked(storeSummary).mock.calls[0][0] as CommitSummary;
			expect(summaryArg.diffStats).toEqual({ filesChanged: 3, insertions: 70, deletions: 15 });
			// `stats` field stays undefined on the migrated summary (this path never
			// ran an LLM and had no local `stats` value to assign).
			expect(summaryArg.stats).toBeUndefined();
		});
	});

	// ─── Empty sourceHashes edge cases ────────────────────────────────────────

	describe("empty sourceHashes edge cases", () => {
		it("gracefully skips squash with empty sourceHashes", async () => {
			const squashOp = {
				op: {
					type: "squash" as const,
					commitHash: "newHash",
					sourceHashes: [] as string[],
					commitSource: "cli" as const,
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([squashOp]).mockResolvedValue([]);

			await runWorker("/test/project");

			expect(mergeManyToOne).not.toHaveBeenCalled();
			expect(generateSummary).not.toHaveBeenCalled();
		});

		it("gracefully skips rebase-squash with empty sourceHashes", async () => {
			const rebaseSquashOp = {
				op: {
					type: "rebase-squash" as const,
					commitHash: "newHash",
					sourceHashes: [] as string[],
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([rebaseSquashOp]).mockResolvedValue([]);

			await runWorker("/test/project");

			expect(mergeManyToOne).not.toHaveBeenCalled();
		});

		it("gracefully skips rebase-pick with no sourceHashes", async () => {
			const rebasePickOp = {
				op: {
					type: "rebase-pick" as const,
					commitHash: "newHash",
					sourceHashes: [] as string[],
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([rebasePickOp]).mockResolvedValue([]);

			await runWorker("/test/project");

			expect(migrateOneToOne).not.toHaveBeenCalled();
		});
	});

	// ─── Notes association ─────────────────────────────────────────────────────

	describe("notes association during commit pipeline", () => {
		it("associates notes with commit when registry has uncommitted notes", async () => {
			setupFullPipeline();
			const noteSourcePath = "/test/project/.jolli/jollimemory/notes/note-1.md";

			// Registry has an uncommitted note
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				notes: {
					"note-1": {
						id: "note-1",
						title: "Test note",
						format: "markdown" as const,
						sourcePath: noteSourcePath,
						addedAt: "2026-02-19T00:00:00.000Z",
						updatedAt: "2026-02-19T00:00:00.000Z",
						branch: "main",
						commitHash: null,
					},
				},
			});

			// Mock fs to allow reading the note file
			vi.mocked(existsSync).mockImplementation((path) => path === noteSourcePath);
			vi.mocked(readFileSync).mockImplementation(((path: unknown) => {
				if (path === noteSourcePath) return "# Test note content";
				return "";
			}) as typeof readFileSync);

			await runWorker("/test/project");

			// savePlansRegistry should be called to archive the note
			expect(savePlansRegistry).toHaveBeenCalled();
			// storeSummary should include notes in the summary
			expect(storeSummary).toHaveBeenCalledWith(
				expect.objectContaining({
					notes: expect.arrayContaining([expect.objectContaining({ title: "Test note" })]),
				}),
				"/test/project",
				false,
				expect.anything(),
			);
		});
	});

	// ─── Codex session discovery in loadSessionTranscripts ────────────────────

	describe("loadSessionTranscripts with Codex", () => {
		it("includes discovered Codex sessions in the transcript merge", async () => {
			setupFullPipeline();
			// Return both a Claude session (from loadAllSessions) and a Codex session (from discovery)
			vi.mocked(loadAllSessions).mockResolvedValue([
				{ sessionId: "claude-1", transcriptPath: "/claude/session.jsonl", updatedAt: "2026-02-19" },
			]);
			vi.mocked(discoverCodexSessions).mockResolvedValue([
				{
					sessionId: "codex-1",
					transcriptPath: "/codex/session.jsonl",
					updatedAt: "2026-02-19",
					source: "codex",
				},
			]);
			vi.mocked(readTranscript)
				.mockResolvedValueOnce({
					entries: [{ role: "human", content: "Claude entry" }],
					newCursor: { transcriptPath: "/claude/session.jsonl", lineNumber: 5, updatedAt: "2026-02-19" },
					totalLinesRead: 5,
				})
				.mockResolvedValueOnce({
					entries: [{ role: "human", content: "Codex entry" }],
					newCursor: { transcriptPath: "/codex/session.jsonl", lineNumber: 3, updatedAt: "2026-02-19" },
					totalLinesRead: 3,
				});
			vi.mocked(buildMultiSessionContext).mockReturnValue("merged context");

			await runWorker("/test/project");

			// Both transcripts should be read
			expect(readTranscript).toHaveBeenCalledTimes(2);
			// buildMultiSessionContext should receive both sessions
			expect(buildMultiSessionContext).toHaveBeenCalledWith([
				expect.objectContaining({ sessionId: "claude-1" }),
				expect.objectContaining({ sessionId: "codex-1" }),
			]);
			// generateSummary should reflect total entries from both sessions
			expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({ transcriptEntries: 2 }));
		});
	});

	// ─── OpenCode session discovery in loadSessionTranscripts ─────────────────

	describe("loadSessionTranscripts with OpenCode", () => {
		it("includes discovered OpenCode sessions and uses the dedicated reader", async () => {
			setupFullPipeline();
			// Return a Claude session (from loadAllSessions) and an OpenCode session (from discovery)
			vi.mocked(loadAllSessions).mockResolvedValue([
				{ sessionId: "claude-1", transcriptPath: "/claude/session.jsonl", updatedAt: "2026-02-19" },
			]);
			vi.mocked(isOpenCodeInstalled).mockResolvedValue(true);
			vi.mocked(discoverOpenCodeSessions).mockResolvedValue([
				{
					sessionId: "oc-1",
					transcriptPath: "/home/user/.local/share/opencode/opencode.db#oc-1",
					updatedAt: "2026-02-19",
					source: "opencode",
				},
			]);
			vi.mocked(readTranscript).mockResolvedValueOnce({
				entries: [{ role: "human", content: "Claude entry" }],
				newCursor: { transcriptPath: "/claude/session.jsonl", lineNumber: 5, updatedAt: "2026-02-19" },
				totalLinesRead: 5,
			});
			vi.mocked(readOpenCodeTranscript).mockResolvedValueOnce({
				entries: [{ role: "human", content: "OpenCode entry" }],
				newCursor: {
					transcriptPath: "/home/user/.local/share/opencode/opencode.db#oc-1",
					lineNumber: 3,
					updatedAt: "2026-02-19",
				},
				totalLinesRead: 3,
			});
			vi.mocked(buildMultiSessionContext).mockReturnValue("merged context");

			await runWorker("/test/project");

			// readOpenCodeTranscript should be called for the opencode session
			expect(readOpenCodeTranscript).toHaveBeenCalledTimes(1);
			// readTranscript should be called for the Claude session
			expect(readTranscript).toHaveBeenCalledTimes(1);
			// buildMultiSessionContext should receive both sessions
			expect(buildMultiSessionContext).toHaveBeenCalledWith([
				expect.objectContaining({ sessionId: "claude-1" }),
				expect.objectContaining({ sessionId: "oc-1" }),
			]);
		});
	});

	// ─── Amend edge cases ─────────────────────────────────────────────────────

	describe("amend edge cases", () => {
		const AMEND_OP = {
			op: {
				type: "amend" as const,
				commitHash: "newHash",
				sourceHashes: ["oldHash"],
				commitSource: "cli" as const,
				createdAt: "2026-02-19T00:00:00.000Z",
			},
			filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
		};

		function setupAmendWithLLM(): void {
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([AMEND_OP]).mockResolvedValue([]);
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Amended commit",
				author: "John",
				date: "2026-02-19",
			});
			vi.mocked(getSummary).mockResolvedValue(createMockSummary("oldHash"));
			vi.mocked(loadConfig).mockResolvedValue({});
			vi.mocked(loadAllSessions).mockResolvedValue([
				{ sessionId: "sess-1", transcriptPath: "/path/to/transcript.jsonl", updatedAt: "2026-02-19" },
			]);
			vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
			vi.mocked(readTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Amend" }],
				newCursor: { transcriptPath: "/path/to/transcript.jsonl", lineNumber: 10, updatedAt: "2026-02-19" },
				totalLinesRead: 10,
			});
			vi.mocked(buildMultiSessionContext).mockReturnValue("[Human]: Amend");
			vi.mocked(getCurrentBranch).mockResolvedValue("feature-branch");
			vi.mocked(getDiffContent).mockResolvedValue("diff content");
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 5, deletions: 2 });
			vi.mocked(discoverCodexSessions).mockResolvedValue([]);
			vi.mocked(isCodexInstalled).mockResolvedValue(true);
		}

		it("skips amend summary on double API failure", async () => {
			setupAmendWithLLM();
			vi.mocked(generateSummary)
				.mockRejectedValueOnce(new Error("API error 1"))
				.mockRejectedValueOnce(new Error("API error 2"));

			const workerPromise = runWorker("/test/project");
			await vi.advanceTimersByTimeAsync(2500);
			await workerPromise;

			expect(generateSummary).toHaveBeenCalledTimes(2);
			// On double failure in amend, storeSummary should NOT be called (early return)
			expect(storeSummary).not.toHaveBeenCalled();
		});

		it("logs todo field when amend topic includes a todo item", async () => {
			setupAmendWithLLM();
			vi.mocked(generateSummary).mockResolvedValue({
				...createMockResult(),
				topics: [
					{
						title: "Amend fix",
						trigger: "Bug found",
						response: "Fixed it",
						decisions: "Quick fix",
						todo: "Follow up later",
					},
				],
			});

			await runWorker("/test/project");

			expect(storeSummary).toHaveBeenCalled();
		});

		it("handles diff failure gracefully with empty fallback", async () => {
			setupAmendWithLLM();
			vi.mocked(getDiffContent).mockRejectedValue(new Error("diff failed"));
			vi.mocked(getDiffStats).mockRejectedValue(new Error("diff failed"));

			await runWorker("/test/project");

			// Should still call generateSummary with empty diff stats
			expect(generateSummary).toHaveBeenCalledWith(
				expect.objectContaining({
					diff: "(Could not compute diff)",
					diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
				}),
			);
		});
	});

	// ─── reassociateMetadata coverage (plans + notes on squash) ──────────────

	describe("reassociateMetadata in squash", () => {
		it("re-associates plans and notes from source summaries on squash", async () => {
			const squashOp = {
				op: {
					type: "squash" as const,
					commitHash: "newHash",
					sourceHashes: ["oldHash1"],
					commitSource: "cli" as const,
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockReset().mockResolvedValueOnce([squashOp]).mockResolvedValue([]);
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Squash",
				author: "John",
				date: "2026-02-19",
			});
			// Old summary has both plans and notes
			vi.mocked(getSummary).mockResolvedValue({
				...createMockSummary("oldHash1"),
				plans: [
					{
						slug: "plan-old",
						title: "Old plan",
						editCount: 1,
						addedAt: "2026-02-19T00:00:00Z",
						updatedAt: "2026-02-19T00:00:00Z",
					},
				],
				notes: [
					{
						id: "note-old",
						title: "Old note",
						format: "markdown" as const,
						addedAt: "2026-02-19T00:00:00Z",
						updatedAt: "2026-02-19T00:00:00Z",
					},
				],
			});
			vi.mocked(mergeManyToOne).mockResolvedValue({ orphanedDocIds: [] });

			await runWorker("/test/project");

			expect(associatePlanWithCommit).toHaveBeenCalledWith("plan-old", "newHash", "/test/project");
			expect(associateNoteWithCommit).toHaveBeenCalledWith("note-old", "newHash", "/test/project");
		});
	});

	// ─── reassociateMetadata coverage (plans + notes on amend, all 3 paths) ──

	describe("reassociateMetadata in amend", () => {
		const AMEND_OP = {
			op: {
				type: "amend" as const,
				commitHash: "newHash",
				sourceHashes: ["oldHash"],
				commitSource: "cli" as const,
				createdAt: "2026-02-19T00:00:00.000Z",
			},
			filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
		};

		function oldSummaryWithMetadata(): CommitSummary {
			return {
				...createMockSummary("oldHash"),
				plans: [
					{
						slug: "plan-old",
						title: "Old plan",
						editCount: 1,
						addedAt: "2026-02-19T00:00:00Z",
						updatedAt: "2026-02-19T00:00:00Z",
					},
				],
				notes: [
					{
						id: "note-old",
						title: "Old note",
						format: "markdown" as const,
						addedAt: "2026-02-19T00:00:00Z",
						updatedAt: "2026-02-19T00:00:00Z",
					},
				],
			};
		}

		function setupAmend(): void {
			vi.mocked(dequeueAllGitOperations).mockReset().mockResolvedValueOnce([AMEND_OP]).mockResolvedValue([]);
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Amended commit",
				author: "John",
				date: "2026-02-19",
			});
			vi.mocked(loadConfig).mockResolvedValue({});
			vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
			vi.mocked(getCurrentBranch).mockResolvedValue("feature-branch");
		}

		it("re-associates plans and notes on short-circuit A (trivial delta, 0 LLM)", async () => {
			setupAmend();
			vi.mocked(getSummary).mockResolvedValue(oldSummaryWithMetadata());
			// No sessions + tiny diff -> isTrivialAmendDelta=true -> short-circuit A
			vi.mocked(loadAllSessions).mockResolvedValue([]);
			vi.mocked(getDiffContent).mockResolvedValue("");
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });

			await runWorker("/test/project");

			// Short-circuit A must NOT call generateSummary (0 LLM)
			expect(generateSummary).not.toHaveBeenCalled();
			expect(storeSummary).toHaveBeenCalled();
			expect(associatePlanWithCommit).toHaveBeenCalledWith("plan-old", "newHash", "/test/project");
			expect(associateNoteWithCommit).toHaveBeenCalledWith("note-old", "newHash", "/test/project");
		});

		it("re-associates plans and notes on short-circuit B (1 LLM, empty delta)", async () => {
			setupAmend();
			vi.mocked(getSummary).mockResolvedValue(oldSummaryWithMetadata());
			// Sessions with entries -> not trivial. Delta returns no topics + no recap -> short-circuit B.
			vi.mocked(loadAllSessions).mockResolvedValue([
				{ sessionId: "sess-1", transcriptPath: "/path/to/transcript.jsonl", updatedAt: "2026-02-19" },
			]);
			vi.mocked(readTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Amend" }],
				newCursor: { transcriptPath: "/path/to/transcript.jsonl", lineNumber: 10, updatedAt: "2026-02-19" },
				totalLinesRead: 10,
			});
			vi.mocked(buildMultiSessionContext).mockReturnValue("[Human]: Amend");
			vi.mocked(getDiffContent).mockResolvedValue("diff content");
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 5, deletions: 2 });
			vi.mocked(generateSummary).mockResolvedValue({
				...createMockResult(),
				topics: [],
				recap: undefined,
			});

			await runWorker("/test/project");

			expect(generateSummary).toHaveBeenCalledTimes(1);
			expect(storeSummary).toHaveBeenCalled();
			expect(associatePlanWithCommit).toHaveBeenCalledWith("plan-old", "newHash", "/test/project");
			expect(associateNoteWithCommit).toHaveBeenCalledWith("note-old", "newHash", "/test/project");
		});

		it("re-associates plans and notes on full path (2 LLM, non-empty delta)", async () => {
			setupAmend();
			vi.mocked(getSummary).mockResolvedValue(oldSummaryWithMetadata());
			vi.mocked(loadAllSessions).mockResolvedValue([
				{ sessionId: "sess-1", transcriptPath: "/path/to/transcript.jsonl", updatedAt: "2026-02-19" },
			]);
			vi.mocked(readTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Amend" }],
				newCursor: { transcriptPath: "/path/to/transcript.jsonl", lineNumber: 10, updatedAt: "2026-02-19" },
				totalLinesRead: 10,
			});
			vi.mocked(buildMultiSessionContext).mockReturnValue("[Human]: Amend");
			vi.mocked(getDiffContent).mockResolvedValue("diff content");
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 5, deletions: 2 });
			// Delta returns substantive topics -> full path (consolidate runs)
			vi.mocked(generateSummary).mockResolvedValue(createMockResult());

			await runWorker("/test/project");

			expect(storeSummary).toHaveBeenCalled();
			expect(associatePlanWithCommit).toHaveBeenCalledWith("plan-old", "newHash", "/test/project");
			expect(associateNoteWithCommit).toHaveBeenCalledWith("note-old", "newHash", "/test/project");
		});
	});

	// ─── runWorker edge cases ────────────────────────────────────────────────

	describe("runWorker edge cases", () => {
		it("handles getProjectRootDir failure gracefully", async () => {
			setupFullPipeline();
			vi.mocked(getProjectRootDir).mockRejectedValueOnce(new Error("not a git repo"));

			await runWorker("/test/project");

			// Should still process the queue successfully
			expect(storeSummary).toHaveBeenCalled();
		});

		it("handles pipeline error without crashing", async () => {
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([DEFAULT_COMMIT_OP]).mockResolvedValue([]);
			vi.mocked(deleteQueueEntry).mockResolvedValue(undefined);
			// Make getCommitInfo throw to trigger pipeline error
			vi.mocked(getCommitInfo).mockRejectedValue(new Error("git error"));

			await runWorker("/test/project");

			// Entry should still be deleted despite the error
			expect(deleteQueueEntry).toHaveBeenCalled();
		});

		it("warns on unknown queue entry type", async () => {
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([
					{
						op: {
							type: "unknown-type" as "commit",
							commitHash: "abc",
							createdAt: "2026-02-19T00:00:00.000Z",
						},
						filePath: "/test/path",
					},
				])
				.mockResolvedValue([]);
			vi.mocked(deleteQueueEntry).mockResolvedValue(undefined);

			await runWorker("/test/project");

			expect(deleteQueueEntry).toHaveBeenCalled();
		});

		it("spawns a chain worker when new entries appear after the main run finishes", async () => {
			// Process one entry in the main loop (first two dequeue calls), then the
			// post-lock-release check finds a remaining entry — triggering launchWorker.
			setupFullPipeline();
			vi.mocked(dequeueAllGitOperations)
				.mockReset()
				// First call inside the while loop: one entry to process
				.mockResolvedValueOnce([DEFAULT_COMMIT_OP])
				// Second call inside the while loop: empty → break
				.mockResolvedValueOnce([])
				// Third call after the finally block: one remaining entry → chain spawn
				.mockResolvedValueOnce([DEFAULT_COMMIT_OP]);
			vi.mocked(deleteQueueEntry).mockResolvedValue(undefined);
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "abc123",
				message: "Fix bug",
				author: "John",
				date: "2026-02-19",
			});
			vi.mocked(generateSummary).mockResolvedValue(createMockResult());

			await runWorker("/test/project");

			// launchWorker should have spawned a background process for the chain
			expect(spawn).toHaveBeenCalled();
		});
	});

	// ─── Squash with partial missing summaries (handleSquashMerge L751-758) ──

	describe("squash with partial missing summaries", () => {
		it("merges available summaries and warns about missing ones", async () => {
			const squashOp = {
				op: {
					type: "squash" as const,
					commitHash: "newHash",
					sourceHashes: ["hash1", "hash2", "hash3"],
					commitSource: "cli" as const,
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockReset().mockResolvedValueOnce([squashOp]).mockResolvedValue([]);
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Squash merge",
				author: "John",
				date: "2026-02-19",
			});
			// hash1 exists, hash2 missing, hash3 exists
			vi.mocked(getSummary)
				.mockResolvedValueOnce(createMockSummary("hash1"))
				.mockResolvedValueOnce(null)
				.mockResolvedValueOnce(createMockSummary("hash3"));
			vi.mocked(mergeManyToOne).mockResolvedValue({ orphanedDocIds: [] });

			await runWorker("/test/project");

			// Should merge available summaries (2 of 3); 5th arg is consolidated topics/recap.
			expect(mergeManyToOne).toHaveBeenCalledWith(
				expect.arrayContaining([
					expect.objectContaining({ commitHash: "hash1" }),
					expect.objectContaining({ commitHash: "hash3" }),
				]),
				expect.anything(),
				"/test/project",
				expect.anything(),
				expect.objectContaining({ topics: expect.any(Array) }),
			);
		});
	});

	// ─── Amend pipeline error handling (L565-567) ─────────────────────────────

	describe("amend pipeline error handling", () => {
		it("catches and logs amend pipeline errors without crashing", async () => {
			const amendOp = {
				op: {
					type: "amend" as const,
					commitHash: "newHash",
					sourceHashes: ["oldHash"],
					commitSource: "cli" as const,
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([amendOp]).mockResolvedValue([]);
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Amended",
				author: "John",
				date: "2026-02-19",
			});
			vi.mocked(getSummary).mockResolvedValue(createMockSummary("oldHash"));
			vi.mocked(loadConfig).mockResolvedValue({});
			// Make loadAllSessions throw to trigger amend pipeline error
			vi.mocked(loadAllSessions).mockRejectedValue(new Error("session load failed"));
			vi.mocked(discoverCodexSessions).mockResolvedValue([]);
			vi.mocked(isCodexInstalled).mockResolvedValue(true);

			// Should not throw
			await runWorker("/test/project");

			expect(deleteQueueEntry).toHaveBeenCalled();
		});
	});

	// ─── hoistMetadataFromOldSummary with e2eTestGuide (L118) ────────────────

	describe("hoistMetadataFromOldSummary with e2eTestGuide", () => {
		it("hoists e2eTestGuide from old summary into amend summary", async () => {
			const amendOp = {
				op: {
					type: "amend" as const,
					commitHash: "newHash",
					sourceHashes: ["oldHash"],
					commitSource: "cli" as const,
					createdAt: "2026-02-19T00:00:00.000Z",
				},
				filePath: "/test/project/.jolli/jollimemory/git-op-queue/1234567890-newHash.json",
			};
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([amendOp]).mockResolvedValue([]);
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: "newHash",
				message: "Amended",
				author: "John",
				date: "2026-02-19",
			});
			vi.mocked(getSummary).mockResolvedValue({
				...createMockSummary("oldHash"),
				e2eTestGuide: [{ title: "Test scenario", steps: ["step 1"], expectedResults: ["assert 1"] }],
			});
			vi.mocked(loadConfig).mockResolvedValue({});
			vi.mocked(loadAllSessions).mockResolvedValue([]);
			vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
			vi.mocked(getCurrentBranch).mockResolvedValue("main");
			// No sessions, no diff → message-only amend path
			vi.mocked(getDiffContent).mockResolvedValue("");
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });
			vi.mocked(discoverCodexSessions).mockResolvedValue([]);
			vi.mocked(isCodexInstalled).mockResolvedValue(true);

			await runWorker("/test/project");

			expect(storeSummary).toHaveBeenCalledWith(
				expect.objectContaining({
					e2eTestGuide: expect.any(Array),
				}),
				"/test/project",
			);
		});
	});

	// ─── Notes edge cases ─────────────────────────────────────────────────────

	describe("notes edge cases", () => {
		it("skips notes not found in registry", async () => {
			setupFullPipeline();
			// Registry has note IDs that don't match any notes entry
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				notes: {
					"note-x": {
						id: "note-x",
						title: "Ghost note",
						format: "markdown" as const,
						sourcePath: "/nonexistent/note.md",
						addedAt: "2026-02-19T00:00:00.000Z",
						updatedAt: "2026-02-19T00:00:00.000Z",
						branch: "main",
						commitHash: null,
					},
				},
			});
			vi.mocked(existsSync).mockReturnValue(false);

			await runWorker("/test/project");

			// Summary should be stored but without notes (sourcePath not found)
			const summaryArg = vi.mocked(storeSummary).mock.calls[0][0] as CommitSummary;
			expect(summaryArg.notes).toBeUndefined();
		});

		it("skips note id that was in detectUncommittedNoteIds set but missing from associateNotesWithCommit registry", async () => {
			setupFullPipeline();

			// loadPlansRegistry is called three times during executePipeline:
			//   1. detectPlanSlugsFromRegistry → empty plans (no plan association)
			//   2. detectUncommittedNoteIds → registry WITH ghost note (id added to set)
			//   3. associateNotesWithCommit → registry WITHOUT that note (id missing → skip)
			const registryWithNote = {
				version: 1 as const,
				plans: {},
				notes: {
					"ghost-note": {
						id: "ghost-note",
						title: "Ghost note",
						format: "markdown" as const,
						sourcePath: "/some/path.md",
						addedAt: "2026-02-19T00:00:00.000Z",
						updatedAt: "2026-02-19T00:00:00.000Z",
						branch: "main",
						commitHash: null,
					},
				},
			};
			const emptyRegistry = { version: 1 as const, plans: {}, notes: {} };

			vi.mocked(loadPlansRegistry)
				.mockResolvedValueOnce(emptyRegistry) // detectPlanSlugsFromRegistry
				.mockResolvedValueOnce(registryWithNote) // detectUncommittedNoteIds
				.mockResolvedValueOnce(emptyRegistry); // associateNotesWithCommit (note is gone)

			await runWorker("/test/project");

			// Summary stored without notes (the id was skipped due to missing registry entry)
			const summaryArg = vi.mocked(storeSummary).mock.calls[0][0] as CommitSummary;
			expect(summaryArg.notes).toBeUndefined();
		});

		it("includes snippet content for snippet-format notes", async () => {
			setupFullPipeline();
			const snippetPath = "/test/project/.jolli/jollimemory/notes/snip-1.md";

			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				notes: {
					"snip-1": {
						id: "snip-1",
						title: "Code snippet",
						format: "snippet" as const,
						sourcePath: snippetPath,
						addedAt: "2026-02-19T00:00:00.000Z",
						updatedAt: "2026-02-19T00:00:00.000Z",
						branch: "main",
						commitHash: null,
					},
				},
			});
			vi.mocked(existsSync).mockImplementation((path) => path === snippetPath);
			vi.mocked(readFileSync).mockImplementation(((path: unknown) => {
				if (path === snippetPath) return "const x = 42;";
				return "";
			}) as typeof readFileSync);

			await runWorker("/test/project");

			expect(storeSummary).toHaveBeenCalledWith(
				expect.objectContaining({
					notes: expect.arrayContaining([
						expect.objectContaining({
							title: "Code snippet",
							format: "snippet",
							content: "const x = 42;",
						}),
					]),
				}),
				"/test/project",
				false,
				expect.anything(),
			);
		});
	});
});
