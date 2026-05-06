import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitCatalog, CommitSummary, SummaryIndex } from "../Types.js";
import {
	extractSnippet,
	findFirstMatchOffset,
	highlightTerms,
	LocalSearchProvider,
	parseSince,
	tokenizeQuery,
} from "./LocalSearchProvider.js";
import { DEFAULT_CATALOG_LIMIT, DEFAULT_SEARCH_BUDGET } from "./Search.js";

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("./SummaryStore.js", () => ({
	getCatalogWithLazyBuild: vi.fn(),
	getIndex: vi.fn(),
	getSummary: vi.fn(),
}));

import { getCatalogWithLazyBuild, getIndex, getSummary } from "./SummaryStore.js";

const mockGetIndex = vi.mocked(getIndex);
const mockGetCatalog = vi.mocked(getCatalogWithLazyBuild);
const mockGetSummary = vi.mocked(getSummary);

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeIndex(rootHashes: string[], date = "2026-04-01T10:00:00.000Z"): SummaryIndex {
	return {
		version: 3,
		entries: rootHashes.map((h, i) => ({
			commitHash: h,
			parentCommitHash: null,
			branch: "feature/x",
			commitMessage: `commit ${i}`,
			commitDate: new Date(new Date(date).getTime() - i * 1000).toISOString(),
			generatedAt: date,
		})),
	};
}

function makeCatalog(entries: CommitCatalog["entries"]): CommitCatalog {
	return { version: 1, entries };
}

function makeSummary(hash: string, overrides: Partial<CommitSummary> = {}): CommitSummary {
	return {
		version: 4,
		commitHash: hash,
		commitMessage: `feat: ${hash}`,
		commitAuthor: "dev",
		commitDate: "2026-04-01T10:00:00.000Z",
		branch: "feature/x",
		generatedAt: "2026-04-01T10:01:00.000Z",
		recap: `Recap for ${hash}`,
		topics: [
			{
				title: "Auth flow",
				trigger: "Need login",
				response: "Implemented OAuth",
				decisions: "Chose JWT over Session",
				category: "feature",
				importance: "major",
				filesAffected: ["src/auth.ts"],
			},
		],
		...overrides,
	};
}

// ─── parseSince ──────────────────────────────────────────────────────────────

describe("parseSince", () => {
	it("returns null for undefined", () => {
		expect(parseSince(undefined)).toBeNull();
	});

	it("returns null for empty / whitespace-only strings", () => {
		expect(parseSince("")).toBeNull();
		expect(parseSince("   ")).toBeNull();
	});

	it("parses days (case-insensitive)", () => {
		const beforeNow = Date.now();
		const ts = parseSince("7d");
		const expected = beforeNow - 7 * 86_400_000;
		// Allow 1s slack for clock drift between Date.now() calls.
		expect(Math.abs((ts ?? 0) - expected)).toBeLessThan(1000);

		const upper = parseSince("7D");
		expect(upper).not.toBeNull();
	});

	it("parses weeks / months / years", () => {
		const w = parseSince("2w");
		expect(w).not.toBeNull();
		const m = parseSince("1m");
		expect(m).not.toBeNull();
		const y = parseSince("1y");
		expect(y).not.toBeNull();
	});

	it("zero days resolves to ~now", () => {
		const ts = parseSince("0d");
		expect(Math.abs((ts ?? 0) - Date.now())).toBeLessThan(1000);
	});

	it("rejects decimal numbers", () => {
		// "1.5d" — the regex matches integer-only so this falls through to Date parsing
		const ts = parseSince("1.5d");
		// Date.parse("1.5d") is NaN
		expect(ts).toBeNull();
	});

	it("parses ISO date strings", () => {
		const ts = parseSince("2026-01-01");
		expect(ts).not.toBeNull();
		expect(ts).toBe(new Date("2026-01-01").getTime());
	});

	it("returns null for invalid date strings", () => {
		expect(parseSince("not-a-date")).toBeNull();
	});
});

// ─── tokenizeQuery ───────────────────────────────────────────────────────────

describe("tokenizeQuery", () => {
	it("returns empty for empty / whitespace", () => {
		expect(tokenizeQuery("")).toEqual([]);
		expect(tokenizeQuery("   ")).toEqual([]);
	});

	it("splits on whitespace", () => {
		expect(tokenizeQuery("foo bar baz")).toEqual(["foo", "bar", "baz"]);
	});

	it("normalizes to lowercase", () => {
		expect(tokenizeQuery("FOO Bar")).toEqual(["foo", "bar"]);
	});

	it("preserves quoted phrases as a single token", () => {
		expect(tokenizeQuery('"rate limiting" auth')).toEqual(["rate limiting", "auth"]);
	});

	it("strips stray quotes from unbalanced input (defensive)", () => {
		// Unbalanced opening quote — the unquoted path captures `"foo`; we strip the quote.
		expect(tokenizeQuery('"foo')).toEqual(["foo"]);
		// Adjacent quotes around a single token.
		expect(tokenizeQuery('foo"bar')).toEqual(["foobar"]);
	});

	it("drops empty captures (e.g. just whitespace inside quotes)", () => {
		expect(tokenizeQuery('"   "')).toEqual([]);
	});
});

