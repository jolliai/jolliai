import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/SearchIndex.js", () => ({
	SearchIndex: { openCached: vi.fn() },
}));
vi.mock("../core/ContextCompiler.js", () => ({
	compileTaskContext: vi.fn(),
	buildRecallPayload: vi.fn(),
	listBranchCatalog: vi.fn(),
	DEFAULT_TOKEN_BUDGET: 80000,
}));
vi.mock("../core/TopicPageStore.js", () => ({ readTopicPage: vi.fn() }));
vi.mock("../core/SummaryStore.js", () => ({ getActiveStorage: vi.fn(), getIndex: vi.fn() }));
vi.mock("../core/PrDescription.js", () => ({ buildPrDescription: vi.fn() }));
vi.mock("../util/Subprocess.js", () => ({ execFileSyncHidden: vi.fn() }));
vi.mock("../core/JolliMemoryPushOrchestrator.js", () => ({
	pushBranchToJolli: vi.fn(),
	resolveSpaceId: vi.fn(),
}));
vi.mock("../core/JolliMemoryPushClient.js", async () => {
	const actual = await vi.importActual<typeof import("../core/JolliMemoryPushClient.js")>(
		"../core/JolliMemoryPushClient.js",
	);
	return { ...actual, JolliMemoryPushClient: vi.fn() };
});
// Mocked so these tests never touch a real `.jolli/jollimemory/space-binding.json`.
vi.mock("../core/SpaceBindingCache.js", () => ({ clearSpaceBindingCache: vi.fn() }));
vi.mock("../core/GitRemoteUtils.js", () => ({
	getCanonicalRepoUrl: vi.fn(),
	deriveRepoNameFromUrl: vi.fn(),
}));

import { buildRecallPayload, compileTaskContext, listBranchCatalog } from "../core/ContextCompiler.js";
import { deriveRepoNameFromUrl, getCanonicalRepoUrl } from "../core/GitRemoteUtils.js";
import { BindingAlreadyExistsError, JolliMemoryPushClient } from "../core/JolliMemoryPushClient.js";
import { pushBranchToJolli, resolveSpaceId } from "../core/JolliMemoryPushOrchestrator.js";
import { buildPrDescription } from "../core/PrDescription.js";
import { SearchIndex } from "../core/SearchIndex.js";
import { clearSpaceBindingCache } from "../core/SpaceBindingCache.js";
import { getActiveStorage, getIndex } from "../core/SummaryStore.js";
import { readTopicPage } from "../core/TopicPageStore.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
import {
	collapseTimelineRefs,
	getTopicDetail,
	runBindSpace,
	runDecisionTimeline,
	runGetPrDescription,
	runListBranches,
	runListSpaces,
	runPushMemory,
	runQueueStatus,
	runRecall,
	runSearch,
} from "./McpTools.js";

const MockClient = vi.mocked(JolliMemoryPushClient);

/**
 * `new JolliMemoryPushClient()` requires the mock implementation to be a real
 * constructible function — an arrow function throws "is not a constructor"
 * when invoked with `new`. `mockImplementation(function () {...})` sidesteps
 * that; this helper keeps call sites reading like a plain stub swap.
 */
function setClientStub(stub: Partial<JolliMemoryPushClient>): void {
	MockClient.mockImplementation(function (this: unknown) {
		return stub;
	} as unknown as typeof JolliMemoryPushClient);
}

let tempDir: string;

