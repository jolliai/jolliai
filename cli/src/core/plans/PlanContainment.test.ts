// NOTE: this is a real-`git` test file (the "default resolver" block spawns
// `git init` + `git rev-parse`). It is deliberately kept OUT of
// `SLOW_TEST_FILES` in cli/vite.config.ts so it runs in the fast tier — that is
// what covers `defaultResolveRepoId` and the `?? defaultResolveRepoId` / `??
// homedir` default branches under `--mode fast`. If you ever move this file into
// `SLOW_TEST_FILES`, you MUST also add `PlanContainment.ts` to
// `SLOW_ONLY_SOURCES` in the same change, or those default branches become
// uncovered in the fast tier and the 97/96/97/97 floor silently breaks.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PlanEntry } from "../../Types.js";
import {
	createPlanSourceClassifier,
	FOREIGN_PLAN_EXCLUSION_REASON,
	type PlanSourceClass,
	partitionForeignPlans,
} from "./PlanContainment.js";

describe("createPlanSourceClassifier (injected deps)", () => {
	const cwd = "/repo/app";
	const home = "/home/dev";
	const mk = (resolveRepoId: (dir: string) => Promise<string | null>) =>
		createPlanSourceClassifier(cwd, { resolveRepoId, homeDir: () => home });

	it("returns unknown for a missing sourcePath (undefined / empty)", async () => {
		const resolveRepoId = vi.fn(async () => "X");
		const classify = mk(resolveRepoId);
		expect(await classify(undefined)).toBe("unknown");
		expect(await classify("")).toBe("unknown");
		expect(resolveRepoId).not.toHaveBeenCalled();
	});

	it("classifies a file inside the current worktree as local, without any git call", async () => {
		const resolveRepoId = vi.fn(async () => "irrelevant");
		const classify = mk(resolveRepoId);
		expect(await classify("/repo/app/docs/plan.md")).toBe("local");
		expect(resolveRepoId).not.toHaveBeenCalled();
	});

	it("whitelists the canonical ~/.claude/plans dir as local, without any git call", async () => {
		const resolveRepoId = vi.fn(async () => "irrelevant");
		const classify = mk(resolveRepoId);
		expect(await classify("/home/dev/.claude/plans/foo.md")).toBe("local");
		expect(resolveRepoId).not.toHaveBeenCalled();
	});

	it("classifies a file in a different git repo as foreign", async () => {
		const classify = mk(async (dir) => (dir.startsWith("/repo/app") ? "own-repo" : "other-repo"));
		expect(await classify("/elsewhere/team-plugins/DEVELOPMENT.md")).toBe("foreign");
	});

	it("classifies a sibling worktree of the same repo as local (shared common-dir)", async () => {
		// Both the sibling worktree dir and cwd resolve to the SAME repo id.
		const classify = mk(async () => "shared-common-dir");
		expect(await classify("/repo/app-worktree-2/docs/plan.md")).toBe("local");
	});

	it("returns unknown when the file is in no git repo (loose temp)", async () => {
		const classify = mk(async (dir) => (dir === "/repo/app" ? "own-repo" : null));
		expect(await classify("/tmp/scratch/plan.md")).toBe("unknown");
	});

	it("returns unknown when the current repo id cannot be resolved (defensive)", async () => {
		const classify = mk(async (dir) => (dir === "/repo/app" ? null : "other-repo"));
		expect(await classify("/elsewhere/x.md")).toBe("unknown");
	});

	it("memoizes git resolution per directory", async () => {
		const resolveRepoId = vi.fn(async (dir: string) => (dir.includes("app") ? "own-repo" : "other-repo"));
		const classify = mk(resolveRepoId);
		expect(await classify("/elsewhere/a/one.md")).toBe("foreign"); // resolves /elsewhere/a + cwd
		expect(await classify("/elsewhere/a/two.md")).toBe("foreign"); // both dirs cached
		expect(await classify("/elsewhere/b/three.md")).toBe("foreign"); // resolves /elsewhere/b (cwd cached)
		// Distinct dirs resolved once each: /elsewhere/a, cwd, /elsewhere/b.
		expect(resolveRepoId).toHaveBeenCalledTimes(3);
	});

	it("exposes a human-readable exclusion reason mentioning 'outside'", () => {
		expect(FOREIGN_PLAN_EXCLUSION_REASON).toMatch(/outside/i);
	});
});

