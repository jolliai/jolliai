/**
 * The bucket key behind the Memory Top Search Terms card, spelled once.
 *
 * **Write-side only, and that is the point.** Two surfaces produce a search (the MCP
 * `search` tool and `jolli search`), both through `ProducerHooks`, which is the ONLY
 * caller: the key is computed once and STORED in `memory_lookups.query_key`. Every
 * reader groups on that column — `buildSearchTerms`' `GROUP BY query_key`, and
 * `clusterSearchTerms` downstream of it — and none of them normalises anything.
 *
 * ⚠ So a read path that calls this is the shape to be suspicious of, not the one to
 * add. A reader deriving the key itself would be a second normaliser over stored
 * data, and the two would drift silently the first time this function changed: the
 * card would list a bucket assembled under one rule while the reader looked for it
 * under another. (An earlier version of this note described exactly such a reader —
 * an `/api/search-term` reverse lookup — as an existing constraint. There is no such
 * route: the phrasings behind a term ride on the payload as `SearchTermRow.queries`,
 * which is what replaced an expansion that re-ran the search.)
 *
 * Written in TypeScript rather than as a generated column because SQLite has no
 * expression that folds runs of internal whitespace, and a migration must not derive
 * business data.
 *
 * Deliberately conservative: case and whitespace only. Stemming, stop-word removal
 * and punctuation stripping would each merge queries a reader typed differently on
 * purpose, and the card's job is to show what they actually searched for.
 */
