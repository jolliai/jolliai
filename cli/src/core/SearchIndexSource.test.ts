import { describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "./StorageProvider.js";

// Mock the four stores this module reads.
vi.mock("./SummaryStore.js", () => ({
	getIndex: vi.fn(),
	getCatalogWithLazyBuild: vi.fn(),
}));
vi.mock("./TopicIndexStore.js", () => ({ readTopicIndex: vi.fn() }));
vi.mock("./TopicPageStore.js", () => ({ readTopicPage: vi.fn() }));

import { collectSearchDocs, computeSourceSignature } from "./SearchIndexSource.js";
import { getCatalogWithLazyBuild, getIndex } from "./SummaryStore.js";
import { readTopicIndex } from "./TopicIndexStore.js";
import { readTopicPage } from "./TopicPageStore.js";

const storage = {} as StorageProvider;

function wireSources() {
	vi.mocked(getIndex).mockResolvedValue({
		version: 3,
		entries: [
			{
				commitHash: "abc123def456",
				parentCommitHash: null,
				commitMessage: "add auth timeout",
				commitDate: "2026-01-02T00:00:00Z",
				branch: "feature/auth",
				generatedAt: "2026-01-02T01:00:00Z",
			},
		],
	} as never);
	vi.mocked(getCatalogWithLazyBuild).mockResolvedValue({
		version: 1,
		entries: [
			{
				commitHash: "abc123def456",
				recap: "Added a configurable auth session timeout.",
				ticketId: "JOLLI-1",
				topics: [{ title: "Auth timeout", decisions: "Chose a 30-min hard cap." }],
			},
		],
	} as never);
	vi.mocked(readTopicIndex).mockResolvedValue({
		schemaVersion: 1,
		topics: [
			{
				stableSlug: "auth-timeout",
				title: "Auth Timeout",
				summary: "How session timeout works",
				relatedBranches: ["feature/auth", "main"],
				sourceRefs: [
					{ type: "summary", id: "abc123def456", timestamp: "2026-01-02T00:00:00Z", branch: "feature/auth" },
				],
				lastUpdatedAt: "2026-01-03T00:00:00Z",
			},
		],
	} as never);
	vi.mocked(readTopicPage).mockResolvedValue({
		schemaVersion: 1,
		stableSlug: "auth-timeout",
		title: "Auth Timeout",
		content: "The auth session has a 30-minute hard timeout.",
		relatedBranches: ["feature/auth", "main"],
		sourceRefs: [
			{ type: "summary", id: "abc123def456", timestamp: "2026-01-02T00:00:00Z", branch: "feature/auth" },
		],
		lastUpdatedAt: "2026-01-03T00:00:00Z",
	} as never);
}

describe("collectSearchDocs", () => {
	it("emits one topic doc and one commit doc with joined fields", async () => {
		wireSources();
		const docs = await collectSearchDocs("/repo", storage);

		const topic = docs.find((d) => d.id === "topic:auth-timeout");
		expect(topic).toBeDefined();
		expect(topic?.type).toBe("topic");
		expect(topic?.content).toContain("30-minute hard timeout");
		expect(topic?.branch).toEqual(["feature/auth", "main"]);
		expect(topic?.slug).toBe("auth-timeout");
		expect(topic?.commitDate).toBe("2026-01-03T00:00:00Z");

		const commit = docs.find((d) => d.id === "commit:abc123def456");
		expect(commit).toBeDefined();
		expect(commit?.type).toBe("commit");
		expect(commit?.branch).toEqual(["feature/auth"]);
		expect(commit?.hash).toBe("abc123def456");
		expect(commit?.decisions).toContain("30-min hard cap");
		expect(commit?.content).toContain("Auth timeout"); // topic title folded into body
		expect(commit?.content).toContain("configurable auth session timeout"); // recap folded in
	});

	it("returns [] when there is no data", async () => {
		vi.mocked(getIndex).mockResolvedValue(null);
		vi.mocked(getCatalogWithLazyBuild).mockResolvedValue({ version: 1, entries: [] } as never);
		vi.mocked(readTopicIndex).mockResolvedValue({ schemaVersion: 1, topics: [] } as never);
		const docs = await collectSearchDocs("/repo", storage);
		expect(docs).toEqual([]);
	});

	it("falls back to the index-entry fields when no topic page exists, and to 'topic' category when refs are empty", async () => {
		// No page on disk → content/branches/sourceRefs/lastUpdatedAt come from the
		// topic index entry, and an empty sourceRefs list defaults the category to
		// "topic" (the dominantSourceType empty-input branch).
		wireSources();
		vi.mocked(readTopicPage).mockResolvedValue(null);
		vi.mocked(readTopicIndex).mockResolvedValue({
			schemaVersion: 1,
			topics: [
				{
					stableSlug: "auth-timeout",
					title: "Auth Timeout",
					summary: "index-entry summary fallback",
					relatedBranches: ["main"],
					sourceRefs: [],
					lastUpdatedAt: "2026-02-02T00:00:00Z",
				},
			],
		} as never);

		const docs = await collectSearchDocs("/repo", storage);
		const topic = docs.find((d) => d.id === "topic:auth-timeout");
		expect(topic?.content).toContain("index-entry summary fallback");
		expect(topic?.branch).toEqual(["main"]);
		expect(topic?.commitDate).toBe("2026-02-02T00:00:00Z");
		expect(topic?.category).toBe("topic"); // empty sourceRefs → default
	});

	it("picks the most frequent source-ref type as the topic category (sort comparator runs)", async () => {
		// Mixed sourceRefs (2× plan, 1× summary) force the dominantSourceType sort
		// comparator to actually compare counts and pick the plurality winner.
		wireSources();
		vi.mocked(readTopicPage).mockResolvedValue({
			schemaVersion: 1,
			stableSlug: "auth-timeout",
			title: "Auth Timeout",
			content: "body",
			relatedBranches: ["main"],
			sourceRefs: [
				{ type: "summary", id: "s1", timestamp: "2026-01-01T00:00:00Z", branch: "main" },
				{ type: "plan", id: "p1", timestamp: "2026-01-01T00:00:00Z", branch: "main" },
				{ type: "plan", id: "p2", timestamp: "2026-01-01T00:00:00Z", branch: "main" },
			],
			lastUpdatedAt: "2026-01-03T00:00:00Z",
		} as never);

		const docs = await collectSearchDocs("/repo", storage);
		expect(docs.find((d) => d.id === "topic:auth-timeout")?.category).toBe("plan");
	});

	it("skips a catalog entry that has no matching index head, and tolerates missing topics/recap/decisions", async () => {
		wireSources();
		vi.mocked(getCatalogWithLazyBuild).mockResolvedValue({
			version: 1,
			entries: [
				// Has an index head (abc123def456) but no topics array and no recap →
				// body is the commit message only; decisions stays "".
				{ commitHash: "abc123def456" },
				// No index head → must be skipped (the `!meta` continue branch).
				{ commitHash: "orphan-no-index", recap: "dangling" },
				// Index head present, a topic whose decisions is undefined → filtered out.
				{ commitHash: "abc123def456", topics: [{ title: "T", decisions: undefined }] },
			],
		} as never);

		const docs = await collectSearchDocs("/repo", storage);
		const commits = docs.filter((d) => d.type === "commit");
		expect(commits.map((c) => c.hash)).not.toContain("orphan-no-index");
		const bare = commits[0];
		expect(bare.content).toBe("add auth timeout"); // commitMessage only
		expect(bare.decisions).toBe("");
	});
});

describe("computeSourceSignature", () => {
	it("changes when source counts or timestamps change", async () => {
		wireSources();
		const sig1 = await computeSourceSignature("/repo", storage);

		vi.mocked(readTopicIndex).mockResolvedValue({
			schemaVersion: 1,
			topics: [
				{
					stableSlug: "auth-timeout",
					title: "Auth Timeout",
					summary: "x",
					relatedBranches: [],
					sourceRefs: [],
					lastUpdatedAt: "2026-09-09T00:00:00Z", // newer
				},
			],
		} as never);
		const sig2 = await computeSourceSignature("/repo", storage);
		expect(sig2).not.toBe(sig1);
	});

	it("changes when catalog content is edited in place (same counts, same timestamps)", async () => {
		// Regression guard (P3): a WebView recap edit rewrites the catalog entry's
		// recap but preserves the index entry's generatedAt and every count — the
		// count+timestamp signature would miss it and serve a stale search index.
		wireSources();
		const sig1 = await computeSourceSignature("/repo", storage);

		vi.mocked(getCatalogWithLazyBuild).mockResolvedValue({
			version: 1,
			entries: [
				{
					commitHash: "abc123def456",
					recap: "EDITED: a different recap entirely.",
					ticketId: "JOLLI-1",
					topics: [{ title: "Auth timeout", decisions: "Chose a 30-min hard cap." }],
				},
			],
		} as never);
		const sig2 = await computeSourceSignature("/repo", storage);
		expect(sig2).not.toBe(sig1);
	});

	it("keeps the newest timestamp when a later entry is older (reducer retains max)", async () => {
		// Two index entries and two topics where the SECOND is older than the first.
		// The reducer's `max > e` retain branch only fires when a non-first element
		// fails the `>` comparison.
		wireSources();
		vi.mocked(getIndex).mockResolvedValue({
			version: 3,
			entries: [
				{ commitHash: "a", branch: "main", parentCommitHash: null, generatedAt: "2026-05-05T00:00:00Z" },
				{ commitHash: "b", branch: "main", parentCommitHash: null, generatedAt: "2026-01-01T00:00:00Z" },
			],
		} as never);
		vi.mocked(readTopicIndex).mockResolvedValue({
			schemaVersion: 1,
			topics: [
				{
					stableSlug: "t1",
					title: "T1",
					summary: "",
					relatedBranches: [],
					sourceRefs: [],
					lastUpdatedAt: "2026-05-05T00:00:00Z",
				},
				{
					stableSlug: "t2",
					title: "T2",
					summary: "",
					relatedBranches: [],
					sourceRefs: [],
					lastUpdatedAt: "2026-01-01T00:00:00Z",
				},
			],
		} as never);

		const sig = await computeSourceSignature("/repo", storage);
		// newestGeneratedAt + topicNewest both pin the May timestamp, not the Jan one.
		expect(sig).toContain("2026-05-05T00:00:00Z");
		expect(sig).not.toContain("2026-01-01T00:00:00Z");
	});

	it("handles a null index and catalog entries missing recap/topics/decisions without throwing", async () => {
		// index null → indexCount 0 and newestGeneratedAt "" (the `?? 0` / `?? []`
		// branches); catalog entries with absent recap/topics and undefined
		// decisions exercise the `?? ""` folds inside the content digest.
		vi.mocked(getIndex).mockResolvedValue(null);
		vi.mocked(getCatalogWithLazyBuild).mockResolvedValue({
			version: 1,
			entries: [{ commitHash: "h1" }, { commitHash: "h2", topics: [{ title: "T", decisions: undefined }] }],
		} as never);
		vi.mocked(readTopicIndex).mockResolvedValue({ schemaVersion: 1, topics: [] } as never);

		const sig = await computeSourceSignature("/repo", storage);
		expect(typeof sig).toBe("string");
		expect(sig.split("|")[1]).toBe("0"); // indexCount === 0 from the null index
	});
});
