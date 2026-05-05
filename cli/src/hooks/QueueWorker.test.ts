import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
		loadAllSessions: vi.fn().mockResolvedValue([]),
		loadCursorForTranscript: vi.fn(),
		saveCursor: vi.fn(),
		loadConfig: vi.fn().mockResolvedValue({}),
		acquireLock: vi.fn().mockResolvedValue(true),
		releaseLock: vi.fn(),
		loadPlansRegistry: vi.fn().mockResolvedValue({ version: 1, plans: {} }),
		savePlansRegistry: vi.fn().mockResolvedValue(undefined),
		associatePlanWithCommit: vi.fn(),
		associateNoteWithCommit: vi.fn(),
		filterSessionsByEnabledIntegrations: actual.filterSessionsByEnabledIntegrations,
		dequeueAllGitOperations: vi.fn().mockResolvedValue([]),
		deleteQueueEntry: vi.fn(),
		enqueueGitOperation: vi.fn(),
		isLockHeld: vi.fn(),
	};
});

vi.mock("../core/TranscriptReader.js", () => ({
	readTranscript: vi.fn(),
	buildMultiSessionContext: vi.fn().mockReturnValue(""),
}));

vi.mock("../core/Summarizer.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/Summarizer.js")>();
	return {
		generateSummary: vi.fn().mockResolvedValue({
			transcriptEntries: 0,
			conversationTurns: 0,
			llm: { model: "test", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "end_turn" },
			stats: { filesChanged: 1, insertions: 5, deletions: 2 },
			topics: [{ title: "Test topic", trigger: "test", response: "done", decisions: "none" }],
		}),
		// Mock the LLM-touching path; default behaviour returns null so the
		// caller falls through to the (real) mechanicalConsolidate.
		generateSquashConsolidation: vi.fn().mockResolvedValue(null),
		// Real implementations for the pure helpers -- runSquashPipeline /
		// handleAmendPipeline rely on their actual behaviour.
		mechanicalConsolidate: actual.mechanicalConsolidate,
		extractTicketIdFromMessage: actual.extractTicketIdFromMessage,
		formatSourceCommitsForSquash: actual.formatSourceCommitsForSquash,
	};
});

vi.mock("../core/StorageFactory.js", () => ({
	createStorage: vi.fn().mockResolvedValue({
		readFile: vi.fn().mockResolvedValue(null),
		writeFiles: vi.fn().mockResolvedValue(undefined),
		listFiles: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(true),
		ensure: vi.fn().mockResolvedValue(undefined),
	}),
}));

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
		// Real implementations -- runSquashPipeline / handleAmendPipeline call
		// these to expand source commits and copy-hoist topics. The mocks above
		// cover the storage write side; these helpers are pure tree transforms
		// so we want their actual behaviour in tests.
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
	isCodexInstalled: vi.fn().mockResolvedValue(false),
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

vi.mock("../core/CursorSessionDiscoverer.js", () => ({
	discoverCursorSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/CursorDetector.js", () => ({
	isCursorInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/CursorTranscriptReader.js", () => ({
	readCursorTranscript: vi.fn().mockResolvedValue({
		entries: [],
		newCursor: { transcriptPath: "", lineNumber: 0, updatedAt: "" },
		totalLinesRead: 0,
	}),
}));

