/**
 * AutoCutover — the wiring that makes the engine reachable without a human
 * typing `jolli cutover`. The cases that matter are the ones that keep a
 * failure invisible to the caller and keep the expensive compare off the
 * per-commit path.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepoProfile, updateRepoProfile, writeManualDisableFlag } from "../core/RepoProfile.js";
import { ORPHAN_BRANCH } from "../Logger.js";
import { type RestoreHome, setIsolatedHome } from "../testUtils/isolatedHome.js";
import { AUTO_CUTOVER_RETRY_MS, autoCutoverAllRepos, maybeAutoCutover } from "./AutoCutover.js";
import { readCutoverBlock } from "./CutoverEngine.js";
import { resolveCutoverRoute } from "./CutoverRouter.js";
import { withDashboardDb } from "./DashboardDb.js";
import { registerRepo } from "./RepoRegistry.js";

let dir: string;
let cwd: string;
let dbPath: string;
let restoreHome: RestoreHome;

const HASH = "a".repeat(40);

async function writeOrphanSummary(hash: string): Promise<void> {
	const { ensureOrphanBranch, writeMultipleFilesToBranch } = await import("../core/GitOps.js");
	await ensureOrphanBranch(ORPHAN_BRANCH, cwd);
	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		[
			{
				path: `summaries/${hash}.json`,
				content: JSON.stringify(
					{
						version: "5",
						commitHash: hash,
						commitMessage: "seed",
						commitDate: "2026-07-01T00:00:00.000Z",
						branch: "main",
						commitType: "commit",
						topics: [],
						children: [],
					},
					null,
					"\t",
				),
			},
		],
		"add",
		cwd,
	);
}

/**
 * A summary the branch LISTS and the import cannot take.
 *
 * The shortest real route to the one refusal that is stable across attempts: the
 * path is a `summaries/<hash>.json` so `listsSummaries` counts it, and the body
 * does not parse so the import writes no row.
 */
async function writeBrokenOrphanSummary(hash: string): Promise<void> {
	const { ensureOrphanBranch, writeMultipleFilesToBranch } = await import("../core/GitOps.js");
	await ensureOrphanBranch(ORPHAN_BRANCH, cwd);
	await writeMultipleFilesToBranch(
		ORPHAN_BRANCH,
		[{ path: `summaries/${hash}.json`, content: "{ this is not json" }],
		"add",
		cwd,
	);
}

/** A real git repo the registry has never heard of — the engine's `not-ready` arm. */
function unregisteredRepo(): string {
	const root = join(dir, `stranger-${strangerCount++}`);
	mkdirSync(root, { recursive: true });
	execSync("git init -q", { cwd: root });
	execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: root });
	return root;
}
let strangerCount = 0;

beforeEach(async () => {
	strangerCount = 0;
	dir = mkdtempSync(join(tmpdir(), "jolli-autocut-"));
	// Isolated HOME: `registerRepo` below writes the machine-global registry.
	// The helper also covers Windows, where `os.homedir()` ignores `HOME`.
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	restoreHome = setIsolatedHome(home);
	cwd = join(dir, "repo");
	mkdirSync(cwd, { recursive: true });
	execSync("git init -q", { cwd });
	execSync("git config user.email t@t && git config user.name t", { cwd });
	execSync("git commit -q --allow-empty -m init", { cwd });
	dbPath = join(dir, "jollimemory.db");
	await registerRepo({ cwd, now: () => new Date(0) });
});

afterEach(() => {
	restoreHome();
	rmSync(dir, { recursive: true, force: true });
});

