import { describe, expect, it } from "vitest";
import { clusterSearchTerms, normalizeLookupQuery, type QueryTally } from "./LookupQuery.js";

const tally = (query: string, searches = 1, lastAtMs = 0): QueryTally => ({
	query,
	queryKey: normalizeLookupQuery(query),
	searches,
	lastAtMs,
});

describe("normalizeLookupQuery", () => {
	it("folds case and whitespace and nothing else", () => {
		expect(normalizeLookupQuery("  Rate   Limiter ")).toBe("rate limiter");
		// Deliberately conservative: stemming or punctuation-stripping would merge
		// queries a reader typed differently on purpose.
		expect(normalizeLookupQuery("retry-after")).toBe("retry-after");
	});
});

describe("clusterSearchTerms", () => {
	it("labels a group by the phrase its queries share", () => {
		const rows = clusterSearchTerms([
			tally("how did we handle rate limiter bursts"),
			tally("why is the rate limiter per org"),
			tally("rate limiter retry-after"),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0].term).toBe("rate limiter");
		expect(rows[0].searches).toBe(3);
	});

	it("prefers the specific phrase over the common word, with no stop-word list", () => {
		// THE reason the objective is characters-explained rather than coverage. `the`
		// appears in four of these and `rate limiter` in three, so a coverage ranking
		// labels the group `the` — and fixing that by hand means a stop-word list per
		// language, forever. Length × coverage inverts it on arithmetic alone.
		const rows = clusterSearchTerms([
			tally("the rate limiter bursts"),
			tally("why is the rate limiter per org"),
			tally("the rate limiter retry"),
			tally("where is the cache"),
			tally("what is the queue depth"),
		]);
		expect(rows[0].term).toBe("rate limiter");
	});

	it("counts SEARCHES, not distinct phrasings", () => {
		const rows = clusterSearchTerms([tally("rate limiter bursts", 7), tally("rate limiter per org", 4)]);
		expect(rows[0].searches).toBe(11);
		expect(rows[0].queries).toHaveLength(2);
	});

	it("leaves a query that shares nothing as its own term, labelled by itself", () => {
		const rows = clusterSearchTerms([
			tally("rate limiter bursts"),
			tally("rate limiter per org"),
			tally("unrelated deployment question"),
		]);
		// Every search is accounted for: the terms sum to the total. The mockup's own
		// fixture leaves a remainder (54 of 61) and never says where it went; a card
		// whose rows do not add up cannot be read.
		expect(rows.reduce((sum, row) => sum + row.searches, 0)).toBe(3);
		expect(rows.map((r) => r.term)).toContain("unrelated deployment question");
	});

	it("needs two distinct queries before it will invent a label", () => {
		// One query is not evidence of a subject. Labelling it with a fragment of
		// itself would assert a grouping that does not exist.
		const rows = clusterSearchTerms([tally("rate limiter bursts", 9)]);
		expect(rows).toEqual([
			{ term: "rate limiter bursts", searches: 9, queries: ["rate limiter bursts"], lastAtMs: 0 },
		]);
	});

	it("ranks by searches, then by recency", () => {
		const rows = clusterSearchTerms([
			tally("auth guard middleware", 2, 100),
			tally("auth guard extraction", 1, 200),
			tally("cache warmup timing", 3, 50),
			tally("cache warmup order", 2, 60),
		]);
		expect(rows.map((r) => [r.term, r.searches])).toEqual([
			["cache warmup", 5],
			["auth guard", 3],
		]);
	});

	it("orders the phrasings behind a term most recent first", () => {
		const rows = clusterSearchTerms([tally("rate limiter older", 1, 10), tally("rate limiter newer", 1, 99)]);
		expect(rows[0].queries).toEqual(["rate limiter newer", "rate limiter older"]);
	});

	it("clusters CJK, where there are no spaces to tokenize on", () => {
		// Character n-grams rather than words — the same trade the search tokenizer
		// makes, and the reason the objective must not depend on a stop-word list:
		// there is no Chinese one to reach for.
		const rows = clusterSearchTerms([
			tally("限流器怎么处理突发"),
			tally("为什么限流器是按组织的"),
			tally("限流器重试策略"),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0].term).toContain("限流器");
		expect(rows[0].searches).toBe(3);
	});

	it("never lets a label start or end mid-word in Latin text", () => {
		const rows = clusterSearchTerms([tally("rate limiter alpha"), tally("rate limiter beta")]);
		expect(rows[0].term).toBe("rate limiter");
		expect(rows[0].term).not.toMatch(/^\s|\s$/);
	});

	it("answers an empty window with no rows", () => {
		expect(clusterSearchTerms([])).toEqual([]);
	});

	it("breaks an exact tie on the phrase itself, so row order cannot relabel a term", () => {
		// `queue` and `guard` are the same length and cover the same two queries, so
		// they explain the same characters and either is a defensible label. What is
		// NOT defensible is picking by iteration order: `buildSearchTerms` groups with
		// no ORDER BY, so a row order that shifted between two 30 s polls would rename
		// the term under the reader. Same answer whichever way the corpus arrives.
		const forward = clusterSearchTerms([tally("queue x guard"), tally("guard y queue")]);
		const reversed = clusterSearchTerms([tally("guard y queue"), tally("queue x guard")]);
		expect(forward[0].term).toBe("guard");
		expect(reversed[0].term).toBe("guard");
	});

	/* The shape the incremental scoring exists for: a window with many distinct
	   queries, each sharing a phrase with exactly ONE other, so every round claims the
	   minimum two and the greedy loop runs as many times as it can. Re-scoring the
	   whole corpus per round is Q²·P work here; the assertions below are about the
	   ANSWER, which subtracting must not change. */
	it("clusters a large window into pairs, with every search still accounted for", () => {
		const PAIRS = 400;
		const tallies: QueryTally[] = [];
		for (let i = 0; i < PAIRS; i++) {
			// Nothing is shared BETWEEN pairs: a word common to all 800 would be one
			// phrase covering the whole corpus, and the greedy loop would finish in a
			// single round — the opposite of what this case is for.
			tallies.push(tally(`subject${i} alpha${i}`, 1, i * 2));
			tallies.push(tally(`subject${i} beta${i}`, 1, i * 2 + 1));
		}
		const rows = clusterSearchTerms(tallies);
		expect(rows).toHaveLength(PAIRS);
		// Each pair collapses onto the one phrase its two members share.
		expect(rows.every((row) => row.searches === 2 && row.queries.length === 2)).toBe(true);
		expect(rows.reduce((sum, row) => sum + row.searches, 0)).toBe(tallies.length);
		expect(new Set(rows.map((row) => row.term)).size).toBe(PAIRS);
	});
});
