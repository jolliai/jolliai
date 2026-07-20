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

// CaptureProgress is the interactive-feedback stream (its own real behavior is
// covered by CaptureProgress.test.ts). Here it is a spy so tests can assert the
// lifecycle events the worker emits, without touching the filesystem.
vi.mock("./CaptureProgress.js", () => ({
	CAPTURE_PROGRESS_MAX_AGE_MS: 60 * 60 * 1000,
	acquireCaptureLock: vi.fn(),
	emitCaptureProgress: vi.fn(),
	pruneStaleCaptureProgress: vi.fn(),
	releaseCaptureLock: vi.fn().mockResolvedValue(undefined),
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

// ContextRelevance: default is a fail-open passthrough (keep all, no soft-exclude), so
// the existing pipeline tests (which relied on the real fail-open behaviour) are
// unaffected. Individual tests override assessContextRelevance via mockResolvedValueOnce
// to drive the AI soft-exclude → skip-association path. The pure helpers
// (buildChangeSignal / computeChangeFingerprint / buildDecisionFromAiExcluded) keep
// their real implementations.
// CommitSelectionStore: readAiSelection is stubbed so tests can drive executePipeline's
// fingerprint-reuse arm (buildDecisionFromAiExcluded) vs the recompute arm. Everything
// else (readExclusions / writeAiSelection / …) keeps its real implementation.
vi.mock("../core/CommitSelectionStore.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/CommitSelectionStore.js")>();
	return {
		...actual,
		readAiSelection: vi.fn(),
		clearAiSelection: vi.fn(),
	};
});

vi.mock("../core/ContextRelevance.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/ContextRelevance.js")>();
	return {
		...actual,
		// buildChangeSignal touches git plumbing not fully mocked in this suite; if it
		// throws, the relevance try-block skips assessContextRelevance entirely. Stub it
		// so assess actually runs. computeChangeFingerprint / buildDecisionFromAiExcluded
		// keep their real implementations.
		buildChangeSignal: vi.fn(async () => ({ commitMessage: "", changedFiles: ["src/file.ts"], symbols: [] })),
		assessContextRelevance: vi.fn(async (raw: Parameters<typeof actual.assessContextRelevance>[0]) => ({
			plans: raw.plans,
			notes: raw.notes,
			references: raw.references,
			excludedContext: [],
			results: [],
		})),
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
	// ingest.lock: default to "acquired" so the ingest phase runs in tests. The
	// lock contract itself is covered in Locks.test.ts.
	acquireIngestLock: vi.fn().mockResolvedValue(true),
	releaseIngestLock: vi.fn(),
	refreshIngestLockMtime: vi.fn(),
	// Passthrough: run the RMW body without touching the real lock file. The
	// per-worktree lock contract itself is covered in Locks.test.ts.
	withPlansLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
	withCommitSelectionLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
	INGEST_PHASE_FILE: "ingest-phase",
}));

vi.mock("./CommitCaptureLock.js", () => ({
	COMMIT_CAPTURE_LOCK_WAIT_MS: 1000,
	withCommitCaptureLock: vi.fn(async (_cwd: string, _hash: string, _mode: unknown, body: () => Promise<unknown>) => ({
		ran: true,
		value: await body(),
	})),
}));

// CaptureProgress: keep the real progress-file helpers (readEvents / format /
// prune) but spy on emitCaptureProgress so tests can assert the lifecycle events
// the squash / rebase handlers emit. This is the fix that makes an interactive
// watcher report a completed squash / rebase-pick / rebase-squash capture
// instead of the "analysis continues in the background…" fallback.
vi.mock("./CaptureProgress.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./CaptureProgress.js")>();
	return {
		...actual,
		emitCaptureProgress: vi.fn(),
	};
});

vi.mock("../sync/PendingIngest.js", () => ({
	recordPendingIngest: vi.fn().mockResolvedValue(undefined),
	wakePendingIngest: vi.fn().mockResolvedValue(undefined),
}));

// `vault-write.lock` integration: the Standalone Hotfix now wraps the worker
// in `acquireVaultWriteLock`. Tests mock it to always succeed so the
// drain-queue test path stays focused on per-entry behaviour. A separate
// QueueWorker.vaultLock test file exercises the lock acquisition / release
// contract directly.
vi.mock("../sync/VaultWriteLock.js", async (importOriginal) => {
	// Keep the real `VaultWriteBusyError` so the unlocked-ingest guard's typed busy
	// signal is the genuine class; only the lock acquisition is stubbed.
	const actual = await importOriginal<typeof import("../sync/VaultWriteLock.js")>();
	return {
		...actual,
		acquireVaultWriteLock: vi.fn().mockResolvedValue({
			release: vi.fn().mockResolvedValue(undefined),
			refresh: vi.fn().mockResolvedValue(undefined),
		}),
		// Used by the unlocked-ingest writeGuard. Passthrough: run the body, report ran.
		withVaultWriteLock: vi.fn(async (_root: string, _mode: unknown, body: () => Promise<unknown>) => ({
			ran: true,
			value: await body(),
		})),
		DEFAULT_VAULT_WRITE_WAIT_MS: 60_000,
		isVaultWriteLockHeld: vi.fn(),
	};
});

// PendingWorkers cross-repo wakeup helpers. Mocked so tests can verify
// QueueWorker records its cwd on lock acquisition failure (L295/309-314)
// and delegates the on-release wakeup to `wakePendingWorkers`. The real
// drain+launch+skip-self loop is exercised directly in PendingWorkers.test.ts;
// here we only assert QueueWorker calls the helper with its own cwd as selfCwd.
vi.mock("../sync/PendingWorkers.js", () => ({
	recordPendingWorker: vi.fn().mockResolvedValue(undefined),
	consumePendingWorkers: vi.fn().mockResolvedValue([]),
	wakePendingWorkers: vi.fn().mockResolvedValue(undefined),
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
		// Passthrough spy for the ingest writeGuard's inner orphan-write.lock. Runs
		// the body without touching the real lock file (the acquire/release contract
		// is covered in SummaryStore.test.ts); tests here assert the WIRING — that
		// ingest writes now flow through this lock, nested inside vault-write.lock.
		withRequiredOrphanWriteLock: vi.fn(
			async (_cwd: string | undefined, _label: string, fn: () => Promise<unknown>) => fn(),
		),
		// Real implementations -- runSquashPipeline / handleAmendPipeline call
		// these to expand source commits and copy-hoist topics. The mocks above
		// cover the storage write side; these helpers are pure tree transforms
		// so we want their actual behaviour in tests.
		stripFunctionalMetadata: actual.stripFunctionalMetadata,
		resolveEffectiveTopics: actual.resolveEffectiveTopics,
		expandSourcesForConsolidation: actual.expandSourcesForConsolidation,
	};
});

// Spy on the checkpoint archive tail step; keep commitSecondUpperBound real so the
// `before` resolver (when reached) still computes a genuine bound. Default no-op.
vi.mock("../core/CheckpointStore.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/CheckpointStore.js")>()),
	archiveSupersededCheckpoints: vi.fn(async () => 0),
}));

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

vi.mock("../core/ClineDetector.js", () => ({
	isClineInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/ClineSessionDiscoverer.js", () => ({
	discoverClineSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/ClineTranscriptReader.js", () => ({
	readClineTranscript: vi.fn().mockResolvedValue({
		entries: [],
		newCursor: { transcriptPath: "", lineNumber: 0, updatedAt: "" },
		totalLinesRead: 0,
	}),
}));

