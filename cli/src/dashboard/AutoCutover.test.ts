/**
 * AutoCutover — the wiring that makes the engine reachable without a human
 * typing `jolli cutover`. The cases that matter are the ones that keep a
 * failure invisible to the caller and keep the expensive compare off the
 * per-commit path.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRepoProfile, updateRepoProfile } from "../core/RepoProfile.js";
import { ORPHAN_BRANCH } from "../Logger.js";
import { type RestoreHome, setIsolatedHome } from "../testUtils/isolatedHome.js";
import { AUTO_CUTOVER_RETRY_MS, maybeAutoCutover } from "./AutoCutover.js";
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

beforeEach(async () => {
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
		// No orphan branch at all: `runCutover` answers `not-ready`, and this must
		// surface as a return value — the callers are `jolli enable` and the
		// post-commit drain, neither of which may fail because of it.
		const outcome = await maybeAutoCutover(cwd, { dbPath });
		expect(outcome).toBe("uncutover");
		expect(process.exitCode).toBeUndefined();
		expect((await resolveCutoverRoute(cwd, { dbPath })).state).toBe("uncutover");
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
		// No orphan branch → `not-ready`, but the slot is still spent.
		await maybeAutoCutover(cwd, { dbPath, throttle: true, nowMs: now });
		expect((await readRepoProfile(cwd)).cutoverAttemptedAtMs).toBe(now);
		expect(await maybeAutoCutover(cwd, { dbPath, throttle: true, nowMs: now + 1000 })).toBe("skipped");
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
