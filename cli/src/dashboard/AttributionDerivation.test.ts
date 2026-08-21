/**
 * Human/agent turn-split derivation over a real SoT database, from
 * `StoredSession.entries` roles. Same seed pattern as `WaitDerivation.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DashboardDbHandle } from "./DashboardDb.js";
import { withDashboardDb } from "./DashboardDb.js";
import { buildJourneyDetail, buildJourneys } from "./JourneysQuery.js";

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

function addMemory(over: { hash: string; message: string; atMs: number; ticketId?: string }): void {
	const summary = {
		commitHash: over.hash,
		commitMessage: over.message,
		commitDate: new Date(over.atMs).toISOString(),
		branch: `feature/${over.hash}`,
		...(over.ticketId === undefined ? {} : { ticketId: over.ticketId }),
	};
	db.prepare(
		`INSERT INTO memories (repo_id, commit_hash, parent_hash, child_pos, root_hash, summary_json, first_seen_ms, written_at_ms, commit_date_ms)
		 VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
	).run(1, over.hash, over.hash, JSON.stringify(summary), over.atMs, over.atMs, over.atMs);
}

function addTranscript(
	transcriptId: string,
	entries: ReadonlyArray<{ role: string; content: string; timestamp?: string }>,
): void {
	const stored = { sessions: [{ sessionId: `s-${transcriptId}`, source: "claude", entries }] };
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

function detailFor(): ReturnType<typeof buildJourneyDetail> {
	const id = buildJourneys(db, { kind: "all" }, 0, NOW + 2 * DAY).journeys[0]?.id ?? "";
	return buildJourneyDetail(db, { kind: "all" }, { startMs: 0, endMs: NOW + 2 * DAY }, id);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-attr-"));
	dbPath = join(dir, "jollimemory.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("buildJourneyDetail — attribution", () => {
	it("splits the recorded turns by speaker", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW - DAY });
			addTranscript("t1", [
				{ role: "human", content: "please do X" },
				{ role: "assistant", content: "doing X" },
				{ role: "assistant", content: "done" },
				{ role: "human", content: "thanks" },
			]);
			linkMemoryTranscript("h1", "t1");

			expect(detailFor()?.attribution).toEqual({ humanTurns: 2, agentTurns: 2 });
		}));

	it("ignores entries that are neither human nor assistant", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW - DAY });
			addTranscript("t1", [
				{ role: "human", content: "hi" },
				{ role: "assistant", content: "hey" },
				{ role: "system", content: "ping" },
			]);
			linkMemoryTranscript("h1", "t1");

			expect(detailFor()?.attribution).toEqual({ humanTurns: 1, agentTurns: 1 });
		}));

	it("counts a transcript shared by two commits once", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "Closes JOLLI-9: one", atMs: NOW - 2 * DAY, ticketId: "JOLLI-9" });
			addMemory({ hash: "h2", message: "Closes JOLLI-9: two", atMs: NOW - DAY, ticketId: "JOLLI-9" });
			addTranscript("t1", [
				{ role: "human", content: "go" },
				{ role: "assistant", content: "ok" },
			]);
			linkMemoryTranscript("h1", "t1");
			linkMemoryTranscript("h2", "t1");

			expect(detailFor()?.attribution).toEqual({ humanTurns: 1, agentTurns: 1 });
		}));

	it("reports zero turns for a journey with no transcript", () =>
		inDb(() => {
			addRepo(1, "repo-a");
			addMemory({ hash: "h1", message: "do the thing", atMs: NOW - DAY });

			expect(detailFor()?.attribution).toEqual({ humanTurns: 0, agentTurns: 0 });
		}));
});
