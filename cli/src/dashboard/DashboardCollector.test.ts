import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommandResult, SessionInfo, TranscriptReadResult, TranscriptSource } from "../Types.js";

vi.mock("../core/GitOps.js", () => ({
	execGit: vi.fn(),
	getCurrentBranch: vi.fn(),
	// Antigravity's narrowing asks the repo for its checkouts. These fixtures have
	// exactly one, which is also what the real helper degrades to when git cannot
	// answer — so returning the identity keeps the attribution assertions about
	// attribution rather than about worktree enumeration.
	resolveWorktreeRoots: vi.fn(async (dir: string) => [dir]),
}));
vi.mock("../core/SummaryStore.js", () => ({
	getIndex: vi.fn(),
	getSummary: vi.fn(),
	readTranscriptsForCommits: vi.fn(),
}));
// Only the read is faked; everything else in the module stays REAL, for two
// separate reasons. `isMissingTranscriptError` classifies the rejection the
// collector catches, so the real predicate has to stay in place. And
// `splitTranscriptLines` is a pure string split that the line-oriented
// extractors depend on — a mocked-away `undefined` would surface as a TypeError
// deep inside a lazily-imported reader rather than as a failed expectation.
vi.mock("../core/TranscriptReader.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../core/TranscriptReader.js")>();
	return { ...original, readTranscript: vi.fn() };
});
// PARTIAL, for the same reason as above: the default stays the REAL per-source
// dispatcher, so a Claude session still lands on the mocked `readTranscript`
// and `readTranscriptLinesForSource` keeps feeding the line-oriented extractors
// that `sessionContentFor` shares. The per-source tests override the dispatch
// with `mockResolvedValueOnce`, which is what lets them assert a codex or
// cursor session without a real SQLite/JSONL fixture.
vi.mock("../core/TranscriptSourceReader.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../core/TranscriptSourceReader.js")>();
	return { ...original, readTranscriptForSource: vi.fn(original.readTranscriptForSource) };
});
// The default session loader fans out to every discoverer; mock the registry
// loader so `loadAllSessions` has one deterministic success and the rest of
// the discoverers run for real against a directory that has none of their stores.
vi.mock("../core/SessionTracker.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../core/SessionTracker.js")>();
	return { ...original, loadAllSessions: vi.fn() };
});
// PARTIAL: only the per-repo scan is replaced, so `codexSessionsForRepo` keeps doing
// real attribution. The spy is how the "a pre-scanned source is not scanned again"
// guarantee is asserted — without it that double read would be invisible.
vi.mock("../core/CodexSessionDiscoverer.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../core/CodexSessionDiscoverer.js")>();
	return { ...original, discoverCodexSessions: vi.fn(async () => []) };
});

import type { ClaudeDiskSession } from "../core/ClaudeSessionDiscoverer.js";
import type { CodexDiskSession } from "../core/CodexSessionDiscoverer.js";
import { discoverCodexSessions } from "../core/CodexSessionDiscoverer.js";
import type { DiskSession } from "../core/DiskSessionScan.js";
import { execGit, getCurrentBranch, resolveWorktreeRoots } from "../core/GitOps.js";
import { loadAllSessions as loadRegistrySessions } from "../core/SessionTracker.js";
import { getIndex, getSummary, readTranscriptsForCommits } from "../core/SummaryStore.js";
import { readTranscript } from "../core/TranscriptReader.js";
import { readTranscriptForSource } from "../core/TranscriptSourceReader.js";
import {
	collectCommitEvents,
	collectFilesForCommits,
	collectSessionEvents,
	collectSummaryEvents,
	collectWorktreeEvent,
	loadAllSessions,
	parseNumstatLog,
	sessionEventFromInfo,
	sessionPassKey,
	sourceOfSessionPassKey,
	summaryEventFromCommitSummary,
} from "./DashboardCollector.js";

beforeEach(() => {
	// The partial SessionTracker mock keeps the real module except for this read.
	// Give the seam its valid default explicitly: a bare `vi.fn()` resolves to
	// undefined, which violates the loader contract and makes the fan-out fail while
	// spreading a fulfilled result that is not an array.
	vi.mocked(loadRegistrySessions).mockResolvedValue([]);
});

const git = (stdout: string): GitCommandResult => ({ stdout, stderr: "", exitCode: 0 });
const gitFail = (stderr: string): GitCommandResult => ({ stdout: "", stderr, exitCode: 128 });

const claudeSession = (over: Partial<SessionInfo> = {}): SessionInfo => ({
	sessionId: "s1",
	transcriptPath: "/t/s1.jsonl",
	updatedAt: "2026-07-30T08:00:00.000Z",
	source: "claude",
	...over,
});

/**
 * A repo root the disk-scan fixtures below attribute themselves to.
 *
 * `resolve()`d rather than a bare "/w/repo" literal, because one source's narrowing
 * normalizes the project dir before matching: `copilotSessionsForRepo` runs it through
 * `path.resolve()`, so on Windows the row's literal "/w/repo" would be compared against
 * "<drive>:\w\repo" and never match — the same trap `CopilotSessionDiscoverer.test.ts`
 * documents and avoids the same way. Resolving BOTH sides here keeps every source's
 * comparison platform-neutral; the other eight compare the string as given.
 */
const WORKTREE = resolve("/w/repo");

const diskSession = (over: Partial<ClaudeDiskSession> = {}): ClaudeDiskSession => ({
	sessionId: "d1",
	transcriptPath: "/t/d1.jsonl",
	updatedAt: "2026-07-30T08:00:00.000Z",
	dirs: [WORKTREE],
	// The whole-file read every non-skipped transcript gets; the scan only reports
	// `false` when the database already held the session.
	complete: true,
	...over,
});

const codexDiskSession = (over: Partial<CodexDiskSession> = {}): CodexDiskSession => ({
	sessionId: "x1",
	transcriptPath: "/t/x1.jsonl",
	updatedAt: "2026-07-30T08:00:00.000Z",
	dirs: [WORKTREE],
	...over,
});

/** A machine-wide scan entry for any of the sources that use the shared shape. */
const diskEntry = (source: TranscriptSource, id: string, dirs: string[] = [WORKTREE]): DiskSession => ({
	session: {
		sessionId: id,
		transcriptPath: `/t/${id}.jsonl`,
		updatedAt: "2026-07-30T08:00:00.000Z",
		source,
	},
	dirs,
});

const transcript = (over: Partial<TranscriptReadResult> = {}): TranscriptReadResult => ({
	entries: [
		{ role: "human", content: "hi", timestamp: "2026-07-30T07:00:00.000Z" },
		{ role: "assistant", content: "hello", timestamp: "2026-07-30T07:30:00.000Z" },
	],
	newCursor: { transcriptPath: "/t/s1.jsonl", lineNumber: 2, updatedAt: "t" },
	totalLinesRead: 2,
	usageByModel: [{ model: "claude-opus-4-8", provider: "anthropic", input: 100, output: 50, cached: 10 }],
	...over,
});

