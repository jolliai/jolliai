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
import { AUTO_CUTOVER_RETRY_MS, maybeAutoCutover } from "./AutoCutover.js";
import { resolveCutoverRoute } from "./CutoverRouter.js";
import { registerRepo } from "./RepoRegistry.js";

let dir: string;
let cwd: string;
let dbPath: string;
let realHome: string | undefined;

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
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	realHome = process.env.HOME;
	process.env.HOME = home;
	cwd = join(dir, "repo");
	mkdirSync(cwd, { recursive: true });
	execSync("git init -q", { cwd });
	execSync("git config user.email t@t && git config user.name t", { cwd });
	execSync("git commit -q --allow-empty -m init", { cwd });
	dbPath = join(dir, "jollimemory.db");
	await registerRepo({ cwd, now: () => new Date(0) });
});

afterEach(() => {
	process.env.HOME = realHome;
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
});