// ─── findFirstMatchOffset ────────────────────────────────────────────────────

describe("findFirstMatchOffset", () => {
	it("returns -1 for empty tokens", () => {
		expect(findFirstMatchOffset("hello world", [])).toBe(-1);
	});

	it("returns -1 for empty text", () => {
		expect(findFirstMatchOffset("", ["foo"])).toBe(-1);
	});

	it("returns -1 when no token matches", () => {
		expect(findFirstMatchOffset("hello world", ["xyz"])).toBe(-1);
	});

	it("returns the first match position", () => {
		expect(findFirstMatchOffset("hello world", ["world"])).toBe(6);
	});

	it("returns the lowest offset across multiple tokens", () => {
		expect(findFirstMatchOffset("hello world foo", ["foo", "world"])).toBe(6);
	});

	it("updates best when a later token finds an earlier match", () => {
		// First token "world" matches at 6; second token "hello" matches at 0,
		// so the loop must update best from 6 → 0.
		expect(findFirstMatchOffset("hello world", ["world", "hello"])).toBe(0);
	});

	it("keeps best unchanged when a later token finds a later match", () => {
		// "hello" matches at 0; "world" matches at 6 (not earlier), so the
		// `idx < best` branch evaluates false and best stays 0.
		expect(findFirstMatchOffset("hello world", ["hello", "world"])).toBe(0);
	});

	it("ignores empty tokens", () => {
		expect(findFirstMatchOffset("hello world", ["", "world"])).toBe(6);
	});

	it("is case-insensitive", () => {
		expect(findFirstMatchOffset("Hello World", ["world"])).toBe(6);
	});
});

// ─── extractSnippet ──────────────────────────────────────────────────────────

describe("extractSnippet", () => {
	it("returns empty string for empty text", () => {
		expect(extractSnippet("", ["foo"])).toBe("");
	});

	it("falls back to prefix when no match", () => {
		const snippet = extractSnippet("a very long string with no matches".repeat(20), ["nope"]);
		expect(snippet).toContain("a very long string");
		expect(snippet.endsWith("...")).toBe(true);
	});

	it("returns full short text on no match without ellipsis", () => {
		expect(extractSnippet("short", ["nope"])).toBe("short");
	});

	it("centers around match with ellipsis on both sides for long text", () => {
		const long = `${"left ".repeat(40)}NEEDLE${" right".repeat(40)}`;
		const snippet = extractSnippet(long, ["needle"]);
		expect(snippet.startsWith("...")).toBe(true);
		expect(snippet.endsWith("...")).toBe(true);
		expect(snippet).toMatch(/\*\*NEEDLE\*\*/);
	});

	it("omits left ellipsis when match is at start", () => {
		const text = "NEEDLE then plenty of trailing context to extend past the half-width threshold. ".repeat(3);
		const snippet = extractSnippet(text, ["needle"]);
		expect(snippet.startsWith("...")).toBe(false);
		expect(snippet).toMatch(/^\*\*NEEDLE\*\*/);
	});

	it("omits right ellipsis when match is at end", () => {
		const lots = "lorem ipsum dolor ".repeat(20);
		const text = `${lots}NEEDLE`;
		const snippet = extractSnippet(text, ["needle"]);
		expect(snippet.endsWith("...")).toBe(false);
		expect(snippet).toMatch(/\*\*NEEDLE\*\*$/);
	});
});

// ─── highlightTerms ──────────────────────────────────────────────────────────

describe("highlightTerms", () => {
	it("returns text unchanged when tokens are empty", () => {
		expect(highlightTerms("hello", [])).toBe("hello");
	});

	it("returns text unchanged when no token matches", () => {
		expect(highlightTerms("hello", ["xyz"])).toBe("hello");
	});

	it("wraps single match in markdown bold", () => {
		expect(highlightTerms("foo bar baz", ["bar"])).toBe("foo **bar** baz");
	});

	it("preserves original casing inside the bold wrapper", () => {
		expect(highlightTerms("Foo BAR baz", ["bar"])).toBe("Foo **BAR** baz");
	});

	it("merges overlapping ranges so we never produce nested **", () => {
		const out = highlightTerms("aaaa", ["aa"]);
		// Overlapping matches (positions 0,1,2) merge into one.
		expect(out).toBe("**aaaa**");
	});

	it("handles multiple tokens that share start position", () => {
		const out = highlightTerms("authentication flow", ["auth", "authentication"]);
		// Both tokens start at 0; ranges merge to length 14 ("authentication").
		expect(out).toBe("**authentication** flow");
	});

	it("ignores empty tokens", () => {
		expect(highlightTerms("foo", ["", "foo"])).toBe("**foo**");
	});
});