describe("collectSessionEvents", () => {
	it("emits a full-coverage event for a Claude session with usage and duration", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript());
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession({ title: "Fix the bug" })],
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			source: "claude",
			sessionId: "s1",
			title: "Fix the bug",
			messageCount: 2,
			startedAtMs: Date.parse("2026-07-30T07:00:00.000Z"),
			durationMs: 30 * 60 * 1000,
			tokenCoverage: "full",
		});
		expect(events[0].models).toEqual([
			expect.objectContaining({ model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50, cachedTokens: 10 }),
		]);
		// claude-opus-4-8 is priced — the estimate must be present and positive.
		expect(events[0].models?.[0].estCostUsd).toBeGreaterThan(0);
	});

	it("asks every worktree root, not just cwd", async () => {
		// The gap this closes: a conversation is keyed by the directory it RAN IN, so a
		// linked worktree's sessions live under its own path and under its own
		// `sessions.json`. Scoping to the registered checkout alone made them invisible
		// to the sweep while their rows already existed — written live by the StopHook
		// running inside that worktree.
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const asked: string[] = [];
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w/main",
			worktreeRoots: ["/w/main", "/w/feature"],
			loadSessions: async (root) => {
				asked.push(root);
				return root === "/w/feature" ? [claudeSession({ sessionId: "in-sibling" })] : [];
			},
		});
		expect(asked).toEqual(["/w/main", "/w/feature"]);
		expect(events.map((e) => e.sessionId)).toEqual(["in-sibling"]);
	});

	it("collects a session two roots both claim exactly once", async () => {
		// What makes asking N roots safe. Roots overlap in practice — a source that
		// cannot scope its store answers the same session for every root it is asked
		// about — and the dedupe on `(source, sessionId)` is the only thing standing
		// between that and one conversation counted once per checkout.
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w/main",
			worktreeRoots: ["/w/main", "/w/feature"],
			loadSessions: async () => [claudeSession({ sessionId: "shared" })],
		});
		expect(events.map((e) => e.sessionId)).toEqual(["shared"]);
	});

	it("falls back to cwd when no roots are supplied", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const asked: string[] = [];
		await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			worktreeRoots: [],
			loadSessions: async (root) => {
				asked.push(root);
				return [];
			},
		});
		expect(asked).toEqual(["/w"]);
	});

	it("still asks cwd when the supplied roots leave it out", async () => {
		// The roots come from a `git worktree list` that degrades to its input on
		// failure, so a caller can hand over a list that does not name this checkout.
		// Replacing `cwd` with it would drop THIS worktree's own `sessions.json` — the
		// hook registry is per-project, so that is the one file nothing else reads —
		// and the loss is silent: the sweep reports a clean run over a checkout it
		// never opened. Union, never substitute.
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const asked: string[] = [];
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w/main",
			worktreeRoots: ["/w/feature"],
			loadSessions: async (root) => {
				asked.push(root);
				return root === "/w/main" ? [claudeSession({ sessionId: "in-cwd" })] : [];
			},
		});
		expect(asked).toEqual(["/w/main", "/w/feature"]);
		expect(events.map((e) => e.sessionId)).toEqual(["in-cwd"]);
	});

	it("reads one checkout once when cwd is also named in the roots", async () => {
		// The common case — a caller that already unioned `cwd` in. The dedupe is on
		// the compare-folded spelling, so `/w/Main` and `/w/main` are one checkout on
		// a case-insensitive filesystem; the SURVIVING string is the caller's own,
		// because `sessionDirBelongsToRepo` walks it as a real on-disk path.
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const asked: string[] = [];
		await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w/main",
			worktreeRoots: ["/w/main", "/w/feature"],
			loadSessions: async (root) => {
				asked.push(root);
				return [];
			},
		});
		expect(asked).toEqual(["/w/main", "/w/feature"]);
	});

	it("asks a worktree-spanning source once, not once per root", async () => {
		// Antigravity is the one definition that declares `forRepoSpansWorktrees`: its
		// narrowing runs its OWN `resolveWorktreeRoots`, so one call already covers
		// every checkout. Asking it per root is the identical search N times, and the
		// dedupe throws all but one result away — while each discarded pass still pays
		// a streamed title read per claimed session. The mocked resolver is the probe:
		// one call means one narrowing.
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			worktreeRoots: [WORKTREE, "/w/feature", "/w/third"],
			loadSessions: async () => [],
			preScanned: { antigravity: [diskEntry("antigravity", "ag-1")] },
		});
		expect(vi.mocked(resolveWorktreeRoots)).toHaveBeenCalledTimes(1);
		expect(events.map((e) => e.sessionId)).toEqual(["ag-1"]);
	});

	it("asks a worktree-spanning source once per CHECKOUT, so a second clone is not lost", async () => {
		// `worktreeRoots` is a union across clones — two checkouts of one remote share
		// a repo identity — while a spanning source resolves the worktrees of the
		// repository it is HANDED. So one call covers one clone's `.git` and reaches no
		// other's: asking only at `cwd` dropped the second clone's sessions for this
		// source alone, while every other source picked them up from the root list.
		vi.mocked(resolveWorktreeRoots).mockImplementation(async (dir: string) =>
			dir === "/w/clone-b" ? ["/w/clone-b", "/w/clone-b-feature"] : [dir, "/w/feature"],
		);
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			worktreeRoots: [WORKTREE, "/w/feature", "/w/clone-b", "/w/clone-b-feature"],
			checkoutRoots: [WORKTREE, "/w/clone-b"],
			loadSessions: async () => [],
			preScanned: {
				antigravity: [
					diskEntry("antigravity", "ag-1"),
					diskEntry("antigravity", "ag-2", ["/w/clone-b-feature"]),
				],
			},
		});
		// Once per checkout — not once per worktree root (four), not once overall.
		expect(vi.mocked(resolveWorktreeRoots)).toHaveBeenCalledTimes(2);
		expect(events.map((e) => e.sessionId).sort()).toEqual(["ag-1", "ag-2"]);
	});

	it("runs a spanning source's per-repo FALLBACK once per checkout, not once per root", async () => {
		// The degraded path: the machine-wide scan failed, so the source arrives as
		// `undefined` and its own `scanForRepo` runs instead. That route used to ride
		// inside `loadAllSessions`, which is driven per worktree root — so the full
		// sweep this flag exists to run once ran N times concurrently, on exactly the
		// path that was already the expensive one.
		await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			worktreeRoots: [WORKTREE, "/w/feature", "/w/third"],
			checkoutRoots: [WORKTREE, "/w/clone-b"],
			// The real `loadAllSessions`, so the fallback is reached the way production
			// reaches it; `antigravity` is absent from `preScanned`, which is how a
			// failed machine-wide scan arrives.
		});
		// The probe is the same one the narrowing test uses: Antigravity's per-repo scan
		// ends in `antigravitySessionsForRepo`, which resolves the worktrees of the
		// directory it was handed. Two directories, not the three worktree roots.
		expect(
			vi
				.mocked(resolveWorktreeRoots)
				.mock.calls.map((c) => c[0])
				.sort(),
		).toEqual(["/w/clone-b", WORKTREE]);
	});

	it("keeps a spanning source out of the slice the per-root loader is handed", async () => {
		// The other half of the same rule, asserted at the seam: `loadAllSessions` runs
		// per worktree root, so anything left in its `defs` is asked N times.
		const handed: Array<ReadonlyArray<string>> = [];
		await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			worktreeRoots: [WORKTREE, "/w/feature"],
			loadSessions: async (_cwd, _windowMs, _pre, defs) => {
				handed.push((defs ?? []).map((d) => d.source));
				return [];
			},
		});
		expect(handed).toHaveLength(2);
		for (const sources of handed) {
			expect(sources).not.toContain("antigravity");
			// The slice is a narrowing, not an emptying — every other source is still there.
			expect(sources).toContain("codex");
		}
	});

	it("leaves tokenCoverage absent for a Claude session with no usage", async () => {
		// Absent, not an explicit `sessions-only`: `StatsWriter` defaults absence to
		// `sessions-only` on first write but PRESERVES an existing `full` on re-read, so
		// a transcript whose retention window dropped its usage cannot downgrade a row
		// that once measured full usage.
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession()],
		});
		expect(events[0]).not.toHaveProperty("tokenCoverage");
		expect(events[0].models).toBeUndefined();
	});

	it("omits the duration for a conversation with a single turn", async () => {
		// First and last entry are the same record, so there is no elapsed time to
		// report. Writing 0 would claim a measurement; absence says there is none —
		// and the guard is `>`, not `>=`, for exactly this case.
		vi.mocked(readTranscript).mockResolvedValue(
			transcript({
				entries: [{ role: "human", content: "one turn", timestamp: "2026-07-30T07:00:00.000Z" }],
				usageByModel: [],
			}),
		);

		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession()],
		});

		expect(events[0].messageCount).toBe(1);
		expect(events[0].durationMs).toBeUndefined();
	});

	it("keeps the NEWER of two views of one session, whichever order they arrive in", async () => {
		// Two discoverers can surface the same conversation — the hook registry and a
		// rescan of the same store — and the dedupe has to be an explicit comparison
		// rather than last-write-wins, or which timestamp survives depends on the order
		// the loaders happened to finish in.
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));

		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [
				claudeSession({ updatedAt: "2026-07-30T09:00:00.000Z" }),
				claudeSession({ updatedAt: "2026-07-30T08:00:00.000Z" }),
			],
		});

		expect(events).toHaveLength(1);
		expect(events[0].updatedAtMs).toBe(Date.parse("2026-07-30T09:00:00.000Z"));
	});

	it("keeps a session whose transcript is unreadable, with what the discoverer knew", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(readTranscript).mockRejectedValue(new Error("moved"));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession()],
		});
		expect(events).toHaveLength(1);
		expect(events[0].messageCount).toBeUndefined();
		// An unexplained read failure is still worth the user's terminal.
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("transcript unreadable"));
		warn.mockRestore();
	});

	it("stays quiet when the transcript is simply gone — a rotated JSONL is not a fault", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const gone = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		vi.mocked(readTranscript).mockRejectedValue(
			Object.assign(new Error("Cannot read transcript: /t/s1.jsonl"), { cause: gone }),
		);
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession()],
		});
		expect(events).toHaveLength(1);
		expect(events[0].messageCount).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("never sends a non-Claude transcript to Claude's reader", async () => {
		// Non-Claude sources DO get read now — that is what gave the other twelve agents
		// their tool and MCP calls. What must not happen is them being read by the
		// Claude-shaped `readTranscript`: a Cursor `transcriptPath` is a synthetic
		// `<dbPath>#<sessionId>` handle, and a JSONL reader handed one does not fail
		// loudly, it parses zero lines and reports an empty conversation.
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession({ source: "cursor", sessionId: "c1" })],
		});
		// The row survives whatever its own reader did — an unreadable transcript still
		// counts as a session, recorded from what the discoverer knew.
		expect(events).toEqual([
			expect.objectContaining({
				source: "cursor",
				sessionId: "c1",
				updatedAtMs: Date.parse("2026-07-30T08:00:00.000Z"),
			}),
		]);
		expect(readTranscript).not.toHaveBeenCalled();
	});

	it("buckets a session's activity, but attributes tokens only where per-turn usage exists", async () => {
		vi.mocked(readTranscriptForSource).mockResolvedValueOnce({
			entries: [
				{ role: "human", content: "hi", timestamp: "2026-08-11T10:07:00.000Z" },
				{ role: "assistant", content: "yo", timestamp: "2026-08-11T10:41:00.000Z" },
			],
			newCursor: { lineNumber: 2 },
			totalLinesRead: 2,
		} as unknown as TranscriptReadResult);

		const event = await sessionEventFromInfo("repo-1", {
			sessionId: "s1",
			source: "codex",
			transcriptPath: "/tmp/s1.jsonl",
			updatedAt: "2026-08-11T10:41:00.000Z",
		} as SessionInfo);

		expect(event?.messageCount).toBe(2);
		expect(event?.activityBuckets).toEqual([
			Date.parse("2026-08-11T10:00:00.000Z"),
			Date.parse("2026-08-11T10:30:00.000Z"),
		]);
		// Codex carries no per-turn usage, so nothing is attributed — the event leaves
		// `tokenCoverage` ABSENT and `StatsWriter` defaults it to `sessions-only` on
		// first write (while preserving an existing `full` on re-read).
		expect(event).not.toHaveProperty("tokenCoverage");
		expect(event?.models).toBeUndefined();
	});

	it("builds a bare session row without attempting a read when no transcript path is known", async () => {
		const event = await sessionEventFromInfo("repo-1", {
			sessionId: "pathless",
			source: "cursor",
			updatedAt: "2026-08-11T10:41:00.000Z",
		});

		expect(event).toEqual({
			type: "session.upserted",
			repoIdentity: "repo-1",
			source: "cursor",
			sessionId: "pathless",
			metadataOnly: true,
			updatedAtMs: Date.parse("2026-08-11T10:41:00.000Z"),
		});
		expect(readTranscript).not.toHaveBeenCalled();
		expect(readTranscriptForSource).not.toHaveBeenCalled();
	});

	it("omits activityBuckets entirely when no entry is timestamped", async () => {
		vi.mocked(readTranscriptForSource).mockResolvedValueOnce({
			entries: [{ role: "human", content: "hi" }],
			newCursor: { lineNumber: 1 },
			totalLinesRead: 1,
		} as unknown as TranscriptReadResult);

		const event = await sessionEventFromInfo("repo-1", {
			sessionId: "s2",
			source: "cursor",
			transcriptPath: "/tmp/s2.db#c1",
			updatedAt: "2026-08-11T10:41:00.000Z",
		} as SessionInfo);

		// ABSENT, not `[]` — "uncovered", not "used no agents".
		expect(event).not.toHaveProperty("activityBuckets");
	});

	it("dedupes (source, sessionId), keeping the newest, and drops unparseable timestamps", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [
				claudeSession({ updatedAt: "2026-07-29T00:00:00.000Z" }),
				claudeSession({ updatedAt: "2026-07-30T00:00:00.000Z" }),
				claudeSession({ sessionId: "junk", updatedAt: "not-a-date" }),
			],
		});
		expect(events).toHaveLength(1);
		expect(events[0].updatedAtMs).toBe(Date.parse("2026-07-30T00:00:00.000Z"));
	});

	it("omits start/duration when the transcript carries no timestamps", async () => {
		vi.mocked(readTranscript).mockResolvedValue(
			transcript({
				entries: [
					{ role: "human", content: "hi" },
					{ role: "assistant", content: "yo" },
				],
				usageByModel: [
					{ model: "totally-unpriced-model", provider: "unknown", input: 1, output: 1, cached: 0 },
				],
			}),
		);
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession()],
		});
		expect(events[0]).not.toHaveProperty("startedAtMs");
		expect(events[0]).not.toHaveProperty("durationMs");
		// Unpriced model: usage recorded, cost honestly absent (not zero).
		expect(events[0].models?.[0]).not.toHaveProperty("estCostUsd");
	});

	it("treats a missing source as claude (registry back-compat)", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => {
				const { source: _omit, ...noSource } = claudeSession();
				return [noSource];
			},
		});
		expect(events[0].source).toBe("claude");
	});

	it("adds pre-scanned Claude transcripts whose working directory matches the repo", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [],
			preScanned: { claude: [diskSession()] },
		});
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ source: "claude", sessionId: "d1" });
	});

	it("reads a pre-scanned transcript itself rather than taking the scan's word", async () => {
		// The scan parsed this file to collect its working directories and deliberately
		// kept none of it — carrying the parse made a run's resident set grow with the
		// window (see `acceptFacts`). So the read is paid here, per session, and it is a
		// re-read rather than a first read.
		vi.mocked(readTranscript).mockResolvedValue(
			transcript({ entries: [{ role: "human", content: "only turn" }], usageByModel: [] }),
		);

		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [],
			preScanned: { claude: [diskSession()] },
		});

		expect(readTranscript).toHaveBeenCalledTimes(1);
		expect(events[0].messageCount).toBe(1);
	});

	it("reads a cheap-path scan the same way — `complete` no longer changes anything here", async () => {
		// `complete: false` says the scan only read a tail, so its `dirs` may be short.
		// That is an attribution caveat and not a content one: neither path carries
		// content, so both cost exactly one read here.
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));

		await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [],
			preScanned: { claude: [diskSession({ complete: false })] },
		});

		expect(readTranscript).toHaveBeenCalledTimes(1);
	});

	it("drops a pre-scanned transcript belonging to another repo", async () => {
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [],
			preScanned: { claude: [diskSession({ dirs: ["/somewhere/else"] })] },
		});
		expect(events).toEqual([]);
		expect(readTranscript).not.toHaveBeenCalled();
	});

	it("merges the disk scan with the registry instead of replacing it", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			// Only reachable through `sessions.json` — e.g. Gemini, which has no disk scanner.
			loadSessions: async () => [claudeSession({ source: "gemini", sessionId: "g1" })],
			preScanned: { claude: [diskSession()] },
		});
		expect(events.map((e) => e.sessionId).sort()).toEqual(["d1", "g1"]);
	});

	it("drops a switched-off source's registry rows", async () => {
		// `sessions.json` is one per-project file holding every source's hook-written
		// rows, so the read happens whatever the toggles say and the ROWS have to go.
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [
				claudeSession({ source: "cursor", sessionId: "c1" }),
				claudeSession({ sessionId: "k1" }),
			],
			isSourceAllowed: (source) => source !== "cursor",
		});
		expect(events.map((e) => e.sessionId)).toEqual(["k1"]);
	});

	it("keeps GEMINI, which has no SESSION_SOURCES entry at all", async () => {
		// The regression the predicate exists to avoid. Gemini has no disk discoverer, so
		// the registry is its ONLY route — filtering sessions by registry MEMBERSHIP
		// rather than by the toggle would delete every Gemini session on the machine,
		// including under a gate as permissive as this one.
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [claudeSession({ source: "gemini", sessionId: "g1" })],
			isSourceAllowed: (source) => source !== "cursor",
		});
		expect(events.map((e) => e.sessionId)).toEqual(["g1"]);
	});

	it("never opens a switched-off source's store — not even by the per-repo fallback", async () => {
		// The half that would silently undo the whole thing: absence from `preScanned` is
		// what makes the collector fall back to a source's PER-REPO scan, so narrowing
		// only the machine-wide scan would turn "do not scan this" into "scan it once per
		// repo instead".
		//
		// `loadSessions` is deliberately NOT injected: that fallback lives inside the
		// DEFAULT loader, so an injected one bypasses the very code under test.
		vi.mocked(loadRegistrySessions).mockResolvedValue([]);
		await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/tmp/definitely-no-agents-here",
			isSourceAllowed: (source) => source !== "codex",
		});
		expect(discoverCodexSessions).not.toHaveBeenCalled();
	});

	it("still runs that fallback for a source that is switched ON", async () => {
		// The other direction, so the test above cannot pass by the gate rejecting
		// everything — or by the fallback simply never running in this harness.
		vi.mocked(loadRegistrySessions).mockResolvedValue([]);
		await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/tmp/definitely-no-agents-here",
			isSourceAllowed: () => true,
		});
		expect(discoverCodexSessions).toHaveBeenCalled();
	});

	it("keeps the registry copy when both routes surface one session (its instant is later)", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			// The Stop hook stamps the hook's own instant, a few seconds after the last turn.
			loadSessions: async () => [claudeSession({ sessionId: "d1", updatedAt: "2026-07-30T08:00:03.000Z" })],
			preScanned: { claude: [diskSession({ updatedAt: "2026-07-30T08:00:00.000Z" })] },
		});
		expect(events).toHaveLength(1);
		expect(events[0].updatedAtMs).toBe(Date.parse("2026-07-30T08:00:03.000Z"));
	});

	it("skips a session the database already holds at or past its instant, without reading it", async () => {
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession()],
			isAlreadyCurrent: () => true,
		});
		expect(events).toEqual([]);
		// The whole point of the skip: the expensive transcript parse never happens.
		expect(readTranscript).not.toHaveBeenCalled();
	});

	it("passes source, id and instant to the skip predicate", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const seen: Array<[string, string, number]> = [];
		await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession(), claudeSession({ source: "cursor", sessionId: "c1" })],
			isAlreadyCurrent: (source, sessionId, updatedAtMs) => {
				seen.push([source, sessionId, updatedAtMs]);
				return source === "cursor";
			},
		});
		expect(seen).toContainEqual(["claude", "s1", Date.parse("2026-07-30T08:00:00.000Z")]);
		expect(seen).toContainEqual(["cursor", "c1", Date.parse("2026-07-30T08:00:00.000Z")]);
	});

	it("re-reads a session whose stored instant is older than the disk one", async () => {
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));
		const stored = Date.parse("2026-07-27T00:00:00.000Z");
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			// A three-day-old conversation the user has just resumed. A repo-wide
			// high-water mark would skip this; a per-session compare must not.
			loadSessions: async () => [claudeSession({ updatedAt: "2026-07-30T00:00:00.000Z" })],
			isAlreadyCurrent: (_source, _sessionId, updatedAtMs) => stored >= updatedAtMs,
		});
		expect(events).toHaveLength(1);
	});

	it("adds pre-scanned Codex rollouts whose working directory matches the repo", async () => {
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [],
			preScanned: { codex: [codexDiskSession()] },
		});
		expect(events).toEqual([expect.objectContaining({ source: "codex", sessionId: "x1" })]);
		// Codex writes JSONL, so it shares the one reader Claude uses — with its own
		// parser, which is the part that must be right. The tier used to open Claude's
		// transcript alone and hand every other agent a bare session row.
		const [path, , parser] = vi.mocked(readTranscript).mock.calls[0];
		expect(path).toBe("/t/x1.jsonl");
		expect(parser?.constructor.name).toBe("CodexTranscriptParser");
	});

	it("drops a pre-scanned Codex rollout belonging to another repo", async () => {
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [],
			preScanned: { codex: [codexDiskSession({ dirs: ["/somewhere/else"] })] },
		});
		expect(events).toEqual([]);
	});

	it("does not scan Codex again when a pre-scan was supplied", async () => {
		// The whole point of hoisting it: a per-repo scan on top of the run-wide one
		// would read `~/.codex/sessions/` twice per repo instead of once per run.
		await loadAllSessions("/w", undefined, { codex: [codexDiskSession()] });

		expect(discoverCodexSessions).not.toHaveBeenCalled();
	});

	it("treats an EMPTY pre-scan as already scanned, not as no scan", async () => {
		// The distinction the whole `PreScannedSessions` shape rests on: `[]` is the
		// positive claim "the scan ran and found nothing", so the per-repo loader must
		// still be skipped. Reading `[]` as "nothing supplied" would re-scan the store
		// for every repo — silently, since both spellings produce zero sessions.
		await loadAllSessions("/w", undefined, { codex: [] });

		expect(discoverCodexSessions).not.toHaveBeenCalled();
	});

	it("does scan Codex when no pre-scan was supplied", async () => {
		// Every caller outside the back-fill relies on this — the sidebar, `jolli status`
		// and the post-commit summary all pass nothing and must still get the source.
		await loadAllSessions("/w");

		expect(discoverCodexSessions).toHaveBeenCalledWith("/w", undefined);
	});

	// Every hookless source reads a machine-global store, so every one of them can be
	// pre-scanned once for a whole multi-repo run and narrowed here. The two halves are
	// asserted together on purpose: a source that narrows correctly but is not skipped
	// by the fan-out reads its store twice per repo, and a source that is skipped but
	// does not narrow disappears from the run — both are silent, and both produce a
	// plausible-looking result.
	// `PreScannedSessions` is keyed by `TranscriptSource` itself, so the key IS the
	// source — spelled once here rather than as a parallel camelCase column, which is
	// what let three of these sit unmatched: an unknown key narrows to nothing, and
	// the "belongs to another repo" half of each pair expects nothing anyway, so only
	// one of the two assertions could ever notice.
	//
	// `lineOriented` marks the sources whose transcript is a JSONL file. Those share
	// the one `readTranscript` entry point (with their own parser) — see
	// LINE_ORIENTED_SOURCES in TranscriptSourceReader; the rest own a reader over a
	// JSON file or a SQLite store and never reach it.
	const HOISTED = [
		{ source: "kimi", lineOriented: true },
		{ source: "opencode", lineOriented: false },
		{ source: "copilot", lineOriented: false },
		{ source: "copilot-chat", lineOriented: false },
		{ source: "cline", lineOriented: false },
		{ source: "cline-cli", lineOriented: false },
		{ source: "devin", lineOriented: false },
		{ source: "cursor-cli", lineOriented: false },
		{ source: "antigravity", lineOriented: false },
	] as const;

	for (const { source, lineOriented } of HOISTED) {
		const key = source;
		it(`adds pre-scanned ${source} sessions whose directory matches the repo`, async () => {
			const events = await collectSessionEvents({
				repoIdentity: "r",
				cwd: WORKTREE,
				loadSessions: async () => [],
				preScanned: { [key]: [diskEntry(source, `${source}-1`)] },
			});
			expect(events).toEqual([expect.objectContaining({ source, sessionId: `${source}-1` })]);
			// A JSONL source is read through the shared entry point; a store-backed one
			// is read by its own module and must never reach it — handing a SQLite file
			// to a line parser does not fail, it reports an empty conversation.
			if (lineOriented) expect(readTranscript).toHaveBeenCalled();
			else expect(readTranscript).not.toHaveBeenCalled();
		});

		it(`drops a pre-scanned ${source} session belonging to another repo`, async () => {
			const events = await collectSessionEvents({
				repoIdentity: "r",
				cwd: WORKTREE,
				loadSessions: async () => [],
				preScanned: { [key]: [diskEntry(source, `${source}-1`, ["/somewhere/else"])] },
			});
			expect(events).toEqual([]);
		});
	}

	it("drops a pre-scanned session that recorded no directory at all", async () => {
		// An empty `dirs` must match NOTHING. The tempting reading — no directories,
		// therefore no objection, therefore keep it — would attach the session to every
		// repo on the machine.
		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [],
			preScanned: { kimi: [diskEntry("kimi", "k1", [])] },
		});
		expect(events).toEqual([]);
	});

	it("does not skip a session whose instant cannot be parsed", async () => {
		const predicate = vi.fn(() => true);
		await collectSessionEvents({
			repoIdentity: "r",
			cwd: "/w",
			loadSessions: async () => [claudeSession({ updatedAt: "not-a-date" })],
			isAlreadyCurrent: predicate,
		});
		// Being unable to date a session is a reason to look at it, not to assume
		// it is current — so the predicate is never consulted for it.
		expect(predicate).not.toHaveBeenCalled();
	});

	it("keeps the other sources' sessions when one source's NARROWING throws", async () => {
		// Narrowing is real I/O for two sources (Antigravity enumerates the repo's
		// worktrees, Cursor resolves a workspace hash), so a failure here is a live
		// mode rather than a defensive catch — and it must cost that source alone.
		// A payload of the wrong shape is the cheapest way to make one throw: every
		// narrowing starts by iterating the scan it was handed.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(readTranscript).mockResolvedValue(transcript({ usageByModel: [] }));

		const events = await collectSessionEvents({
			repoIdentity: "r",
			cwd: WORKTREE,
			loadSessions: async () => [],
			preScanned: {
				kimi: "not an array" as unknown as ReadonlyArray<unknown>,
				opencode: [diskEntry("opencode", "oc1")],
			},
		});

		expect(events.map((e) => e.sessionId)).toEqual(["oc1"]);
		warn.mockRestore();
	});
});

