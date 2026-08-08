/**
 * CutoverRouter — the four-state table, row by row. The two rows that a
 * boolean or a three-state implementation gets wrong are the ones pinned
 * hardest: fenced-but-uncommitted must NOT read as "not cut over" (that
 * routes writes onto the frozen branch), and never-fenced with a broken
 * database must NOT read as blocked (that halts healthy repos).
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCutoverFence } from "../core/RepoProfile.js";
import { hasCutoverRow, resetCutoverRouterCaches, resolveCutoverRoute } from "./CutoverRouter.js";
import { withDashboardDb } from "./DashboardDb.js";
import { resolveRepoIdentityForCwd } from "./RepoRegistry.js";

// Partial, with the real implementation behind a spy: the memo below is only
// observable as a CALL COUNT, and `vi.spyOn` on a live ESM namespace cannot
// rebind what CutoverRouter already imported. The spy has to sit on the entry
// point CutoverRouter actually calls — a spy on `resolveRepoIdentity` counts
// nothing, because `resolveRepoIdentityForCwd` reaches it through the module's
// own binding rather than through the mocked namespace.
vi.mock("./RepoRegistry.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./RepoRegistry.js")>();
	return { ...actual, resolveRepoIdentityForCwd: vi.fn(actual.resolveRepoIdentityForCwd) };
});

let dir: string;
let cwd: string;
let dbPath: string;

const FENCE = { reason: "cutover", at: "2026-08-04T00:00:00Z" };

/** Registers the repo and returns its identity, so repo_state rows can exist. */
async function registerInDb(): Promise<void> {
	const { resolveRepoIdentity } = await import("./RepoRegistry.js");
	const { identity } = await resolveRepoIdentity(cwd);
	await withDashboardDb(
		(db) =>
			db
				.prepare("INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)")
				.run(identity, "r", cwd, "t"),
		{ dbPath },
	);
}

async function writeCutoverRow(): Promise<void> {
	const { resolveRepoIdentity } = await import("./RepoRegistry.js");
	const { identity } = await resolveRepoIdentity(cwd);
	await withDashboardDb(
		(db) => {
			const repo = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as { id: number };
			db.prepare("INSERT INTO repo_state (repo_id, key, value) VALUES (?, 'cutover', ?)").run(
				repo.id,
				JSON.stringify({
					tips: { [cwd]: "a".repeat(40) },
					cutoverVersion: 1,
					committedAt: "t",
					schemaVersion: 1,
				}),
			);
		},
		{ dbPath },
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jolli-router-"));
	cwd = join(dir, "repo");
	mkdirSync(cwd, { recursive: true });
	// A real (tiny) git repo so profile.json anchors and identity resolves.
	execSync("git init -q", { cwd });
	dbPath = join(dir, "jollimemory.db");
	resetCutoverRouterCaches();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveCutoverRoute", () => {
	it("routes an untouched repo as uncutover, silently", async () => {
		await withDashboardDb(() => undefined, { dbPath }); // db exists, no rows
		expect(await resolveCutoverRoute(cwd, { dbPath })).toEqual({ state: "uncutover" });
	});

	it("never blocks a never-fenced repo on a broken database — warns instead", async () => {
		// Absent database: orphan is still this repo's source of truth.
		const route = await resolveCutoverRoute(cwd, { dbPath });
		expect(route.state).toBe("uncutover");
		expect((route as { warning?: string }).warning).toContain("does not exist");
		// Garbage database file: same verdict, different reason.
		writeFileSync(dbPath, "not a database");
		const route2 = await resolveCutoverRoute(cwd, { dbPath });
		expect(route2.state).toBe("uncutover");
		expect((route2 as { warning?: string }).warning).toBeTruthy();
	});

	it("routes fenced-but-uncommitted as legacy-fenced, the state a boolean loses", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		await registerInDb();
		await writeCutoverFence(cwd, FENCE);
		expect(await resolveCutoverRoute(cwd, { dbPath })).toEqual({ state: "legacy-fenced" });
	});

	it("a fence with an unusable database is blocked — never a fallback to orphan", async () => {
		await writeCutoverFence(cwd, FENCE);
		const route = await resolveCutoverRoute(cwd, { dbPath });
		expect(route.state).toBe("blocked");
		expect((route as { reason: string }).reason).toContain("does not exist");
	});

	it("routes a committed repo as cutover, with the CAS evidence", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		await registerInDb();
		await writeCutoverRow();
		// The fence is still present (never auto-revoked); the row outranks it.
		await writeCutoverFence(cwd, FENCE);
		const route = await resolveCutoverRoute(cwd, { dbPath });
		expect(route.state).toBe("cutover");
		expect((route as { record: { cutoverVersion: number } }).record.cutoverVersion).toBe(1);
	});

	it("a cutover row without a fence trace still routes as cutover", async () => {
		// The row is written strictly after fencing, so a lost profile.json
		// must not resurrect orphan writes.
		await withDashboardDb(() => undefined, { dbPath });
		await registerInDb();
		await writeCutoverRow();
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("cutover");
	});

	it("an unregistered repo in a usable database reads as no-row, not unavailable", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		expect(await resolveCutoverRoute(cwd, { dbPath })).toEqual({ state: "uncutover" });
		await writeCutoverFence(cwd, FENCE);
		expect(await resolveCutoverRoute(cwd, { dbPath })).toEqual({ state: "legacy-fenced" });
	});

	it("sidecars without the database file are unavailable, not a fresh install", async () => {
		writeFileSync(`${dbPath}-wal`, "wal of a deleted database");
		await writeCutoverFence(cwd, FENCE);
		const route = await resolveCutoverRoute(cwd, { dbPath });
		expect(route.state).toBe("blocked");
		expect((route as { reason: string }).reason).toContain("doctor --recover");
	});

	it("a schema from the future is unavailable: blocked when fenced", async () => {
		await withDashboardDb(
			(db) => db.prepare("UPDATE schema_meta SET value = '99' WHERE key = 'schema_version'").run(),
			{ dbPath },
		);
		await writeCutoverFence(cwd, FENCE);
		const route = await resolveCutoverRoute(cwd, { dbPath });
		expect(route.state).toBe("blocked");
		expect((route as { reason: string }).reason).toContain("upgrade this surface");
	});
});

