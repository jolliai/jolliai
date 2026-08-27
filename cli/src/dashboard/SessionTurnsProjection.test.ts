/**
 * SessionTurnsProjection — the text-free per-turn extractor that feeds
 * `session_turns`.
 *
 * Two properties matter here and nowhere else: no entry's `content` ever
 * reaches a row (asserted by selecting only the columns the table has — there
 * is no `content` column to leak into), and re-projecting the same transcript
 * is idempotent (delete-then-insert, mirroring `transcript_sessions`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredSession } from "../Types.js";
import { type DashboardDbHandle, withDashboardDb } from "./DashboardDb.js";
import { projectSessionTurns, uncoveredSessionsForSlice } from "./SessionTurnsProjection.js";

let dir: string;
let dbPath: string;

const NOW = 1_800_000_000_000;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-session-turns-"));
	dbPath = join(dir, "dashboard.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** One repo (id 1) and one session row (event_id 'e1'), the minimum `projectSessionTurns` needs to find an event_id. */
function seedRepoAndSession(db: DashboardDbHandle): void {
	db.prepare(
		"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/w', 1)",
	).run();
	db.prepare(
		"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES ('e1', 1, 'claude', 's1', 1000)",
	).run();
}

const SESSIONS: ReadonlyArray<StoredSession> = [
	{
		sessionId: "s1",
		source: "claude",
		entries: [
			{ role: "human", content: "hi", timestamp: "2025-01-01T00:00:00Z" },
			{ role: "assistant", content: "secret reply", timestamp: "2025-01-01T00:10:00Z" },
		],
		compactions: [1700000000000],
		testRuns: [1700000001000],
		turnAborts: [],
	},
];

interface Row {
	session_event_id: string;
	slice_id: string;
	seq: number;
	role: string | null;
	ts_ms: number | null;
	kind: string;
}