export function normalizeLookupQuery(query: string): string {
	return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * One row of the Search Terms card: a label, and the raw queries behind it.
 *
 * `term` is EXTRACTED, not a query — several differently-worded searches about one
 * subject collapse onto it. That is what makes the card a ranking rather than a
 * list of recent searches: queries are composed by the agent from whatever the
 * reader asked, so the same subject is almost never phrased the same way twice
 * (measured over the first real receipts: every query distinct).
 */
export interface SearchTermCluster {
	readonly term: string;
	/** Total searches, not distinct queries — the figure the row prints. */
	readonly searches: number;
	/** Distinct phrasings, most recent first. */
	readonly queries: ReadonlyArray<string>;
	readonly lastAtMs: number;
}

/** One distinct query, as the card's aggregate query returns it. */
export interface QueryTally {
	readonly query: string;
	readonly queryKey: string;
	readonly searches: number;
	readonly lastAtMs: number;
}

/**
 * Words trimmed from a chosen label's EDGES, and nothing else.
 *
 * ⚠ This is a stop-word list, and the scoring above exists precisely so that one is
 * not needed — so its scope is the whole justification. It never touches GROUPING:
 * the clustering runs first, on the objective alone, and this only tidies the label
 * the winner produced. `the rate limiter` and `rate limiter` cover the same three
 * queries and the longer wins on characters explained, which is right for
 * `rate` vs `rate limiter` and merely clumsy here; trimming a leading article fixes
 * the clumsiness without letting a word list decide what groups with what.
 *
 * Consequences of it being incomplete are therefore bounded to presentation: a
 * language it does not cover gets a slightly wordy label, never a wrong grouping.
 * CJK needs no entries at all — its candidates are character n-grams with no
 * leading article to strip.
 *
 * Do NOT grow this into a filter over candidate phrases. That is the design this
 * replaced, and the reason is in `clusterSearchTerms`.
 */
const EDGE_FILLER = new Set([
	"a",
	"an",
	"the",
	"is",
	"are",
	"was",
	"were",
	"do",
	"did",
	"does",
	"how",
	"why",
	"what",
	"when",
	"where",
	"we",
	"i",
	"our",
	"my",
	"to",
	"of",
	"in",
	"on",
	"for",
	"and",
	"or",
]);

/** Strips filler from a label's ends, keeping at least one word. */
function trimLabel(phrase: string): string {
	const words = phrase.split(" ");
	while (words.length > 1 && EDGE_FILLER.has(words[0])) words.shift();
	while (words.length > 1 && EDGE_FILLER.has(words[words.length - 1])) words.pop();
	return words.join(" ");
}

/** Longest phrase, in tokens, a term may be. Past this a label stops being scannable. */
const MAX_TERM_TOKENS = 5;
/** Shortest a candidate may be. Two characters is a real CJK word; one is a particle. */
const MIN_TERM_CHARS = 2;

/**
 * Runs of CJK script, which have no spaces to tokenize on. Mirrors the search
 * index's own `CJK_RUN` (see `core/SearchTokenizer.ts`) — the two answer different
 * questions and need not stay in lockstep, but they should not disagree about what
 * counts as CJK.
 */
const CJK_RUN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;

/**
 * Every phrase a query could be labelled by.
 *
 * Latin text yields contiguous WORD n-grams, so a label never starts or ends
 * mid-word. A CJK run has no word boundaries without a dictionary, so it yields
 * character n-grams instead — the same trade the search tokenizer makes, and for
 * the same reason: recall without a dependency.
 */
function candidatePhrases(query: string): Set<string> {
	const phrases = new Set<string>();
	for (const run of query.match(CJK_RUN) ?? []) {
		for (let start = 0; start < run.length; start++) {
			for (let size = MIN_TERM_CHARS; size <= MAX_TERM_TOKENS && start + size <= run.length; size++) {
				phrases.add(run.slice(start, start + size));
			}
		}
	}
	const words = query
		.replace(CJK_RUN, " ")
		.split(/[^\p{L}\p{N}_'-]+/u)
		.filter(Boolean);
	for (let start = 0; start < words.length; start++) {
		for (let size = 1; size <= MAX_TERM_TOKENS && start + size <= words.length; size++) {
			const phrase = words.slice(start, start + size).join(" ");
			if (phrase.length >= MIN_TERM_CHARS) phrases.add(phrase);
		}
	}
	return phrases;
}

/**
 * One phrase's coverage of the queries not yet claimed.
 *
 * Maintained by SUBTRACTION as rounds claim queries, never rebuilt — which is what
 * makes both counts monotonically DECREASING, and that in turn is what makes the
 * lazy heap below correct.
 */
interface PhraseCoverage {
	searches: number;
	queries: number;
}

/** A phrase, with the score it had when it entered the heap. */
interface ScoredPhrase {
	readonly phrase: string;
	/** `phrase.length * coverage.searches` at push time — an UPPER BOUND ever after. */
	readonly score: number;
}

/**
 * Max-heap order: characters explained, then the longer phrase, then the phrase
 * ITSELF.
 *
 * Ties break on the LONGER phrase because two labels explaining the same number of
 * characters differ only in specificity, and the specific one is the label.
 *
 * The third key is what makes the answer a function of the corpus alone. Two phrases
 * of equal length and equal coverage are equally good labels, so ANY rule picks a
 * defensible one — but the rule this replaced was iteration order over the SQL
 * result, and `buildSearchTerms` groups by `query_key` with no `ORDER BY`. A row
 * order that shifted between two 30 s polls would relabel a term the reader was
 * looking at, and every query the loser had claimed would move with it. Comparing
 * the text cannot do that.
 */
function outranks(a: ScoredPhrase, b: ScoredPhrase): boolean {
	if (a.score !== b.score) return a.score > b.score;
	if (a.phrase.length !== b.phrase.length) return a.phrase.length > b.phrase.length;
	return a.phrase < b.phrase;
}

function heapPush(heap: ScoredPhrase[], entry: ScoredPhrase): void {
	heap.push(entry);
	for (let i = heap.length - 1; i > 0; ) {
		const parent = (i - 1) >> 1;
		if (!outranks(heap[i], heap[parent])) break;
		[heap[i], heap[parent]] = [heap[parent], heap[i]];
		i = parent;
	}
}

function heapPop(heap: ScoredPhrase[]): ScoredPhrase | undefined {
	const top = heap[0];
	const last = heap.pop();
	if (last !== undefined && heap.length > 0) {
		heap[0] = last;
		for (let i = 0; ; ) {
			const left = 2 * i + 1;
			let best = i;
			if (left < heap.length && outranks(heap[left], heap[best])) best = left;
			if (left + 1 < heap.length && outranks(heap[left + 1], heap[best])) best = left + 1;
			if (best === i) break;
			[heap[i], heap[best]] = [heap[best], heap[i]];
			i = best;
		}
	}
	return top;
}

/**
 * Groups distinct queries into ranked terms.
 *
 * **The objective is CHARACTERS EXPLAINED — phrase length × searches covered — and
 * that choice is what removes the need for a stop-word list.** Scoring by coverage
 * alone lets `the` beat `rate limiter` whenever it appears in one more query, so a
 * coverage-ranked implementation needs a hand-kept list of words to ignore, per
 * language, forever. Weighting by length inverts that without a dictionary: `the`
 * across five searches explains 15 characters, `rate limiter` across three explains
 * 36, so the specific phrase wins on its own merits. It also behaves identically on
 * CJK, where a stop-word list would have to be built from scratch.
 *
 * Greedy and one-term-per-query: the best phrase claims its queries, and the search
 * repeats on what is left. A query sharing nothing with any other becomes its own
 * term, labelled by the whole query — so the term counts always sum to the total
 * searches, and the card never has an unexplained remainder.
 *
 * A phrase must cover at least TWO distinct queries to be a term. One query is not
 * evidence of a subject; labelling it with a fragment of itself would be inventing
 * a grouping that does not exist.
 *
 * ⚠ **Coverage is scored ONCE and then decremented; a round must never rebuild it.**
 * That is a complexity bound, not a micro-optimisation. `buildSearchTerms`
 * deliberately clusters over EVERY distinct query in the window rather than a top-N
 * (a withheld query is a phrasing the clustering cannot see), and a round claims as
 * few as two queries — so re-scoring every remaining query per round is Q²·P work
 * inside a builder `/api/model` re-runs every 30 s, about 5·10⁷ operations at 2,000
 * distinct queries. Subtracting instead makes the scoring linear in Q·P, and the
 * per-round "which phrase wins" becomes a heap pop.
 *
 * The heap is LAZY, which is sound only because coverage never grows: an entry's
 * stored score is therefore an upper bound on the phrase's current score for ever,
 * so a popped entry whose stored score still matches is the true maximum and a stale
 * one is simply re-seated. That is also why nothing is pushed on a decrement — the
 * entry already there still bounds it.
 */
export function clusterSearchTerms(tallies: ReadonlyArray<QueryTally>): ReadonlyArray<SearchTermCluster> {
	const remaining = [...tallies];
	const clusters: SearchTermCluster[] = [];

	/**
	 * One query's phrase set, built ONCE.
	 *
	 * ⚠ Still a memo, and still load-bearing: the initial scoring pass and every
	 * claim ask a query for its phrases, so deriving them on the spot would rebuild
	 * every n-gram of every claimed query a second time.
	 */
	const phrasesOf = new Map<string, Set<string>>();
	const phrasesFor = (queryKey: string): Set<string> => {
		const memo = phrasesOf.get(queryKey);
		if (memo) return memo;
		const phrases = candidatePhrases(queryKey);
		phrasesOf.set(queryKey, phrases);
		return phrases;
	};

	// Score every phrase any query could carry — the ONLY full pass over the corpus.
	const coverage = new Map<string, PhraseCoverage>();
	for (const tally of remaining) {
		for (const phrase of phrasesFor(tally.queryKey)) {
			const seen = coverage.get(phrase);
			if (seen) {
				seen.searches += tally.searches;
				seen.queries += 1;
			} else {
				coverage.set(phrase, { searches: tally.searches, queries: 1 });
			}
		}
	}
	// A phrase covering one query can never cover two — counts only fall — so it is
	// dropped here rather than skipped on every round.
	const heap: ScoredPhrase[] = [];
	for (const [phrase, cover] of coverage) {
		if (cover.queries < 2) {
			coverage.delete(phrase);
			continue;
		}
		heapPush(heap, { phrase, score: phrase.length * cover.searches });
	}

	for (;;) {
		let best: string | undefined;
		for (;;) {
			const top = heapPop(heap);
			if (!top) break;
			const cover = coverage.get(top.phrase);
			// Deleted above or emptied by a claim: it is out of the running for good.
			if (!cover) continue;
			const score = top.phrase.length * cover.searches;
			if (score === top.score) {
				best = top.phrase;
				break;
			}
			// A claim moved it since it was pushed. Re-seat it at its real score; the
			// bound held, so nothing above it was missed.
			heapPush(heap, { ...top, score });
		}
		if (best === undefined) break;

		const claimed: QueryTally[] = [];
		for (let i = remaining.length - 1; i >= 0; i--) {
			if (phrasesFor(remaining[i].queryKey).has(best)) claimed.unshift(...remaining.splice(i, 1));
		}
		// Take the claimed queries back out of every phrase they were counted in,
		// including the winner's own — which is what empties it.
		for (const tally of claimed) {
			for (const phrase of phrasesFor(tally.queryKey)) {
				const cover = coverage.get(phrase);
				if (!cover) continue;
				cover.searches -= tally.searches;
				cover.queries -= 1;
				if (cover.queries < 2) coverage.delete(phrase);
			}
		}
		clusters.push(clusterOf(trimLabel(best), claimed));
	}

	// Whatever shares nothing stands alone, labelled by its own most recent spelling.
	for (const tally of remaining) clusters.push(clusterOf(tally.query, [tally]));

	return clusters.sort((a, b) => b.searches - a.searches || b.lastAtMs - a.lastAtMs);
}

function clusterOf(term: string, tallies: ReadonlyArray<QueryTally>): SearchTermCluster {
	const ordered = [...tallies].sort((a, b) => b.lastAtMs - a.lastAtMs);
	return {
		term,
		searches: ordered.reduce((sum, t) => sum + t.searches, 0),
		queries: ordered.map((t) => t.query),
		lastAtMs: ordered[0]?.lastAtMs ?? 0,
	};
}
