/**
 * The DEFAULT collaborators of `buildRepairPlan`, which every case in
 * `RepairPlan.test.ts` injects past. Its own file because the sibling suite
 * deliberately runs `remountStrandedTree` for real, and mocking `SummaryStore`
 * there would take that away.
 *
 * Without these, `defaultTargetHasMemory` asking the wrong question, or a
 * swapped `(hash, cwd)` argument order in any of the four defaults, would fail
 * no test at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../SummaryStore.js", () => ({ getIndex: vi.fn() }));
vi.mock("./GitReachability.js", () => ({
	isReachableFromAnyRef: vi.fn(),
	resolveCommitHash: vi.fn(),
	commitSubject: vi.fn(),
}));
vi.mock("./ReflogPairing.js", () => ({ pairStrandedHash: vi.fn() }));
vi.mock("./StrandedTrees.js", () => ({ findStrandedRoots: vi.fn() }));

import { getIndex } from "../SummaryStore.js";
import { commitSubject, isReachableFromAnyRef, resolveCommitHash } from "./GitReachability.js";
import { pairStrandedHash } from "./ReflogPairing.js";
import { buildRepairPlan } from "./RepairPlan.js";
import { findStrandedRoots } from "./StrandedTrees.js";

const strandedTree = { oldHash: "old", root: { commitHash: "old" }, conversationCount: 1, skillCount: 0 } as never;

function index(entries: Array<{ commitHash: string; parentCommitHash?: string | null }>) {
	return { version: 3, entries } as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(commitSubject).mockResolvedValue("target subject");
});

describe("buildRepairPlan default wiring", () => {
	it("detects with findStrandedRoots, pairs with the reflog and reads the real index", async () => {
		vi.mocked(findStrandedRoots).mockResolvedValue([strandedTree]);
		vi.mocked(pairStrandedHash).mockResolvedValue({ kind: "paired", newHash: "new" });
		vi.mocked(getIndex).mockResolvedValue(index([{ commitHash: "new", parentCommitHash: null }]));

		const plan = await buildRepairPlan("/repo");

		expect(findStrandedRoots).toHaveBeenCalledWith("/repo");
		expect(pairStrandedHash).toHaveBeenCalledWith("old", "/repo");
		expect(getIndex).toHaveBeenCalledWith("/repo");
		expect(plan[0]).toMatchObject({ kind: "remount", targetHash: "new" });
		// The subject `--status` renders comes from the real helper, in (hash, cwd)
		// order. Swapped arguments would silently render every target as unknown.
		expect(commitSubject).toHaveBeenCalledWith("new", "/repo");
		expect(plan[0]).toMatchObject({ targetSubject: "target subject" });
	});

	// I6: the same repository must not plan differently before and after
	// cutover. `summaries/<hash>.json` exists for a non-root on SQLite (the
	// path routes through `assembleMemoryTree`) and not on the orphan branch,
	// so the question has to be about the index's parent edge instead. A
	// non-root target answering "has memory" would remount a hash as a root
	// while it is still another tree's child.
	it("treats a hash that is another tree's CHILD as having no memory of its own", async () => {
		vi.mocked(findStrandedRoots).mockResolvedValue([strandedTree]);
		vi.mocked(pairStrandedHash).mockResolvedValue({ kind: "paired", newHash: "kid" });
		vi.mocked(getIndex).mockResolvedValue(
			index([
				{ commitHash: "root1", parentCommitHash: null },
				{ commitHash: "kid", parentCommitHash: "root1" },
			]),
		);

		const plan = await buildRepairPlan("/repo");

		expect(plan[0]).toMatchObject({ kind: "migrate", targetHash: "kid" });
	});

	it("treats a legacy v1 entry (undefined parent) as a root with a memory", async () => {
		vi.mocked(findStrandedRoots).mockResolvedValue([strandedTree]);
		vi.mocked(pairStrandedHash).mockResolvedValue({ kind: "paired", newHash: "new" });
		vi.mocked(getIndex).mockResolvedValue(index([{ commitHash: "new" }]));

		expect((await buildRepairPlan("/repo"))[0]).toMatchObject({ kind: "remount" });
	});

	it("plans a migrate when the index has no row for the target at all", async () => {
		vi.mocked(findStrandedRoots).mockResolvedValue([strandedTree]);
		vi.mocked(pairStrandedHash).mockResolvedValue({ kind: "paired", newHash: "new" });
		vi.mocked(getIndex).mockResolvedValue(null);

		expect((await buildRepairPlan("/repo"))[0]).toMatchObject({ kind: "migrate" });
	});

	it("resolves --to through git and checks its reachability before acting on it", async () => {
		vi.mocked(findStrandedRoots).mockResolvedValue([strandedTree]);
		vi.mocked(resolveCommitHash).mockResolvedValue("f".repeat(40));
		vi.mocked(isReachableFromAnyRef).mockResolvedValue(true);
		vi.mocked(getIndex).mockResolvedValue(index([{ commitHash: "f".repeat(40), parentCommitHash: null }]));

		const plan = await buildRepairPlan("/repo", { from: "old", to: "ffffffff" });

		expect(resolveCommitHash).toHaveBeenCalledWith("ffffffff", "/repo");
		expect(isReachableFromAnyRef).toHaveBeenCalledWith("f".repeat(40), "/repo");
		// The reflog is bypassed entirely on the override path.
		expect(pairStrandedHash).not.toHaveBeenCalled();
		expect(plan[0]).toMatchObject({ kind: "remount", targetHash: "f".repeat(40) });
	});
});
