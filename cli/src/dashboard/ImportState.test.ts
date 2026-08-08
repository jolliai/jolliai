/**
 * ImportState — the lifecycle record's reader and its one user-facing string.
 *
 * The reader's case list mirrors `CutoverRouter.readCutoverRow` because it has
 * the same obligation: "no record" and "cannot ask" must never collapse into
 * one answer. The formatter's table is pinned row by row, and the row that
 * matters most is the middle one — a live pid with a stale heartbeat is STILL
 * migrating. Reporting it as interrupted is the exact lie this whole feature
 * exists to remove.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./DashboardDb.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./DashboardDb.js")>();
	return { ...original, canUseDashboardDb: vi.fn(original.canUseDashboardDb) };
});

import { canUseDashboardDb, withDashboardDb } from "./DashboardDb.js";
import {
	cursorFingerprint,
	describeImportState,
	IMPORT_STALE_MS,
	type ImportStateAnswer,
	type OrphanImportState,
	readImportState,
	writeImportState,
} from "./ImportState.js";

let dir: string;
let cwd: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-importstate-"));
	cwd = join(dir, "repo");
	mkdirSync(cwd, { recursive: true });
	// A real (tiny) git repo so identity resolves, as CutoverRouter's tests do.
	execSync("git init -q", { cwd });
	dbPath = join(dir, "jollimemory.db");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function registerAndWrite(state: OrphanImportState): Promise<void> {
	const { resolveRepoIdentity } = await import("./RepoRegistry.js");
	const { identity } = await resolveRepoIdentity(cwd);
	await withDashboardDb(
		(db) => {
			db.prepare(
				"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
			).run(identity, "r", cwd, "t");
			const repo = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as { id: number };
			writeImportState(db, repo.id, state);
		},
		{ dbPath },
	);
}

describe("cursorFingerprint", () => {
	it("is order-sensitive, because the cursor indexes into that order", () => {
		expect(cursorFingerprint(["a", "b"])).toBe(cursorFingerprint(["a", "b"]));
		expect(cursorFingerprint(["a", "b"])).not.toBe(cursorFingerprint(["b", "a"]));
		expect(cursorFingerprint(["a", "b"])).not.toBe(cursorFingerprint(["a", "b", "c"]));
	});
});

describe("readImportState", () => {
	it("reports no record when the database file does not exist", async () => {
		// Certain, and actionable — unlike CutoverRouter, where the same state has
		// to stay "cannot ask".
		expect(await readImportState(cwd, { dbPath })).toEqual({ kind: "none" });
	});

	it("reports no record when the repo was never registered", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		expect(await readImportState(cwd, { dbPath })).toEqual({ kind: "none" });
	});

	it("reports no record when the repo is registered but has never imported", async () => {
		const { resolveRepoIdentity } = await import("./RepoRegistry.js");
		const { identity } = await resolveRepoIdentity(cwd);
		await withDashboardDb(
			(db) =>
				db
					.prepare(
						"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
					)
					.run(identity, "r", cwd, "t"),
			{ dbPath },
		);
		expect(await readImportState(cwd, { dbPath })).toEqual({ kind: "none" });
	});

	it("reports unavailable — never 'none' — when the file is not a database", async () => {
		writeFileSync(dbPath, "not a database");
		const answer = await readImportState(cwd, { dbPath });
		expect(answer.kind).toBe("unavailable");
	});

	it("reports unavailable when the schema is newer than this build", async () => {
		await withDashboardDb(
			(db) => db.prepare("UPDATE schema_meta SET value = '999' WHERE key = 'schema_version'").run(),
			{ dbPath },
		);
		const answer = await readImportState(cwd, { dbPath });
		expect(answer.kind).toBe("unavailable");
		expect((answer as { reason: string }).reason).toContain("999");
	});

	it("reports unavailable when the WAL survived but the database did not", async () => {
		writeFileSync(`${dbPath}-wal`, "");
		const answer = await readImportState(cwd, { dbPath });
		expect(answer.kind).toBe("unavailable");
		expect((answer as { reason: string }).reason).toContain("doctor");
	});

	it("reports unavailable — not 'none' — when the stored value is corrupt", async () => {
		// "Cannot tell" and "never migrated" must stay distinct: the second one
		// tells the user to re-run a migration that may already be complete.
		await registerAndWrite({ state: "done", nodes: 7 });
		await withDashboardDb(
			(db) => db.prepare("UPDATE repo_state SET value = '{ not json' WHERE key = 'orphan-import'").run(),
			{ dbPath },
		);
		expect((await readImportState(cwd, { dbPath })).kind).toBe("unavailable");
	});

	it("reports unavailable when this runtime cannot open the database at all", async () => {
		vi.mocked(canUseDashboardDb).mockReturnValueOnce(false);
		const answer = await readImportState(cwd, { dbPath });
		expect(answer.kind).toBe("unavailable");
		expect((answer as { reason: string }).reason).toContain("node:sqlite");
	});

	it("returns the record when one exists", async () => {
		await registerAndWrite({ state: "done", nodes: 7, at: 5_000 });
		expect(await readImportState(cwd, { dbPath })).toEqual({
			kind: "record",
			state: { state: "done", nodes: 7, at: 5_000 },
		});
	});
});

describe("describeImportState", () => {
	const NOW = 10_000_000;
	const record = (state: OrphanImportState): ImportStateAnswer => ({ kind: "record", state });

	it("tells a repo that has never migrated what to run", () => {
		expect(describeImportState({ kind: "none" }, NOW)).toBe("Not migrated — run `jolli dashboard`");
	});

	it("surfaces the reason when the database cannot be asked", () => {
		expect(describeImportState({ kind: "unavailable", reason: "no sqlite" }, NOW)).toBe("Unavailable (no sqlite)");
	});

	it("reads a pre-lifecycle row as done", () => {
		// Rows written before `state` existed were only ever written on success.
		// Any other reading tells a fully-migrated repo to migrate again.
		expect(describeImportState(record({ at: NOW, nodes: 12 }), NOW)).toBe("Migrated (12 memories, just now)");
	});

	it("counts one memory in the singular", () => {
		expect(describeImportState(record({ state: "done", at: NOW, nodes: 1 }), NOW)).toBe(
			"Migrated (1 memory, just now)",
		);
	});

	it("reports a live pid with a fresh heartbeat as migrating", () => {
		const line = describeImportState(
			record({ state: "running", pid: process.pid, heartbeatAt: NOW - 1_000, done: 1_600, total: 3_214 }),
			NOW,
		);
		expect(line).toBe(`Migrating — 1600/3214 memories (pid ${process.pid})`);
	});

	it("reports a live pid with a STALE heartbeat as migrating, not interrupted", () => {
		// The load-bearing row. The longest un-instrumented span in the import is
		// a batch read of thousands of git objects, so a quiet stretch is normal;
		// requiring a fresh heartbeat too would call a healthy run dead.
		const line = describeImportState(
			record({
				state: "running",
				pid: process.pid,
				heartbeatAt: NOW - IMPORT_STALE_MS - 60_000,
				done: 1_600,
				total: 3_214,
			}),
			NOW,
		);
		expect(line).toContain("Migrating —");
		expect(line).toContain("no progress for");
		expect(line).not.toContain("Interrupted");
	});

	it("reports a dead pid as interrupted, and says the run can be resumed", () => {
		const line = describeImportState(
			record({ state: "running", pid: 999_999, heartbeatAt: NOW, done: 1_600, total: 3_214 }),
			NOW,
		);
		expect(line).toBe("Interrupted at 1600/3214 — run `jolli dashboard` to resume");
	});

	it("scales the completion timestamp from minutes to days", () => {
		// Coarse on purpose — the exact stamp helps nobody on a status line — but
		// every bucket has to be reachable, or a week-old migration reads as
		// "168h ago".
		const at = (agoMs: number): string =>
			describeImportState(record({ state: "done", nodes: 1, at: NOW - agoMs }), NOW);
		expect(at(10_000)).toContain("just now");
		expect(at(5 * 60_000)).toContain("5m ago");
		expect(at(3 * 3_600_000)).toContain("3h ago");
		expect(at(5 * 24 * 3_600_000)).toContain("5d ago");
	});

	it("reports a recorded failure with its reason", () => {
		const line = describeImportState(
			record({ state: "failed", error: "database is locked", done: 12, total: 40 }),
			NOW,
		);
		expect(line).toContain("Failed at 12/40");
		expect(line).toContain("database is locked");
	});
});
