import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetIndex, mockGetSummary } = vi.hoisted(() => ({
	mockGetIndex: vi.fn(),
	mockGetSummary: vi.fn(),
}));

vi.mock("./SummaryStore.js", () => ({
	getIndex: mockGetIndex,
	getSummary: mockGetSummary,
}));

import { getMemoryDetail, listCommittedMemories } from "./MemoryBankModel.js";

function entry(hash: string, branch: string, date: string, topicCount = 1, msg = `msg ${hash}`) {
	return {
		commitHash: hash,
		parentCommitHash: null,
		commitMessage: msg,
		commitDate: date,
		branch,
		generatedAt: date,
		topicCount,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("listCommittedMemories", () => {
	it("returns [] on an empty index", async () => {
		mockGetIndex.mockResolvedValue({ entries: [] });
		expect(await listCommittedMemories("/x")).toEqual([]);
	});

	it("is index-only: filters by branch, sorts newest-first, no per-row getSummary", async () => {
		mockGetIndex.mockResolvedValue({
			entries: [
				entry("a1", "main", "2026-07-01T00:00:00Z", 2),
				entry("b2", "main", "2026-07-03T00:00:00Z", 5),
				entry("c3", "other", "2026-07-04T00:00:00Z"),
			],
		});

		const items = await listCommittedMemories("/x", { branch: "main" });
		expect(items).toEqual([
			{ hash: "b2", title: "msg b2", date: "2026-07-03T00:00:00Z", branch: "main", topicsCount: 5 },
			{ hash: "a1", title: "msg a1", date: "2026-07-01T00:00:00Z", branch: "main", topicsCount: 2 },
		]);
		// The list must NOT load full summaries (detail pane does that on selection).
		expect(mockGetSummary).not.toHaveBeenCalled();
	});

	it("applies an explicit limit", async () => {
		mockGetIndex.mockResolvedValue({
			entries: [entry("a1", "main", "2026-07-01T00:00:00Z"), entry("b2", "main", "2026-07-03T00:00:00Z")],
		});
		const items = await listCommittedMemories("/x", { branch: "main", limit: 1 });
		expect(items.map((i) => i.hash)).toEqual(["b2"]);
	});
});

describe("getMemoryDetail", () => {
	it("delegates to getSummary", async () => {
		mockGetSummary.mockResolvedValue({ recap: "r" });
		expect(await getMemoryDetail("/x", "a1")).toEqual({ recap: "r" });
	});
});
