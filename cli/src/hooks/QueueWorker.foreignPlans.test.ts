// Real-`git` integration coverage for the archive chokepoint:
// detectPlanSlugsFromRegistry must drop plans whose sourcePath lives in a
// DIFFERENT git repository (a sibling checkout the agent incidentally touched)
// while keeping in-repo plans. Uses real repos + a real plans.json rather than a
// mocked registry, because the classifier hard-wires the real-git resolver.
//
// Deliberately kept OUT of `SLOW_TEST_FILES` in cli/vite.config.ts (fast tier):
// the two `git init` repos it drives are cheap, and this is the only test that
// exercises detectPlanSlugsFromRegistry's foreign-exclusion branch against a real
// resolver — the mocked QueueWorker suites stub GitOps and never reach it, so
// moving this to the slow tier would leave that branch uncovered in the gate.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { __test__ } from "./QueueWorker.js";

describe("detectPlanSlugsFromRegistry — foreign-repo exclusion", () => {
	const dirs: string[] = [];
	const makeRepo = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "jm-fp-"));
		dirs.push(dir);
		execFileSync("git", ["init", "-q"], { cwd: dir });
		return dir;
	};

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("keeps in-repo plans and drops both fresh and revived plans from a foreign repo", async () => {
		const ownRepo = makeRepo();
		const foreignRepo = makeRepo();

		// A real file on disk so this is a realistic committed-plan entry (its dir
		// exists, so the classifier's `git rev-parse` resolves). The foreign check
		// now runs before hashing, so it is dropped without the live hash ever
		// being read — but the file keeps the entry representative of production.
		const revivedForeign = join(foreignRepo, "revived.md");
		writeFileSync(revivedForeign, "# foreign revived\nlive body\n");

		const registry = {
			version: 1,
			plans: {
				"local-fresh": {
					slug: "local-fresh",
					title: "Local",
					sourcePath: join(ownRepo, "docs", "local.md"),
					addedAt: "a",
					updatedAt: "b",
					commitHash: null,
				},
				"foreign-fresh": {
					slug: "foreign-fresh",
					title: "Foreign fresh",
					sourcePath: join(foreignRepo, "DEVELOPMENT.md"),
					addedAt: "a",
					updatedAt: "b",
					commitHash: null,
				},
				"foreign-revived": {
					slug: "foreign-revived",
					title: "Foreign revived",
					sourcePath: revivedForeign,
					addedAt: "a",
					updatedAt: "b",
					commitHash: "deadbeefdeadbeef",
					contentHashAtCommit: "0".repeat(64),
				},
			},
		};
		const memDir = join(ownRepo, ".jolli", "jollimemory");
		mkdirSync(memDir, { recursive: true });
		writeFileSync(join(memDir, "plans.json"), JSON.stringify(registry));

		const slugs = await __test__.detectPlanSlugsFromRegistry(ownRepo, "main");
		expect([...slugs]).toEqual(["local-fresh"]);
	});
});