describe("sessionPassKey", () => {
	it("joins the source and the session id", () => {
		expect(sessionPassKey("claude", "s1")).toBe("claude:s1");
	});

	it("reads the source back off a key", () => {
		expect(sourceOfSessionPassKey("copilot-chat:abc")).toBe("copilot-chat");
	});

	it("keeps only the FIRST segment, so an id containing a colon cannot shift the source", () => {
		expect(sourceOfSessionPassKey("cursor:a:b:c")).toBe("cursor");
	});

	it("answers the whole string for a key with no separator at all", () => {
		// Nothing produces such a key today — every one comes from `sessionPassKey`. The
		// fallback exists so a malformed key degrades to a wrong-looking agent NAME in a
		// report rather than to an empty label that reads as a missing agent.
		expect(sourceOfSessionPassKey("nocolon")).toBe("nocolon");
	});
});

describe("loadAllSessions (default loader)", () => {
	it("aggregates across discoverers and survives one of them throwing", async () => {
		vi.mocked(loadRegistrySessions).mockRejectedValue(new Error("registry unreadable"));
		// Every other discoverer scans a directory with no agent stores → empty.
		const sessions = await loadAllSessions("/tmp/definitely-no-agents-here");
		expect(Array.isArray(sessions)).toBe(true);
	});

	it("returns registry sessions when that loader succeeds", async () => {
		vi.mocked(loadRegistrySessions).mockResolvedValue([claudeSession()]);
		const sessions = await loadAllSessions("/tmp/definitely-no-agents-here");
		expect(sessions).toContainEqual(claudeSession());
	});
});

