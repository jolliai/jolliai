import { describe, expect, it, vi } from "vitest";

vi.mock("../core/SearchIndex.js", () => ({
	SearchIndex: { openCached: vi.fn() },
}));
vi.mock("../core/ContextCompiler.js", () => ({
	compileTaskContext: vi.fn(),
	buildRecallPayload: vi.fn(),
	listBranchCatalog: vi.fn(),
}));
vi.mock("../core/TopicPageStore.js", () => ({ readTopicPage: vi.fn() }));
vi.mock("../core/GitOps.js", () => ({ getCurrentBranch: vi.fn() }));
vi.mock("../core/SummaryStore.js", () => ({ getActiveStorage: vi.fn() }));
vi.mock("../core/PrDescription.js", () => ({ buildPrDescription: vi.fn() }));

import { buildRecallPayload, compileTaskContext, listBranchCatalog } from "../core/ContextCompiler.js";
import { getCurrentBranch } from "../core/GitOps.js";
import { buildPrDescription } from "../core/PrDescription.js";
import { SearchIndex } from "../core/SearchIndex.js";
import { getActiveStorage } from "../core/SummaryStore.js";
import { readTopicPage } from "../core/TopicPageStore.js";
import { runDecisionTimeline, runGetPrDescription, runListBranches, runRecall, runSearch } from "./McpTools.js";

describe("runSearch", () => {
	it("delegates to SearchIndex.search and returns hits", async () => {
		const search = vi.fn().mockResolvedValue([{ id: "topic:x", type: "topic", title: "X", score: 1 }]);
		vi.mocked(SearchIndex.openCached).mockResolvedValue({ search } as never);
		const out = await runSearch("/repo", { query: "auth", limit: 5 });
		expect(search).toHaveBeenCalledWith({ query: "auth", limit: 5, branch: undefined, type: undefined });
		expect(out.hits).toHaveLength(1);
	});

	it("rejects an empty query with a structured error", async () => {
		await expect(runSearch("/repo", { query: "" })).rejects.toThrow(/query/i);
	});

	it("threads the active storage into openCached so the index dir matches the compile warm-up", async () => {
		// Folder/dual-write users: the index lives at `<kbRoot>/.jolli/jollimemory/`,
		// resolved from storage.kbRoot. Without passing storage, openCached falls back
		// to cwd and never sees the warm index. Pin that storage is forwarded.
		const storage = { kbRoot: "/vault/repo" } as never;
		vi.mocked(getActiveStorage).mockReturnValue(storage);
		const search = vi.fn().mockResolvedValue([]);
		vi.mocked(SearchIndex.openCached).mockResolvedValue({ search } as never);
		await runSearch("/repo", { query: "auth" });
		expect(SearchIndex.openCached).toHaveBeenCalledWith("/repo", storage);
	});
});

describe("runRecall", () => {
	it("defaults to the current branch when none given", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("feature/auth");
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: "feature/auth" } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: "feature/auth" } as never);
		const out = await runRecall("/repo", {});
		expect(compileTaskContext).toHaveBeenCalledWith({ branch: "feature/auth" }, "/repo");
		expect(out.branch).toBe("feature/auth");
	});

	it("uses the explicit branch when provided", async () => {
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: "main" } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: "main" } as never);
		await runRecall("/repo", { branch: "main" });
		expect(compileTaskContext).toHaveBeenCalledWith({ branch: "main" }, "/repo");
	});
});

describe("runDecisionTimeline", () => {
	it("sorts a topic's sourceRefs chronologically", async () => {
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Auth",
			sourceRefs: [
				{ type: "summary", id: "b", timestamp: "2026-02-01T00:00:00Z", branch: "x" },
				{ type: "summary", id: "a", timestamp: "2026-01-01T00:00:00Z", branch: "x" },
			],
		} as never);
		const out = await runDecisionTimeline("/repo", { slug: "auth" });
		expect(out.timeline.map((t) => t.sourceId)).toEqual(["a", "b"]);
	});

	it("orders mixed-timezone timestamps by instant, not lexically", async () => {
		// '…+09:00' is the SAME instant as '…Z' minus 9h; a string localeCompare
		// would order them by suffix and get this wrong. The first ref is the
		// later instant despite sorting earlier as a raw string.
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Auth",
			sourceRefs: [
				{ type: "summary", id: "late", timestamp: "2026-01-01T10:00:00+09:00", branch: "x" },
				{ type: "summary", id: "early", timestamp: "2026-01-01T00:30:00Z", branch: "x" },
			],
		} as never);
		const out = await runDecisionTimeline("/repo", { slug: "auth" });
		// 00:30Z (=09:30+09:00) is earlier than 10:00+09:00, so "early" comes first.
		expect(out.timeline.map((t) => t.sourceId)).toEqual(["early", "late"]);
	});

	it("throws when the topic does not exist", async () => {
		vi.mocked(readTopicPage).mockResolvedValue(null);
		await expect(runDecisionTimeline("/repo", { slug: "missing" })).rejects.toThrow(/not found/i);
	});

	it("rejects an empty slug", async () => {
		await expect(runDecisionTimeline("/repo", { slug: "  " })).rejects.toThrow(/slug` is required/i);
	});

	it("defaults a missing ref branch to an empty string", async () => {
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Auth",
			sourceRefs: [{ type: "summary", id: "a", timestamp: "2026-01-01T00:00:00Z" }],
		} as never);
		const out = await runDecisionTimeline("/repo", { slug: "auth" });
		expect(out.timeline[0].branch).toBe("");
	});
});

describe("runListBranches", () => {
	it("returns the branch catalog", async () => {
		vi.mocked(listBranchCatalog).mockResolvedValue({ type: "catalog", branches: [{ branch: "main" }] } as never);
		const out = await runListBranches("/repo");
		expect(out.branches).toHaveLength(1);
	});
});

describe("runGetPrDescription", () => {
	it("forwards args to buildPrDescription and returns its result", async () => {
		const fakeResult = {
			type: "pr_description",
			branch: "feature/x",
			baseBranch: "main",
			title: "Add feature",
			body: "<!-- jollimemory-summary-start -->\nbody\n<!-- jollimemory-summary-end -->",
			commitCount: 2,
			summaryCount: 2,
			missingCount: 0,
		} as never;
		vi.mocked(buildPrDescription).mockResolvedValue(fakeResult);
		const out = await runGetPrDescription("/repo", {
			baseBranch: "main",
			includeMarkers: true,
		});
		expect(buildPrDescription).toHaveBeenCalledWith("/repo", {
			baseBranch: "main",
			includeMarkers: true,
		});
		expect(out).toBe(fakeResult);
	});

	it("propagates the 'no summaries' error from buildPrDescription", async () => {
		vi.mocked(buildPrDescription).mockRejectedValue(
			new Error('No JolliMemory summaries found on branch "empty" (base "main").'),
		);
		await expect(runGetPrDescription("/repo", {})).rejects.toThrow(/No JolliMemory summaries/);
	});
});
