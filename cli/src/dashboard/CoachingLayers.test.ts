/**
 * The coaching page's three rule layers — ADOPT NEXT, the queue, and patterns —
 * assembled over a real SoT database exactly as `CoachingQuery.test.ts` does it.
 * Each is a rules-over-journeys projection (§3.5), so the assertions pin the
 * rule and the template, not a snapshot of markup.
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
let db: DashboardDbHandle;

function addRepo(id: number, identity: string): void {
	db.prepare(
		"INSERT INTO repos (id, repo_identity, repo_name, worktree_root, enabled_at, bootstrap_state) VALUES (?, ?, ?, ?, ?, 'done')",
	).run(id, identity, identity, `/tmp/${identity}`, new Date(NOW).toISOString());
}

let journeySeq = 0;

/** One memory row — the single commit a journey is assembled from. */
function seedJourney(over: {
	branch: string;
	planFirst: boolean;
	turns?: number;
	atMs?: number;
	title?: string;
}): string {
	journeySeq += 1;
	const atMs = over.atMs ?? NOW;
	const hash = `lh${journeySeq}`;
	const summary = {
		commitHash: hash,
		commitMessage: over.title ?? `layers journey ${journeySeq}`,
		commitDate: new Date(atMs).toISOString(),
		branch: over.branch,
		...(over.turns === undefined ? {} : { conversationTurns: over.turns }),
		...(over.planFirst ? { plans: [{ slug: "p", title: "P", addedAt: new Date(atMs - DAY).toISOString() }] } : {}),
	};
	db.prepare(
		`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, summary_json, first_seen_ms, written_at_ms, commit_date_ms)
		 VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
	).run(1, hash, hash, JSON.stringify(summary), atMs, atMs, atMs);
	return hash;
}

let transcriptSeq = 0;

/** A `transcripts` row whose `sessions_blob` carries one `StoredSession` with a
 *  `source` and optional `turnAborts`/`testRuns` fields, linked to one commit —
 *  enough for `buildCoachingWindow` and the test-first pattern to read the
 *  turn-level signals without the `sessions`/`session_activity` chain. */
function seedSessionTranscript(
	commitHash: string,
	over: { source: string; turnAborts?: number[]; testRuns?: number[] },
): void {
	transcriptSeq += 1;
	const transcriptId = `t${transcriptSeq}`;
	const stored = {
		sessions: [
			{
				sessionId: `s${transcriptSeq}`,
				source: over.source,
				entries: [],
				...(over.turnAborts === undefined ? {} : { turnAborts: over.turnAborts }),
				...(over.testRuns === undefined ? {} : { testRuns: over.testRuns }),
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

/** Seeds the transcript→session→activity chain so one journey gets measured duration. */
function seedMeasuredDuration(commitHash: string, buckets: number[]): void {
	transcriptSeq += 1;
	const transcriptId = `t${transcriptSeq}`;
	const sessionId = `s${transcriptSeq}`;
	const source = "claude";
	db.prepare(
		"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
	).run(1, transcriptId, Buffer.from("{}"), NOW);
	db.prepare("INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)").run(
		1,
		commitHash,
		transcriptId,
	);
	db.prepare("INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, ?)").run(
		1,
		transcriptId,
		sessionId,
		source,
	);
	db.prepare(
		"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
	).run(`1:${source}:${sessionId}`, 1, source, sessionId, NOW, 0);
	for (const bucket of buckets) {
		db.prepare("INSERT INTO session_activity (session_event_id, bucket_ms, recorded_at_ms) VALUES (?, ?, ?)").run(
			`1:${source}:${sessionId}`,
			bucket,
			NOW,
		);
	}
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
	dir = mkdtempSync(join(tmpdir(), "jolli-layers-"));
	dbPath = join(dir, "jollimemory.db");
	journeySeq = 0;
	transcriptSeq = 0;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("buildCoaching — ADOPT NEXT", () => {
	it("reports plan-first share over the last five journeys", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			for (let i = 0; i < 3; i++) seedJourney({ branch: `feat/plan-${i}`, planFirst: true, atMs: NOW + i });
			for (let i = 0; i < 2; i++)
				seedJourney({ branch: `feat/straight-${i}`, planFirst: false, atMs: NOW + 100 + i });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.adoptNext).toHaveLength(1);
			expect(model.adoptNext[0]).toMatchObject({ key: "plan-first", adopted: 3, window: 5 });
			expect(model.adoptNext[0].detail).toContain("3 of your last 5");
		}));

	it("measures the share over fewer journeys when the window holds fewer than five", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/one", planFirst: true });
			seedJourney({ branch: "feat/two", planFirst: false });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.adoptNext[0]).toMatchObject({ adopted: 1, window: 2 });
		}));

	it("emits nothing for an empty window", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.adoptNext).toHaveLength(0);
			expect(model.queue).toHaveLength(0);
			expect(model.patterns.established).toHaveLength(0);
			expect(model.patterns.emerging).toHaveLength(0);
		}));
});

describe("buildCoaching — queue", () => {
	it("asks for a plan only when fewer than half the journeys plan first, and links the most recent straight one", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			// Three journeys: one plan-first, two straight. The MOST RECENT straight
			// one (latest atMs) is the evidence link.
			seedJourney({ branch: "feat/planned", planFirst: true, atMs: NOW, title: "planned one" });
			seedJourney({ branch: "feat/straight-older", planFirst: false, atMs: NOW + 1000, title: "straight older" });
			seedJourney({
				branch: "feat/straight-newest",
				planFirst: false,
				atMs: NOW + 2000,
				title: "straight newest",
			});
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			const item = model.queue.find((q) => q.key === "plan-first");
			expect(item).toBeDefined();
			expect(item?.detail).toContain("1 of 3");
			expect(item?.journeyTitle).toBe("straight newest");
		}));

	it("omits the plan item once at least half plan first", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/planned", planFirst: true, atMs: NOW });
			seedJourney({ branch: "feat/straight", planFirst: false, atMs: NOW + 1000 });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.queue.some((q) => q.key === "plan-first")).toBe(false);
		}));

	it("asks to split a journey that reaches the turn ceiling", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/small", planFirst: true, turns: 5, atMs: NOW, title: "small one" });
			seedJourney({ branch: "feat/big", planFirst: false, turns: 60, atMs: NOW + 1000, title: "big one" });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			const item = model.queue.find((q) => q.key === "scope");
			expect(item).toBeDefined();
			expect(item?.journeyTitle).toBe("big one");
		}));
});

describe("buildCoaching — patterns", () => {
	it("establishes a pattern with four journeys over three distinct weeks", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/a", planFirst: true, atMs: NOW });
			seedJourney({ branch: "feat/b", planFirst: true, atMs: NOW + 7 * DAY });
			seedJourney({ branch: "feat/c", planFirst: true, atMs: NOW + 14 * DAY });
			seedJourney({ branch: "feat/d", planFirst: true, atMs: NOW + 21 * DAY });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + 30 * DAY, "UTC");
			const plan = model.patterns.established.find((p) => p.key === "plan-first");
			expect(plan).toBeDefined();
			expect(plan?.emerging).toBe(false);
			expect(plan?.weeks).toBe(4);
		}));

	it("keeps a pattern emerging when it spans too few weeks", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			// Four journeys, but all within two distinct weeks.
			seedJourney({ branch: "feat/a", planFirst: true, atMs: NOW });
			seedJourney({ branch: "feat/b", planFirst: true, atMs: NOW + 3 * DAY });
			seedJourney({ branch: "feat/c", planFirst: true, atMs: NOW + 7 * DAY });
			seedJourney({ branch: "feat/d", planFirst: true, atMs: NOW + 8 * DAY });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + 30 * DAY, "UTC");
			const plan = model.patterns.emerging.find((p) => p.key === "plan-first");
			expect(plan).toBeDefined();
			expect(plan?.emerging).toBe(true);
			expect(plan?.weeks).toBe(2);
		}));

	it("keeps a pattern emerging when it matches too few journeys", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/a", planFirst: true, atMs: NOW });
			seedJourney({ branch: "feat/b", planFirst: true, atMs: NOW + 7 * DAY });
			seedJourney({ branch: "feat/c", planFirst: true, atMs: NOW + 14 * DAY });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + 30 * DAY, "UTC");
			const plan = model.patterns.emerging.find((p) => p.key === "plan-first");
			expect(plan).toBeDefined();
			expect(plan?.count).toBe(3);
		}));

	it("reports the single-commit pattern over the window's commit counts", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/one", planFirst: true });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			const single = [...model.patterns.established, ...model.patterns.emerging].find(
				(p) => p.key === "single-commit",
			);
			expect(single?.count).toBe(1);
		}));

	it("reports a test-first pattern for journeys that ran a test before their first commit", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const h1 = seedJourney({ branch: "feat/a", planFirst: true, atMs: NOW });
			const h2 = seedJourney({ branch: "feat/b", planFirst: true, atMs: NOW + 1000 });
			seedSessionTranscript(h1, { source: "claude", testRuns: [NOW - 60_000] });
			seedSessionTranscript(h2, { source: "claude", testRuns: [NOW + 1000 - 60_000] });

			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			const testFirst = [...model.patterns.established, ...model.patterns.emerging].find(
				(p) => p.key === "test-first",
			);
			expect(testFirst?.count).toBe(2);
		}));

	it("emits no test-first pattern when no journey ran a test before its first commit", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const h1 = seedJourney({ branch: "feat/a", planFirst: true, atMs: NOW });
			// After the first commit — test-after, not test-first.
			seedSessionTranscript(h1, { source: "claude", testRuns: [NOW + 60_000] });

			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			const keys = [...model.patterns.established, ...model.patterns.emerging].map((p) => p.key);
			expect(keys).not.toContain("test-first");
		}));
});

describe("buildCoaching — turnaround", () => {
	it("is unavailable, never zero, when no journey has measured duration", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			seedJourney({ branch: "feat/one", planFirst: true });
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.roster.turnaround.availability).toBe("unavailable");
			expect(model.roster.turnaround.value).toBeUndefined();
		}));

	it("reports the median activity minutes over the measured journeys", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			// 2 buckets = 30 min, 4 buckets = 60 min, 3 buckets = 45 min.
			const h1 = seedJourney({ branch: "feat/a", planFirst: true, atMs: NOW });
			const h2 = seedJourney({ branch: "feat/b", planFirst: true, atMs: NOW + 1000 });
			const h3 = seedJourney({ branch: "feat/c", planFirst: true, atMs: NOW + 2000 });
			seedMeasuredDuration(h1, [900_000, 1_800_000]);
			seedMeasuredDuration(h2, [900_000, 1_800_000, 2_700_000, 3_600_000]);
			seedMeasuredDuration(h3, [900_000, 1_800_000, 2_700_000]);
			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.roster.turnaround.availability).toBe("measured");
			expect(model.roster.turnaround.value).toBe(45);
		}));
});

describe("buildCoaching — friction", () => {
	it("counts turn aborts from a measured Codex session", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const h1 = seedJourney({ branch: "feat/one", planFirst: true });
			seedSessionTranscript(h1, { source: "codex", turnAborts: [NOW - 60_000, NOW] });

			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.roster.friction.availability).toBe("measured");
			expect(model.roster.friction.value).toBe(2);
		}));

	it("is unavailable when no session can report friction (Claude-only)", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const h1 = seedJourney({ branch: "feat/one", planFirst: true });
			seedSessionTranscript(h1, { source: "claude" });

			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.roster.friction.availability).toBe("unavailable");
			expect(model.roster.friction.value).toBeUndefined();
		}));

	it("is unavailable, never zero, for a Codex session written before the field", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const h1 = seedJourney({ branch: "feat/one", planFirst: true });
			seedSessionTranscript(h1, { source: "codex" });

			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.roster.friction.availability).toBe("unavailable");
			expect(model.roster.friction.value).toBeUndefined();
		}));

	it("is partial when the window mixes measured and unmeasured Codex sessions", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const measured = seedJourney({ branch: "feat/a", planFirst: true, atMs: NOW });
			const unmeasured = seedJourney({ branch: "feat/b", planFirst: true, atMs: NOW + 1000 });
			seedSessionTranscript(measured, { source: "codex", turnAborts: [NOW] });
			seedSessionTranscript(unmeasured, { source: "codex" });

			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.roster.friction.availability).toBe("partial");
		}));

	it("counts one abort instant once across two transcripts of the same commit", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const h1 = seedJourney({ branch: "feat/one", planFirst: true });
			seedSessionTranscript(h1, { source: "codex", turnAborts: [NOW] });
			seedSessionTranscript(h1, { source: "codex", turnAborts: [NOW] });

			const model = buildCoaching(db, { kind: "all" }, 0, NOW + DAY, "UTC");
			expect(model.roster.friction.availability).toBe("measured");
			expect(model.roster.friction.value).toBe(1);
		}));
});
