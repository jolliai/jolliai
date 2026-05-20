import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../Types.js";

vi.mock("./CursorSessionDiscoverer.js", () => ({ scanCursorSessions: vi.fn() }));
vi.mock("./CodexSessionDiscoverer.js", () => ({ discoverCodexSessions: vi.fn() }));
vi.mock("./OpenCodeSessionDiscoverer.js", () => ({ scanOpenCodeSessions: vi.fn() }));
vi.mock("./CopilotSessionDiscoverer.js", () => ({ scanCopilotSessions: vi.fn() }));
vi.mock("./CopilotChatSessionDiscoverer.js", () => ({ scanCopilotChatSessions: vi.fn() }));
vi.mock("./SessionTracker.js", () => ({ loadAllSessions: vi.fn().mockResolvedValue([]) }));
vi.mock("./SessionTitleResolver.js", () => ({
	resolveSessionTitle: vi.fn().mockImplementation(async (s) => s.title ?? `resolved:${s.sessionId}`),
}));
vi.mock("./TranscriptMessageCounter.js", () => ({
	// Default to a single-entry transcript so the aggregator's
	// "filter out 0-message sessions" rule keeps mocked sessions visible —
	// tests that exercise the filter override to [] explicitly.
	loadMergedTranscript: vi.fn().mockResolvedValue([{ role: "human", content: "msg" }]),
	loadUnreadMergedTranscript: vi.fn().mockResolvedValue([{ role: "human", content: "msg" }]),
}));

import { listActiveConversations } from "./ActiveSessionAggregator.js";
import { discoverCodexSessions } from "./CodexSessionDiscoverer.js";
import { conversationKey, setExcluded } from "./CommitSelectionStore.js";
import { scanCopilotChatSessions } from "./CopilotChatSessionDiscoverer.js";
import { scanCopilotSessions } from "./CopilotSessionDiscoverer.js";
import { scanCursorSessions } from "./CursorSessionDiscoverer.js";
import { scanOpenCodeSessions } from "./OpenCodeSessionDiscoverer.js";
import { loadMergedTranscript, loadUnreadMergedTranscript } from "./TranscriptMessageCounter.js";

// Mock shape used by all sqlite-backed discoverers (cursor/opencode/copilot/copilot-chat).
type ScanResult = { sessions: readonly SessionInfo[]; error?: undefined };
function scan(sessions: SessionInfo[]): ScanResult {
	return { sessions };
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-05-15T12:00:00.000Z").getTime();

function iso(offsetMs: number) {
	return new Date(NOW + offsetMs).toISOString();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.mocked(scanCursorSessions).mockReset().mockResolvedValue(scan([]));
	vi.mocked(scanOpenCodeSessions).mockReset().mockResolvedValue(scan([]));
	vi.mocked(scanCopilotSessions).mockReset().mockResolvedValue(scan([]));
	vi.mocked(scanCopilotChatSessions).mockReset().mockResolvedValue(scan([]));
	vi.mocked(discoverCodexSessions).mockReset().mockResolvedValue([]);
	vi.mocked(loadMergedTranscript)
		.mockReset()
		.mockResolvedValue([{ role: "human", content: "msg" }]);
	vi.mocked(loadUnreadMergedTranscript)
		.mockReset()
		.mockResolvedValue([{ role: "human", content: "msg" }]);
});

