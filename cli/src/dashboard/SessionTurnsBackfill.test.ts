/**
 * The stored-transcript `session_turns` backfill over a real SoT database: a
 * session whose transcript is persisted but has no turn rows gets them,
 * idempotently; coverage is per SLICE (a session spanning two transcripts
 * backfills only the missing one); an unresolvable session is left alone (no
 * death loop); and every backfilled row is stamped above the sync cursor.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { withDashboardDb } from "./DashboardDb.js";
import { backfillStoredSessionTurns } from "./DbBackfill.js";

const NOW = 1_754_000_000_000;

let dir: string;
let dbPath: string;
let db: DashboardDbHandle;

interface Entry {
	role: string;
	content: string;
	timestamp?: string;
}

function addRepo(id: number, identity: string): void {
	db.prepare(
		"INSERT INTO repos (id, repo_identity, repo_name, worktree_root, enabled_at, bootstrap_state) VALUES (?, ?, ?, ?, ?, 'done')",
	).run(id, identity, identity, `/tmp/${identity}`, new Date(NOW).toISOString());
}

function addSession(source: string, sessionId: string): string {
	const eventId = `session:repo-a:${source}:${sessionId}`;
	db.prepare(
		"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
	).run(eventId, 1, source, sessionId, NOW);
	return eventId;
}

/** A `transcripts` row whose blob carries one `StoredSession` with `entries`. */
function addTranscript(transcriptId: string, sessionId: string, entries: Entry[]): void {
	const stored = { sessions: [{ sessionId, source: "claude", entries }] };
	const blob = deflateSync(Buffer.from(JSON.stringify(stored), "utf8"));
	db.prepare(
		"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
	).run(1, transcriptId, blob, NOW);
}

function linkTranscriptSession(transcriptId: string, sessionId: string): void {
	db.prepare("INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, ?)").run(
		1,
		transcriptId,
		sessionId,
		"claude",
	);
}

