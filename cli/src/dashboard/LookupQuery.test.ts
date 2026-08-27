import { describe, expect, it } from "vitest";
import {
	clampLookupQuery,
	clusterSearchTerms,
	LOOKUP_QUERY_MAX,
	normalizeLookupQuery,
	type QueryTally,
} from "./LookupQuery.js";

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

describe("clampLookupQuery", () => {
	it("leaves any query a person or an agent would actually compose alone", () => {
		expect(clampLookupQuery("how did we handle rate limiter bursts")).toBe("how did we handle rate limiter bursts");
	});

	it("bounds a pasted blob, because nothing else does", () => {
		// The bound is not about storage. This table rides the session-push channel,
		// which is all-or-nothing, and the client neither silences a 400 nor steps
		// past it — so ONE row the server refuses makes that machine retry the same
		// unsendable batch for ever, on every table. An agent pasting a stack trace
		// into `search` is the realistic way to produce one.
		const clamped = clampLookupQuery("x".repeat(LOOKUP_QUERY_MAX + 500));

		expect(clamped).toHaveLength(LOOKUP_QUERY_MAX);
	});

	it("drops a surrogate pair whole rather than splitting it at the boundary", () => {
		// A UTF-16 slice can land between the two units of one emoji. The orphan is not
		// a wire fault — it travels as the ASCII escape `\ud83d` and parses fine — but it
		// is a mangled character in the text the card prints, so the trim takes both
		// units and comes back one shorter than the bound.
		const clamped = clampLookupQuery(`${"x".repeat(LOOKUP_QUERY_MAX - 1)}\u{1F600} bursts`);

		expect(clamped).toHaveLength(LOOKUP_QUERY_MAX - 1);
		expect(clamped.endsWith("x")).toBe(true);
	});

	it("stays far below the server's own ceiling, so the two can never meet", () => {
		// The server refuses at 20 000. Keeping the producer an order of magnitude
		// under that is what makes the refusal unreachable rather than merely rare.
		expect(LOOKUP_QUERY_MAX).toBeLessThan(20_000);
	});

	it("keys the bucket off the CLAMPED text, so the two cannot describe different strings", () => {
		// `ProducerHooks` clamps before both the stored query and its key. Deriving
		// the key from the unclamped text would make the card group by a string it
		// never shows.
		const long = `${"Rate  Limiter ".repeat(400)}`;

		expect(normalizeLookupQuery(clampLookupQuery(long))).toBe(normalizeLookupQuery(clampLookupQuery(long)));
		expect(normalizeLookupQuery(clampLookupQuery(long)).length).toBeLessThanOrEqual(LOOKUP_QUERY_MAX);
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

	it("names a subject spelled singular and plural, rather than the filler around it", () => {
		// The card shipped a row labelled `to`. Without the singular fold `desicions`
		// and `desicion` are unrelated tokens, so these two questions share no content
		// word at all; the best phrase left was `how to`, and trimming the article off
		// it left one filler word standing as the label.
		const rows = clusterSearchTerms([tally("How to get desicions"), tally("how to make desicion")]);

		expect(rows).toHaveLength(1);
		expect(rows[0].term).toBe("desicion");
		expect(rows[0].queries).toHaveLength(2);
	});

	it("refuses a term whose phrase is filler all the way through", () => {
		// `is the` covers both and explains more characters than `is` or `the` alone,
		// so nothing in the scoring can reject it — the words themselves have to. Two
		// questions sharing only function words are not one subject, and standing
		// alone with their own text is the honest answer.
		const rows = clusterSearchTerms([tally("where is the cache"), tally("what is the queue depth")]);

		expect([...rows.map((row) => row.term)].sort()).toEqual(["what is the queue depth", "where is the cache"]);
	});

	it("folds the two spellings onto the SAME string, not merely a shorter plural", () => {
		// The fold's whole mechanism: `query` reaches `singularize` unchanged, so a
		// plural rule that produced anything but `query` would leave the pair in two
		// groups — the failure it exists to remove, wearing the shape of a feature.
		// `-ies` fell through to the bare `-s` arm as `querie` and met nothing, and
		// `-ses` was taken as `-s` plus `es`, so `cases` became a `cas` that the `case`
		// beside it never matched.
		for (const [singular, plural] of [
			["query", "queries"],
			["entries", "entry"],
			["repositories", "repository"],
			["case", "cases"],
			["releases", "release"],
			["responses", "response"],
		]) {
			const rows = clusterSearchTerms([tally(`${singular} alpha`), tally(`${plural} beta`)]);

			expect(rows, `${singular} / ${plural}`).toHaveLength(1);
			expect(rows[0].queries, `${singular} / ${plural}`).toHaveLength(2);
		}
	});

	it("folds plurals only — a word family is several subjects, not one", () => {
		// The bound on the fold, from both sides: a real stemmer would merge `limiter`
		// with `limiting`, and would cut `status` down to a `statu` no reader typed.
		const rows = clusterSearchTerms([
			tally("rate limiter alpha"),
			tally("rate limiter beta"),
			tally("rate limiting gamma"),
			tally("migration status one"),
			tally("migration status two"),
		]);

		const terms = rows.map((row) => row.term);
		expect(terms).toContain("rate limiter");
		expect(terms).toContain("migration status");
		expect(terms).toContain("rate limiting gamma");
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
