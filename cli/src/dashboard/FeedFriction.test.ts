/**
 * Per-journey friction derivation for the feed's `flagged` chip, over a real
 * SoT database. `buildJourneys` only attaches `friction` when the caller opts
 * in — the roster's page-load path must not pay the transcript walk.
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

function addTranscript(transcriptId: string, over: { source?: string; turnAborts?: number[] } = {}): void {
	const stored = {
		sessions: [
			{
				sessionId: `s-${transcriptId}`,
				source: over.source ?? "codex",
				entries: [],
				...(over.turnAborts === undefined ? {} : { turnAborts: over.turnAborts }),
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

function frictionOf(withFriction: boolean): unknown {
	return buildJourneys(db, { kind: "all" }, 0, NOW + 2 * DAY, undefined, { withFriction }).journeys[0]?.friction;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-feedfric-"));
	dbPath = join(dir, "jollimemory.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("buildJourneys — per-journey friction", () => {
	it("marks a journey measured with its abort count when opted in", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW - DAY });
			addTranscript("t1", { turnAborts: [NOW - 60_000, NOW] });
			linkMemoryTranscript("h1", "t1");

			expect(frictionOf(true)).toEqual({ availability: "measured", value: 2 });
		}));

	it("reads unavailable, never zero, for a Claude-only journey", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW - DAY });
			addTranscript("t1", { source: "claude" });
			linkMemoryTranscript("h1", "t1");

			expect(frictionOf(true)).toEqual({ availability: "unavailable" });
		}));

	it("reads partial when a journey mixes a measured and an unmeasured Codex session", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW - DAY });
			addTranscript("t1", { turnAborts: [NOW] });
			addTranscript("t2", { source: "codex" });
			linkMemoryTranscript("h1", "t1");
			linkMemoryTranscript("h1", "t2");

			expect(frictionOf(true)).toEqual({ availability: "partial", value: 1 });
		}));

	it("leaves friction absent when the caller does not opt in", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW - DAY });
			addTranscript("t1", { turnAborts: [NOW] });
			linkMemoryTranscript("h1", "t1");

			expect(frictionOf(false)).toBeUndefined();
		}));
});
