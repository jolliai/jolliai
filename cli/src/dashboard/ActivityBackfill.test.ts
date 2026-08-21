/**
 * The stored-transcript activity backfill over a real SoT database: a session
 * whose transcript is persisted but has no `session_activity` rows gets them,
 * idempotently, and a timestamp-less transcript stays absent (never a zero).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_BUCKET_MS } from "./ActivityBuckets.js";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { withDashboardDb } from "./DashboardDb.js";
import { backfillStoredActivity } from "./DbBackfill.js";

const NOW = 1_754_000_000_000;

let dir: string;
let dbPath: string;
let db: DashboardDbHandle;

function addRepo(id: number, identity: string): void {
	db.prepare(
		"INSERT INTO repos (id, repo_identity, repo_name, worktree_root, enabled_at, bootstrap_state) VALUES (?, ?, ?, ?, ?, 'done')",
	).run(id, identity, identity, `/tmp/${identity}`, new Date(NOW).toISOString());
}

function addSession(repoId: number, source: string, sessionId: string): void {
	db.prepare(
		"INSERT INTO sessions (event_id, repo_id, source, session_id, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
	).run(`session:repo-a:${source}:${sessionId}`, repoId, source, sessionId, NOW);
}

/** A `transcripts` row whose blob carries one `StoredSession` with `entries`. */
function addTranscript(
	repoId: number,
	transcriptId: string,
	entries: Array<{ role: string; content: string; timestamp?: string }>,
): void {
	const stored = { sessions: [{ sessionId: "s1", source: "claude", entries }] };
	const blob = deflateSync(Buffer.from(JSON.stringify(stored), "utf8"));
	db.prepare(
		"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
	).run(repoId, transcriptId, blob, NOW);
}

function linkTranscriptSession(repoId: number, transcriptId: string, source: string, sessionId: string): void {
	db.prepare("INSERT INTO transcript_sessions (repo_id, transcript_id, session_id, source) VALUES (?, ?, ?, ?)").run(
		repoId,
		transcriptId,
		sessionId,
		source,
	);
}

function activityFor(): ReadonlyArray<{ session_event_id: string; bucket_ms: number }> {
	return db
		.prepare("SELECT session_event_id, bucket_ms FROM session_activity ORDER BY bucket_ms")
		.all() as ReadonlyArray<{ session_event_id: string; bucket_ms: number }>;
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
const bucketOf = (ms: number) => Math.floor(ms / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-activity-backfill-"));
	dbPath = join(dir, "jollimemory.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("backfillStoredActivity", () => {
	it("writes the quarter-hour buckets for a session with a stored transcript", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addSession(1, "claude", "s1");
			addTranscript(1, "t1", [{ role: "assistant", content: "ran things", timestamp: iso(NOW) }]);
			linkTranscriptSession(1, "t1", "claude", "s1");

			expect(backfillStoredActivity(db)).toBe(1);
			expect(activityFor()).toEqual([{ session_event_id: "session:repo-a:claude:s1", bucket_ms: bucketOf(NOW) }]);
		}));

	it("is a no-op on re-run once the session is covered", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addSession(1, "claude", "s1");
			addTranscript(1, "t1", [{ role: "assistant", content: "ran things", timestamp: iso(NOW) }]);
			linkTranscriptSession(1, "t1", "claude", "s1");

			expect(backfillStoredActivity(db)).toBe(1);
			expect(backfillStoredActivity(db)).toBe(0);
			expect(activityFor()).toHaveLength(1);
		}));

	it("writes nothing for a session whose entries carry no timestamp", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addSession(1, "claude", "s1");
			addTranscript(1, "t1", [{ role: "assistant", content: "no clock" }]);
			linkTranscriptSession(1, "t1", "claude", "s1");

			expect(backfillStoredActivity(db)).toBe(0);
			expect(activityFor()).toHaveLength(0);
		}));

	it("dedupes multiple buckets from one session into distinct rows", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addSession(1, "claude", "s1");
			addTranscript(1, "t1", [
				{ role: "assistant", content: "a", timestamp: iso(NOW) },
				{ role: "assistant", content: "b", timestamp: iso(NOW + ACTIVITY_BUCKET_MS) },
			]);
			linkTranscriptSession(1, "t1", "claude", "s1");

			expect(backfillStoredActivity(db)).toBe(1);
			expect(activityFor().map((r) => r.bucket_ms)).toEqual([bucketOf(NOW), bucketOf(NOW + ACTIVITY_BUCKET_MS)]);
		}));
});
