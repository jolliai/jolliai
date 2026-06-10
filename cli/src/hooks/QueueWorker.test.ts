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
		loadPlansRegistry: vi.fn().mockResolvedValue({ version: 1, plans: {} }),
		savePlansRegistry: vi.fn().mockResolvedValue(undefined),
		associatePlanWithCommit: vi.fn(),
		associateNoteWithCommit: vi.fn(),
		detectUncommittedReferenceIds: vi.fn().mockResolvedValue([]),
		detectActivePlansForBranch: vi.fn().mockResolvedValue([]),
		detectActiveNotesForBranch: vi.fn().mockResolvedValue([]),
		getReferenceEntriesForBranch: vi.fn().mockResolvedValue([]),
		filterSessionsByEnabledIntegrations: actual.filterSessionsByEnabledIntegrations,
		dequeueAllGitOperations: vi.fn().mockResolvedValue([]),
		deleteQueueEntry: vi.fn(),
		enqueueGitOperation: vi.fn(),
	};
});

// ReferenceStore is fs-bound; mock it so QueueWorker tests don't touch disk
vi.mock("../core/references/ReferenceStore.js", () => ({
	referencePath: vi.fn(
		(cwd: string, source: string, key: string) => `${cwd}/.jolli/jollimemory/references/${source}/${key}.md`,
	),
	referenceDir: vi.fn((cwd: string, source: string) => `${cwd}/.jolli/jollimemory/references/${source}`),
	sanitizeNativeIdForPath: vi.fn((_source: string, id: string) => id),
	readReferenceMarkdown: vi.fn().mockResolvedValue(null),
	readReferenceMarkdownFromString: vi.fn().mockReturnValue(null),
	writeReferenceMarkdown: vi.fn().mockResolvedValue({ sourcePath: "/x", contentHash: "fake-content-hash" }),
	deleteReferenceMarkdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/PlanPromptFormatter.js", () => ({
	formatPlansBlock: vi.fn().mockResolvedValue(""),
}));

vi.mock("../core/NotePromptFormatter.js", () => ({
	formatNotesBlock: vi.fn().mockResolvedValue(""),
}));

vi.mock("../core/Locks.js", () => ({
	acquireWorkerLock: vi.fn().mockResolvedValue(true),
	releaseWorkerLock: vi.fn(),
	refreshWorkerLockMtime: vi.fn(),
	isWorkerLockHeld: vi.fn(),
	// Passthrough: run the RMW body without touching the real lock file. The
	// per-worktree lock contract itself is covered in Locks.test.ts.
	withPlansLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
	WORKER_PHASE_FILE: "worker-phase",
}));

// `vault-write.lock` integration: the Standalone Hotfix now wraps the worker
// in `acquireVaultWriteLock`. Tests mock it to always succeed so the
// drain-queue test path stays focused on per-entry behaviour. A separate
// QueueWorker.vaultLock test file exercises the lock acquisition / release
// contract directly.
vi.mock("../sync/VaultWriteLock.js", () => ({
	acquireVaultWriteLock: vi.fn().mockResolvedValue({
		release: vi.fn().mockResolvedValue(undefined),
		refresh: vi.fn().mockResolvedValue(undefined),
	}),
	DEFAULT_VAULT_WRITE_WAIT_MS: 60_000,
	isVaultWriteLockHeld: vi.fn(),
}));

// PendingWorkers cross-repo wakeup helpers. Mocked so tests can verify
// QueueWorker records its cwd on lock acquisition failure (L295/309-314)
// and skips itself when consuming on release (L425).
vi.mock("../sync/PendingWorkers.js", () => ({
	recordPendingWorker: vi.fn().mockResolvedValue(undefined),
	consumePendingWorkers: vi.fn().mockResolvedValue([]),
}));

vi.mock("../sync/SyncBootstrap.js", () => ({
	deriveMemoryBankRoot: vi.fn((localFolder?: string) => localFolder ?? "/tmp/jolli-test-vault"),
}));

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
		// Mock the LLM-touching path; default behaviour returns "no-content"
		// so the caller falls through to the (real) mechanicalConsolidate
		// WITHOUT setting a summaryError marker — healthy "nothing to merge"
		// path is what most tests exercise by default.
		generateSquashConsolidation: vi.fn().mockResolvedValue({ status: "no-content" }),
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

// Linear-legacy elimination preflight (Phase A). The preflight gates on
// MigrationState + the orphan branch's exists() — both mocked away here so
// the existing run-worker tests do NOT exercise the migration path. The
// dedicated "linear-legacy elimination preflight" describe-block below
// re-mocks `readMigrationState` per case to drive the gate explicitly.
const mockOrphanLinearMigration = vi.hoisted(() =>
	vi.fn().mockResolvedValue({ status: "noop", movedFiles: 0, rewroteSummaries: 0 }),
);

vi.mock("../core/OrphanBranchLinearMigration.js", () => ({
	migrateOrphanBranchLinearLegacy: mockOrphanLinearMigration,
}));

const mockMetadataManagerInstance = vi.hoisted(() => ({
	readMigrationState: vi.fn(() => null as ReturnType<typeof Object> | null),
	saveMigrationState: vi.fn(),
}));

vi.mock("../core/MetadataManager.js", () => ({
	MetadataManager: vi.fn(function MockMetadataManager() {
		return mockMetadataManagerInstance;
	}),
}));

vi.mock("../core/KBPathResolver.js", () => ({
	extractRepoName: vi.fn(() => "test-repo"),
	getRemoteUrl: vi.fn(() => null),
	resolveKBPath: vi.fn(() => "/tmp/jolli-test-kb"),
}));

// Stateful mock controls whether the OrphanBranchStorage stub returned by the
// constructor reports exists()==true. Tests that exercise the preflight set
// this to true; default false so the preflight short-circuits in unrelated
// tests.
const orphanExistsForPreflight = vi.hoisted(() => ({ value: false }));

vi.mock("../core/OrphanBranchStorage.js", () => ({
	OrphanBranchStorage: vi.fn(function MockOrphanBranchStorage() {
		return {
			exists: vi.fn(async () => orphanExistsForPreflight.value),
			ensure: vi.fn().mockResolvedValue(undefined),
			readFile: vi.fn().mockResolvedValue(null),
			writeFiles: vi.fn().mockResolvedValue(undefined),
			listFiles: vi.fn().mockResolvedValue([]),
		};
	}),
}));

vi.mock("../core/FolderStorage.js", () => ({
	FolderStorage: vi.fn(function MockFolderStorage() {
		return {
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn().mockResolvedValue(undefined),
			readFile: vi.fn().mockResolvedValue(null),
			writeFiles: vi.fn().mockResolvedValue(undefined),
			listFiles: vi.fn().mockResolvedValue([]),
		};
	}),
}));

