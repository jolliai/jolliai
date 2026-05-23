/**
 * Tests for AggregateMerge — pure deterministic merges of the four
 * `.jolli/<aggregate>.json` files (JOLLI-1316 §3). No I/O; we feed
 * hand-crafted entries and assert the merged output.
 *
 * Each test pins one of the cases in the design doc's tiebreak tables, so a
 * future regression is easy to localize.
 */

import { describe, expect, it } from "vitest";
import { canonicalBranchFolder, mergeBranches, mergeCatalog, mergeIndex, mergeManifest } from "./AggregateMerge.js";
import type { BranchEntry, CatalogEntry, IndexEntry, ManifestEntry } from "./AggregateTypes.js";

function manifest(id: string, generatedAt: string, overrides: Partial<ManifestEntry> = {}): ManifestEntry {
	return {
		path: `notes/${id}.md`,
		fileId: id,
		type: "commit",
		fingerprint: `fp-${id}`,
		title: `title-${id}`,
		source: { commitHash: `c-${id}`, branch: "main", generatedAt },
		...overrides,
	};
}

function indexEntry(commitHash: string, overrides: Partial<IndexEntry> = {}): IndexEntry {
	return {
		commitHash,
		parentCommitHash: null,
		treeHash: `t-${commitHash}`,
		commitType: "commit",
		commitMessage: `msg-${commitHash}`,
		commitDate: "2026-05-01T00:00:00Z",
		branch: "main",
		generatedAt: "2026-05-01T00:00:00Z",
		...overrides,
	};
}

function branchEntry(branch: string, overrides: Partial<BranchEntry> = {}): BranchEntry {
	return {
		branch,
		folder: canonicalBranchFolder(branch),
		createdAt: "2026-05-01T00:00:00Z",
		...overrides,
	};
}

function catalogEntry(commitHash: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		commitHash,
		recap: `recap-${commitHash}`,
		ticketId: "JOLLI-1316",
		topics: [],
		...overrides,
	};
}

describe("mergeManifest", () => {
	it("returns the union when both sides are disjoint", () => {
		const local = [manifest("a", "2026-05-01T00:00:00Z")];
		const remote = [manifest("b", "2026-05-01T00:00:00Z")];
		const merged = mergeManifest(local, remote);
		expect(merged.map((m) => m.fileId).sort()).toEqual(["a", "b"]);
	});

	it("dedupes by fileId — newer source.generatedAt wins", () => {
		const local = [manifest("a", "2026-05-01T00:00:00Z", { title: "old" })];
		const remote = [manifest("a", "2026-05-02T00:00:00Z", { title: "new" })];
		const merged = mergeManifest(local, remote);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.title).toBe("new");
	});

	it("dedupes by fileId — older remote loses to newer local", () => {
		const local = [manifest("a", "2026-05-02T00:00:00Z", { title: "local-new" })];
		const remote = [manifest("a", "2026-05-01T00:00:00Z", { title: "remote-old" })];
		const merged = mergeManifest(local, remote);
		expect(merged[0]?.title).toBe("local-new");
	});

	it("keeps local on exact generatedAt tie (stable, deterministic)", () => {
		const ts = "2026-05-01T00:00:00Z";
		const local = [manifest("a", ts, { title: "local" })];
		const remote = [manifest("a", ts, { title: "remote" })];
		expect(mergeManifest(local, remote)[0]?.title).toBe("local");
	});

	it("handles empty inputs symmetrically", () => {
		expect(mergeManifest([], [])).toEqual([]);
		expect(mergeManifest([manifest("a", "2026-05-01T00:00:00Z")], [])).toHaveLength(1);
		expect(mergeManifest([], [manifest("a", "2026-05-01T00:00:00Z")])).toHaveLength(1);
	});

	it("is order-independent within each input list (dedupe is set-like)", () => {
		// Same set of entries, different array order → same set of fileIds.
		const a = manifest("a", "2026-05-01T00:00:00Z");
		const b = manifest("b", "2026-05-01T00:00:00Z");
		const c = manifest("c", "2026-05-02T00:00:00Z");
		const merged1 = mergeManifest([a, b], [c])
			.map((m) => m.fileId)
			.sort();
		const merged2 = mergeManifest([b, a], [c])
			.map((m) => m.fileId)
			.sort();
		expect(merged1).toEqual(merged2);
	});
});