beforeEach(async () => {
	tempDir = join(tmpdir(), `mcptools-${process.pid}-${Math.floor(Date.now() % 1e9)}`);
	await mkdir(tempDir, { recursive: true });
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

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
		vi.mocked(execFileSyncHidden).mockReturnValue("feature/auth\n");
		vi.mocked(listBranchCatalog).mockResolvedValue({
			type: "catalog",
			branches: [{ branch: "feature/auth", commitCount: 1, period: { start: "2026-01-01", end: "2026-01-01" } }],
		} as never);
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: "feature/auth", commitCount: 1 } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: "feature/auth" } as never);
		const out = await runRecall("/repo", {});
		expect(out.type).toBe("recall");
		if (out.type === "recall") expect(out.branch).toBe("feature/auth");
	});

	it("uses the explicit branch when provided", async () => {
		vi.mocked(listBranchCatalog).mockResolvedValue({
			type: "catalog",
			branches: [{ branch: "main", commitCount: 1, period: { start: "2026-01-01", end: "2026-01-01" } }],
		} as never);
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: "main", commitCount: 1 } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: "main" } as never);
		await runRecall("/repo", { branch: "main" });
		expect(compileTaskContext).toHaveBeenCalledWith(expect.objectContaining({ branch: "main" }), "/repo");
	});

	it("returns type:catalog for a non-matching branch fragment", async () => {
		vi.mocked(listBranchCatalog).mockResolvedValue({
			type: "catalog",
			branches: [{ branch: "main", commitCount: 1, period: { start: "2026-01-01", end: "2026-01-01" } }],
		} as never);
		const r = await runRecall("/repo", { branch: "no-such-frag" });
		expect(r.type).toBe("catalog");
	});

	it("returns type:recall for an exact branch", async () => {
		const seededBranch = "feature/seeded";
		vi.mocked(listBranchCatalog).mockResolvedValue({
			type: "catalog",
			branches: [{ branch: seededBranch, commitCount: 2, period: { start: "2026-01-01", end: "2026-01-02" } }],
		} as never);
		vi.mocked(compileTaskContext).mockResolvedValue({ branch: seededBranch, commitCount: 2 } as never);
		vi.mocked(buildRecallPayload).mockReturnValue({ type: "recall", branch: seededBranch } as never);
		const r = await runRecall("/repo", { branch: seededBranch });
		expect(r.type).toBe("recall");
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

	it("folds an amend-superseded summary ref into its live head via the index", async () => {
		// The page holds both the pre-amend hash ("old") and the re-ingested head
		// ("new"); the index marks "old" as superseded (parentCommitHash → "new").
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Auth",
			sourceRefs: [
				{ type: "summary", id: "old", timestamp: "2026-01-01T00:00:00Z", branch: "x" },
				{ type: "summary", id: "new", timestamp: "2026-01-01T00:00:00Z", branch: "x" },
			],
		} as never);
		vi.mocked(getIndex).mockResolvedValue({
			entries: [
				{ commitHash: "old", parentCommitHash: "new", commitDate: "2026-01-01T00:00:00Z", branch: "x" },
				{ commitHash: "new", parentCommitHash: null, commitDate: "2026-01-01T00:00:00Z", branch: "y" },
			],
		} as never);
		const out = await runDecisionTimeline("/repo", { slug: "auth" });
		expect(out.timeline).toEqual([
			{ timestamp: "2026-01-01T00:00:00Z", branch: "y", sourceType: "summary", sourceId: "new" },
		]);
	});

	it("dedupes per-commit plan snapshots to the base slug's earliest timestamp", async () => {
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Auth",
			sourceRefs: [
				{ type: "plan", id: "home-tab-deadbeef", timestamp: "2026-01-03T00:00:00Z", branch: "x" },
				{ type: "plan", id: "home-tab-cafe1234", timestamp: "2026-01-02T00:00:00Z", branch: "x" },
				{ type: "note", id: "n1", timestamp: "2026-01-04T00:00:00Z", branch: "x" },
			],
		} as never);
		const out = await runDecisionTimeline("/repo", { slug: "auth" });
		expect(out.timeline.map((t) => t.sourceId)).toEqual(["home-tab-cafe1234", "n1"]);
	});
});