describe("collectCommitEvents", () => {
	const SEP = "\u001f";
	const REC = "\u0001";

	it("combines git log with summary-index enrichment, attributing the recorded branch", async () => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") {
				return git(
					[
						`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}Foster${SEP}f@x.com${SEP}feat: one`,
						`bbb${SEP}2026-07-29T08:00:00+08:00${SEP}Foster${SEP}f@x.com${SEP}fix: two`,
					].join("\n"),
				);
			}
			// The numstat pass is a separate `git log`, prefixed with -c.
			if (args[0] === "-c") {
				return git(
					[`${REC}aaa`, "10\t2\tsrc/a.ts", "-\t-\tdocs/logo.png", `${REC}bbb`, "1\t0\tsrc/a.ts"].join("\n"),
				);
			}
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "feat: one",
					commitDate: "2026-07-30",
					branch: "feature/x",
					generatedAt: "t",
					diffStats: { filesChanged: 3, insertions: 10, deletions: 2 },
				},
			],
		});

		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			hash: "aaa",
			message: "feat: one",
			authorName: "Foster",
			branch: "feature/x", // recorded branch from the summary index
			// The SAME fact as `branch`, as a one-element list — not a reachability
			// union. No `rev-list` is run at all any more.
			branches: ["feature/x"],
			filesChanged: 3,
			insertions: 10,
			deletions: 2,
		});
		expect(events[0]?.files).toEqual([
			{ path: "src/a.ts", insertions: 10, deletions: 2 },
			// Binary: git prints "-", so neither count is recorded rather than 0.
			{ path: "docs/logo.png" },
		]);
		// `bbb` has no summary entry, so nothing records a branch for it: `[]`, which
		// CLEARS any stored attribution rather than leaving a stale one behind.
		expect(events[1]).toMatchObject({ hash: "bbb", branches: [] });
		expect(events[1]?.files).toEqual([{ path: "src/a.ts", insertions: 1, deletions: 0 }]);
		expect(events[1]).not.toHaveProperty("filesChanged");
	});

	// The churn regression. `for-each-ref --sort=-committerdate` + `slice(0, 50)`
	// was an UNSTABLE window on a repo past the cap: a commit on ANY branch
	// reorders it. `unchangedCommitEvent` compares `branches` for exact set
	// equality, so a window that swaps one member re-projected every commit the
	// window reached — forever, never converging. Measured on a 350-branch repo:
	// 11,953 commits re-enqueued per shift and 24.6 MB of duplicate `events_raw`
	// rows, plus branch attribution that was a moving target because `branches` is
	// replace-when-present. The fix makes the value depend only on the summary's
	// recorded branch, which is a historical fact and cannot reshuffle.
	const collectWithBranchWindow = async (branchList: ReadonlyArray<string>, recordedBranch = "feature/x") => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}one`);
			if (args[0] === "for-each-ref") return git(`${branchList.join("\n")}\n`);
			// Every branch reaches the commit, which is the normal shape: old feature
			// branches all contain main's history.
			if (args[0] === "rev-list") return git("aaa\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "one",
					commitDate: "2026-07-30",
					branch: recordedBranch,
					generatedAt: "t",
				},
			],
		});
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		return events[0]?.branches;
	};

	it("emits a stable branches value when the branch window reshuffles", async () => {
		const many = Array.from({ length: 60 }, (_, i) => `b${i}`);
		const first = await collectWithBranchWindow(many);
		// One branch enters the window and one falls out — exactly what a single
		// commit on any branch does to a `-committerdate` sort.
		const second = await collectWithBranchWindow(["newcomer", ...many.slice(0, 59)]);
		expect(second).toEqual(first);
		// And the value is the commit's recorded branch, not a reachability union.
		expect(first).toEqual(["feature/x"]);
	});

	it("passes --since through to log and rev-list when given", async () => {
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") return git("");
			if (args[0] === "for-each-ref") return git("main\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		await collectCommitEvents({ repoIdentity: "r", cwd: "/w", sinceMs: 1_700_000_000_000 });
		const logCall = calls.find((c) => c[0] === "log");
		expect(logCall?.join(" ")).toContain("--since=2023-11-14T22:13:20.000Z");
	});

	it("scopes both log passes to local branches and HEAD, never --all", async () => {
		// The commit pass and the file-stats pass must agree with the attribution
		// loop, which walks refs/heads. Under `--all` a commit living only on a
		// remote-tracking ref or a tag was imported as this machine's work and then
		// displayed with no branch, because refs/heads could not explain it.
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "for-each-ref") return git("main\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		const logPasses = calls.filter((c) => c[0] === "log" || c[0] === "-c");
		expect(logPasses).toHaveLength(2);
		for (const pass of logPasses) {
			expect(pass).toContain("--branches");
			expect(pass).toContain("HEAD");
			expect(pass).not.toContain("--all");
		}
	});

	it("excludes Jolli's own storage refs from both log passes", async () => {
		// The orphan branch is a local branch like any other, so every ref-scoped
		// call here picks it up unless told not to — and it holds one commit PER
		// MEMORY. Measured on this repo before the exclusion: 1800 of 2468 stored
		// commits were `Add summary for …`.
		//
		// The attribution half of this test is gone with the reachability scan; the
		// namespace-vs-prefix rule it also covered now has direct tests in
		// `core/JolliRefs.test.ts`, next to the function that owns it.
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}one`);
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		// Two ways to get this wrong silently, so both are pinned. `--exclude` is
		// positional — it applies only to the selector that FOLLOWS it — and its
		// pattern is relative to that selector, so the `refs/heads/`-prefixed form
		// matches nothing under `--branches` and is ignored without a word.
		const logPasses = calls.filter((c) => c[0] === "log" || c[0] === "-c");
		expect(logPasses.length).toBeGreaterThan(0);
		for (const pass of logPasses) {
			expect(pass.indexOf("--exclude=jollimemory/*")).toBe(pass.indexOf("--branches") - 1);
		}
	});

	it("runs no per-branch rev-list at all", async () => {
		// The 350 subprocesses this replaced were both the cost and the churn: the
		// window they were driven from reshuffled on every commit. Pinned as a call
		// shape because a reintroduced `rev-list` would still produce correct-looking
		// output — it is the instability, not the values, that was wrong.
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}one`);
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(calls.filter((c) => c[0] === "rev-list")).toEqual([]);
		expect(calls.filter((c) => c[0] === "for-each-ref")).toEqual([]);
	});

	it("scans --numstat only for commits the caller has not stored", async () => {
		// The one expensive step in this collection (6.3 s → 0.44 s on a real 2.5k
		// commit history), and the reason a moved branch tip no longer costs a
		// whole-history scan. A commit's diff is immutable, so a stored hash can
		// never need re-scanning.
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") {
				return git(
					[
						`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}new`,
						`bbb${SEP}2026-07-29T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}old`,
					].join("\n"),
				);
			}
			if (args[0] === "for-each-ref") return git("main\n");
			if (args[0] === "rev-list") return git("aaa\nbbb\n");
			if (args[0] === "-c") return git([`${REC}aaa`, "1\t0\tsrc/a.ts"].join("\n"));
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		vi.mocked(getIndex).mockResolvedValue(null);

		const events = await collectCommitEvents({
			repoIdentity: "r",
			cwd: "/w",
			knownHashes: new Set(["bbb"]),
		});

		// `--no-walk <hash>` for the new commit only — never the whole-history form.
		const numstat = calls.find((c) => c[0] === "-c");
		expect(numstat).toContain("--no-walk");
		expect(numstat).toContain("aaa");
		expect(numstat).not.toContain("bbb");
		// Both commits are still emitted: the commit list is what the prune is
		// computed against, and branch reachability changes for OLD commits every
		// time a branch moves — neither may be narrowed to the new arrivals.
		expect(events.map((e) => e.hash)).toEqual(["aaa", "bbb"]);
		expect(events[0].files).toHaveLength(1);
		// ABSENT, not empty: absent means "keep the stored rows", while `[]` would
		// claim the commit touches no files and delete them.
		expect(events[1]).not.toHaveProperty("files");
	});

	it("never re-asks numstat for a merge commit, which has no file rows to find", async () => {
		// A merge shows no diff under `git log --numstat`, so it can never acquire
		// `commit_files` rows — and the caller's "which commits have file rows" set
		// therefore never contains it. Retrying it on every sweep would be pure
		// waste, and in a merge-heavy history enough of them to push past
		// INCREMENTAL_NUMSTAT_LIMIT and drag the whole-history scan back in.
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") {
				return git(
					[
						// %P rides last: two parents = merge, one = ordinary commit.
						`mmm${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}merge${SEP}p1 p2`,
						`aaa${SEP}2026-07-29T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}new${SEP}p1`,
					].join("\n"),
				);
			}
			if (args[0] === "for-each-ref") return git("main\n");
			if (args[0] === "rev-list") return git("mmm\naaa\n");
			if (args[0] === "-c") return git([`${REC}aaa`, "1\t0\tsrc/a.ts"].join("\n"));
			throw new Error(`unexpected git ${args.join(" ")}`);
		});
		vi.mocked(getIndex).mockResolvedValue(null);

		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w", knownHashes: new Set() });

		const numstat = calls.find((c) => c[0] === "-c");
		expect(numstat).toContain("aaa");
		expect(numstat).not.toContain("mmm");
		// Still emitted, and still ABSENT rather than `[]` — the merge keeps whatever
		// the projection holds instead of claiming it touches nothing.
		expect(events.map((e) => e.hash)).toEqual(["mmm", "aaa"]);
		expect(events[0]).not.toHaveProperty("files");
		// The subject stays intact with the parent field appended after it.
		expect(events[0]?.message).toBe("merge");
	});

	it("falls back to the whole-history scan when too many commits are new", async () => {
		// The incremental form passes every hash as an argv entry, and Windows caps a
		// command line at ~32 KB — so past the limit it does not run slower, it fails
		// to spawn.
		const many = Array.from({ length: 401 }, (_, i) => `h${i}`);
		const calls: string[][] = [];
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			calls.push([...args]);
			if (args[0] === "log") {
				return git(
					many.map((h) => `${h}${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x.com${SEP}m`).join("\n"),
				);
			}
			if (args[0] === "for-each-ref") return git("main\n");
			return git("");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		await collectCommitEvents({ repoIdentity: "r", cwd: "/w", knownHashes: new Set() });
		const numstat = calls.find((c) => c[0] === "-c");
		expect(numstat).not.toContain("--no-walk");
		expect(numstat).toContain("--branches");
	});

	it("still emits commits when only the numstat pass fails, without a files field", async () => {
		// The numstat pass is deliberately separate so its failure costs file
		// detail and nothing else — this is the test that pins that down.
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "-c") return gitFail("numstat exploded");
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}feat: one`);
			if (args[0] === "for-each-ref") return git("main\n");
			return git("aaa\n");
		});
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events).toHaveLength(1);
		// Absent, not empty — an empty array would delete rows a previous pass got.
		expect(events[0]).not.toHaveProperty("files");
	});

	it("THROWS when git log fails rather than reporting an empty history", async () => {
		// [] is a claim, not an absence: the caller prunes every stored commit the
		// collection did not list. `execGit` reports a >10 MB stdout overflow as
		// exit 1, so a large history reached this branch and wiped the commit layer.
		vi.mocked(execGit).mockResolvedValue(gitFail("not a repo"));
		vi.mocked(getIndex).mockResolvedValue(null);
		await expect(collectCommitEvents({ repoIdentity: "r", cwd: "/w" })).rejects.toThrow(/git log failed/);
	});

	// `branches` is REPLACE-when-present in the projection, so ABSENT vs EMPTY is
	// the whole guard, and the three next tests are the set that pins it:
	//   `[]`        → "the index records no branch for this commit" → CLEARS its rows
	//   `undefined` → "no index loaded, so could not tell"          → LEAVES them
	// Collapsing them either way is a silent bug in one direction or the other.
	const logOneCommit = () => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`aaa${SEP}2026-07-30T08:00:00+08:00${SEP}F${SEP}f@x${SEP}feat: one`);
			return git("");
		});
	};

	it("omits branches entirely when the summary index throws", async () => {
		// "Could not tell", so the stored attribution has to survive it — one
		// unreadable index must not wipe the repo's branch rows in a single pass.
		logOneCommit();
		vi.mocked(getIndex).mockRejectedValue(new Error("index unreadable"));
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events).toHaveLength(1);
		expect(events[0]).not.toHaveProperty("branches");
	});

	it("omits branches entirely when the summary index resolves null", async () => {
		// THE REGRESSION THIS PINS. A resolved `null` used to be read as "readable,
		// records nothing" and emitted `[]`, which CLEARS every commit_branches row.
		// But `getIndex` resolves null for every genuine read failure too —
		// `FolderStorage` classifies EACCES/EIO to a warn + null, `readFileFromBranch`
		// does the same for a failed `git show`, and a malformed `index.json` is
		// swallowed at the `JSON.parse` — so a throw is the rare shape and that guard
		// protected almost nothing. One EACCES wiped the repo's whole attribution, and
		// since the pass is otherwise complete the cursor advances and the next sweep
		// skips collection, so the blank outlived the failure.
		//
		// Absent is the safe reading of BOTH cases: a repo that has no index yet keeps
		// rows an older client stored, and those are invisible until an index exists
		// (the only query reading them inner-joins `memories`), at which point a commit
		// the index does not mention gets `[]` and clears them anyway.
		logOneCommit();
		vi.mocked(getIndex).mockResolvedValue(null);
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events[0]).not.toHaveProperty("branches");
	});

	it("emits an empty branches array for an index entry carrying no branch name", async () => {
		// The EMPTY half of the pair, and the one that keeps a mid-transition database
		// converging: an index that loaded is a real answer, so a commit it records
		// nothing for must clear its old reachability rows rather than keep them.
		// (The other shape of this — a loaded index that has no entry for the commit
		// at all — is `bbb` in the first test of this describe.)
		//
		// `SummaryIndexEntry.branch` is a required
		// `string`, so the empty value is the type-legal shape of "recorded nothing";
		// a legacy on-disk entry written before the field existed reaches the same
		// falsy path (the type already documents that legacy entries omit fields —
		// see `parentCommitHash`'s `undefined` case). Both must clear, not preserve.
		logOneCommit();
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{
					commitHash: "aaa",
					parentCommitHash: null,
					commitMessage: "feat: one",
					commitDate: "2026-07-30",
					branch: "",
					generatedAt: "t",
				},
			],
		});
		const events = await collectCommitEvents({ repoIdentity: "r", cwd: "/w" });
		expect(events[0]?.branches).toEqual([]);
		expect(events[0]).not.toHaveProperty("branch");
	});

	it("skips malformed log lines and survives a missing summary index", async () => {
		vi.mocked(execGit).mockImplementation(async (args: ReadonlyArray<string>) => {
			if (args[0] === "log") return git(`ccc${SEP}not-a-date${SEP}a${SEP}b${SEP}subject\n\n`);
			if (args[0] === "for-each-ref") return gitFail("boom");
			return git("");
		});
		vi.mocked(getIndex).mockRejectedValue(new Error("no orphan branch"));
		expect(await collectCommitEvents({ repoIdentity: "r", cwd: "/w" })).toEqual([]);
	});
});