describe("mergeIndex — 2×2 tiebreak", () => {
	const PARENT = "parent-sha";
	const T_EARLY = "2026-05-01T00:00:00Z";
	const T_LATE = "2026-05-02T00:00:00Z";

	it("set + set → newer generatedAt wins", () => {
		const local = [indexEntry("c", { parentCommitHash: PARENT, generatedAt: T_EARLY })];
		const remote = [indexEntry("c", { parentCommitHash: PARENT, generatedAt: T_LATE })];
		expect(mergeIndex(local, remote)[0]?.generatedAt).toBe(T_LATE);
	});

	it("null + null → newer generatedAt wins", () => {
		const local = [indexEntry("c", { parentCommitHash: null, generatedAt: T_EARLY })];
		const remote = [indexEntry("c", { parentCommitHash: null, generatedAt: T_LATE })];
		expect(mergeIndex(local, remote)[0]?.generatedAt).toBe(T_LATE);
	});

	it("set vs null → entry with parent wins regardless of generatedAt", () => {
		const local = [indexEntry("c", { parentCommitHash: PARENT, generatedAt: T_EARLY })];
		const remote = [indexEntry("c", { parentCommitHash: null, generatedAt: T_LATE })];
		const merged = mergeIndex(local, remote);
		expect(merged[0]?.parentCommitHash).toBe(PARENT);
		expect(merged[0]?.generatedAt).toBe(T_EARLY);
	});

	it("null vs set → entry with parent wins regardless of generatedAt", () => {
		const local = [indexEntry("c", { parentCommitHash: null, generatedAt: T_LATE })];
		const remote = [indexEntry("c", { parentCommitHash: PARENT, generatedAt: T_EARLY })];
		const merged = mergeIndex(local, remote);
		expect(merged[0]?.parentCommitHash).toBe(PARENT);
		expect(merged[0]?.generatedAt).toBe(T_EARLY);
	});

	it("ties on generatedAt keep local (stable)", () => {
		const local = [indexEntry("c", { parentCommitHash: PARENT, generatedAt: T_EARLY, commitMessage: "local" })];
		const remote = [indexEntry("c", { parentCommitHash: PARENT, generatedAt: T_EARLY, commitMessage: "remote" })];
		expect(mergeIndex(local, remote)[0]?.commitMessage).toBe("local");
	});

	it("returns the union when disjoint", () => {
		const local = [indexEntry("a"), indexEntry("b")];
		const remote = [indexEntry("c")];
		expect(
			mergeIndex(local, remote)
				.map((e) => e.commitHash)
				.sort(),
		).toEqual(["a", "b", "c"]);
	});

	it("preserves optional fields (topicCount, diffStats)", () => {
		const local = [
			indexEntry("c", {
				topicCount: 3,
				diffStats: { filesChanged: 5, insertions: 100, deletions: 20 },
			}),
		];
		const merged = mergeIndex(local, []);
		expect(merged[0]?.topicCount).toBe(3);
		expect(merged[0]?.diffStats?.filesChanged).toBe(5);
	});

	it("handles empty inputs symmetrically", () => {
		expect(mergeIndex([], [])).toEqual([]);
		expect(mergeIndex([indexEntry("a")], [])).toHaveLength(1);
		expect(mergeIndex([], [indexEntry("a")])).toHaveLength(1);
	});
});

describe("mergeBranches", () => {
	it("dedupes by branch with last-write-wins (remote overrides local)", () => {
		const local = [branchEntry("main", { createdAt: "2026-05-01T00:00:00Z" })];
		const remote = [branchEntry("main", { createdAt: "2026-06-01T00:00:00Z" })];
		const merged = mergeBranches(local, remote);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.createdAt).toBe("2026-06-01T00:00:00Z");
	});

	it("returns the union when disjoint", () => {
		const merged = mergeBranches([branchEntry("main")], [branchEntry("feat/x")]);
		expect(merged.map((b) => b.branch).sort()).toEqual(["feat/x", "main"]);
	});

	it("trusts the writer's `folder` field (does not recompute)", () => {
		// A hostile/buggy writer could pass non-canonical folder; merge should
		// still pass it through — backend validation, not merge, is the guard.
		const local = [branchEntry("feat/x", { folder: "feat-x" })];
		const merged = mergeBranches(local, []);
		expect(merged[0]?.folder).toBe("feat-x");
	});
});

describe("mergeCatalog", () => {
	it("dedupes by commitHash with last-write-wins", () => {
		const local = [catalogEntry("c", { recap: "local-recap" })];
		const remote = [catalogEntry("c", { recap: "remote-recap" })];
		expect(mergeCatalog(local, remote)[0]?.recap).toBe("remote-recap");
	});

	it("returns the union when disjoint", () => {
		const merged = mergeCatalog([catalogEntry("a")], [catalogEntry("b")]);
		expect(merged.map((c) => c.commitHash).sort()).toEqual(["a", "b"]);
	});

	it("preserves multi-topic entries", () => {
		const local = [
			catalogEntry("c", {
				topics: [
					{ title: "T1", decisions: "D1", category: "bugfix", importance: "major", filesAffected: ["x.md"] },
					{ title: "T2", decisions: "D2", category: "docs", importance: "minor", filesAffected: [] },
				],
			}),
		];
		const merged = mergeCatalog(local, []);
		expect(merged[0]?.topics).toHaveLength(2);
	});
});