function turnsFor(): ReadonlyArray<{ session_event_id: string; slice_id: string; seq: number; role: string | null }> {
	return db
		.prepare("SELECT session_event_id, slice_id, seq, role FROM session_turns ORDER BY slice_id, seq")
		.all() as ReadonlyArray<{ session_event_id: string; slice_id: string; seq: number; role: string | null }>;
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

const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-session-turns-backfill-"));
	dbPath = join(dir, "jollimemory.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("backfillStoredSessionTurns", () => {
	it("projects the turns of a session that has a stored transcript but no rows", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addSession("claude", "s1");
			addTranscript("t1", "s1", [
				{ role: "human", content: "hi", timestamp: iso(NOW) },
				{ role: "assistant", content: "secret", timestamp: iso(NOW + 1000) },
			]);
			linkTranscriptSession("t1", "s1");

			expect(backfillStoredSessionTurns(db)).toBe(2);
			expect(turnsFor()).toEqual([
				{ session_event_id: "session:repo-a:claude:s1", slice_id: "t1", seq: 0, role: "human" },
				{ session_event_id: "session:repo-a:claude:s1", slice_id: "t1", seq: 1, role: "assistant" },
			]);
		}));

	it("is a no-op on re-run once the slice is covered", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addSession("claude", "s1");
			addTranscript("t1", "s1", [{ role: "human", content: "hi", timestamp: iso(NOW) }]);
			linkTranscriptSession("t1", "s1");

			expect(backfillStoredSessionTurns(db)).toBe(1);
			expect(backfillStoredSessionTurns(db)).toBe(0);
			expect(turnsFor()).toHaveLength(1);
		}));

	it("backfills only the missing slice when one session spans two transcripts", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addSession("claude", "s1");
			addTranscript("t1", "s1", [{ role: "human", content: "a", timestamp: iso(NOW) }]);
			linkTranscriptSession("t1", "s1");

			// First pass covers t1.
			expect(backfillStoredSessionTurns(db)).toBe(1);

			// A second transcript of the SAME session lands with no turns. A per-session
			// coverage test would call the session "already covered" and skip it; the
			// per-slice test must still backfill t2.
			addTranscript("t2", "s1", [
				{ role: "human", content: "b", timestamp: iso(NOW + 1000) },
				{ role: "assistant", content: "c", timestamp: iso(NOW + 2000) },
			]);
			linkTranscriptSession("t2", "s1");

			expect(backfillStoredSessionTurns(db)).toBe(2);
			expect(turnsFor().map((r) => r.slice_id)).toEqual(["t1", "t2", "t2"]);
		}));

	it("backfills a legacy link whose transcript_sessions.source is NULL (a claude sessions row)", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			// The `sessions` row carries the source the live path coalesced a missing
			// value to; the `transcript_sessions` link predates `source` and is NULL.
			addSession("claude", "s1");
			addTranscript("t1", "s1", [{ role: "human", content: "hi", timestamp: iso(NOW) }]);
			db.prepare(
				"INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, NULL)",
			).run(1, "t1", "s1");

			// A bare `s.source = ts.source` join is `'claude' = NULL` — never true — so
			// the blob would never be selected. COALESCE(ts.source, 'claude') selects it.
			expect(backfillStoredSessionTurns(db)).toBe(1);
			expect(turnsFor()).toEqual([
				{ session_event_id: "session:repo-a:claude:s1", slice_id: "t1", seq: 0, role: "human" },
			]);
		}));

	it("leaves a transcript whose session has no sessions row alone (no death loop)", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			// No addSession — the (session ⋈) join has nothing to resolve, so the
			// transcript is never selected and cannot be re-parsed forever.
			addTranscript("t1", "s1", [{ role: "human", content: "hi", timestamp: iso(NOW) }]);
			linkTranscriptSession("t1", "s1");

			expect(backfillStoredSessionTurns(db)).toBe(0);
			expect(turnsFor()).toHaveLength(0);
		}));

	it("tolerates an unreadable transcript blob without failing the run", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addSession("claude", "s1");
			db.prepare(
				"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
			).run(1, "t1", Buffer.from("not a deflate stream", "utf8"), NOW);
			linkTranscriptSession("t1", "s1");

			expect(backfillStoredSessionTurns(db)).toBe(0);
			expect(turnsFor()).toHaveLength(0);
		}));

	it("does not re-stamp the already-covered session in a mixed-coverage blob", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			const e1 = addSession("claude", "s1");
			addSession("claude", "s2");

			// s1 already has a turn for slice t1, stamped long ago (a prior live write).
			const oldStamp = NOW - 1_000_000;
			db.prepare(
				"INSERT INTO session_turns (session_event_id, slice_id, seq, role, ts_ms, kind, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(e1, "t1", 0, "human", NOW, "turn", oldStamp);

			// One blob carries BOTH sessions; only s2 is uncovered, so the blob is
			// selected for s2 — but s1 rides along in the same blob.
			const stored = {
				sessions: [
					{
						sessionId: "s1",
						source: "claude",
						entries: [{ role: "human", content: "x", timestamp: iso(NOW) }],
					},
					{
						sessionId: "s2",
						source: "claude",
						entries: [{ role: "human", content: "y", timestamp: iso(NOW) }],
					},
				],
			};
			db.prepare(
				"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
			).run(1, "t1", deflateSync(Buffer.from(JSON.stringify(stored), "utf8")), NOW);
			linkTranscriptSession("t1", "s1");
			linkTranscriptSession("t1", "s2");

			// Only s2's row is inserted; s1 is filtered out, so its old stamp is untouched
			// (re-projecting it would delete-then-insert with the fresh higher stamp and
			// re-upload an already-synced row).
			expect(backfillStoredSessionTurns(db)).toBe(1);
			const s1Stamp = db
				.prepare("SELECT recorded_at_ms AS ms FROM session_turns WHERE session_event_id = ?")
				.get(e1) as { ms: number };
			expect(s1Stamp.ms).toBe(oldStamp);
		}));

	it("stamps backfilled rows above every recorded_at_ms already present, so a sync cursor cannot page over them", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addSession("claude", "s1");
			addTranscript("t1", "s1", [{ role: "human", content: "hi", timestamp: iso(NOW) }]);
			linkTranscriptSession("t1", "s1");

			// A concurrent live write already recorded a turn for another session at a
			// stamp the keyset session-sync cursor has since paged past — the floor every
			// future stamp must clear (the cohort here is pure inserts, so this max is it).
			addSession("claude", "other");
			const cursorStamp = NOW + 5_000_000;
			db.prepare(
				"INSERT INTO session_turns (session_event_id, slice_id, seq, role, ts_ms, kind, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run("session:repo-a:claude:other", "tX", 0, "human", NOW, "turn", cursorStamp);

			// Backfill's own clock reads BELOW the current max (the parse-race window or a
			// plain clock step-back).
			expect(backfillStoredSessionTurns(db, () => NOW)).toBe(1);

			const stamped = db
				.prepare("SELECT recorded_at_ms AS ms FROM session_turns WHERE session_event_id = ?")
				.all("session:repo-a:claude:s1") as ReadonlyArray<{ ms: number }>;
			expect(stamped).not.toHaveLength(0);
			for (const row of stamped) expect(row.ms).toBeGreaterThan(cursorStamp);
		}));
});