describe("maybeAutoCutover", () => {
	it("cuts the repo over to SQLite without anyone asking for it", async () => {
		await writeOrphanSummary(HASH);
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("uncutover");

		expect(await maybeAutoCutover(cwd, { dbPath })).toBe("cutover");

		// The observable point of the whole exercise: reads and writes now route
		// to the database rather than the orphan branch.
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("cutover");
	});

	it("is idempotent — a second call on a cut-over repo is a no-op answer", async () => {
		await writeOrphanSummary(HASH);
		await maybeAutoCutover(cwd, { dbPath });
		const attemptedAt = (await readRepoProfile(cwd)).cutoverAttemptedAtMs;
		expect(await maybeAutoCutover(cwd, { dbPath })).toBe("cutover");
		// Short-circuited on the route BEFORE stamping: a repo that is already
		// done must not keep spending attempt slots.
		expect((await readRepoProfile(cwd)).cutoverAttemptedAtMs).toBe(attemptedAt);
	});

	it("reports rather than throws when the repo is not ready", async () => {
		// An UNREGISTERED repo: `runCutover` answers `not-ready`, and this must
		// surface as a return value — the callers are `jolli enable` and the
		// post-commit drain, neither of which may fail because of it. (A repo with
		// no orphan branch is deliberately no longer one of these: nothing to
		// migrate is the easiest cutover, not a refusal.)
		const outcome = await maybeAutoCutover(unregisteredRepo(), { dbPath });
		expect(outcome).toBe("uncutover");
		expect(process.exitCode).toBeUndefined();
	});

	it("a repo with nothing to migrate cuts over rather than reporting uncutover", async () => {
		expect(await maybeAutoCutover(cwd, { dbPath })).toBe("cutover");
	});

	it("throttles the opportunistic caller, and only that caller", async () => {
		const now = Date.parse("2026-08-09T12:00:00Z");
		await updateRepoProfile(cwd, { cutoverAttemptedAtMs: now - 60_000 });
		await writeOrphanSummary(HASH);

		// Post-commit drain: an attempt just ran, so step 3's full-tree compare
		// stays off this commit's path.
		expect(await maybeAutoCutover(cwd, { dbPath, throttle: true, nowMs: now })).toBe("skipped");
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("uncutover");

		// Past the window it tries again.
		expect(await maybeAutoCutover(cwd, { dbPath, throttle: true, nowMs: now + AUTO_CUTOVER_RETRY_MS + 1 })).toBe(
			"cutover",
		);
	});

	it("does not throttle the post-import caller", async () => {
		const now = Date.parse("2026-08-09T12:00:00Z");
		await updateRepoProfile(cwd, { cutoverAttemptedAtMs: now - 60_000 });
		await writeOrphanSummary(HASH);
		// `importDashboardHistory` passes no throttle: it has just filled the
		// database from the branch, which is when the compare is most likely to
		// pass, and the user is waiting on setup anyway.
		expect(await maybeAutoCutover(cwd, { dbPath, nowMs: now })).toBe("cutover");
	});

	it("stamps the attempt BEFORE running, so a crashing compare cannot loop", async () => {
		const now = Date.parse("2026-08-09T12:00:00Z");
		// Unregistered → `not-ready`, but the slot is still spent.
		const other = unregisteredRepo();
		await maybeAutoCutover(other, { dbPath, throttle: true, nowMs: now });
		expect((await readRepoProfile(other)).cutoverAttemptedAtMs).toBe(now);
		expect(await maybeAutoCutover(other, { dbPath, throttle: true, nowMs: now + 1000 })).toBe("skipped");
	});

	describe("onAttemptStart", () => {
		// The hook exists so a foreground command can tell the user not to press
		// Ctrl+C into a silent tens-of-seconds step. That only works if it fires
		// exactly when work is about to happen — a line printed on the throttled
		// runs (the common case) is one the user learns to ignore.
		it("fires for a real attempt, before anything is written", async () => {
			await writeOrphanSummary(HASH);
			// The hook is synchronous, so the ordering claim has to be observed
			// synchronously too: the stamp's own file is the earliest write the
			// attempt makes, and it must not exist yet when the line goes out.
			const profile = join(cwd, ".jolli", "jollimemory", "profile.json");
			const existedDuringCallback: boolean[] = [];
			expect(
				await maybeAutoCutover(cwd, {
					dbPath,
					onAttemptStart: () => existedDuringCallback.push(existsSync(profile)),
				}),
			).toBe("cutover");
			expect(existedDuringCallback).toEqual([false]);
			// …and exists afterwards, which is what proves the path above is the real
			// one rather than a typo that can only ever read as "not written yet".
			expect(existsSync(profile)).toBe(true);
		});

		it("does not fire when the throttle window suppressed the attempt", async () => {
			const now = Date.parse("2026-08-09T12:00:00Z");
			await updateRepoProfile(cwd, { cutoverAttemptedAtMs: now - 60_000 });
			await writeOrphanSummary(HASH);
			let calls = 0;
			expect(
				await maybeAutoCutover(cwd, { dbPath, throttle: true, nowMs: now, onAttemptStart: () => calls++ }),
			).toBe("skipped");
			expect(calls).toBe(0);
		});

		it("does not fire for a repo that is already cut over", async () => {
			await writeOrphanSummary(HASH);
			await maybeAutoCutover(cwd, { dbPath });
			let calls = 0;
			// The route short-circuits ahead of every gate, so a caller reporting on
			// this hook says nothing about a repo with nothing left to do.
			expect(await maybeAutoCutover(cwd, { dbPath, onAttemptStart: () => calls++ })).toBe("cutover");
			expect(calls).toBe(0);
		});

		it("still fires for an attempt that ends short of cutover", async () => {
			// `not-ready` is the state the user most needs told about, because it is
			// the one where the wait bought nothing visible.
			let calls = 0;
			expect(await maybeAutoCutover(unregisteredRepo(), { dbPath, onAttemptStart: () => calls++ })).toBe(
				"uncutover",
			);
			expect(calls).toBe(1);
		});
	});

	/**
	 * The refusal no retry can change — and the reason this is a MEMO rather than
	 * a window. Every case here is about the same distinction: an unchanged input
	 * means the answer is already known, and a changed one means it is not, with
	 * no elapsed time entering into either.
	 */
	describe("a recorded cutover block", () => {
		it("stops the second attempt dead — the full import is not repeated", async () => {
			await writeBrokenOrphanSummary(HASH);
			// First call earns the refusal: the branch lists a summary and the import
			// stores none, which is the one thing the engine still refuses.
			expect(await maybeAutoCutover(cwd, { dbPath })).toBe("uncutover");

			let attempts = 0;
			expect(await maybeAutoCutover(cwd, { dbPath, onAttemptStart: () => attempts++ })).toBe("skipped");
			// The whole point: no attempt at all, so no re-import and no compare.
			expect(attempts).toBe(0);
			expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("uncutover");
		});

		it("says WHY, because `skipped` is also what a disabled repo answers", async () => {
			await writeBrokenOrphanSummary(HASH);
			await maybeAutoCutover(cwd, { dbPath });
			const seen: Array<{ code: string; reason: string }> = [];
			expect(await maybeAutoCutover(cwd, { dbPath, onBlocked: (r) => seen.push(r) })).toBe("skipped");
			expect(seen).toHaveLength(1);
			expect(seen[0]?.code).toBe("no-summary-rows");
			expect(seen[0]?.reason).toContain("stored no memories");
		});

		it("is retired by a moved orphan tip, and the retry runs IMMEDIATELY", async () => {
			await writeBrokenOrphanSummary(HASH);
			expect(await maybeAutoCutover(cwd, { dbPath })).toBe("uncutover");

			// A real summary lands: same repo, same second, different input. No window
			// is consulted anywhere — this is what a throttle could not do.
			await writeOrphanSummary("b".repeat(40));
			let attempts = 0;
			expect(await maybeAutoCutover(cwd, { dbPath, onAttemptStart: () => attempts++ })).toBe("cutover");
			expect(attempts).toBe(1);
		});

		it("is not recorded for a transient refusal — an unregistered repo stays retryable", async () => {
			// The classification has to stay narrow: only the two IMPORT refusals are
			// stable. "Not registered" is a state that changes on its own, so a block
			// here would be a repo that never cuts over after one bad moment.
			const stranger = unregisteredRepo();
			expect(await maybeAutoCutover(stranger, { dbPath })).toBe("uncutover");
			let attempts = 0;
			let blocked = 0;
			expect(
				await maybeAutoCutover(stranger, {
					dbPath,
					onAttemptStart: () => attempts++,
					onBlocked: () => blocked++,
				}),
			).toBe("uncutover");
			expect([attempts, blocked]).toEqual([1, 0]);
		});

		it("is cleared once the repo cuts over, so nothing stale outlives it", async () => {
			await writeBrokenOrphanSummary(HASH);
			await maybeAutoCutover(cwd, { dbPath });
			await writeOrphanSummary("c".repeat(40));
			expect(await maybeAutoCutover(cwd, { dbPath })).toBe("cutover");
			// Read through the public route: a leftover row would make a later
			// `--status` on a healthy repo print a refusal that no longer happened.
			expect(await readCutoverBlock(cwd, { dbPath })).toBeNull();
		});
	});

	describe("post-cutover drift probe", () => {
		it("catches a fence-bypassing write with nobody typing --probe", async () => {
			// The whole reason the version-floor admission check could come out. After
			// the freeze reads come from SQLite, so a write that bypassed the fence has
			// NO symptom — a user has nothing to investigate and no reason to run the
			// diagnostic by hand. If this call site goes away, that memory is lost
			// silently rather than reported.
			const now = Date.parse("2026-08-09T12:00:00Z");
			await writeOrphanSummary(HASH);
			expect(await maybeAutoCutover(cwd, { dbPath, nowMs: now })).toBe("cutover");

			// An old surface writes the frozen branch anyway.
			await writeOrphanSummary("e".repeat(40));

			expect(await maybeAutoCutover(cwd, { dbPath, nowMs: now + AUTO_CUTOVER_RETRY_MS + 1 })).toBe("cutover");
			const rows = await withDashboardDb(
				(db) => db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number },
				{ dbPath },
			);
			expect(rows.n).toBe(2);
		});

		it("does not probe on the call that performs the cutover", async () => {
			// That call returns through the CAS, not the already-cut-over branch, and
			// the tips it would compare are the ones it pinned itself moments ago.
			const now = Date.parse("2026-08-09T12:00:00Z");
			await writeOrphanSummary(HASH);
			expect(await maybeAutoCutover(cwd, { dbPath, nowMs: now })).toBe("cutover");
			expect((await readRepoProfile(cwd)).cutoverDriftProbedAtMs).toBeUndefined();
		});

		it("throttles on its OWN stamp — the attempt's stops moving once cut over", async () => {
			const now = Date.parse("2026-08-09T12:00:00Z");
			await writeOrphanSummary(HASH);
			await maybeAutoCutover(cwd, { dbPath, nowMs: now });
			// First call to find the repo already cut over: this is the one that
			// probes, and it stamps BEFORE probing — same rule as the attempt.
			await maybeAutoCutover(cwd, { dbPath, nowMs: now + 60_000 });
			expect((await readRepoProfile(cwd)).cutoverDriftProbedAtMs).toBe(now + 60_000);

			// Inside the window the bypassing write is NOT imported yet: the probe's
			// repair is a full catch-up import, and drift is deliberately never
			// cleared, so an unthrottled probe would pay that on every commit forever.
			await writeOrphanSummary("e".repeat(40));
			await maybeAutoCutover(cwd, { dbPath, nowMs: now + 120_000 });
			expect((await readRepoProfile(cwd)).cutoverDriftProbedAtMs).toBe(now + 60_000);
			const before = await withDashboardDb(
				(db) => db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number },
				{ dbPath },
			);
			expect(before.n).toBe(1);
		});

		it("is throttled even for the caller that passes no throttle", async () => {
			// The post-import caller's reason to skip the throttle — the database was
			// just filled from the branch — is about the COMPARE. It says nothing
			// about drift, which is slow-moving by nature, so `throttle` is not
			// consulted here at all: no call in this test passes one.
			const now = Date.parse("2026-08-09T12:00:00Z");
			await writeOrphanSummary(HASH);
			await maybeAutoCutover(cwd, { dbPath, nowMs: now });
			await maybeAutoCutover(cwd, { dbPath, nowMs: now + 60_000 });
			await maybeAutoCutover(cwd, { dbPath, nowMs: now + 120_000 });
			expect((await readRepoProfile(cwd)).cutoverDriftProbedAtMs).toBe(now + 60_000);
		});
	});
});