// ─── LocalSearchProvider.buildCatalog ─────────────────────────────────────────

describe("LocalSearchProvider.buildCatalog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty catalog when no index", async () => {
		mockGetIndex.mockResolvedValue(null);
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "auth" });
		expect(result.totalCandidates).toBe(0);
		expect(result.entries).toHaveLength(0);
		expect(result.truncated).toBe(false);
	});

	it("joins index metadata with catalog content", async () => {
		mockGetIndex.mockResolvedValue(makeIndex(["aaa1", "bbb2"]));
		mockGetCatalog.mockResolvedValue(
			makeCatalog([
				{
					commitHash: "aaa1",
					recap: "Recap A",
					ticketId: "PROJ-1",
					topics: [
						{
							title: "Topic A",
							decisions: "Did A",
							category: "feature",
							importance: "major",
							filesAffected: ["a.ts"],
						},
					],
				},
				{ commitHash: "bbb2", recap: "Recap B" },
			]),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "auth" });
		expect(result.entries).toHaveLength(2);
		const a = result.entries.find((e) => e.fullHash === "aaa1");
		expect(a?.recap).toBe("Recap A");
		expect(a?.ticketId).toBe("PROJ-1");
		expect(a?.topics?.[0].decisions).toBe("Did A");
		expect(a?.topics?.[0].filesAffected).toEqual(["a.ts"]);
		const b = result.entries.find((e) => e.fullHash === "bbb2");
		expect(b?.recap).toBe("Recap B");
		expect(b?.topics).toBeUndefined();
	});

	it("filters by --since (relative)", async () => {
		const recent = new Date().toISOString();
		const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
		mockGetIndex.mockResolvedValue({
			version: 3,
			entries: [
				{
					commitHash: "recent",
					parentCommitHash: null,
					branch: "x",
					commitMessage: "m1",
					commitDate: recent,
					generatedAt: recent,
				},
				{
					commitHash: "old",
					parentCommitHash: null,
					branch: "x",
					commitMessage: "m2",
					commitDate: old,
					generatedAt: old,
				},
			],
		});
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q", since: "30d" });
		expect(result.entries.map((e) => e.fullHash)).toEqual(["recent"]);
	});

	it("respects --limit", async () => {
		mockGetIndex.mockResolvedValue(makeIndex(["a", "b", "c", "d"]));
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q", limit: 2 });
		expect(result.entries).toHaveLength(2);
		expect(result.truncated).toBe(true);
		expect(result.totalCandidates).toBe(4);
	});

	it("trims `decisions` to fit budget when entry would exceed", async () => {
		const longDecisions = "X".repeat(2000);
		mockGetIndex.mockResolvedValue(makeIndex(["aaa"]));
		mockGetCatalog.mockResolvedValue(
			makeCatalog([
				{
					commitHash: "aaa",
					topics: [{ title: "t", decisions: longDecisions }],
				},
			]),
		);
		const provider = new LocalSearchProvider("/test");
		const tight = await provider.buildCatalog({ query: "q", budget: 50 });
		expect(tight.entries.length === 0 || tight.entries[0].topics?.[0].decisions === undefined).toBe(true);
	});

	it("treats missing index entries as empty without crashing", async () => {
		mockGetIndex.mockResolvedValue({ version: 3, entries: [] });
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q" });
		expect(result.entries).toHaveLength(0);
		expect(result.totalCandidates).toBe(0);
	});

	it("preserves the --since echo even when filter excludes everything", async () => {
		mockGetIndex.mockResolvedValue(makeIndex(["aaa", "bbb"], "2025-01-01T00:00:00.000Z"));
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q", since: "1d" });
		expect(result.filter.since).toBe("1d");
		expect(result.entries).toHaveLength(0);
	});

	it("breaks early and marks truncated when even the trimmed entry exceeds budget", async () => {
		// Two entries: first fits trimmed; second still exceeds even after trimming.
		const massiveTitle = "X".repeat(20_000);
		mockGetIndex.mockResolvedValue(makeIndex(["aaa", "bbb"]));
		mockGetCatalog.mockResolvedValue(
			makeCatalog([
				{ commitHash: "aaa", topics: [{ title: "fits" }] },
				{ commitHash: "bbb", topics: [{ title: massiveTitle }] },
			]),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q", budget: 100 });
		expect(result.truncated).toBe(true);
		// We expect to have included the small one but not the massive one.
		expect(result.entries.length).toBeLessThanOrEqual(1);
	});

	it("filters skip ineligible (child) entries", async () => {
		mockGetIndex.mockResolvedValue({
			version: 3,
			entries: [
				{
					commitHash: "root",
					parentCommitHash: null,
					branch: "x",
					commitMessage: "m1",
					commitDate: "2026-04-01T00:00:00Z",
					generatedAt: "2026-04-01T00:00:00Z",
				},
				{
					commitHash: "child",
					parentCommitHash: "root",
					branch: "x",
					commitMessage: "m2",
					commitDate: "2026-03-31T00:00:00Z",
					generatedAt: "2026-03-31T00:00:00Z",
				},
			],
		});
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q" });
		expect(result.entries.map((e) => e.fullHash)).toEqual(["root"]);
	});

	it("forwards an explicit storage parameter to internal calls", async () => {
		// Provide a stub StorageProvider that we don't expect to be called (because
		// SummaryStore is mocked), but its presence exercises the constructor's
		// `storage?` branch.
		const stubStorage = {
			readFile: vi.fn(async () => null),
			writeFiles: vi.fn(async () => undefined),
			listFiles: vi.fn(async () => []),
			exists: vi.fn(async () => true),
			ensure: vi.fn(async () => undefined),
		};
		mockGetIndex.mockResolvedValue(makeIndex(["a"]));
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test", stubStorage);
		const result = await provider.buildCatalog({ query: "q" });
		expect(result.entries).toHaveLength(1);
	});

	it("trimEntry returns the entry untouched when it has no topics", async () => {
		// Reach the early-return path inside trimEntry by giving a budget too
		// small for an entry that has no `topics` field — so trim is a no-op.
		mockGetIndex.mockResolvedValue(makeIndex(["lonely"]));
		mockGetCatalog.mockResolvedValue(makeCatalog([{ commitHash: "lonely", recap: "X".repeat(2000) }]));
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q", budget: 10 });
		// Even after trim the entry is too big, so it should be excluded and truncated.
		expect(result.truncated).toBe(true);
		expect(result.entries).toHaveLength(0);
	});

	it("uses defaults for limit and budget when not provided", async () => {
		mockGetIndex.mockResolvedValue(makeIndex(["a"]));
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q" });
		expect(result.filter.limit).toBe(DEFAULT_CATALOG_LIMIT);
		// budget isn't echoed back, but the default should not cause truncation here
		expect(result.estimatedTokens).toBeLessThan(DEFAULT_SEARCH_BUDGET);
	});
});

