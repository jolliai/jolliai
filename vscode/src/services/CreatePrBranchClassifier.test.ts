import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockOrphanBranchExists, mockIsAncestor } = vi.hoisted(() => ({
	mockOrphanBranchExists: vi.fn(),
	mockIsAncestor: vi.fn(),
}));

vi.mock("../../../cli/src/core/GitOps.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../../../cli/src/core/GitOps.js")>();
	return {
		...actual,
		orphanBranchExists: mockOrphanBranchExists,
		isAncestor: mockIsAncestor,
	};
});

import {
	type CreatePrBranchDecision,
	classifyCreatePrBranch,
	createPrBlockMessage,
	effectiveBranchFor,
} from "./CreatePrBranchClassifier.js";

const CWD = "/repo";

describe("classifyCreatePrBranch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockOrphanBranchExists.mockResolvedValue(false);
		mockIsAncestor.mockResolvedValue(false);
	});

	it("no summary branch → ok, scoped to the current branch", async () => {
		const d = await classifyCreatePrBranch(undefined, "main", "abc", CWD);
		expect(d).toEqual({ kind: "ok", effectiveBranch: "main" });
		expect(mockOrphanBranchExists).not.toHaveBeenCalled();
	});

	it("current branch is the HEAD sentinel → detachedHead", async () => {
		const d = await classifyCreatePrBranch("feat", "HEAD", "abc", CWD);
		expect(d).toEqual({ kind: "detachedHead" });
		expect(mockOrphanBranchExists).not.toHaveBeenCalled();
	});

	it("summary branch equals current branch → ok, no git probes", async () => {
		const d = await classifyCreatePrBranch("feat", "feat", "abc", CWD);
		expect(d).toEqual({ kind: "ok", effectiveBranch: "feat" });
		expect(mockOrphanBranchExists).not.toHaveBeenCalled();
		expect(mockIsAncestor).not.toHaveBeenCalled();
	});

	it("mismatch + old ref still exists → crossBranch", async () => {
		mockOrphanBranchExists.mockResolvedValue(true);
		const d = await classifyCreatePrBranch("feat", "other", "abc", CWD);
		expect(d).toEqual({ kind: "crossBranch", summaryBranch: "feat" });
		expect(mockOrphanBranchExists).toHaveBeenCalledWith("feat", CWD);
		// Containment is irrelevant once the old ref exists.
		expect(mockIsAncestor).not.toHaveBeenCalled();
	});

	it("mismatch + old ref gone + current contains the commit → okAsCurrent (rename / successor)", async () => {
		mockOrphanBranchExists.mockResolvedValue(false);
		mockIsAncestor.mockResolvedValue(true);
		const d = await classifyCreatePrBranch("old", "new", "abc", CWD);
		expect(d).toEqual({ kind: "okAsCurrent", effectiveBranch: "new" });
		expect(mockIsAncestor).toHaveBeenCalledWith("abc", "HEAD", CWD);
	});

	it("mismatch + old ref gone + current does NOT contain the commit → originalGone (deleted+unrelated, or rename+rebase)", async () => {
		mockOrphanBranchExists.mockResolvedValue(false);
		mockIsAncestor.mockResolvedValue(false);
		const d = await classifyCreatePrBranch("old", "new", "abc", CWD);
		expect(d).toEqual({ kind: "originalGone", summaryBranch: "old" });
	});

	it("mismatch + old ref gone + no commit hash → originalGone without probing ancestry", async () => {
		mockOrphanBranchExists.mockResolvedValue(false);
		const d = await classifyCreatePrBranch("old", "new", undefined, CWD);
		expect(d).toEqual({ kind: "originalGone", summaryBranch: "old" });
		expect(mockIsAncestor).not.toHaveBeenCalled();
	});
});

describe("createPrBlockMessage", () => {
	it("detachedHead → distinct 'cannot determine' message (never 'Checkout HEAD')", () => {
		const msg = createPrBlockMessage({ kind: "detachedHead" }, "feat");
		expect(msg).toContain("Cannot determine the current branch");
		expect(msg).toContain("feat");
		expect(msg).not.toContain("Checkout HEAD");
	});

	it("detachedHead with no summary branch → omits the branch clause", () => {
		const msg = createPrBlockMessage({ kind: "detachedHead" }, undefined);
		expect(msg).toContain("Cannot determine the current branch");
		expect(msg).not.toContain("for ");
	});

	it("crossBranch → asks the user to checkout the summary's branch", () => {
		const msg = createPrBlockMessage(
			{ kind: "crossBranch", summaryBranch: "feat" },
			"feat",
		);
		expect(msg).toBe(
			"This summary is on branch feat. Checkout feat to create its PR.",
		);
	});

	it("originalGone → explains the branch is gone and the commit isn't on the current branch", () => {
		const msg = createPrBlockMessage(
			{ kind: "originalGone", summaryBranch: "old" },
			"old",
		);
		expect(msg).toContain("no longer exists");
		expect(msg).toContain("old");
	});

	it("ok / okAsCurrent → no block message", () => {
		expect(
			createPrBlockMessage({ kind: "ok", effectiveBranch: "feat" }, "feat"),
		).toBeNull();
		expect(
			createPrBlockMessage(
				{ kind: "okAsCurrent", effectiveBranch: "new" },
				"old",
			),
		).toBeNull();
	});
});

describe("effectiveBranchFor", () => {
	it("ok / okAsCurrent → the decision's effective branch", () => {
		expect(
			effectiveBranchFor({ kind: "ok", effectiveBranch: "feat" }, "feat"),
		).toBe("feat");
		expect(
			effectiveBranchFor(
				{ kind: "okAsCurrent", effectiveBranch: "new" },
				"old",
			),
		).toBe("new");
	});

	it("blocked / cross-branch kinds → fall back to the summary branch", () => {
		const kinds: CreatePrBranchDecision[] = [
			{ kind: "detachedHead" },
			{ kind: "crossBranch", summaryBranch: "feat" },
			{ kind: "originalGone", summaryBranch: "old" },
		];
		for (const d of kinds) {
			expect(effectiveBranchFor(d, "summary")).toBe("summary");
		}
	});
});
