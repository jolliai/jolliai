import { describe, expect, it } from "vitest";
import type { BranchCommit } from "../../Types.js";
import { CommitsDataService } from "./CommitsDataService.js";

function makeCommit(hash: string): BranchCommit {
	return {
		hash,
		shortHash: hash.substring(0, 8),
		message: "msg",
		author: "Test",
		authorEmail: "t@t",
		date: "2026-01-01T00:00:00Z",
		shortDate: "01-01",
		topicCount: 0,
		insertions: 0,
		deletions: 0,
		filesChanged: 0,
		isPushed: false,
		hasSummary: false,
	};
}

describe("CommitsDataService.didSequenceChange", () => {
	it("returns false for two empty sequences", () => {
		expect(CommitsDataService.didSequenceChange([], [])).toBe(false);
	});

	it("returns false for identical sequences", () => {
		expect(CommitsDataService.didSequenceChange(["a", "b"], ["a", "b"])).toBe(
			false,
		);
	});

	it("returns true when lengths differ", () => {
		expect(CommitsDataService.didSequenceChange(["a"], ["a", "b"])).toBe(true);
	});

	it("returns true when any hash differs (amend at HEAD)", () => {
		expect(
			CommitsDataService.didSequenceChange(["old", "b"], ["new", "b"]),
		).toBe(true);
	});

	it("returns true when order swaps", () => {
		expect(CommitsDataService.didSequenceChange(["a", "b"], ["b", "a"])).toBe(
			true,
		);
	});
});

describe("CommitsDataService.applyRangeCheck", () => {
	const commits = [makeCommit("aaa1"), makeCommit("bbb2"), makeCommit("ccc3")];

	it("checks the target and everything newer (0..index)", () => {
		const next = CommitsDataService.applyRangeCheck(
			commits,
			new Set(),
			2,
			true,
		);
		expect(next).toEqual(new Set(["aaa1", "bbb2", "ccc3"]));
	});

	it("checking an earlier commit with later ones selected is a no-op on the later ones", () => {
		const next = CommitsDataService.applyRangeCheck(
			commits,
			new Set(["aaa1", "bbb2"]),
			0,
			true,
		);
		expect(next).toEqual(new Set(["aaa1", "bbb2"]));
	});

	it("unchecks the target and everything older (index..end)", () => {
		const next = CommitsDataService.applyRangeCheck(
			commits,
			new Set(["aaa1", "bbb2", "ccc3"]),
			1,
			false,
		);
		expect(next).toEqual(new Set(["aaa1"]));
	});

	it("returns a shallow copy for out-of-range indices", () => {
		const current = new Set(["aaa1"]);
		const next = CommitsDataService.applyRangeCheck(commits, current, -1, true);
		expect(next).toEqual(current);
		expect(next).not.toBe(current);
	});

	it("handles index === commits.length gracefully", () => {
		const next = CommitsDataService.applyRangeCheck(
			commits,
			new Set(),
			commits.length,
			true,
		);
		expect(next).toEqual(new Set());
	});
});

describe("CommitsDataService.selectedCommits", () => {
	const commits = [makeCommit("aaa1"), makeCommit("bbb2"), makeCommit("ccc3")];

	it("returns commits whose hashes are in the selection set", () => {
		const selected = CommitsDataService.selectedCommits(
			commits,
			new Set(["aaa1", "ccc3"]),
		);
		expect(selected.map((c) => c.hash)).toEqual(["aaa1", "ccc3"]);
	});

	it("returns empty when nothing is selected", () => {
		expect(CommitsDataService.selectedCommits(commits, new Set())).toEqual([]);
	});
});

describe("CommitsDataService.staleSelection", () => {
	it("identifies selected hashes that are no longer in the commit list", () => {
		const commits = [makeCommit("aaa1")];
		const selection = new Set(["aaa1", "gone1", "gone2"]);
		expect(CommitsDataService.staleSelection(commits, selection)).toEqual([
			"gone1",
			"gone2",
		]);
	});

	it("returns empty when every selection is still present", () => {
		const commits = [makeCommit("aaa1"), makeCommit("bbb2")];
		expect(
			CommitsDataService.staleSelection(commits, new Set(["aaa1", "bbb2"])),
		).toEqual([]);
	});
});

describe("CommitsDataService.shortHash", () => {
	it("returns the first 8 characters of a hash", () => {
		expect(CommitsDataService.shortHash("abcdef1234567890")).toBe("abcdef12");
	});

	it("passes undefined through", () => {
		expect(CommitsDataService.shortHash(undefined)).toBeUndefined();
	});
});
