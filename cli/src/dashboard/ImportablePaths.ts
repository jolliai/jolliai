/**
 * ImportablePaths — which orphan-branch paths the SoT import will actually take.
 *
 * One rule, in one place, because two places used to disagree about it and the
 * disagreement was silent and permanent:
 *
 * - `importRepoMemory` filters every family listing before reading it (`.json`
 *   for summaries / transcripts / plan-progress, `.md` for the four context
 *   families, and `isTopicPagePath` for topic pages).
 * - the cutover's step-3 compare walked the SAME prefixes with NO filter, and
 *   required every path it found to read back from the database.
 *
 * Anything in the difference is a file the import is designed never to store,
 * so the database can never answer for it — `missing from the database`, on
 * every attempt, forever, with the reason only reaching `debug.log`. Measured
 * examples: an editor's stray `notes/foo.txt`, a `summaries/x.json.bak`.
 *
 * The compare's criterion is therefore "every path the import WOULD take reads
 * back", not "every file on the branch reads back". That is not a weaker
 * guarantee: a file the import never reads is one the database was never meant
 * to hold, so demanding it is asking the wrong question. What must not be lost —
 * everything the import does take — is unchanged.
 *
 * `topics/index.json` and `topics/processed.json` are deliberately NOT importable
 * paths: they are synthesized union views, compared by containment further up.
 *
 * A TRUE leaf — it imports nothing. That is load-bearing rather than tidy:
 * `isTopicPagePath` lived in `TopicPageStore` first, and importing it from there
 * broke five suites at module-init time. `TopicPageStore` is `vi.mock`ed all
 * over the suite (it reaches `SummaryStore` and the orphan branch), so a mocked
 * module handed this one `undefined` where a predicate belonged. The rule is a
 * pure string test with no storage in it; `TopicPageStore` now imports it from
 * here instead.
 */

/** Reserved file names under `topics/` that are NOT topic pages. */
const RESERVED_TOPIC_NAMES = new Set(["index", "processed"]);

/**
 * Is `path` a canonical topic page — one of the files `listTopicPageSlugs`
 * yields, and therefore one the import will actually take?
 *
 * Nested paths and the two reserved names answer false. Those are not dropped
 * on the floor: the union views are compared separately, by containment.
 */
export function isTopicPagePath(path: string): boolean {
	if (!path.startsWith("topics/") || !path.endsWith(".json")) return false;
	const slug = path.slice("topics/".length, -".json".length);
	return slug.length > 0 && !slug.includes("/") && !RESERVED_TOPIC_NAMES.has(slug);
}

/**
 * Every family prefix the orphan tree can carry, with the predicate the import
 * applies to it. A family missing from this list is not "unchecked", it is
 * INVISIBLE to the compare — containment only ever visits paths this produces.
 *
 * `as const` is load-bearing: it is what makes {@link ImportFamily} a union of
 * these eight literals, and therefore what makes a mistyped prefix at a call
 * site a COMPILE error. Most callers do not iterate {@link IMPORT_FAMILIES} —
 * `importRepoMemory` names its family inline, once per family — so without the
 * literal type a typo would silently answer "the import takes nothing here" and
 * drop a whole family with no error anywhere.
 */
const FAMILY_PREDICATES = [
	["summaries/", (p: string) => p.endsWith(".json")],
	["transcripts/", (p: string) => p.endsWith(".json")],
	["plans/", (p: string) => p.endsWith(".md")],
	["notes/", (p: string) => p.endsWith(".md")],
	["references/", (p: string) => p.endsWith(".md")],
	["skills/", (p: string) => p.endsWith(".md")],
	["plan-progress/", (p: string) => p.endsWith(".json")],
	["topics/", isTopicPagePath],
] as const satisfies ReadonlyArray<readonly [prefix: string, takes: (path: string) => boolean]>;

/** One of the eight family prefixes — the only thing `importTakesPath` accepts. */
export type ImportFamily = (typeof FAMILY_PREDICATES)[number][0];

/** The family prefixes, in compare order. */
export const IMPORT_FAMILIES: ReadonlyArray<ImportFamily> = FAMILY_PREDICATES.map(([prefix]) => prefix);

/**
 * Derived from the list above, never written twice: a second literal here is the
 * exact drift this module exists to remove.
 */
const PREDICATE_BY_FAMILY = Object.fromEntries(FAMILY_PREDICATES) as Record<ImportFamily, (path: string) => boolean>;

/**
 * Would the import take `path` from the family listed under `prefix`?
 *
 * Total on {@link ImportFamily}, so there is no "unknown prefix" branch to get
 * wrong — an unknown prefix cannot be spelled.
 *
 * `topics/` answers false for the two union views and for nested paths, which is
 * exactly what `listTopicPageSlugs` does — those are handled separately, not
 * dropped.
 */
export function importTakesPath(prefix: ImportFamily, path: string): boolean {
	return PREDICATE_BY_FAMILY[prefix](path);
}
