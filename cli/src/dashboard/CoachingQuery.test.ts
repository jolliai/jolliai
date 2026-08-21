/**
 * Assembly over a real SoT database, exactly as `JourneysQuery.test.ts` does it:
 * a per-file temp database opened through `withDashboardDb`, which is what
 * CREATES the schema. `SotSchema.ts` exports its DDL in pieces, so it is never
 * hand-assembled here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCoaching } from "./CoachingQuery.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { withDashboardDb } from "./DashboardDb.js";

const DAY = 86_400_000;
const NOW = 1_754_000_000_000;

let dir: string;
let dbPath: string;
/** Seeds and assertions run inside one `withDashboardDb` call per test. */
let db: DashboardDbHandle;

function addRepo(id: number, identity: string): void {
	// `repos.enabled_at` is NOT NULL.
	db.prepare(
		"INSERT INTO repos (id, repo_identity, repo_name, worktree_root, enabled_at, bootstrap_state) VALUES (?, ?, ?, ?, ?, 'done')",
	).run(id, identity, identity, `/tmp/${identity}`, new Date(NOW).toISOString());
}

let journeySeq = 0;

/** One memory row — the commit a journey is assembled from. Models `JourneysQuery.test.ts`'s `addMemory`. Returns the commit hash so a caller can link a transcript to it. */
function seedJourney(over: {
	branch: string;
	planFirst: boolean;
	costUsd?: number;
	turns?: number;
	atMs?: number;
}): string {
	journeySeq += 1;
	const atMs = over.atMs ?? NOW;
	const hash = `jh${journeySeq}`;
	const summary = {
		commitHash: hash,
		commitMessage: `do journey work ${journeySeq}`,
		commitDate: new Date(atMs).toISOString(),
		branch: over.branch,
		...(over.turns === undefined ? {} : { conversationTurns: over.turns }),
		...(over.costUsd === undefined ? {} : { estimatedCostUsd: over.costUsd }),
		// Plan-FIRST: the plan must predate the commit. A `planFirst: false` case
		// simply carries no plan at all, which is already enough to make
		// `earliestPlanMs` null and `planFirst` false on the assembled journey.
		...(over.planFirst ? { plans: [{ slug: "p", title: "P", addedAt: new Date(atMs - DAY).toISOString() }] } : {}),
	};
	db.prepare(
		`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, summary_json, first_seen_ms, written_at_ms, commit_date_ms)
		 VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
	).run(1, hash, hash, JSON.stringify(summary), atMs, atMs, atMs);
	return hash;
}

/**
 * A transcript row carrying one session, plus its `memory_transcripts` link —
 * the shape `readJourneySessions` inflates. Models `FeedFriction.test.ts`'s
 * `addTranscript` (turn-abort case) and `JourneysQuery.test.ts`'s
 * `addWaitTranscript` (real entries case) in one helper, since a coaching-page
 * seed needs both signals available.
 */
function addJourneyTranscript(
	commitHash: string,
	over: {
		readonly source?: string;
		readonly turnAborts?: ReadonlyArray<number>;
		readonly entries?: ReadonlyArray<{ readonly role: "human" | "assistant"; readonly atMs: number }>;
	},
): void {
	const transcriptId = `t-${commitHash}`;
	const stored = {
		sessions: [
			{
				sessionId: `s-${commitHash}`,
				source: over.source ?? "codex",
				entries: (over.entries ?? []).map((e) => ({
					role: e.role,
					content: "x",
					timestamp: new Date(e.atMs).toISOString(),
				})),
				...(over.turnAborts === undefined ? {} : { turnAborts: over.turnAborts }),
			},
		],
	};
	const blob = deflateSync(Buffer.from(JSON.stringify(stored), "utf8"));
	db.prepare(
		"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
	).run(1, transcriptId, blob, NOW);
	db.prepare("INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)").run(
		1,
		commitHash,
		transcriptId,
	);
}

/**
 * A journey whose sole session reports a turn-abort count — `aborts: 0` still
 * sets `turnAborts: []` (present, empty) so the friction cell comes back
 * `measured` with `value: 0`, not `unavailable`: the flagged count's
 * denominator is journeys with MEASURABLE friction, and an omitted field would
 * put this journey outside that denominator instead of inside it at zero.
 */
function seedJourneyWithAborts(over: { branch: string; aborts: number; atMs?: number }): void {
	const hash = seedJourney({ branch: over.branch, planFirst: false, atMs: over.atMs });
	const atMs = over.atMs ?? NOW;
	addJourneyTranscript(hash, {
		turnAborts: Array.from({ length: over.aborts }, (_, i) => atMs - (i + 1) * 60_000),
	});
}

/**
 * A journey whose sole session waited on the human for `waitMinutes` — an
 * assistant turn followed `waitMinutes` later by a human turn, the exact shape
 * `deriveWaits` reads (see `JourneysQuery.test.ts`'s `addWaitTranscript`).
 */
function seedJourneyWithWait(over: { branch: string; waitMinutes: number; atMs?: number }): void {
	const atMs = over.atMs ?? NOW;
	const hash = seedJourney({ branch: over.branch, planFirst: false, atMs });
	addJourneyTranscript(hash, {
		entries: [
			{ role: "assistant", atMs: atMs - over.waitMinutes * 60_000 },
			{ role: "human", atMs },
		],
	});
}

/**
 * A `sessions` + `session_activity` pair giving a journey a MEASURED duration
 * (see `JourneysQuery.ts`'s `readSessionBuckets` — duration comes only from
 * these bucket rows, never from the transcript blob or `sessions.duration_ms`).
 * Links through `transcript_sessions`, the SAME relation `readSessionAggregates`
 * joins on — a bare `addJourneyTranscript` blob has no such row.
 */
function seedJourneyWithDuration(over: { branch: string; buckets: ReadonlyArray<number>; atMs?: number }): void {
	const hash = seedJourney({ branch: over.branch, planFirst: false, atMs: over.atMs });
	const transcriptId = `dur-${hash}`;
	db.prepare(
		"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
	).run(1, transcriptId, Buffer.from("{}"), NOW);
	db.prepare("INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)").run(
		1,
		hash,
		transcriptId,
	);
	const sessionId = `dur-sess-${hash}`;
	db.prepare("INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, ?)").run(
		1,
		transcriptId,
		sessionId,
		"claude",
	);
	const eventId = `dur-evt-${hash}`;
	db.prepare(
		"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
	).run(eventId, 1, "claude", sessionId, NOW, 0);
	for (const bucket of over.buckets) {
		db.prepare("INSERT INTO session_activity (session_event_id, bucket_ms, recorded_at_ms) VALUES (?, ?, ?)").run(
			eventId,
			bucket,
			NOW,
		);
	}
}

let sessionSeq = 0;

/** One session plus a single `session_tool_use` row of kind `'skill'`. */
function seedSessionWithSkill(startedAtMs: number, skillName: string, repoId = 1): void {
	sessionSeq += 1;
	const eventId = `sess-skill-${sessionSeq}`;
	db.prepare(
		"INSERT INTO sessions (event_id, repo_id, source, session_id, started_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
	).run(eventId, repoId, "claude", `skill-session-${sessionSeq}`, startedAtMs, startedAtMs);
	db.prepare(
		"INSERT INTO session_tool_use (session_event_id, tool_name, kind, server, calls, last_call_at_ms) VALUES (?, ?, 'skill', NULL, 1, ?)",
	).run(eventId, skillName, startedAtMs);
}

/** One session plus a single `session_tool_use` row of kind `'mcp'`. */
function seedSessionWithMcpTool(startedAtMs: number, toolName: string, calls: number, repoId = 1): void {
	sessionSeq += 1;
	const eventId = `sess-mcp-${sessionSeq}`;
	db.prepare(
		"INSERT INTO sessions (event_id, repo_id, source, session_id, started_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
	).run(eventId, repoId, "claude", `mcp-session-${sessionSeq}`, startedAtMs, startedAtMs);
	db.prepare(
		"INSERT INTO session_tool_use (session_event_id, tool_name, kind, server, calls, last_call_at_ms) VALUES (?, ?, 'mcp', NULL, ?, ?)",
	).run(eventId, toolName, calls, startedAtMs);
}

/**
 * Two journeys with measured turns — enough to clear `MIN_FEATURED_MEASURED_TURNS`
 * (2) in `JourneysQuery.ts`, so `smoothestId`/`hardestId` come back non-null.
 * One carries a plan (substance, low friction — the smoothest candidate), the
 * other carries many turns and no plan (higher friction — the hardest candidate).
 */
function seedFeaturablePair(): void {
	seedJourney({ branch: "feat/smooth", planFirst: true, turns: 5, atMs: NOW - DAY });
	seedJourney({ branch: "feat/hard", planFirst: false, turns: 60, atMs: NOW });
}

function inDb(body: () => void): Promise<void> {
	return withDashboardDb(
		(handle) => {
			db = handle;
			body();
		},
		{ dbPath },
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-coaching-"));
	dbPath = join(dir, "jollimemory.db");
	journeySeq = 0;
	sessionSeq = 0;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("buildCoaching", () => {
	it("reports plan-first share over the window's journeys", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/one", planFirst: true });
			seedJourney({ branch: "feat/two", planFirst: false });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.roster.planFirst.availability).toBe("measured");
			expect(model.roster.planFirst.value).toBe(50);
		}));

	it("marks skills partial when the window starts before the first captured tool row", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const firstToolMs = NOW;
			seedSessionWithSkill(firstToolMs, "superpowers:brainstorming");
			// Window opens a full day BEFORE capture began.
			const model = buildCoaching(db, { kind: "all" }, firstToolMs - DAY, firstToolMs + DAY, "UTC");
			expect(model.roster.skills.availability).toBe("partial");
		}));

	it("marks skills measured when the window lies entirely after capture began", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const firstToolMs = NOW;
			// The window opens EXACTLY at the first captured row — `fromMs < first`
			// is false, so this is `measured`, not `partial`.
			seedSessionWithSkill(firstToolMs, "superpowers:brainstorming");
			const model = buildCoaching(db, { kind: "all" }, firstToolMs, firstToolMs + DAY, "UTC");
			expect(model.roster.skills.availability).toBe("measured");
			expect(model.roster.skills.topName).toBe("superpowers:brainstorming");
		}));

	it("counts recall under a namespaced server name", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedSessionWithMcpTool(NOW, "plugin_jolli_jollimemory.recall", 4);
			const model = buildCoaching(db, { kind: "all" }, NOW, NOW + 3_600_000, "UTC");
			expect(model.roster.recall.value).toBe(4);
		}));

	it("does not count a server whose name merely ends in the same letters", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedSessionWithMcpTool(NOW, "notjollimemory.recall", 4);
			// Window opens exactly at the row, so this must come back `unavailable`
			// for the NAME reason (no matching tool), never for a `partial` window.
			const model = buildCoaching(db, { kind: "all" }, NOW, NOW + 3_600_000, "UTC");
			expect(model.roster.recall.availability).toBe("unavailable");
		}));

	it("scopes the skills and recall cells to the selected repo", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addRepo(2, "repo-b");
			// repo-a: one skill call, one recall call. repo-b: extra skill and recall
			// rows that must NOT bleed into a repo-a-scoped roster.
			seedSessionWithSkill(NOW, "superpowers:brainstorming", 1);
			seedSessionWithMcpTool(NOW, "jollimemory.recall", 1, 1);
			seedSessionWithSkill(NOW, "superpowers:other", 2);
			seedSessionWithMcpTool(NOW, "jollimemory.recall", 9, 2);
			const scoped = buildCoaching(db, { kind: "repo", repoIdentities: ["repo-a"] }, NOW, NOW + 3_600_000, "UTC");
			// Only repo-a's own single call in each cell — not the machine-wide total.
			expect(scoped.roster.skills.value).toBe(1);
			expect(scoped.roster.skills.distinctCount).toBe(1);
			expect(scoped.roster.recall.value).toBe(1);
			// The all-repos view still sums both repos, so the scoping is what
			// distinguishes them rather than a window or capture difference.
			const all = buildCoaching(db, { kind: "all" }, NOW, NOW + 3_600_000, "UTC");
			expect(all.roster.skills.value).toBe(2);
			expect(all.roster.recall.value).toBe(10);
		}));

	it("leaves the cost trend unavailable when the prior window drew nothing", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/one", planFirst: true, costUsd: 3.5, atMs: NOW });
			// Nothing at all in the preceding window.
			const model = buildCoaching(db, { kind: "all" }, NOW - 3_600_000, NOW + 3_600_000, "UTC");
			expect(model.roster.cost.trendPct).toBeUndefined();
			expect(model.roster.cost.value).toBeCloseTo(3.5, 2);
		}));

	it("carries the featured pair as whole journeys, not ids", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedFeaturablePair();
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.featured.smoothest?.title).toBeTypeOf("string");
			expect(model.featured.hardest?.title).toBeTypeOf("string");
		}));

	it("treats a window opening one millisecond before capture as partial", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedSessionWithSkill(NOW, "superpowers:brainstorming");
			const model = buildCoaching(db, { kind: "all" }, NOW - 1, NOW + DAY, "UTC");
			expect(model.roster.skills.availability).toBe("partial");
		}));

	it("shapes an empty window: every cell unavailable, layers empty, featured null", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			// A repo with no work and no tool rows: the whole roster must answer
			// "not measured" — never a zero — and the expansion must be empty,
			// never a featured card over nothing.
			const model = buildCoaching(db, { kind: "all" }, NOW - DAY, NOW, "UTC");
			expect(model.roster.planFirst).toEqual({ availability: "unavailable" });
			expect(model.roster.skills.availability).toBe("unavailable");
			expect(model.roster.cost).toEqual({ availability: "unavailable" });
			expect(model.roster.recall.availability).toBe("unavailable");
			expect(model.roster.turnaround).toEqual({ availability: "unavailable" });
			expect(model.roster.friction).toEqual({ availability: "unavailable" });
			expect(model.adoptNext).toEqual([]);
			expect(model.queue).toEqual([]);
			expect(model.patterns).toEqual({ established: [], emerging: [] });
			expect(model.hero).toEqual([]);
			expect(model.featured).toEqual({ smoothest: null, hardest: null });
			expect(model.journeyCount).toBe(0);
			// Zero journeys means neither signal was measured — an unmeasured count
			// must stay absent, never render as a false "0".
			expect(model.flaggedCount).toBeUndefined();
			expect(model.awaitingCount).toBeUndefined();
			expect(model.indexedCommits).toBe(0);
		}));

	it("counts flagged journeys from measured per-journey friction", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourneyWithAborts({ branch: "feat/one", aborts: 2, atMs: NOW });
			seedJourneyWithAborts({ branch: "feat/two", aborts: 0, atMs: NOW });
			const model = buildCoaching(db, { kind: "all" }, NOW - DAY, NOW + DAY, "UTC");
			expect(model.flaggedCount).toBe(1);
		}));

	it("leaves flaggedCount undefined when no friction is measurable", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/one", planFirst: true, atMs: NOW }); // no abort signal / all-Claude
			const model = buildCoaching(db, { kind: "all" }, NOW - DAY, NOW + DAY, "UTC");
			expect(model.flaggedCount).toBeUndefined();
		}));

	it("counts journeys that stalled waiting on the human", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourneyWithWait({ branch: "feat/one", waitMinutes: 45, atMs: NOW }); // ≥ WAIT_STALL_MINUTES
			seedJourneyWithWait({ branch: "feat/two", waitMinutes: 5, atMs: NOW });
			const model = buildCoaching(db, { kind: "all" }, NOW - DAY, NOW + DAY, "UTC");
			expect(model.awaitingCount).toBe(1);
		}));

	it("does not count a journey with no wait transcript toward awaitingCount", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourneyWithWait({ branch: "feat/one", waitMinutes: 45, atMs: NOW }); // ≥ WAIT_STALL_MINUTES
			// No transcript at all — `collectWindowSignals` still gives it a defined
			// `longestWaitMinutes` of 0 (the reduce's own initial value), which must
			// not clear the WAIT_STALL_MINUTES bar either.
			seedJourney({ branch: "feat/untimed", planFirst: false, atMs: NOW });
			const model = buildCoaching(db, { kind: "all" }, NOW - DAY, NOW + DAY, "UTC");
			expect(model.awaitingCount).toBe(1);
		}));

	it("trends both plan-first share and cost against a prior window that also has journeys", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			// Prior window: nobody planned first, low cost.
			seedJourney({ branch: "feat/prior-a", planFirst: false, costUsd: 5, atMs: NOW - DAY - 60_000 });
			seedJourney({ branch: "feat/prior-b", planFirst: false, atMs: NOW - DAY - 60_000 });
			// Current window: everybody planned first, higher cost.
			seedJourney({ branch: "feat/cur-a", planFirst: true, costUsd: 10, atMs: NOW });
			seedJourney({ branch: "feat/cur-b", planFirst: true, atMs: NOW });

			const model = buildCoaching(db, { kind: "all" }, NOW - 60_000, NOW + DAY, "UTC");

			expect(model.roster.planFirst.value).toBe(100);
			expect(model.roster.planFirst.trendPct).toBe(100);
			expect(model.roster.cost.value).toBeCloseTo(10, 2);
			expect(model.roster.cost.trendPct).toBe(100);
		}));

	it("reports the median turnaround with an odd measured count, with no trend when the prior window has none measured", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourneyWithDuration({ branch: "feat/one", buckets: [900_000, 1_800_000], atMs: NOW });
			const model = buildCoaching(db, { kind: "all" }, NOW - 60_000, NOW + DAY, "UTC");
			expect(model.roster.turnaround.availability).toBe("measured");
			expect(model.roster.turnaround.value).toBe(30);
			expect(model.roster.turnaround.trendPct).toBeUndefined();
		}));

	it("reports the median turnaround with an even measured count, trended against a measured prior window", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			// Prior window: one measured journey at 15 minutes.
			seedJourneyWithDuration({ branch: "feat/prior", buckets: [900_000], atMs: NOW - DAY - 60_000 });
			// Current window: two measured journeys (30 and 60 minutes) — an EVEN
			// count, so the median averages the middle pair.
			seedJourneyWithDuration({ branch: "feat/cur-a", buckets: [900_000, 1_800_000], atMs: NOW });
			seedJourneyWithDuration({
				branch: "feat/cur-b",
				buckets: [900_000, 1_800_000, 2_700_000, 3_600_000],
				atMs: NOW,
			});
			const model = buildCoaching(db, { kind: "all" }, NOW - 60_000, NOW + DAY, "UTC");
			expect(model.roster.turnaround.value).toBe(45);
			expect(model.roster.turnaround.trendPct).toBeGreaterThan(0);
		}));

	it("recommends breaking up the single largest-turn journey among several timed ones", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/small", planFirst: true, turns: 10, atMs: NOW - 2 * DAY });
			seedJourney({ branch: "feat/biggest", planFirst: true, turns: 50, atMs: NOW - DAY });
			seedJourney({ branch: "feat/medium", planFirst: true, turns: 30, atMs: NOW });
			const model = buildCoaching(db, { kind: "all" }, NOW - 90 * DAY, NOW + DAY, "UTC");
			const scopeItem = model.queue.find((item) => item.key === "scope");
			expect(scopeItem?.journeyTitle).toContain("journey work");
			expect(scopeItem?.detail).toContain("50 turns");
		}));

	it("breaks a pattern tie by key, alphabetically", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			// Two journeys planned first, two not — plan-first and straight-to-execute
			// tie at count 2, forcing buildPatterns' comparator into its key tie-break.
			seedJourney({ branch: "feat/a", planFirst: true, atMs: NOW - 3 * DAY });
			seedJourney({ branch: "feat/b", planFirst: true, atMs: NOW - 2 * DAY });
			seedJourney({ branch: "feat/c", planFirst: false, atMs: NOW - DAY });
			seedJourney({ branch: "feat/d", planFirst: false, atMs: NOW });
			const model = buildCoaching(db, { kind: "all" }, NOW - 90 * DAY, NOW + DAY, "UTC");
			const keys = [...model.patterns.established, ...model.patterns.emerging].map((p) => p.key);
			const planFirstIdx = keys.indexOf("plan-first");
			const straightIdx = keys.indexOf("straight-to-execute");
			expect(planFirstIdx).toBeGreaterThanOrEqual(0);
			expect(straightIdx).toBeGreaterThanOrEqual(0);
			// Tied on count, so alphabetical: "plan-first" sorts before
			// "straight-to-execute".
			expect(planFirstIdx).toBeLessThan(straightIdx);
		}));
});