describe("projectSessionTurns", () => {
	it("projects entries and instant arrays into session_turns, text dropped", async () => {
		const rows = await withDashboardDb(
			(db) => {
				seedRepoAndSession(db);
				projectSessionTurns(db, 1, "t1", SESSIONS, NOW);
				return db
					.prepare(
						"SELECT session_event_id, slice_id, seq, role, ts_ms, kind FROM session_turns ORDER BY seq",
					)
					.all() as Row[];
			},
			{ dbPath },
		);

		expect(rows).toEqual([
			{
				session_event_id: "e1",
				slice_id: "t1",
				seq: 0,
				role: "human",
				ts_ms: Date.parse("2025-01-01T00:00:00Z"),
				kind: "turn",
			},
			{
				session_event_id: "e1",
				slice_id: "t1",
				seq: 1,
				role: "assistant",
				ts_ms: Date.parse("2025-01-01T00:10:00Z"),
				kind: "turn",
			},
			{ session_event_id: "e1", slice_id: "t1", seq: 2, role: null, ts_ms: 1700000000000, kind: "compaction" },
			{ session_event_id: "e1", slice_id: "t1", seq: 3, role: null, ts_ms: 1700000001000, kind: "test-run" },
		]);
		// turnAborts:[] emits no rows, and no row above carries anything from
		// `content` — the table has no such column to begin with.
	});

	it("re-projecting the same transcript is idempotent (delete-then-insert)", async () => {
		const count = await withDashboardDb(
			(db) => {
				seedRepoAndSession(db);
				projectSessionTurns(db, 1, "t1", SESSIONS, NOW);
				projectSessionTurns(db, 1, "t1", SESSIONS, NOW);
				return (db.prepare("SELECT count(*) c FROM session_turns").get() as { c: number }).c;
			},
			{ dbPath },
		);

		expect(count).toBe(4);
	});

	it("skips a session with no sessions row yet, the same gap transcript_sessions has", async () => {
		const count = await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/w', 1)",
				).run();
				// No INSERT INTO sessions — the event_id lookup must come back empty.
				projectSessionTurns(db, 1, "t1", SESSIONS, NOW);
				return (db.prepare("SELECT count(*) c FROM session_turns").get() as { c: number }).c;
			},
			{ dbPath },
		);

		expect(count).toBe(0);
	});

	it("skips an id-less session without binding an undefined session_id", async () => {
		// A sessionless session reaches the projection (the caller's guard only
		// covers `transcript_sessions`); it must be skipped, not crash the driver.
		const idless: ReadonlyArray<StoredSession> = [
			{ sessionId: "", source: "claude", entries: [{ role: "human", content: "hi", timestamp: undefined }] },
		];
		const count = await withDashboardDb(
			(db) => {
				seedRepoAndSession(db);
				projectSessionTurns(db, 1, "t1", idless, NOW);
				return (db.prepare("SELECT count(*) c FROM session_turns").get() as { c: number }).c;
			},
			{ dbPath },
		);

		expect(count).toBe(0);
	});

	it("nulls ts_ms for a missing or unparsable timestamp, and tolerates absent instant arrays", async () => {
		// A valid session (so the event_id resolves) whose entries carry a missing
		// then an unparsable timestamp, and which has NO compaction/test-run/abort
		// arrays at all — the `instants ?? []` and both `ts_ms` null paths.
		const messy: ReadonlyArray<StoredSession> = [
			{
				sessionId: "s1",
				source: "claude",
				entries: [
					{ role: "human", content: "a", timestamp: undefined },
					{ role: "assistant", content: "b", timestamp: "not-a-date" },
				],
			},
		];
		const rows = await withDashboardDb(
			(db) => {
				seedRepoAndSession(db);
				projectSessionTurns(db, 1, "t1", messy, NOW);
				return db
					.prepare(
						"SELECT session_event_id, slice_id, seq, role, ts_ms, kind FROM session_turns ORDER BY seq",
					)
					.all() as Row[];
			},
			{ dbPath },
		);

		expect(rows).toEqual([
			{ session_event_id: "e1", slice_id: "t1", seq: 0, role: "human", ts_ms: null, kind: "turn" },
			{ session_event_id: "e1", slice_id: "t1", seq: 1, role: "assistant", ts_ms: null, kind: "turn" },
		]);
	});

	it("tolerates a stored session with no entries field, projecting its instants only", async () => {
		// `entries` is type-required, but a stored transcript blob is untrusted
		// on-disk data and an older/malformed one can omit it. It must be one skipped
		// turn stream, never a throw that fails the whole backfill transaction.
		const noEntries = [
			{ sessionId: "s1", source: "claude", compactions: [1700000000000] },
		] as unknown as ReadonlyArray<StoredSession>;
		const rows = await withDashboardDb(
			(db) => {
				seedRepoAndSession(db);
				projectSessionTurns(db, 1, "t1", noEntries, NOW);
				return db
					.prepare(
						"SELECT session_event_id, slice_id, seq, role, ts_ms, kind FROM session_turns ORDER BY seq",
					)
					.all() as Row[];
			},
			{ dbPath },
		);

		expect(rows).toEqual([
			{ session_event_id: "e1", slice_id: "t1", seq: 0, role: null, ts_ms: 1700000000000, kind: "compaction" },
		]);
	});
});

describe("uncoveredSessionsForSlice", () => {
	it("drops sessions that already have turns for the slice, keeping the missing ones", async () => {
		// A repo with two sessions; only 'e1' has turns for slice 't1'. A blob
		// carrying both is selected for 's2', but re-projecting 's1' would re-stamp
		// its already-synced rows — so the filter must return 's2' alone.
		const kept = await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/w', 1)",
				).run();
				db.prepare(
					"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES ('e1', 1, 'claude', 's1', 1000)",
				).run();
				db.prepare(
					"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES ('e2', 1, 'claude', 's2', 1000)",
				).run();
				db.prepare(
					"INSERT INTO session_turns (session_event_id, slice_id, seq, role, ts_ms, kind, recorded_at_ms) VALUES ('e1', 't1', 0, 'human', 1, 'turn', 1)",
				).run();
				const sessions: ReadonlyArray<StoredSession> = [
					{ sessionId: "s1", source: "claude", entries: [] },
					{ sessionId: "s2", source: "claude", entries: [] },
				];
				return uncoveredSessionsForSlice(db, 1, "t1", sessions).map((s) => s.sessionId);
			},
			{ dbPath },
		);

		expect(kept).toEqual(["s2"]);
	});

	it("drops a session with no sessions row (no event_id to hang turns off)", async () => {
		const kept = await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES ('r', 'r', '/w', 1)",
				).run();
				// No sessions row for 's1' — eventIdFor returns undefined.
				const sessions: ReadonlyArray<StoredSession> = [{ sessionId: "s1", source: "claude", entries: [] }];
				return uncoveredSessionsForSlice(db, 1, "t1", sessions).map((s) => s.sessionId);
			},
			{ dbPath },
		);

		expect(kept).toEqual([]);
	});
});