// ─── LocalSearchProvider.loadHits ─────────────────────────────────────────────

describe("LocalSearchProvider.loadHits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns empty results for empty hashes", async () => {
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "auth", hashes: [] });
		expect(result.results).toHaveLength(0);
		expect(result.failedHashes).toBeUndefined();
	});

	it("loads hits and includes failed hashes when summary is missing", async () => {
		mockGetSummary.mockImplementation(async (hash: string) => {
			if (hash === "found") return makeSummary("found");
			return null;
		});
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "auth", hashes: ["found", "missing"] });
		expect(result.results).toHaveLength(1);
		expect(result.failedHashes).toEqual(["missing"]);
	});

	it("includes filesAffected in matches when query touches a file path", async () => {
		mockGetSummary.mockResolvedValueOnce(
			makeSummary("zzz", {
				ticketId: "TKT-1",
				topics: [
					{
						title: "Auth",
						trigger: "T",
						response: "R",
						decisions: "D",
						filesAffected: ["src/middleware/auth.ts"],
					},
				],
			}),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "middleware", hashes: ["zzz"] });
		const fileMatch = result.results[0].matches.find((m) => m.field === "filesAffected");
		expect(fileMatch).toBeDefined();
		expect(fileMatch?.snippet).toMatch(/\*\*middleware\*\*/);
	});

	it("emits matches with bold highlighting", async () => {
		mockGetSummary.mockResolvedValue(
			makeSummary("xxx", {
				topics: [
					{
						title: "Auth flow",
						trigger: "user wanted auth",
						response: "added auth middleware",
						decisions: "JWT preferred over auth Session",
						filesAffected: ["src/auth.ts"],
					},
				],
				recap: "Recap mentions auth",
			}),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "auth", hashes: ["xxx"] });
		expect(result.results[0].matches.length).toBeGreaterThan(0);
		for (const m of result.results[0].matches) {
			expect(m.snippet).toMatch(/\*\*auth\*\*/i);
		}
	});

	it("dedups & does not throw when topic fields are absent", async () => {
		mockGetSummary.mockResolvedValue(
			makeSummary("yyy", {
				topics: [
					{
						title: "ttt",
						trigger: "",
						response: "",
						decisions: "",
					},
				],
				recap: undefined,
			}),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "anything", hashes: ["yyy"] });
		expect(result.results[0].matches.every((m) => typeof m.snippet === "string")).toBe(true);
	});
});
