/**
 * Assembly over a real SoT database.
 *
 * Opened through `withDashboardDb` against a temp path, exactly as
 * `MemoriesQuery.test.ts` does: that helper is what CREATES the schema, and
 * `SotSchema.ts` exports its DDL in pieces (`ACTIVITY_DDL`, `RECALL_RECEIPTS_DDL`,
 * …) rather than as one applicable string. Do not hand-assemble the schema.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { withDashboardDb } from "./DashboardDb.js";
import {
	buildJourneyDetail,
	buildJourneys,
	journeyActivityMinutes,
	readSessionBuckets,
	sessionActivityKey,
} from "./JourneysQuery.js";

const DAY = 86_400_000;
const NOW = 1_754_000_000_000;

let dir: string;
let dbPath: string;
/** Seeds and assertions run inside one `withDashboardDb` call per test. */
let db: DashboardDbHandle;

function addRepo(id: number, identity: string): void {
	// `repos.enabled_at` is NOT NULL — not in the brief's literal SQL, which
	// predates a schema that requires it. A fixed value is fine: no test reads it.
	db.prepare(
		"INSERT INTO repos (id, repo_identity, repo_name, worktree_root, enabled_at, bootstrap_state) VALUES (?, ?, ?, ?, ?, 'done')",
	).run(id, identity, identity, `/tmp/${identity}`, new Date(NOW).toISOString());
}