describe("parseNumstatLog", () => {
	const REC = "\u0001";

	it("keeps a merge commit as an empty list rather than dropping it", () => {
		// A merge shows no diff under --numstat, so its record has no rows. That
		// is "changed nothing", which is different from "not collected" — the
		// latter must stay expressible as an ABSENT map entry.
		const parsed = parseNumstatLog([`${REC}merge1`, `${REC}real1`, "3\t1\tsrc/a.ts"].join("\n"));
		expect(parsed.get("merge1")).toEqual([]);
		expect(parsed.get("real1")).toEqual([{ path: "src/a.ts", insertions: 3, deletions: 1 }]);
	});

	it("skips a line that did not split into three fields instead of storing a broken path", () => {
		const parsed = parseNumstatLog([`${REC}c1`, "1\t2", "", "4\t5\tsrc/ok.ts"].join("\n"));
		expect(parsed.get("c1")).toEqual([{ path: "src/ok.ts", insertions: 4, deletions: 5 }]);
	});

	it("caps a mechanical commit rather than storing thousands of paths", () => {
		const lines = [`${REC}huge`];
		for (let i = 0; i < 250; i++) lines.push(`1\t1\tvendor/f${i}.js`);
		const parsed = parseNumstatLog(lines.join("\n"));
		expect(parsed.get("huge")).toHaveLength(200);
	});

	it("keeps non-ASCII paths verbatim", () => {
		const parsed = parseNumstatLog([`${REC}c1`, "1\t0\t\u6587\u6863/\u8bf4\u660e.md"].join("\n"));
		expect(parsed.get("c1")?.[0]?.path).toBe("\u6587\u6863/\u8bf4\u660e.md");
	});
});