describe("listActiveConversations", () => {
	it("aggregates multiple sources concurrently", async () => {
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([
				{ sessionId: "c1", transcriptPath: "/x", updatedAt: iso(-HOUR), source: "cursor", title: "Cursor 1" },
			]),
		);
		vi.mocked(scanOpenCodeSessions).mockResolvedValueOnce(
			scan([
				{ sessionId: "o1", transcriptPath: "/y", updatedAt: iso(-2 * HOUR), source: "opencode", title: "OC 1" },
			]),
		);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		const ids = items.map((i) => i.sessionId);
		expect(ids).toContain("c1");
		expect(ids).toContain("o1");
	});

	it("filters sessions older than windowMs", async () => {
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([
				{ sessionId: "fresh", transcriptPath: "/x", updatedAt: iso(-HOUR), source: "cursor" },
				{ sessionId: "old", transcriptPath: "/x", updatedAt: iso(-3 * DAY), source: "cursor" },
			]),
		);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items.map((i) => i.sessionId)).toEqual(["fresh"]);
	});

	it("sorts by updatedAt descending, tie-break by sessionId ascending", async () => {
		const sameTime = iso(-HOUR);
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([
				{ sessionId: "b", transcriptPath: "/", updatedAt: sameTime, source: "cursor" },
				{ sessionId: "a", transcriptPath: "/", updatedAt: sameTime, source: "cursor" },
				{ sessionId: "c", transcriptPath: "/", updatedAt: iso(-2 * HOUR), source: "cursor" },
			]),
		);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items.map((i) => i.sessionId)).toEqual(["a", "b", "c"]);
	});

	it("continues when one source throws", async () => {
		vi.mocked(scanCursorSessions).mockRejectedValueOnce(new Error("sqlite locked"));
		vi.mocked(scanOpenCodeSessions).mockResolvedValueOnce(
			scan([{ sessionId: "ok", transcriptPath: "/", updatedAt: iso(-HOUR), source: "opencode" }]),
		);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items.map((i) => i.sessionId)).toEqual(["ok"]);
	});

	it("resolves titles for every returned item", async () => {
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([{ sessionId: "c1", transcriptPath: "/", updatedAt: iso(-HOUR), source: "cursor", title: "Mine" }]),
		);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items[0].title).toBe("Mine");
	});

	it("returns numeric messageCount even when transcript unreadable", async () => {
		vi.mocked(discoverCodexSessions).mockResolvedValueOnce([
			{ sessionId: "x", transcriptPath: "/dev/null", updatedAt: iso(-HOUR), source: "codex" },
		]);
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		for (const i of items) expect(typeof i.messageCount).toBe("number");
	});

	it("returns empty when every sqlite-backed discoverer + codex throws", async () => {
		// Exercises the inner catch in each loadXxx helper (lines 110, 120, 130, 140, 150).
		vi.mocked(scanCursorSessions).mockRejectedValueOnce(new Error("cursor fail"));
		vi.mocked(scanOpenCodeSessions).mockRejectedValueOnce(new Error("opencode fail"));
		vi.mocked(scanCopilotSessions).mockRejectedValueOnce(new Error("copilot fail"));
		vi.mocked(scanCopilotChatSessions).mockRejectedValueOnce(new Error("cc fail"));
		vi.mocked(discoverCodexSessions).mockRejectedValueOnce(new Error("codex fail"));

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items).toEqual([]);
	});

	it("loadClaudeAndGemini swallows SessionTracker errors", async () => {
		const { loadAllSessions } = await import("./SessionTracker.js");
		vi.mocked(loadAllSessions).mockRejectedValueOnce(new Error("registry busted"));
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items).toEqual([]);
	});

	// Identity = (source, sessionId), so the same sessionId emitted by two
	// different providers must NOT collapse — they're genuinely different
	// conversations that happen to share an id namespace. The previous
	// behavior (single-key dedup) silently dropped one row whenever a
	// Cursor hash collided with an opencode id, and this test pins the
	// correct contract: both rows survive.
	it("keeps cross-source rows with the same sessionId distinct", async () => {
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([{ sessionId: "dup", transcriptPath: "/cursor", updatedAt: iso(-2 * HOUR), source: "cursor" }]),
		);
		vi.mocked(scanOpenCodeSessions).mockResolvedValueOnce(
			scan([{ sessionId: "dup", transcriptPath: "/opencode", updatedAt: iso(-HOUR), source: "opencode" }]),
		);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items).toHaveLength(2);
		const bySource = Object.fromEntries(items.map((i) => [i.source, i.transcriptPath]));
		expect(bySource).toEqual({ cursor: "/cursor", opencode: "/opencode" });
	});

	// Within a single source, duplicate sessionIds *should* collapse to the
	// most-recently-updated row. This is the defensive in-source dedup that
	// the composite key still preserves — e.g. if a discoverer ever emits
	// the same id twice (shouldn't happen, but the loaders make no formal
	// guarantee) we keep the freshest snapshot.
	it("dedupes intra-source duplicates, keeping the most recent updatedAt", async () => {
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([
				{ sessionId: "dup", transcriptPath: "/old", updatedAt: iso(-2 * HOUR), source: "cursor" },
				{ sessionId: "dup", transcriptPath: "/new", updatedAt: iso(-HOUR), source: "cursor" },
			]),
		);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items).toHaveLength(1);
		expect(items[0].transcriptPath).toBe("/new");
	});

	// Mirror of the intra-source dedup test, but with the *older* row arriving
	// second. Exercises the `else` arm of `if (!existing || newer)` — "I've
	// already seen this (source, sessionId) at a more recent time, drop the
	// older copy" — which the above test alone does not cover.
	it("dedupes intra-source duplicates, keeping the earlier-seen entry when the second is older", async () => {
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([
				{ sessionId: "dup", transcriptPath: "/new", updatedAt: iso(-HOUR), source: "cursor" },
				{ sessionId: "dup", transcriptPath: "/old", updatedAt: iso(-2 * HOUR), source: "cursor" },
			]),
		);

		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items).toHaveLength(1);
		expect(items[0].transcriptPath).toBe("/new");
	});

	it("uses windowMs default when caller passes opts.windowMs as undefined", async () => {
		// Exercises the `windowMs ?? DEFAULT_WINDOW_MS` fallback branch. A
		// session 36h old must still appear under the 48h default.
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([{ sessionId: "old", transcriptPath: "/x", updatedAt: iso(-36 * HOUR), source: "cursor" }]),
		);
		const items = await listActiveConversations({
			cwd: "/proj",
			windowMs: undefined as unknown as number,
		});
		expect(items.map((i) => i.sessionId)).toEqual(["old"]);
	});

	it("falls back to source 'claude' when the discoverer omits source", async () => {
		// Exercises the `s.source ?? "claude"` fallback used in both the hidden
		// filter and the output mapping. SessionTracker (Claude+Gemini) sometimes
		// returns SessionInfo without an explicit source field.
		const { loadAllSessions } = await import("./SessionTracker.js");
		vi.mocked(loadAllSessions).mockResolvedValueOnce([
			{ sessionId: "no-src", transcriptPath: "/n", updatedAt: iso(-HOUR) } as SessionInfo,
		]);
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items).toEqual([expect.objectContaining({ sessionId: "no-src", source: "claude" })]);
	});

	it("treats transcript load errors as zero and drops the session from the list", async () => {
		// Exercises safeLoadUnreadMerged's catch branch — unread visibility is
		// now the gate for whether a session appears in the sidebar at all.
		const { loadUnreadMergedTranscript } = await import("./TranscriptMessageCounter.js");
		vi.mocked(loadUnreadMergedTranscript).mockRejectedValueOnce(new Error("read fail"));
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([{ sessionId: "broken", transcriptPath: "/b", updatedAt: iso(-HOUR), source: "cursor" }]),
		);
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items).toEqual([]);
	});

	// `safeLoadMerged` is only reached when `unread.length > 0` (the title-
	// resolution disk pass runs on the full merged transcript so the title
	// quality matches the panel's view). Its catch branch warn-logs and
	// returns []. Two flavors: one with `s.source` defined and one without,
	// to exercise both arms of `s.source ?? "claude"` in the warn-log args.
	it("safeLoadMerged: warn-logs and returns [] when loadMergedTranscript rejects (source defined)", async () => {
		const { loadMergedTranscript } = await import("./TranscriptMessageCounter.js");
		vi.mocked(loadMergedTranscript).mockRejectedValueOnce(new Error("merge fail"));
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([{ sessionId: "merge-broken", transcriptPath: "/m", updatedAt: iso(-HOUR), source: "cursor" }]),
		);
		// unread still resolves with 1 entry (default mock), so the session
		// row survives — title resolution falls back to UNTITLED_SESSION via
		// the empty-entries shortcut in resolveSessionTitle.
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items.map((i) => i.sessionId)).toEqual(["merge-broken"]);
		expect(items[0].messageCount).toBe(1);
	});

	it("safeLoadMerged: warn-logs the fallback 'claude' source when SessionInfo omits source", async () => {
		// Companion to the test above — drives the nullish-coalescing arm
		// of `s.source ?? "claude"` inside the warn-log args of safeLoadMerged.
		// SessionTracker (Claude/Gemini) is the producer of source-less rows.
		const { loadMergedTranscript } = await import("./TranscriptMessageCounter.js");
		const { loadAllSessions } = await import("./SessionTracker.js");
		vi.mocked(loadMergedTranscript).mockRejectedValueOnce(new Error("merge fail"));
		vi.mocked(loadAllSessions).mockResolvedValueOnce([
			{ sessionId: "no-src-merge-broken", transcriptPath: "/n", updatedAt: iso(-HOUR) } as SessionInfo,
		]);
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items).toEqual([
			expect.objectContaining({ sessionId: "no-src-merge-broken", source: "claude", messageCount: 1 }),
		]);
	});

	it("drops sessions whose post-overlay merged transcript is empty", async () => {
		// One session has no unread entries (cursor already consumed it), one
		// still has 7 unread entries. The sidebar should only show the latter.
		const { loadUnreadMergedTranscript } = await import("./TranscriptMessageCounter.js");
		const seven = Array.from({ length: 7 }, (_, i) => ({ role: "human" as const, content: `m${i}` }));
		vi.mocked(loadUnreadMergedTranscript)
			.mockResolvedValueOnce([]) // first call → "empty" session
			.mockResolvedValueOnce(seven); // second call → "non-empty" session
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([
				{ sessionId: "empty", transcriptPath: "/e", updatedAt: iso(-HOUR), source: "cursor" },
				{ sessionId: "keeps", transcriptPath: "/k", updatedAt: iso(-2 * HOUR), source: "cursor" },
			]),
		);
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items.map((i) => i.sessionId)).toEqual(["keeps"]);
		expect(items[0].messageCount).toBe(7);
	});

	it("filters out sessions whose full transcript exists but unread cursor slice is empty", async () => {
		const { loadMergedTranscript, loadUnreadMergedTranscript } = await import("./TranscriptMessageCounter.js");
		vi.mocked(loadUnreadMergedTranscript).mockResolvedValueOnce([]);
		vi.mocked(loadMergedTranscript).mockResolvedValueOnce([
			{ role: "human", content: "already used in previous commit" },
		]);
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([{ sessionId: "consumed", transcriptPath: "/c", updatedAt: iso(-HOUR), source: "cursor" }]),
		);
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items).toEqual([]);
	});

	it("filters consumed claude and gemini sessions from SessionTracker the same way", async () => {
		const { loadAllSessions } = await import("./SessionTracker.js");
		const { loadUnreadMergedTranscript } = await import("./TranscriptMessageCounter.js");
		vi.mocked(loadAllSessions).mockResolvedValueOnce([
			{ sessionId: "claude-consumed", transcriptPath: "/c", updatedAt: iso(-HOUR), source: "claude" },
			{ sessionId: "gemini-fresh", transcriptPath: "/g", updatedAt: iso(-2 * HOUR), source: "gemini" },
		]);
		vi.mocked(loadUnreadMergedTranscript)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ role: "human", content: "new gemini turn" }]);
		const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
		expect(items.map((i) => i.sessionId)).toEqual(["gemini-fresh"]);
	});

	it("forwards the project dir (cwd) to the transcript loader", async () => {
		// loadMergedTranscript needs projectDir to locate the per-session
		// overlay file under <projectDir>/.jolli/jollimemory/conversation-edits/.
		// Verifying the wire here means we don't have to roundtrip through
		// ConversationOverlayStore in this unit test.
		const { loadMergedTranscript } = await import("./TranscriptMessageCounter.js");
		vi.mocked(scanCursorSessions).mockResolvedValueOnce(
			scan([{ sessionId: "s", transcriptPath: "/t", updatedAt: iso(-HOUR), source: "cursor" }]),
		);
		await listActiveConversations({ cwd: "/the-cwd", windowMs: 2 * DAY });
		expect(vi.mocked(loadMergedTranscript)).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "s" }),
			"/the-cwd",
		);
	});

	it("excludes sessions marked hidden in HiddenConversationsStore", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { hideConversation } = await import("./HiddenConversationsStore.js");
		const projectDir = mkdtempSync(join(tmpdir(), "agg-hidden-"));
		try {
			vi.mocked(scanCursorSessions).mockResolvedValueOnce(
				scan([
					{ sessionId: "visible", transcriptPath: "/v", updatedAt: iso(-HOUR), source: "cursor" },
					{ sessionId: "to-hide", transcriptPath: "/h", updatedAt: iso(-2 * HOUR), source: "cursor" },
				]),
			);
			await hideConversation(projectDir, "cursor", "to-hide");

			const items = await listActiveConversations({ cwd: projectDir, windowMs: 2 * DAY });
			expect(items.map((i) => i.sessionId)).toEqual(["visible"]);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// Hide is per-snapshot dismiss, not permanent block. A session that the
	// user previously hid must re-surface once the source app records new
	// turns — otherwise long-running Cursor/Codex/Copilot Chat sessions
	// would be invisible forever after one "Mark All as Deleted" click.
	// `updatedAt` advancing past `hiddenAt` is the signal.
	it("re-surfaces a hidden session when its updatedAt advances past hiddenAt", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { hideConversation } = await import("./HiddenConversationsStore.js");
		const projectDir = mkdtempSync(join(tmpdir(), "agg-hide-resurface-"));
		try {
			// Hide at NOW (fake system time pinned in beforeEach), then surface a
			// session whose updatedAt is 1ms newer. Strict `>` boundary.
			await hideConversation(projectDir, "cursor", "resurface");
			vi.mocked(scanCursorSessions).mockResolvedValueOnce(
				scan([{ sessionId: "resurface", transcriptPath: "/r", updatedAt: iso(1), source: "cursor" }]),
			);

			const items = await listActiveConversations({ cwd: projectDir, windowMs: 2 * DAY });
			expect(items.map((i) => i.sessionId)).toEqual(["resurface"]);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// Boundary case: a session whose updatedAt is *exactly* the hiddenAt
	// timestamp is still considered hidden — equal timestamps mean we're
	// looking at the same snapshot the user just dismissed, not new activity.
	it("keeps a hidden session hidden when updatedAt equals hiddenAt", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { hideConversation } = await import("./HiddenConversationsStore.js");
		const projectDir = mkdtempSync(join(tmpdir(), "agg-hide-equal-"));
		try {
			await hideConversation(projectDir, "cursor", "still-hidden");
			vi.mocked(scanCursorSessions).mockResolvedValueOnce(
				scan([
					// updatedAt = NOW exactly, matching the hiddenAt stamped by
					// hideConversation under the fake-timers clock.
					{ sessionId: "still-hidden", transcriptPath: "/x", updatedAt: iso(0), source: "cursor" },
				]),
			);

			const items = await listActiveConversations({ cwd: projectDir, windowMs: 2 * DAY });
			expect(items).toEqual([]);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// ─── Silent-failure observability (Critical #5) ───────────────────────
	// Each sqlite-backed discoverer returns a structured `{ sessions, error? }`
	// envelope. When `error` is set, the loader emits a warn log and still
	// surfaces the (possibly empty) `sessions` array — exercising the
	// previously-uncovered "r.error" branch in each of the four loaders.
	describe("discoverer error envelope", () => {
		it("still returns sessions and continues when scanCursorSessions reports an error", async () => {
			vi.mocked(scanCursorSessions).mockResolvedValueOnce({
				sessions: [
					{ sessionId: "cur-A", transcriptPath: "/x", updatedAt: iso(-HOUR), source: "cursor", title: "T" },
				],
				error: { kind: "sqlite_locked", message: "locked" } as never,
			});
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items.map((i) => i.sessionId)).toContain("cur-A");
		});

		it("still returns sessions and continues when scanOpenCodeSessions reports an error", async () => {
			vi.mocked(scanOpenCodeSessions).mockResolvedValueOnce({
				sessions: [
					{ sessionId: "oc-A", transcriptPath: "/x", updatedAt: iso(-HOUR), source: "opencode", title: "T" },
				],
				error: { kind: "schema_drift", message: "x" } as never,
			});
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items.map((i) => i.sessionId)).toContain("oc-A");
		});

		it("still returns sessions and continues when scanCopilotSessions reports an error", async () => {
			vi.mocked(scanCopilotSessions).mockResolvedValueOnce({
				sessions: [
					{ sessionId: "cp-A", transcriptPath: "/x", updatedAt: iso(-HOUR), source: "copilot", title: "T" },
				],
				error: { kind: "sqlite_corrupt", message: "x" } as never,
			});
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items.map((i) => i.sessionId)).toContain("cp-A");
		});

		it("still returns sessions and continues when scanCopilotChatSessions reports an error", async () => {
			vi.mocked(scanCopilotChatSessions).mockResolvedValueOnce({
				sessions: [
					{
						sessionId: "cc-A",
						transcriptPath: "/x",
						updatedAt: iso(-HOUR),
						source: "copilot-chat",
						title: "T",
					},
				],
				error: { kind: "storage_missing", message: "x" } as never,
			});
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items.map((i) => i.sessionId)).toContain("cc-A");
		});

		it("listActiveConversationsWithDiagnostics surfaces failedSources when a loader rejects", async () => {
			const { listActiveConversationsWithDiagnostics } = await import("./ActiveSessionAggregator.js");
			vi.mocked(scanCursorSessions).mockRejectedValueOnce(new Error("loader threw"));
			const result = await listActiveConversationsWithDiagnostics({ cwd: "/proj", windowMs: 2 * DAY });
			expect(result.items).toEqual([]);
			expect(result.failedSources).toEqual(["cursor"]);
		});

		it("listActiveConversationsWithDiagnostics surfaces failedSources when a discoverer returns r.error", async () => {
			const { listActiveConversationsWithDiagnostics } = await import("./ActiveSessionAggregator.js");
			vi.mocked(scanOpenCodeSessions).mockResolvedValueOnce({
				sessions: [],
				error: { kind: "locked", message: "database is locked" },
			} as never);
			const result = await listActiveConversationsWithDiagnostics({ cwd: "/proj", windowMs: 2 * DAY });
			expect(result.failedSources).toEqual(["opencode"]);
		});

		it("listActiveConversationsWithDiagnostics aggregates multiple simultaneous failures", async () => {
			const { listActiveConversationsWithDiagnostics } = await import("./ActiveSessionAggregator.js");
			vi.mocked(scanCursorSessions).mockRejectedValueOnce(new Error("cursor down"));
			vi.mocked(scanCopilotSessions).mockResolvedValueOnce({
				sessions: [],
				error: { kind: "schema_drift", message: "no turns table" },
			} as never);
			const result = await listActiveConversationsWithDiagnostics({ cwd: "/proj", windowMs: 2 * DAY });
			expect([...result.failedSources].sort()).toEqual(["copilot", "cursor"]);
		});

		it("listActiveConversationsWithDiagnostics reports empty failedSources when all loaders succeed", async () => {
			const { listActiveConversationsWithDiagnostics } = await import("./ActiveSessionAggregator.js");
			const result = await listActiveConversationsWithDiagnostics({ cwd: "/proj", windowMs: 2 * DAY });
			expect(result.failedSources).toEqual([]);
		});

		// Discoverer returns a non-empty `sessions` array AND an `r.error`
		// (partial-failure case where the scan got some rows before tripping).
		// The contract is: keep the sessions we did get, but still flag the
		// source as failed so the UI can hint "this source returned partial data".
		it("listActiveConversationsWithDiagnostics flags failedSources even when discoverer also returned sessions", async () => {
			const { listActiveConversationsWithDiagnostics } = await import("./ActiveSessionAggregator.js");
			vi.mocked(scanCursorSessions).mockResolvedValueOnce({
				sessions: [{ sessionId: "partial", transcriptPath: "/x", updatedAt: iso(-HOUR), source: "cursor" }],
				error: { kind: "locked", message: "concurrent writer" },
			} as never);
			const result = await listActiveConversationsWithDiagnostics({ cwd: "/proj", windowMs: 2 * DAY });
			expect(result.items.map((i) => i.sessionId)).toContain("partial");
			expect(result.failedSources).toEqual(["cursor"]);
		});

		// Each loader's inner try/catch branch — when the discoverer module
		// itself throws (not just returns an error envelope), the loader
		// must absorb, log, and return [] so the rest of the fan-out keeps
		// going. One assertion per loader keeps the catch path covered.
		it("loadCursor catches throws from the discoverer module", async () => {
			vi.mocked(scanCursorSessions).mockRejectedValueOnce(new Error("cursor blew up"));
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items).toEqual([]);
		});

		it("loadCodex catches throws from the discoverer module", async () => {
			vi.mocked(discoverCodexSessions).mockRejectedValueOnce(new Error("codex blew up"));
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items).toEqual([]);
		});

		it("loadOpenCode catches throws from the discoverer module", async () => {
			vi.mocked(scanOpenCodeSessions).mockRejectedValueOnce(new Error("opencode blew up"));
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items).toEqual([]);
		});

		it("loadCopilot catches throws from the discoverer module", async () => {
			vi.mocked(scanCopilotSessions).mockRejectedValueOnce(new Error("copilot blew up"));
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items).toEqual([]);
		});

		it("loadCopilotChat catches throws from the discoverer module", async () => {
			vi.mocked(scanCopilotChatSessions).mockRejectedValueOnce(new Error("copilot-chat blew up"));
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items).toEqual([]);
		});

		// `err instanceof Error ? err.message : String(err)` — exercise the
		// String(err) fallback in every loader's catch so a thrown
		// non-Error value (e.g. a plain string from an over-eager `throw`)
		// is still safely stringified for the log.
		it("loaders stringify non-Error throws when reporting them", async () => {
			vi.mocked(scanCursorSessions).mockRejectedValueOnce("string-thrown");
			vi.mocked(discoverCodexSessions).mockRejectedValueOnce("string-thrown");
			vi.mocked(scanOpenCodeSessions).mockRejectedValueOnce("string-thrown");
			vi.mocked(scanCopilotSessions).mockRejectedValueOnce("string-thrown");
			vi.mocked(scanCopilotChatSessions).mockRejectedValueOnce("string-thrown");
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			expect(items).toEqual([]);
		});

		// safeLoadUnreadMerged's catch path mentions `s.source ?? "claude"` —
		// exercise the default arm by feeding a SessionInfo without `source`
		// whose transcript read throws.
		it("safeLoadUnreadMerged logs with default source 'claude' when SessionInfo omits source", async () => {
			const { loadUnreadMergedTranscript } = await import("./TranscriptMessageCounter.js");
			vi.mocked(loadUnreadMergedTranscript).mockRejectedValueOnce(new Error("boom"));
			vi.mocked(scanCursorSessions).mockResolvedValueOnce(
				scan([
					{
						sessionId: "no-src",
						transcriptPath: "/x",
						updatedAt: iso(-HOUR),
						// source intentionally omitted
					} as unknown as SessionInfo,
				]),
			);
			const items = await listActiveConversations({ cwd: "/proj", windowMs: 2 * DAY });
			// safeLoadUnreadMerged returns [] on throw, and the `messageCount > 0`
			// guard drops the row — assert the empty result and trust the
			// log path.
			expect(items).toEqual([]);
		});
	});

	it("stamps isSelected=false on rows whose key is in the exclusion file", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const projectDir = mkdtempSync(join(tmpdir(), "agg-selected-false-"));
		try {
			const sessionId = "sel-false-session";
			vi.mocked(scanCursorSessions).mockResolvedValueOnce(
				scan([{ sessionId, transcriptPath: "/x", updatedAt: iso(-HOUR), source: "cursor" }]),
			);
			await setExcluded(projectDir, "conversations", conversationKey("cursor", sessionId), true);

			const items = await listActiveConversations({ cwd: projectDir, windowMs: 2 * DAY });

			expect(items).toHaveLength(1);
			expect(items[0].isSelected).toBe(false);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("defaults isSelected=true when the row is not in the exclusion file", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const projectDir = mkdtempSync(join(tmpdir(), "agg-selected-true-"));
		try {
			vi.mocked(scanCursorSessions).mockResolvedValueOnce(
				scan([
					{ sessionId: "sel-true-session", transcriptPath: "/x", updatedAt: iso(-HOUR), source: "cursor" },
				]),
			);

			const items = await listActiveConversations({ cwd: projectDir, windowMs: 2 * DAY });

			expect(items).toHaveLength(1);
			expect(items[0].isSelected).toBe(true);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