describe("hasCutoverRow — the write-time second witness", () => {
	it("answers true exactly when the CAS row exists for this identity", async () => {
		await withDashboardDb(() => undefined, { dbPath });
		await registerInDb();
		expect(await hasCutoverRow(cwd, { dbPath })).toBe(false);
		await writeCutoverRow();
		// No fence needed: the row is keyed by the remote identity every clone
		// shares, which is the whole point — a clone the cutover never fenced
		// still learns the orphan is retired.
		expect(await hasCutoverRow(cwd, { dbPath })).toBe(true);
	});

	it("answers false, quietly, when the database cannot answer", async () => {
		// Absent database — the everyday pre-dashboard state every orphan write
		// passes through; it must neither block nor log.
		expect(await hasCutoverRow(cwd, { dbPath })).toBe(false);
		writeFileSync(dbPath, "not a database");
		expect(await hasCutoverRow(cwd, { dbPath })).toBe(false);
	});

	it("forks git for the identity once per cwd, not once per orphan write", async () => {
		// This runs on EVERY orphan write (the D6 second witness) and
		// resolveRepoIdentity shells out to read the canonical remote. A
		// worktree's identity cannot change under a live process, so the
		// resolution is memoized — same rule ProducerHooks keeps on the hook path.
		await withDashboardDb(() => undefined, { dbPath });
		await registerInDb();
		const spy = vi.mocked(resolveRepoIdentityForCwd);
		spy.mockClear();
		resetCutoverRouterCaches();
		await hasCutoverRow(cwd, { dbPath });
		await hasCutoverRow(cwd, { dbPath });
		await resolveCutoverRoute(cwd, { dbPath });
		expect(spy).toHaveBeenCalledTimes(1);
		// The seam exists so a test that reuses a cwd is not served a stale id.
		resetCutoverRouterCaches();
		await hasCutoverRow(cwd, { dbPath });
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