vi.mock("../core/StaleChildMarkdownCleanup.js", () => ({
	cleanupBranchStaleChildMarkdown: vi.fn().mockResolvedValue({ deleted: 0, failed: 0 }),
	cleanupAllBranchesStaleChildMarkdown: vi.fn().mockResolvedValue({ deleted: 0, failed: 0 }),
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
		storeReferences: vi.fn().mockResolvedValue(undefined),
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

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		readFile: vi.fn().mockResolvedValue(""),
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

vi.mock("../core/CopilotChatDetector.js", () => ({
	isCopilotChatInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/CopilotChatSessionDiscoverer.js", () => ({
	discoverCopilotChatSessions: vi.fn().mockResolvedValue([]),
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

vi.mock("../core/IngestPipeline.js", () => ({
	drainIngest: vi.fn(async () => ({ batches: 0, ingested: 0, outcome: "NO_PENDING", topicFailures: [] })),
}));

vi.mock("../core/TopicWikiRenderer.js", () => ({
	renderTopicKBWiki: vi.fn(async () => {}),
}));

vi.mock("../core/IngestRunStore.js", () => ({
	appendCredentialMissingRun: vi.fn(async () => {}),
	appendIngestRun: vi.fn(async () => {}),
}));

vi.mock("../core/IngestTrigger.js", () => ({
	enqueueIngestOperation: vi.fn(async () => true),
}));

// Suppress console output
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCodexInstalled } from "../core/CodexSessionDiscoverer.js";
import { isCopilotChatInstalled } from "../core/CopilotChatDetector.js";
import { discoverCopilotChatSessions } from "../core/CopilotChatSessionDiscoverer.js";
import { isCopilotInstalled } from "../core/CopilotDetector.js";
import { discoverCopilotSessions } from "../core/CopilotSessionDiscoverer.js";
import { readCopilotTranscript } from "../core/CopilotTranscriptReader.js";
import { isCursorInstalled } from "../core/CursorDetector.js";
import { discoverCursorSessions } from "../core/CursorSessionDiscoverer.js";
import { readCursorTranscript } from "../core/CursorTranscriptReader.js";
import { getCommitInfo, getCurrentBranch, getDiffContent, getDiffStats } from "../core/GitOps.js";
import { drainIngest } from "../core/IngestPipeline.js";
import { appendCredentialMissingRun } from "../core/IngestRunStore.js";
import { enqueueIngestOperation } from "../core/IngestTrigger.js";
import { LlmCredentialError } from "../core/LlmClient.js";
import { acquireWorkerLock, releaseWorkerLock } from "../core/Locks.js";
import { discoverOpenCodeSessions, isOpenCodeInstalled } from "../core/OpenCodeSessionDiscoverer.js";
import { readOpenCodeTranscript } from "../core/OpenCodeTranscriptReader.js";
import {
	dequeueAllGitOperations,
	detectActiveNotesForBranch,
	detectActivePlansForBranch,
	detectUncommittedReferenceIds,
	getReferenceEntriesForBranch,
	loadAllSessions,
	loadConfig,
	loadCursorForTranscript,
	loadPlansRegistry,
	saveCursor,
	savePlansRegistry,
} from "../core/SessionTracker.js";
import { cleanupBranchStaleChildMarkdown } from "../core/StaleChildMarkdownCleanup.js";
import { createStorage } from "../core/StorageFactory.js";
import { generateSummary } from "../core/Summarizer.js";
import { storeSummary } from "../core/SummaryStore.js";
import { renderTopicKBWiki } from "../core/TopicWikiRenderer.js";
import { buildMultiSessionContext } from "../core/TranscriptReader.js";
import { consumePendingWorkers, recordPendingWorker } from "../sync/PendingWorkers.js";
import { acquireVaultWriteLock } from "../sync/VaultWriteLock.js";
import type { CommitGitOperation, IngestOperation } from "../Types.js";
import { __test__, buildWorkerStartupBanner, launchWorker, runWorker } from "./QueueWorker.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCommitOp(overrides: Partial<CommitGitOperation> = {}): CommitGitOperation {
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
		vi.mocked(acquireWorkerLock).mockResolvedValue(true);
		vi.mocked(releaseWorkerLock).mockResolvedValue(undefined);
		// vault-write.lock: re-establish the always-succeed implementation
		// after `resetAllMocks` wipes the factory default. The handle's
		// `release` / `refresh` are themselves `vi.fn()` so per-test
		// assertions can spy on them if needed.
		vi.mocked(acquireVaultWriteLock).mockResolvedValue({
			release: vi.fn().mockResolvedValue(undefined),
			refresh: vi.fn().mockResolvedValue(undefined),
		});
		vi.mocked(dequeueAllGitOperations).mockResolvedValue([]);
		vi.mocked(loadConfig).mockResolvedValue(
			{} as ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never,
		);
		vi.mocked(loadAllSessions).mockResolvedValue([]);
		vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
		vi.mocked(saveCursor).mockResolvedValue(undefined);
		vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {} });
		vi.mocked(savePlansRegistry).mockResolvedValue(undefined);
		vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([]);
		vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([]);
		vi.mocked(detectActivePlansForBranch).mockResolvedValue([]);
		vi.mocked(detectActiveNotesForBranch).mockResolvedValue([]);
		vi.mocked(getReferenceEntriesForBranch).mockResolvedValue([]);
		vi.mocked(getReferenceEntriesForBranch).mockResolvedValue([]);
		vi.mocked(isCodexInstalled).mockResolvedValue(false);
		vi.mocked(isOpenCodeInstalled).mockResolvedValue(false);
		vi.mocked(isCursorInstalled).mockResolvedValue(false);
		vi.mocked(isCopilotInstalled).mockResolvedValue(false);
		vi.mocked(isCopilotChatInstalled).mockResolvedValue(false);
		vi.mocked(discoverCopilotChatSessions).mockResolvedValue([]);
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

	describe("runWorker — vault-write.lock failure path", () => {
		it("records pendingWorker and returns early when vault lock acquisition fails", async () => {
			// Pins QueueWorker.ts L295 (vaultLock === null branch) and
			// L309-314 (recordPendingWorker call + early return). When the
			// vault-write.lock is held by another writer, the worker must
			// record its cwd so the next release re-spawns it, then exit
			// without touching the queue.
			vi.mocked(acquireVaultWriteLock).mockResolvedValueOnce(null);

			await runWorker("/test/cwd-locked");

			// The pending-worker entry must be recorded so a cross-repo
			// release can wake us up.
			expect(recordPendingWorker).toHaveBeenCalledTimes(1);
			expect(recordPendingWorker).toHaveBeenCalledWith(expect.any(String), "/test/cwd-locked");
			// And we MUST NOT have done any queue work.
			expect(dequeueAllGitOperations).not.toHaveBeenCalled();
			expect(acquireWorkerLock).not.toHaveBeenCalled();
		});

		it("consumePendingWorkers wakes other pending cwds but skips self on release", async () => {
			// Pins the `pendingCwd !== cwd` guard on QueueWorker.ts L425 —
			// when our own cwd is recorded as pending (e.g. we raced with
			// ourselves), we must not infinitely re-spawn. Other cwds get
			// `launchWorker` invoked.
			vi.mocked(consumePendingWorkers).mockResolvedValueOnce(["/test/cwd", "/other/cwd"]);
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
			// launchWorker refuses to spawn when the worker bundle is missing;
			// satisfy its existence probe (and only that one) so the wake-up
			// spawn for /other/cwd goes through.
			vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith("QueueWorker.js"));

			await runWorker("/test/cwd");

			expect(consumePendingWorkers).toHaveBeenCalledTimes(1);
			// `launchWorker` is `v8 ignore`d (calls `spawn`), so we verify the
			// observable side: `spawn` was invoked exactly once (for /other/cwd,
			// not /test/cwd).
			expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
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

	describe("runWorker — entity association (multi-source)", () => {
		it("archives entities into the summary with archivedKey populated (Linear projected to linearIssues)", async () => {
			const op = makeCommitOp({ commitHash: "abc12345def67890" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/li.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");

			// Multi-source path: detectUncommittedReferenceIds returns the
			// (mapKey, source, sourcePath) triple list that drives the archive.
			vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([
				{
					mapKey: "linear:PROJ-1528",
					source: "linear",
					sourcePath: "/test/cwd/.jolli/jollimemory/references/linear/PROJ-1528.md",
				},
			]);
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				references: {
					"linear:PROJ-1528": {
						source: "linear",
						nativeId: "PROJ-1528",
						title: "Treat referenced Linear issues",
						url: "https://linear.app/jolliai/issue/PROJ-1528/",
						sourcePath: "/test/cwd/.jolli/jollimemory/references/linear/PROJ-1528.md",
						addedAt: "2026-04-01T00:00:00Z",
						updatedAt: "2026-04-01T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				},
			});
			const { readReferenceMarkdown } = await import("../core/references/ReferenceStore.js");
			vi.mocked(readReferenceMarkdown).mockResolvedValue({
				mapKey: "linear:PROJ-1528",
				source: "linear",
				nativeId: "PROJ-1528",
				title: "Treat referenced Linear issues",
				url: "https://linear.app/jolliai/issue/PROJ-1528/",
				fields: [
					{ key: "status", label: "Status", value: "In Progress", icon: "circle-large-filled" },
					{ key: "priority", label: "Priority", value: "No priority", icon: "flame" },
					{ key: "labels", label: "Labels", value: "JolliMemory, Feature", icon: "tag" },
				],
				description: "## Problem\nbody",
				toolName: "mcp__linear__get_issue",
				referencedAt: "2026-05-14T06:06:01.123Z",
			});

			const { readFile } = await import("node:fs/promises");
			(readFile as unknown as { mockResolvedValue: (v: string) => void }).mockResolvedValue("file content");

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			const savedSummary = vi.mocked(storeSummary).mock.calls[0][0];
			// Multi-source field: entities[] is the canonical post-Phase-2 shape.
			expect(savedSummary.references).toBeDefined();
			expect(savedSummary.references?.[0].archivedKey).toBe("linear:PROJ-1528-abc12345");
			expect(savedSummary.references?.[0].source).toBe("linear");
			expect(savedSummary.references?.[0].nativeId).toBe("PROJ-1528");
			expect(savedSummary.references?.[0].title).toBe("Treat referenced Linear issues");
			// The opaque fields bag is snapshotted verbatim into the ReferenceCommitRef.
			expect(savedSummary.references?.[0].fields).toEqual([
				{ key: "status", label: "Status", value: "In Progress", icon: "circle-large-filled" },
				{ key: "priority", label: "Priority", value: "No priority", icon: "flame" },
				{ key: "labels", label: "Labels", value: "JolliMemory, Feature", icon: "tag" },
			]);
			// The archivedKey lives only in the CommitSummary's ReferenceCommitRef
			// (asserted above) + the orphan-branch snapshot; under the
			// commit-deletes-entry model the registry row + local markdown are torn
			// down by finalizeReferenceArchive after storeReferences succeeds.
		});

		it("preserves local reference state when the orphan-branch write fails (write-ahead recovery)", async () => {
			const op = makeCommitOp({ commitHash: "abc12345def67890" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/li.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");

			vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([
				{ mapKey: "linear:PROJ-1528", source: "linear", sourcePath: "/ref.md" },
			]);
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				references: {
					"linear:PROJ-1528": {
						source: "linear",
						nativeId: "PROJ-1528",
						title: "t",
						url: "u",
						sourcePath: "/ref.md",
						addedAt: "x",
						updatedAt: "x",
						sourceToolName: "mcp__linear__get_issue",
					},
				},
			});
			const { readReferenceMarkdown } = await import("../core/references/ReferenceStore.js");
			vi.mocked(readReferenceMarkdown).mockResolvedValue({
				mapKey: "linear:PROJ-1528",
				source: "linear",
				nativeId: "PROJ-1528",
				title: "t",
				url: "u",
				toolName: "mcp__linear__get_issue",
				referencedAt: "2026-05-14T06:06:01.123Z",
			});
			const { readFile } = await import("node:fs/promises");
			(readFile as unknown as { mockResolvedValue: (v: string) => void }).mockResolvedValue("file content");

			// Orphan-branch write fails AFTER the snapshot was captured but BEFORE
			// any local teardown — the whole point of the deferred-delete ordering.
			const { storeReferences } = await import("../core/SummaryStore.js");
			vi.mocked(storeReferences).mockRejectedValueOnce(new Error("orphan write failed"));

			// Worker swallows the per-entry error (fire-and-forget) and completes.
			await runWorker("/test/cwd");

			// finalizeReferenceArchive never ran → local markdown NOT deleted, so the
			// active row stays in plans.json and re-archives on the next commit.
			const { deleteReferenceMarkdown } = await import("../core/references/ReferenceStore.js");
			expect(vi.mocked(deleteReferenceMarkdown)).not.toHaveBeenCalled();
		});

		it("skips entities whose source markdown is unreadable but still completes the pipeline", async () => {
			const op = makeCommitOp({ commitHash: "abc12345def67890" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/li.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");

			vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([
				{
					mapKey: "linear:PROJ-1528",
					source: "linear",
					sourcePath: "/missing.md",
				},
			]);
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				references: {
					"linear:PROJ-1528": {
						source: "linear",
						nativeId: "PROJ-1528",
						title: "t",
						url: "u",
						sourcePath: "/missing.md",
						addedAt: "x",
						updatedAt: "x",
						sourceToolName: "mcp__linear__get_issue",
					},
				},
			});
			const { readReferenceMarkdown } = await import("../core/references/ReferenceStore.js");
			vi.mocked(readReferenceMarkdown).mockResolvedValue(null);

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			const savedSummary = vi.mocked(storeSummary).mock.calls[0][0];
			expect(savedSummary.references).toBeUndefined();
		});

		it("archives multiple sources (linear + jira)", async () => {
			const op = makeCommitOp({ commitHash: "abc12345def67890" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/li.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");

			vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([
				{
					mapKey: "linear:PROJ-1528",
					source: "linear",
					sourcePath: "/test/cwd/.jolli/jollimemory/references/linear/PROJ-1528.md",
				},
				{
					mapKey: "jira:KAN-7",
					source: "jira",
					sourcePath: "/test/cwd/.jolli/jollimemory/references/jira/KAN-7.md",
				},
			]);
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				references: {
					"linear:PROJ-1528": {
						source: "linear",
						nativeId: "PROJ-1528",
						title: "Linear issue",
						url: "https://linear.app/x/PROJ-1528",
						sourcePath: "/test/cwd/.jolli/jollimemory/references/linear/PROJ-1528.md",
						addedAt: "x",
						updatedAt: "x",
						sourceToolName: "mcp__linear__get_issue",
					},
					"jira:KAN-7": {
						source: "jira",
						nativeId: "KAN-7",
						title: "Jira ticket",
						url: "https://example.atlassian.net/browse/KAN-7",
						sourcePath: "/test/cwd/.jolli/jollimemory/references/jira/KAN-7.md",
						addedAt: "x",
						updatedAt: "x",
						sourceToolName: "mcp__jira__get_issue",
					},
				},
			});
			const { readReferenceMarkdown } = await import("../core/references/ReferenceStore.js");
			vi.mocked(readReferenceMarkdown).mockImplementation(async (path: string) => {
				if (path.includes("PROJ-1528")) {
					return {
						mapKey: "linear:PROJ-1528",
						source: "linear",
						nativeId: "PROJ-1528",
						title: "Linear issue",
						url: "https://linear.app/x/PROJ-1528",
						toolName: "mcp__linear__get_issue",
						referencedAt: "2026-05-14T06:06:01.123Z",
					};
				}
				if (path.includes("KAN-7")) {
					return {
						mapKey: "jira:KAN-7",
						source: "jira",
						nativeId: "KAN-7",
						title: "Jira ticket",
						url: "https://example.atlassian.net/browse/KAN-7",
						toolName: "mcp__jira__get_issue",
						referencedAt: "2026-05-14T06:06:02.123Z",
					};
				}
				return null;
			});

			const { readFile } = await import("node:fs/promises");
			(readFile as unknown as { mockResolvedValue: (v: string) => void }).mockResolvedValue("file content");

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			const savedSummary = vi.mocked(storeSummary).mock.calls[0][0];
			expect(savedSummary.references).toHaveLength(2);
			const sources = savedSummary.references?.map((r) => r.source).sort();
			expect(sources).toEqual(["jira", "linear"]);
			// References include both linear and jira entries.
			const linearRef = savedSummary.references?.find((r) => r.source === "linear");
			expect(linearRef?.nativeId).toBe("PROJ-1528");
		});

		it("skips ids whose mapKey is not present in plans.json.references (registry miss)", async () => {
			// Regression guard: associateReferencesWithCommit must tolerate
			// detectUncommittedReferenceIds returning a mapKey that's been removed
			// from plans.json between detect and archive — log + skip, do not
			// throw. Without this guard the whole pipeline would explode on
			// concurrent ignoreEntity + commit.
			const op = makeCommitOp({ commitHash: "abc12345def67890" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/li.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");

			vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([
				{
					mapKey: "linear:GHOST-1",
					source: "linear",
					sourcePath: "/tmp/ghost.md",
				},
			]);
			// Registry contains no matching entry — the dropped path fires.
			vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, references: {} });

			await runWorker("/test/cwd");

			// Pipeline still completes; summary contains no entities.
			expect(storeSummary).toHaveBeenCalledTimes(1);
			const savedSummary = vi.mocked(storeSummary).mock.calls[0][0];
			expect(savedSummary.references).toBeUndefined();
		});

		it("preserves notes on save and tolerates a mix of present + dropped ids during merge (L1061/1065/1072)", async () => {
			// Pins three sibling branches in `associateReferencesWithCommit`'s
			// near-write reread path (QueueWorker.ts L1059-1073):
			//
			//   • L1061: `updatedEntities[mapKey] !== undefined` falsy arm —
			//     iterates the ghost id whose mapKey was dropped earlier.
			//   • L1065: `updatedEntities[archivedKey] !== undefined` falsy arm
			//     — same dropped id has no archivedKey either.
			//   • L1072: `freshRegistry.notes !== undefined` truthy spread —
			//     when notes are present they must survive the rewrite.
			//
			// Without the falsy arms an unrecognised id would crash the merge;
			// without the notes spread, concurrent NoteService work would be
			// silently nuked on save.
			const op = makeCommitOp({ commitHash: "abc12345def67890" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/li.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");

			vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([
				{
					mapKey: "linear:PROJ-1528",
					source: "linear",
					sourcePath: "/test/cwd/.jolli/jollimemory/references/linear/PROJ-1528.md",
				},
				{
					mapKey: "linear:GHOST-1",
					source: "linear",
					sourcePath: "/tmp/ghost.md",
				},
			]);
			// Registry: one match, one miss, plus a notes section that must
			// survive the rewrite (L1072 truthy spread).
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				notes: {
					"note-1": {
						id: "note-1",
						title: "keep me",
						format: "snippet",
						commitHash: null,
						sourcePath: "/repo/.jolli/jollimemory/notes/note-1.md",
						addedAt: "y",
						updatedAt: "y",
					},
				},
				references: {
					"linear:PROJ-1528": {
						source: "linear",
						nativeId: "PROJ-1528",
						title: "Real entry",
						url: "https://linear.app/x/PROJ-1528",
						sourcePath: "/test/cwd/.jolli/jollimemory/references/linear/PROJ-1528.md",
						addedAt: "x",
						updatedAt: "x",
						sourceToolName: "mcp__linear__get_issue",
					},
				},
			});
			const { readReferenceMarkdown } = await import("../core/references/ReferenceStore.js");
			vi.mocked(readReferenceMarkdown).mockResolvedValue({
				mapKey: "linear:PROJ-1528",
				source: "linear",
				nativeId: "PROJ-1528",
				title: "Real entry",
				url: "https://linear.app/x/PROJ-1528",
				toolName: "mcp__linear__get_issue",
				referencedAt: "2026-05-14T06:06:01.123Z",
			});
			const { readFile } = await import("node:fs/promises");
			(readFile as unknown as { mockResolvedValue: (v: string) => void }).mockResolvedValue("file content");

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			// Real entry archived; ghost dropped.
			const savedSummary = vi.mocked(storeSummary).mock.calls[0][0];
			expect(savedSummary.references).toHaveLength(1);
			expect(savedSummary.references?.[0].nativeId).toBe("PROJ-1528");
			// Registry save was called with the notes section preserved
			// (L1072 truthy arm) and the dropped id absent (L1061/1065 falsy).
			const saveCalls = vi.mocked(savePlansRegistry).mock.calls;
			const lastSave = saveCalls[saveCalls.length - 1][0] as Extract<
				(typeof saveCalls)[number][0],
				{ version: 1 }
			>;
			expect(lastSave.version).toBe(1);
			expect(lastSave.notes).toEqual({
				"note-1": {
					id: "note-1",
					title: "keep me",
					format: "snippet",
					commitHash: null,
					sourcePath: "/repo/.jolli/jollimemory/notes/note-1.md",
					addedAt: "y",
					updatedAt: "y",
				},
			});
			expect(lastSave.references?.["linear:GHOST-1"]).toBeUndefined();
		});
	});

	describe("finalizeReferenceArchive — fingerprint guard", () => {
		const refRow = (updatedAt: string) => ({
			source: "linear" as const,
			nativeId: "PROJ-1",
			title: "t",
			url: "u",
			sourcePath: "/ref.md",
			addedAt: "x",
			updatedAt,
			sourceToolName: "mcp__linear__get_issue",
		});

		it("deletes the row + markdown when the fresh fingerprint matches the captured one", async () => {
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				references: { "linear:PROJ-1": refRow("2026-04-01T00:00:00Z") },
			});
			const { deleteReferenceMarkdown } = await import("../core/references/ReferenceStore.js");

			await __test__.finalizeReferenceArchive(
				[{ mapKey: "linear:PROJ-1", sourcePath: "/ref.md", updatedAt: "2026-04-01T00:00:00Z" }],
				"/test/cwd",
			);

			const saved = vi.mocked(savePlansRegistry).mock.calls.at(-1)?.[0];
			expect(saved?.references?.["linear:PROJ-1"]).toBeUndefined();
			expect(vi.mocked(deleteReferenceMarkdown)).toHaveBeenCalledWith("/ref.md");
		});

		it("keeps the row + markdown when a StopHook re-upsert changed updatedAt (race)", async () => {
			// Fresh registry shows a NEWER updatedAt → the ref was re-upserted between
			// storeReferences and finalize. Deleting it would lose the re-reference.
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				references: { "linear:PROJ-1": refRow("2026-04-02T09:00:00Z") },
			});
			const { deleteReferenceMarkdown } = await import("../core/references/ReferenceStore.js");

			await __test__.finalizeReferenceArchive(
				[{ mapKey: "linear:PROJ-1", sourcePath: "/ref.md", updatedAt: "2026-04-01T00:00:00Z" }],
				"/test/cwd",
			);

			// Nothing was deleted → no write at all (avoids a pointless lost-update
			// window), and the markdown is left intact.
			expect(vi.mocked(savePlansRegistry)).not.toHaveBeenCalled();
			expect(vi.mocked(deleteReferenceMarkdown)).not.toHaveBeenCalled();
		});
	});

	describe("runWorker — prompt assembly (multi-source)", () => {
		it("pulls active entities from getReferenceEntriesForBranch and renders one block per source", async () => {
			const op = makeCommitOp({ commitHash: "abc12345def67890" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/li.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");

			// Provide active entries for two sources — Linear and Jira. The pipeline
			// must call getReferenceEntriesForBranch (NOT getReferenceEntriesForBranch).
			vi.mocked(getReferenceEntriesForBranch).mockResolvedValue([
				{
					source: "linear",
					nativeId: "PROJ-9",
					title: "Linear active",
					url: "https://linear.app/x/PROJ-9",
					sourcePath: "/test/cwd/.jolli/jollimemory/references/linear/PROJ-9.md",
					addedAt: "x",
					updatedAt: "x",
					sourceToolName: "mcp__linear__get_issue",
				},
				{
					source: "jira",
					nativeId: "KAN-9",
					title: "Jira active",
					url: "https://example.atlassian.net/browse/KAN-9",
					sourcePath: "/test/cwd/.jolli/jollimemory/references/jira/KAN-9.md",
					addedAt: "x",
					updatedAt: "x",
					sourceToolName: "mcp__jira__get_issue",
				},
			]);
			const { readReferenceMarkdown } = await import("../core/references/ReferenceStore.js");
			vi.mocked(readReferenceMarkdown).mockImplementation(async (path: string) => {
				if (path.includes("PROJ-9")) {
					return {
						mapKey: "linear:PROJ-9",
						source: "linear",
						nativeId: "PROJ-9",
						title: "Linear active",
						url: "https://linear.app/x/PROJ-9",
						toolName: "mcp__linear__get_issue",
						referencedAt: "2026-05-14T06:06:01.123Z",
					};
				}
				if (path.includes("KAN-9")) {
					return {
						mapKey: "jira:KAN-9",
						source: "jira",
						nativeId: "KAN-9",
						title: "Jira active",
						url: "https://example.atlassian.net/browse/KAN-9",
						toolName: "mcp__jira__get_issue",
						referencedAt: "2026-05-14T06:06:02.123Z",
					};
				}
				return null;
			});

			await runWorker("/test/cwd");

			expect(getReferenceEntriesForBranch).toHaveBeenCalledWith("/test/cwd", "feature/test");
			// generateSummary receives the rendered block. Today the only
			// registered adapter is Linear, so only Linear refs appear in the
			// block; once Jira adapter lands the second adapter will append its
			// own XML section. Either way readReferenceMarkdown is called for
			// EVERY active entity (not just Linear).
			expect(readReferenceMarkdown).toHaveBeenCalledWith(
				"/test/cwd/.jolli/jollimemory/references/linear/PROJ-9.md",
			);
			expect(readReferenceMarkdown).toHaveBeenCalledWith("/test/cwd/.jolli/jollimemory/references/jira/KAN-9.md");
		});

		it("calls generateSummary with empty referenceBlocks when no active entities exist", async () => {
			const op = makeCommitOp({ commitHash: "abc12345def67890" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/li.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");
			vi.mocked(getReferenceEntriesForBranch).mockResolvedValue([]);

			await runWorker("/test/cwd");

			expect(generateSummary).toHaveBeenCalledTimes(1);
			const call = vi.mocked(generateSummary).mock.calls[0][0];
			// Empty-source path: no adapter has refs → join("") → "".
			expect(call.referenceBlocks).toBe("");
		});
	});

	describe("runWorker error handling", () => {
		it("should catch and log errors from the worker loop", async () => {
			vi.mocked(dequeueAllGitOperations).mockRejectedValueOnce(new Error("I/O error"));

			await runWorker("/test/cwd");

			// Worker should complete without throwing (error caught internally)
			expect(releaseWorkerLock).toHaveBeenCalled();
		});

		// As of the summaryError-marker unification, credential errors flow
		// through the same retry-then-placeholder path as any other LLM
		// failure. The "loud" signal is the webview banner driven by
		// `summaryError: "llm-failed"` — visible on every affected commit
		// until the user fixes credentials and clicks Regenerate. These two
		// tests pin BOTH retry slots (first-attempt and retry-attempt
		// credential failures) to the placeholder path.
		it("writes a placeholder + summaryError marker when first attempt throws LlmCredentialError", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/cred.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			vi.mocked(generateSummary)
				.mockRejectedValueOnce(new LlmCredentialError())
				.mockRejectedValueOnce(new LlmCredentialError());

			await runWorker("/test/cwd");

			// Retry attempt happens; both fail; placeholder lands.
			expect(generateSummary).toHaveBeenCalledTimes(2);
			expect(storeSummary).toHaveBeenCalledTimes(1);
			const stored = vi.mocked(storeSummary).mock.calls[0][0];
			expect(stored.topics).toEqual([]);
			expect(stored.llm?.stopReason).toBe("error");
			expect(stored.summaryError).toBe("llm-failed");
		});

		it("writes a placeholder + summaryError marker when only the retry throws LlmCredentialError", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/cred-retry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			vi.mocked(generateSummary)
				.mockRejectedValueOnce(new Error("transient transport error"))
				.mockRejectedValueOnce(new LlmCredentialError());

			await runWorker("/test/cwd");

			expect(generateSummary).toHaveBeenCalledTimes(2);
			expect(storeSummary).toHaveBeenCalledTimes(1);
			const stored = vi.mocked(storeSummary).mock.calls[0][0];
			expect(stored.summaryError).toBe("llm-failed");
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
				plans: [{ slug: "p", title: "P", addedAt: "x", updatedAt: "y" }],
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
		it("returns only notes with null commitHash and no contentHashAtCommit guard", async () => {
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
						commitHash: null,
					},
					// Excluded: already committed
					committed: {
						id: "committed",
						title: "Committed",
						format: "markdown" as const,
						sourcePath: "/p",
						addedAt: "x",
						updatedAt: "y",
						commitHash: "abc123",
					},
					// Excluded: archive guard (contentHashAtCommit set, source not revived)
					guard: {
						id: "guard",
						title: "Guard",
						format: "markdown" as const,
						sourcePath: "/p",
						addedAt: "x",
						updatedAt: "y",
						commitHash: null,
						contentHashAtCommit: "hash",
					},
				},
			});

			const ids = await __test__.detectUncommittedNoteIds("/test/cwd", "main");
			expect([...ids].sort()).toEqual(["fresh"]);
		});

		it("returns empty set when registry has no notes field", async () => {
			vi.mocked(loadPlansRegistry).mockResolvedValueOnce({ version: 1, plans: {} });
			const ids = await __test__.detectUncommittedNoteIds("/test/cwd", "main");
			expect(ids.size).toBe(0);
		});

		// Iterative-commit revival mirror of detectPlanSlugsFromRegistry: a previously
		// archived note's source file has been edited since archive, so the new
		// content needs to re-enter the working area and be carried into the next
		// commit.
		it("includes revived guard notes whose source file no longer matches contentHashAtCommit", async () => {
			const { createHash } = await import("node:crypto");
			const oldHash = createHash("sha256").update("v1\n").digest("hex");
			vi.mocked(loadPlansRegistry).mockResolvedValueOnce({
				version: 1,
				plans: {},
				notes: {
					"revived-note": {
						id: "revived-note",
						title: "Revived",
						format: "markdown" as const,
						sourcePath: "/repo/notes/revived-note.md",
						addedAt: "x",
						updatedAt: "y",
						commitHash: "deadbeefdeadbeef",
						contentHashAtCommit: oldHash,
					},
				},
			});
			vi.mocked(existsSync).mockImplementation((p) => p === "/repo/notes/revived-note.md");
			vi.mocked(readFileSync).mockImplementation((p) => (p === "/repo/notes/revived-note.md" ? "v2\n" : ""));

			const ids = await __test__.detectUncommittedNoteIds("/test/cwd", "main");
			expect([...ids]).toEqual(["revived-note"]);
		});

		it("excludes guard notes whose source file still matches contentHashAtCommit", async () => {
			const { createHash } = await import("node:crypto");
			const body = "v1\n";
			const hash = createHash("sha256").update(body).digest("hex");
			vi.mocked(loadPlansRegistry).mockResolvedValueOnce({
				version: 1,
				plans: {},
				notes: {
					"stable-note": {
						id: "stable-note",
						title: "Stable",
						format: "markdown" as const,
						sourcePath: "/repo/notes/stable-note.md",
						addedAt: "x",
						updatedAt: "y",
						commitHash: "deadbeefdeadbeef",
						contentHashAtCommit: hash,
					},
				},
			});
			vi.mocked(existsSync).mockImplementation((p) => p === "/repo/notes/stable-note.md");
			vi.mocked(readFileSync).mockImplementation((p) => (p === "/repo/notes/stable-note.md" ? body : ""));

			const ids = await __test__.detectUncommittedNoteIds("/test/cwd", "main");
			expect(ids.size).toBe(0);
		});

		it("excludes guard notes whose source file is missing on disk", async () => {
			vi.mocked(loadPlansRegistry).mockResolvedValueOnce({
				version: 1,
				plans: {},
				notes: {
					"gone-note": {
						id: "gone-note",
						title: "Gone",
						format: "markdown" as const,
						sourcePath: "/repo/notes/gone-note.md",
						addedAt: "x",
						updatedAt: "y",
						commitHash: "deadbeefdeadbeef",
						contentHashAtCommit: "anything",
					},
				},
			});
			vi.mocked(existsSync).mockReturnValue(false);

			const ids = await __test__.detectUncommittedNoteIds("/test/cwd", "main");
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

	describe("Copilot Chat integration", () => {
		it("includes Copilot Chat sessions when chat is detected and copilotEnabled is true", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/copilot-chat.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isCopilotChatInstalled).mockResolvedValue(true);
			vi.mocked(discoverCopilotChatSessions).mockResolvedValue([
				{
					sessionId: "chat-1",
					transcriptPath: "/fake/chat-1.jsonl",
					updatedAt: "2026-05-06T00:00:00.000Z",
					source: "copilot-chat",
				},
			]);

			await runWorker("/test/cwd");

			expect(isCopilotChatInstalled).toHaveBeenCalled();
			expect(discoverCopilotChatSessions).toHaveBeenCalledWith("/test/cwd");
		});

		it("does not call isCopilotChatInstalled or discoverCopilotChatSessions when copilotEnabled is false", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/copilot-chat-disabled.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({
				copilotEnabled: false,
			} as Awaited<ReturnType<typeof loadConfig>>);

			await runWorker("/test/cwd");

			expect(isCopilotChatInstalled).not.toHaveBeenCalled();
			expect(discoverCopilotChatSessions).not.toHaveBeenCalled();
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

		it("squash llm-error: passes summaryError marker on the consolidated arg into mergeManyToOne", async () => {
			const { getSummary, mergeManyToOne } = await import("../core/SummaryStore.js");
			const { generateSquashConsolidation } = await import("../core/Summarizer.js");
			vi.mocked(getSummary).mockResolvedValue({
				version: 3,
				commitHash: "src1",
				commitMessage: "Src",
				commitAuthor: "Jane",
				commitDate: "2026-04-01T10:00:00.000Z",
				branch: "feature/test",
				generatedAt: "2026-04-01T10:00:00.000Z",
				topics: [{ title: "Src topic", trigger: "t", response: "r", decisions: "d" }],
			} as Awaited<ReturnType<typeof getSummary>>);
			vi.mocked(generateSquashConsolidation).mockResolvedValueOnce({ status: "llm-error" });
			setupPipelineMocks("sq-new");

			await __test__.handleSquashFromQueue(
				makeCommitOp({ commitHash: "sq-new", sourceHashes: ["src1"] }),
				"/test/cwd",
			);

			expect(mergeManyToOne).toHaveBeenCalledTimes(1);
			const consolidatedArg = vi.mocked(mergeManyToOne).mock.calls[0][4];
			expect(consolidatedArg?.summaryError).toBe("llm-failed");
			expect((consolidatedArg?.topics ?? []).length).toBeGreaterThan(0); // mechanical preserved content
		});

		it("squash no-content: mechanical fallback WITHOUT summaryError marker", async () => {
			const { getSummary, mergeManyToOne } = await import("../core/SummaryStore.js");
			const { generateSquashConsolidation } = await import("../core/Summarizer.js");
			vi.mocked(getSummary).mockResolvedValue({
				version: 3,
				commitHash: "src2",
				commitMessage: "Src2",
				commitAuthor: "Jane",
				commitDate: "2026-04-01T10:00:00.000Z",
				branch: "feature/test",
				generatedAt: "2026-04-01T10:00:00.000Z",
				topics: [{ title: "Src topic", trigger: "t", response: "r", decisions: "d" }],
			} as Awaited<ReturnType<typeof getSummary>>);
			vi.mocked(generateSquashConsolidation).mockResolvedValueOnce({ status: "no-content" });
			setupPipelineMocks("sq-nc");

			await __test__.handleSquashFromQueue(
				makeCommitOp({ commitHash: "sq-nc", sourceHashes: ["src2"] }),
				"/test/cwd",
			);

			expect(mergeManyToOne).toHaveBeenCalledTimes(1);
			const consolidatedArg = vi.mocked(mergeManyToOne).mock.calls[0][4];
			expect(consolidatedArg?.summaryError).toBeUndefined();
		});

		it("squash ok: inherits summaryError when any source was already degraded", async () => {
			// Source-state inheritance: even if THIS squash succeeded, if any
			// source was a prior placeholder / mechanical / Copy-Hoist result
			// (signalled by summaryError or legacy stopReason="error"), the
			// merged root is "consolidated from compromised inputs" and must
			// carry the marker forward. Otherwise handlePush would let the
			// degraded content land on Jolli unannounced.
			const { getSummary, mergeManyToOne } = await import("../core/SummaryStore.js");
			const { generateSquashConsolidation } = await import("../core/Summarizer.js");
			vi.mocked(getSummary)
				.mockResolvedValueOnce({
					version: 3,
					commitHash: "src-bad",
					commitMessage: "Previously failed",
					commitAuthor: "Jane",
					commitDate: "2026-04-01T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-04-01T10:00:00.000Z",
					topics: [{ title: "Placeholder", trigger: "t", response: "r", decisions: "d" }],
					summaryError: "llm-failed",
				} as Awaited<ReturnType<typeof getSummary>>)
				.mockResolvedValueOnce({
					version: 3,
					commitHash: "src-good",
					commitMessage: "Healthy",
					commitAuthor: "Jane",
					commitDate: "2026-04-02T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-04-02T10:00:00.000Z",
					topics: [{ title: "Good", trigger: "t", response: "r", decisions: "d" }],
				} as Awaited<ReturnType<typeof getSummary>>);
			vi.mocked(generateSquashConsolidation).mockResolvedValueOnce({
				status: "ok",
				topics: [{ title: "Merged", trigger: "t", response: "r", decisions: "d" }],
				llm: { model: "x", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
			});
			setupPipelineMocks("sq-inh");

			await __test__.handleSquashFromQueue(
				makeCommitOp({ commitHash: "sq-inh", sourceHashes: ["src-bad", "src-good"] }),
				"/test/cwd",
			);

			expect(mergeManyToOne).toHaveBeenCalledTimes(1);
			const consolidatedArg = vi.mocked(mergeManyToOne).mock.calls[0][4];
			expect(consolidatedArg?.summaryError).toBe("llm-failed");
		});

		it("squash ok: does NOT set summaryError when all sources are healthy", async () => {
			// Regression guard for the inherited-marker fix above — healthy
			// squash must stay healthy.
			const { getSummary, mergeManyToOne } = await import("../core/SummaryStore.js");
			const { generateSquashConsolidation } = await import("../core/Summarizer.js");
			vi.mocked(getSummary)
				.mockResolvedValueOnce({
					version: 3,
					commitHash: "src-a",
					commitMessage: "A",
					commitAuthor: "Jane",
					commitDate: "2026-04-01T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-04-01T10:00:00.000Z",
					topics: [{ title: "A", trigger: "t", response: "r", decisions: "d" }],
				} as Awaited<ReturnType<typeof getSummary>>)
				.mockResolvedValueOnce({
					version: 3,
					commitHash: "src-b",
					commitMessage: "B",
					commitAuthor: "Jane",
					commitDate: "2026-04-02T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-04-02T10:00:00.000Z",
					topics: [{ title: "B", trigger: "t", response: "r", decisions: "d" }],
				} as Awaited<ReturnType<typeof getSummary>>);
			vi.mocked(generateSquashConsolidation).mockResolvedValueOnce({
				status: "ok",
				topics: [{ title: "Merged", trigger: "t", response: "r", decisions: "d" }],
				llm: { model: "x", inputTokens: 1, outputTokens: 1, apiLatencyMs: 1, stopReason: "end_turn" },
			});
			setupPipelineMocks("sq-ok");

			await __test__.handleSquashFromQueue(
				makeCommitOp({ commitHash: "sq-ok", sourceHashes: ["src-a", "src-b"] }),
				"/test/cwd",
			);

			expect(mergeManyToOne).toHaveBeenCalledTimes(1);
			const consolidatedArg = vi.mocked(mergeManyToOne).mock.calls[0][4];
			expect(consolidatedArg?.summaryError).toBeUndefined();
		});

		it("squash no-content with degraded source: inherits summaryError", async () => {
			// no-content is "nothing meaningful to merge" — normally healthy.
			// But if a source was already degraded, the mechanical-fallback
			// merge is built on compromised input, so the marker must carry.
			const { getSummary, mergeManyToOne } = await import("../core/SummaryStore.js");
			const { generateSquashConsolidation } = await import("../core/Summarizer.js");
			vi.mocked(getSummary).mockResolvedValueOnce({
				version: 3,
				commitHash: "src-bad",
				commitMessage: "Previously failed",
				commitAuthor: "Jane",
				commitDate: "2026-04-01T10:00:00.000Z",
				branch: "feature/test",
				generatedAt: "2026-04-01T10:00:00.000Z",
				topics: [{ title: "Placeholder", trigger: "t", response: "r", decisions: "d" }],
				summaryError: "llm-failed",
			} as Awaited<ReturnType<typeof getSummary>>);
			vi.mocked(generateSquashConsolidation).mockResolvedValueOnce({ status: "no-content" });
			setupPipelineMocks("sq-nc-inh");

			await __test__.handleSquashFromQueue(
				makeCommitOp({ commitHash: "sq-nc-inh", sourceHashes: ["src-bad"] }),
				"/test/cwd",
			);

			expect(mergeManyToOne).toHaveBeenCalledTimes(1);
			const consolidatedArg = vi.mocked(mergeManyToOne).mock.calls[0][4];
			expect(consolidatedArg?.summaryError).toBe("llm-failed");
		});
	});

	describe("post-op stale-child cleanup", () => {
		const mockStorage = {
			readFile: vi.fn(),
			writeFiles: vi.fn(),
			listFiles: vi.fn(),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn(),
			deleteVisibleMarkdown: vi.fn(),
		};

		beforeEach(() => {
			vi.mocked(cleanupBranchStaleChildMarkdown).mockClear();
			vi.mocked(cleanupBranchStaleChildMarkdown).mockResolvedValue({
				deleted: 0,
				failed: 0,
			});
			// getCurrentBranch is consumed by the tail cleanup step regardless of op
			// type; setupPipelineMocks() at the top of every other test rebuilds the
			// full mock pack, but here we only need the branch reader.
			vi.mocked(getCurrentBranch).mockResolvedValue("feature/test");
		});

		// Use op.type === "rebase-pick" with no sourceHashes: the handler early-
		// returns at the top of handleRebasePickFromQueue without any LLM /
		// transcript machinery, so processQueueEntry's switch falls through cleanly
		// into the tail cleanup. This isolates the test to the cleanup wiring.
		it("invokes cleanupBranchStaleChildMarkdown after the op handler returns", async () => {
			await __test__.processQueueEntry(
				{
					type: "rebase-pick",
					commitHash: "deadbeef1234567890abcdef0123456789abcdef",
					branch: "feature/test",
					createdAt: new Date().toISOString(),
				} as never,
				"/test/cwd",
				mockStorage as never,
				false,
			);

			expect(cleanupBranchStaleChildMarkdown).toHaveBeenCalledWith("/test/cwd", "feature/test", mockStorage);
		});

		it("swallows cleanup errors — the op succeeds even when cleanup throws", async () => {
			vi.mocked(cleanupBranchStaleChildMarkdown).mockRejectedValueOnce(new Error("disk-gone"));

			await expect(
				__test__.processQueueEntry(
					{
						type: "rebase-pick",
						commitHash: "feedface1234567890abcdef0123456789abcdef",
						branch: "feature/test",
						createdAt: new Date().toISOString(),
					} as never,
					"/test/cwd",
					mockStorage as never,
					false,
				),
			).resolves.toBeUndefined();
		});

		// Regression: the tail step used to read getCurrentBranch(cwd) every
		// time, which is wrong when the user has `git checkout`'d to a different
		// branch between enqueue and drain. The cleanup would then prune the
		// wrong branch's directory and leave the original branch's hoisted
		// older versions stranded on disk. The branch must come from the queued
		// op (captured at enqueue time inside the git hook).
		it("uses op.branch for cleanup, not the live getCurrentBranch", async () => {
			// Simulate: enqueued on feature/A, user has since switched to main.
			vi.mocked(getCurrentBranch).mockResolvedValue("main");

			await __test__.processQueueEntry(
				{
					type: "rebase-pick",
					commitHash: "deadbeef1234567890abcdef0123456789abcdef",
					branch: "feature/A",
					createdAt: new Date().toISOString(),
				} as never,
				"/test/cwd",
				mockStorage as never,
				false,
			);

			expect(cleanupBranchStaleChildMarkdown).toHaveBeenCalledWith("/test/cwd", "feature/A", mockStorage);
			expect(cleanupBranchStaleChildMarkdown).not.toHaveBeenCalledWith("/test/cwd", "main", mockStorage);
		});

		it("skips cleanup (no live-branch fallback) when op.branch is missing", async () => {
			// Stale on-disk queue entries from before the branch-recording
			// landed have no op.branch. The conservative choice is to skip
			// rather than fall through to getCurrentBranch — falling through
			// is precisely the bug we're fixing.
			vi.mocked(getCurrentBranch).mockResolvedValue("main");

			await __test__.processQueueEntry(
				{
					type: "rebase-pick",
					commitHash: "feedface1234567890abcdef0123456789abcdef",
					createdAt: new Date().toISOString(),
				} as never,
				"/test/cwd",
				mockStorage as never,
				false,
			);

			expect(cleanupBranchStaleChildMarkdown).not.toHaveBeenCalled();
		});
	});

	describe("buildWorkerStartupBanner", () => {
		it("reports source=cli verbatim for the CLI surface (no path derivation)", () => {
			expect(
				buildWorkerStartupBanner({
					nodeVersion: "24.10.0",
					kind: "cli",
					pkgVersion: "1.2.3",
					cliVersion: "1.2.3",
					distDir: "/opt/whatever/dist",
				}),
			).toBe("node=24.10.0 kind=cli source=cli pkgVer=1.2.3 cliVer=1.2.3 dist=/opt/whatever/dist");
		});

		it("derives source=cursor from a Cursor extension dist path", () => {
			expect(
				buildWorkerStartupBanner({
					nodeVersion: "22.5.0",
					kind: "vscode-plugin",
					pkgVersion: "0.99.1",
					cliVersion: "1.4.0",
					distDir: "/Users/luke/.cursor/extensions/jolli.jollimemory-vscode-0.99.1/dist",
				}),
			).toBe(
				"node=22.5.0 kind=vscode-plugin source=cursor pkgVer=0.99.1 cliVer=1.4.0 dist=/Users/luke/.cursor/extensions/jolli.jollimemory-vscode-0.99.1/dist",
			);
		});

		it("derives source=vscode from a VS Code extension dist path", () => {
			expect(
				buildWorkerStartupBanner({
					nodeVersion: "20.11.0",
					kind: "vscode-plugin",
					pkgVersion: "0.99.1",
					cliVersion: "1.4.0",
					distDir: "/home/u/.vscode/extensions/jolli.jollimemory-vscode/dist",
				}),
			).toBe(
				"node=20.11.0 kind=vscode-plugin source=vscode pkgVer=0.99.1 cliVer=1.4.0 dist=/home/u/.vscode/extensions/jolli.jollimemory-vscode/dist",
			);
		});
	});

	describe("launchWorker — argv hygiene (regression for old-Node startup crash)", () => {
		it("spawns node with NO flags before scriptPath (no --disable-warning*)", () => {
			vi.mocked(spawn).mockClear();
			vi.mocked(existsSync).mockReturnValue(true);

			launchWorker("/test/cwd");

			expect(spawn).toHaveBeenCalledTimes(1);
			const args = vi.mocked(spawn).mock.calls[0][1] as string[];

			// scriptPath is the first non-flag arg; everything before it is a
			// Node flag. The whole point of the fix is that there are NONE.
			const scriptIdx = args.findIndex((a) => a.endsWith("QueueWorker.js"));
			expect(scriptIdx).toBe(0);
			const nodeFlags = args.slice(0, scriptIdx);
			expect(nodeFlags).toEqual([]);

			// Belt-and-suspenders: the offending flag must not appear anywhere.
			expect(args.some((a) => a.startsWith("--disable-warning"))).toBe(false);

			// The legitimate script args are still present and ordered.
			expect(args.slice(scriptIdx + 1)).toEqual(["--worker", "--cwd", "/test/cwd"]);
		});
	});

	describe("launchWorker — missing worker script guard (regression for 0.99.2 silent spawn crash)", () => {
		// 0.99.2 shipped a CLI dist without QueueWorker.js (rollup folded it
		// into the SyncBootstrap chunk after a circular import appeared), and
		// the detached child died on MODULE_NOT_FOUND with stdio ignored —
		// zero log lines, summaries silently never generated. The guard must
		// refuse to spawn and leave an ERROR trace instead.
		it("does not spawn when QueueWorker.js is absent next to the running bundle", () => {
			vi.mocked(spawn).mockClear();
			vi.mocked(existsSync).mockReturnValue(false);

			launchWorker("/test/cwd");

			expect(spawn).not.toHaveBeenCalled();
			// The guard must have probed for the worker script by its contract name.
			const probed = vi.mocked(existsSync).mock.calls.map((c) => String(c[0]));
			expect(probed.some((p) => p.endsWith("QueueWorker.js"))).toBe(true);
		});

		it("spawns normally when QueueWorker.js exists", () => {
			vi.mocked(spawn).mockClear();
			vi.mocked(existsSync).mockReturnValue(true);

			launchWorker("/test/cwd");

			expect(spawn).toHaveBeenCalledTimes(1);
		});
	});

	describe("runWorker — stale phase cleanup on lock acquisition", () => {
		it("removes a worker-phase file left by a crashed worker when it acquires the lock", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "jolli-stalephase-"));
			mkdirSync(join(tmp, ".jolli", "jollimemory"), { recursive: true });
			const phaseFile = join(tmp, ".jolli", "jollimemory", "worker-phase");
			// Simulate crash residue: a previous worker was SIGKILL'd mid-ingest, so
			// its `finally` cleanup never ran and the 'ingest' marker persists.
			writeFileSync(phaseFile, "ingest");

			const { existsSync: realExistsSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
			expect(realExistsSync(phaseFile)).toBe(true);

			// Minimal storage so setActiveStorage() has something to hold; empty
			// queue so the worker just acquires the lock and drains nothing.
			vi.mocked(createStorage).mockResolvedValue({
				readFile: vi.fn().mockResolvedValue(null),
				writeFiles: vi.fn().mockResolvedValue(undefined),
				listFiles: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn().mockResolvedValue(undefined),
			} as never);
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([]);

			await runWorker(tmp);

			// The fresh worker holds the lock, proving the previous one is gone, so
			// the stale marker is cleared at the source — not left to mislabel the
			// next genuine summary run as "Updating Memory Bank…".
			expect(realExistsSync(phaseFile)).toBe(false);

			rmSync(tmp, { recursive: true, force: true });
		});
	});

	describe("runWorker — ingest dispatch", () => {
		function makeIngestOp(triggeredBy: IngestOperation["triggeredBy"] = "post-merge"): IngestOperation {
			return { type: "ingest", triggeredBy, createdAt: new Date().toISOString() };
		}

		function storageWithWiki(present: boolean): never {
			return {
				readFile: vi.fn().mockResolvedValue(null),
				writeFiles: vi.fn().mockResolvedValue(undefined),
				listFiles: vi.fn().mockResolvedValue([]),
				exists: vi.fn().mockResolvedValue(true),
				ensure: vi.fn().mockResolvedValue(undefined),
				isTopicWikiPresent: vi.fn().mockReturnValue(present),
			} as never;
		}

		// resetAllMocks (outer beforeEach) wipes the StorageFactory default, so
		// re-establish a folder-like storage whose wiki is present — the common
		// case. Per-test overrides drive the wiki-missing recovery path.
		beforeEach(() => {
			vi.mocked(createStorage).mockResolvedValue(storageWithWiki(true));
		});

		it("writes worker-phase=ingest during ingest and removes it after", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "jolli-phase-"));
			mkdirSync(join(tmp, ".jolli", "jollimemory"), { recursive: true });
			const phaseFile = join(tmp, ".jolli", "jollimemory", "worker-phase");

			// Use the actual fs functions so we can observe real disk writes from
			// production code (writeFileSync / rmSync are actual in the mock spread).
			const { existsSync: realExistsSync, readFileSync: realReadFileSync } =
				await vi.importActual<typeof import("node:fs")>("node:fs");
			vi.mocked(existsSync).mockImplementation(realExistsSync);
			vi.mocked(readFileSync).mockImplementation(realReadFileSync as typeof readFileSync);

			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			let phaseSeenDuringIngest: string | null = null;
			vi.mocked(drainIngest).mockImplementation(async () => {
				phaseSeenDuringIngest = existsSync(phaseFile) ? readFileSync(phaseFile, "utf-8") : null;
				return { batches: 1, ingested: 2, outcome: "OK", topicFailures: [] };
			});

			await __test__.processQueueEntry(makeIngestOp("post-merge"), tmp, storageWithWiki(true), false);

			expect(phaseSeenDuringIngest).toBe("ingest");
			expect(existsSync(phaseFile)).toBe(false);

			rmSync(tmp, { recursive: true, force: true });
		});

		it("removes worker-phase even when ingest throws", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "jolli-phase-"));
			mkdirSync(join(tmp, ".jolli", "jollimemory"), { recursive: true });
			const phaseFile = join(tmp, ".jolli", "jollimemory", "worker-phase");

			const { existsSync: realExistsSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
			vi.mocked(existsSync).mockImplementation(realExistsSync);

			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockRejectedValue(new Error("boom"));

			await expect(
				__test__.processQueueEntry(makeIngestOp("post-merge"), tmp, storageWithWiki(true), false),
			).rejects.toThrow("boom");

			expect(existsSync(phaseFile)).toBe(false);

			rmSync(tmp, { recursive: true, force: true });
		});

		it("routes an ingest op to drainIngest and renderTopicKBWiki when API key is configured", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 2, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/ingest.json" }])
				.mockResolvedValueOnce([]);

			await runWorker("/test/cwd");

			expect(vi.mocked(drainIngest)).toHaveBeenCalledOnce();
			expect(vi.mocked(renderTopicKBWiki)).toHaveBeenCalledOnce();
		});

		it("skips drainIngest when no API key is configured", async () => {
			vi.mocked(loadConfig).mockResolvedValue({} as never);
			const origKey = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;

			const op = makeIngestOp("recall-miss");
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/ingest.json" }])
				.mockResolvedValueOnce([]);

			await runWorker("/test/cwd");

			expect(vi.mocked(drainIngest)).not.toHaveBeenCalled();
			expect(vi.mocked(renderTopicKBWiki)).not.toHaveBeenCalled();
			expect(vi.mocked(appendCredentialMissingRun)).toHaveBeenCalledWith("/test/cwd", "recall-miss");

			if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
		});

		it("skips renderTopicKBWiki when drainIngest reports 0 ingested", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 0, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("manual");
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/ingest.json" }])
				.mockResolvedValueOnce([]);

			await runWorker("/test/cwd");

			expect(vi.mocked(drainIngest)).toHaveBeenCalledOnce();
			expect(vi.mocked(renderTopicKBWiki)).not.toHaveBeenCalled();
		});

		it("re-renders the wiki when ingested=0 but the visible wiki was deleted", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 0, outcome: "OK", topicFailures: [] });
			vi.mocked(createStorage).mockResolvedValueOnce(storageWithWiki(false));

			const op = makeIngestOp("manual");
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/ingest.json" }])
				.mockResolvedValueOnce([]);

			await runWorker("/test/cwd");

			expect(vi.mocked(renderTopicKBWiki)).toHaveBeenCalledOnce();
		});

		it("does NOT re-render when ingested=0 and the visible wiki is already present", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 0, outcome: "OK", topicFailures: [] });
			vi.mocked(createStorage).mockResolvedValueOnce(storageWithWiki(true));

			const op = makeIngestOp("manual");
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/ingest.json" }])
				.mockResolvedValueOnce([]);

			await runWorker("/test/cwd");

			expect(vi.mocked(renderTopicKBWiki)).not.toHaveBeenCalled();
		});

		it("does NOT re-trigger a post-commit ingest when only an ingest op was processed (no self-perpetuation)", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 2, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/ingest.json" }])
				.mockResolvedValueOnce([]);

			await runWorker("/test/cwd");

			expect(vi.mocked(enqueueIngestOperation)).not.toHaveBeenCalled();
		});
	});
});