describe("collectFilesForCommits", () => {
	const REC = "\u0001";

	it("returns an empty map for no hashes without spawning git", async () => {
		vi.mocked(execGit).mockClear();
		expect((await collectFilesForCommits([], "/w")).size).toBe(0);
		expect(execGit).not.toHaveBeenCalled();
	});

	it("returns an empty map when git fails, so the caller omits files rather than clearing them", async () => {
		vi.mocked(execGit).mockResolvedValue(gitFail("bad object"));
		expect((await collectFilesForCommits(["aaa"], "/w")).size).toBe(0);
		// One hash has nothing to bisect: exactly one call, no retry.
		expect(execGit).toHaveBeenCalledTimes(1);
	});

	it("bisects a failing batch so one unreadable commit does not blank the rest", async () => {
		// The failure mode this exists for: a diff past execGit's maxBuffer fails
		// the whole `--no-walk` call, identically on every retry. Returning empty
		// for the batch denies file rows to the other commits, and since the next
		// sweep asks which commits HAVE file rows, the same doomed batch comes back
		// forever. Here `poison` fails whenever it is in the argv.
		vi.mocked(execGit).mockClear();
		vi.mocked(execGit).mockImplementation(async (args) => {
			const hashes = args.filter((a) => /^[a-z]\d$/.test(a));
			if (hashes.includes("p1")) return gitFail("stdout maxBuffer length exceeded");
			return git(hashes.map((h) => `${REC}${h}\n1\t0\tf-${h}.ts`).join("\n"));
		});

		const files = await collectFilesForCommits(["a1", "b1", "p1", "c1"], "/w");

		expect([...files.keys()].sort()).toEqual(["a1", "b1", "c1"]);
		expect(files.get("a1")?.[0]?.path).toBe("f-a1.ts");
	});

	it("stops bisecting a wholly broken repo instead of one call per commit", async () => {
		// Same failure shape covers "git is broken here", where splitting can only
		// spend subprocesses. The budget caps the damage at a flat handful rather
		// than ~2N on every sweep, forever.
		vi.mocked(execGit).mockClear();
		vi.mocked(execGit).mockResolvedValue(gitFail("not a git repository"));
		const hashes = Array.from({ length: 200 }, (_, i) => `h${i}`);

		expect((await collectFilesForCommits(hashes, "/w")).size).toBe(0);

		expect(vi.mocked(execGit).mock.calls.length).toBeLessThan(30);
	});
});

