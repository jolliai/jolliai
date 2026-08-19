import { describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../../Types.js";

vi.mock("./GitReachability.js", () => ({ listReachableCommits: vi.fn() }));
vi.mock("../SummaryStore.js", () => ({ getIndex: vi.fn(), getSummary: vi.fn() }));

function root(hash: string, over: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 5,
		commitHash: hash,
		commitMessage: `msg ${hash}`,
		commitAuthor: "T",
		commitDate: "2026-08-17T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T00:00:00.000Z",
		topics: [],
		recap: "",
		...over,
	} as CommitSummary;
}

describe("findStrandedRoots", () => {
	// The two-step shape the production path now uses: hashes off the index,
	// payloads only for the hashes that came back unreachable.
	const withRoots = (...roots: CommitSummary[]) => ({
		listRootHashes: async () => roots.map((r) => r.commitHash),
		loadRoot: async (hash: string) => roots.find((r) => r.commitHash === hash) ?? null,
	});

	it("returns roots whose commit is unreachable", async () => {
		const { findStrandedRoots } = await import("./StrandedTrees.js");
		const result = await findStrandedRoots("/repo", {
			...withRoots(root("aaa"), root("bbb")),
			reachableCommits: async () => new Set(["bbb"]),
		});
		expect(result.map((r) => r.oldHash)).toEqual(["aaa"]);
	});

	it("ignores reachable roots entirely", async () => {
		const { findStrandedRoots } = await import("./StrandedTrees.js");
		const result = await findStrandedRoots("/repo", {
			...withRoots(root("aaa")),
			reachableCommits: async () => new Set(["aaa"]),
		});
		expect(result).toEqual([]);
	});

	it("builds the reachable set with ONE call regardless of how many roots there are", async () => {
		const { findStrandedRoots } = await import("./StrandedTrees.js");
		const reachableCommits = vi.fn(async () => new Set<string>());
		await findStrandedRoots("/repo", {
			...withRoots(root("aaa"), root("bbb"), root("ccc")),
			reachableCommits,
		});
		expect(reachableCommits).toHaveBeenCalledTimes(1);
		expect(reachableCommits).toHaveBeenCalledWith("/repo");
	});

	it("counts conversations and skills the repair would bring back", async () => {
		const { findStrandedRoots } = await import("./StrandedTrees.js");
		const [only] = await findStrandedRoots("/repo", {
			...withRoots(
				root("aaa", {
					transcripts: ["t1", "t2", "t3"],
					skills: [{ archivedKey: "k1" }, { archivedKey: "k2" }],
				} as unknown as Partial<CommitSummary>),
			),
			reachableCommits: async () => new Set(),
		});
		expect(only?.conversationCount).toBe(3);
		expect(only?.skillCount).toBe(2);
	});

	it("counts across the whole tree, not just the root node", async () => {
		const { findStrandedRoots } = await import("./StrandedTrees.js");
		const child = root("child", {
			transcripts: ["t1", "t2"],
			skills: [{ archivedKey: "k" }],
		} as unknown as Partial<CommitSummary>);
		const [only] = await findStrandedRoots("/repo", {
			...withRoots(root("aaa", { children: [child] } as Partial<CommitSummary>)),
			reachableCommits: async () => new Set(),
		});
		expect(only?.conversationCount).toBe(2);
		expect(only?.skillCount).toBe(1);
	});

	// The DEFAULT wiring is the production path and every test above injects
	// past it. Without this case, passing the wrong function or the wrong
	// argument order to the index/summary readers would not fail a single test.
	it("defaults to the real reachability set, the index root list and the real summary loader", async () => {
		const { listReachableCommits } = await import("./GitReachability.js");
		const { getIndex, getSummary } = await import("../SummaryStore.js");
		const { findStrandedRoots } = await import("./StrandedTrees.js");

		vi.mocked(getIndex).mockResolvedValue({
			entries: [
				{ commitHash: "aaa", parentCommitHash: null },
				// A CHILD row: it must never be probed, let alone reported.
				{ commitHash: "kid", parentCommitHash: "aaa" },
			],
		} as never);
		vi.mocked(getSummary).mockResolvedValue(root("aaa"));
		vi.mocked(listReachableCommits).mockResolvedValue(new Set());

		const result = await findStrandedRoots("/repo");

		expect(getIndex).toHaveBeenCalledWith("/repo", undefined);
		expect(listReachableCommits).toHaveBeenCalledWith("/repo");
		expect(listReachableCommits).toHaveBeenCalledTimes(1);
		expect(getSummary).toHaveBeenCalledWith("aaa", "/repo", undefined);
		expect(result.map((r) => r.oldHash)).toEqual(["aaa"]);
	});

	// The whole point of the two-step: `doctor` runs this on every invocation,
	// and a repo whose roots are all reachable (the normal state) must not pay
	// a single summary load. A regression back to `listSummaries` would load
	// all of them before the first reachability probe.
	it("loads no summary payload at all when every root is reachable", async () => {
		const { listReachableCommits } = await import("./GitReachability.js");
		const { getIndex, getSummary } = await import("../SummaryStore.js");
		const { findStrandedRoots } = await import("./StrandedTrees.js");

		vi.mocked(getIndex).mockResolvedValue({
			entries: [
				{ commitHash: "aaa", parentCommitHash: null },
				{ commitHash: "bbb", parentCommitHash: undefined },
			],
		} as never);
		vi.mocked(listReachableCommits).mockResolvedValue(new Set(["aaa", "bbb"]));
		vi.mocked(getSummary).mockClear();

		expect(await findStrandedRoots("/repo")).toEqual([]);
		expect(getSummary).not.toHaveBeenCalled();
	});

	it("skips an index root whose summary payload is gone rather than reporting an empty tree", async () => {
		const { findStrandedRoots } = await import("./StrandedTrees.js");
		const result = await findStrandedRoots("/repo", {
			listRootHashes: async () => ["ghost"],
			loadRoot: async () => null,
			reachableCommits: async () => new Set(),
		});
		expect(result).toEqual([]);
	});
});