describe("getTopicDetail", () => {
	it("returns the page's readable content, related branches, and ordered timeline", async () => {
		vi.mocked(readTopicPage).mockResolvedValue({
			title: "Renamed file diff",
			content: "## Problem\nDiff failed.\n## Fix\nRead the working tree.",
			relatedBranches: ["bug-rename"],
			lastUpdatedAt: "2026-07-13T00:00:00Z",
			sourceRefs: [
				{ type: "summary", id: "b", timestamp: "2026-02-01T00:00:00Z", branch: "x" },
				{ type: "summary", id: "a", timestamp: "2026-01-01T00:00:00Z", branch: "x" },
			],
		} as never);
		const out = await getTopicDetail("/repo", "renamed");
		expect(out.title).toBe("Renamed file diff");
		expect(out.content).toContain("Read the working tree.");
		expect(out.relatedBranches).toEqual(["bug-rename"]);
		expect(out.timeline.map((t) => t.sourceId)).toEqual(["a", "b"]); // chronological
	});

	it("throws when the topic does not exist", async () => {
		vi.mocked(readTopicPage).mockResolvedValue(null);
		await expect(getTopicDetail("/repo", "missing")).rejects.toThrow(/not found/i);
	});

	it("rejects an empty slug", async () => {
		await expect(getTopicDetail("/repo", "  ")).rejects.toThrow(/slug` is required/i);
	});
});

describe("collapseTimelineRefs", () => {
	it("survives a parentCommitHash cycle and keeps distinct heads distinct", () => {
		const refs = [
			{ type: "summary" as const, id: "a", timestamp: "2026-01-01T00:00:00Z" },
			{ type: "summary" as const, id: "c", timestamp: "2026-01-02T00:00:00Z" },
		];
		const entries = [
			{ commitHash: "a", parentCommitHash: "b" },
			{ commitHash: "b", parentCommitHash: "a" }, // corrupt cycle — must not hang
		] as never[];
		const out = collapseTimelineRefs(refs, entries as never);
		expect(out.map((r) => r.id).sort()).toEqual(["b", "c"]);
	});

	it("prefers a parseable plan timestamp over an unparseable one", () => {
		const refs = [
			{ type: "plan" as const, id: "p-12345678", timestamp: "not-a-date" },
			{ type: "plan" as const, id: "p-abcdef01", timestamp: "2026-01-02T00:00:00Z" },
		];
		const out = collapseTimelineRefs(refs, []);
		expect(out).toHaveLength(1);
		expect(out[0].timestamp).toBe("2026-01-02T00:00:00Z");
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

describe("runQueueStatus", () => {
	it("returns drained for an empty queue", async () => {
		const r = await runQueueStatus(tempDir, {});
		expect(r).toMatchObject({ active: 0, drained: true });
	});

	it("returns waitedMs when wait is requested", async () => {
		const r = await runQueueStatus(tempDir, { wait: true, timeoutMs: 20 });
		expect(r).toHaveProperty("waitedMs");
	});
});

describe("runPushMemory", () => {
	afterEach(() => {
		vi.mocked(pushBranchToJolli).mockReset();
	});

	it("delegates to pushBranchToJolli and returns a pushed result", async () => {
		vi.mocked(pushBranchToJolli).mockResolvedValue({
			type: "pushed",
			pushed: 2,
			skipped: 0,
			urls: ["https://jolli.ai/articles?doc=1"],
		});
		const out = await runPushMemory("/repo", { baseBranch: "main", space: "acme" });
		expect(pushBranchToJolli).toHaveBeenCalledWith({ cwd: "/repo", baseBranch: "main", space: "acme" });
		expect(out).toEqual({ type: "pushed", pushed: 2, skipped: 0, urls: ["https://jolli.ai/articles?doc=1"] });
	});

	it("returns the binding_required union member unchanged", async () => {
		vi.mocked(pushBranchToJolli).mockResolvedValue({
			type: "binding_required",
			repoUrl: "https://github.com/acme/widgets",
			spaces: [{ id: 1, name: "Acme", slug: "acme" }],
			defaultSpaceId: 1,
		});
		const out = await runPushMemory("/repo", {});
		expect(pushBranchToJolli).toHaveBeenCalledWith({ cwd: "/repo", baseBranch: undefined, space: undefined });
		expect(out.type).toBe("binding_required");
	});
});

describe("runListSpaces", () => {
	afterEach(() => {
		MockClient.mockReset();
	});

	it("returns the spaces and default space id from the client", async () => {
		const spaces = [
			{ id: 1, name: "Acme", slug: "acme" },
			{ id: 2, name: "Widgets", slug: "widgets" },
		];
		setClientStub({ listSpaces: vi.fn(async () => ({ spaces, defaultSpaceId: 2 })) });
		const out = await runListSpaces("/repo");
		expect(out).toEqual({ spaces, defaultSpaceId: 2 });
	});
});

describe("runBindSpace", () => {
	afterEach(() => {
		MockClient.mockReset();
		vi.mocked(getCanonicalRepoUrl).mockReset();
		vi.mocked(deriveRepoNameFromUrl).mockReset();
		vi.mocked(resolveSpaceId).mockReset();
		vi.mocked(clearSpaceBindingCache).mockReset();
	});

	it("resolves the repo + space and returns the bound result", async () => {
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("https://github.com/acme/widgets");
		vi.mocked(deriveRepoNameFromUrl).mockReturnValue("widgets");
		vi.mocked(resolveSpaceId).mockResolvedValue(2);
		const createBinding = vi.fn(async () => ({ bindingId: 9, jmSpaceId: 2, repoName: "widgets" }));
		setClientStub({ createBinding });
		const out = await runBindSpace("/repo", { space: "widgets" });
		expect(createBinding).toHaveBeenCalledWith({
			repoUrl: "https://github.com/acme/widgets",
			repoName: "widgets",
			jmSpaceId: 2,
		});
		expect(out).toEqual({ type: "bound", bindingId: 9, jmSpaceId: 2, repoName: "widgets" });
		// Bind-only entry point: the local binding cache is dropped so the next
		// probe (or push echo) rebuilds it authoritatively.
		expect(clearSpaceBindingCache).toHaveBeenCalledWith("/repo");
	});

	it("returns type:already_bound instead of throwing when the repo is already bound", async () => {
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("https://github.com/acme/widgets");
		vi.mocked(deriveRepoNameFromUrl).mockReturnValue("widgets");
		vi.mocked(resolveSpaceId).mockResolvedValue(1);
		const createBinding = vi.fn(async () => {
			throw new BindingAlreadyExistsError("binding_already_exists");
		});
		setClientStub({ createBinding });
		const out = await runBindSpace("/repo", { space: "acme" });
		expect(out).toEqual({ type: "already_bound", message: "binding_already_exists" });
		// The binding did not change, so the cache is left untouched.
		expect(clearSpaceBindingCache).not.toHaveBeenCalled();
	});

	it("rejects an empty space", async () => {
		await expect(runBindSpace("/repo", { space: "  " })).rejects.toThrow(/space` is required/i);
	});

	it("propagates a non-BindingAlreadyExistsError from createBinding", async () => {
		vi.mocked(getCanonicalRepoUrl).mockResolvedValue("https://github.com/acme/widgets");
		vi.mocked(deriveRepoNameFromUrl).mockReturnValue("widgets");
		vi.mocked(resolveSpaceId).mockResolvedValue(1);
		const createBinding = vi.fn(async () => {
			throw new Error("HTTP 500");
		});
		setClientStub({ createBinding });
		await expect(runBindSpace("/repo", { space: "acme" })).rejects.toThrow("HTTP 500");
	});
});
