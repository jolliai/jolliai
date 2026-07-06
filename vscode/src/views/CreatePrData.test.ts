import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../../../cli/src/Types.js";

const h = vi.hoisted(() => ({
	loadBranchSummaries: vi.fn(),
}));

vi.mock("./BranchSummaryLoader.js", () => ({
	loadBranchSummaries: h.loadBranchSummaries,
}));

import { buildCreatePrViewModel, parseNameStatus } from "./CreatePrData.js";

function summary(hash: string, msg: string, extra: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 5,
		commitHash: hash,
		commitMessage: msg,
		commitAuthor: "Dev",
		commitDate: "2024-01-01T00:00:00Z",
		branch: "feature/x",
		generatedAt: "2024-01-01T00:01:00Z",
		transcripts: [],
		plans: [],
		notes: [],
		references: [],
		topics: [],
		...extra,
	} as CommitSummary;
}

function makeBridge(over: Partial<Record<string, unknown>> = {}) {
	return {
		getCurrentBranch: vi.fn().mockResolvedValue("feature/x"),
		getBranchPrStats: vi.fn().mockResolvedValue({
			insertions: 10,
			deletions: 3,
			filesChanged: 2,
			files: [
				{ path: "src/foo.ts", dir: "src", status: "M" },
				{ path: "README.md", dir: "", status: "A" },
			],
		}),
		...over,
	} as unknown as import("../JolliMemoryBridge.js").JolliMemoryBridge;
}

describe("buildCreatePrViewModel", () => {
	beforeEach(() => {
		h.loadBranchSummaries.mockReset();
	});

	it("returns { empty: true } when no unmerged memories exist", async () => {
		h.loadBranchSummaries.mockResolvedValue({ summaries: [], missingCount: 0 });
		const vm = await buildCreatePrViewModel(makeBridge(), "main");
		expect(vm).toEqual({ empty: true });
	});

	it("assembles title/body/memories/files/e2e from branch summaries (anchor=last)", async () => {
		const older = summary("bbb2222", "fix: bug");
		const anchor = summary("aaa1111", "feat: redesign sidebar", {
			e2eTestGuide: [{ title: "Smoke", steps: ["open"], expectedResults: ["ok"] }],
		});
		// summaries in chronological order: oldest first, anchor (newest) last
		h.loadBranchSummaries.mockResolvedValue({
			summaries: [older, anchor],
			missingCount: 1,
		});
		const vm = await buildCreatePrViewModel(makeBridge(), "main");
		if ("empty" in vm) throw new Error("expected a view model");
		expect(vm.branch).toBe("feature/x");
		expect(vm.mainBranch).toBe("main");
		expect(vm.memoryCount).toBe(2);
		expect(vm.missingCount).toBe(1);
		// memories array preserves summaries order (oldest first)
		expect(vm.memories.map((m) => m.hash)).toEqual(["bbb2222", "aaa1111"]);
		// no prNumber field ever populated
		expect(vm.memories.every((m) => m.prNumber === undefined)).toBe(true);
		// title and body come from anchor (last element)
		expect(vm.title.length).toBeGreaterThan(0);
		expect(vm.bodyMarkdown).toContain("feat");
		// e2eScenarios aggregated across memories (here only the anchor has one)
		expect(vm.e2eScenarios).toHaveLength(1);
		expect(vm.e2eScenarios[0].title).toBe("Smoke");
		// file stats from getBranchPrStats
		expect(vm.insertions).toBe(10);
		expect(vm.deletions).toBe(3);
		expect(vm.filesChanged).toBe(2);
		expect(vm.files).toHaveLength(2);
		expect(vm.files[0]).toEqual({ path: "src/foo.ts", dir: "src", status: "M" });
	});

	it("aggregates E2E scenarios across all memories, not just the anchor", async () => {
		// The older (non-anchor) commit carries a scenario; the anchor has none.
		// Before aggregation the panel's E2E Test Guide would render empty.
		const older = summary("bbb2222", "fix: bug", {
			e2eTestGuide: [{ title: "Older scenario", steps: ["run"], expectedResults: ["pass"] }],
		});
		const anchor = summary("aaa1111", "feat: redesign sidebar");
		h.loadBranchSummaries.mockResolvedValue({ summaries: [older, anchor], missingCount: 0 });
		const vm = await buildCreatePrViewModel(makeBridge(), "main");
		if ("empty" in vm) throw new Error("expected a view model");
		expect(vm.e2eScenarios.map((s) => s.title)).toEqual(["Older scenario"]);
	});

	it("falls back to getCurrentBranch when anchor.branch is empty", async () => {
		const anchor = summary("ccc3333", "feat: no branch", { branch: "" });
		h.loadBranchSummaries.mockResolvedValue({ summaries: [anchor], missingCount: 0 });
		const bridge = makeBridge({ getCurrentBranch: vi.fn().mockResolvedValue("fallback-branch") });
		const vm = await buildCreatePrViewModel(bridge, "main");
		if ("empty" in vm) throw new Error("expected a view model");
		expect(vm.branch).toBe("fallback-branch");
	});
});

describe("parseNameStatus", () => {
	it("parses name-status lines into file rows", () => {
		const raw = "M\tsrc/foo.ts\nA\tREADME.md\nD\told/bar.ts\nR100\told/baz.ts\tnew/baz.ts";
		const rows = parseNameStatus(raw);
		expect(rows).toEqual([
			{ path: "src/foo.ts", dir: "src", status: "M" },
			{ path: "README.md", dir: "", status: "A" },
			{ path: "old/bar.ts", dir: "old", status: "D" },
			// Rename keeps BOTH sides: `path` = new, `oldPath` = base-side path so a
			// per-file diff can read the left side from where the content lived.
			{ path: "new/baz.ts", dir: "new", status: "R", oldPath: "old/baz.ts" },
		]);
	});

	it("returns empty array for empty input", () => {
		expect(parseNameStatus("")).toEqual([]);
		expect(parseNameStatus("  \n  ")).toEqual([]);
	});

	it("strips trailing CR from CRLF-terminated lines", async () => {
		const { parseNameStatus } = await import("./CreatePrData.js");
		const rows = parseNameStatus("M\tsrc/foo.ts\r\nA\tREADME.md\r");
		expect(rows).toEqual([
			{ path: "src/foo.ts", dir: "src", status: "M" },
			{ path: "README.md", dir: "", status: "A" },
		]);
	});
});
