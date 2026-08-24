/**
 * Per-journey test-first derivation over a real SoT database, from
 * `StoredSession.testRuns`. Same seed pattern as `FeedFriction.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { withDashboardDb } from "./DashboardDb.js";
import { buildJourneys } from "./JourneysQuery.js";

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

function addMemory(over: { hash: string; message: string; atMs: number }): void {
	const summary = {
		commitHash: over.hash,
		commitMessage: over.message,
		commitDate: new Date(over.atMs).toISOString(),
		branch: `feature/${over.hash}`,
	};
	db.prepare(
		`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, summary_json, first_seen_ms, written_at_ms, commit_date_ms)
		 VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
	).run(1, over.hash, over.hash, JSON.stringify(summary), over.atMs, over.atMs, over.atMs);
}

function addTranscript(transcriptId: string, over: { source?: string; testRuns?: number[] } = {}): void {
	const stored = {
		sessions: [
			{
				sessionId: `s-${transcriptId}`,
				source: over.source ?? "claude",
				entries: [],
				...(over.testRuns === undefined ? {} : { testRuns: over.testRuns }),
			},
		],
	};
	const blob = deflateSync(Buffer.from(JSON.stringify(stored), "utf8"));
	db.prepare(
		"INSERT INTO transcripts (repo_id, transcript_id, sessions_blob, written_at_ms) VALUES (?, ?, ?, ?)",
	).run(1, transcriptId, blob, NOW);
}

function linkMemoryTranscript(commitHash: string, transcriptId: string): void {
	db.prepare("INSERT INTO memory_transcripts (repo_id, commit_hash, transcript_id) VALUES (?, ?, ?)").run(
		1,
		commitHash,
		transcriptId,
	);
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

function testedOf(): unknown {
	return buildJourneys(db, { kind: "all" }, 0, NOW + 2 * DAY, { withTests: true }).journeys[0]?.tested;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-testfirst-"));
	dbPath = join(dir, "jollimemory.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("buildJourneys — per-journey test-first", () => {
	it("is test-first when a test run precedes the first commit", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW });
			addTranscript("t1", { testRuns: [NOW - 60_000] });
			linkMemoryTranscript("h1", "t1");

			expect(testedOf()).toEqual({ availability: "measured", testFirst: true });
		}));

	it("is not test-first when the test run follows the first commit", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW });
			addTranscript("t1", { testRuns: [NOW + 60_000] });
			linkMemoryTranscript("h1", "t1");

			expect(testedOf()).toEqual({ availability: "measured", testFirst: false });
		}));

	it("is measured, not test-first, for an empty testRuns (ran no tests)", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW });
			addTranscript("t1", { testRuns: [] });
			linkMemoryTranscript("h1", "t1");

			expect(testedOf()).toEqual({ availability: "measured", testFirst: false });
		}));

	it("is unavailable for a source that cannot report test runs", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW });
			addTranscript("t1", { source: "claude" });
			linkMemoryTranscript("h1", "t1");

			expect(testedOf()).toEqual({ availability: "unavailable" });
		}));

	it("is partial when a journey mixes measured and unmeasured sessions", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW });
			addTranscript("t1", { testRuns: [NOW - 60_000] });
			addTranscript("t2", { source: "codex" });
			linkMemoryTranscript("h1", "t1");
			linkMemoryTranscript("h1", "t2");

			expect(testedOf()).toEqual({ availability: "partial", testFirst: true });
		}));
});
