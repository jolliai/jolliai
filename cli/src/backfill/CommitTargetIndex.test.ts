import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execGit } from "../core/GitOps.js";
import { anchorCommitForEdit, buildCommitTargetIndex, shortBranch } from "./CommitTargetIndex.js";

describe("shortBranch", () => {
	it("reduces a source ref to a short branch name", () => {
		expect(shortBranch("refs/heads/feat-x")).toBe("feat-x");
		expect(shortBranch("refs/remotes/origin/feat-x")).toBe("feat-x");
		expect(shortBranch("refs/remotes/origin")).toBeUndefined(); // no branch segment
		expect(shortBranch("refs/tags/v1")).toBeUndefined();
		expect(shortBranch("HEAD")).toBeUndefined();
	});
});

describe("CommitTargetIndex (real temp git repo)", () => {
	let repo: string;

	beforeEach(async () => {
		repo = mkdtempSync(join(tmpdir(), "bf-tgt-"));
		await execGit(["init", "-b", "main"], repo);
		await execGit(["config", "user.email", "t@t.dev"], repo);
		await execGit(["config", "user.name", "T"], repo);
		await execGit(["config", "commit.gpgsign", "false"], repo);
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	async function commit(file: string, message: string): Promise<string> {
		writeFileSync(join(repo, file), `// ${message}\n`);
		await execGit(["add", "."], repo);
		await execGit(["commit", "-m", message], repo);
		return (await execGit(["rev-parse", "HEAD"], repo)).stdout.trim();
	}

	it("indexes real code commits and excludes 'Add summary for' bookkeeping commits", async () => {
		const a = await commit("a.ts", "feat: add A");
		const b = await commit("b.ts", "feat: add B");
		// jolli bookkeeping commit — must be excluded from the target set.
		await commit("c.ts", "Add summary for deadbeef: feat: add A");

		const idx = await buildCommitTargetIndex(repo);

		expect(idx.commitMeta.has(a)).toBe(true);
		expect(idx.commitMeta.has(b)).toBe(true);
		// The "Add summary for" commit is excluded even though it touched c.ts.
		expect([...idx.commitMeta.values()].some((m) => m.subject.startsWith("Add summary for"))).toBe(false);
		expect(idx.fileToCommits.has("a.ts")).toBe(true);
		expect(idx.fileToCommits.has("c.ts")).toBe(false);
	});

	it("anchorCommitForEdit resolves the earliest commit touching the file after the edit", async () => {
		const a = await commit("a.ts", "feat: add A");
		const idx = await buildCommitTargetIndex(repo);
		const commitTs = idx.commitMeta.get(a)?.ts ?? 0;

		// Edit slightly before the commit → resolves to A.
		expect(anchorCommitForEdit(idx, "a.ts", "a.ts", commitTs - 1000)).toBe(a);
		// Basename fallback works when the rel path is unknown.
		expect(anchorCommitForEdit(idx, "weird/a.ts", "a.ts", commitTs - 1000)).toBe(a);
		// Unknown file → null.
		expect(anchorCommitForEdit(idx, "nope.ts", "nope.ts", commitTs)).toBeNull();
		// NaN edit time → null.
		expect(anchorCommitForEdit(idx, "a.ts", "a.ts", Number.NaN)).toBeNull();
		// Edit far AFTER the commit (beyond horizon) → null (no later commit touches it).
		expect(anchorCommitForEdit(idx, "a.ts", "a.ts", commitTs + 60 * 24 * 60 * 60 * 1000)).toBeNull();
	});

	it("excludes the orphan summaries branch when it exists", async () => {
		const a = await commit("a.ts", "feat: real");
		// Create an orphan ref (no parent) via plumbing so `--not <orphan>` has
		// something to exclude without disturbing the working tree.
		const tree = (await execGit(["rev-parse", "HEAD^{tree}"], repo)).stdout.trim();
		const orphanCommit = (await execGit(["commit-tree", "-m", "orphan bookkeeping", tree], repo)).stdout.trim();
		await execGit(["branch", "jollimemory/summaries/v3", orphanCommit], repo);

		const idx = await buildCommitTargetIndex(repo);
		expect(idx.commitMeta.has(a)).toBe(true); // real commit still indexed
		expect(idx.commitMeta.has(orphanCommit)).toBe(false); // orphan excluded via --not
	});

	it("records every commit that touches a file, time-sorted", async () => {
		const c1 = await commit("a.ts", "feat: a v1");
		const c2 = await commit("a.ts", "feat: a v2");
		const idx = await buildCommitTargetIndex(repo);
		const refs = idx.fileToCommits.get("a.ts");
		expect(refs).toHaveLength(2); // pushRef appended the second commit to the same key
		expect(new Set(refs?.map((r) => r.hash))).toEqual(new Set([c1, c2]));
	});

	it("excludes a real-branch commit whose diff is purely orphan bookkeeping", async () => {
		const real = await commit("a.ts", "feat: real");
		await commit("catalog.json", "chore: bookkeeping only"); // only an orphan-prefix/bookkeeping file
		const idx = await buildCommitTargetIndex(repo);
		expect(idx.commitMeta.has(real)).toBe(true);
		expect(idx.fileToCommits.has("catalog.json")).toBe(false); // orphan bookkeeping file dropped
	});

	it("returns empty index on a non-repo directory", async () => {
		const notRepo = mkdtempSync(join(tmpdir(), "bf-norepo-"));
		try {
			const idx = await buildCommitTargetIndex(notRepo);
			expect(idx.commitMeta.size).toBe(0);
		} finally {
			rmSync(notRepo, { recursive: true, force: true });
		}
	});
});
