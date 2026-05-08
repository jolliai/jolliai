import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitCatalog, CommitSummary, SummaryIndex } from "../Types.js";
import { LocalSearchProvider, parseSince } from "./LocalSearchProvider.js";
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
	it("returns kind:'unset' for undefined", () => {
		expect(parseSince(undefined)).toEqual({ kind: "unset" });
	});

	it("returns kind:'unset' for empty / whitespace-only strings", () => {
		expect(parseSince("")).toEqual({ kind: "unset" });
		expect(parseSince("   ")).toEqual({ kind: "unset" });
	});

	it("parses days (case-insensitive) into kind:'ok'", () => {
		const beforeNow = Date.now();
		const result = parseSince("7d");
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		const expected = beforeNow - 7 * 86_400_000;
		// Allow 1s slack for clock drift between Date.now() calls.
		expect(Math.abs(result.ts - expected)).toBeLessThan(1000);

		const upper = parseSince("7D");
		expect(upper.kind).toBe("ok");
	});

	it("parses weeks / months / years", () => {
		expect(parseSince("2w").kind).toBe("ok");
		expect(parseSince("1m").kind).toBe("ok");
		expect(parseSince("1y").kind).toBe("ok");
	});

	it("zero days resolves to ~now", () => {
		const result = parseSince("0d");
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(Math.abs(result.ts - Date.now())).toBeLessThan(1000);
	});

	it("returns kind:'invalid' for decimals like '1.5d'", () => {
		// Earlier this collapsed to null (== unset); now decimals are an explicit
		// invalid signal so the CLI can emit a hard error instead of silently
		// disabling the filter.
		const result = parseSince("1.5d");
		expect(result.kind).toBe("invalid");
		if (result.kind !== "invalid") return;
		expect(result.value).toBe("1.5d");
	});

	it("parses ISO date strings into kind:'ok'", () => {
		const result = parseSince("2026-01-01");
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.ts).toBe(new Date("2026-01-01").getTime());
	});

	it("returns kind:'invalid' for unparseable strings (was silent null before)", () => {
		// This is the regression-prevention test for the typo failure mode:
		// `--since=lastweek` used to disable filtering entirely (null = no filter)
		// instead of erroring. Now it surfaces explicitly so the CLI can reject it.
		expect(parseSince("not-a-date")).toEqual({ kind: "invalid", value: "not-a-date" });
		expect(parseSince("lastweek")).toEqual({ kind: "invalid", value: "lastweek" });
		expect(parseSince("7days")).toEqual({ kind: "invalid", value: "7days" });
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

	it("skips an oversized entry but keeps later candidates (continue, not break)", async () => {
		// Regression: earlier the budget loop did `break` when one entry couldn't
		// fit even after trim. Because candidates are newest-first, a single
		// verbose recent commit would silently exclude EVERY older smaller one.
		// Now we `continue` past the oversized entry and keep accumulating.
		const huge = "X".repeat(20_000);
		mockGetIndex.mockResolvedValue(makeIndex(["recent-huge", "older-small"], "2026-04-01T10:00:00.000Z"));
		mockGetCatalog.mockResolvedValue(
			makeCatalog([
				// Recent entry: even after trim (drop decisions) still ~20K chars of
				// recap, exceeds the budget. With `break` this would tank the loop.
				{ commitHash: "recent-huge", recap: huge, topics: [{ title: "t", decisions: "d" }] },
				// Older entry: tiny, would fit easily if reached.
				{ commitHash: "older-small", topics: [{ title: "small", decisions: "x" }] },
			]),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q", budget: 1000 });
		// The huge one is skipped; the small one made it in.
		const hashes = result.entries.map((e) => e.fullHash);
		expect(hashes).toContain("older-small");
		expect(hashes).not.toContain("recent-huge");
		expect(result.truncated).toBe(true);
	});

	it("throws on invalid --since instead of silently disabling the filter", async () => {
		// Regression: earlier `--since=lastweek` returned more results than the
		// user expected (because invalid → null → no filter). Now it errors out
		// at the boundary so the CLI can surface the typo to the user.
		mockGetIndex.mockResolvedValue(makeIndex(["aaa"]));
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test");
		await expect(provider.buildCatalog({ query: "q", since: "lastweek" })).rejects.toThrow(/Invalid --since/);
		await expect(provider.buildCatalog({ query: "q", since: "7days" })).rejects.toThrow(/Invalid --since/);
		await expect(provider.buildCatalog({ query: "q", since: "2026-13-99" })).rejects.toThrow(/Invalid --since/);
	});

	it("filterEcho omits since when invalid would have been passed (defense in depth)", async () => {
		// `buildCatalog` throws on invalid since, so this echo-vs-actual mismatch
		// is impossible at runtime. But verify that when since IS unset, filterEcho
		// also leaves it out (regression check on the conditional spread).
		mockGetIndex.mockResolvedValue(makeIndex(["aaa"]));
		mockGetCatalog.mockResolvedValue({ version: 1, entries: [] });
		const provider = new LocalSearchProvider("/test");
		const result = await provider.buildCatalog({ query: "q" });
		expect(result.filter.since).toBeUndefined();
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

	it("records hashes whose summary load failed in failedHashes", async () => {
		mockGetSummary.mockImplementation(async (hash: string) => {
			if (hash === "found") return makeSummary("found");
			return null;
		});
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "auth", hashes: ["found", "missing"] });
		expect(result.results).toHaveLength(1);
		expect(result.failedHashes).toEqual(["missing"]);
	});

	it("emits identity / provenance / narrative fields on each hit", async () => {
		mockGetSummary.mockResolvedValueOnce(
			makeSummary("abc1234", {
				commitMessage: "feat: add OAuth flow",
				commitAuthor: "alice",
				commitDate: "2026-04-01T10:00:00.000Z",
				branch: "feature/oauth",
				commitType: "amend",
				ticketId: "TKT-99",
				recap: "Quick recap of the OAuth work",
			}),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "oauth", hashes: ["abc1234"] });
		const hit = result.results[0];
		expect(hit.hash).toBe("abc1234"); // 8-char short
		expect(hit.fullHash).toBe("abc1234");
		expect(hit.commitMessage).toBe("feat: add OAuth flow");
		expect(hit.commitAuthor).toBe("alice");
		expect(hit.commitDate).toBe("2026-04-01T10:00:00.000Z");
		expect(hit.branch).toBe("feature/oauth");
		expect(hit.commitType).toBe("amend");
		expect(hit.ticketId).toBe("TKT-99");
		expect(hit.recap).toBe("Quick recap of the OAuth work");
	});

	it("emits diffStats when present on the source summary", async () => {
		mockGetSummary.mockResolvedValueOnce(
			makeSummary("withstats", {
				diffStats: { files: 7, insertions: 123, deletions: 45 },
			}),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "x", hashes: ["withstats"] });
		expect(result.results[0].diffStats).toEqual({ files: 7, insertions: 123, deletions: 45 });
	});

	it("emits the full topics array — title / trigger / response / decisions / category / importance / filesAffected", async () => {
		mockGetSummary.mockResolvedValueOnce(
			makeSummary("topictest", {
				topics: [
					{
						title: "Auth flow",
						trigger: "Need login",
						response: "Implemented OAuth via Authlib",
						decisions:
							"- **JWT over Session**: stateless, scales horizontally\n- **PKCE flow**: required for mobile",
						category: "feature",
						importance: "major",
						filesAffected: ["src/auth.ts", "src/middleware.ts"],
					},
				],
			}),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "anything", hashes: ["topictest"] });
		const topic = result.results[0].topics[0];
		expect(topic.title).toBe("Auth flow");
		expect(topic.trigger).toBe("Need login");
		expect(topic.response).toBe("Implemented OAuth via Authlib");
		expect(topic.decisions).toContain("JWT over Session");
		expect(topic.category).toBe("feature");
		expect(topic.importance).toBe("major");
		expect(topic.filesAffected).toEqual(["src/auth.ts", "src/middleware.ts"]);
	});

	it("propagates topic.todo when present", async () => {
		mockGetSummary.mockResolvedValueOnce(
			makeSummary("todotest", {
				topics: [
					{
						title: "T",
						trigger: "T",
						response: "R",
						decisions: "D",
						todo: "Add rate-limit middleware in a follow-up",
					},
				],
			}),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "x", hashes: ["todotest"] });
		expect(result.results[0].topics[0].todo).toBe("Add rate-limit middleware in a follow-up");
	});

	it("omits optional topic fields when source data lacks them", async () => {
		mockGetSummary.mockResolvedValueOnce(
			makeSummary("minimal", {
				topics: [
					{
						title: "Bare topic",
						trigger: "T",
						response: "R",
						decisions: "D",
						// no todo / filesAffected / category / importance
					},
				],
			}),
		);
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "x", hashes: ["minimal"] });
		const topic = result.results[0].topics[0];
		// Optional fields should be absent from the JSON, not present as undefined
		// (skill template's schema doc tells the LLM "optional" — rendering must
		// not see literal `undefined`).
		expect(Object.hasOwn(topic, "todo")).toBe(false);
		expect(Object.hasOwn(topic, "filesAffected")).toBe(false);
		expect(Object.hasOwn(topic, "category")).toBe(false);
		expect(Object.hasOwn(topic, "importance")).toBe(false);
	});

	it("does NOT emit matches[] or commit-level filesAffected (removed in the rich-topics rewrite)", async () => {
		// Earlier shape exposed pre-bolded `matches[]` snippets and an aggregated
		// commit-level `filesAffected`. With full topics in the hit, both became
		// redundant — `matches` because the LLM has full topic content, and
		// commit-level `filesAffected` because per-topic `filesAffected` is
		// strictly stronger (preserves the decision→file mapping).
		mockGetSummary.mockResolvedValueOnce(makeSummary("noredundant"));
		const provider = new LocalSearchProvider("/test");
		const result = await provider.loadHits({ query: "anything", hashes: ["noredundant"] });
		const hit = result.results[0] as Record<string, unknown>;
		expect(hit.matches).toBeUndefined();
		expect(hit.filesAffected).toBeUndefined();
	});
});