describe("collectWorktreeEvent", () => {
	it("passes the current branch to the observation", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("main");
		vi.mocked(execGit).mockResolvedValue(git(" 1 file changed, 2 insertions(+)"));
		const event = await collectWorktreeEvent("r", "/w", () => 7);
		expect(event).toMatchObject({ branch: "main", filesChanged: 1, insertions: 2, deletions: 0, observedAtMs: 7 });
	});

	it("maps detached HEAD to no branch (the '' sentinel downstream)", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("HEAD");
		vi.mocked(execGit).mockResolvedValue(git(""));
		const event = await collectWorktreeEvent("r", "/w");
		expect(event).not.toHaveProperty("branch");
	});

	it("still observes when the branch lookup itself fails", async () => {
		vi.mocked(getCurrentBranch).mockRejectedValue(new Error("no HEAD"));
		vi.mocked(execGit).mockResolvedValue(git(""));
		const event = await collectWorktreeEvent("r", "/w");
		expect(event).toMatchObject({ filesChanged: 0 });
	});
});

describe("summaryEventFromCommitSummary", () => {
	const baseSummary = {
		version: 5,
		commitHash: "abc123",
		commitMessage: "feat: dashboard\n\nlong body",
		commitAuthor: "Dev",
		commitDate: "2026-07-30T09:00:00Z",
		branch: "feature/dash",
		generatedAt: "2026-07-30T09:01:00Z",
		ticketId: "JOLLI-2069",
		conversationTurns: 12,
		conversationTokens: 34000,
		estimatedCostUsd: 2.5,
		topics: [
			{
				title: "Storage",
				trigger: "t",
				response: "r",
				decisions: "Use node:sqlite",
				todo: "add FTS later",
			},
			{ title: "Empty", trigger: "t", response: "r", decisions: "  " },
		],
		references: [
			{
				archivedKey: "linear:JOLLI-2069-abc1234",
				source: "linear",
				nativeId: "JOLLI-2069",
				title: "Dashboard",
				url: "https://linear.app/x",
				referencedAt: "t",
				sourceToolName: "Linear",
			},
		],
		transcripts: ["t1"],
		// biome-ignore lint/suspicious/noExplicitAny: minimal CommitSummary fixture
	} as any;

	const entry = { role: "human" as const, content: "x" };
	const transcripts = new Map([
		[
			"t1",
			{
				sessions: [
					{ sessionId: "s1", source: "claude" as const, entries: [entry, entry, entry] },
					{ sessionId: "s1", source: "claude" as const, entries: [entry] }, // duplicate — deduped
				],
			},
		],
	]);

	it("maps memory fields, insights, references and exact session links", () => {
		const event = summaryEventFromCommitSummary("repo-1", baseSummary, transcripts);
		expect(event).toMatchObject({
			type: "commit.summary",
			repoIdentity: "repo-1",
			hash: "abc123",
			branch: "feature/dash",
			message: "feat: dashboard",
			turns: 12,
			tokens: 34000,
			estCostUsd: 2.5,
			ticketId: "JOLLI-2069",
		});
		expect(event?.insights).toEqual([
			{ kind: "decision", text: "Use node:sqlite" },
			{ kind: "todo", text: "add FTS later" },
		]);
		expect(event?.references).toEqual([
			{ source: "linear", nativeId: "JOLLI-2069", title: "Dashboard", url: "https://linear.app/x" },
		]);
		expect(event?.sessionLinks).toEqual([
			{ source: "claude", sessionId: "s1", confidence: "exact", messageCount: 3 },
		]);
	});

	it("carries a stored session's own usageByModel into its link, priced", () => {
		const withUsage = new Map([
			[
				"t1",
				{
					sessions: [
						{
							sessionId: "s1",
							source: "claude" as const,
							entries: [entry],
							usageByModel: [
								{
									model: "claude-opus-4-8",
									provider: "anthropic" as const,
									input: 100,
									output: 50,
									cached: 10,
								},
							],
						},
					],
				},
			],
		]);
		const event = summaryEventFromCommitSummary("repo-1", baseSummary, withUsage);
		expect(event?.sessionLinks).toEqual([
			{
				source: "claude",
				sessionId: "s1",
				confidence: "exact",
				messageCount: 1,
				models: [
					expect.objectContaining({
						model: "claude-opus-4-8",
						inputTokens: 100,
						outputTokens: 50,
						cachedTokens: 10,
					}),
				],
			},
		]);
		expect(event?.sessionLinks?.[0].models?.[0].estCostUsd).toBeGreaterThan(0);
	});

	it("attributes an archived skill to the session its usage split names", () => {
		const withSession = new Map([
			["t1", { sessions: [{ sessionId: "s1", source: "claude" as const, entries: [entry] }] }],
		]);
		const event = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						archivedKey: "claude:jolli-recall-abc",
						source: "claude" as const,
						skill: "jolli-recall",
						entryPaths: ["tool" as const],
						invocationCount: 3,
						firstUsedAt: "2026-08-06T01:24:50.313Z",
						lastUsedAt: "2026-08-06T01:24:50.313Z",
						usageBySession: {
							"claude:s1": { input: 8, cached: 13730, output: 5215, confidence: "attributed" as const },
						},
					},
				],
			},
			withSession,
		);
		expect(event?.sessionLinks?.[0].tools).toEqual([{ name: "jolli-recall", kind: "skill", calls: 3 }]);
	});

	it("falls back to the memory's single link of the ref's source when there is no usage split", () => {
		// codex archives a heuristic ref with no usageBySession — still unambiguous
		// when the memory has exactly one codex session.
		const withSession = new Map([
			["t1", { sessions: [{ sessionId: "cx", source: "codex" as const, entries: [entry] }] }],
		]);
		const event = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						archivedKey: "codex:jolli-recall-f4f",
						source: "codex" as const,
						skill: "jolli-recall",
						entryPaths: ["tool" as const],
						invocationCount: 1,
						firstUsedAt: "2026-08-07T09:11:15.043Z",
						lastUsedAt: "2026-08-07T09:11:15.043Z",
						detection: "heuristic" as const,
					},
				],
			},
			withSession,
		);
		expect(event?.sessionLinks?.[0].tools).toEqual([{ name: "jolli-recall", kind: "skill", calls: 1 }]);
	});

	it("skips a skill no single session can own rather than splitting its call count", () => {
		const twoSessions = new Map([
			[
				"t1",
				{
					sessions: [
						{ sessionId: "s1", source: "claude" as const, entries: [entry] },
						{ sessionId: "s2", source: "claude" as const, entries: [entry] },
					],
				},
			],
		]);
		const skill = {
			archivedKey: "claude:dataviz-abc",
			source: "claude" as const,
			skill: "dataviz",
			entryPaths: ["tool" as const],
			invocationCount: 4,
			firstUsedAt: "2026-08-06T01:00:00.000Z",
			lastUsedAt: "2026-08-06T02:00:00.000Z",
		};
		// (a) a split naming two sessions — no per-session count exists
		const spanning = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						...skill,
						usageBySession: {
							"claude:s1": { input: 1, cached: 0, output: 1, confidence: "attributed" as const },
							"claude:s2": { input: 1, cached: 0, output: 1, confidence: "attributed" as const },
						},
					},
				],
			},
			twoSessions,
		);
		// (b) no split at all, and the source names two candidates
		const ambiguous = summaryEventFromCommitSummary("repo-1", { ...baseSummary, skills: [skill] }, twoSessions);

		for (const event of [spanning, ambiguous]) {
			for (const link of event?.sessionLinks ?? []) expect(link).not.toHaveProperty("tools");
		}
	});

	it("never overwrites a transcript-derived skill count with the archived one", () => {
		// `parseToolUse` already emits kind:"skill" rows off the transcript's own
		// blocks; the archived ref is a gap-filler, not a competing source.
		const withTools = new Map([
			[
				"t1",
				{
					sessions: [
						{
							sessionId: "s1",
							source: "claude" as const,
							entries: [entry],
							toolUse: [{ name: "jolli-recall", kind: "skill" as const, calls: 7 }],
						},
					],
				},
			],
		]);
		const event = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						archivedKey: "claude:jolli-recall-abc",
						source: "claude" as const,
						skill: "jolli-recall",
						entryPaths: ["tool" as const],
						invocationCount: 1,
						firstUsedAt: "2026-08-06T01:24:50.313Z",
						lastUsedAt: "2026-08-06T01:24:50.313Z",
						usageBySession: {
							"claude:s1": { input: 8, cached: 13730, output: 5215, confidence: "attributed" as const },
						},
					},
				],
			},
			withTools,
		);
		expect(event?.sessionLinks?.[0].tools).toEqual([{ name: "jolli-recall", kind: "skill", calls: 7 }]);
	});

	it("appends an archived skill alongside the transcript's other tools", () => {
		const withTools = new Map([
			[
				"t1",
				{
					sessions: [
						{
							sessionId: "s1",
							source: "claude" as const,
							entries: [entry],
							toolUse: [{ name: "Bash", kind: "builtin" as const, calls: 2 }],
						},
					],
				},
			],
		]);
		const event = summaryEventFromCommitSummary(
			"repo-1",
			{
				...baseSummary,
				skills: [
					{
						archivedKey: "claude:dataviz-abc",
						source: "claude" as const,
						skill: "dataviz",
						entryPaths: ["tool" as const],
						invocationCount: 2,
						firstUsedAt: "2026-08-06T01:00:00.000Z",
						lastUsedAt: "2026-08-06T02:00:00.000Z",
						usageBySession: {
							"claude:s1": { input: 1, cached: 0, output: 1, confidence: "attributed" as const },
						},
					},
				],
			},
			withTools,
		);
		expect(event?.sessionLinks?.[0].tools).toEqual([
			{ name: "Bash", kind: "builtin", calls: 2 },
			{ name: "dataviz", kind: "skill", calls: 2 },
		]);
	});

	it("carries a stored session's toolUse into its link", () => {
		const withTools = new Map([
			[
				"t1",
				{
					sessions: [
						{
							sessionId: "s1",
							source: "claude" as const,
							entries: [entry],
							toolUse: [
								{ name: "Bash", kind: "builtin" as const, calls: 3 },
								{
									name: "jollimemory.recall",
									kind: "mcp" as const,
									server: "jollimemory",
									calls: 1,
								},
							],
						},
					],
				},
			],
		]);
		const event = summaryEventFromCommitSummary("repo-1", baseSummary, withTools);
		expect(event?.sessionLinks?.[0].tools).toEqual([
			{ name: "Bash", kind: "builtin", calls: 3 },
			{ name: "jollimemory.recall", kind: "mcp", server: "jollimemory", calls: 1 },
		]);
	});

	it("forwards an empty toolUse but omits the field when the memory recorded none", () => {
		// `[]` is the recorded fact "called no tools" and must reach the projection so
		// it can replace stale rows; absent means the memory predates the field (or the
		// source cannot report tools) and must leave existing rows standing.
		const session = (toolUse?: ReadonlyArray<{ name: string; kind: "builtin"; calls: number }>) =>
			new Map([
				[
					"t1",
					{
						sessions: [
							{
								sessionId: "s1",
								source: "claude" as const,
								entries: [entry],
								...(toolUse && { toolUse }),
							},
						],
					},
				],
			]);

		expect(summaryEventFromCommitSummary("repo-1", baseSummary, session([]))?.sessionLinks?.[0].tools).toEqual([]);
		expect(summaryEventFromCommitSummary("repo-1", baseSummary, session())?.sessionLinks?.[0]).not.toHaveProperty(
			"tools",
		);
	});

	it("returns null for an unparseable commit date", () => {
		const event = summaryEventFromCommitSummary("repo-1", { ...baseSummary, commitDate: "nope" }, new Map());
		expect(event).toBeNull();
	});

	it("tolerates a summary with no topics, references or transcripts", () => {
		const bare = { ...baseSummary, topics: undefined, references: undefined, transcripts: [] };
		const event = summaryEventFromCommitSummary("repo-1", bare, new Map());
		expect(event?.insights).toEqual([]);
		expect(event?.references).toEqual([]);
		expect(event?.sessionLinks).toEqual([]);
	});

	it("collectSummaryEvents projects ROOT summaries only and survives an unreadable one", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{ commitHash: "abc123", parentCommitHash: null },
				{ commitHash: "child1", parentCommitHash: "abc123" }, // child — skipped
				{ commitHash: "broken1", parentCommitHash: null },
				// biome-ignore lint/suspicious/noExplicitAny: minimal index fixture
			] as any,
		});
		vi.mocked(getSummary).mockImplementation(async (hash: string) => {
			if (hash === "abc123") return baseSummary;
			throw new Error("orphan read failed");
		});
		vi.mocked(readTranscriptsForCommits).mockResolvedValue(transcripts);

		const { events, complete } = await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" });

		expect(events).toHaveLength(1);
		expect(events[0].hash).toBe("abc123");
		expect(getSummary).toHaveBeenCalledTimes(2); // roots only, never the child
		// The whole point of surviving it: the caller must NOT advance its cursor,
		// or this sweep's blind spot becomes permanent.
		expect(complete).toBe(false);
	});

	it("collectSummaryEvents reports a clean sweep as complete", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			// biome-ignore lint/suspicious/noExplicitAny: minimal index fixture
			entries: [{ commitHash: "abc123", parentCommitHash: null }] as any,
		});
		vi.mocked(getSummary).mockResolvedValue(baseSummary);
		vi.mocked(readTranscriptsForCommits).mockResolvedValue(new Map());

		const { events, complete } = await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" });
		expect(events).toHaveLength(1);
		expect(complete).toBe(true);
	});

	// A root the index names but the store no longer has is "not there", not a
	// failure — pruning is normal, and treating it as a failure would stall the
	// cursor forever on a repo that has one.
	it("collectSummaryEvents treats a null summary as absent, not a failed read", async () => {
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			// biome-ignore lint/suspicious/noExplicitAny: minimal index fixture
			entries: [{ commitHash: "gone", parentCommitHash: null }] as any,
		});
		vi.mocked(getSummary).mockResolvedValue(null);

		const { events, complete } = await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" });
		expect(events).toEqual([]);
		expect(complete).toBe(true);
	});

	it("collectSummaryEvents returns empty and incomplete when there is no index", async () => {
		vi.mocked(getIndex).mockResolvedValue(null);
		// Incomplete, not complete-and-empty: an unreadable index says nothing
		// about what is stored, so the cursor must not move past it.
		expect(await collectSummaryEvents({ repoIdentity: "repo-1", cwd: "/w" })).toEqual({
			events: [],
			complete: false,
		});
	});
});
