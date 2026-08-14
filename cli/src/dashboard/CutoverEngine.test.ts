/**
 * CutoverEngine — the protocol's regression net. The deterministic
 * concurrency case is the one the plan calls the whole protocol's reason to
 * exist: a write that lands between the compare and the CAS must be seen by
 * the tip check, retried, and the frozen branch must not have moved when the
 * commit finally lands.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCommittish } from "../core/GitRefStorage.js";
import { readCutoverFence, writeCutoverFence } from "../core/RepoProfile.js";
import { ORPHAN_BRANCH } from "../Logger.js";
import { type RestoreHome, setIsolatedHome } from "../testUtils/isolatedHome.js";
import { probeCutoverDrift, runCutover } from "./CutoverEngine.js";
import { resolveCutoverRoute } from "./CutoverRouter.js";
import { withDashboardDb } from "./DashboardDb.js";
import { readRepoRegistry, registerRepo } from "./RepoRegistry.js";

let dir: string;
let cwd: string;
let dbPath: string;
let home: string;
let restoreHome: RestoreHome;

const HASH = "a".repeat(40);

async function resolveIdentity(): Promise<string> {
	const { resolveRepoIdentity } = await import("./RepoRegistry.js");
	return (await resolveRepoIdentity(cwd)).identity;
}

function summaryJson(hash: string, message: string): string {
	return JSON.stringify(
		{
			version: "5",
			commitHash: hash,
			commitMessage: message,
			commitDate: "2026-07-01T00:00:00.000Z",
			branch: "main",
			commitType: "commit",
			topics: [],
			children: [],
		},
		null,
		"\t",
	);
}

/** A post-fence regeneration of {@link HASH}: same commit, a body only the database has. */
const regeneratedJson = summaryJson(HASH, "regenerated after the fence");

/** The commit message the database currently holds for `hash` — the observable side of a rollback. */
async function storedMessage(hash: string): Promise<string | undefined> {
	const row = await withDashboardDb(
		(db) =>
			db.prepare("SELECT commit_message FROM memories WHERE commit_hash = ?").get(hash) as
				| { commit_message: string }
				| undefined,
		{ dbPath },
	);
	return row?.commit_message;
}

async function writeOrphanSummary(hash: string, message: string): Promise<void> {
	// Plumbing, not OrphanBranchStorage: the race these tests inject models an
	// OLD runtime that does not know the fence — the storage class's own
	// write-time fence check (D6) would correctly refuse after fencing, which
	// is exactly why the simulation must go underneath it.
	const { ensureOrphanBranch, writeMultipleFilesToBranch } = await import("../core/GitOps.js");
	await ensureOrphanBranch(ORPHAN_BRANCH, cwd);
	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		[{ path: `summaries/${hash}.json`, content: summaryJson(hash, message) }],
		"add",
		cwd,
	);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "jolli-cutover-"));
	// Isolated HOME: the registry and profile paths are machine-global. Must go
	// through the helper — setting `HOME` alone leaves the real home in place on
	// Windows, where `os.homedir()` reads `USERPROFILE`.
	home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	restoreHome = setIsolatedHome(home);
	cwd = join(dir, "repo");
	mkdirSync(cwd, { recursive: true });
	execSync("git init -q", { cwd });
	// Repo-local identity: the isolated HOME hides any global gitconfig, and
	// OrphanBranchStorage's plumbing commits need an author.
	execSync("git config user.email t@t && git config user.name t", { cwd });
	execSync("git commit -q --allow-empty -m init", { cwd });
	dbPath = join(dir, "jollimemory.db");
	await registerRepo({ cwd, now: () => new Date(0) });
});

afterEach(() => {
	restoreHome();
	rmSync(dir, { recursive: true, force: true });
});

