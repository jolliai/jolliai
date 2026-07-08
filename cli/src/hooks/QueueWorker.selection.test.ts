/**
 * QueueWorker.selection.test
 *
 * Verifies that the summary pipeline respects commit-selection.json exclusions:
 *  - Excluded conversations are dropped from the sessionTranscripts fed to the LLM.
 *  - Excluded plans are dropped from the plans block.
 *  - Excluded notes are dropped from the notes block.
 *  - The pipeline never writes to commit-selection.json (read-only consumer).
 *
 * Drives executePipeline (and processQueueEntry for non-LLM op types) via
 * __test__ exports. All external IO is mocked identically to PostCommitHook.test.ts
 * except CommitSelectionStore — which exercises the real on-disk read path
 * against a temp directory.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module stubs (same surface as PostCommitHook.test.ts) ---

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

vi.mock("../core/GitOps.js", () => ({
	getProjectRootDir: vi.fn().mockImplementation((cwd: string) => Promise.resolve(cwd)),
	getCommitInfo: vi.fn(),
	getHeadHash: vi.fn(),
	getParentHash: vi.fn(),
	getDiffContent: vi.fn(),
	getDiffStats: vi.fn(),
	getCurrentBranch: vi.fn(),
	getLastReflogAction: vi.fn(),
	readFileFromBranch: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/SessionTracker.js")>();
	return {
		loadAllSessions: vi.fn().mockResolvedValue([]),
		loadCursorForTranscript: vi.fn().mockResolvedValue(null),
		saveCursor: vi.fn().mockResolvedValue(undefined),
		loadConfig: vi.fn().mockResolvedValue({}),
		loadSquashPending: vi.fn(),
		deleteSquashPending: vi.fn(),
		loadPluginSource: vi.fn(),
		deletePluginSource: vi.fn(),
		loadPlansRegistry: vi.fn().mockResolvedValue({ version: 1, plans: {} }),
		savePlansRegistry: vi.fn().mockResolvedValue(undefined),
		associatePlanWithCommit: vi.fn().mockResolvedValue(undefined),
		associateNoteWithCommit: vi.fn().mockResolvedValue(undefined),
		associateReferenceWithCommit: vi.fn().mockResolvedValue(undefined),
		detectUncommittedReferenceIds: vi.fn().mockResolvedValue([]),
		discardExcludedWorkingItems: vi.fn().mockResolvedValue({ plans: 0, notes: 0, references: 0 }),
		detectActivePlansForBranch: vi.fn().mockResolvedValue([]),
		detectActiveNotesForBranch: vi.fn().mockResolvedValue([]),
		getReferenceEntriesForBranch: vi.fn().mockResolvedValue([]),
		filterSessionsByEnabledIntegrations: actual.filterSessionsByEnabledIntegrations,
		dequeueAllGitOperations: vi.fn().mockResolvedValue([]),
		deleteQueueEntry: vi.fn().mockResolvedValue(undefined),
		enqueueGitOperation: vi.fn(),
	};
});

vi.mock("../core/references/ReferenceStore.js", () => ({
	referencePath: vi.fn(
		(cwd: string, source: string, key: string) => `${cwd}/.jolli/jollimemory/references/${source}/${key}.md`,
	),
	referenceDir: vi.fn((cwd: string, source: string) => `${cwd}/.jolli/jollimemory/references/${source}`),
	sanitizeNativeIdForPath: vi.fn((_source: string, id: string) => id),
	readReferenceMarkdown: vi.fn().mockResolvedValue(null),
	readReferenceMarkdownFromString: vi.fn().mockReturnValue(null),
	writeReferenceMarkdown: vi.fn().mockResolvedValue({ sourcePath: "/x", contentHash: "fakehash" }),
	hashReferenceContent: vi.fn().mockReturnValue("fakehash"),
}));

vi.mock("../core/PlanPromptFormatter.js", () => ({
	formatPlansBlock: vi.fn().mockResolvedValue(""),
}));

vi.mock("../core/NotePromptFormatter.js", () => ({
	formatNotesBlock: vi.fn().mockResolvedValue(""),
}));

vi.mock("../core/Locks.js", () => ({
	acquireWorkerLock: vi.fn().mockResolvedValue(true),
	releaseWorkerLock: vi.fn().mockResolvedValue(undefined),
	refreshWorkerLockMtime: vi.fn(),
	isWorkerLockHeld: vi.fn(),
	withPlansLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
	withCommitSelectionLock: (_projectDir: string, fn: () => Promise<unknown>) => fn(),
	WORKER_PHASE_FILE: "worker-phase",
}));

vi.mock("../core/TranscriptReader.js", () => ({
	readTranscript: vi.fn(),
	buildMultiSessionContext: vi.fn().mockReturnValue(""),
}));

vi.mock("../core/TranscriptParser.js", () => ({
	getParserForSource: vi.fn().mockReturnValue({ parseLine: vi.fn() }),
}));

vi.mock("../core/Summarizer.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/Summarizer.js")>();
	return {
		generateSummary: vi.fn(),
		generateSquashConsolidation: vi.fn().mockResolvedValue(null),
		mechanicalConsolidate: actual.mechanicalConsolidate,
		extractTicketIdFromMessage: actual.extractTicketIdFromMessage,
		formatSourceCommitsForSquash: actual.formatSourceCommitsForSquash,
	};
});

vi.mock("../core/SummaryStore.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/SummaryStore.js")>();
	return {
		storeSummary: vi.fn().mockResolvedValue(undefined),
		getSummary: vi.fn().mockResolvedValue(null),
		mergeManyToOne: vi.fn().mockResolvedValue(undefined),
		migrateOneToOne: vi.fn().mockResolvedValue(undefined),
		storePlans: vi.fn().mockResolvedValue(undefined),
		storeNotes: vi.fn().mockResolvedValue(undefined),
		storeReferences: vi.fn().mockResolvedValue(undefined),
		setActiveStorage: vi.fn(),
		resolveStorage: vi.fn(),
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

vi.mock("../core/ConversationOverlayStore.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/ConversationOverlayStore.js")>();
	return {
		...actual,
		applyOverlaysToSessions: vi.fn(async (sessions: unknown) => sessions),
		loadOverlay: vi.fn(async () => null),
	};
});

vi.mock("../core/HiddenConversationsStore.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/HiddenConversationsStore.js")>();
	return {
		...actual,
		loadHiddenConversations: vi.fn(async () => ({ version: 1, entries: {} })),
	};
});

vi.mock("../core/StaleChildMarkdownCleanup.js", () => ({
	cleanupBranchStaleChildMarkdown: vi.fn().mockResolvedValue({ deleted: 0, failed: 0 }),
}));

vi.mock("../core/PlanProgressEvaluator.js", () => ({
	evaluatePlanProgress: vi.fn().mockResolvedValue(null),
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

// --- Real imports (after vi.mock hoisting) ---

import { conversationKey, setExcluded } from "../core/CommitSelectionStore.js";
import { getCommitInfo, getCurrentBranch, getDiffContent, getDiffStats } from "../core/GitOps.js";
import { formatNotesBlock } from "../core/NotePromptFormatter.js";
import { formatPlansBlock } from "../core/PlanPromptFormatter.js";
import {
	detectActiveNotesForBranch,
	detectActivePlansForBranch,
	detectUncommittedReferenceIds,
	discardExcludedWorkingItems,
	getReferenceEntriesForBranch,
	loadAllSessions,
	loadConfig,
	loadCursorForTranscript,
	loadPlansRegistry,
	saveCursor,
} from "../core/SessionTracker.js";
import type { SummaryResult } from "../core/Summarizer.js";
import { generateSummary } from "../core/Summarizer.js";
import { storeSummary } from "../core/SummaryStore.js";
import { buildMultiSessionContext, readTranscript } from "../core/TranscriptReader.js";
import type { CommitGitOperation, NoteEntry, PlanEntry, ReferenceEntry } from "../Types.js";
import { __test__ } from "./QueueWorker.js";

const { executePipeline, processQueueEntry } = __test__;

// --- Minimal mock helpers ---

function makeSummaryResult(): SummaryResult {
	return {
		transcriptEntries: 1,
		llm: { model: "test-model", inputTokens: 10, outputTokens: 5, apiLatencyMs: 100, stopReason: "end_turn" },
		stats: { filesChanged: 1, insertions: 2, deletions: 1 },
		topics: [{ title: "T", trigger: "X", response: "Y", decisions: "Z" }],
	};
}

function makeCommitOp(overrides?: Partial<CommitGitOperation>): CommitGitOperation {
	return {
		type: "commit",
		commitHash: "abc12345",
		commitSource: "cli",
		createdAt: "2026-01-01T00:00:00.000Z",
		branch: "main",
		...overrides,
	};
}

/** Seed standard git mocks so the pipeline gets past diff/branch lookups. */
function seedGitMocks(_cwd: string): void {
	vi.mocked(getCommitInfo).mockResolvedValue({
		hash: "abc12345",
		message: "test commit",
		author: "Test User",
		date: "2026-01-01",
	});
	vi.mocked(getCurrentBranch).mockResolvedValue("main");
	vi.mocked(getDiffContent).mockResolvedValue("diff --git a/foo.ts b/foo.ts");
	vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 2, deletions: 1 });
	vi.mocked(loadConfig).mockResolvedValue({
		codexEnabled: false,
		openCodeEnabled: false,
		cursorEnabled: false,
		copilotEnabled: false,
	} as never);
	vi.mocked(saveCursor).mockResolvedValue(undefined);
	vi.mocked(generateSummary).mockResolvedValue(makeSummaryResult());
}

