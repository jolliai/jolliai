// Discovery-time containment gate for scanPlansFrom: an external `.md` that
// belongs to ANOTHER git repository (a sibling checkout the agent incidentally
// read/wrote) must never be registered into plans.json in the first place, while
// an in-repo external `.md` is registered as before. This is the front-of-pipe
// counterpart to the archive-time gate covered by QueueWorker.foreignPlans.test.ts.
//
// The real git-identity logic lives in PlanContainment and is exercised against a
// real resolver in PlanContainment.test.ts / QueueWorker.foreignPlans.test.ts.
// Here we stub GitOps.resolveContainingRepoCommonDir by directory so the test is
// deterministic and fast, and asserts the ONE new thing: scanPlansFrom wires the
// classifier and drops `foreign` external paths before upsert.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Classify by directory: the current worktree (cwd) is one repo, anything under a
// path segment named `foreign-repo` is a different repo, everything else is "not a
// git repo" (null → classified `unknown` → kept). normalizePathForCompare lowercases
// and forward-slashes both the argument and our return, so the string comparison in
// defaultResolveRepoId is stable across platforms.
let ownCwd = "";
vi.mock("../GitOps.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../GitOps.js")>()),
	resolveContainingRepoCommonDir: vi.fn(async (dir: string) => {
		const norm = dir.replace(/\\/g, "/").toLowerCase();
		if (norm.includes("/foreign-repo")) return "/foreign-repo/.git";
		if (ownCwd && norm.startsWith(ownCwd.replace(/\\/g, "/").toLowerCase())) return "/own-repo/.git";
		return null;
	}),
}));

// Run the plans.json read-modify-write body inline — the lock contract itself is
// covered in Locks.test.ts, and a real per-worktree lock would need extra setup.
vi.mock("../Locks.js", () => ({
	withPlansLock: (_cwd: string | undefined, fn: () => Promise<unknown>) => fn(),
}));

import { loadPlansRegistry } from "../SessionTracker.js";
import { scanPlansFrom } from "./TranscriptPlanDiscovery.js";

/** Builds a Claude-style JSONL transcript line for a Write of `absPath`. JSON
 *  escaping (Windows `\`) is handled by JSON.stringify so the scanner decodes it
 *  back to the original path. */
function writeLine(absPath: string): string {
	return JSON.stringify({ type: "tool_use", name: "Write", input: { file_path: absPath } });
}

describe("scanPlansFrom — discovery-time foreign-repo exclusion", () => {
	const dirs: string[] = [];
	let cwd = "";

	const makeCwd = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "jm-tpd-"));
		dirs.push(dir);
		mkdirSync(join(dir, ".jolli", "jollimemory"), { recursive: true });
		return dir;
	};

	beforeEach(() => {
		cwd = makeCwd();
		ownCwd = cwd;
	});

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("registers an in-repo external plan and drops a sibling-repo one", async () => {
		// Local external plan: a real .md inside the worktree (isPathInside → local,
		// no resolver call; existsSync must see it).
		const localPlan = join(cwd, "docs", "local-plan.md");
		mkdirSync(join(cwd, "docs"), { recursive: true });
		writeFileSync(localPlan, "# Local Plan\nbody\n");

		// Foreign external plan: a path in a sibling checkout, outside cwd and outside
		// any temp root (so isExternalPlanCandidate does not pre-drop it as scratch).
		// It need not exist on disk — the gate drops it before the existsSync check.
		const foreignPlan = "/work/foreign-repo/design.md";

		const transcript = join(cwd, "session.jsonl");
		writeFileSync(transcript, `${writeLine(localPlan)}\n${writeLine(foreignPlan)}\n`);

		await scanPlansFrom(transcript, 0, cwd, "claude");

		const registry = await loadPlansRegistry(cwd);
		const slugs = Object.keys(registry.plans);
		expect(slugs).toContain("local-plan");
		expect(slugs).not.toContain("design");
		expect(registry.plans["local-plan"]?.sourcePath).toBe(localPlan);
	});

	it("writes nothing when every external plan is foreign", async () => {
		const foreignA = "/work/foreign-repo/plan-a.md";
		const foreignB = "/work/foreign-repo/nested/plan-b.md";
		const transcript = join(cwd, "session.jsonl");
		writeFileSync(transcript, `${writeLine(foreignA)}\n${writeLine(foreignB)}\n`);

		await scanPlansFrom(transcript, 0, cwd, "claude");

		const registry = await loadPlansRegistry(cwd);
		expect(Object.keys(registry.plans)).toHaveLength(0);
	});
});
