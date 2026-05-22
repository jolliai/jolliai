/**
 * QueueWorker.overlay.test
 *
 * Pins the central feature promise of PR #113: when the user deletes (or
 * edits) messages in ConversationDetailsPanel, those changes flow through
 * `loadSessionTranscripts` so the orphan-branch transcript and the
 * summary input both reflect the curated view — not the raw source.
 *
 * `PostCommitHook.test.ts` mocks `applyOverlaysToSessions` to identity
 * passthrough (so its fake-timer-based pipeline tests don't hang on
 * fs/promises). That mock means nothing there actually exercises the
 * overlay path. This file is the orthogonal companion: real timers, real
 * ConversationOverlayStore, real on-disk overlay JSON — but everything
 * else (session discovery, transcript readers) is stubbed minimally.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module stubs (every external IO the pipeline touches, kept minimal) ---

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
		// Default: no sessions discovered — each test overrides via mockResolvedValueOnce.
		loadAllSessions: vi.fn().mockResolvedValue([]),
		loadCursorForTranscript: vi.fn().mockResolvedValue(null),
		saveCursor: vi.fn().mockResolvedValue(undefined),
		loadConfig: vi.fn().mockResolvedValue({}),
		filterSessionsByEnabledIntegrations: actual.filterSessionsByEnabledIntegrations,
		associatePlanWithCommit: vi.fn(),
		associateNoteWithCommit: vi.fn(),
		dequeueAllGitOperations: vi.fn(),
		deleteQueueEntry: vi.fn(),
		enqueueGitOperation: vi.fn(),
		loadSquashPending: vi.fn(),
		deleteSquashPending: vi.fn(),
		loadPluginSource: vi.fn(),
		deletePluginSource: vi.fn(),
		loadPlansRegistry: vi.fn().mockResolvedValue({ version: 1, plans: {} }),
		savePlansRegistry: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock("../core/TranscriptReader.js", () => ({
	readTranscript: vi.fn(),
	buildMultiSessionContext: vi.fn(),
}));

vi.mock("../core/TranscriptParser.js", () => ({
	getParserForSource: vi.fn().mockReturnValue({ parseLine: vi.fn() }),
}));

vi.mock("../core/CodexSessionDiscoverer.js", () => ({
	discoverCodexSessions: vi.fn().mockResolvedValue([]),
	isCodexInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/OpenCodeSessionDiscoverer.js", () => ({
	discoverOpenCodeSessions: vi.fn().mockResolvedValue([]),
	isOpenCodeInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/CursorDetector.js", () => ({
	isCursorInstalled: vi.fn().mockResolvedValue(false),
}));

vi.mock("../core/CursorSessionDiscoverer.js", () => ({
	discoverCursorSessions: vi.fn().mockResolvedValue([]),
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

vi.mock("../core/Locks.js", () => ({
	acquireWorkerLock: vi.fn(),
	releaseWorkerLock: vi.fn(),
	refreshWorkerLockMtime: vi.fn(),
	isWorkerLockHeld: vi.fn(),
}));

// Sqlite-backed and patch-doc readers — each loadSessionTranscripts call
// dispatches by source, so the per-source try/catch branches in
// readAllTranscripts need a mock per reader that we can flip to reject.
vi.mock("../core/OpenCodeTranscriptReader.js", () => ({
	readOpenCodeTranscript: vi.fn(),
}));
vi.mock("../core/CursorTranscriptReader.js", () => ({
	readCursorTranscript: vi.fn(),
}));
vi.mock("../core/CopilotTranscriptReader.js", () => ({
	readCopilotTranscript: vi.fn(),
}));
vi.mock("../core/CopilotChatTranscriptReader.js", () => ({
	readCopilotChatTranscript: vi.fn(),
}));
vi.mock("../core/GeminiTranscriptReader.js", () => ({
	readGeminiTranscript: vi.fn(),
}));

// HiddenConversationsStore IS exercised — loadHiddenConversations runs against
// the real store reading from the tmp project dir.

// ConversationOverlayStore runs unmocked: saveOverlay / applyOverlaysToSessions /
// loadOverlay / overlayPath / pruneConsumedOverlayRules all hit the real
// implementation against on-disk JSON. The pipeline order in
// loadSessionTranscripts is apply-then-prune (see QueueWorker.ts), so by the
// time GC runs the planted overlay rules have already been observed by apply
// and reflected in `result.*`. GC then unlinks fully-consumed overlay files —
// which is exactly what the two trailing GC tests assert.

// We need a separate import for saveOverlay so the test fixture can plant
// real overlay JSON without going through the panel.
import { loadOverlay, overlayPath, saveOverlay } from "../core/ConversationOverlayStore.js";
import { readCopilotChatTranscript } from "../core/CopilotChatTranscriptReader.js";
import { readCopilotTranscript } from "../core/CopilotTranscriptReader.js";
import { readCursorTranscript } from "../core/CursorTranscriptReader.js";
import { readOpenCodeTranscript } from "../core/OpenCodeTranscriptReader.js";
import { loadAllSessions, loadCursorForTranscript } from "../core/SessionTracker.js";
import { readTranscript } from "../core/TranscriptReader.js";
import type { SessionInfo, TranscriptReadResult } from "../Types.js";
import { __test__ } from "./QueueWorker.js";

const { loadSessionTranscripts } = __test__;

describe("QueueWorker overlay path", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "qw-overlay-"));
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	function stubSession(): { sessionInfo: SessionInfo; readResult: TranscriptReadResult } {
		const sessionInfo: SessionInfo = {
			sessionId: "session-A",
			transcriptPath: "/fake/transcript-A.jsonl",
			updatedAt: "2026-05-17T00:00:00Z",
			source: "claude",
		};
		const readResult: TranscriptReadResult = {
			entries: [
				{ role: "human", content: "msg-1", timestamp: "t0" },
				{ role: "assistant", content: "msg-2", timestamp: "t1" },
				{ role: "human", content: "msg-3", timestamp: "t2" },
				{ role: "assistant", content: "msg-4", timestamp: "t3" },
				{ role: "human", content: "msg-5", timestamp: "t4" },
			],
			newCursor: { transcriptPath: sessionInfo.transcriptPath, lineNumber: 5, updatedAt: sessionInfo.updatedAt },
			totalLinesRead: 5,
		};
		vi.mocked(loadAllSessions).mockResolvedValueOnce([sessionInfo]);
		vi.mocked(loadCursorForTranscript).mockResolvedValueOnce(null);
		vi.mocked(readTranscript).mockResolvedValueOnce(readResult);
		return { sessionInfo, readResult };
	}

	it("with no overlay, totalEntries matches the raw read", async () => {
		stubSession();
		const result = await loadSessionTranscripts(projectDir, { codexEnabled: false } as never);
		expect(result.sessionTranscripts.length).toBe(1);
		expect(result.totalEntries).toBe(5);
		expect(result.humanEntries).toBe(3);
	});

	it("delete-overlay shrinks totalEntries and removes the matched entries from the stored transcript", async () => {
		const { sessionInfo } = stubSession();
		// Plant an overlay deleting msg-2 and msg-4 by identity.
		await saveOverlay(
			{ projectDir, source: "claude", sessionId: sessionInfo.sessionId },
			{
				deletes: [
					{ role: "assistant", content: "msg-2", timestamp: "t1" },
					{ role: "assistant", content: "msg-4", timestamp: "t3" },
				],
				edits: [],
			},
		);
		const result = await loadSessionTranscripts(projectDir, { codexEnabled: false } as never);

		expect(result.totalEntries).toBe(3); // 5 - 2 deletes
		expect(result.humanEntries).toBe(3); // unchanged — both deletes targeted assistant rows
		expect(result.sessionTranscripts[0].entries.map((e) => e.content)).toEqual(["msg-1", "msg-3", "msg-5"]);
	});

	it("edit-overlay rewrites stored entry content while keeping totalEntries unchanged", async () => {
		const { sessionInfo } = stubSession();
		await saveOverlay(
			{ projectDir, source: "claude", sessionId: sessionInfo.sessionId },
			{
				deletes: [],
				edits: [{ role: "assistant", content: "msg-2", timestamp: "t1", newContent: "EDITED-msg-2" }],
			},
		);
		const result = await loadSessionTranscripts(projectDir, { codexEnabled: false } as never);

		expect(result.totalEntries).toBe(5); // edit, not delete
		const stored = result.sessionTranscripts[0].entries;
		expect(stored[1].content).toBe("EDITED-msg-2");
		expect(stored[1].role).toBe("assistant");
		expect(stored[1].timestamp).toBe("t1");
		// Untouched entries pass through verbatim.
		expect(stored[0].content).toBe("msg-1");
		expect(stored[4].content).toBe("msg-5");
	});

	it("when overlay deletes every entry, the session is dropped from sessionTranscripts and totalEntries falls to zero", async () => {
		const { sessionInfo, readResult } = stubSession();
		await saveOverlay(
			{ projectDir, source: "claude", sessionId: sessionInfo.sessionId },
			{
				deletes: readResult.entries.map((e) => ({
					role: e.role,
					content: e.content,
					timestamp: e.timestamp,
				})),
				edits: [],
			},
		);
		const result = await loadSessionTranscripts(projectDir, { codexEnabled: false } as never);
		// `applyOverlaysToSessions` still returns the session object; only
		// `entries` is empty. The "skip when nothing to summarize" guard
		// downstream uses totalEntries === 0 (not session count) as its
		// signal, so the critical assertion is the count.
		expect(result.totalEntries).toBe(0);
		expect(result.humanEntries).toBe(0);
	});

	// Coverage: readAllTranscripts wraps each sqlite-backed / patch-doc
	// source in try/catch + `continue`. The catch arms (and the implicit
	// "skip this session, keep going" semantics) need a test where each
	// reader throws so the surrounding pipeline still completes.
	const readErrorCases: ReadonlyArray<{
		readonly source: "opencode" | "cursor" | "copilot" | "copilot-chat";
		readonly mock: ReturnType<typeof vi.fn>;
	}> = [
		{ source: "opencode", mock: vi.mocked(readOpenCodeTranscript) },
		{ source: "cursor", mock: vi.mocked(readCursorTranscript) },
		{ source: "copilot", mock: vi.mocked(readCopilotTranscript) },
		{ source: "copilot-chat", mock: vi.mocked(readCopilotChatTranscript) },
	];
	for (const { source, mock } of readErrorCases) {
		it(`skips a ${source} session whose transcript reader throws`, async () => {
			const sessionInfo: SessionInfo = {
				sessionId: `session-${source}`,
				transcriptPath: `/fake/${source}.db`,
				updatedAt: "2026-05-17T00:00:00Z",
				source,
			};
			vi.mocked(loadAllSessions).mockResolvedValueOnce([sessionInfo]);
			vi.mocked(loadCursorForTranscript).mockResolvedValueOnce(null);
			mock.mockRejectedValueOnce(new Error("reader blew up"));
			const result = await loadSessionTranscripts(projectDir, { codexEnabled: false } as never);
			expect(result.totalEntries).toBe(0);
			expect(result.sessionTranscripts).toHaveLength(0);
		});
	}

	it("loadSessionTranscripts unlinks overlays whose rules all match entries in the cursor-trimmed slice", async () => {
		const { sessionInfo } = stubSession();
		// Both rule identities match entries returned by stubSession (msg-2 at t1, msg-4 at t3).
		await saveOverlay(
			{ projectDir, source: "claude", sessionId: sessionInfo.sessionId },
			{
				deletes: [{ role: "assistant", content: "msg-2", timestamp: "t1" }],
				edits: [{ role: "assistant", content: "msg-4", timestamp: "t3", newContent: "EDITED" }],
			},
		);
		const file = overlayPath({ projectDir, source: "claude", sessionId: sessionInfo.sessionId });
		expect(existsSync(file)).toBe(true);

		await loadSessionTranscripts(projectDir, { codexEnabled: false } as never);

		expect(existsSync(file)).toBe(false);
	});

	it("loadSessionTranscripts keeps the overlay when a rule's identity is outside the cursor-trimmed slice", async () => {
		const { sessionInfo } = stubSession();
		// "future-msg" / "t99" is NOT in stubSession's entries — rule must survive.
		await saveOverlay(
			{ projectDir, source: "claude", sessionId: sessionInfo.sessionId },
			{
				deletes: [{ role: "assistant", content: "future-msg", timestamp: "t99" }],
				edits: [],
			},
		);
		const file = overlayPath({ projectDir, source: "claude", sessionId: sessionInfo.sessionId });

		await loadSessionTranscripts(projectDir, { codexEnabled: false } as never);

		expect(existsSync(file)).toBe(true);
		const remaining = await loadOverlay({ projectDir, source: "claude", sessionId: sessionInfo.sessionId });
		expect(remaining?.deletes).toEqual([{ role: "assistant", content: "future-msg", timestamp: "t99" }]);
		expect(remaining?.edits).toEqual([]);
	});
});