describe("autoCutoverAllRepos", () => {
	/** A second registered repo, so the sweep has a roster rather than one entry. */
	async function secondRepo(name: string): Promise<string> {
		const root = join(dir, name);
		mkdirSync(root, { recursive: true });
		execSync("git init -q", { cwd: root });
		execSync("git config user.email t@t && git config user.name t", { cwd: root });
		execSync("git commit -q --allow-empty -m init", { cwd: root });
		await registerRepo({ cwd: root, now: () => new Date(0) });
		return root;
	}

	it("cuts over EVERY registered repo, not just the one you are standing in", async () => {
		// The asymmetry this exists to remove: `runHistoryImport` has always swept the
		// whole roster while the cutover beside it took only `cwd`, so a user had to
		// open the dashboard once per repository.
		const other = await secondRepo("other");
		const entries = await autoCutoverAllRepos({ dbPath, preferFirst: cwd });

		expect(entries).toHaveLength(2);
		expect(entries.every((e) => e.state === "cutover")).toBe(true);
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("cutover");
		expect((await resolveCutoverRoute(other, { dbPath })).state).toBe("cutover");
	});

	it("puts preferFirst's repo first", async () => {
		// The user is standing in it, so an interrupted sweep has already tried the
		// one they were most likely waiting on.
		const other = await secondRepo("other");
		const entries = await autoCutoverAllRepos({ dbPath, preferFirst: other });
		expect(entries[0]?.root).toBe(other);
	});

	it("tolerates a preferFirst that belongs to no registered repo", async () => {
		// Registration can fail, and the front door also runs outside a git worktree.
		// Ordering is a nicety; losing it must not cost the sweep.
		const other = await secondRepo("other");
		const entries = await autoCutoverAllRepos({ dbPath, preferFirst: join(dir, "nowhere") });
		expect(entries.map((e) => e.root).sort()).toEqual([cwd, other].sort());
	});

	it("skips a repo the user switched off and sweeps the rest", async () => {
		const other = await secondRepo("other");
		await writeManualDisableFlag(other, true);

		const entries = await autoCutoverAllRepos({ dbPath, preferFirst: cwd });
		expect(entries.find((e) => e.root === other)).toMatchObject({ state: "skipped", attempted: false });
		// The other repo is untouched — one repo's opt-out is not a verdict on the rest.
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("cutover");
		expect((await resolveCutoverRoute(other, { dbPath })).state).toBe("uncutover");
	});

	it("skips a repo whose checkout is gone WITHOUT writing to its path", async () => {
		// `existingWorktrees` never returns empty (it falls back to `worktreeRoot`), so
		// a repo whose checkout was deleted is indistinguishable from a healthy one in
		// its return value — `hasLiveWorktree` has to be asked first, or the attempt
		// stamps a profile into a directory that does not exist.
		const other = await secondRepo("other");
		rmSync(other, { recursive: true, force: true });

		const entries = await autoCutoverAllRepos({ dbPath, preferFirst: cwd });
		expect(entries.find((e) => e.root === other)).toMatchObject({ state: "skipped", attempted: false });
		expect(existsSync(other)).toBe(false);
	});

	it("reports attempted separately from state", async () => {
		// `cutover` is the answer both for a repo this pass switched and for one that
		// was already switched, so a caller's reporting cannot be derived from state.
		const names: string[] = [];
		const first = await autoCutoverAllRepos({ dbPath, onAttemptStart: (n) => names.push(n) });
		expect(first.every((e) => e.attempted)).toBe(true);
		expect(names).toHaveLength(first.length);

		names.length = 0;
		const second = await autoCutoverAllRepos({ dbPath, onAttemptStart: (n) => names.push(n) });
		expect(second.every((e) => e.state === "cutover")).toBe(true);
		expect(second.every((e) => !e.attempted)).toBe(true);
		expect(names).toEqual([]);
	});
});
