/**
 * CutoverBlock — the storage and the witness. What matters here is the two
 * defaults: an input that moved must retire the record (the memo may never
 * outlive its inputs), and anything unreadable must read as NO block (a repo we
 * cannot explain is a repo we retry, never one we give up on).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	CUTOVER_BLOCK_KEY,
	type CutoverBlockRecord,
	clearCutoverBlockRow,
	cutoverBlockWitness,
	readCutoverBlockRow,
	writeCutoverBlockRow,
} from "./CutoverBlock.js";
import { type DashboardDbHandle, withDashboardDb } from "./DashboardDb.js";

let dir: string;
let dbPath: string;
let nextId = 0;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-cutoverblock-"));
	dbPath = join(dir, "jollimemory.db");
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A fresh `repos` row — `repo_state.repo_id` is a real foreign key. */
function newRepo(db: DashboardDbHandle): number {
	const identity = `repo-${++nextId}`;
	db.prepare(
		`INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at)
		 VALUES (?, ?, ?, ?)`,
	).run(identity, identity, `/tmp/${identity}`, "2026-08-18T00:00:00.000Z");
	const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as { id: number };
	return row.id;
}

const RECORD: CutoverBlockRecord = {
	code: "stored-nothing",
	reason: "the import stored nothing from /repo",
	witness: "dev|/repo@abc",
	at: 1_770_000_000_000,
};

/** Real handle, real SQL — the point of the module is what SQLite stores. */
async function onDb<T>(fn: (db: DashboardDbHandle, repoId: number) => T): Promise<T> {
	return withDashboardDb((db) => fn(db, newRepo(db)), { dbPath });
}

describe("cutoverBlockWitness", () => {
	it("is order-insensitive — `collectSources` order is a lock order, not an input", async () => {
		const a = cutoverBlockWitness([
			{ root: "/b", tip: "222" },
			{ root: "/a", tip: "111" },
		]);
		const b = cutoverBlockWitness([
			{ root: "/a", tip: "111" },
			{ root: "/b", tip: "222" },
		]);
		expect(a).toBe(b);
	});

	it("changes when a tip moves", () => {
		expect(cutoverBlockWitness([{ root: "/a", tip: "111" }])).not.toBe(
			cutoverBlockWitness([{ root: "/a", tip: "222" }]),
		);
	});

	it("changes when a source gains or loses its branch (NO_ORPHAN_TIP is a value)", () => {
		expect(cutoverBlockWitness([{ root: "/a", tip: "" }])).not.toBe(
			cutoverBlockWitness([{ root: "/a", tip: "111" }]),
		);
	});

	it("changes when a source appears — a new clone is a new input", () => {
		expect(cutoverBlockWitness([{ root: "/a", tip: "111" }])).not.toBe(
			cutoverBlockWitness([
				{ root: "/a", tip: "111" },
				{ root: "/b", tip: "111" },
			]),
		);
	});

	it("carries the build version, so upgrading retires every recorded block", () => {
		// The version leads the string — that is what makes a new importer re-earn
		// the refusal instead of inheriting the last build's verdict. Read from the
		// same define the module reads, so this cannot drift with a release.
		expect(cutoverBlockWitness([{ root: "/a", tip: "111" }])).toBe(`${__CLI_PKG_VERSION__}|/a@111`);
	});
});

describe("the repo_state row", () => {
	it("round-trips", async () => {
		expect(
			await onDb((db, repoId) => {
				writeCutoverBlockRow(db, repoId, RECORD);
				return readCutoverBlockRow(db, repoId);
			}),
		).toEqual(RECORD);
	});

	it("reads as no-block when nothing was ever written", async () => {
		expect(await onDb((db, repoId) => readCutoverBlockRow(db, repoId))).toBeNull();
	});

	it("upserts rather than duplicating — one row per repo", async () => {
		const [second, count] = await onDb((db, repoId) => {
			writeCutoverBlockRow(db, repoId, RECORD);
			writeCutoverBlockRow(db, repoId, { ...RECORD, code: "no-summary-rows", witness: "dev|/repo@def" });
			const rows = db
				.prepare("SELECT COUNT(*) AS n FROM repo_state WHERE repo_id = ? AND key = ?")
				.get(repoId, CUTOVER_BLOCK_KEY) as { n: number };
			return [readCutoverBlockRow(db, repoId), rows.n] as const;
		});
		expect(second).toMatchObject({ code: "no-summary-rows", witness: "dev|/repo@def" });
		expect(count).toBe(1);
	});

	it("clears", async () => {
		expect(
			await onDb((db, repoId) => {
				writeCutoverBlockRow(db, repoId, RECORD);
				clearCutoverBlockRow(db, repoId);
				return readCutoverBlockRow(db, repoId);
			}),
		).toBeNull();
	});

	it("clearing a repo that has no record is a no-op, not an error", async () => {
		await expect(onDb((db, repoId) => clearCutoverBlockRow(db, repoId))).resolves.toBeUndefined();
	});

	it("is scoped per repo — one repo's block cannot answer for another", async () => {
		expect(
			await withDashboardDb(
				(db) => {
					const mine = newRepo(db);
					const theirs = newRepo(db);
					writeCutoverBlockRow(db, mine, RECORD);
					return readCutoverBlockRow(db, theirs);
				},
				{ dbPath },
			),
		).toBeNull();
	});
});

describe("an unreadable record", () => {
	// Both cases default to "no block", i.e. one wasted attempt. The opposite
	// default would let a corrupt value stop a healthy repo from EVER cutting
	// over, which no amount of saved import time is worth.
	it("reads as no-block when the value is not JSON", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				await onDb((db, repoId) => {
					db.prepare("INSERT INTO repo_state (repo_id, key, value) VALUES (?, ?, ?)").run(
						repoId,
						CUTOVER_BLOCK_KEY,
						"{ not json",
					);
					return readCutoverBlockRow(db, repoId);
				}),
			).toBeNull();
		} finally {
			warn.mockRestore();
		}
	});

	it.each([
		["a code this build does not know", { ...RECORD, code: "invented-later" }],
		["a missing witness", { code: "stored-nothing", reason: "r", at: 1 }],
		["a non-numeric timestamp", { ...RECORD, at: "yesterday" }],
		["an absent reason", { code: "stored-nothing", witness: "w", at: 1 }],
	])("reads as no-block for %s", async (_label, value) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				await onDb((db, repoId) => {
					db.prepare("INSERT INTO repo_state (repo_id, key, value) VALUES (?, ?, ?)").run(
						repoId,
						CUTOVER_BLOCK_KEY,
						JSON.stringify(value),
					);
					return readCutoverBlockRow(db, repoId);
				}),
			).toBeNull();
		} finally {
			warn.mockRestore();
		}
	});
});