/** Seed one claude session so loadSessionTranscripts produces a SessionTranscript. */
function seedClaudeSession(sessionId: string, marker: string): void {
	vi.mocked(loadAllSessions).mockResolvedValue([
		{
			sessionId,
			transcriptPath: `/fake/${sessionId}.jsonl`,
			updatedAt: "2026-01-01T00:00:00Z",
			source: "claude" as const,
		},
	]);
	vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
	vi.mocked(readTranscript).mockResolvedValue({
		entries: [{ role: "human", content: marker, timestamp: "t0" }],
		newCursor: { transcriptPath: `/fake/${sessionId}.jsonl`, lineNumber: 1, updatedAt: "2026-01-01T00:00:00Z" },
		totalLinesRead: 1,
	});
}

/** Return the selectionFilePath for a given projectDir. */
function selectionPath(projectDir: string): string {
	return join(projectDir, ".jolli", "jollimemory", "commit-selection.json");
}

// --- Test suite ---

describe("QueueWorker selection filter", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "qw-selection-"));
		vi.clearAllMocks();
		// Restore per-test defaults that clearAllMocks resets:
		vi.mocked(detectActivePlansForBranch).mockResolvedValue([]);
		vi.mocked(detectActiveNotesForBranch).mockResolvedValue([]);
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("skips a conversation that is marked excluded in commit-selection.json", async () => {
		const claudeSessionId = "claude-sess-A";
		const claudeMarker = "UNIQUE_CLAUDE_CONTENT_MARKER";
		seedGitMocks(projectDir);
		seedClaudeSession(claudeSessionId, claudeMarker);

		// Mark claude session as excluded
		await setExcluded(projectDir, "conversations", conversationKey("claude", claudeSessionId), true);

		// Track what buildMultiSessionContext receives
		const capturedSessions: unknown[] = [];
		vi.mocked(buildMultiSessionContext).mockImplementation((sessions) => {
			capturedSessions.push(...sessions);
			return "";
		});

		await executePipeline(projectDir, makeCommitOp());

		// The excluded session must not reach buildMultiSessionContext
		expect(capturedSessions).toHaveLength(0);
	});

	it("passes non-excluded conversations through to buildMultiSessionContext", async () => {
		const claudeSessionId = "claude-sess-B";
		const claudeMarker = "KEEP_THIS_CONTENT";
		seedGitMocks(projectDir);
		seedClaudeSession(claudeSessionId, claudeMarker);

		// Do NOT exclude this session
		const capturedSessions: unknown[] = [];
		vi.mocked(buildMultiSessionContext).mockImplementation((sessions) => {
			capturedSessions.push(...sessions);
			return claudeMarker;
		});

		await executePipeline(projectDir, makeCommitOp());

		expect(capturedSessions).toHaveLength(1);
	});

	it("advances the cursor for an excluded conversation (discard)", async () => {
		// Selection is a one-time discard: an unchecked conversation is consumed
		// (cursor → commit boundary) so it leaves the working area on the next
		// refresh, even though its entries never enter the summary. So the excluded
		// session IS read and its cursor IS advanced — it is just dropped from the
		// summary input (verified elsewhere).
		const claudeSessionId = "claude-sess-excluded";
		seedGitMocks(projectDir);
		seedClaudeSession(claudeSessionId, "EXCLUDED_CONTENT");

		await setExcluded(projectDir, "conversations", conversationKey("claude", claudeSessionId), true);

		await executePipeline(projectDir, makeCommitOp());

		expect(vi.mocked(saveCursor)).toHaveBeenCalled();
		expect(vi.mocked(readTranscript)).toHaveBeenCalled();
	});

	it("advances the cursor for a non-excluded conversation", async () => {
		const claudeSessionId = "claude-sess-included";
		seedGitMocks(projectDir);
		seedClaudeSession(claudeSessionId, "INCLUDED_CONTENT");

		await executePipeline(projectDir, makeCommitOp());

		expect(vi.mocked(saveCursor)).toHaveBeenCalledTimes(1);
	});

	it("excludes an unchecked conversation's usage tokens from stored conversationTokens", async () => {
		// Both conversations are read (so the unchecked one's cursor advances), but only
		// the kept conversation's tokens may count toward the stored total — otherwise
		// the token bar reports A+B while the body/entries reflect only A.
		seedGitMocks(projectDir);
		vi.mocked(buildMultiSessionContext).mockReturnValue("ctx");
		vi.mocked(loadAllSessions).mockResolvedValue([
			{
				sessionId: "sess-keep",
				transcriptPath: "/fake/sess-keep.jsonl",
				updatedAt: "2026-01-01T00:00:00Z",
				source: "claude" as const,
			},
			{
				sessionId: "sess-drop",
				transcriptPath: "/fake/sess-drop.jsonl",
				updatedAt: "2026-01-01T00:00:00Z",
				source: "claude" as const,
			},
		]);
		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
		vi.mocked(readTranscript).mockImplementation(async (transcriptPath: string) => {
			const isKeep = transcriptPath.includes("sess-keep");
			return {
				entries: [{ role: "human", content: isKeep ? "KEEP" : "DROP", timestamp: "t0" }],
				newCursor: { transcriptPath, lineNumber: 1, updatedAt: "2026-01-01T00:00:00Z" },
				totalLinesRead: 1,
				usageTokens: isKeep ? 100 : 999,
			};
		});

		await setExcluded(projectDir, "conversations", conversationKey("claude", "sess-drop"), true);

		await executePipeline(projectDir, makeCommitOp());

		expect(vi.mocked(storeSummary)).toHaveBeenCalledTimes(1);
		const summaryArg = vi.mocked(storeSummary).mock.calls[0][0];
		// 100 (kept) only — NOT 1099 (would include the excluded conversation's 999).
		expect(summaryArg.conversationTokens).toBe(100);
	});

	it("advances the cursor for an excluded conversation on the amend path (discard)", async () => {
		// The amend path shares loadSessionTranscripts, so excluded conversations are
		// discarded there too: consumed (cursor advanced) but dropped from the summary.
		const claudeSessionId = "claude-sess-amend-excluded";
		seedGitMocks(projectDir);
		seedClaudeSession(claudeSessionId, "EXCLUDED_AMEND_CONTENT");

		await setExcluded(projectDir, "conversations", conversationKey("claude", claudeSessionId), true);

		const amendOp = makeCommitOp({ type: "amend", sourceHashes: ["old-hash-0001"] });
		await executePipeline(projectDir, amendOp);

		expect(vi.mocked(saveCursor)).toHaveBeenCalled();
		expect(vi.mocked(readTranscript)).toHaveBeenCalled();
	});

	it("discards excluded plans/notes/references after archival (commit path)", async () => {
		seedGitMocks(projectDir);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		await setExcluded(projectDir, "plans", "plan-skip", true);
		await setExcluded(projectDir, "notes", "note-skip", true);
		await setExcluded(projectDir, "references", "linear:L-9", true);

		await executePipeline(projectDir, makeCommitOp());

		expect(vi.mocked(discardExcludedWorkingItems)).toHaveBeenCalledTimes(1);
		const arg = vi.mocked(discardExcludedWorkingItems).mock.calls[0][0];
		expect(arg.plans.has("plan-skip")).toBe(true);
		expect(arg.notes.has("note-skip")).toBe(true);
		expect(arg.references.has("linear:L-9")).toBe(true);
	});

	it("filters excluded plans out of the plans block input", async () => {
		seedGitMocks(projectDir);
		// No sessions — diff alone will trigger the pipeline
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		const keepPlan: PlanEntry = {
			slug: "plan-keep",
			title: "Keep Plan",
			sourcePath: "/fake/plan-keep.md",
			addedAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			commitHash: null,
		};
		const skipPlan: PlanEntry = {
			slug: "plan-skip",
			title: "Skip Plan",
			sourcePath: "/fake/plan-skip.md",
			addedAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			commitHash: null,
		};
		vi.mocked(detectActivePlansForBranch).mockResolvedValue([keepPlan, skipPlan]);

		// Exclude "plan-skip"
		await setExcluded(projectDir, "plans", "plan-skip", true);

		const capturedPlanArgs: PlanEntry[][] = [];
		vi.mocked(formatPlansBlock).mockImplementation(async (entries) => {
			capturedPlanArgs.push([...entries] as PlanEntry[]);
			return "";
		});

		await executePipeline(projectDir, makeCommitOp());

		expect(capturedPlanArgs).toHaveLength(1);
		const passedSlugs = capturedPlanArgs[0].map((p) => p.slug);
		expect(passedSlugs).toContain("plan-keep");
		expect(passedSlugs).not.toContain("plan-skip");
	});

	it("filters excluded notes out of the notes block input", async () => {
		seedGitMocks(projectDir);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		const keepNote: NoteEntry = {
			id: "note-keep",
			title: "Keep Note",
			format: "markdown",
			addedAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			commitHash: null,
		};
		const skipNote: NoteEntry = {
			id: "note-skip",
			title: "Skip Note",
			format: "markdown",
			addedAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			commitHash: null,
		};
		vi.mocked(detectActiveNotesForBranch).mockResolvedValue([keepNote, skipNote]);

		// Exclude "note-skip"
		await setExcluded(projectDir, "notes", "note-skip", true);

		const capturedNoteArgs: NoteEntry[][] = [];
		vi.mocked(formatNotesBlock).mockImplementation(async (entries) => {
			capturedNoteArgs.push([...entries] as NoteEntry[]);
			return "";
		});

		await executePipeline(projectDir, makeCommitOp());

		expect(capturedNoteArgs).toHaveLength(1);
		const passedIds = capturedNoteArgs[0].map((n) => n.id);
		expect(passedIds).toContain("note-keep");
		expect(passedIds).not.toContain("note-skip");
	});

	it("never writes commit-selection.json from the pipeline (commit path)", async () => {
		const claudeSessionId = "claude-sess-C";
		seedGitMocks(projectDir);
		seedClaudeSession(claudeSessionId, "content-C");
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		// Plant an exclusion so the file exists before the run
		await setExcluded(projectDir, "conversations", conversationKey("claude", claudeSessionId), true);
		const before = await readFile(selectionPath(projectDir), "utf8");

		await executePipeline(projectDir, makeCommitOp());

		const after = await readFile(selectionPath(projectDir), "utf8");
		expect(after).toBe(before);
	});

	it("never writes commit-selection.json on the amend path", async () => {
		const claudeSessionId = "claude-sess-D";
		seedGitMocks(projectDir);
		seedClaudeSession(claudeSessionId, "content-D");
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		// The amend path: op.type = "amend", op.sourceHashes[0] must be set
		// executePipeline hands off to handleAmendPipeline when op.type === "amend"
		const amendOp = makeCommitOp({ type: "amend", sourceHashes: ["old-hash-0000"] });

		await setExcluded(projectDir, "conversations", conversationKey("claude", claudeSessionId), true);
		const before = await readFile(selectionPath(projectDir), "utf8");

		await executePipeline(projectDir, amendOp);

		const after = await readFile(selectionPath(projectDir), "utf8");
		expect(after).toBe(before);
	});

	it("never writes commit-selection.json on the squash path via processQueueEntry", async () => {
		seedGitMocks(projectDir);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		// squash op: needs sourceHashes + an existing summary to proceed
		// getSummary returns null by default → handleSquashFromQueue skips (warns and returns)
		// so no writes are attempted but the pipeline is entered
		const squashOp = makeCommitOp({
			type: "squash",
			sourceHashes: ["src-hash-0001"],
		});

		await setExcluded(projectDir, "conversations", conversationKey("claude", "any-id"), true);
		const before = await readFile(selectionPath(projectDir), "utf8");

		// processQueueEntry is the production dispatch path for squash
		await processQueueEntry(squashOp, projectDir, {} as never, false);

		const after = await readFile(selectionPath(projectDir), "utf8");
		expect(after).toBe(before);
	});

	it("never writes commit-selection.json on the rebase-pick path via processQueueEntry", async () => {
		seedGitMocks(projectDir);
		vi.mocked(loadAllSessions).mockResolvedValue([]);

		const rebasePickOp = makeCommitOp({
			type: "rebase-pick",
			sourceHashes: ["src-hash-0002"],
		});

		await setExcluded(projectDir, "conversations", conversationKey("claude", "any-id"), true);
		const before = await readFile(selectionPath(projectDir), "utf8");

		await processQueueEntry(rebasePickOp, projectDir, {} as never, false);

		const after = await readFile(selectionPath(projectDir), "utf8");
		expect(after).toBe(before);
	});

	it("never writes commit-selection.json on the rebase-squash path via processQueueEntry", async () => {
		seedGitMocks(projectDir);
		vi.mocked(loadAllSessions).mockResolvedValue([]);

		const rebaseSquashOp = makeCommitOp({
			type: "rebase-squash",
			sourceHashes: ["src-hash-0003"],
		});

		await setExcluded(projectDir, "conversations", conversationKey("claude", "any-id"), true);
		const before = await readFile(selectionPath(projectDir), "utf8");

		await processQueueEntry(rebaseSquashOp, projectDir, {} as never, false);

		const after = await readFile(selectionPath(projectDir), "utf8");
		expect(after).toBe(before);
	});

	// ─── Archive-path exclusion (regression: PR #125 only filtered the prompt block) ──
	// The two tests below drive the same pipeline through to `storeSummary` and assert
	// that the excluded plan / note slug is absent from `summary.plans` / `summary.notes`.
	// Without the archive-side filter the excluded entry still gets associated with the
	// commit, written to the orphan branch, and disappears from the panel.

	it("filters excluded plans out of summary.plans on the archive path", async () => {
		seedGitMocks(projectDir);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {
				"plan-keep": {
					slug: "plan-keep",
					title: "Keep Plan",
					sourcePath: "/fake/plan-keep.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
				"plan-skip": {
					slug: "plan-skip",
					title: "Skip Plan",
					sourcePath: "/fake/plan-skip.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
			},
		});

		const fs = await import("node:fs");
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			const s = String(p);
			return s.endsWith("plan-keep.md") || s.endsWith("plan-skip.md");
		});
		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const s = String(p);
			if (s.endsWith("plan-keep.md")) return "# Keep Plan\nbody";
			if (s.endsWith("plan-skip.md")) return "# Skip Plan\nbody";
			return "";
		});

		await setExcluded(projectDir, "plans", "plan-skip", true);

		await executePipeline(projectDir, makeCommitOp());

		expect(vi.mocked(storeSummary)).toHaveBeenCalledTimes(1);
		const summaryArg = vi.mocked(storeSummary).mock.calls[0][0];
		const archivedPlanSlugs = (summaryArg.plans ?? []).map((p) => p.slug);
		// commitHash short = "abc12345" → newSlug pattern is `<slug>-abc12345`
		expect(archivedPlanSlugs).toContain("plan-keep-abc12345");
		expect(archivedPlanSlugs).not.toContain("plan-skip-abc12345");
	});

	it("filters excluded notes out of summary.notes on the archive path", async () => {
		seedGitMocks(projectDir);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {},
			notes: {
				"note-keep": {
					id: "note-keep",
					title: "Keep Note",
					format: "markdown",
					sourcePath: "/fake/note-keep.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
				"note-skip": {
					id: "note-skip",
					title: "Skip Note",
					format: "markdown",
					sourcePath: "/fake/note-skip.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					commitHash: null,
				},
			},
		});

		const fs = await import("node:fs");
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			const s = String(p);
			return s.endsWith("note-keep.md") || s.endsWith("note-skip.md");
		});
		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const s = String(p);
			if (s.endsWith("note-keep.md")) return "# Keep Note\nbody";
			if (s.endsWith("note-skip.md")) return "# Skip Note\nbody";
			return "";
		});

		await setExcluded(projectDir, "notes", "note-skip", true);

		await executePipeline(projectDir, makeCommitOp());

		expect(vi.mocked(storeSummary)).toHaveBeenCalledTimes(1);
		const summaryArg = vi.mocked(storeSummary).mock.calls[0][0];
		const archivedNoteIds = (summaryArg.notes ?? []).map((n) => n.id);
		expect(archivedNoteIds).toContain("note-keep-abc12345");
		expect(archivedNoteIds).not.toContain("note-skip-abc12345");
	});

	// ─── Entity exclusion (panel-level skip-don't-archive) ──────────────────
	// Mirrors the plan / note archive-side filter tests above: an excluded
	// entity must be dropped from BOTH the prompt block AND the
	// archive call. Without the archive-side filter the entity row
	// would still be committed and disappear from the panel — defeating the
	// "uncheck = skip on this commit, reappear next time" semantics.

	it("filters excluded entities out of the prompt-block input", async () => {
		seedGitMocks(projectDir);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		const keepEntity: ReferenceEntry = {
			source: "jira",
			nativeId: "PROJ-1",
			title: "Keep Entity",
			url: "https://example.atlassian.net/browse/PROJ-1",
			sourcePath: "/fake/jira/PROJ-1.md",
			addedAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			sourceToolName: "atlassian-mcp",
		};
		const skipEntity: ReferenceEntry = {
			source: "github",
			nativeId: "owner/repo#42",
			title: "Skip Entity",
			url: "https://github.com/owner/repo/issues/42",
			sourcePath: "/fake/github/owner-repo-42.md",
			addedAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			sourceToolName: "github-mcp",
		};
		vi.mocked(getReferenceEntriesForBranch).mockImplementation(async () => {
			return [keepEntity, skipEntity];
		});

		// Stub readReferenceMarkdown to capture which sourcePaths flow through.
		const referenceStore = await import("../core/references/ReferenceStore.js");
		const readCalls: string[] = [];
		vi.mocked(referenceStore.readReferenceMarkdown).mockImplementation(async (p) => {
			readCalls.push(String(p));
			return null;
		});

		await setExcluded(projectDir, "references", "github:owner/repo#42", true);

		await executePipeline(projectDir, makeCommitOp());

		// The Step-6b loop reads sourcePath via readReferenceMarkdown. Excluded
		// entity must not be read (no disk read for the excluded entity).
		expect(readCalls).toContain("/fake/jira/PROJ-1.md");
		expect(readCalls).not.toContain("/fake/github/owner-repo-42.md");
	});

	it("filters excluded entities out of the archive call", async () => {
		seedGitMocks(projectDir);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");

		// detectUncommittedReferenceIds returns the {mapKey, source, sourcePath}
		// triples that drive the archive step. The filter must
		// drop the excluded mapKey before passing to associateReferencesWithCommit
		// — which we observe indirectly through loadPlansRegistry not being
		// asked to upgrade the entity (we keep the v1-shaped registry mock so
		// associateReferencesWithCommit would throw if called with the excluded id).
		vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([
			{ mapKey: "jira:PROJ-KEEP", source: "jira", sourcePath: "/fake/jira/PROJ-KEEP.md" },
			{ mapKey: "jira:PROJ-SKIP", source: "jira", sourcePath: "/fake/jira/PROJ-SKIP.md" },
		]);
		// Provide a populated registry shape so associateReferencesWithCommit doesn't
		// throw on the kept entry. The kept entry has the full panel-row
		// shape; the excluded entry is intentionally absent (would be
		// "dropped by mapKey not in registry" path otherwise).
		vi.mocked(loadPlansRegistry).mockResolvedValue({
			version: 1,
			plans: {},
			references: {
				"jira:PROJ-KEEP": {
					source: "jira",
					nativeId: "PROJ-KEEP",
					title: "Keep",
					url: "https://x/PROJ-KEEP",
					sourcePath: "/fake/jira/PROJ-KEEP.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					sourceToolName: "atlassian-mcp",
				},
				"jira:PROJ-SKIP": {
					source: "jira",
					nativeId: "PROJ-SKIP",
					title: "Skip",
					url: "https://x/PROJ-SKIP",
					sourcePath: "/fake/jira/PROJ-SKIP.md",
					addedAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					sourceToolName: "atlassian-mcp",
				},
			},
		} as never);

		const referenceStore = await import("../core/references/ReferenceStore.js");
		// readReferenceMarkdown is called inside associateReferencesWithCommit
		// during archive (via the loop reading `entry.sourcePath`). Track
		// which sourcePaths were touched to confirm the excluded entity
		// never reached that loop.
		const archivePaths: string[] = [];
		vi.mocked(referenceStore.readReferenceMarkdown).mockImplementation(async (p) => {
			archivePaths.push(String(p));
			return null;
		});

		await setExcluded(projectDir, "references", "jira:PROJ-SKIP", true);

		await executePipeline(projectDir, makeCommitOp());

		// The kept entity's sourcePath shows up in readReferenceMarkdown (in both
		// the prompt block and the archive call — same helper). The skipped one
		// must NOT appear at all. The prompt-block filter already drops it from
		// the prompt path, and the archive-side filter drops it from the archive path.
		expect(archivePaths.every((p) => !p.includes("PROJ-SKIP"))).toBe(true);
	});
});