describe("createPlanSourceClassifier (real git, default resolver)", () => {
	const dirs: string[] = [];
	const makeRepo = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "jm-containment-"));
		dirs.push(dir);
		execFileSync("git", ["init", "-q"], { cwd: dir });
		return dir;
	};

	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("keeps an in-worktree plan as local (no git call needed)", async () => {
		const repo = makeRepo();
		const classify = createPlanSourceClassifier(repo);
		expect(await classify(join(repo, "docs", "plan.md"))).toBe("local");
	});

	it("marks a plan whose sourcePath is in a different git repo as foreign", async () => {
		const ownRepo = makeRepo();
		const foreignRepo = makeRepo();
		const classify = createPlanSourceClassifier(ownRepo);
		expect(await classify(join(foreignRepo, "DEVELOPMENT.md"))).toBe("foreign");
	});

	it("returns unknown when the enclosing directory does not exist (git rev-parse throws)", async () => {
		const ownRepo = makeRepo();
		// Create then remove a dir so the path is guaranteed not to exist (no
		// reliance on a fixed name never colliding on the CI machine).
		const gone = mkdtempSync(join(tmpdir(), "jm-containment-gone-"));
		rmSync(gone, { recursive: true, force: true });
		const classify = createPlanSourceClassifier(ownRepo);
		expect(await classify(join(gone, "plan.md"))).toBe("unknown");
	});

	// Regression: the classifier runs inside the post-commit queue worker, which
	// is spawned from a git hook and therefore inherits GIT_DIR / GIT_WORK_TREE
	// pinned to the CURRENT repo. If those are forwarded to the `git rev-parse`
	// that resolves a sibling repo, every path resolves to the current repo's
	// common-dir and a foreign plan reads as `local` — the exact way this shipped
	// broken. The resolver must strip them and discover by cwd.
	it("still classifies foreign when GIT_DIR/GIT_WORK_TREE are set (git-hook environment)", async () => {
		const ownRepo = makeRepo();
		const foreignRepo = makeRepo();
		vi.stubEnv("GIT_DIR", join(ownRepo, ".git"));
		vi.stubEnv("GIT_WORK_TREE", ownRepo);
		try {
			const classify = createPlanSourceClassifier(ownRepo);
			expect(await classify(join(foreignRepo, "DEVELOPMENT.md"))).toBe("foreign");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	// Identity, not directory containment: a sibling worktree of the SAME repo
	// must stay local. Inline git config supplies an author so the empty commit
	// (required before `git worktree add`) does not depend on the ambient
	// identity, which the monorepo git-isolation env deliberately omits.
	const gitAuthor = ["-c", "user.email=t@example.com", "-c", "user.name=Test"];
	const makeRepoWithWorktree = (base: string): { main: string; worktree: string } => {
		const main = join(base, "main");
		mkdirSync(main);
		execFileSync("git", ["init", "-q"], { cwd: main });
		execFileSync("git", [...gitAuthor, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
		const worktree = join(base, "wt2");
		execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: main });
		return { main, worktree };
	};

	it("classifies a sibling worktree of the same repo as local (real git worktree)", async () => {
		const base = mkdtempSync(join(tmpdir(), "jm-wt-"));
		dirs.push(base);
		const { main, worktree } = makeRepoWithWorktree(base);
		const classify = createPlanSourceClassifier(main);
		// Plan at the worktree root so its enclosing dir exists for `git rev-parse`.
		expect(await classify(join(worktree, "plan.md"))).toBe("local");
	});

	// Regression for the symlink case: git reports the common-dir as a RELATIVE
	// `.git` for the main worktree (resolved against the queried path, symlink
	// prefix intact) but an ABSOLUTE, realpath'd path for a linked worktree. Under
	// a symlinked prefix (macOS /var → /private/var, a symlinked home) the two
	// spellings diverge and a same-repo sibling worktree would read as foreign
	// unless the resolver canonicalizes with realpath. Skipped where the host
	// cannot create a symlink/junction (unprivileged Windows without junction).
	it("classifies a sibling worktree as local under a symlinked path prefix", async () => {
		const realBase = mkdtempSync(join(tmpdir(), "jm-wt-real-"));
		dirs.push(realBase);
		const linkBase = `${realBase}-link`;
		try {
			symlinkSync(realBase, linkBase, "junction");
		} catch {
			return; // symlink/junction not permitted here — nothing to assert
		}
		dirs.push(linkBase);
		makeRepoWithWorktree(realBase);
		// Query through the symlinked spelling; the worktree's stored gitdir points
		// at the real path, so without realpath the two ids never match.
		const classify = createPlanSourceClassifier(join(linkBase, "main"));
		expect(await classify(join(linkBase, "wt2", "plan.md"))).toBe("local");
	});
});

describe("partitionForeignPlans", () => {
	const plan = (slug: string, sourcePath: string): PlanEntry => ({
		slug,
		title: `${slug} title`,
		sourcePath,
		addedAt: "a",
		updatedAt: "b",
		commitHash: null,
	});

	it("returns empty partitions for no plans", async () => {
		const r = await partitionForeignPlans([], async () => "foreign");
		expect(r.localPlans).toEqual([]);
		expect(r.foreignExcludedContext).toEqual([]);
	});

	it("keeps local and unknown plans, excludes foreign with reason + tier", async () => {
		const plans = [plan("a", "/x/a.md"), plan("b", "/y/b.md"), plan("c", "/z/c.md")];
		const classify = async (sp: string | undefined): Promise<PlanSourceClass> =>
			sp === "/x/a.md" ? "local" : sp === "/y/b.md" ? "foreign" : "unknown";
		const r = await partitionForeignPlans(plans, classify);
		// unknown is KEPT (conservative), only foreign is excluded.
		expect(r.localPlans.map((p) => p.slug)).toEqual(["a", "c"]);
		expect(r.foreignExcludedContext).toEqual([
			{ kind: "plan", key: "b", title: "b title", reason: FOREIGN_PLAN_EXCLUSION_REASON, tier: "low" },
		]);
	});

	it("excludes every plan when all are foreign", async () => {
		const plans = [plan("a", "/x/a.md"), plan("b", "/y/b.md")];
		const r = await partitionForeignPlans(plans, async () => "foreign");
		expect(r.localPlans).toEqual([]);
		expect(r.foreignExcludedContext.map((e) => e.key)).toEqual(["a", "b"]);
	});
});
