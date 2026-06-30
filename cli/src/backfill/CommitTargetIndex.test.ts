import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execGit } from "../core/GitOps.js";
import {
	attributionLowerBound,
	buildCommitTargetIndex,
	type CommitTargetIndex,
	shortBranch,
} from "./CommitTargetIndex.js";

describe("attributionLowerBound", () => {
	const idx: CommitTargetIndex = {
		commitMeta: new Map([
			["C0", { ts: 1000, subject: "" }],
			["C1", { ts: 5000, subject: "" }],
		]),
		commitFiles: new Map([
			["C1", ["foo.ts", "bar.ts"]],
			["NOFILES", []],
		]),
		fileToCommits: new Map([
			[
				"foo.ts",
				[
					{ ts: 1000, hash: "C0" },
					{ ts: 5000, hash: "C1" },
				],
			], // prior commit @1000
			["bar.ts", [{ ts: 5000, hash: "C1" }]], // only committed by C1 itself
		]),
		baseToCommits: new Map(),
	};

	it("floors at the previous commit of the files (most recent before commitTs)", () => {
		expect(attributionLowerBound(idx, "C1", 5000, 1_000_000)).toBe(1000); // foo.ts prior @1000
	});
	it("caps to commitTs - maxLookback when no earlier commit exists", () => {
		// If only bar.ts mattered there'd be no prior → cap. Force via a commit whose
		// file has no earlier commit:
		const idx2: CommitTargetIndex = { ...idx, commitFiles: new Map([["X", ["bar.ts"]]]) };
		expect(attributionLowerBound(idx2, "X", 5000, 2000)).toBe(3000); // 5000 - 2000 (bar.ts has no commit < 5000)
	});
	it("returns commitTs - maxLookback for a commit with no files", () => {
		expect(attributionLowerBound(idx, "NOFILES", 9000, 1500)).toBe(7500);
	});
	it("caps immediately when every commit of the files is at/after commitTs", () => {
		// foo.ts committed @1000 and @5000; commitTs=500 → first ref (1000) is NOT < 500,
		// so the loop breaks at once, prev stays -Inf, and lb falls back to the cap.
		const idx3: CommitTargetIndex = { ...idx, commitFiles: new Map([["Z", ["foo.ts"]]]) };
		expect(attributionLowerBound(idx3, "Z", 500, 100)).toBe(400);
	});
	it("skips files that have no commit history", () => {
		// ghost.ts is not in fileToCommits → the `!refs` branch skips it; foo.ts@1000 floors it.
		const idx4: CommitTargetIndex = { ...idx, commitFiles: new Map([["Q", ["ghost.ts", "foo.ts"]]]) };
		expect(attributionLowerBound(idx4, "Q", 5000, 1_000_000)).toBe(1000);
	});
});

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

	it("derives the basename for a file in a subdirectory", async () => {
		mkdirSync(join(repo, "sub"), { recursive: true });
		await commit("sub/x.ts", "feat: nested file");
		const idx = await buildCommitTargetIndex(repo);
		expect(idx.fileToCommits.has("sub/x.ts")).toBe(true);
		// basename() takes the path after the last "/" — the idx>=0 branch.
		expect(idx.baseToCommits.has("x.ts")).toBe(true);
	});
});
