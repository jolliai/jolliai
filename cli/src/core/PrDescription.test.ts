import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./BranchCommitLister.js", () => ({ listBranchCommitHashes: vi.fn() }));
vi.mock("./SummaryStore.js", () => ({ getSummary: vi.fn() }));
vi.mock("./GitOps.js", () => ({ getCurrentBranch: vi.fn(), getDefaultBranch: vi.fn() }));

import { listBranchCommitHashes } from "./BranchCommitLister.js";
import { getCurrentBranch, getDefaultBranch } from "./GitOps.js";
import {
	buildPrBodyMarkdown,
	buildPrDescription,
	loadBranchSummaries,
	MARKER_END,
	MARKER_START,
	pickPrTitle,
	wrapWithMarkers,
} from "./PrDescription.js";
import { getSummary } from "./SummaryStore.js";

const s = (msg: string, extra: object = {}): never =>
	({
		commitMessage: msg,
		commitHash: "aabbccdd1122334",
		topics: [],
		plans: [],
		notes: [],
		children: [],
		...extra,
	}) as never;

describe("pickPrTitle", () => {
	it("uses last summary message when 2+", () => {
		expect(pickPrTitle(s("clicked"), [s("a"), s("b")])).toBe("b");
	});
	it("uses the single summary message", () => {
		expect(pickPrTitle(s("clicked"), [s("only")])).toBe("only");
	});
	it("falls back to currentSummary when none", () => {
		expect(pickPrTitle(s("clicked"), [])).toBe("clicked");
	});
});

describe("buildPrBodyMarkdown", () => {
	it("appends missing footnote in single-summary mode", () => {
		const body = buildPrBodyMarkdown(s("c"), [s("one")], 2);
		expect(body).toContain("2 commit(s) without summary were skipped");
	});
	it("aggregates for 2+ summaries (no single-mode footnote)", () => {
		const body = buildPrBodyMarkdown(s("c"), [s("a"), s("b")], 0);
		expect(body).toContain("Commits in this PR (2)");
	});
	it("does not append missing footnote when summaries is empty (falls back to currentSummary, no footnote)", () => {
		// summaries.length === 0 path: source = currentSummary; missingCount > 0 but
		// the guard `summaries.length === 0` short-circuits before appending the footnote
		const body = buildPrBodyMarkdown(s("c"), [], 3);
		expect(body).not.toContain("commit(s) without summary were skipped");
	});
});

describe("wrapWithMarkers", () => {
	it("wraps with start/end markers", () => {
		expect(wrapWithMarkers("X")).toBe("<!-- jollimemory-summary-start -->\nX\n<!-- jollimemory-summary-end -->");
	});
});

describe("loadBranchSummaries", () => {
	beforeEach(() => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: [], isMerged: false });
		vi.mocked(getSummary).mockResolvedValue(null);
	});

	it("returns empty summaries and zero missingCount when hashes is empty", async () => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: [], isMerged: false });
		const result = await loadBranchSummaries("/repo", "main");
		expect(result.summaries).toHaveLength(0);
		expect(result.missingCount).toBe(0);
	});

	it("reverses hashes to chronological order (oldest first)", async () => {
		// listBranchCommitHashes returns newest-first: ["h2", "h1"]
		// loadBranchSummaries must reverse to chronological: getSummary called with h1 first, h2 second
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h2", "h1"], isMerged: false });
		vi.mocked(getSummary).mockImplementation(async (hash) => s(`commit ${hash}`, { commitHash: hash }));
		const result = await loadBranchSummaries("/repo", "main");
		expect(result.summaries).toHaveLength(2);
		// chronological = oldest (h1) first, newest (h2) last
		expect((result.summaries[0] as { commitHash: string }).commitHash).toBe("h1");
		expect((result.summaries[1] as { commitHash: string }).commitHash).toBe("h2");
	});

	it("counts a null getSummary result as missingCount", async () => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h1", "h2"], isMerged: false });
		// h1 (chronologically first after reversal) returns null; h2 returns a summary
		vi.mocked(getSummary).mockImplementation(async (hash) =>
			hash === "h2" ? s("commit h2", { commitHash: "h2" }) : null,
		);
		const result = await loadBranchSummaries("/repo", "main");
		expect(result.summaries).toHaveLength(1);
		expect(result.missingCount).toBe(1);
	});

	it("counts a rejected getSummary promise as missingCount", async () => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["hBad"], isMerged: false });
		vi.mocked(getSummary).mockRejectedValue(new Error("storage failure"));
		const result = await loadBranchSummaries("/repo", "main");
		expect(result.summaries).toHaveLength(0);
		expect(result.missingCount).toBe(1);
	});
});