describe("runCutover", () => {
	it("refuses an unregistered repo and a repo without an orphan branch", async () => {
		const stranger = join(dir, "stranger");
		mkdirSync(stranger, { recursive: true });
		execSync("git init -q", { cwd: stranger });
		execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: stranger });
		expect((await runCutover(stranger, { dbPath })).status).toBe("not-ready");
		// Registered, but no orphan branch yet.
		const result = await runCutover(cwd, { dbPath });
		expect(result).toMatchObject({ status: "not-ready", reason: expect.stringContaining("no orphan branch") });
	});

	it("a database written by a newer build cuts over normally — no version gate left", async () => {
		await writeOrphanSummary(HASH, "the memory");
		// Stamp the format ahead of this build, the way a dev machine that ran a later
		// build leaves it. This used to make every writable open throw, so the CAS
		// could never land and the whole repo reported not-ready. The database no
		// longer refuses anyone, so the cutover simply proceeds.
		await withDashboardDb(
			(db) =>
				db
					.prepare(
						`INSERT INTO schema_meta (key, value) VALUES ('schema_version', '999')
						 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
					)
					.run(),
			{ dbPath },
		);

		expect((await runCutover(cwd, { dbPath })).status).toBe("committed");
		expect(await readCutoverFence(cwd)).not.toBeNull();
	});

	it("imports, compares, fences every source, and commits the CAS", async () => {
		await writeOrphanSummary(HASH, "the memory");
		const tip = await resolveCommittish(ORPHAN_BRANCH, cwd);
		const result = await runCutover(cwd, { dbPath, nowMs: 1000 });
		expect(result.status).toBe("committed");
		const record = (result as { record: { tips: Record<string, string>; cutoverVersion: number } }).record;
		expect(Object.values(record.tips)).toEqual([tip]);
		expect(record.cutoverVersion).toBe(1);
		// The fence is up, with the pinned tips riding on it.
		const fence = await readCutoverFence(cwd);
		expect(fence?.tips && Object.values(fence.tips)).toEqual([tip]);
		// The router now answers cutover; a re-run is a no-op.
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("cutover");
		expect((await runCutover(cwd, { dbPath })).status).toBe("already-cutover");
		// And the memory really is in the database.
		const rows = await withDashboardDb(
			(db) => db.prepare("SELECT commit_hash FROM memories").all() as { commit_hash: string }[],
			{ dbPath },
		);
		expect(rows).toEqual([{ commit_hash: HASH }]);
	});

	it("a failing compare stays in prepare: no fence, no CAS", async () => {
		await writeOrphanSummary(HASH, "the memory");
		const result = await runCutover(cwd, {
			dbPath,
			compare: async () => ({ ok: false, detail: "injected mismatch" }),
		});
		expect(result).toMatchObject({ status: "not-ready", reason: expect.stringContaining("injected mismatch") });
		expect(await readCutoverFence(cwd)).toBeNull();
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("uncutover");
	});

	it("deterministic race: a write between compare and CAS forces a retry, and the frozen tip never moves after commit", async () => {
		await writeOrphanSummary(HASH, "first");
		let injected = false;
		const result = await runCutover(cwd, {
			dbPath,
			nowMs: 1000,
			compare: async () => {
				// The barrier: a writer lands AFTER the compare passed, BEFORE the
				// CAS takes the locks — the exact silent-loss window.
				if (!injected) {
					injected = true;
					await writeOrphanSummary("b".repeat(40), "raced in after compare");
				}
				return { ok: true, detail: "ok" };
			},
		});
		expect(result.status).toBe("committed");
		// The retry re-pinned: the committed tips are the CURRENT branch tip,
		// and the raced-in memory made it into the database (not lost).
		const finalTip = await resolveCommittish(ORPHAN_BRANCH, cwd);
		const record = (result as { record: { tips: Record<string, string> } }).record;
		expect(Object.values(record.tips)).toEqual([finalTip]);
		const rows = await withDashboardDb(
			(db) =>
				db.prepare("SELECT commit_hash FROM memories ORDER BY commit_hash").all() as { commit_hash: string }[],
			{ dbPath },
		);
		expect(rows.map((r) => r.commit_hash)).toEqual([HASH, "b".repeat(40)]);
	});

	it("gives up after maxRetries with the fence still up — resume finishes later", async () => {
		await writeOrphanSummary(HASH, "first");
		let n = 0;
		const result = await runCutover(cwd, {
			dbPath,
			maxRetries: 1,
			compare: async () => {
				n++;
				await writeOrphanSummary(String(n).padStart(40, "0"), `always racing ${n}`);
				return { ok: true, detail: "ok" };
			},
		});
		expect(result.status).toBe("retry-exhausted");
		// One-way: the fence stays up; the router answers legacy-fenced.
		expect(await readCutoverFence(cwd)).not.toBeNull();
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("legacy-fenced");
		// Resume: no more racing — the CAS completes without re-fencing.
		const resumed = await runCutover(cwd, { dbPath });
		expect(resumed.status).toBe("committed");
	});

	it("a busy orphan-write.lock is a retry, not a crash after the fence went up", async () => {
		// Contention is ordinary: legitimate writers hold this lock across whole
		// post-LLM write sections. It used to throw out of runCutover — past
		// CutoverCommand's uncaught action — so the user got a stack trace
		// AFTER the fence was already up, instead of the documented outcome and
		// its "re-run to finish" guidance.
		await writeOrphanSummary(HASH, "first");
		const { acquireOrphanWriteLock, releaseOrphanWriteLock } = await import("../core/Locks.js");
		expect(await acquireOrphanWriteLock(cwd)).toBe(true);
		try {
			const result = await runCutover(cwd, { dbPath, maxRetries: 1, lockTimeoutMs: 20 });
			expect(result.status).toBe("retry-exhausted");
			expect((result as { reason: string }).reason).toContain("lock stayed busy");
		} finally {
			await releaseOrphanWriteLock(cwd);
		}
		// The fence is up (one-way) and the repo routes as legacy-fenced, so
		// writes go to SQLite — and the resume completes once the lock is free.
		expect(await readCutoverFence(cwd)).not.toBeNull();
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("legacy-fenced");
		expect((await runCutover(cwd, { dbPath })).status).toBe("committed");
	});

	it("real end-to-end compare passes via the containment criterion", async () => {
		// Every family, including the two allowlisted divergences: a parent
		// whose embedded child is STALE relative to the child's own file (the
		// database reassembles from current rows, so bytes differ — the
		// shell+child-set criterion must absorb it), and a stored topic index
		// whose entry order differs from the synthesized one.
		const staleChild = JSON.parse(summaryJson("c".repeat(40), "old embedded copy")) as Record<string, unknown>;
		const parent = JSON.parse(summaryJson("d".repeat(40), "parent")) as Record<string, unknown>;
		parent.children = [staleChild];
		const page = (slug: string, title: string): string =>
			JSON.stringify(
				{
					schemaVersion: 1,
					stableSlug: slug,
					title,
					content: `# ${title}`,
					relatedBranches: [],
					sourceRefs: [],
					lastUpdatedAt: "2026-07-03T00:00:00.000Z",
				},
				null,
				"\t",
			);
		const { ensureOrphanBranch, writeMultipleFilesToBranch } = await import("../core/GitOps.js");
		await ensureOrphanBranch(ORPHAN_BRANCH, cwd);
		await writeMultipleFilesToBranch(
			ORPHAN_BRANCH,
			[
				{ path: `summaries/${"d".repeat(40)}.json`, content: JSON.stringify(parent, null, "\t") },
				{ path: `summaries/${"c".repeat(40)}.json`, content: summaryJson("c".repeat(40), "fresh child file") },
				{ path: "plans/my-plan.md", content: "# my plan" },
				{ path: "notes/n-1.md", content: "note" },
				{ path: "plan-progress/my-plan.json", content: JSON.stringify({ planSlug: "my-plan", v: 1 }) },
				{ path: "topics/alpha.json", content: page("alpha", "Alpha") },
				{ path: "topics/beta.json", content: page("beta", "Beta") },
				{
					path: "topics/index.json",
					content: JSON.stringify(
						{
							schemaVersion: 1,
							topics: [
								{
									stableSlug: "beta",
									title: "Beta",
									summary: "b",
									relatedBranches: [],
									sourceRefs: [],
									lastUpdatedAt: "2026-07-03T00:00:00.000Z",
								},
								{
									stableSlug: "alpha",
									title: "Alpha",
									summary: "a",
									relatedBranches: [],
									sourceRefs: [],
									lastUpdatedAt: "2026-07-03T00:00:00.000Z",
								},
							],
						},
						null,
						"\t",
					),
				},
			],
			"seed all families",
			cwd,
		);
		// No injected compare: compareSourceContainment runs for real against
		// the imported database.
		const result = await runCutover(cwd, { dbPath });
		expect(result.status).toBe("committed");
	});

	it("the real compare fails containment when the database is missing a path", async () => {
		await writeOrphanSummary(HASH, "will not be imported");
		// Import nothing: inject an importer bypass by comparing BEFORE import —
		// simplest honest shape is a compare against an empty database via a
		// second db path that no import ever touched.
		const { SqliteStorage } = await import("../core/SqliteStorage.js");
		const { GitRefStorage } = await import("../core/GitRefStorage.js");
		const { compareSourceContainment } = await import("./CutoverEngine.js");
		const tip = (await resolveCommittish(ORPHAN_BRANCH, cwd)) as string;
		const emptyDb = join(dir, "empty.db");
		await withDashboardDb(
			(db) =>
				db
					.prepare(
						"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
					)
					.run("x", "x", "/x", "t"),
			{ dbPath: emptyDb },
		);
		const verdict = await compareSourceContainment(new GitRefStorage(tip, cwd), new SqliteStorage("x", emptyDb));
		expect(verdict.ok).toBe(false);
		expect(verdict.detail).toContain("missing from the database");
	});

	it("compare degrades per-path without batchReadFiles, flags content drift, and strips keyless children", async () => {
		const { SqliteStorage } = await import("../core/SqliteStorage.js");
		const { compareSourceContainment } = await import("./CutoverEngine.js");
		await writeOrphanSummary(HASH, "seed");
		expect((await runCutover(cwd, { dbPath })).status).toBe("committed");
		void SqliteStorage;
		// Two fakes: the orphan side has NO batchReadFiles (per-path fallback
		// arm), a keyless-children summary that differs only in whitespace from
		// the "database" side (equivalence via strip()'s ?? [] arm), and a plan
		// whose body genuinely differs → "content differs".
		const keyless = JSON.parse(summaryJson(HASH, "seed")) as Record<string, unknown>;
		delete keyless.children;
		const files = (spaced: boolean): Record<string, string> => ({
			[`summaries/${HASH}.json`]: JSON.stringify(keyless, null, spaced ? "\t" : 2),
			"plans/other.md": spaced ? "# orphan copy" : "# database copy",
		});
		const provider = (spaced: boolean, batch: boolean) => ({
			async readFile(path: string): Promise<string | null> {
				return files(spaced)[path] ?? null;
			},
			...(batch
				? {
						async batchReadFiles(paths: string[]): Promise<Map<string, string | null>> {
							return new Map(paths.map((p) => [p, files(spaced)[p] ?? null]));
						},
					}
				: {}),
			async listFiles(prefix: string): Promise<string[]> {
				return Object.keys(files(spaced)).filter((p) => p.startsWith(prefix));
			},
			async writeFiles(): Promise<void> {},
			async exists(): Promise<boolean> {
				return true;
			},
			async ensure(): Promise<void> {},
		});
		const verdict = await compareSourceContainment(
			provider(true, false),
			provider(false, true) as unknown as InstanceType<typeof SqliteStorage>,
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.detail).toBe("plans/other.md: content differs");
	});

	it("VISITS skills/ and a reordered topic page during the containment compare", async () => {
		const { SqliteStorage } = await import("../core/SqliteStorage.js");
		const { compareSourceContainment } = await import("./CutoverEngine.js");
		void SqliteStorage;
		// Two omissions the families list used to carry. `skills/` was absent
		// entirely, so containment read ZERO skill paths and reported ok — certifying
		// a freeze after which the only copy of every archived skill sat on a branch
		// the router no longer reads. And the order-insensitive allowance meant for
		// `topics/index.json` alone was applied via startsWith("topics/") to every
		// topic PAGE, whose array order is exactly what `topic_source_refs.pos` exists
		// to preserve.
		const orphan = {
			"skills/claude/brainstorming-a1b2c3d4.md": "# skill",
			"topics/alpha.json": JSON.stringify({ stableSlug: "alpha", sourceRefs: ["r1", "r2"] }),
		};
		const db = {
			"skills/claude/brainstorming-a1b2c3d4.md": "# DIFFERENT skill",
			"topics/alpha.json": JSON.stringify({ stableSlug: "alpha", sourceRefs: ["r2", "r1"] }),
		};
		const provider = (files: Record<string, string>) => ({
			async readFile(path: string): Promise<string | null> {
				return files[path] ?? null;
			},
			async batchReadFiles(paths: string[]): Promise<Map<string, string | null>> {
				return new Map(paths.map((p) => [p, files[p] ?? null]));
			},
			async listFiles(prefix: string): Promise<string[]> {
				return Object.keys(files).filter((p) => p.startsWith(prefix));
			},
			async writeFiles(): Promise<void> {},
			async exists(): Promise<boolean> {
				return true;
			},
			async ensure(): Promise<void> {},
		});

		const verdict = await compareSourceContainment(
			provider(orphan),
			provider(db) as unknown as InstanceType<typeof SqliteStorage>,
		);
		expect(verdict.ok).toBe(false);
		// Skills are compared first (families order), so that is the reported drift —
		// the point being that it is reported at all.
		expect(verdict.detail).toContain("skills/claude/brainstorming-a1b2c3d4.md");
	});

	it("reports a reordered topic page as drift, unlike topics/index.json", async () => {
		const { SqliteStorage } = await import("../core/SqliteStorage.js");
		const { compareSourceContainment } = await import("./CutoverEngine.js");
		void SqliteStorage;
		const page = (refs: string[]): string => JSON.stringify({ stableSlug: "alpha", sourceRefs: refs });
		const provider = (files: Record<string, string>) => ({
			async readFile(path: string): Promise<string | null> {
				return files[path] ?? null;
			},
			async batchReadFiles(paths: string[]): Promise<Map<string, string | null>> {
				return new Map(paths.map((p) => [p, files[p] ?? null]));
			},
			async listFiles(prefix: string): Promise<string[]> {
				return Object.keys(files).filter((p) => p.startsWith(prefix));
			},
			async writeFiles(): Promise<void> {},
			async exists(): Promise<boolean> {
				return true;
			},
			async ensure(): Promise<void> {},
		});

		const drift = await compareSourceContainment(
			provider({ "topics/alpha.json": page(["r1", "r2"]) }),
			provider({ "topics/alpha.json": page(["r2", "r1"]) }) as unknown as InstanceType<typeof SqliteStorage>,
		);
		expect(drift).toMatchObject({ ok: false, detail: "topics/alpha.json: content differs" });

		// The index keeps its allowance: its entry order falls out of a query.
		// Both entries carry a page file so they survive the unbacked-entry filter
		// and the assertion is about ORDER, not about them being dropped.
		const pages = { "topics/a.json": page([]), "topics/b.json": page([]) };
		const index = { schemaVersion: 1, topics: [{ stableSlug: "a" }, { stableSlug: "b" }] };
		const reversed = { schemaVersion: 1, topics: [{ stableSlug: "b" }, { stableSlug: "a" }] };
		const ok = await compareSourceContainment(
			provider({ ...pages, "topics/index.json": JSON.stringify(index) }),
			provider({ ...pages, "topics/index.json": JSON.stringify(reversed) }) as unknown as InstanceType<
				typeof SqliteStorage
			>,
		);
		expect(ok.ok).toBe(true);
	});

	it("accepts a union view that CONTAINS the source, for both topics/ views", async () => {
		const { SqliteStorage } = await import("../core/SqliteStorage.js");
		const { compareSourceContainment } = await import("./CutoverEngine.js");
		void SqliteStorage;
		const provider = (files: Record<string, string>) => ({
			async readFile(path: string): Promise<string | null> {
				return files[path] ?? null;
			},
			async batchReadFiles(paths: string[]): Promise<Map<string, string | null>> {
				return new Map(paths.map((p) => [p, files[p] ?? null]));
			},
			async listFiles(prefix: string): Promise<string[]> {
				return Object.keys(files).filter((p) => p.startsWith(prefix));
			},
			async writeFiles(): Promise<void> {},
			async exists(): Promise<boolean> {
				return true;
			},
			async ensure(): Promise<void> {},
		});
		// Two clones of one remote import into ONE repo id, so both synthesized
		// views render A∪B. Equality could never hold against either clone's
		// file, which left such a repo permanently un-cutoverable.
		// The page files matter: an index entry with no `topics/<slug>.json` on the
		// branch is dropped from the source side before comparing (it can never be
		// in the database), so without them this would pass vacuously.
		const cloneA = {
			"topics/a.json": JSON.stringify({ stableSlug: "a" }),
			"topics/index.json": JSON.stringify({ schemaVersion: 1, topics: [{ stableSlug: "a" }] }),
			"topics/processed.json": JSON.stringify({
				schemaVersion: 1,
				processed: { summary: ["s1"], plan: [], note: [], userfile: [] },
			}),
		};
		const union = {
			"topics/a.json": JSON.stringify({ stableSlug: "a" }),
			"topics/index.json": JSON.stringify({
				schemaVersion: 1,
				topics: [{ stableSlug: "b" }, { stableSlug: "a" }],
			}),
			"topics/processed.json": JSON.stringify({
				schemaVersion: 1,
				processed: { summary: ["s2", "s1"], plan: ["p1"], note: [], userfile: [] },
			}),
		};
		const contained = await compareSourceContainment(
			provider(cloneA),
			provider(union) as unknown as InstanceType<typeof SqliteStorage>,
		);
		expect(contained.ok).toBe(true);

		// Containment is one-directional: an entry the SOURCE lists and the
		// database lacks is still drift.
		const missing = await compareSourceContainment(
			provider(cloneA),
			provider({
				...union,
				"topics/processed.json": JSON.stringify({
					schemaVersion: 1,
					processed: { summary: ["s2"], plan: [], note: [], userfile: [] },
				}),
			}) as unknown as InstanceType<typeof SqliteStorage>,
		);
		expect(missing).toMatchObject({ ok: false, detail: "topics/processed.json: content differs" });
	});

	describe("compares only what the import would take", () => {
		const provider = (files: Record<string, string>) => ({
			async readFile(path: string): Promise<string | null> {
				return files[path] ?? null;
			},
			async batchReadFiles(paths: string[]): Promise<Map<string, string | null>> {
				return new Map(paths.map((p) => [p, files[p] ?? null]));
			},
			async listFiles(prefix: string): Promise<string[]> {
				return Object.keys(files).filter((p) => p.startsWith(prefix));
			},
			async writeFiles(): Promise<void> {},
			async exists(): Promise<boolean> {
				return true;
			},
			async ensure(): Promise<void> {},
		});
		const compare = async (source: Record<string, string>, db: Record<string, string>) => {
			const { SqliteStorage } = await import("../core/SqliteStorage.js");
			const { compareSourceContainment } = await import("./CutoverEngine.js");
			return compareSourceContainment(
				provider(source),
				provider(db) as unknown as InstanceType<typeof SqliteStorage>,
			);
		};

		it("ignores files whose extension the import filters out", async () => {
			// The import reads `notes/*.md` and `summaries/*.json` only, so the
			// database can never answer for these — demanding it did made any stray
			// file a permanent, silent cutover blocker.
			const verdict = await compare(
				{ "notes/scratch.txt": "x", "summaries/a.json.bak": "y", "notes/real.md": "kept" },
				{ "notes/real.md": "kept" },
			);
			expect(verdict.ok).toBe(true);
		});

		it("still blocks on a file the import WOULD take and the database lacks", async () => {
			const verdict = await compare({ "notes/real.md": "kept" }, {});
			expect(verdict).toMatchObject({ ok: false, detail: "notes/real.md: missing from the database" });
		});

		it("ignores nested topic paths, which listTopicPageSlugs also refuses", async () => {
			expect((await compare({ "topics/sub/x.json": "x" }, {})).ok).toBe(true);
		});

		it("drops index entries with no page file on the branch", async () => {
			// The database renders `topics/index.json` from `topic_pages`, and a row
			// exists only where a PAGE was imported. An index entry whose page file
			// is absent can therefore never be contained — and the state is stable,
			// because `saveTopicIndex` never prunes such entries.
			const source = {
				"topics/kept.json": JSON.stringify({ stableSlug: "kept" }),
				"topics/index.json": JSON.stringify({
					schemaVersion: 1,
					topics: [{ stableSlug: "kept" }, { stableSlug: "shell", summary: "only in the index" }],
				}),
			};
			const db = {
				"topics/kept.json": JSON.stringify({ stableSlug: "kept" }),
				"topics/index.json": JSON.stringify({ schemaVersion: 1, topics: [{ stableSlug: "kept" }] }),
			};
			expect((await compare(source, db)).ok).toBe(true);

			// A BACKED entry the database lacks is still drift — the narrowing is
			// only about entries the import could never have stored.
			const backedButMissing = {
				...source,
				"topics/shell.json": JSON.stringify({ stableSlug: "shell" }),
			};
			// Reported as the PAGE, not as the index: union views are compared after
			// the pages precisely so the detail names a file the user can look at.
			expect(await compare(backedButMissing, db)).toMatchObject({
				ok: false,
				detail: "topics/shell.json: missing from the database",
			});
		});

		it("accepts an index of only-unbacked entries against a database with no topics at all", async () => {
			// `synthTopicIndex` answers null until the database holds one page, and
			// the null check runs before the union-view branch — so this shape used
			// to report `missing from the database` and could never be filtered.
			const verdict = await compare(
				{ "topics/index.json": JSON.stringify({ schemaVersion: 1, topics: [{ stableSlug: "shell" }] }) },
				{},
			);
			expect(verdict.ok).toBe(true);
		});

		it("falls back to the STRICTER comparison when the index cannot be parsed", async () => {
			const verdict = await compare({ "topics/index.json": "{not json" }, { "topics/index.json": "{}" });
			expect(verdict).toMatchObject({ ok: false, detail: "topics/index.json: content differs" });

			// And the same input against an EMPTY database is a failure, not the
			// "nothing survived the filter" pass. This is what the unparsable
			// branch's `kept: 1` buys: an index we cannot interpret must never
			// widen what the compare accepts, and `kept: 0` there would certify a
			// cutover for a document nobody has read.
			expect(await compare({ "topics/index.json": "{not json" }, {})).toMatchObject({
				ok: false,
				detail: "topics/index.json: missing from the database",
			});
		});
	});

	it("increments the cutover version over a prior generation", async () => {
		await writeOrphanSummary(HASH, "seed");
		const identity = await resolveIdentity();
		await withDashboardDb(
			(db) => {
				db.prepare(
					"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
				).run(identity, "r", cwd, "t");
				const row = db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as { id: number };
				db.prepare("INSERT INTO repo_state (repo_id, key, value) VALUES (?, 'cutover-version', '4')").run(
					row.id,
				);
			},
			{ dbPath },
		);
		const result = await runCutover(cwd, { dbPath });
		expect(result).toMatchObject({ status: "committed", record: { cutoverVersion: 5 } });
	});

	it("a registry whose worktrees are all gone is not-ready, not a crash", async () => {
		await writeOrphanSummary(HASH, "seed");
		const { getRepoRegistryPath } = await import("./RepoRegistry.js");
		const { readFileSync, writeFileSync } = await import("node:fs");
		const path = getRepoRegistryPath();
		const registry = JSON.parse(readFileSync(path, "utf-8")) as { repos: Record<string, unknown>[] };
		registry.repos[0].worktreeRoot = join(dir, "vanished");
		registry.repos[0].worktrees = [join(dir, "vanished")];
		writeFileSync(path, JSON.stringify(registry));
		const result = await runCutover(cwd, { dbPath });
		expect(result).toMatchObject({ status: "not-ready", reason: expect.stringContaining("no live worktree") });
	});

	it("two independent clones are treated as distinct sources, not collapsed by their identical relative common-dir string", async () => {
		// `git rev-parse --git-common-dir` prints `.git` (relative to cwd) for
		// ANY main-worktree clone — a second, wholly independent clone of the
		// same project reports the exact same string despite living at a
		// different absolute path. Naive string dedup would collapse the two,
		// silently dropping one clone out of the cutover entirely.
		await writeOrphanSummary(HASH, "clone one");
		const clone2 = join(dir, "repo2");
		mkdirSync(clone2, { recursive: true });
		execSync("git init -q", { cwd: clone2 });
		execSync("git config user.email t@t && git config user.name t", { cwd: clone2 });
		execSync("git commit -q --allow-empty -m init", { cwd: clone2 });
		const HASH2 = "b".repeat(40);
		const priorCwd = cwd;
		cwd = clone2;
		await writeOrphanSummary(HASH2, "clone two");
		cwd = priorCwd;

		const { getRepoRegistryPath } = await import("./RepoRegistry.js");
		const { readFileSync, writeFileSync } = await import("node:fs");
		const registryPath = getRepoRegistryPath();
		const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as { repos: Record<string, unknown>[] };
		registry.repos[0].worktrees = [cwd, clone2];
		writeFileSync(registryPath, JSON.stringify(registry));

		const result = await runCutover(cwd, { dbPath, nowMs: 1000 });
		expect(result.status).toBe("committed");
		const record = (result as { record: { tips: Record<string, string> } }).record;
		expect(Object.keys(record.tips).sort()).toEqual([clone2, cwd].sort());

		// Both clones must be fenced — the missing one would stay `uncutover`
		// and keep writing the (now frozen, for the other clone) orphan branch.
		const fence1 = await readCutoverFence(cwd);
		const fence2 = await readCutoverFence(clone2);
		expect(fence1?.tips && Object.keys(fence1.tips).sort()).toEqual([clone2, cwd].sort());
		expect(fence2?.tips && Object.keys(fence2.tips).sort()).toEqual([clone2, cwd].sort());

		// Both clones' memories made it into the database.
		const rows = await withDashboardDb(
			(db) =>
				db.prepare("SELECT commit_hash FROM memories ORDER BY commit_hash").all() as { commit_hash: string }[],
			{ dbPath },
		);
		expect(rows.map((r) => r.commit_hash).sort()).toEqual([HASH, HASH2].sort());
	});

	it("resume after a partial fence failure still fences the source that was missed", async () => {
		// Simulates an earlier `runCutover` that fenced clone one and then
		// failed (crash, disk error) before it got to clone two — clone one's
		// profile.json already carries `cutoverFence`, clone two's does not.
		// A resumed run anchored at clone one must still notice and fence
		// clone two, not skip fencing entirely because the entry point looked
		// already-fenced.
		await writeOrphanSummary(HASH, "clone one");
		const clone2 = join(dir, "repo2");
		mkdirSync(clone2, { recursive: true });
		execSync("git init -q", { cwd: clone2 });
		execSync("git config user.email t@t && git config user.name t", { cwd: clone2 });
		execSync("git commit -q --allow-empty -m init", { cwd: clone2 });
		const HASH2 = "b".repeat(40);
		const priorCwd = cwd;
		cwd = clone2;
		await writeOrphanSummary(HASH2, "clone two");
		cwd = priorCwd;

		const { getRepoRegistryPath } = await import("./RepoRegistry.js");
		const { readFileSync, writeFileSync } = await import("node:fs");
		const registryPath = getRepoRegistryPath();
		const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as { repos: Record<string, unknown>[] };
		registry.repos[0].worktrees = [cwd, clone2];
		writeFileSync(registryPath, JSON.stringify(registry));

		await writeCutoverFence(cwd, { reason: "cutover to sqlite", at: new Date(500).toISOString() });
		expect(await readCutoverFence(cwd)).not.toBeNull();
		expect(await readCutoverFence(clone2)).toBeNull();

		const result = await runCutover(cwd, { dbPath, nowMs: 1000 });
		expect(result.status).toBe("committed");

		// clone two must be fenced by this resumed run — not left unfenced just
		// because clone one (the entry point) already was.
		expect(await readCutoverFence(clone2)).not.toBeNull();
	});

	it("an old surface installed on this machine does NOT block the cutover", async () => {
		await writeOrphanSummary(HASH, "seed");
		// This used to be a hard refusal: any `dist-paths/` entry below a
		// fence-aware version floor refused the whole cutover. One un-upgraded
		// fork-editor extension then pinned every repo on the machine at
		// `uncutover` forever, with the reason only ever reaching `debug.log`.
		// The risk it guarded — an old surface writing the frozen branch — is
		// covered downstream by `probeCutoverDrift`, which reports such a write
		// AND catch-up imports it (see the drift test below).
		const distDir = join(home, ".jolli", "jollimemory", "dist-paths");
		mkdirSync(distDir, { recursive: true });
		const { writeFileSync } = await import("node:fs");
		const staleDist = join(dir, "stale-vscode-dist");
		mkdirSync(staleDist, { recursive: true });
		writeFileSync(join(distDir, "vscode"), `source=vscode@0.98.0\n${staleDist}\n`);
		expect((await runCutover(cwd, { dbPath })).status).toBe("committed");
		expect(await readCutoverFence(cwd)).not.toBeNull();
	});

	it("drift probe: a bypassing write is reported, imported, and KEEPS being reported", async () => {
		await writeOrphanSummary(HASH, "seed");
		expect((await runCutover(cwd, { dbPath })).status).toBe("committed");
		const { probeCutoverDrift } = await import("./CutoverEngine.js");
		expect(await probeCutoverDrift(cwd, { dbPath })).toEqual([]);
		// An old client bypasses the fence (raw plumbing).
		await writeOrphanSummary("e".repeat(40), "bypassed the fence");
		const drift = await probeCutoverDrift(cwd, { dbPath, nowMs: 2000 });
		expect(drift).toHaveLength(1);
		expect(drift[0].currentTip).not.toBe(drift[0].recordedTip);
		// The stranded memory was caught up into the database…
		const rows = await withDashboardDb(
			(db) => db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number },
			{ dbPath },
		);
		expect(rows.n).toBe(2);
		// …and the recorded tip was NOT advanced: drift reports until a human
		// deals with the bypassing writer, never "all clear" by accident.
		expect(await probeCutoverDrift(cwd, { dbPath, nowMs: 3000 })).toHaveLength(1);
	});

	it("drift probe: a checkout that no longer exists is not drift", async () => {
		// `git worktree remove` after the cutover left that checkout's recorded tip
		// permanently unresolvable, which the probe reported as "someone bypassed the
		// fence" — so `--probe` exited 1 on every run with nothing the user could do
		// to clear it. Drift means the branch MOVED, and only a present checkout can
		// say so.
		await writeOrphanSummary(HASH, "seed");
		expect((await runCutover(cwd, { dbPath })).status).toBe("committed");
		const { probeCutoverDrift } = await import("./CutoverEngine.js");
		expect(await probeCutoverDrift(cwd, { dbPath })).toEqual([]);

		// Record a second, non-existent checkout alongside the real one.
		const identity = await resolveIdentity();
		const gone = join(dir, "removed-worktree");
		await withDashboardDb(
			(db) => {
				const repoId = (
					db.prepare("SELECT id FROM repos WHERE repo_identity = ?").get(identity) as { id: number }
				).id;
				const row = db
					.prepare("SELECT value FROM repo_state WHERE repo_id = ? AND key = 'cutover'")
					.get(repoId) as { value: string };
				const record = JSON.parse(row.value) as { tips: Record<string, string> };
				record.tips[gone] = "0".repeat(40);
				db.prepare("UPDATE repo_state SET value = ? WHERE repo_id = ? AND key = 'cutover'").run(
					JSON.stringify(record),
					repoId,
				);
			},
			{ dbPath },
		);

		expect(await probeCutoverDrift(cwd, { dbPath })).toEqual([]);
	});

	it("drift probe: the bypassing write cannot roll a post-fence row back to its pre-fence body", async () => {
		await writeOrphanSummary(HASH, "seed");
		expect((await runCutover(cwd, { dbPath, nowMs: 1000 })).status).toBe("committed");
		// The new runtime regenerates that commit's summary AFTER the fence, so it
		// exists only in the database — the frozen branch still holds "seed".
		await withDashboardDb(
			(db) =>
				db
					.prepare("UPDATE memories SET summary_json = ?, written_at_ms = 2000 WHERE commit_hash = ?")
					.run(regeneratedJson, HASH),
			{ dbPath },
		);
		// An old client bypasses the fence and rewrites that same path.
		await writeOrphanSummary(HASH, "pre-fence body an old client re-pushed");

		expect(await probeCutoverDrift(cwd, { dbPath, nowMs: 3000 })).toHaveLength(1);

		// Caught up, but not clobbered: the post-fence body survives. Without the
		// fence-time protection this import is a silent rollback against a branch
		// nothing will ever fix again.
		expect(await storedMessage(HASH)).toBe("regenerated after the fence");
	});

	it("retry after the fence went up cannot roll a post-fence row back either — it refuses instead", async () => {
		// A first run that fences and then cannot take the lock: the fence is
		// one-way, so every later attempt imports an ALREADY-FENCED source, which
		// is the second unprotected catch-up.
		await writeOrphanSummary(HASH, "first");
		const { acquireOrphanWriteLock, releaseOrphanWriteLock } = await import("../core/Locks.js");
		expect(await acquireOrphanWriteLock(cwd)).toBe(true);
		try {
			expect((await runCutover(cwd, { dbPath, maxRetries: 0, lockTimeoutMs: 20, nowMs: 1000 })).status).toBe(
				"retry-exhausted",
			);
		} finally {
			await releaseOrphanWriteLock(cwd);
		}
		expect(await readCutoverFence(cwd)).not.toBeNull();
		await withDashboardDb(
			(db) =>
				db
					.prepare("UPDATE memories SET summary_json = ?, written_at_ms = 2000 WHERE commit_hash = ?")
					.run(regeneratedJson, HASH),
			{ dbPath },
		);
		await writeOrphanSummary(HASH, "pre-fence body an old client re-pushed");

		// The resume reports the disagreement instead of resolving it by
		// overwriting the newer side. legacy-fenced is a working state — writes go
		// to SQLite, reads come from the database — so refusing costs a stuck
		// cutover, while importing would cost the memory itself.
		const resumed = await runCutover(cwd, { dbPath, nowMs: 3000 });
		expect(resumed).toMatchObject({ status: "not-ready", reason: expect.stringContaining("content differs") });
		expect(await storedMessage(HASH)).toBe("regenerated after the fence");
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("legacy-fenced");
	});

	it("drift probe on an un-cutover repo (or unknown repo) is an empty answer, not an error", async () => {
		const { probeCutoverDrift } = await import("./CutoverEngine.js");
		// No database at all yet.
		expect(await probeCutoverDrift(cwd, { dbPath: join(dir, "none.db") })).toEqual([]);
		// Database exists, repo row absent.
		await withDashboardDb(() => undefined, { dbPath });
		expect(await probeCutoverDrift(cwd, { dbPath })).toEqual([]);
		// Repo row exists, no cutover record.
		const identity = await resolveIdentity();
		await withDashboardDb(
			(db) =>
				db
					.prepare(
						"INSERT INTO repos (repo_identity, repo_name, worktree_root, enabled_at) VALUES (?, ?, ?, ?)",
					)
					.run(identity, "r", cwd, "t"),
			{ dbPath },
		);
		expect(await probeCutoverDrift(cwd, { dbPath })).toEqual([]);
	});

	it("registry check: the repo rows agree about the source set", async () => {
		const registry = await readRepoRegistry();
		expect(registry.repos).toHaveLength(1);
	});
});