/**
 * Cross-device determinism guard. Every merge function MUST satisfy
 * `JSON.stringify(merge(A,B)) === JSON.stringify(merge(B,A))` so two devices
 * — one having pulled the other's bytes — converge instead of re-conflicting
 * on the same `.jolli/<aggregate>.json` forever. The previous implementation
 * relied on Map insertion order and silently violated this for any non-empty
 * symmetric difference between local and remote.
 */
describe("merge determinism (cross-device symmetry)", () => {
	const STRINGIFY = (entries: ReadonlyArray<unknown>) => JSON.stringify(entries, null, 2);

	it("mergeManifest: A∪B byte-equals B∪A", () => {
		const a = [manifest("z", "2026-05-01"), manifest("a", "2026-05-02"), manifest("m", "2026-05-03")];
		const b = [manifest("q", "2026-05-01"), manifest("a", "2026-05-04"), manifest("b", "2026-05-01")];
		expect(STRINGIFY(mergeManifest(a, b))).toBe(STRINGIFY(mergeManifest(b, a)));
	});

	it("mergeIndex: A∪B byte-equals B∪A across all 2×2 parent/timestamp cases", () => {
		const a = [
			indexEntry("h-z", { parentCommitHash: "p", generatedAt: "2026-05-02T00:00:00Z" }),
			indexEntry("h-a", { parentCommitHash: null, generatedAt: "2026-05-01T00:00:00Z" }),
		];
		const b = [
			indexEntry("h-a", { parentCommitHash: "p", generatedAt: "2026-05-03T00:00:00Z" }),
			indexEntry("h-m", { parentCommitHash: null, generatedAt: "2026-05-04T00:00:00Z" }),
		];
		expect(STRINGIFY(mergeIndex(a, b))).toBe(STRINGIFY(mergeIndex(b, a)));
	});

	it("mergeBranches: A∪B byte-equals B∪A", () => {
		const a = [branchEntry("main"), branchEntry("feat/x"), branchEntry("zeta")];
		const b = [branchEntry("alpha"), branchEntry("main"), branchEntry("feat/y")];
		expect(STRINGIFY(mergeBranches(a, b))).toBe(STRINGIFY(mergeBranches(b, a)));
	});

	it("mergeCatalog: A∪B byte-equals B∪A", () => {
		const a = [catalogEntry("z"), catalogEntry("a"), catalogEntry("m")];
		const b = [catalogEntry("q"), catalogEntry("a"), catalogEntry("b")];
		expect(STRINGIFY(mergeCatalog(a, b))).toBe(STRINGIFY(mergeCatalog(b, a)));
	});

	it("sort key is codepoint, not locale — unicode branches still converge", () => {
		// `ä` (U+00E4) and `z` order is locale-sensitive under localeCompare
		// (Swedish: ä > z; English: ä < z). Codepoint compare gives a single
		// answer everywhere.
		const a = [branchEntry("ä"), branchEntry("z")];
		const b = [branchEntry("z"), branchEntry("ä")];
		expect(STRINGIFY(mergeBranches(a, b))).toBe(STRINGIFY(mergeBranches(b, a)));
	});
});

describe("canonicalBranchFolder", () => {
	it("lowercases and replaces slashes with hyphens", () => {
		expect(canonicalBranchFolder("feat/foo")).toBe("feat-foo");
		expect(canonicalBranchFolder("FEAT/BAR")).toBe("feat-bar");
	});

	it("collapses runs of non-[a-z0-9-] characters into a single hyphen", () => {
		expect(canonicalBranchFolder("hello world")).toBe("hello-world");
		expect(canonicalBranchFolder("a__b__c")).toBe("a-b-c");
	});

	it("trims leading and trailing hyphens", () => {
		expect(canonicalBranchFolder("/main/")).toBe("main");
		expect(canonicalBranchFolder("---x---")).toBe("x");
	});

	it("falls back to 'branch' for empty / all-junk input", () => {
		expect(canonicalBranchFolder("")).toBe("branch");
		expect(canonicalBranchFolder("///")).toBe("branch");
		expect(canonicalBranchFolder("---")).toBe("branch");
	});

	it("preserves digits and hyphens", () => {
		expect(canonicalBranchFolder("v1-rc-2")).toBe("v1-rc-2");
		expect(canonicalBranchFolder("release/0.99.x")).toBe("release-0-99-x");
	});

	it("normalizes NFKD (accented characters become ASCII when possible)", () => {
		// "é" decomposes to "e" + combining-acute, which gets stripped by the
		// non-[a-z0-9-] cleanup. "café" → "caf-e" (the combining mark and ASCII
		// "e" survive separately) is acceptable; just confirm no crash + no
		// raw "é".
		const result = canonicalBranchFolder("café");
		expect(result).not.toContain("é");
		expect(result.length).toBeGreaterThan(0);
	});
});
