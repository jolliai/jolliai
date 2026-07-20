import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./MemoryBankRepoDiscovery.js", () => ({ discoverRepos: vi.fn() }));
vi.mock("./StorageFactory.js", () => ({ createFolderStorageAtRoot: vi.fn((kbRoot: string) => ({ kbRoot })) }));
vi.mock("./SearchIndex.js", () => ({ SearchIndex: { openCached: vi.fn() } }));

import { searchAll } from "./CrossRepoSearch.js";
import { discoverRepos } from "./MemoryBankRepoDiscovery.js";
import type { SearchHitResult } from "./SearchIndex.js";
import { SearchIndex } from "./SearchIndex.js";

function hit(score: number, over: Partial<SearchHitResult> = {}): SearchHitResult {
	return {
		id: `id-${score}`,
		type: "topic",
		title: `title-${score}`,
		snippet: "",
		branch: "main",
		commitDate: "",
		slug: `slug-${score}`,
		hash: "",
		score,
		...over,
	} as SearchHitResult;
}

/** Fake index whose search() returns the given hits. */
function fakeIndex(hits: SearchHitResult[]): { search: () => Promise<SearchHitResult[]> } {
	return { search: vi.fn(async () => hits) };
}

beforeEach(() => {
	vi.mocked(discoverRepos).mockResolvedValue([
		{ folder: "a", kbRoot: "/mb/a" },
		{ folder: "b", kbRoot: "/mb/b" },
	] as never);
	vi.mocked(SearchIndex.openCached).mockReset();
});

describe("searchAll", () => {
	it("short-circuits an empty / whitespace query without discovery", async () => {
		expect(await searchAll("/mb", "")).toEqual([]);
		expect(await searchAll("/mb", "   ")).toEqual([]);
		expect(discoverRepos).not.toHaveBeenCalled();
	});

	it("merges hits across repos ordered by score descending", async () => {
		vi.mocked(SearchIndex.openCached).mockImplementation(
			async (kbRoot: string) =>
				(kbRoot.endsWith("/a") ? fakeIndex([hit(1), hit(5)]) : fakeIndex([hit(3)])) as never,
		);
		const hits = await searchAll("/mb", "query");
		expect(hits.map((h) => h.score)).toEqual([5, 3, 1]);
		// Each hit is tagged with its source repo.
		expect(hits.find((h) => h.score === 3)?.repo).toBe("b");
	});

	it("skips a repo whose index fails to open, keeping the rest", async () => {
		vi.mocked(SearchIndex.openCached).mockImplementation(async (kbRoot: string) => {
			if (kbRoot.endsWith("/b")) throw new Error("orama boom");
			return fakeIndex([hit(2), hit(9)]) as never;
		});
		const hits = await searchAll("/mb", "query");
		expect(hits.map((h) => h.score)).toEqual([9, 2]); // only repo a's hits, b skipped
	});

	it("caps the merged result to `limit`", async () => {
		vi.mocked(SearchIndex.openCached).mockImplementation(async () => fakeIndex([hit(1), hit(2), hit(3)]) as never);
		const hits = await searchAll("/mb", "query", { limit: 2 });
		expect(hits).toHaveLength(2);
		expect(hits.map((h) => h.score)).toEqual([3, 3]); // top 2 across both repos
	});

	it("forwards excludeFolders to discovery", async () => {
		vi.mocked(discoverRepos).mockResolvedValue([] as never);
		await searchAll("/mb", "query", { excludeFolders: ["temp", "*-archive"] });
		expect(discoverRepos).toHaveBeenCalledWith("/mb", ["temp", "*-archive"]);
	});
});