vi.mock("../core/ClineCliDetector.js", () => ({
	isClineCliInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/ClineCliSessionDiscoverer.js", () => ({
	discoverClineCliSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../core/ClineCliTranscriptReader.js", () => ({
	readClineCliTranscript: vi.fn().mockResolvedValue({
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

vi.mock("../core/DevinSessionDiscoverer.js", () => ({
	discoverDevinSessions: vi.fn().mockResolvedValue([]),
	isDevinInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/DevinTranscriptReader.js", () => ({
	readDevinTranscript: vi.fn().mockResolvedValue({
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

vi.mock("../core/IngestPipeline.js", () => ({
	drainIngest: vi.fn(async () => ({ batches: 0, ingested: 0, outcome: "NO_PENDING", topicFailures: [] })),
}));

vi.mock("../core/TopicWikiRenderer.js", () => ({
	renderTopicKBWiki: vi.fn(async () => {}),
}));
vi.mock("../graph/GraphBuilder.js", () => ({
	buildKnowledgeGraph: vi.fn(async () => ({ built: false })),
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
import { archiveSupersededCheckpoints } from "../core/CheckpointStore.js";
import { isClineCliInstalled } from "../core/ClineCliDetector.js";
import { discoverClineCliSessions } from "../core/ClineCliSessionDiscoverer.js";
import { readClineCliTranscript } from "../core/ClineCliTranscriptReader.js";
import { isClineInstalled } from "../core/ClineDetector.js";
import { discoverClineSessions } from "../core/ClineSessionDiscoverer.js";
import { readClineTranscript } from "../core/ClineTranscriptReader.js";
import { isCodexInstalled } from "../core/CodexSessionDiscoverer.js";
import { clearAiSelection, readAiSelection } from "../core/CommitSelectionStore.js";
import { assessContextRelevance, buildChangeSignal, computeChangeFingerprint } from "../core/ContextRelevance.js";
import { isCopilotChatInstalled } from "../core/CopilotChatDetector.js";
import { discoverCopilotChatSessions } from "../core/CopilotChatSessionDiscoverer.js";
import { isCopilotInstalled } from "../core/CopilotDetector.js";
import { discoverCopilotSessions } from "../core/CopilotSessionDiscoverer.js";
import { readCopilotTranscript } from "../core/CopilotTranscriptReader.js";
import { isCursorInstalled } from "../core/CursorDetector.js";
import { discoverCursorSessions } from "../core/CursorSessionDiscoverer.js";
import { readCursorTranscript } from "../core/CursorTranscriptReader.js";
import { discoverDevinSessions, isDevinInstalled } from "../core/DevinSessionDiscoverer.js";
import { readDevinTranscript } from "../core/DevinTranscriptReader.js";
import { getCommitInfo, getCurrentBranch, getDiffContent, getDiffStats } from "../core/GitOps.js";
import { drainIngest } from "../core/IngestPipeline.js";
import { appendCredentialMissingRun } from "../core/IngestRunStore.js";
import { enqueueIngestOperation } from "../core/IngestTrigger.js";
import { LlmCredentialError } from "../core/LlmClient.js";
import { acquireIngestLock, acquireWorkerLock, releaseIngestLock, releaseWorkerLock } from "../core/Locks.js";
import { LocalAgentAuthError } from "../core/localagent/Types.js";
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
import { storeSummary, withRequiredOrphanWriteLock } from "../core/SummaryStore.js";
import { renderTopicKBWiki } from "../core/TopicWikiRenderer.js";
import { buildMultiSessionContext, readTranscript } from "../core/TranscriptReader.js";
import { buildKnowledgeGraph } from "../graph/GraphBuilder.js";
import { recordPendingIngest, wakePendingIngest } from "../sync/PendingIngest.js";
import { recordPendingWorker, wakePendingWorkers } from "../sync/PendingWorkers.js";
import { acquireVaultWriteLock, withVaultWriteLock } from "../sync/VaultWriteLock.js";
import type {
	CommitGitOperation,
	CommitInfo,
	CommitSummary,
	ExcludedContextItem,
	IngestOperation,
	PlanReference,
	ReferenceCommitRef,
} from "../Types.js";
import { emitCaptureProgress } from "./CaptureProgress.js";
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
		// ingest.lock: re-establish "acquired" after resetAllMocks wipes the factory
		// default, so the queue-driven ingest phase runs (release/refresh are void).
		vi.mocked(acquireIngestLock).mockResolvedValue(true);
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
		vi.mocked(isClineInstalled).mockResolvedValue(false);
		vi.mocked(discoverClineSessions).mockResolvedValue([]);
		vi.mocked(isClineCliInstalled).mockResolvedValue(false);
		vi.mocked(discoverClineCliSessions).mockResolvedValue([]);
		vi.mocked(isDevinInstalled).mockResolvedValue(false);
		vi.mocked(discoverDevinSessions).mockResolvedValue([]);
		vi.mocked(buildMultiSessionContext).mockReturnValue("");
		vi.mocked(generateSummary).mockResolvedValue({
			transcriptEntries: 0,
			conversationTurns: 0,
			llm: { model: "test", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "end_turn" },
			stats: { filesChanged: 1, insertions: 5, deletions: 2 },
			topics: [{ title: "Test topic", trigger: "test", response: "done", decisions: "none" }],
		});
		vi.mocked(storeSummary).mockResolvedValue(undefined);
		vi.mocked(readAiSelection).mockResolvedValue({ aiRelevance: [] });
		vi.mocked(clearAiSelection).mockResolvedValue(undefined);
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
			// Three dequeues now: the capped drain (broke at 20), the chain-spawn
			// probe, and the ingest-phase pre-check (which finds no ingest entries).
			expect(vi.mocked(dequeueAllGitOperations)).toHaveBeenCalledTimes(3);
		});
	});

	describe("runWorker — vault-write.lock failure path", () => {
		it("records pendingWorker and returns early when vault lock stays busy through the retry", async () => {
			// Pins the vaultLock === null branch: recordPendingWorker call +
			// post-record fail-fast retry + early return. When the
			// vault-write.lock is held by another writer that is STILL holding
			// it on the retry, the worker must record its cwd so the next
			// release re-spawns it, then exit without touching the queue.
			// Both the wait-mode acquire and the fail-fast retry miss.
			vi.mocked(acquireVaultWriteLock).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

			await runWorker("/test/cwd-locked");

			// The pending-worker entry must be recorded so a cross-repo
			// release can wake us up.
			expect(recordPendingWorker).toHaveBeenCalledTimes(1);
			expect(recordPendingWorker).toHaveBeenCalledWith(expect.any(String), "/test/cwd-locked");
			// Two acquisition attempts: the wait-mode acquire, then the
			// post-record fail-fast retry (the lost-wakeup guard).
			expect(acquireVaultWriteLock).toHaveBeenCalledTimes(2);
			// And we MUST NOT have done any queue work.
			expect(dequeueAllGitOperations).not.toHaveBeenCalled();
			expect(acquireWorkerLock).not.toHaveBeenCalled();
		});

		it("proceeds when the holder releases during the pending-record gap (lost-wakeup guard)", async () => {
			// Pins the lost-wakeup guard: the wait-mode acquire times out, we
			// record our pending entry, and the holder happens to release in
			// the gap between our timeout and the record landing. Its
			// consumePendingWorkers may have run against an empty registry and
			// will never re-spawn us — so the post-record fail-fast retry must
			// grab the now-free lock and PROCEED to drain the queue rather than
			// stranding the entry until this repo's next commit.
			vi.mocked(acquireVaultWriteLock)
				.mockResolvedValueOnce(null) // wait-mode acquire times out
				.mockResolvedValueOnce({
					release: vi.fn().mockResolvedValue(undefined),
					refresh: vi.fn().mockResolvedValue(undefined),
				}); // fail-fast retry succeeds — holder released in the gap

			await runWorker("/test/cwd-retry");

			// Intent was recorded before the retry (so any concurrent releaser
			// would also see it), but this run grabbed the lock itself.
			expect(recordPendingWorker).toHaveBeenCalledTimes(1);
			expect(acquireVaultWriteLock).toHaveBeenCalledTimes(2);
			// Crucially: we proceeded past the vault lock and did real work
			// instead of returning early.
			expect(acquireWorkerLock).toHaveBeenCalled();
		});

		it("delegates the on-release wakeup to wakePendingWorkers with its own cwd as selfCwd", async () => {
			// QueueWorker no longer hand-rolls the drain+launch+skip-self loop;
			// it delegates to the shared `wakePendingWorkers`, passing its own cwd
			// as `selfCwd` so the helper won't re-spawn this very worker (which
			// already chain-spawns for itself at the end of the drain). The actual
			// skip-self + launch behaviour is exercised against the REAL helper in
			// PendingWorkers.test.ts — here we only pin the delegation contract.
			vi.mocked(dequeueAllGitOperations).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

			await runWorker("/test/cwd");

			expect(wakePendingWorkers).toHaveBeenCalledWith(expect.any(String), expect.any(Function), "/test/cwd");
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

			// Four dequeues: two in the drain loop (entry, then empty → break), the
			// chain-spawn probe (returns a remaining summary entry → log + launchWorker),
			// and the ingest-phase pre-check (empty by default). launchWorker is in a
			// v8-ignore branch, so we verify via the dequeue count.
			expect(dequeueAllGitOperations).toHaveBeenCalledTimes(4);
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

	// Regression: summary.branch used to be read from the live getCurrentBranch
	// at drain time. That is wrong when HEAD moved between enqueue and drain —
	// a rapid squash/amend/rebase (rebase transiently checks out the upstream),
	// or a sibling worktree sitting on another branch. The branch must come from
	// the queued op (captured inside the git hook at enqueue time), mirroring the
	// tail-cleanup fix. Otherwise a commit on a feature branch is filed under
	// whatever branch happened to be live (e.g. "main"), which breaks branch
	// grouping and the sidebar's `gh pr list --head <branch>` PR-status lookup.
	describe("runWorker — summary.branch provenance", () => {
		it("records op.branch on the summary, not the live getCurrentBranch", async () => {
			const op = makeCommitOp({ branch: "feature/captured" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			// Simulate HEAD drifting away after enqueue (e.g. rebase checked out main).
			vi.mocked(getCurrentBranch).mockResolvedValue("main");

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			const savedSummary = vi.mocked(storeSummary).mock.calls[0][0];
			expect(savedSummary.branch).toBe("feature/captured");
		});

		it("falls back to live getCurrentBranch when op.branch is absent (pre-0.99.x entries)", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			vi.mocked(getCurrentBranch).mockResolvedValue("feature/live");

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			const savedSummary = vi.mocked(storeSummary).mock.calls[0][0];
			expect(savedSummary.branch).toBe("feature/live");
		});
	});

	describe("runWorker — capture skip guard + checkpoint archive gate", () => {
		const storageWithKb = () => ({
			readFile: vi.fn().mockResolvedValue(null),
			writeFiles: vi.fn().mockResolvedValue(undefined),
			listFiles: vi.fn().mockResolvedValue([]),
			exists: vi.fn().mockResolvedValue(true),
			ensure: vi.fn().mockResolvedValue(undefined),
			kbRoot: "/kb/test-repo",
		});

		it("regenerates when only a back-filled summary exists — live capture supersedes it, and archives", async () => {
			const { getSummary } = await import("../core/SummaryStore.js");
			const op = makeCommitOp({ branch: "feature/x" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/e.json" }])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			vi.mocked(createStorage).mockResolvedValue(storageWithKb() as never);
			vi.mocked(getSummary).mockResolvedValue({ commitHash: op.commitHash, backfilled: true } as never);

			await runWorker("/test/cwd");

			// A back-fill is a placeholder → it does NOT short-circuit: the pipeline runs
			// and stores the live summary, and the durable summary then supersedes the
			// branch's checkpoints.
			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(vi.mocked(archiveSupersededCheckpoints)).toHaveBeenCalledTimes(1);
		});

		it("skips regeneration when a live (non-back-filled) summary already exists, but still archives", async () => {
			const { getSummary } = await import("../core/SummaryStore.js");
			const op = makeCommitOp({ branch: "feature/x" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/e.json" }])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			vi.mocked(createStorage).mockResolvedValue(storageWithKb() as never);
			vi.mocked(getSummary).mockResolvedValue({ commitHash: op.commitHash } as never);

			await runWorker("/test/cwd");

			// A live summary exists → skip the LLM pipeline, but archiving is still
			// correct because the summary is present.
			expect(storeSummary).not.toHaveBeenCalled();
			expect(vi.mocked(archiveSupersededCheckpoints)).toHaveBeenCalledTimes(1);
		});

		it("does NOT archive checkpoints when the pipeline stored no summary (empty diff + no transcript)", async () => {
			const { getSummary } = await import("../core/SummaryStore.js");
			const op = makeCommitOp({ branch: "feature/x" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/e.json" }])
				.mockResolvedValueOnce([]);
			vi.mocked(getCommitInfo).mockResolvedValue({
				hash: op.commitHash,
				message: "m",
				author: "a",
				date: "2026-04-01T12:00:00.000Z",
			});
			vi.mocked(getCurrentBranch).mockResolvedValue("feature/x");
			// Empty diff + no transcript → executePipeline skips without storing.
			vi.mocked(getDiffContent).mockResolvedValue("");
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 });
			vi.mocked(loadAllSessions).mockResolvedValue([]);
			vi.mocked(createStorage).mockResolvedValue(storageWithKb() as never);
			vi.mocked(getSummary).mockResolvedValue(null as never);

			await runWorker("/test/cwd");

			// Nothing durable landed for this commit, so the checkpoint tail step must
			// NOT retire the branch's live checkpoints.
			expect(storeSummary).not.toHaveBeenCalled();
			expect(vi.mocked(archiveSupersededCheckpoints)).not.toHaveBeenCalled();
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

		it("writes the auth-specific marker when both attempts throw LocalAgentAuthError", async () => {
			// The local `claude` login expired — both attempts throw
			// LocalAgentAuthError. The placeholder still lands, but the marker is
			// the auth-specific kind so the SessionStart reminder + post-commit
			// output can show sign-in guidance instead of a generic failure.
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/auth.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			vi.mocked(generateSummary)
				.mockRejectedValueOnce(new LocalAgentAuthError("OAuth session expired"))
				.mockRejectedValueOnce(new LocalAgentAuthError("OAuth session expired"));

			await runWorker("/test/cwd");

			expect(generateSummary).toHaveBeenCalledTimes(2);
			expect(storeSummary).toHaveBeenCalledTimes(1);
			const stored = vi.mocked(storeSummary).mock.calls[0][0];
			expect(stored.topics).toEqual([]);
			expect(stored.llm?.stopReason).toBe("error");
			expect(stored.summaryError).toBe("local-agent-auth");
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

	describe("Cline integration", () => {
		it("should include discovered Cline (VS Code) sessions in the pipeline when enabled", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/cline.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isClineInstalled).mockResolvedValue(true);
			vi.mocked(discoverClineSessions).mockResolvedValue([
				{
					sessionId: "cline-1",
					transcriptPath: "/tmp/cline/task-1/ui_messages.json",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "cline",
				},
			]);
			vi.mocked(readClineTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Cline context", timestamp: "2026-04-01T12:00:00.000Z" }],
				newCursor: {
					transcriptPath: "/tmp/cline/task-1/ui_messages.json",
					lineNumber: 1,
					updatedAt: "2026-04-01T12:00:00.000Z",
				},
				totalLinesRead: 1,
			});

			await runWorker("/test/cwd");

			expect(discoverClineSessions).toHaveBeenCalledWith("/test/cwd");
			expect(readClineTranscript).toHaveBeenCalledWith(
				"/tmp/cline/task-1/ui_messages.json",
				null,
				"2026-04-01T12:00:00.000Z",
			);
			expect(saveCursor).toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/tmp/cline/task-1/ui_messages.json", lineNumber: 1 }),
				"/test/cwd",
			);
		});

		it("should include discovered Cline CLI sessions in the pipeline when enabled", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/cline-cli.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isClineCliInstalled).mockResolvedValue(true);
			vi.mocked(discoverClineCliSessions).mockResolvedValue([
				{
					sessionId: "cline-cli-1",
					transcriptPath: "/tmp/cline-cli/session-1.json",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "cline-cli",
				},
			]);
			vi.mocked(readClineCliTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Cline CLI context", timestamp: "2026-04-01T12:00:00.000Z" }],
				newCursor: {
					transcriptPath: "/tmp/cline-cli/session-1.json",
					lineNumber: 1,
					updatedAt: "2026-04-01T12:00:00.000Z",
				},
				totalLinesRead: 1,
			});

			await runWorker("/test/cwd");

			expect(discoverClineCliSessions).toHaveBeenCalledWith("/test/cwd");
			expect(readClineCliTranscript).toHaveBeenCalledWith(
				"/tmp/cline-cli/session-1.json",
				null,
				"2026-04-01T12:00:00.000Z",
			);
			expect(saveCursor).toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/tmp/cline-cli/session-1.json", lineNumber: 1 }),
				"/test/cwd",
			);
		});

		it("skips discovery for both Cline sources when clineEnabled is explicitly false", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/cline-disabled.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({ clineEnabled: false } as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isClineInstalled).mockResolvedValue(true);
			vi.mocked(isClineCliInstalled).mockResolvedValue(true);

			await runWorker("/test/cwd");

			// clineEnabled=false short-circuits before isClineInstalled/isClineCliInstalled are consulted
			expect(isClineInstalled).not.toHaveBeenCalled();
			expect(discoverClineSessions).not.toHaveBeenCalled();
			expect(isClineCliInstalled).not.toHaveBeenCalled();
			expect(discoverClineCliSessions).not.toHaveBeenCalled();
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

	describe("Devin integration", () => {
		it("should include discovered Devin sessions in the pipeline when enabled", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/devin.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isDevinInstalled).mockResolvedValue(true);
			vi.mocked(discoverDevinSessions).mockResolvedValue([
				{
					sessionId: "dev-1",
					transcriptPath: "/tmp/devin/sessions.db#dev-1",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "devin",
				},
			]);
			vi.mocked(readDevinTranscript).mockResolvedValue({
				entries: [{ role: "human", content: "Devin context", timestamp: "2026-04-01T12:00:00.000Z" }],
				newCursor: {
					transcriptPath: "/tmp/devin/sessions.db#dev-1",
					lineNumber: 1,
					updatedAt: "2026-04-01T12:00:00.000Z",
				},
				totalLinesRead: 1,
			});

			await runWorker("/test/cwd");

			expect(discoverDevinSessions).toHaveBeenCalledWith("/test/cwd");
			expect(readDevinTranscript).toHaveBeenCalledWith(
				"/tmp/devin/sessions.db#dev-1",
				null,
				"2026-04-01T12:00:00.000Z",
			);
			expect(saveCursor).toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/tmp/devin/sessions.db#dev-1", lineNumber: 1 }),
				"/test/cwd",
			);
		});

		it("does not call isDevinInstalled or discoverDevinSessions when devinEnabled is false", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/devin-disabled.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({
				devinEnabled: false,
			} as Awaited<ReturnType<typeof loadConfig>>);

			await runWorker("/test/cwd");

			expect(isDevinInstalled).not.toHaveBeenCalled();
			expect(discoverDevinSessions).not.toHaveBeenCalled();
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
				unresolvedOrphanHashes: ["pending-child"],
				plans: [{ slug: "p", title: "P", addedAt: "x", updatedAt: "y" }],
				notes: [{ id: "n", title: "N", format: "markdown" as const, addedAt: "x", updatedAt: "y" }],
				e2eTestGuide: [{ title: "T", steps: ["s"], expectedResults: ["r"] }],
			};
			const out = __test__.hoistMetadataFromOldSummary(rich);
			expect(out.jolliDocId).toBe(42);
			expect(out.jolliDocUrl).toBe("https://jolli.app/d/42");
			expect(out.orphanedDocIds).toEqual([1, 2]);
			expect(out.unresolvedOrphanHashes).toEqual(["pending-child"]);
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

	describe("Claude integration — missing transcript file", () => {
		it("skips a Claude session whose transcript file is unreadable and still summarizes the rest", async () => {
			// Regression: a Claude session in sessions.json pointing at a transcript that was
			// deleted/rotated makes readTranscript throw ENOENT. The claude branch in
			// readAllTranscripts used to be unguarded, so that throw aborted the whole pipeline
			// and the commit summary was silently dropped. The reader is now wrapped in
			// try/catch + continue, so one dead transcript only skips its own session.
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/claude-missing.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadAllSessions).mockResolvedValue([
				{
					sessionId: "dead-1",
					transcriptPath: "/Users/zf/.claude/projects/proj/dead-1.jsonl",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "claude",
				},
				{
					sessionId: "live-1",
					transcriptPath: "/Users/zf/.claude/projects/proj/live-1.jsonl",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "claude",
				},
			]);
			vi.mocked(readTranscript).mockImplementation(async (transcriptPath: string) => {
				if (transcriptPath.endsWith("dead-1.jsonl")) {
					throw new Error(`Cannot read transcript: ${transcriptPath}`);
				}
				return {
					entries: [{ role: "human", content: "Live context", timestamp: "2026-04-01T12:00:00.000Z" }],
					newCursor: { transcriptPath, lineNumber: 1, updatedAt: "2026-04-01T12:00:00.000Z" },
					totalLinesRead: 1,
				};
			});

			await runWorker("/test/cwd");

			// The throw from the dead transcript must not abort the run — the summary is still produced.
			expect(storeSummary).toHaveBeenCalledTimes(1);
			// The live session's cursor advanced; the dead session never produced a cursor write.
			expect(saveCursor).toHaveBeenCalledWith(
				expect.objectContaining({
					transcriptPath: "/Users/zf/.claude/projects/proj/live-1.jsonl",
					lineNumber: 1,
				}),
				"/test/cwd",
			);
			expect(saveCursor).not.toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/Users/zf/.claude/projects/proj/dead-1.jsonl" }),
				"/test/cwd",
			);
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

	describe("Cline integration — read failure", () => {
		it("skips a Cline session whose transcript read throws and continues with the rest of the pipeline", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/cline-throws.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isClineInstalled).mockResolvedValue(true);
			vi.mocked(discoverClineSessions).mockResolvedValue([
				{
					sessionId: "cline-broken",
					transcriptPath: "/cline/task-broken/ui_messages.json",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "cline",
				},
			]);
			vi.mocked(readClineTranscript).mockRejectedValue(new Error("Cannot read Cline session: cline-broken"));

			await runWorker("/test/cwd");

			expect(readClineTranscript).toHaveBeenCalledWith(
				"/cline/task-broken/ui_messages.json",
				null,
				"2026-04-01T12:00:00.000Z",
			);
			// Pipeline still completes — the broken session was skipped, not fatal
			expect(storeSummary).toHaveBeenCalled();
			expect(saveCursor).not.toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/cline/task-broken/ui_messages.json" }),
				"/test/cwd",
			);
		});

		it("skips a Cline CLI session whose transcript read throws and continues with the rest of the pipeline", async () => {
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/cline-cli-throws.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadConfig).mockResolvedValue({} as Awaited<ReturnType<typeof loadConfig>>);
			vi.mocked(isClineCliInstalled).mockResolvedValue(true);
			vi.mocked(discoverClineCliSessions).mockResolvedValue([
				{
					sessionId: "cline-cli-broken",
					transcriptPath: "/cline-cli/session-broken.json",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "cline-cli",
				},
			]);
			vi.mocked(readClineCliTranscript).mockRejectedValue(new Error("Cannot read Cline CLI session: broken"));

			await runWorker("/test/cwd");

			expect(readClineCliTranscript).toHaveBeenCalledWith(
				"/cline-cli/session-broken.json",
				null,
				"2026-04-01T12:00:00.000Z",
			);
			expect(storeSummary).toHaveBeenCalled();
			expect(saveCursor).not.toHaveBeenCalledWith(
				expect.objectContaining({ transcriptPath: "/cline-cli/session-broken.json" }),
				"/test/cwd",
			);
		});
	});

	describe("squash helpers", () => {
		it("should skip squash queue entries without source hashes", async () => {
			await expect(__test__.handleSquashFromQueue(makeCommitOp(), "/test/cwd")).resolves.toBeUndefined();
		});

		it("emits a terminal `failed` for an unknown queue entry type so the watcher never hangs", async () => {
			const { emitCaptureProgress } = await import("./CaptureProgress.js");
			vi.mocked(emitCaptureProgress).mockClear();
			// A corrupt / future queue entry whose type matches no switch case. It
			// stores nothing, so the interactive watcher must be told `failed`
			// rather than left on "analysis continues in the background…". storage
			// is never read (the branch-less op returns before the tail step).
			const op = makeCommitOp({ type: "bogus" as CommitGitOperation["type"] });
			await expect(__test__.processQueueEntry(op, "/test/cwd", {} as never, false)).resolves.toBeUndefined();
			expect(vi.mocked(emitCaptureProgress)).toHaveBeenCalledWith("/test/cwd", op.commitHash, "failed");
			// The `finally` still closes the stream with a terminal `end`.
			expect(vi.mocked(emitCaptureProgress)).toHaveBeenCalledWith("/test/cwd", op.commitHash, "end", {
				terminal: true,
			});
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

	// Regression: squash / rebase-pick / rebase-squash used to emit only `start`
	// + the terminal `end`, never a `stored`/`skipped` content event — so after a
	// SUCCESSFUL consolidation an interactive watcher wrongly printed "analysis
	// continues in the background…". Each handler must now emit `stored` on a
	// produced summary and `skipped` on a no-op, matching executePipeline's shape.
	describe("capture-progress feedback for squash / rebase handlers", () => {
		function makeSummary(topics: number): CommitSummary {
			return {
				version: 3,
				commitHash: "oldhash",
				commitMessage: "Old",
				commitAuthor: "Jane",
				commitDate: "2026-04-01T10:00:00.000Z",
				branch: "feature/test",
				generatedAt: "2026-04-01T10:00:00.000Z",
				topics: Array.from({ length: topics }, (_, i) => ({
					title: `T${i}`,
					trigger: "t",
					response: "r",
					decisions: "d",
				})),
			} as CommitSummary;
		}

		it("squash emits a `stored` event on a successful consolidation", async () => {
			const { getSummary } = await import("../core/SummaryStore.js");
			vi.mocked(getSummary).mockResolvedValue(makeSummary(1));
			setupPipelineMocks("sq-stored");

			await __test__.handleSquashFromQueue(
				makeCommitOp({ commitHash: "sq-stored", sourceHashes: ["oldhash"] }),
				"/test/cwd",
			);

			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "sq-stored", "stored", {
				data: { topics: expect.any(Number) },
			});
			expect(emitCaptureProgress).not.toHaveBeenCalledWith(
				"/test/cwd",
				"sq-stored",
				"skipped",
				expect.anything(),
			);
		});

		it("squash emits a terminal `skipped` event when there are no source hashes", async () => {
			await __test__.handleSquashFromQueue(makeCommitOp({ commitHash: "sq-none" }), "/test/cwd");
			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "sq-none", "skipped", { terminal: true });
		});

		it("squash emits a `skipped` event when no source summaries exist", async () => {
			const { getSummary } = await import("../core/SummaryStore.js");
			vi.mocked(getSummary).mockResolvedValue(null);
			await __test__.handleSquashFromQueue(
				makeCommitOp({ commitHash: "sq-empty", sourceHashes: ["missing"] }),
				"/test/cwd",
			);
			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "sq-empty", "skipped", { terminal: true });
		});

		it("rebase-pick emits a `stored` event carrying the migrated topic count", async () => {
			const { getSummary, migrateOneToOne } = await import("../core/SummaryStore.js");
			vi.mocked(getSummary).mockResolvedValue(makeSummary(2));
			setupPipelineMocks("rp-new");

			await __test__.handleRebasePickFromQueue(
				// commitSource set so the forwarded-source spread arm is exercised too.
				makeCommitOp({
					type: "rebase-pick",
					commitHash: "rp-new",
					sourceHashes: ["oldhash"],
					commitSource: "plugin",
				}),
				"/test/cwd",
			);

			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "rp-new", "stored", { data: { topics: 2 } });
			expect(migrateOneToOne).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ hash: "rp-new" }),
				"/test/cwd",
				expect.objectContaining({ commitType: "rebase", commitSource: "plugin" }),
			);
		});

		it("rebase-pick `stored` defaults topics to 0 for a container root with no own topics", async () => {
			// Container/hoist roots have `topics` absent — the `?? 0` fallback must
			// not throw and still reports a completed (not background) capture.
			const { getSummary } = await import("../core/SummaryStore.js");
			const containerRoot = {
				version: 3,
				commitHash: "oldhash",
				commitMessage: "Old",
				commitAuthor: "Jane",
				commitDate: "2026-04-01T10:00:00.000Z",
				branch: "feature/test",
				generatedAt: "2026-04-01T10:00:00.000Z",
			} as CommitSummary;
			vi.mocked(getSummary).mockResolvedValue(containerRoot);
			setupPipelineMocks("rp-container");

			await __test__.handleRebasePickFromQueue(
				makeCommitOp({ type: "rebase-pick", commitHash: "rp-container", sourceHashes: ["oldhash"] }),
				"/test/cwd",
			);

			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "rp-container", "stored", {
				data: { topics: 0 },
			});
		});

		it("rebase-pick emits a terminal `skipped` event when there is no source hash", async () => {
			await __test__.handleRebasePickFromQueue(
				makeCommitOp({ type: "rebase-pick", commitHash: "rp-none" }),
				"/test/cwd",
			);
			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "rp-none", "skipped", { terminal: true });
		});

		it("rebase-pick emits a `skipped` event when the source summary is missing", async () => {
			const { getSummary } = await import("../core/SummaryStore.js");
			vi.mocked(getSummary).mockResolvedValue(null);
			await __test__.handleRebasePickFromQueue(
				makeCommitOp({ type: "rebase-pick", commitHash: "rp-miss", sourceHashes: ["gone"] }),
				"/test/cwd",
			);
			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "rp-miss", "skipped", { terminal: true });
		});

		it("rebase-squash emits a `stored` event on a successful consolidation", async () => {
			const { getSummary } = await import("../core/SummaryStore.js");
			vi.mocked(getSummary).mockResolvedValue(makeSummary(1));
			setupPipelineMocks("rs-stored");

			await __test__.handleRebaseSquashFromQueue(
				makeCommitOp({ type: "rebase-squash", commitHash: "rs-stored", sourceHashes: ["oldhash"] }),
				"/test/cwd",
			);

			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "rs-stored", "stored", {
				data: { topics: expect.any(Number) },
			});
		});

		it("rebase-squash emits a terminal `skipped` event when there are no source hashes", async () => {
			await __test__.handleRebaseSquashFromQueue(
				makeCommitOp({ type: "rebase-squash", commitHash: "rs-none" }),
				"/test/cwd",
			);
			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "rs-none", "skipped", { terminal: true });
		});

		it("rebase-squash emits a `skipped` event when no source summaries exist", async () => {
			const { getSummary } = await import("../core/SummaryStore.js");
			vi.mocked(getSummary).mockResolvedValue(null);
			await __test__.handleRebaseSquashFromQueue(
				makeCommitOp({ type: "rebase-squash", commitHash: "rs-empty", sourceHashes: ["missing"] }),
				"/test/cwd",
			);
			expect(emitCaptureProgress).toHaveBeenCalledWith("/test/cwd", "rs-empty", "skipped", { terminal: true });
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

	// The branch written onto summary.branch must come from the op captured at enqueue
	// time (inside the git hook), NOT a live getCurrentBranch read during drain. Reading
	// live mis-attributes the summary when the user has `git checkout`'d away between
	// enqueue and drain (e.g. `git commit && git checkout main`). Live read survives only
	// as a fallback for pre-0.99.x queue entries lacking op.branch.
	describe("branch attribution (op.branch over live getCurrentBranch)", () => {
		it("executePipeline writes op.branch, not the live branch", async () => {
			const op = makeCommitOp({ commitHash: "abc12345def67890", branch: "feature/x" });
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");
			// Simulate the user having switched to main after committing on feature/x.
			vi.mocked(getCurrentBranch).mockResolvedValue("main");

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(vi.mocked(storeSummary).mock.calls[0][0].branch).toBe("feature/x");
		});

		it("executePipeline falls back to live branch when op.branch is missing (pre-0.99.x entry)", async () => {
			const op = makeCommitOp({ commitHash: "abc12345def67890" }); // no branch field
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");
			vi.mocked(getCurrentBranch).mockResolvedValue("main");

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(vi.mocked(storeSummary).mock.calls[0][0].branch).toBe("main");
		});

		it("amend fresh-leaf writes op.branch via branchHint, not the live branch", async () => {
			const op = makeCommitOp({
				type: "amend",
				commitHash: "abc12345def67890",
				branch: "feature/x",
				sourceHashes: ["0123456789abcdef0123456789abcdef01234567"],
			});
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");
			vi.mocked(getCurrentBranch).mockResolvedValue("main");
			// No old summary → fresh-leaf path (getSummary defaults to undefined).
			// Non-trivial delta (>50 lines) so the trivial-amend short-circuit is skipped.
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 60, deletions: 1 });
			// One uncommitted reference (registry-miss, tolerated) so the fresh-leaf
			// reference-association path runs on op.branch too — references suffer the
			// same mis-attribution as summary.branch.
			vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([
				{ mapKey: "linear:GHOST-1", source: "linear", sourcePath: "/tmp/ghost.md" },
			]);
			vi.mocked(loadPlansRegistry).mockResolvedValue({ version: 1, plans: {}, references: {} });

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(vi.mocked(storeSummary).mock.calls[0][0].branch).toBe("feature/x");
		});

		it("amend fresh-leaf falls back to live branch when op.branch is missing", async () => {
			const op = makeCommitOp({
				type: "amend",
				commitHash: "abc12345def67890",
				sourceHashes: ["0123456789abcdef0123456789abcdef01234567"],
			}); // no branch field
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");
			vi.mocked(getCurrentBranch).mockResolvedValue("main");
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 60, deletions: 1 });

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(vi.mocked(storeSummary).mock.calls[0][0].branch).toBe("main");
		});

		it("amend fresh-leaf skips AI soft-excluded items from association (keeps them uncommitted)", async () => {
			// Mirror executePipeline's normal path: an AI soft-excluded item must NOT be
			// associated — it keeps no commitHash and stays in the working area for the
			// next commit. Regression: the amend fresh-leaf path previously honoured only
			// user hard-excludes, so soft-excluded items were silently committed on amend.
			const dir = mkdtempSync(join(tmpdir(), "jolli-amend-soft-exclude-"));
			try {
				const keptPath = join(dir, "kept.md");
				const excludedPath = join(dir, "excluded.md");
				writeFileSync(keptPath, "kept note body");
				writeFileSync(excludedPath, "excluded note body");
				// node:fs is mocked in this suite (existsSync defaults to false); restore the
				// real fns so associateNotesWithCommit can read the temp note source files.
				const { existsSync: realExistsSync, readFileSync: realReadFileSync } =
					await vi.importActual<typeof import("node:fs")>("node:fs");
				vi.mocked(existsSync).mockImplementation(realExistsSync);
				vi.mocked(readFileSync).mockImplementation(realReadFileSync as typeof readFileSync);
				const op = makeCommitOp({
					type: "amend",
					commitHash: "abc12345def67890",
					branch: "feature/x",
					sourceHashes: ["0123456789abcdef0123456789abcdef01234567"],
				});
				vi.mocked(dequeueAllGitOperations)
					.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
					.mockResolvedValueOnce([])
					.mockResolvedValueOnce([]);
				setupPipelineMocks("abc12345def67890");
				vi.mocked(getCurrentBranch).mockResolvedValue("feature/x");
				// Non-trivial delta so the trivial-amend short-circuit is skipped.
				vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 60, deletions: 1 });
				// Two uncommitted notes on the branch → detectUncommittedNoteIds finds both.
				vi.mocked(loadPlansRegistry).mockResolvedValue({
					version: 1,
					plans: {},
					notes: {
						"n-kept": {
							id: "n-kept",
							title: "Kept",
							format: "snippet" as const,
							sourcePath: keptPath,
							addedAt: "2026-04-01T00:00:00Z",
							updatedAt: "2026-04-01T00:00:00Z",
							commitHash: null,
						},
						"n-excluded": {
							id: "n-excluded",
							title: "Excluded",
							format: "snippet" as const,
							sourcePath: excludedPath,
							addedAt: "2026-04-01T00:00:00Z",
							updatedAt: "2026-04-01T00:00:00Z",
							commitHash: null,
						},
					},
				});
				// AI soft-excludes n-excluded — it must be dropped from association.
				vi.mocked(assessContextRelevance).mockResolvedValueOnce({
					plans: [],
					notes: [],
					references: [],
					excludedContext: [
						{
							kind: "note",
							key: "n-excluded",
							title: "Excluded",
							reason: "unrelated to this change",
							tier: "low",
						},
					],
					results: [],
				});

				await runWorker("/test/cwd");

				expect(storeSummary).toHaveBeenCalledTimes(1);
				const saved = vi.mocked(storeSummary).mock.calls[0][0];
				const noteIds = (saved.notes ?? []).map((n) => n.id);
				// n-kept is associated (id carries the -<shorthash> suffix); n-excluded is
				// skipped entirely, keeping no commitHash.
				expect(noteIds.some((id) => id.startsWith("n-kept"))).toBe(true);
				expect(noteIds.some((id) => id.startsWith("n-excluded"))).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("executePipeline — context relevance degraded paths", () => {
		it("falls back to all user-kept context when relevance assessment throws (fail-open)", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			// buildChangeSignal throwing drives the relevance try-block's catch → fail-open:
			// all user-kept context retained, pipeline still completes.
			vi.mocked(buildChangeSignal).mockRejectedValueOnce(new Error("git diff failed"));

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			// Fail-open keeps everything → no excludedContext audit on the summary.
			expect(vi.mocked(storeSummary).mock.calls[0][0].excludedContext).toBeUndefined();
		});

		it("reuses the persisted panel ranking when the change fingerprint matches (no LLM)", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			const signal = { commitMessage: "", changedFiles: ["src/file.ts"], symbols: [] as string[] };
			vi.mocked(buildChangeSignal).mockResolvedValueOnce(signal);
			// Persisted fingerprint matches this change → executePipeline takes the
			// buildDecisionFromAiExcluded reuse arm and skips assessContextRelevance.
			vi.mocked(readAiSelection).mockResolvedValueOnce({
				aiRelevance: [],
				changeFingerprint: computeChangeFingerprint(signal),
			});
			vi.mocked(assessContextRelevance).mockClear();

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(assessContextRelevance).not.toHaveBeenCalled();
		});

		it("clears the AI selection layer after consuming it for a commit", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			vi.mocked(clearAiSelection).mockClear();

			await runWorker("/test/cwd");

			// The AI layer is cleared post-consume so a later same-file-set commit
			// can't reuse this now-stale fingerprint/decision.
			expect(clearAiSelection).toHaveBeenCalledWith("/test/cwd");
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

		it("writes ingest-phase=ingest:wiki during ingest, advances to ingest:graph before the graph build, and removes it after", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "jolli-phase-"));
			mkdirSync(join(tmp, ".jolli", "jollimemory"), { recursive: true });
			const phaseFile = join(tmp, ".jolli", "jollimemory", "ingest-phase");

			// Use the actual fs functions so we can observe real disk writes from
			// production code (writeFileSync / rmSync are actual in the mock spread).
			const { existsSync: realExistsSync, readFileSync: realReadFileSync } =
				await vi.importActual<typeof import("node:fs")>("node:fs");
			vi.mocked(existsSync).mockImplementation(realExistsSync);
			vi.mocked(readFileSync).mockImplementation(realReadFileSync as typeof readFileSync);

			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			const readPhase = () => (existsSync(phaseFile) ? readFileSync(phaseFile, "utf-8") : null);
			let phaseSeenDuringDrain: string | null = null;
			let phaseSeenDuringGraph: string | null = null;
			vi.mocked(drainIngest).mockImplementation(async () => {
				phaseSeenDuringDrain = readPhase();
				return { batches: 1, ingested: 2, outcome: "OK", topicFailures: [] };
			});
			vi.mocked(buildKnowledgeGraph).mockImplementationOnce(async () => {
				phaseSeenDuringGraph = readPhase();
				return { built: true };
			});

			await __test__.runIngestEntry(makeIngestOp("post-merge"), tmp, storageWithWiki(true));

			// The wiki phase covers ingest + render; the marker flips to graph only
			// right before the (gated) build.
			expect(phaseSeenDuringDrain).toBe("ingest:wiki");
			expect(phaseSeenDuringGraph).toBe("ingest:graph");
			expect(existsSync(phaseFile)).toBe(false);

			rmSync(tmp, { recursive: true, force: true });
		});

		it("leaves the marker at ingest:wiki (never ingest:graph) when the graph build is skipped", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "jolli-phase-"));
			mkdirSync(join(tmp, ".jolli", "jollimemory"), { recursive: true });
			const phaseFile = join(tmp, ".jolli", "jollimemory", "ingest-phase");

			const { existsSync: realExistsSync, readFileSync: realReadFileSync } =
				await vi.importActual<typeof import("node:fs")>("node:fs");
			vi.mocked(existsSync).mockImplementation(realExistsSync);
			vi.mocked(readFileSync).mockImplementation(realReadFileSync as typeof readFileSync);

			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			// 0 ingested + wiki present → render + graph both skipped, so the phase
			// never advances past wiki.
			let phaseSeenDuringDrain: string | null = null;
			vi.mocked(drainIngest).mockImplementation(async () => {
				phaseSeenDuringDrain = existsSync(phaseFile) ? readFileSync(phaseFile, "utf-8") : null;
				return { batches: 1, ingested: 0, outcome: "OK", topicFailures: [] };
			});

			await __test__.runIngestEntry(makeIngestOp("post-merge"), tmp, storageWithWiki(true));

			expect(phaseSeenDuringDrain).toBe("ingest:wiki");
			expect(vi.mocked(buildKnowledgeGraph)).not.toHaveBeenCalled();
			expect(existsSync(phaseFile)).toBe(false);

			rmSync(tmp, { recursive: true, force: true });
		});

		it("removes ingest-phase even when ingest throws", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "jolli-phase-"));
			mkdirSync(join(tmp, ".jolli", "jollimemory"), { recursive: true });
			const phaseFile = join(tmp, ".jolli", "jollimemory", "ingest-phase");

			const { existsSync: realExistsSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
			vi.mocked(existsSync).mockImplementation(realExistsSync);

			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockRejectedValue(new Error("boom"));

			await expect(
				__test__.runIngestEntry(makeIngestOp("post-merge"), tmp, storageWithWiki(true)),
			).rejects.toThrow("boom");

			expect(existsSync(phaseFile)).toBe(false);

			rmSync(tmp, { recursive: true, force: true });
		});

		it("routes an ingest op to drainIngest and renderTopicKBWiki when API key is configured", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 2, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(vi.mocked(drainIngest)).toHaveBeenCalledOnce();
			expect(vi.mocked(renderTopicKBWiki)).toHaveBeenCalledOnce();
			// The knowledge graph is refreshed right after the wiki, on the same gate.
			expect(vi.mocked(buildKnowledgeGraph)).toHaveBeenCalledOnce();
		});

		it("isolates a knowledge-graph build failure (non-fatal: wiki/ingest still succeed)", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 2, outcome: "OK", topicFailures: [] });
			vi.mocked(buildKnowledgeGraph).mockRejectedValueOnce(new Error("graph boom"));

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			// Must not throw despite the graph build rejecting.
			await expect(runWorker("/test/cwd")).resolves.not.toThrow();
			expect(vi.mocked(renderTopicKBWiki)).toHaveBeenCalledOnce();
			expect(vi.mocked(buildKnowledgeGraph)).toHaveBeenCalledOnce();
			// The INNER graph try/catch handled it — proven by the graph-specific WARN
			// firing while the OUTER ingest-phase catch's ERROR does NOT. Without the
			// inner catch the throw would bubble to that outer catch and this would
			// flip, so these two assertions are what make the inner isolation
			// load-bearing rather than redundant with the outer handler.
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Knowledge graph build failed"));
			expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining("Unlocked ingest phase failed"));
		});

		it("releases the entry-level vault-write.lock before running the ingest LLM phase", async () => {
			// A dequeued ingest op must NOT be processed under the worker's entry-level
			// vault-write.lock: the long reconcile phase would otherwise block every
			// later commit-summary worker. The entry lock is released first; ingest's
			// own per-write guard re-acquires it briefly per page.
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			const order: string[] = [];
			const release = vi.fn(async () => {
				order.push("release");
			});
			vi.mocked(acquireVaultWriteLock).mockResolvedValue({
				release,
				refresh: vi.fn().mockResolvedValue(undefined),
			});
			vi.mocked(drainIngest).mockImplementation(async () => {
				order.push("drainIngest");
				return { batches: 1, ingested: 1, outcome: "OK", topicFailures: [] };
			});

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(order).toEqual(["release", "drainIngest"]);
		});

		it("releases worker.lock BEFORE the ingest phase so a concurrent summary worker can run", async () => {
			// The whole point of the ingest.lock split: ingest no longer holds
			// worker.lock. Both entry-level locks (vault, then worker) are released
			// BEFORE the ingest phase runs, so a same-repo summary worker can proceed
			// concurrently. Hence the order: vault-release, worker-release, drainIngest.
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			const order: string[] = [];
			vi.mocked(acquireVaultWriteLock).mockResolvedValue({
				release: vi.fn(async () => {
					order.push("vault-release");
				}),
				refresh: vi.fn().mockResolvedValue(undefined),
			});
			vi.mocked(releaseWorkerLock).mockImplementation(async () => {
				order.push("worker-release");
			});
			vi.mocked(drainIngest).mockImplementation(async () => {
				order.push("drainIngest");
				return { batches: 1, ingested: 1, outcome: "OK", topicFailures: [] };
			});

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			// releaseWorkerLock also runs in the outer finally (idempotent), so assert
			// the first worker-release lands before drainIngest rather than exact equality.
			expect(order.indexOf("vault-release")).toBeLessThan(order.indexOf("worker-release"));
			expect(order.indexOf("worker-release")).toBeLessThan(order.indexOf("drainIngest"));
		});

		it("passes a per-write guard to drainIngest and renderTopicKBWiki so ingest writes self-lock", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 2, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			const drainOpts = vi.mocked(drainIngest).mock.calls[0]?.[2];
			expect(typeof drainOpts?.writeGuard).toBe("function");
			expect(typeof vi.mocked(renderTopicKBWiki).mock.calls[0]?.[2]).toBe("function");
		});

		it("routes each ingest write through orphan-write.lock so ingest orphan-ref writes self-lock", async () => {
			// The ingest writeGuard body is wrapped in `withRequiredOrphanWriteLock`
			// so ingest's orphan-ref writes serialise against summary writes on the
			// same lock. Drive the guard with a sentinel write and assert it flowed
			// through the orphan lock with the "ingest-write" label.
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			let sentinelRan = false;
			vi.mocked(drainIngest).mockImplementation(async (_op, _cwd, opts) => {
				await opts?.writeGuard?.(async () => {
					sentinelRan = true;
				});
				return { batches: 1, ingested: 1, outcome: "OK", topicFailures: [] };
			});

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(sentinelRan).toBe(true);
			expect(vi.mocked(withRequiredOrphanWriteLock)).toHaveBeenCalledWith(
				"/test/cwd",
				"ingest-write",
				expect.any(Function),
			);
		});

		it("nests orphan-write.lock INSIDE vault-write.lock in the ingest writeGuard (vault→orphan order)", async () => {
			// Lock-ordering guarantee: the ingest writeGuard must take vault-write.lock
			// (outer) then orphan-write.lock (inner), matching the summary path's
			// vault→orphan direction so the two never deadlock. Record entry order of
			// both locks plus the actual write.
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			const order: string[] = [];
			vi.mocked(withVaultWriteLock).mockImplementationOnce(
				async (_root: string, _mode: unknown, body: () => Promise<unknown>) => {
					order.push("vault");
					return { ran: true, value: await body() };
				},
			);
			vi.mocked(withRequiredOrphanWriteLock).mockImplementationOnce(
				async (_cwd: string | undefined, label: string, fn: () => Promise<unknown>) => {
					order.push(`orphan:${label}`);
					return fn();
				},
			);
			vi.mocked(drainIngest).mockImplementation(async (_op, _cwd, opts) => {
				await opts?.writeGuard?.(async () => {
					order.push("write");
				});
				return { batches: 1, ingested: 1, outcome: "OK", topicFailures: [] };
			});

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(order).toEqual(["vault", "orphan:ingest-write", "write"]);
		});

		it("records a pending ingest and retries once when ingest.lock is initially lost, then runs", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			// Lose the fail-fast acquire, then win the retry after recording intent.
			vi.mocked(acquireIngestLock).mockResolvedValueOnce(false).mockResolvedValue(true);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 1, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(vi.mocked(recordPendingIngest)).toHaveBeenCalled();
			expect(vi.mocked(drainIngest)).toHaveBeenCalledOnce();
		});

		it("skips the ingest and leaves its entries when ingest.lock stays lost after recording", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(acquireIngestLock).mockResolvedValue(false); // both the fail-fast and the retry miss
			const { deleteQueueEntry } = await import("../core/SessionTracker.js");
			vi.mocked(deleteQueueEntry).mockClear();

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(vi.mocked(recordPendingIngest)).toHaveBeenCalled();
			// Never ran ingest, and the queued ingest entry is left for the holder's wake.
			expect(vi.mocked(drainIngest)).not.toHaveBeenCalled();
			expect(vi.mocked(deleteQueueEntry)).not.toHaveBeenCalled();
		});

		it("releases ingest.lock BEFORE waking a pending ingest (detached spawn needs a free lock)", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			const order: string[] = [];
			vi.mocked(releaseIngestLock).mockImplementation(async () => {
				order.push("release-ingest");
			});
			vi.mocked(wakePendingIngest).mockImplementation(async () => {
				order.push("wake-ingest");
			});
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 1, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(order).toEqual(["release-ingest", "wake-ingest"]);
		});

		it("skips drainIngest when no API key is configured", async () => {
			vi.mocked(loadConfig).mockResolvedValue({} as never);
			const origKey = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;

			const op = makeIngestOp("recall-miss");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(vi.mocked(drainIngest)).not.toHaveBeenCalled();
			expect(vi.mocked(renderTopicKBWiki)).not.toHaveBeenCalled();
			expect(vi.mocked(appendCredentialMissingRun)).toHaveBeenCalledWith("/test/cwd", "recall-miss");

			if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
		});

		it("does not skip drainIngest when aiProvider is local-agent, even with no stored key", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ aiProvider: "local-agent" } as never);
			const origKey2 = process.env.ANTHROPIC_API_KEY;
			delete process.env.ANTHROPIC_API_KEY;
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 1, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("recall-miss");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(vi.mocked(drainIngest)).toHaveBeenCalledOnce();
			expect(vi.mocked(appendCredentialMissingRun)).not.toHaveBeenCalled();

			if (origKey2 !== undefined) process.env.ANTHROPIC_API_KEY = origKey2;
		});

		it("skips renderTopicKBWiki when drainIngest reports 0 ingested", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 0, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("manual");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(vi.mocked(drainIngest)).toHaveBeenCalledOnce();
			expect(vi.mocked(renderTopicKBWiki)).not.toHaveBeenCalled();
			// Graph is gated identically — no wiki render, no graph build.
			expect(vi.mocked(buildKnowledgeGraph)).not.toHaveBeenCalled();
		});

		it("re-renders the wiki when ingested=0 but the visible wiki was deleted", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 0, outcome: "OK", topicFailures: [] });
			vi.mocked(createStorage).mockResolvedValueOnce(storageWithWiki(false));

			const op = makeIngestOp("manual");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(vi.mocked(renderTopicKBWiki)).toHaveBeenCalledOnce();
		});

		it("does NOT re-render when ingested=0 and the visible wiki is already present", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 0, outcome: "OK", topicFailures: [] });
			vi.mocked(createStorage).mockResolvedValueOnce(storageWithWiki(true));

			const op = makeIngestOp("manual");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(vi.mocked(renderTopicKBWiki)).not.toHaveBeenCalled();
		});

		it("does NOT re-trigger a post-commit ingest when only an ingest op was processed (no self-perpetuation)", async () => {
			vi.mocked(loadConfig).mockResolvedValue({ apiKey: "sk-test" } as never);
			vi.mocked(drainIngest).mockResolvedValue({ batches: 1, ingested: 2, outcome: "OK", topicFailures: [] });

			const op = makeIngestOp("post-merge");
			vi.mocked(dequeueAllGitOperations).mockResolvedValue([{ op, filePath: "/tmp/queue/ingest.json" }]);

			await runWorker("/test/cwd");

			expect(vi.mocked(enqueueIngestOperation)).not.toHaveBeenCalled();
		});
	});

	describe("conversationTokens accumulation (B4)", () => {
		it("sums usageTokens from two Claude sessions and writes conversationTokens onto the CommitSummary", async () => {
			// Two Claude sessions whose usage sums to 1425 (425 + 1000).
			// readTranscript is mocked to return usageTokens for each session.
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/tokens-test.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadAllSessions).mockResolvedValue([
				{
					sessionId: "claude-a",
					transcriptPath: "/tmp/claude-a.jsonl",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "claude" as const,
				},
				{
					sessionId: "claude-b",
					transcriptPath: "/tmp/claude-b.jsonl",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "claude" as const,
				},
			]);
			vi.mocked(readTranscript).mockImplementation(async (transcriptPath: string) => {
				const usageTokens = transcriptPath.endsWith("claude-a.jsonl") ? 425 : 1000;
				return {
					entries: [{ role: "human", content: "ctx", timestamp: "2026-04-01T12:00:00.000Z" }],
					newCursor: { transcriptPath, lineNumber: 1, updatedAt: "2026-04-01T12:00:00.000Z" },
					totalLinesRead: 1,
					usageTokens,
				};
			});

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			const [calledSummary] = vi.mocked(storeSummary).mock.calls[0] as [
				{ conversationTokens?: number },
				...unknown[],
			];
			expect(calledSummary.conversationTokens).toBe(1425);
		});

		it("merges per-model usage across sessions and writes conversationModels + estimatedCostUsd", async () => {
			// Both sessions used the same priced model (claude-opus-4-8: $5/1M input).
			// The reconciliation must merge them into one bucket: 1M + 1M input → $10.
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/cost-test.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadAllSessions).mockResolvedValue([
				{
					sessionId: "claude-a",
					transcriptPath: "/tmp/claude-a.jsonl",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "claude" as const,
				},
				{
					sessionId: "claude-b",
					transcriptPath: "/tmp/claude-b.jsonl",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "claude" as const,
				},
			]);
			vi.mocked(readTranscript).mockImplementation(async (transcriptPath: string) => ({
				entries: [{ role: "human", content: "ctx", timestamp: "2026-04-01T12:00:00.000Z" }],
				newCursor: { transcriptPath, lineNumber: 1, updatedAt: "2026-04-01T12:00:00.000Z" },
				totalLinesRead: 1,
				usageTokens: 1_000_000,
				usageBreakdown: { input: 1_000_000, output: 0, cached: 0 },
				usageByModel: [
					{
						model: "claude-opus-4-8",
						provider: "anthropic" as const,
						input: 1_000_000,
						output: 0,
						cached: 0,
					},
				],
			}));

			await runWorker("/test/cwd");

			const [calledSummary] = vi.mocked(storeSummary).mock.calls[0] as [
				{
					conversationModels?: Array<{ model: string; input: number }>;
					estimatedCostUsd?: number;
					pricesAsOf?: string;
				},
				...unknown[],
			];
			expect(calledSummary.conversationModels).toEqual([
				{ model: "claude-opus-4-8", provider: "anthropic", input: 2_000_000, output: 0, cached: 0 },
			]);
			// 2M input tokens × $5/1M = $10.
			expect(calledSummary.estimatedCostUsd).toBeCloseTo(10, 6);
			expect(calledSummary.pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		it("stores conversationModels but omits estimatedCostUsd for an unpriced model", async () => {
			// A model absent from the price table keeps its tokens/models recorded but
			// yields no cost — the reader shows "unknown", not a misleading $0.00.
			const op = makeCommitOp();
			const queueEntry = { op, filePath: "/tmp/queue/unpriced-test.json" };

			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([queueEntry])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);

			setupPipelineMocks();
			vi.mocked(loadAllSessions).mockResolvedValue([
				{
					sessionId: "claude-x",
					transcriptPath: "/tmp/claude-x.jsonl",
					updatedAt: "2026-04-01T12:00:00.000Z",
					source: "claude" as const,
				},
			]);
			vi.mocked(readTranscript).mockImplementation(async (transcriptPath: string) => ({
				entries: [{ role: "human", content: "ctx", timestamp: "2026-04-01T12:00:00.000Z" }],
				newCursor: { transcriptPath, lineNumber: 1, updatedAt: "2026-04-01T12:00:00.000Z" },
				totalLinesRead: 1,
				usageTokens: 500,
				usageBreakdown: { input: 500, output: 0, cached: 0 },
				usageByModel: [
					{ model: "mystery-model", provider: "unknown" as const, input: 500, output: 0, cached: 0 },
				],
			}));

			await runWorker("/test/cwd");

			const [calledSummary] = vi.mocked(storeSummary).mock.calls[0] as [
				{ conversationModels?: unknown[]; estimatedCostUsd?: number; pricesAsOf?: string },
				...unknown[],
			];
			expect(calledSummary.conversationModels).toHaveLength(1);
			expect(calledSummary.estimatedCostUsd).toBeUndefined();
			expect(calledSummary.pricesAsOf).toBeUndefined();
		});
	});

	// ─── C5: usage tokens counted even when a slice yields 0 merged entries ──────
	describe("conversationTokens — usage counted regardless of merged-entry count (C5)", () => {
		it("accumulates usageTokens from a slice that produced zero merged entries", async () => {
			const cwd = mkdtempSync(join(tmpdir(), "jolli-c5-"));
			try {
				vi.mocked(loadAllSessions).mockResolvedValue([
					{
						sessionId: "claude-empty",
						transcriptPath: "/tmp/claude-empty.jsonl",
						updatedAt: "2026-04-01T12:00:00.000Z",
						source: "claude" as const,
					},
				]);
				vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
				vi.mocked(saveCursor).mockResolvedValue(undefined);
				// Slice has real token usage (assistant turns carried a usage block) but
				// every parsed entry was dropped/merged away → 0 merged entries. Pre-fix,
				// the `if (entries.length > 0)` gate dropped these tokens entirely.
				vi.mocked(readTranscript).mockResolvedValue({
					entries: [],
					newCursor: {
						transcriptPath: "/tmp/claude-empty.jsonl",
						lineNumber: 3,
						updatedAt: "2026-04-01T12:00:00.000Z",
					},
					totalLinesRead: 3,
					usageTokens: 777,
				});

				const result = await __test__.loadSessionTranscripts(cwd, {});

				expect(result.totalEntries).toBe(0);
				expect(result.sessionTranscripts).toHaveLength(0);
				expect(result.conversationTokens).toBe(777);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	// ─── C1: conversationTokens reconciled against overlay-applied entry set ─────
	// The overlay is driven through the module-level `node:fs/promises.readFile`
	// mock (declared at the top of this file). loadOverlay reads the overlay JSON
	// via readFile, so returning a real overlay payload for the overlay path (and
	// "" elsewhere) exercises the genuine applyOverlaysToSessions delete path
	// without needing an un-mocked filesystem.
	describe("conversationTokens — overlay delete reconciliation (C1)", () => {
		it("zeros conversationTokens when an overlay removed entries from the slice", async () => {
			const cwd = mkdtempSync(join(tmpdir(), "jolli-c1-"));
			const { readFile } = await import("node:fs/promises");
			try {
				const { overlayPath } = await import("../core/ConversationOverlayStore.js");
				vi.mocked(loadAllSessions).mockResolvedValue([
					{
						sessionId: "claude-c1",
						transcriptPath: "/tmp/claude-c1.jsonl",
						updatedAt: "2026-04-01T12:00:00.000Z",
						source: "claude" as const,
					},
				]);
				vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
				vi.mocked(saveCursor).mockResolvedValue(undefined);
				// Two entries read with 500 tokens of usage. The overlay deletes one.
				vi.mocked(readTranscript).mockResolvedValue({
					entries: [
						{ role: "human", content: "keep me", timestamp: "2026-04-01T12:00:00.000Z" },
						{ role: "human", content: "delete me", timestamp: "2026-04-01T12:00:01.000Z" },
					],
					newCursor: {
						transcriptPath: "/tmp/claude-c1.jsonl",
						lineNumber: 2,
						updatedAt: "2026-04-01T12:00:00.000Z",
					},
					totalLinesRead: 2,
					usageTokens: 500,
				});
				const op = overlayPath({ projectDir: cwd, source: "claude", sessionId: "claude-c1" });
				const overlayJson = JSON.stringify({
					version: 2,
					source: "claude",
					sessionId: "claude-c1",
					updatedAt: "2026-04-01T12:00:00.000Z",
					deletes: [{ role: "human", content: "delete me", timestamp: "2026-04-01T12:00:01.000Z" }],
					edits: [],
				});
				vi.mocked(readFile).mockImplementation(async (p: unknown) => (String(p) === op ? overlayJson : ""));

				const result = await __test__.loadSessionTranscripts(cwd, {});

				// Overlay removed one entry; per-line token attribution to the surviving
				// entry set does not exist, so the raw 500 is no longer meaningful → 0.
				expect(result.totalEntries).toBe(1);
				expect(result.conversationTokens).toBe(0);
			} finally {
				vi.mocked(readFile).mockResolvedValue(""); // restore the file-level default
				rmSync(cwd, { recursive: true, force: true });
			}
		});

		it("zeros only the session whose entries an overlay removed, keeping other sessions' tokens", async () => {
			// Per-session isolation: a delete in session A must not wipe session B's
			// real token count. Pre-fix, the removal was detected at the aggregate
			// level (totalEntries < preOverlayEntries), so a single deleted turn in
			// ANY session zeroed conversationTokens for the whole commit.
			const cwd = mkdtempSync(join(tmpdir(), "jolli-c1multi-"));
			const { readFile } = await import("node:fs/promises");
			try {
				const { overlayPath } = await import("../core/ConversationOverlayStore.js");
				vi.mocked(loadAllSessions).mockResolvedValue([
					{
						sessionId: "claude-a",
						transcriptPath: "/tmp/claude-a.jsonl",
						updatedAt: "2026-04-01T12:00:00.000Z",
						source: "claude" as const,
					},
					{
						sessionId: "claude-b",
						transcriptPath: "/tmp/claude-b.jsonl",
						updatedAt: "2026-04-01T12:00:00.000Z",
						source: "claude" as const,
					},
				]);
				vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
				vi.mocked(saveCursor).mockResolvedValue(undefined);
				// Session A: two entries, 500 tokens — the overlay deletes one of them.
				// Session B: one untouched entry, 900 tokens — must survive intact.
				vi.mocked(readTranscript).mockImplementation(async (transcriptPath: string) => {
					if (transcriptPath === "/tmp/claude-a.jsonl") {
						return {
							entries: [
								{ role: "human", content: "keep me", timestamp: "2026-04-01T12:00:00.000Z" },
								{ role: "human", content: "delete me", timestamp: "2026-04-01T12:00:01.000Z" },
							],
							newCursor: { transcriptPath, lineNumber: 2, updatedAt: "2026-04-01T12:00:00.000Z" },
							totalLinesRead: 2,
							usageTokens: 500,
						};
					}
					return {
						entries: [{ role: "human", content: "b untouched", timestamp: "2026-04-01T12:00:00.000Z" }],
						newCursor: { transcriptPath, lineNumber: 1, updatedAt: "2026-04-01T12:00:00.000Z" },
						totalLinesRead: 1,
						usageTokens: 900,
					};
				});
				const opA = overlayPath({ projectDir: cwd, source: "claude", sessionId: "claude-a" });
				const overlayJson = JSON.stringify({
					version: 2,
					source: "claude",
					sessionId: "claude-a",
					updatedAt: "2026-04-01T12:00:00.000Z",
					deletes: [{ role: "human", content: "delete me", timestamp: "2026-04-01T12:00:01.000Z" }],
					edits: [],
				});
				vi.mocked(readFile).mockImplementation(async (p: unknown) => (String(p) === opA ? overlayJson : ""));

				const result = await __test__.loadSessionTranscripts(cwd, {});

				// A (removed) is zeroed; B (untouched) keeps its 900 → total 900, not 0.
				expect(result.totalEntries).toBe(2);
				expect(result.conversationTokens).toBe(900);
			} finally {
				vi.mocked(readTranscript).mockReset();
				vi.mocked(readFile).mockResolvedValue("");
				rmSync(cwd, { recursive: true, force: true });
			}
		});

		it("keeps the raw token sum when no overlay altered the entry set", async () => {
			const cwd = mkdtempSync(join(tmpdir(), "jolli-c1b-"));
			const { readFile } = await import("node:fs/promises");
			try {
				vi.mocked(readFile).mockResolvedValue(""); // no overlay file → pass-through
				vi.mocked(loadAllSessions).mockResolvedValue([
					{
						sessionId: "claude-c1b",
						transcriptPath: "/tmp/claude-c1b.jsonl",
						updatedAt: "2026-04-01T12:00:00.000Z",
						source: "claude" as const,
					},
				]);
				vi.mocked(loadCursorForTranscript).mockResolvedValue(null);
				vi.mocked(saveCursor).mockResolvedValue(undefined);
				vi.mocked(readTranscript).mockResolvedValue({
					entries: [{ role: "human", content: "no overlay here", timestamp: "2026-04-01T12:00:00.000Z" }],
					newCursor: {
						transcriptPath: "/tmp/claude-c1b.jsonl",
						lineNumber: 1,
						updatedAt: "2026-04-01T12:00:00.000Z",
					},
					totalLinesRead: 1,
					usageTokens: 321,
				});

				const result = await __test__.loadSessionTranscripts(cwd, {});

				expect(result.totalEntries).toBe(1);
				expect(result.conversationTokens).toBe(321);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	// ─── amend Context consumption: new-wins ref union, audit filter, plan soft-exclude, fresh-leaf refs ───
	describe("amend workspace-Context consumption", () => {
		const bySlug = (r: { slug: string }) => r.slug;

		describe("mergeRefsNewWins", () => {
			it("returns [] for empty / undefined inputs", () => {
				expect(__test__.mergeRefsNewWins(undefined, undefined, bySlug)).toEqual([]);
				expect(__test__.mergeRefsNewWins([], [], bySlug)).toEqual([]);
			});

			it("keeps old refs when there are no new refs", () => {
				const old = [{ slug: "a" }, { slug: "b" }];
				expect(__test__.mergeRefsNewWins(old, undefined, bySlug)).toEqual(old);
			});

			it("unions non-colliding new refs after the old ones", () => {
				const merged = __test__.mergeRefsNewWins([{ slug: "a" }], [{ slug: "b" }], bySlug);
				expect(merged.map(bySlug)).toEqual(["a", "b"]);
			});

			it("new ref wins on base-key collision (drops the stale old snapshot)", () => {
				const merged = __test__.mergeRefsNewWins(
					[{ slug: "a", tag: "old" }],
					[{ slug: "a", tag: "new" }],
					bySlug,
				);
				expect(merged).toEqual([{ slug: "a", tag: "new" }]);
			});
		});

		describe("buildHoistedAmendRoot ref merge + audit", () => {
			const newInfo: CommitInfo = {
				hash: "new67890abcdef12",
				message: "Amended commit",
				author: "Jane",
				date: "2026-04-02T10:00:00.000Z",
			};
			const hoisted = {
				topics: [{ title: "T", trigger: "x", response: "y", decisions: "z" }],
				transcripts: [] as string[],
			};
			const fullDiffStats = { filesChanged: 1, insertions: 2, deletions: 1 };
			const refABCold: ReferenceCommitRef = {
				archivedKey: "linear:ABC-old12345",
				source: "linear",
				nativeId: "ABC",
				title: "Issue ABC",
				url: "https://linear.app/x/ABC",
				referencedAt: "2026-04-01T00:00:00Z",
				sourceToolName: "mcp__linear__get_issue",
			};

			function makeOld(over: Partial<CommitSummary> = {}): CommitSummary {
				return {
					version: 5,
					commitHash: "old12345",
					commitMessage: "Old",
					commitAuthor: "Jane",
					commitDate: "2026-04-01T10:00:00.000Z",
					branch: "feature/test",
					generatedAt: "2026-04-01T10:00:00.000Z",
					topics: [{ title: "Old", trigger: "t", response: "r", decisions: "d" }],
					transcripts: [],
					...over,
				} as CommitSummary;
			}

			it("hoists old references into the merged root (references truthy arm)", () => {
				const root = __test__.buildHoistedAmendRoot(
					makeOld({ references: [refABCold] }),
					newInfo,
					hoisted,
					{},
					fullDiffStats,
				);
				expect(root.references?.map((r) => `${r.source}:${r.nativeId}`)).toEqual(["linear:ABC"]);
			});

			it("unions old + new references with new winning on collision", () => {
				const refABCnew: ReferenceCommitRef = { ...refABCold, archivedKey: "linear:ABC-new67890" };
				const refXYZnew: ReferenceCommitRef = {
					...refABCold,
					archivedKey: "linear:XYZ-new67890",
					nativeId: "XYZ",
				};
				const root = __test__.buildHoistedAmendRoot(
					makeOld({ references: [refABCold] }),
					newInfo,
					hoisted,
					{},
					fullDiffStats,
					undefined,
					{ references: [refABCnew, refXYZnew] },
				);
				expect(root.references?.map((r) => `${r.source}:${r.nativeId}`)).toEqual(["linear:ABC", "linear:XYZ"]);
				// new wins: the ABC ref carries the NEW archivedKey, not the old snapshot.
				expect(root.references?.find((r) => r.nativeId === "ABC")?.archivedKey).toBe("linear:ABC-new67890");
			});

			it("merges new plans with new winning on slug base-key collision", () => {
				// Both slugs share base "foo" after the `-<8 hex>` suffix strip → collision.
				const planOld: PlanReference = { slug: "foo-0abc1234", title: "Foo", addedAt: "a", updatedAt: "a" };
				const planNew: PlanReference = { slug: "foo-9def5678", title: "Foo", addedAt: "a", updatedAt: "b" };
				const root = __test__.buildHoistedAmendRoot(
					makeOld({ plans: [planOld] }),
					newInfo,
					hoisted,
					{},
					fullDiffStats,
					undefined,
					{ plans: [planNew] },
				);
				expect(root.plans?.map((p) => p.slug)).toEqual(["foo-9def5678"]);
			});

			it("writes the excludedContext audit when the soft-excluded item is NOT attached", () => {
				const excluded: ExcludedContextItem[] = [
					{ kind: "note", key: "n-unrelated", title: "N", reason: "unrelated", tier: "low" },
				];
				const root = __test__.buildHoistedAmendRoot(
					makeOld(),
					newInfo,
					hoisted,
					{},
					fullDiffStats,
					undefined,
					undefined,
					excluded,
				);
				expect(root.excludedContext).toEqual(excluded);
			});

			it("drops a soft-excluded item from the audit when it is attached via a hoisted ref", () => {
				// Re-referenced linear:ABC: committed earlier (hoisted), then soft-excluded now.
				// It must appear in references (attached) but NOT also in excludedContext.
				const excluded: ExcludedContextItem[] = [
					{ kind: "reference", key: "linear:ABC", title: "Issue ABC", reason: "unrelated", tier: "low" },
				];
				const root = __test__.buildHoistedAmendRoot(
					makeOld({ references: [refABCold] }),
					newInfo,
					hoisted,
					{},
					fullDiffStats,
					undefined,
					undefined,
					excluded,
				);
				expect(root.references?.map((r) => `${r.source}:${r.nativeId}`)).toEqual(["linear:ABC"]);
				expect(root.excludedContext).toBeUndefined();
			});
		});

		it("consumeWorkspaceContext skips an AI soft-excluded plan from association", async () => {
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {
					foo: {
						slug: "foo",
						title: "Foo",
						sourcePath: "/x/foo.md",
						addedAt: "2026-04-01T00:00:00Z",
						updatedAt: "2026-04-01T00:00:00Z",
						commitHash: null,
					},
				},
			} as Awaited<ReturnType<typeof loadPlansRegistry>>);

			const result = await __test__.consumeWorkspaceContext({
				cwd: "/test/cwd",
				branch: "feature/test",
				commitHash: "new67890abcdef12",
				exclusions: { plans: new Set(), notes: new Set(), references: new Set() },
				excludedContext: [{ kind: "plan", key: "foo", title: "Foo", reason: "unrelated", tier: "low" }],
			});

			// foo was detected (commitHash null) but soft-excluded → dropped before associate.
			expect(result.planAssociation.refs).toEqual([]);
		});

		it("amend fresh-leaf attaches an active reference to the summary (references spread)", async () => {
			const op = makeCommitOp({
				type: "amend",
				commitHash: "abc12345def67890",
				branch: "feature/x",
				sourceHashes: ["0123456789abcdef0123456789abcdef01234567"],
			});
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");
			vi.mocked(getCurrentBranch).mockResolvedValue("feature/x");
			// Non-trivial delta + no old summary → fresh-leaf path.
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 60, deletions: 1 });
			vi.mocked(detectUncommittedReferenceIds).mockResolvedValue([
				{ mapKey: "linear:PROJ-1", source: "linear", sourcePath: "/ref.md" },
			]);
			vi.mocked(loadPlansRegistry).mockResolvedValue({
				version: 1,
				plans: {},
				references: {
					"linear:PROJ-1": {
						source: "linear",
						nativeId: "PROJ-1",
						title: "Proj one",
						url: "https://linear.app/x/PROJ-1",
						sourcePath: "/ref.md",
						addedAt: "2026-04-01T00:00:00Z",
						updatedAt: "2026-04-01T00:00:00Z",
						sourceToolName: "mcp__linear__get_issue",
					},
				},
			});
			const { readReferenceMarkdown } = await import("../core/references/ReferenceStore.js");
			vi.mocked(readReferenceMarkdown).mockResolvedValue({
				mapKey: "linear:PROJ-1",
				source: "linear",
				nativeId: "PROJ-1",
				title: "Proj one",
				url: "https://linear.app/x/PROJ-1",
				toolName: "mcp__linear__get_issue",
				referencedAt: "2026-05-14T06:06:01.123Z",
			});
			const { readFile } = await import("node:fs/promises");
			(readFile as unknown as { mockResolvedValue: (v: string) => void }).mockResolvedValue("file content");

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			const saved = vi.mocked(storeSummary).mock.calls[0][0];
			expect(saved.references?.[0].archivedKey).toBe("linear:PROJ-1-abc12345");
		});

		it("clears the AI selection layer once, up front, on an amend", async () => {
			// A `git commit --amend` moves HEAD → the panel's cached fingerprint is
			// stale, so every amend path invalidates it (mirrors the normal pipeline's
			// pre-LLM clear). Verified here via the fresh-leaf path.
			const op = makeCommitOp({
				type: "amend",
				commitHash: "abc12345def67890",
				branch: "feature/x",
				sourceHashes: ["0123456789abcdef0123456789abcdef01234567"],
			});
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks("abc12345def67890");
			vi.mocked(getCurrentBranch).mockResolvedValue("feature/x");
			vi.mocked(getDiffStats).mockResolvedValue({ filesChanged: 1, insertions: 60, deletions: 1 });
			vi.mocked(clearAiSelection).mockClear();

			await runWorker("/test/cwd");

			expect(clearAiSelection).toHaveBeenCalledWith("/test/cwd");
		});

		it("amend pre-LLM short-circuit inherits a v5 oldSummary's transcripts into the hoisted root", async () => {
			// Exercises the whole short-circuit consume+hoist path end-to-end with a real
			// oldSummary, and covers the `oldSummary.transcripts !== undefined` (v5) arm.
			const { getSummary } = await import("../core/SummaryStore.js");
			vi.mocked(getSummary).mockResolvedValue({
				version: 5,
				commitHash: "old12345",
				commitMessage: "Old",
				commitAuthor: "Jane",
				commitDate: "2026-04-01T10:00:00.000Z",
				branch: "feature/x",
				generatedAt: "2026-04-01T10:00:00.000Z",
				topics: [{ title: "Old", trigger: "t", response: "r", decisions: "d" }],
				transcripts: ["t-existing"],
			} as Awaited<ReturnType<typeof getSummary>>);
			const op = makeCommitOp({
				type: "amend",
				commitHash: "abc12345def67890",
				branch: "feature/x",
				sourceHashes: ["0123456789abcdef0123456789abcdef01234567"],
			});
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			// setupPipelineMocks' default diff (7 lines) is ≤ TRIVIAL_AMEND_DELTA_LINES → pre-LLM short-circuit.
			setupPipelineMocks("abc12345def67890");
			vi.mocked(getCurrentBranch).mockResolvedValue("feature/x");

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(vi.mocked(storeSummary).mock.calls[0][0].transcripts).toContain("t-existing");
		});

		it("normal commit writes the excludedContext audit onto the summary", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			vi.mocked(assessContextRelevance).mockResolvedValueOnce({
				plans: [],
				notes: [],
				references: [],
				excludedContext: [{ kind: "note", key: "n-x", title: "N", reason: "unrelated", tier: "low" }],
				results: [],
			});

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(vi.mocked(storeSummary).mock.calls[0][0].excludedContext).toEqual([
				{ kind: "note", key: "n-x", title: "N", reason: "unrelated", tier: "low" },
			]);
		});

		it("normal commit writes contextRelevance (kept items' tier+reason) onto the summary", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			vi.mocked(assessContextRelevance).mockResolvedValueOnce({
				plans: [],
				notes: [],
				references: [],
				excludedContext: [],
				results: [
					{
						id: "p-kept",
						kind: "plan",
						relevant: true,
						score: 0.9,
						tier: "high",
						reason: "plan covers the change",
						rank: 1,
						autoExclude: false,
					},
					{
						id: "n-dropped",
						kind: "note",
						relevant: false,
						score: 0.1,
						tier: "low",
						reason: "unrelated",
						rank: 2,
						autoExclude: true,
					},
				],
			});

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			// Only the KEPT item's verdict lands on contextRelevance (excluded ones
			// live on excludedContext instead).
			expect(vi.mocked(storeSummary).mock.calls[0][0].contextRelevance).toEqual([
				{ kind: "plan", key: "p-kept", tier: "high", reason: "plan covers the change" },
			]);
		});

		it("fingerprint reuse writes contextRelevance from the persisted aiRelevanceResults (no LLM)", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			const signal = { commitMessage: "", changedFiles: ["src/file.ts"], symbols: [] as string[] };
			vi.mocked(buildChangeSignal).mockResolvedValueOnce(signal);
			// Matching fingerprint → the reuse arm runs (no LLM). This suite's
			// default mocks detect no plans/notes/refs, so the meaningful assertion
			// is the legacy-file shape: empty persisted results must yield NO
			// contextRelevance field (not an empty array).
			vi.mocked(readAiSelection).mockResolvedValueOnce({
				aiRelevance: [],
				changeFingerprint: computeChangeFingerprint(signal),
			});
			vi.mocked(assessContextRelevance).mockClear();

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(assessContextRelevance).not.toHaveBeenCalled();
			// Empty persisted results (legacy selection file) → no contextRelevance
			// on the summary rather than a bogus empty array.
			expect(vi.mocked(storeSummary).mock.calls[0][0].contextRelevance).toBeUndefined();
		});

		it("fingerprint reuse threads a persisted kept-item verdict onto summary.contextRelevance", async () => {
			const op = makeCommitOp();
			vi.mocked(dequeueAllGitOperations)
				.mockResolvedValueOnce([{ op, filePath: "/tmp/queue/entry.json" }])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([]);
			setupPipelineMocks();
			// One detected working note; the panel's persisted layer carries its verdict.
			vi.mocked(detectActiveNotesForBranch).mockResolvedValue([
				{
					id: "n-kept",
					title: "Kept",
					format: "snippet",
					sourcePath: "/x/kept.md",
					addedAt: "2026-04-01T00:00:00Z",
					updatedAt: "2026-04-01T00:00:00Z",
					commitHash: null,
				} as never,
			]);
			const signal = { commitMessage: "", changedFiles: ["src/file.ts"], symbols: [] as string[] };
			vi.mocked(buildChangeSignal).mockResolvedValueOnce(signal);
			vi.mocked(readAiSelection).mockResolvedValueOnce({
				aiRelevance: [
					{ kind: "notes", key: "n-kept", tier: "high", reason: "note covers the change", excluded: false },
				],
				changeFingerprint: computeChangeFingerprint(signal),
			});
			vi.mocked(assessContextRelevance).mockClear();

			await runWorker("/test/cwd");

			expect(storeSummary).toHaveBeenCalledTimes(1);
			expect(assessContextRelevance).not.toHaveBeenCalled();
			// The panel's persisted verdict rides through buildDecisionFromAiExcluded
			// onto the artifact — the reuse path's whole point.
			expect(vi.mocked(storeSummary).mock.calls[0][0].contextRelevance).toEqual([
				{ kind: "note", key: "n-kept", tier: "high", reason: "note covers the change" },
			]);
		});

		it("finalizeReferenceArchive returns early when nothing was committed", async () => {
			vi.mocked(loadPlansRegistry).mockClear();
			await __test__.finalizeReferenceArchive([], "/test/cwd");
			// Early return before the registry read — no lock/registry work for an empty set.
			expect(loadPlansRegistry).not.toHaveBeenCalled();
		});
	});
});