describe("buildPrDescription", () => {
	beforeEach(() => {
		// Reset call history too, not just return values. The suite-wide
		// `clearMocks` does not reach these `vi.mock()`-factory mocks, so an
		// earlier test in this block leaves `getDefaultBranch` call history
		// behind and breaks the `not.toHaveBeenCalled()` assertion below.
		vi.mocked(getCurrentBranch).mockReset().mockResolvedValue("feature/test");
		vi.mocked(getDefaultBranch).mockReset().mockResolvedValue("main");
		vi.mocked(listBranchCommitHashes).mockReset().mockResolvedValue({ hashes: [], isMerged: false });
		vi.mocked(getSummary).mockReset().mockResolvedValue(null);
	});

	it("throws with /No JolliMemory summaries/ when zero summaries exist", async () => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: [], isMerged: false });
		await expect(buildPrDescription("/repo", {})).rejects.toThrow(/No JolliMemory summaries/);
	});

	it("always reports the current branch (there is no branch override)", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("feature/auto");
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h1"], isMerged: false });
		vi.mocked(getSummary).mockResolvedValue(s("feat: auto branch", { commitHash: "h1" }));
		const result = await buildPrDescription("/repo", {});
		expect(result.branch).toBe("feature/auto");
	});

	it("defaults the base to the repo's resolved default branch when none is passed", async () => {
		vi.mocked(getDefaultBranch).mockResolvedValue("develop");
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h1"], isMerged: false });
		vi.mocked(getSummary).mockResolvedValue(s("feat: default base", { commitHash: "h1" }));
		const result = await buildPrDescription("/repo", {});
		expect(result.baseBranch).toBe("develop");
		expect(listBranchCommitHashes).toHaveBeenCalledWith("/repo", "develop");
	});

	it("does not resolve the default branch when an explicit baseBranch is given", async () => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h1"], isMerged: false });
		vi.mocked(getSummary).mockResolvedValue(s("feat: explicit", { commitHash: "h1" }));
		await buildPrDescription("/repo", { baseBranch: "release/9.x" });
		expect(getDefaultBranch).not.toHaveBeenCalled();
	});

	it("honors a custom baseBranch for the commit range", async () => {
		vi.mocked(getCurrentBranch).mockResolvedValue("feature/work");
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h1"], isMerged: false });
		vi.mocked(getSummary).mockResolvedValue(s("feat: explicit base", { commitHash: "h1" }));
		const result = await buildPrDescription("/repo", { baseBranch: "develop" });
		// branch is always the current branch; only the base is configurable.
		expect(result.branch).toBe("feature/work");
		expect(result.baseBranch).toBe("develop");
		expect(listBranchCommitHashes).toHaveBeenCalledWith("/repo", "develop");
	});

	it("returns correct title (last chronological summary's commitMessage)", async () => {
		// hashes newest-first: ["h2", "h1"] → reversed chronological: h1, h2 → last = h2
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h2", "h1"], isMerged: false });
		vi.mocked(getSummary).mockImplementation(async (hash) => s(`commit ${hash}`, { commitHash: hash }));
		const result = await buildPrDescription("/repo", {});
		expect(result.title).toBe("commit h2");
	});

	it("returns correct summaryCount and commitCount", async () => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h3", "h2", "h1"], isMerged: false });
		// h1 and h2 have summaries; h3 (newest, returned first by lister) is missing
		vi.mocked(getSummary).mockImplementation(async (hash) =>
			hash === "h3" ? null : s(`commit ${hash}`, { commitHash: hash }),
		);
		const result = await buildPrDescription("/repo", {});
		expect(result.summaryCount).toBe(2);
		expect(result.missingCount).toBe(1);
		expect(result.commitCount).toBe(3); // summaryCount + missingCount
	});

	it("wraps body in markers when includeMarkers defaults to true", async () => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h1"], isMerged: false });
		vi.mocked(getSummary).mockResolvedValue(s("feat: markers", { commitHash: "h1" }));
		const result = await buildPrDescription("/repo", {});
		expect(result.body).toContain(MARKER_START);
		expect(result.body).toContain(MARKER_END);
	});

	it("does NOT wrap body in markers when includeMarkers is false", async () => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h1"], isMerged: false });
		vi.mocked(getSummary).mockResolvedValue(s("feat: no markers", { commitHash: "h1" }));
		const result = await buildPrDescription("/repo", { includeMarkers: false });
		expect(result.body).not.toContain(MARKER_START);
		expect(result.body).not.toContain(MARKER_END);
	});

	it("includes queueActive and workerBlocking backstop fields", async () => {
		vi.mocked(listBranchCommitHashes).mockResolvedValue({ hashes: ["h1"], isMerged: false });
		vi.mocked(getSummary).mockResolvedValue(s("feat: backstop", { commitHash: "h1" }));
		const result = await buildPrDescription("/repo", {});
		expect(result).toHaveProperty("queueActive");
		expect(result).toHaveProperty("workerBlocking");
		expect(typeof result.queueActive).toBe("number");
		expect(typeof result.workerBlocking).toBe("boolean");
	});
});
