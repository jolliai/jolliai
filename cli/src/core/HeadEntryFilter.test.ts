import { describe, expect, it } from "vitest";
import type { SummaryIndexEntry } from "../Types.js";
import { filterToBranchHeads, getBranchHeads } from "./HeadEntryFilter.js";

function e(
	commitHash: string,
	branch: string,
	parent: string | null | undefined,
	repoName?: string,
): SummaryIndexEntry {
	return {
		commitHash,
		parentCommitHash: parent,
		commitMessage: commitHash,
		commitDate: "2026-05-12T00:00:00Z",
		branch,
		generatedAt: "2026-05-12T00:00:00Z",
		...(repoName !== undefined ? { repoName } : {}),
	};
}

describe("HeadEntryFilter", () => {
	describe("getBranchHeads", () => {
		it("returns empty set for empty input", () => {
			expect(getBranchHeads([])).toEqual(new Set());
		});

		it("returns the single entry when there's only one (root)", () => {
			expect(getBranchHeads([e("a", "main", null)])).toEqual(new Set(["a"]));
		});

		it("returns only the root of a v4 Hoist chain (root + hoisted older children)", () => {
			// Under v4 Hoist: 'a' is the live head; 'b' and 'c' are older versions
			// that were squash/amend-rewritten and now sit in a.children[].
			// Index encoding: b.parent = a, c.parent = a.
			const heads = getBranchHeads([e("a", "main", null), e("b", "main", "a"), e("c", "main", "a")]);
			expect(heads).toEqual(new Set(["a"]));
		});

		it("returns multiple heads when a branch has multiple independent commits", () => {
			// Two independent commits on the same branch, each its own Hoist root.
			// (e.g. branch has 2 distinct git commits, neither amended into the other.)
			const heads = getBranchHeads([
				e("a", "main", null),
				e("b", "main", "a"),
				e("x", "main", null),
				e("y", "main", "x"),
			]);
			expect(heads).toEqual(new Set(["a", "x"]));
		});

		it("ignores branch when judging head — only parentCommitHash matters", () => {
			// rebase-pick across branches creates parent links across branch labels.
			// Under v4 Hoist 'a' is still a head on its branch as long as parent==null.
			const heads = getBranchHeads([e("a", "feature-x", null), e("aprime", "feature-y", "a")]);
			// 'a' is head (parent null). 'aprime' has parent → NOT a head.
			expect(heads).toEqual(new Set(["a"]));
		});

		it("ignores repoName when judging head — only parentCommitHash matters", () => {
			const heads = getBranchHeads([
				e("a", "main", null, "repoA"),
				e("b", "main", "a", "repoA"),
				e("x", "main", null, "repoB"),
				e("y", "main", "x", "repoB"),
			]);
			expect(heads).toEqual(new Set(["a", "x"]));
		});

		it("treats undefined parentCommitHash (legacy v1) as head", () => {
			// v1 entries never had `parentCommitHash`. The field-only test uses
			// `== null` which is true for both null and undefined, so v1 entries
			// are classified as heads — the correct migration semantics.
			expect(getBranchHeads([e("a", "main", undefined)])).toEqual(new Set(["a"]));
		});

		it("does NOT treat a dangling parent pointer as a head (semantics change vs ChainLeafFilter)", () => {
			// Previously this returned {b} because the old DAG-scan algorithm
			// inferred "no entry in scope claims b as a parent, so b is root".
			// Under v4 Hoist semantics, b.parent has a non-null value (even if
			// it resolves to nothing in the current index), so b was written as
			// a hoisted child of something — not a live head. Reflecting this
			// honestly is more useful than masking it.
			expect(getBranchHeads([e("b", "main", "a")])).toEqual(new Set());
		});

		it("returns empty set when every entry has a parent (cycle / all-children case)", () => {
			// 2-cycle: a→b, b→a — neither has null parent.
			expect(getBranchHeads([e("a", "main", "b"), e("b", "main", "a")])).toEqual(new Set());
			// 3-cycle: a→c, b→a, c→b — same.
			expect(getBranchHeads([e("a", "main", "c"), e("b", "main", "a"), e("c", "main", "b")])).toEqual(new Set());
		});
	});

	describe("filterToBranchHeads", () => {
		it("returns entries whose parentCommitHash is null", () => {
			const root = e("a", "main", null);
			const child = e("b", "main", "a");
			expect(filterToBranchHeads([root, child])).toEqual([root]);
		});

		it("preserves input order among heads", () => {
			const child1 = e("b", "main", "a");
			const root1 = e("a", "main", null);
			const child2 = e("y", "main", "x");
			const root2 = e("x", "main", null);
			expect(filterToBranchHeads([child1, root1, child2, root2]).map((x) => x.commitHash)).toEqual(["a", "x"]);
		});

		it("treats undefined parentCommitHash as head (v1 legacy)", () => {
			const legacy = e("a", "main", undefined);
			expect(filterToBranchHeads([legacy])).toEqual([legacy]);
		});
	});
});