function addMemory(over: {
	repoId?: number;
	hash: string;
	message?: string;
	ticketId?: string | null;
	branch?: string;
	atMs?: number;
	turns?: number;
	costUsd?: number;
	decisions?: string;
	planAddedAtMs?: number;
	/** Set together with `childPos`/`rootHash` to seed a SUPERSEDED (child) row. */
	parentHash?: string;
	childPos?: number;
	rootHash?: string;
}): void {
	const atMs = over.atMs ?? NOW;
	const summary = {
		commitHash: over.hash,
		commitMessage: over.message ?? "do a thing",
		commitDate: new Date(atMs).toISOString(),
		branch: over.branch ?? "feature/x",
		...(over.ticketId === undefined ? {} : { ticketId: over.ticketId }),
		...(over.turns === undefined ? {} : { conversationTurns: over.turns }),
		...(over.costUsd === undefined ? {} : { estimatedCostUsd: over.costUsd }),
		...(over.decisions === undefined ? {} : { topics: [{ title: "t", decisions: over.decisions }] }),
		...(over.planAddedAtMs === undefined
			? {}
			: { plans: [{ slug: "p", title: "P", addedAt: new Date(over.planAddedAtMs).toISOString() }] }),
	};
	db.prepare(
		`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, summary_json, first_seen_ms, written_at_ms, commit_date_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		over.repoId ?? 1,
		over.hash,
		over.parentHash ?? null,
		over.childPos ?? null,
		over.rootHash ?? over.hash,
		JSON.stringify(summary),
		atMs,
		atMs,
		atMs,
	);
}

/** A `commits` row — the COMMITTER-date clock, distinct from `memories.commit_date_ms` (author date). */
function addCommitRow(hash: string, committedAtMs: number, repoId = 1): void {
	db.prepare("INSERT INTO commits (event_id, repo_id, hash, committed_at_ms) VALUES (?, ?, ?, ?)").run(
		`evt-${repoId}-${hash}`,
		repoId,
		hash,
		committedAtMs,
	);
}

/** A transcript row. `sessions_blob` is unused by `readSessionAggregates`, so its content is a placeholder. */
function addTranscript(transcriptId: string, repoId = 1): void {
	db.prepare(
		"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
	).run(repoId, transcriptId, Buffer.from("{}"), NOW);
}

function linkMemoryTranscript(commitHash: string, transcriptId: string, repoId = 1): void {
	db.prepare("INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)").run(
		repoId,
		commitHash,
		transcriptId,
	);
}

function addTranscriptSession(transcriptId: string, sessionId: string, source: string, repoId = 1): void {
	db.prepare("INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, ?)").run(
		repoId,
		transcriptId,
		sessionId,
		source,
	);
}

function addSession(sessionId: string, source: string, durationMs: number, repoId = 1): void {
	db.prepare(
		"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
	).run(`${repoId}:${source}:${sessionId}`, repoId, source, sessionId, NOW, durationMs);
}

/** Activity buckets for a session, keyed by the same `event_id` `addSession` builds. */
function addSessionActivity(sessionId: string, source: string, buckets: number[], repoId = 1): void {
	for (const bucket of buckets) {
		db.prepare("INSERT INTO session_activity (session_event_id, bucket_ms, recorded_at_ms) VALUES (?, ?, ?)").run(
			`${repoId}:${source}:${sessionId}`,
			bucket,
			NOW,
		);
	}
}

/**
 * Each test body runs inside the open database. Vitest awaits an async `it`, so
 * the handle is valid for the whole body and closed before the next test.
 */
function inDb(body: () => void): Promise<void> {
	return withDashboardDb(
		(handle) => {
			db = handle;
			addRepo(1, "repo-a");
			body();
		},
		{ dbPath },
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-journeys-"));
	dbPath = join(dir, "jollimemory.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const build = (fromMs = NOW - 90 * DAY, toMs = NOW + DAY) =>
	buildJourneys(db, { kind: "all" }, fromMs, toMs, undefined);

describe("buildJourneys", () => {
	it("groups two commits under one ticket and orders newest first", () =>
		inDb(() => {
			addMemory({ hash: "h1", message: "Closes JOLLI-9: part one", atMs: NOW - 2 * DAY });
			addMemory({ hash: "h2", message: "Closes JOLLI-9: part two", atMs: NOW - DAY });
			addMemory({ hash: "h3", message: "unrelated", branch: "solo", atMs: NOW - 3 * DAY });

			const model = build();
			expect(model.indexedCommits).toBe(3);
			expect(model.journeys).toHaveLength(2);
			const ticketed = model.journeys.find((j) => j.ticket === "JOLLI-9");
			expect(ticketed?.groupedBy).toBe("ticket");
			expect(ticketed?.commitCount).toBe(2);
			expect(ticketed?.startedAtMs).toBe(NOW - 2 * DAY);
			expect(ticketed?.endedAtMs).toBe(NOW - DAY);
			expect(model.journeys[0]?.endedAtMs).toBeGreaterThanOrEqual(model.journeys[1]?.endedAtMs ?? 0);
		}));

	// A journey id is only meaningful within the window that grouped it, so a
	// caller re-opening one (the `/api/journey` detail route) must send these
	// EXACT bounds back rather than re-resolving a window of its own — see
	// `JourneysModel.windowStartMs`'s doc comment.
	it("echoes back the exact bounds it was called with", () =>
		inDb(() => {
			addMemory({ hash: "h1" });
			const fromMs = NOW - 12 * DAY;
			const toMs = NOW + 3 * DAY;
			const model = build(fromMs, toMs);
			expect(model.windowStartMs).toBe(fromMs);
			expect(model.windowEndMs).toBe(toMs);
		}));

	it("changes the grouping when the window changes", () =>
		inDb(() => {
			// The branch holds two commits over 90 days but one in the last 7, so it
			// is a branch journey at 90d and a lone commit at 7d. Intended: a journey
			// is what the work looks like over the period asked about.
			addMemory({ hash: "h1", branch: "feature/long", atMs: NOW - 60 * DAY });
			addMemory({ hash: "h2", branch: "feature/long", atMs: NOW - DAY });

			expect(build().journeys[0]?.groupedBy).toBe("branch");
			const week = build(NOW - 7 * DAY, NOW + DAY);
			expect(week.journeys).toHaveLength(1);
			expect(week.journeys[0]?.groupedBy).toBe("commit");
		}));

	it("reports every unmeasurable signal as unavailable, and never as zero", () =>
		inDb(() => {
			addMemory({ hash: "h1", branch: "solo" });
			const journey = build().journeys[0];
			expect(journey?.availability.frictionSignals).toBe("unavailable");
			expect(journey?.availability.waitTiming).toBe("unavailable");
			expect(journey?.availability.reviewTiming).toBe("unavailable");
			expect(journey?.durationMinutes).toBeNull();
			expect(journey?.availability.duration).toBe("unavailable");
		}));

	it("reports turns and cost as measured only when present", () =>
		inDb(() => {
			addMemory({ hash: "h1", branch: "solo", turns: 42, costUsd: 1.5 });
			addMemory({ hash: "h2", branch: "solo2" });
			const [withData, without] = [
				build().journeys.find((j) => j.turns === 42),
				build().journeys.find((j) => j.turns === null),
			];
			expect(withData?.availability.turns).toBe("measured");
			expect(withData?.costUsd).toBeCloseTo(1.5);
			expect(without?.availability.turns).toBe("unavailable");
			expect(without?.costUsd).toBeNull();
		}));

	it("is plan-first only when a plan predates the first commit", () =>
		inDb(() => {
			addMemory({ hash: "h1", branch: "a", planAddedAtMs: NOW - 5 * DAY, atMs: NOW - 2 * DAY });
			addMemory({ hash: "h2", branch: "b", planAddedAtMs: NOW - DAY, atMs: NOW - 2 * DAY });
			const journeys = build().journeys;
			expect(journeys.find((j) => j.branch === "a")?.planFirst).toBe(true);
			expect(journeys.find((j) => j.branch === "b")?.planFirst).toBe(false);
		}));

	it("collects decisions across a journey's commits and caps the feed list", () =>
		inDb(() => {
			const bullets = Array.from({ length: 9 }, (_v, i) => `- decision ${i}`).join("\n");
			addMemory({ hash: "h1", message: "Closes JOLLI-9", decisions: bullets });
			const journey = build().journeys[0];
			expect(journey?.decisionCount).toBe(9);
			expect(journey?.decisions).toHaveLength(8);
			expect(journey?.decisions[0]?.text).toBe("decision 0");
		}));

	it("drops commits git can no longer reach", () =>
		inDb(() => {
			addMemory({ hash: "h1", branch: "solo" });
			addMemory({ hash: "h2", branch: "solo" });
			const reachable = new Map([["repo-a", new Set(["h1"])]]);
			const model = buildJourneys(db, { kind: "all" }, NOW - 90 * DAY, NOW + DAY, reachable);
			expect(model.indexedCommits).toBe(1);
			expect(model.journeys[0]?.groupedBy).toBe("commit");
		}));

	it("picks a featured smoothest and hardest when enough journeys have measured turns, and neither on an empty window", () =>
		inDb(() => {
			// Two journeys with measured turns — enough to clear MIN_FEATURED_MEASURED_TURNS.
			addMemory({ hash: "h1", message: "Closes JOLLI-9", decisions: "- a", turns: 5 });
			addMemory({ hash: "h2", branch: "solo", turns: 40 });
			const model = build();
			expect(model.smoothestId).not.toBeNull();
			expect(model.hardestId).not.toBeNull();

			const empty = build(NOW - 90 * DAY, NOW - 89 * DAY);
			expect(empty.journeys).toHaveLength(0);
			expect(empty.smoothestId).toBeNull();
			expect(empty.hardestId).toBeNull();
		}));

	// I1(a) regression: fewer than two journeys with measured turns must not
	// feature a pick at all — with almost nothing measured, every unmeasured
	// journey ties at friction 0 and the featured section would headline
	// whichever one happened to fold first, not a real "smoothest"/"hardest".
	it("features nothing when fewer than two journeys have measured turns", () =>
		inDb(() => {
			addMemory({ hash: "h1", message: "Closes JOLLI-9", decisions: "- a" });
			addMemory({ hash: "h2", branch: "solo" });
			const model = build();
			expect(model.smoothestId).toBeNull();
			expect(model.hardestId).toBeNull();
		}));

	it("keeps two repos' same-named branches apart", () =>
		inDb(() => {
			addRepo(2, "repo-b");
			addMemory({ hash: "h1", branch: "shared" });
			addMemory({ repoId: 2, hash: "h2", branch: "shared" });
			expect(build().journeys).toHaveLength(2);
		}));

	// Regression: `memories` is a TREE — amend/squash/rebase file the follow-up
	// as a new ROOT and re-parent the superseded version as a CHILD. Without a
	// `parent_hash IS NULL` filter, a plain row scan counts every superseded
	// revision as its own journey (RepositoriesQuery.ts measured the same shape
	// at ~2.5x inflation).
	it("counts memory ROOTS, not memory rows — a superseded child never becomes its own journey", () =>
		inDb(() => {
			addMemory({ hash: "root1", branch: "solo-root" });
			// A child of root1: same tree, its own commit hash, a DIFFERENT branch so
			// a leaked child would show up as its OWN journey rather than silently
			// folding into root1's (both branches hold only one unticketed commit
			// each, so neither reaches the branch-journey fallback threshold).
			addMemory({ hash: "child1", branch: "solo-child", parentHash: "root1", childPos: 0, rootHash: "root1" });
			// `reachable` stays undefined (via `build()`): this proves the SQL's own
			// parent_hash filter excludes the child, not the git reachability walk.
			const model = build();
			expect(model.indexedCommits).toBe(1);
			expect(model.journeys).toHaveLength(1);
		}));

	// Regression: `memory_transcripts` is many-to-many (one transcript is shared
	// across an amend chain; one memory can reference several), so joining it
	// straight to `transcript_sessions` yields one row per (transcript, session)
	// pair — the same fan-out MemoriesQuery.ts's buildActivity hit on these exact
	// tables. A duration SUM over that join multiplies a session's duration by
	// how many transcript files happen to name it.
	it("does not fan out a session's duration across the transcripts that share it", () =>
		inDb(() => {
			addMemory({ hash: "h1", branch: "solo" });
			addTranscript("t1");
			addTranscript("t2");
			linkMemoryTranscript("h1", "t1");
			linkMemoryTranscript("h1", "t2");
			// Both transcripts name the SAME session.
			addTranscriptSession("t1", "s1", "claude");
			addTranscriptSession("t2", "s1", "claude");
			addSession("s1", "claude", 90 * 60_000);
			addSessionActivity("s1", "claude", [900_000, 1_800_000]);
			const journey = build().journeys[0];
			expect(journey?.sessionCount).toBe(1);
			expect(journey?.durationMinutes).toBe(30);
		}));

	// Regression (C2): the per-commit dedup above is not the same bug as this
	// one. A session that produced TWO commits in the same journey used to be
	// counted, and its duration summed, once per commit it touched — measured on
	// a real database at up to 63x for one session. Journey-level identity is a
	// Set keyed by (source, sessionId), accumulated across every commit in the
	// journey, so the same session recurring on a later commit must be a no-op.
	it("collapses a session shared by two commits in the same journey", () =>
		inDb(() => {
			addMemory({ hash: "h1", message: "Closes JOLLI-9: part one", atMs: NOW - 2 * DAY });
			addMemory({ hash: "h2", message: "Closes JOLLI-9: part two", atMs: NOW - DAY });
			addTranscript("t1");
			addTranscript("t2");
			linkMemoryTranscript("h1", "t1");
			linkMemoryTranscript("h2", "t2");
			// The SAME session touched both commits (e.g. one long agent session
			// that produced two commits in a row).
			addTranscriptSession("t1", "s1", "claude");
			addTranscriptSession("t2", "s1", "claude");
			addSession("s1", "claude", 90 * 60_000);
			addSessionActivity("s1", "claude", [900_000, 1_800_000]);
			const journey = build().journeys.find((j) => j.ticket === "JOLLI-9");
			expect(journey?.commitCount).toBe(2);
			expect(journey?.sessionCount).toBe(1);
			expect(journey?.durationMinutes).toBe(30);
		}));

	// Regression: the WHERE clause used to filter on the raw author date
	// (`memories.commit_date_ms`) while the SELECT, ORDER BY and grouping all
	// used COALESCE(commits.committed_at_ms, memories.commit_date_ms) — the
	// COMMITTER date when a `commits` row exists. A rebased or cherry-picked
	// commit could then be excluded from a window it was reported as belonging
	// to, or the reverse.
	it("filters on the same clock it sorts and groups by, not the raw author date", () =>
		inDb(() => {
			// Author date is far outside the window; the committer date on `commits`
			// (what COALESCE prefers) is what actually lands it inside.
			addMemory({ hash: "h-committer-in", branch: "a", atMs: NOW - 200 * DAY });
			addCommitRow("h-committer-in", NOW - 10 * DAY);

			// Mirror: author date is inside the window, but the committer date
			// COALESCE prefers is outside it.
			addMemory({ hash: "h-committer-out", branch: "b", atMs: NOW - 10 * DAY });
			addCommitRow("h-committer-out", NOW - 200 * DAY);

			const model = build();
			expect(model.journeys.some((j) => j.branch === "a")).toBe(true);
			expect(model.journeys.some((j) => j.branch === "b")).toBe(false);
		}));

	// Regression: a private decisions splitter that does not strip `**` emphasis
	// (or collapse whitespace) disagrees with `splitDecisionBullets` — the
	// memory detail pane's canonical splitter — about what one commit's
	// decision text is.
	it("strips markdown emphasis from decision text via the canonical splitter", () =>
		inDb(() => {
			addMemory({ hash: "h1", message: "Closes JOLLI-9", decisions: "- **bold** decision" });
			const text = build().journeys[0]?.decisions[0]?.text;
			expect(text).toBe("bold decision");
			expect(text).not.toContain("*");
		}));

	// Regression (I4): the journey's TITLE is always the newest commit's subject
	// ("newest commit names the journey"), but a multi-commit branch's shape
	// used to read that one title as a claim about the whole journey — a
	// feature branch ending in a chore-shaped commit rendered "chore · clean
	// land" even though most of the branch was real feature work.
	it("does not label a multi-commit journey a chore just because its last commit is", () =>
		inDb(() => {
			addMemory({ hash: "h1", branch: "feature/big", message: "add the feature", atMs: NOW - 3 * DAY });
			addMemory({ hash: "h2", branch: "feature/big", message: "wire it up", atMs: NOW - 2 * DAY });
			addMemory({ hash: "h3", branch: "feature/big", message: "bump lockfile", atMs: NOW - DAY });
			const journey = build().journeys[0];
			expect(journey?.title).toBe("bump lockfile");
			expect(journey?.shape.kind).not.toBe("chore");
		}));
});

describe("buildJourneyDetail", () => {
	it("returns every commit and every decision, uncapped", () =>
		inDb(() => {
			const bullets = Array.from({ length: 9 }, (_v, i) => `- decision ${i}`).join("\n");
			addMemory({ hash: "h1", message: "Closes JOLLI-9: one", decisions: bullets, atMs: NOW - 2 * DAY });
			addMemory({ hash: "h2", message: "Closes JOLLI-9: two", atMs: NOW - DAY });
			const id = build().journeys[0]?.id ?? "";

			const detail = buildJourneyDetail(db, { kind: "all" }, { startMs: NOW - 90 * DAY, endMs: NOW + DAY }, id);
			expect(detail?.commits).toHaveLength(2);
			expect(detail?.commits[0]?.commitHash).toBe("h1");
			expect(detail?.decisions).toHaveLength(9);
			expect(detail?.journey.decisions).toHaveLength(8);
		}));

	it("is undefined for an id the window does not contain", () =>
		inDb(() => {
			expect(
				buildJourneyDetail(db, { kind: "all" }, { startMs: NOW - DAY, endMs: NOW }, "T\x00repo-a\x00NOPE-1"),
			).toBeUndefined();
		}));
});

describe("readSessionBuckets", () => {
	it("groups buckets per session and keeps two repos' identical session ids apart", () =>
		inDb(() => {
			addRepo(2, "repo-b");
			// Same source AND same session_id in two repos — the case an
			// unqualified key would silently merge.
			addSession("S", "claude", 0, 1);
			addSession("S", "claude", 0, 2);
			addSessionActivity("S", "claude", [900_000, 1_800_000], 1);
			addSessionActivity("S", "claude", [2_700_000], 2);

			const buckets = readSessionBuckets(db);

			expect([...(buckets.get(sessionActivityKey("repo-a", "claude", "S")) ?? [])].sort((a, b) => a - b)).toEqual(
				[900_000, 1_800_000],
			);
			expect([...(buckets.get(sessionActivityKey("repo-b", "claude", "S")) ?? [])]).toEqual([2_700_000]);
		}));

	it("returns no entry for a session with no activity rows", () =>
		inDb(() => {
			addSession("S", "claude", 0, 1);

			expect(readSessionBuckets(db).get(sessionActivityKey("repo-a", "claude", "S"))).toBeUndefined();
		}));
});

describe("journeyActivityMinutes", () => {
	it("counts each distinct quarter-hour once", () => {
		expect(journeyActivityMinutes(new Set([900_000, 1_800_000, 2_700_000]))).toBe(45);
	});

	it("is zero for an empty set", () => {
		expect(journeyActivityMinutes(new Set())).toBe(0);
	});
});

describe("journey duration from activity buckets", () => {
	// Two sessions on one journey, both active in the 900_000 bucket. Summing
	// gives 45 minutes; the truth is 30 — that quarter-hour happened once. This
	// is the whole reason the fold is a union.
	it("unions overlapping sessions instead of summing them", () =>
		inDb(() => {
			addMemory({ hash: "h1", message: "Closes JOLLI-9: part one", atMs: NOW - DAY });
			addTranscript("t1");
			linkMemoryTranscript("h1", "t1");
			addTranscriptSession("t1", "s1", "claude");
			addTranscriptSession("t1", "s2", "claude");
			addSession("s1", "claude", 0);
			addSession("s2", "claude", 0);
			addSessionActivity("s1", "claude", [900_000, 1_800_000]);
			addSessionActivity("s2", "claude", [900_000]);

			expect(build().journeys[0]?.durationMinutes).toBe(30);
		}));

	it("reports null, never 0, when no session on the journey has any buckets", () =>
		inDb(() => {
			addMemory({ hash: "h1", message: "Closes JOLLI-9: part one", atMs: NOW - DAY });
			addTranscript("t1");
			linkMemoryTranscript("h1", "t1");
			addTranscriptSession("t1", "s1", "claude");
			addSession("s1", "claude", 90 * 60_000);

			const journey = build().journeys[0];

			expect(journey?.durationMinutes).toBeNull();
			expect(journey?.availability.duration).toBe("unavailable");
		}));
});

describe("buildJourneys — longestWaitMinutes", () => {
	/**
	 * A transcript blob carrying real session entries (role + timestamp), the
	 * shape `deriveWaits` reads. The shared `addTranscript` above writes an
	 * uncompressed `{}` placeholder — fine for the aggregate-only tests above,
	 * but `readJourneySessions` inflates this blob, so a placeholder here would
	 * be caught as unreadable and yield zero sessions.
	 */
	function addWaitTranscript(
		transcriptId: string,
		entries: ReadonlyArray<{ role: "human" | "assistant"; atMs: number }>,
		repoId = 1,
	): void {
		const stored = {
			sessions: [
				{
					sessionId: `s-${transcriptId}`,
					source: "codex",
					entries: entries.map((e) => ({
						role: e.role,
						content: "x",
						timestamp: new Date(e.atMs).toISOString(),
					})),
				},
			],
		};
		const blob = deflateSync(Buffer.from(JSON.stringify(stored), "utf8"));
		db.prepare(
			"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
		).run(repoId, transcriptId, blob, NOW);
	}

	function seedWaitingJourney(): void {
		addMemory({ hash: "h1", message: "do the thing", atMs: NOW - DAY });
		addWaitTranscript("t1", [
			{ role: "assistant", atMs: NOW - DAY },
			// 10 minutes later — comfortably past the 5-minute wait threshold.
			{ role: "human", atMs: NOW - DAY + 10 * 60_000 },
		]);
		linkMemoryTranscript("h1", "t1");
	}

	it("omits longestWaitMinutes unless withWaits is requested", () =>
		inDb(() => {
			seedWaitingJourney();

			const model = buildJourneys(db, { kind: "all" }, 0, NOW + DAY);

			expect(model.journeys[0].longestWaitMinutes).toBeUndefined();
		}));

	it("reports the journey's longest wait when withWaits is requested", () =>
		inDb(() => {
			seedWaitingJourney();

			const model = buildJourneys(db, { kind: "all" }, 0, NOW + DAY, undefined, { withWaits: true });

			expect(model.journeys[0].longestWaitMinutes).toBeGreaterThan(0);
		}));
});

describe("buildJourneys — wait signal isolation regressions", () => {
	/** A transcript blob with one session whose id, source and entries the caller controls. */
	function addSessionTranscript(
		transcriptId: string,
		sessionId: string,
		entries: ReadonlyArray<{ role: "human" | "assistant"; atMs: number }>,
		repoId = 1,
	): void {
		const stored = {
			sessions: [
				{
					sessionId,
					source: "codex",
					entries: entries.map((e) => ({
						role: e.role,
						content: "x",
						timestamp: new Date(e.atMs).toISOString(),
					})),
				},
			],
		};
		const blob = deflateSync(Buffer.from(JSON.stringify(stored), "utf8"));
		db.prepare(
			"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
		).run(repoId, transcriptId, blob, NOW);
	}

	// Regression (High): the transcript cache is keyed by transcript_id alone, but
	// transcripts are unique only by (repo_id, transcript_id) — see SotSchema's
	// `transcripts` PK. In the default multi-repo window two repos each holding a
	// transcript "t1" alias in the cache, so whichever repo is processed second
	// reuses the first's parsed sessions and inherits its wait signal. The
	// assertion pins BOTH repos' own values, so the collision fails regardless of
	// which group the walk reaches first.
	it("does not alias two repos' identically-named transcripts in the wait cache", () =>
		inDb(() => {
			addRepo(2, "repo-b");
			// repo-a's t1 carries a real 30-minute wait.
			addMemory({ repoId: 1, hash: "h1", branch: "solo-a", atMs: NOW - DAY });
			addSessionTranscript(
				"t1",
				"sa",
				[
					{ role: "assistant", atMs: NOW - DAY },
					{ role: "human", atMs: NOW - DAY + 30 * 60_000 },
				],
				1,
			);
			linkMemoryTranscript("h1", "t1", 1);
			// repo-b's t1 (same id, different repo) carries NO wait — one quick reply.
			addMemory({ repoId: 2, hash: "h2", branch: "solo-b", atMs: NOW - DAY });
			addSessionTranscript(
				"t1",
				"sb",
				[
					{ role: "assistant", atMs: NOW - DAY },
					{ role: "human", atMs: NOW - DAY + 60_000 },
				],
				2,
			);
			linkMemoryTranscript("h2", "t1", 2);

			const model = buildJourneys(db, { kind: "all" }, 0, NOW + DAY, undefined, { withWaits: true });
			const a = model.journeys.find((j) => j.branch === "solo-a");
			const b = model.journeys.find((j) => j.branch === "solo-b");
			expect(a?.longestWaitMinutes).toBe(30);
			expect(b?.longestWaitMinutes).toBe(0);
		}));

	// Regression (Medium): one conversation is filed as a slice per commit of an
	// amend chain. deriveWaits scanned each slice independently, so an assistant
	// turn at the end of one slice and the human reply at the start of the next —
	// the SAME session — never formed a wait, understating longestWaitMinutes.
	it("sees a wait that straddles two transcript slices of one session", () =>
		inDb(() => {
			addMemory({ hash: "h1", message: "Closes JOLLI-9: one", atMs: NOW - 2 * DAY });
			addMemory({ hash: "h2", message: "Closes JOLLI-9: two", atMs: NOW - DAY });
			// Slice A (commit h1) ends on an assistant turn...
			addSessionTranscript("t1", "sess1", [{ role: "assistant", atMs: NOW - DAY }], 1);
			linkMemoryTranscript("h1", "t1", 1);
			// ...slice B (commit h2) — the SAME session — opens with the human reply
			// 30 minutes later. The gap exists only across the slice boundary.
			addSessionTranscript("t2", "sess1", [{ role: "human", atMs: NOW - DAY + 30 * 60_000 }], 1);
			linkMemoryTranscript("h2", "t2", 1);

			const model = buildJourneys(db, { kind: "all" }, 0, NOW + DAY, undefined, { withWaits: true });
			const journey = model.journeys.find((j) => j.ticket === "JOLLI-9");
			expect(journey?.longestWaitMinutes).toBe(30);
		}));
});