vi.mock("../core/CopilotDetector.js", () => ({
	isCopilotInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/CopilotSessionDiscoverer.js", () => ({
	discoverCopilotSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/CopilotTranscriptReader.js", () => ({
	readCopilotTranscript: vi.fn().mockResolvedValue({
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

vi.mock("../core/TranscriptParser.js", () => ({
	getParserForSource: vi.fn().mockReturnValue({ parseLine: vi.fn() }),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: vi.fn().mockReturnValue({ unref: vi.fn(), pid: 12345 }),
	};
});

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isCodexInstalled } from "../core/CodexSessionDiscoverer.js";
import { isCopilotInstalled } from "../core/CopilotDetector.js";
import { discoverCopilotSessions } from "../core/CopilotSessionDiscoverer.js";
import { readCopilotTranscript } from "../core/CopilotTranscriptReader.js";
import { isCursorInstalled } from "../core/CursorDetector.js";
import { discoverCursorSessions } from "../core/CursorSessionDiscoverer.js";
import { readCursorTranscript } from "../core/CursorTranscriptReader.js";
import { getCommitInfo, getCurrentBranch, getDiffContent, getDiffStats } from "../core/GitOps.js";
import { discoverOpenCodeSessions, isOpenCodeInstalled } from "../core/OpenCodeSessionDiscoverer.js";
import { readOpenCodeTranscript } from "../core/OpenCodeTranscriptReader.js";
import {
	acquireLock,
	dequeueAllGitOperations,
	loadAllSessions,
	loadConfig,
	loadCursorForTranscript,
	loadPlansRegistry,
	releaseLock,
	saveCursor,
	savePlansRegistry,
} from "../core/SessionTracker.js";
import { generateSummary } from "../core/Summarizer.js";
import { storeSummary } from "../core/SummaryStore.js";
import { buildMultiSessionContext } from "../core/TranscriptReader.js";
import type { GitOperation } from "../Types.js";
import { __test__, runWorker } from "./QueueWorker.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCommitOp(overrides: Partial<GitOperation> = {}): GitOperation {
	return {
		type: "commit",
		commitHash: "abc12345def67890",
		createdAt: "2026-04-01T12:00:00.000Z",
		...overrides,
	};
}

function setupPipelineMocks(hash = "abc12345def67890"): void {
	vi.mocked(getCommitInfo).mockResolvedValue({
		hash,
		message: "Test commit",
		author: "Jane",
		date: "2026-04-01T12:00:00.000Z",
	});
	vi.mocked(getCurrentBranch).mockResolvedValue("feature/test");
	vi.mocked(getDiffContent).mockResolvedValue("diff --git a/file.ts b/file.ts\n+line");
	vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 5, deletions: 2 });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("QueueWorker", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(acquireLock).mockResolvedValue(true);
		vi.mocked(releaseLock).mockResolvedValue(undefined);
		vi.mocked(dequeueAllGitOperations).mockResolvedValue([]);
		vi.mocked(loadConfig).mockResolvedValue(
			{} as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never,
		);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
		vi.mocked(saveCursor).mockResolvedValue(undefined);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
		vi.mocked(savePlansRegistry).mockResolvedValue(undefined);
		vi.mocked(isCodexInstalled).mockResolvedValue(false);
		vi.mocked(isOpenCodeInstalled).mockResolvedValue(false);
		vi.mocked(isCursorInstalled).mockResolvedValue(false);
		vi.mocked(isCopilotInstalled).mockResolvedValue(false);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");
		vi.mocked(generateSummary).mockResolvedValue({
			transcriptEntries: 0,
			conversationTurns: 0,
			llm: { model: "test", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "end_turn" },
			stats: { filesChanged: 1, insertions: 5, deletions: 2 },
			topics: [{ title: "Test topic", trigger: "test", response: "done", decisions: "none" }],
		});
		vi.mocked(storeSummary).mockResolvedValue(undefined);
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readFileSync).mockReturnValue("");
		vi.mocked(spawn).mockReturnValue({ unref: vi.fn(), pid: 12345 } as unknown as ReturnType<typeof spawn>);
	});

	describe("runWorker — MAX_ENTRIES_PER_RUN cap", () => {
		it("stops processing after MAX_ENTRIES_PER_RUN entries in a single batch, leaves the rest for the next run", async () => {
			// Build a batch of 25 entries (>MAX=20) — forces the inner-loop break guard
			// to fire at the 20th entry. The remaining 5 should sit in the queue; the
			// post-finally dequeue call picks them up and triggers the chain-spawn path.
			const batch = Array.from({ length: 25 }, (_, i) => ({
				op: makeCommitOp({ commitHash: `hash${String(i).padStart(4, "0")}` }),
				filePath: `/tmp/queue/entry-${i}.json`,
			}));
			const remainingAfterCap = batch.slice(20); // 5 left over

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce(batch) // 1st while iteration: 25 entries, break at 20
				.mockResolvedValueOnce(remainingAfterCap); // chain-spawn probe: 5 remaining

			setupPipelineMocks();

			await runWorker("/test/cwd");

			// processQueueEntry is called via executePipeline, which depends on many
			// collaborators; rather than assert on the inner pipeline we verify the
			// two observable invariants of the cap:
			//   (1) exactly 20 entries got deleteQueueEntry'd (one per processed entry)
			//   (2) dequeueAllGitOperations was called exactly twice — once inside
			//       the loop (which broke out after 20), once after finally
			const { deleteQueueEntry } = await import("../core/SessionTracker.js");
			expect(vi.mocked(deleteQueueEntry)).toHaveBeenCalledTimes(20);
			expect(vi.mocked(dequeueAllGitOperations)).toHaveBeenCalledTimes(2);
		});
	});

	describe("runWorker — chain spawn", () => {
		it("should detect remaining entries after processing and log chain spawn intent", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/entry.json" };

			// First call inside the while-loop: returns one entry to process
			// Second call inside the while-loop: returns empty (drain complete)
			// Third call after finally block: returns remaining entries (chain spawn)
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([{ op: makeCommitOp({ commitHash: "remaining1" }), filePath: "/tmp/q2.json" }]);

			setupPipelineMocks();

			await runWorker("/test/cwd");

			// The third call to dequeueAllGitOperations happens after the finally block
			// and returns non-empty, triggering lines 234-235 (log + launchWorker).
			// launchWorker is in v8 ignore, so we verify by checking dequeue was called 3 times.
			expect(dequeueAllGitOperations).toHaveBeenCalledTimes(3);
		});
	});

	describe("runWorker — note association with missing registry entry", () => {
		it("should skip notes whose IDs are not in the registry when associating", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/entry.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();

			// Pipeline calls loadPlansRegistry:
			//   1. detectPlanSlugsFromRegistry — no uncommitted plans
			//   2. detectUncommittedNoteIds — finds "ghost-note" with null commitHash
			//   3. associateNotesWithCommit — re-loads registry but "ghost-note" is gone
			// (associatePlansWithCommit skips loadPlansRegistry when slugs.size === 0)
			vi.mocked(loadPlansRegistry)
				.mockResolvedValueOnce({ version: 1, plans: {} })
				.mockResolvedValueOnce({
					version: 1,
					plans: {},
					notes: {
						"ghost-note": {
							id: "ghost-note",
							title: "Ghost",
							format: "snippet" as const,
							sourcePath: "/tmp/ghost.md",
							addedAt: "2026-04-01T00:00:00Z",
							updatedAt: "2026-04-01T00:00:00Z",
							branch: "main",
							commitHash: null,
						},
					},
				})
				.mockResolvedValueOnce({ version: 1, plans: {}, notes: {} });

			await runWorker("/test/cwd");

			// storeSummary should be called (pipeline completed), and no notes in the summary
			expect(storeSummary).toHaveBeenCalledTimes(1);
			const savedSummary = vi.mocked(storeSummary).mock.calls[0][0];
			// Notes should be absent because the only note ID was not found in the registry
			expect(savedSummary.notes).toBeUndefined();
		});
	});

	describe("runWorker error handling", () => {
		it("should catch and log errors from the worker loop", async () => {
			vi.mocked(dequeueAllGitOperations).mockRejectedValueOnce(new Error("I/O error"));

			await runWorker("/test/cwd");

			// Worker should complete without throwing (error caught internally)
			expect(releaseLock).toHaveBeenCalled();
		});
	});

	describe("Cursor integration", () => {
		it("should include discovered Cursor sessions in the pipeline when enabled", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/cursor.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isCursorInstalled).mockResolvedValue(true);
			vi.mocked(discoverCursorSessions).mockResolvedValue([
				{
					sessionId: "cur-1",
					transcriptPath: "/tmp/cursor.vscdb#cur-1",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "cursor",
				},
			]);
			vi.mocked(readCursorTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Cursor context", timestamp: "2026-04-01T12:00:00.000Z" }],
				newCursor: {
					transcriptPath: "/tmp/cursor.vscdb#cur-1",
					lineNumber: 1,
					updatedAt: "2026-04-01T12:00:00.000Z",
				},
				totalLinesRead: 1,
			});

			await runWorker("/test/cwd");

			expect(discoverCursorSessions).toHaveBeenCalledWith("/test/cwd");
			expect(readCursorTranscript).toHaveBeenCalledWith(
				"/tmp/cursor.vscdb#cur-1",
				null,
				"2026-04-01T12:00:00.000Z",
			);
			expect(saveCursor).toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/tmp/cursor.vscdb#cur-1", lineNumber: 1 }),
				"/test/cwd",
			);
		});

		it("skips discovery when cursorEnabled is explicitly false", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/cursor-disabled.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({ cursorEnabled: false } as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isCursorInstalled).mockResolvedValue(true);

			await runWorker("/test/cwd");

			// cursorEnabled=false short-circuits before isCursorInstalled is consulted
			expect(isCursorInstalled).not.toHaveBeenCalled();
			expect(discoverCursorSessions).not.toHaveBeenCalled();
		});
	});

	describe("Cursor integration — empty sessions", () => {
		it("logs no Discovered count when isCursorInstalled=true but discovery returns empty", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/cursor-empty.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(isCursorInstalled).mockResolvedValue(true);
			vi.mocked(discoverCursorSessions).mockResolvedValue([]);

			await runWorker("/test/cwd");

			expect(discoverCursorSessions).toHaveBeenCalledWith("/test/cwd");
			expect(storeSummary).toHaveBeenCalled();
		});
	});

	describe("OpenCode integration", () => {
		it("should include discovered OpenCode sessions in the pipeline when enabled", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/open-code.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isOpenCodeInstalled).mockResolvedValue(true);
			vi.mocked(discoverOpenCodeSessions).mockResolvedValue([
				{
					sessionId: "op-1",
					transcriptPath: "/tmp/opencode.db#op-1",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "opencode",
				},
			]);
			vi.mocked(readOpenCodeTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "OpenCode context", timestamp: "2026-04-01T12:00:00.000Z" }],
				newCursor: {
					transcriptPath: "/tmp/opencode.db#op-1",
					lineNumber: 1,
					updatedAt: "2026-04-01T12:00:00.000Z",
				},
				totalLinesRead: 1,
			});

			await runWorker("/test/cwd");

			expect(discoverOpenCodeSessions).toHaveBeenCalledWith("/test/cwd");
			expect(readOpenCodeTranscript).toHaveBeenCalledWith(
				"/tmp/opencode.db#op-1",
				null,
				"2026-04-01T12:00:00.000Z",
			);
			expect(saveCursor).toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/tmp/opencode.db#op-1", lineNumber: 1 }),
				"/test/cwd",
			);
		});
	});

	describe("hoistMetadataFromOldSummary", () => {
		it("returns empty object when oldSummary is null", () => {
			expect(__test__.hoistMetadataFromOldSummary(null)).toEqual({});
		});

		it("returns empty object when oldSummary is undefined", () => {
			expect(__test__.hoistMetadataFromOldSummary(undefined)).toEqual({});
		});

		it("omits absent fields so the && falsy branches are exercised", () => {
			// Minimal summary with ZERO hoistable metadata — every `&&` branch hits its falsy side.
			const bare = {
				version: 3 as const,
				commitHash: "h",
				commitMessage: "m",
				commitAuthor: "a",
				commitDate: "2026-04-01T00:00:00.000Z",
				branch: "b",
				generatedAt: "2026-04-01T00:00:00.000Z",
				topics: [],
			};
			expect(__test__.hoistMetadataFromOldSummary(bare)).toEqual({});
		});

		it("hoists every field when present", () => {
			const rich = {
				version: 3 as const,
				commitHash: "h",
				commitMessage: "m",
				commitAuthor: "a",
				commitDate: "2026-04-01T00:00:00.000Z",
				branch: "b",
				generatedAt: "2026-04-01T00:00:00.000Z",
				topics: [],
				jolliDocId: 42,
				jolliDocUrl: "https://jolli.app/d/42",
				orphanedDocIds: [1, 2],
				plans: [{ slug: "p", title: "P", editCount: 1, addedAt: "x", updatedAt: "y" }],
				notes: [{ id: "n", title: "N", format: "markdown" as const, addedAt: "x", updatedAt: "y" }],
				e2eTestGuide: [{ title: "T", steps: ["s"], expectedResults: ["r"] }],
			};
			const out = __test__.hoistMetadataFromOldSummary(rich);
			expect(out.jolliDocId).toBe(42);
			expect(out.jolliDocUrl).toBe("https://jolli.app/d/42");
			expect(out.orphanedDocIds).toEqual([1, 2]);
			expect(out.plans).toHaveLength(1);
			expect(out.notes).toHaveLength(1);
			expect(out.e2eTestGuide).toHaveLength(1);
		});
	});

	describe("detectUncommittedNoteIds", () => {
		it("returns only notes with null commitHash and no ignored/contentHashAtCommit", async () => {
			vi.mocked(loadPlansRegistry).mockResolvedValueOnce({
				version: 1,
				plans: {},
				notes: {
					fresh: {
						id: "fresh",
						title: "Fresh",
						format: "markdown" as const,
						sourcePath: "/p",
						addedAt: "x",
						updatedAt: "y",
						branch: "main",
						commitHash: null,
					},
					// Fails branch: already committed
					committed: {
						id: "committed",
						title: "Committed",
						format: "markdown" as const,
						sourcePath: "/p",
						addedAt: "x",
						updatedAt: "y",
						branch: "main",
						commitHash: "abc123",
					},
					// Fails branch: ignored
					ignored: {
						id: "ignored",
						title: "Ignored",
						format: "markdown" as const,
						sourcePath: "/p",
						addedAt: "x",
						updatedAt: "y",
						branch: "main",
						commitHash: null,
						ignored: true,
					},
					// Fails branch: contentHashAtCommit set (guard entry)
					guard: {
						id: "guard",
						title: "Guard",
						format: "markdown" as const,
						sourcePath: "/p",
						addedAt: "x",
						updatedAt: "y",
						branch: "main",
						commitHash: null,
						contentHashAtCommit: "hash",
					},
				},
			});

			const ids = await __test__.detectUncommittedNoteIds("/test/cwd");
			expect([...ids].sort()).toEqual(["fresh"]);
		});

		it("returns empty set when registry has no notes field", async () => {
			vi.mocked(loadPlansRegistry).mockResolvedValueOnce({ version: 1, plans: {} });
			const ids = await __test__.detectUncommittedNoteIds("/test/cwd");
			expect(ids.size).toBe(0);
		});
	});

	describe("buildStoredTranscript", () => {
		it("keeps per-session source/transcriptPath even when two sources share the same sessionId", async () => {
			// Regression: the previous Map<sessionId,…> lookup would collapse these
			// two into a single entry because UUID collisions across integrations
			// can't be ruled out and the transcriptPath on collision differs per source.
			const stored = __test__.buildStoredTranscript([
				{
					sessionId: "shared-uuid",
					transcriptPath: "/claude/sessions/shared-uuid.jsonl",
					source: "claude",
					entries: [{ role: "human", content: "hi from claude", timestamp: "2026-04-22T10:00:00Z" }],
				},
				{
					sessionId: "shared-uuid",
					transcriptPath: "/tmp/opencode.db#shared-uuid",
					source: "opencode",
					entries: [{ role: "human", content: "hi from opencode", timestamp: "2026-04-22T10:00:01Z" }],
				},
			]);

			expect(stored.sessions).toHaveLength(2);
			const claudeSession = stored.sessions[0];
			const opencodeSession = stored.sessions[1];
			expect(claudeSession.source).toBe("claude");
			expect(claudeSession.transcriptPath).toBe("/claude/sessions/shared-uuid.jsonl");
			expect(opencodeSession.source).toBe("opencode");
			expect(opencodeSession.transcriptPath).toBe("/tmp/opencode.db#shared-uuid");
		});

		it("preserves sessionTranscripts that arrive without a source (legacy claude rows)", async () => {
			const stored = __test__.buildStoredTranscript([
				{
					sessionId: "legacy-session",
					transcriptPath: "/claude/legacy.jsonl",
					// source intentionally omitted — pre-multi-source data shape
					entries: [],
				},
			]);

			expect(stored.sessions).toHaveLength(1);
			expect(stored.sessions[0].source).toBeUndefined();
			expect(stored.sessions[0].transcriptPath).toBe("/claude/legacy.jsonl");
		});
	});

	describe("OpenCode integration — empty sessions", () => {
		it("logs no Discovered count when isOpenCodeInstalled=true but discovery returns empty", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/entry.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(isOpenCodeInstalled).mockResolvedValue(true);
			vi.mocked(discoverOpenCodeSessions).mockResolvedValue([]);

			await runWorker("/test/cwd");

			expect(discoverOpenCodeSessions).toHaveBeenCalledWith("/test/cwd");
			// Pipeline completes normally
			expect(storeSummary).toHaveBeenCalled();
		});
	});

	describe("Copilot integration", () => {
		it("should include discovered Copilot sessions in the pipeline when enabled", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/copilot.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isCopilotInstalled).mockResolvedValue(true);
			vi.mocked(discoverCopilotSessions).mockResolvedValue([
				{
					sessionId: "cp-1",
					transcriptPath: "/db.sqlite#cp-1",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "copilot",
				},
			]);
			vi.mocked(readCopilotTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Copilot context", timestamp: "2026-04-01T12:00:00.000Z" }],
				newCursor: {
					transcriptPath: "/db.sqlite#cp-1",
					lineNumber: 1,
					updatedAt: "2026-04-01T12:00:00.000Z",
				},
				totalLinesRead: 1,
			});

			await runWorker("/test/cwd");

			expect(discoverCopilotSessions).toHaveBeenCalledWith("/test/cwd");
			expect(readCopilotTranscript).toHaveBeenCalledWith("/db.sqlite#cp-1", null, "2026-04-01T12:00:00.000Z");
			expect(saveCursor).toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/db.sqlite#cp-1", lineNumber: 1 }),
				"/test/cwd",
			);
		});
	});

	describe("Copilot integration — disabled", () => {
		it("should not call isCopilotInstalled or discoverCopilotSessions when copilotEnabled is false", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/copilot-disabled.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({
				copilotEnabled: false,
			} as Awaited<ReturnType<typeof loadConfig>>);

			await runWorker("/test/cwd");

			expect(isCopilotInstalled).not.toHaveBeenCalled();
			expect(discoverCopilotSessions).not.toHaveBeenCalled();
		});
	});

	describe("Copilot integration — empty sessions", () => {
		it("logs no Discovered count when isCopilotInstalled=true but discovery returns empty", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/copilot-empty.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(isCopilotInstalled).mockResolvedValue(true);
			vi.mocked(discoverCopilotSessions).mockResolvedValue([]);

			await runWorker("/test/cwd");

			expect(discoverCopilotSessions).toHaveBeenCalledWith("/test/cwd");
			// Pipeline completes normally
			expect(storeSummary).toHaveBeenCalled();
		});
	});

	describe("Copilot integration — read failure", () => {
		it("skips a Copilot session whose transcript read throws and continues with the rest of the pipeline", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/copilot-throws.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isCopilotInstalled).mockResolvedValue(true);
			vi.mocked(discoverCopilotSessions).mockResolvedValue([
				{
					sessionId: "cp-broken",
					transcriptPath: "/db.sqlite#cp-broken",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "copilot",
				},
			]);
			vi.mocked(readCopilotTranscript).mockRejectedValue(new Error("Cannot read Copilot session: cp-broken"));

			await runWorker("/test/cwd");

			expect(readCopilotTranscript).toHaveBeenCalledWith(
				"/db.sqlite#cp-broken",
				null,
				"2026-04-01T12:00:00.000Z",
			);
			// Pipeline still completes — the broken session was skipped, not fatal
			expect(storeSummary).toHaveBeenCalled();
			// No cursor saved for the failed session
			expect(saveCursor).not.toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/db.sqlite#cp-broken" }),
				"/test/cwd",
			);
		});
	});

	describe("squash helpers", () => {
		it("should skip squash queue entries without source hashes", async () => {
			await expect(__test__.handleSquashFromQueue(makeCommitOp(), "/test/cwd")).resolves.toBeUndefined();
		});

		it("should default squash commitSource to cli", async () => {
			const { getSummary, mergeManyToOne } = await import("../core/SummaryStore.js");
			vi.mocked(getSummary).mockResolvedValue({
				version: 3,
				commitHash: "oldhash",
				commitMessage: "Old",
				commitAuthor: "Jane",
				commitDate: "2026-04-01T10:00:00.000Z",
				branch: "feature/test",
				generatedAt: "2026-04-01T10:00:00.000Z",
				topics: [{ title: "Old topic", trigger: "t", response: "r", decisions: "d" }],
			} as Awaited<ReturnType<typeof getSummary>>);
			setupPipelineMocks("newhash123");

			await __test__.handleSquashFromQueue(
				makeCommitOp({ commitHash: "newhash123", sourceHashes: ["oldhash"] }),
				"/test/cwd",
			);

			// runSquashPipeline calls mergeManyToOne with a 5th `consolidated`
			// argument (LLM result or mechanicalConsolidate fallback).
			expect(mergeManyToOne).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({ hash: "newhash123" }),
				"/test/cwd",
				expect.objectContaining({ commitSource: "cli", commitType: "squash" }),
				expect.objectContaining({ topics: expect.any(Array) }),
			);
		});
	});
});
