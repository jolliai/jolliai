/**
 * GraphSchema — types, validation, and assembly for the knowledge-graph layer.
 *
 * Self-contained graph feature module (see cli/src/graph/). This is the in-TS
 * port of the standalone prototype's `merge-graph.mjs`: it validates the
 * LLM-distilled layer (categories + topics + units + edges) for referential
 * integrity, joins per-topic source metadata, computes rollup stats, and emits
 * the final `KnowledgeGraph` the viz runtime (`assets/js/data.js`) consumes via
 * `window.__EMBEDDED_GRAPH__`.
 *
 * No fs, no LLM, no storage — pure data shaping. Callers wire I/O.
 */

/** The five typed relationships between knowledge units. */
export const EDGE_TYPES = ["extends", "caused-by", "supersedes", "contradicts", "related-to"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** The kinds a knowledge unit can take. */
export const UNIT_KINDS = ["decision", "mechanism", "fix"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/**
 * Schema version stamped onto the emitted graph; bump on a breaking shape change.
 *
 * Because `units` / `edges` / `categories` / `topics` are embedded in graph.json
 * verbatim, ANY change to their output SHAPE (a new field, a changed `kind` /
 * edge-type enum, a changed unit-id format) IS a breaking shape change here and
 * MUST bump this constant. Incremental update (GraphBuilder) reuses the prior
 * graph.json as its baseline only when the stored `schemaVersion` matches this
 * value. Bumping is the PRIMARY (and only complete) guard against reusing a
 * structurally-incompatible baseline — in particular it is the ONLY thing that
 * catches a NEWLY-ADDED field (see `toDistilled`: a field-set check cannot detect
 * a field it doesn't yet know about). `toDistilled`'s check is a secondary net
 * for removed/retyped fields and corruption, not a substitute for this bump.
 * Bumped 1→2 when incremental dirty detection added `topicFingerprints` AND
 * `topicMetaFingerprints` to `KnowledgeGraph`. Both top-level fields landed
 * together in the same (unreleased) v2, so adding the second one did not need a
 * further bump. Consumers (webview / export) read only
 * `categories`/`topics`/`units`/`edges`, so these baseline-only fields are inert
 * to them. A FUTURE change to either field's shape, or any new top-level field,
 * is a breaking shape change and must bump this constant again.
 */
export const GRAPH_SCHEMA_VERSION = 2;

/** Category id for topics not grouped into any real category. Shared by the full
 * distiller (backfill) and the incremental merge so both bucket the same way. */
export const UNCATEGORIZED_CATEGORY_ID = "uncategorized";

// -- LLM-distilled layer (what GraphDistiller emits) --------------------------

/** A top-level grouping of topics. */
export interface DistilledCategory {
	readonly id: string;
	readonly shortTitle: string;
	readonly summary: string;
}

/** A wiki topic, assigned to a category, with an LLM-written short title + summary. */
export interface DistilledTopic {
	readonly slug: string;
	readonly shortTitle: string;
	readonly summary: string;
	readonly title: string;
	readonly categoryId: string;
}

/** Anchors that ground a unit in the codebase / history. */
export interface UnitAnchors {
	readonly files: string[];
	readonly commits: string[];
}

/** A single distilled knowledge unit (one decision / mechanism / fix). */
export interface DistilledUnit {
	readonly id: string;
	readonly topicSlug: string;
	readonly kind: UnitKind;
	readonly shortTitle: string;
	readonly summary: string;
	readonly anchors: UnitAnchors;
}

/** A typed, unit-to-unit relationship with confidence + evidence. */
export interface GraphEdge {
	readonly from: string;
	readonly to: string;
	readonly type: EdgeType;
	readonly confidence: number;
	readonly evidence: string;
}

/** The raw LLM output: the distilled graph before source-metadata joins / stats. */
export interface DistilledGraph {
	readonly categories: DistilledCategory[];
	readonly topics: DistilledTopic[];
	readonly units: DistilledUnit[];
	readonly edges: GraphEdge[];
}

// -- Per-topic source metadata (joined in from TopicPage objects) -------------

export interface SourceCommitRef {
	readonly hash: string;
	readonly message: string;
}

/** Source metadata for one topic, supplied by the caller from its TopicPage. */
export interface TopicSourceMeta {
	readonly sourceBranches: string[];
	readonly sourceCommits: SourceCommitRef[];
	readonly overview: string;
	/** Verbatim topic page body, rendered in the viz reader drawer. */
	readonly fullBody: string;
}

// -- Final merged graph (what the viz consumes) -------------------------------

export interface GraphCategory extends DistilledCategory {
	topicCount: number;
	unitCount: number;
	commitCount: number;
}

export interface GraphTopic extends DistilledTopic {
	readonly sourceBranches: string[];
	readonly sourceCommits: SourceCommitRef[];
	readonly overview: string;
	readonly fullBody: string;
	readonly wikiFile: string;
	unitCount: number;
	commitCount: number;
}

export interface GraphStats {
	readonly categories: number;
	readonly topics: number;
	readonly units: number;
	readonly edges: number;
	readonly intraTopicEdges: number;
	readonly crossTopicEdges: number;
	readonly crossCategoryEdges: number;
}

export interface KnowledgeGraph {
	readonly schemaVersion: number;
	readonly generatedAt: string;
	readonly source: string;
	/**
	 * Per-topic content fingerprint, keyed by `stableSlug`. The incremental
	 * baseline: GraphBuilder diffs the previous graph.json's fingerprints against
	 * the freshly-computed ones to find dirty/new/deleted topics. Empty `{}` on a
	 * full build that had no fingerprint input (e.g. legacy callers / tests).
	 */
	readonly topicFingerprints: Record<string, string>;
	/**
	 * Per-topic fingerprint of the JOIN metadata that the content fingerprint
	 * deliberately excludes — `sourceBranches` + `sourceCommits` (→ `commitCount`).
	 * Keyed by `stableSlug`. These fields live in graph.json but are NOT LLM inputs,
	 * so they can drift while `topicFingerprints` stays put (a new commit folded into
	 * a topic whose summary regenerated identically, a branch rename). GraphBuilder
	 * compares this on a content-no-op to decide between a true skip and a NO-LLM
	 * reassemble that refreshes the stale metadata. Empty `{}` when unavailable.
	 */
	readonly topicMetaFingerprints: Record<string, string>;
	readonly stats: GraphStats;
	readonly categories: GraphCategory[];
	readonly topics: GraphTopic[];
	readonly units: DistilledUnit[];
	readonly edges: GraphEdge[];
}

// -- Validation ---------------------------------------------------------------

/**
 * Referential-integrity check over a distilled graph, mirroring the prototype's
 * `merge-graph.mjs`: unknown categoryId / topicSlug, dangling edge endpoints,
 * duplicate unit ids, and duplicate edges. Returns a (possibly empty) list of
 * human-readable error strings — never throws. A non-empty result means the
 * graph must not ship.
 */
export function validateDistilledGraph(graph: DistilledGraph): string[] {
	const errors: string[] = [];

	const categoryIds = new Set(graph.categories.map((c) => c.id));
	const topicSlugs = new Set(graph.topics.map((t) => t.slug));

	for (const t of graph.topics) {
		if (!categoryIds.has(t.categoryId)) errors.push(`topic ${t.slug}: unknown categoryId ${t.categoryId}`);
	}

	const unitIds = new Set<string>();
	for (const u of graph.units) {
		if (unitIds.has(u.id)) errors.push(`duplicate unit id ${u.id}`);
		unitIds.add(u.id);
		if (!topicSlugs.has(u.topicSlug)) errors.push(`unit ${u.id}: unknown topicSlug ${u.topicSlug}`);
		if (!UNIT_KINDS.includes(u.kind)) errors.push(`unit ${u.id}: invalid kind ${u.kind}`);
	}

	const edgePairSeen = new Set<string>();
	for (const e of graph.edges) {
		if (!unitIds.has(e.from)) errors.push(`edge from unknown unit ${e.from}`);
		if (!unitIds.has(e.to)) errors.push(`edge to unknown unit ${e.to}`);
		if (!EDGE_TYPES.includes(e.type)) errors.push(`edge ${e.from}->${e.to}: invalid type ${e.type}`);
		const key = `${e.from}|${e.to}|${e.type}`;
		if (edgePairSeen.has(key)) errors.push(`duplicate edge ${key}`);
		edgePairSeen.add(key);
	}

	return errors;
}

// -- Assembly -----------------------------------------------------------------

/**
 * Joins the distilled graph with per-topic source metadata, computes rollup
 * stats, and returns the final `KnowledgeGraph`. Throws if the distilled graph
 * fails {@link validateDistilledGraph} — a broken graph must not ship (the
 * caller runs this non-fatally, so a throw degrades to "no graph this run"
 * rather than failing the compile).
 *
 * Topics absent from `sources` get empty source metadata (still rendered).
 */
export function assembleGraph(
	distill: DistilledGraph,
	sources: ReadonlyMap<string, TopicSourceMeta>,
	generatedAt: string,
	topicFingerprints: Record<string, string> = {},
	topicMetaFingerprints: Record<string, string> = {},
): KnowledgeGraph {
	const errors = validateDistilledGraph(distill);
	if (errors.length > 0) {
		throw new Error(`knowledge graph validation failed (${errors.length}): ${errors.join("; ")}`);
	}

	const topics: GraphTopic[] = distill.topics.map((t) => {
		const src = sources.get(t.slug);
		return {
			...t,
			sourceBranches: src ? src.sourceBranches : [],
			sourceCommits: src ? src.sourceCommits : [],
			overview: src ? src.overview : "",
			fullBody: src ? src.fullBody : "",
			wikiFile: `topic--${t.slug}.md`,
			unitCount: 0,
			commitCount: 0,
		};
	});

	// Rollups: unit + commit counts per topic, then per category.
	const unitsByTopic = new Map<string, number>();
	for (const u of distill.units) unitsByTopic.set(u.topicSlug, (unitsByTopic.get(u.topicSlug) ?? 0) + 1);
	for (const t of topics) {
		t.unitCount = unitsByTopic.get(t.slug) ?? 0;
		t.commitCount = t.sourceCommits.length;
	}

	// Mechanical empty-category prune: drop any category no topic references
	// (topicCount === 0). Post-validation every topic's categoryId resolves to a
	// real category, so a zero-topic category is unreferenced and safe to remove —
	// this is what keeps the incremental "categories only grow" merge from leaving
	// an empty `uncategorized` (or any) card behind after a topic is deleted or
	// re-categorized out of it. Harmless on the full path (the distiller rarely
	// emits an unused category, but if it does, it goes too).
	const categories: GraphCategory[] = distill.categories
		.map((c) => {
			const catTopics = topics.filter((t) => t.categoryId === c.id);
			return {
				...c,
				topicCount: catTopics.length,
				unitCount: catTopics.reduce((a, t) => a + t.unitCount, 0),
				commitCount: catTopics.reduce((a, t) => a + t.commitCount, 0),
			};
		})
		.filter((c) => c.topicCount > 0);

	// Edge rollups (for stats / the panel header; the view recomputes its own
	// aggregates at render time from expansion state).
	const unitToTopic = new Map(distill.units.map((u) => [u.id, u.topicSlug]));
	const topicToCategory = new Map(distill.topics.map((t) => [t.slug, t.categoryId]));
	let intraTopicEdges = 0;
	let crossTopicEdges = 0;
	let crossCategoryEdges = 0;
	for (const e of distill.edges) {
		const ta = unitToTopic.get(e.from);
		const tb = unitToTopic.get(e.to);
		if (ta === tb) {
			intraTopicEdges++;
			continue;
		}
		crossTopicEdges++;
		// Post-validation both endpoints are known units, so unitToTopic always
		// resolved them — the casts can't be undefined here.
		if (topicToCategory.get(ta as string) !== topicToCategory.get(tb as string)) crossCategoryEdges++;
	}

	const stats: GraphStats = {
		categories: categories.length,
		topics: topics.length,
		units: distill.units.length,
		edges: distill.edges.length,
		intraTopicEdges,
		crossTopicEdges,
		crossCategoryEdges,
	};

	return {
		schemaVersion: GRAPH_SCHEMA_VERSION,
		generatedAt,
		source: "topic KB distillation (LLM categories/topics/units/edges + computed joins)",
		topicFingerprints,
		topicMetaFingerprints,
		stats,
		categories,
		topics,
		units: distill.units,
		edges: distill.edges,
	};
}

// -- Incremental baseline: diff + restore -------------------------------------

/** The four buckets an incremental build partitions the current topics into. */
export interface TopicDiff {
	/** Existing topics whose fingerprint changed. */
	readonly dirty: string[];
	/** Topics present now but absent from the baseline. */
	readonly added: string[];
	/** Topics in the baseline but absent now. */
	readonly deleted: string[];
	/** Existing topics whose fingerprint is unchanged (reusable verbatim). */
	readonly clean: string[];
}

/**
 * Partitions topics by comparing the baseline fingerprint map (from the prior
 * graph.json) against the freshly-computed one. Pure: no I/O, no LLM. Keys are
 * `stableSlug`, values are the content fingerprint.
 */
export function diffTopics(prev: Record<string, string>, cur: Record<string, string>): TopicDiff {
	const dirty: string[] = [];
	const added: string[] = [];
	const clean: string[] = [];
	for (const [slug, fp] of Object.entries(cur)) {
		if (!(slug in prev)) added.push(slug);
		else if (prev[slug] !== fp) dirty.push(slug);
		else clean.push(slug);
	}
	const deleted = Object.keys(prev).filter((slug) => !(slug in cur));
	return { dirty, added, deleted, clean };
}

function isStringArray(v: unknown): boolean {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validCategory(c: unknown): boolean {
	if (typeof c !== "object" || c === null) return false;
	const r = c as Record<string, unknown>;
	return typeof r.id === "string" && typeof r.shortTitle === "string" && typeof r.summary === "string";
}

function validTopic(t: unknown): boolean {
	if (typeof t !== "object" || t === null) return false;
	const r = t as Record<string, unknown>;
	return (
		typeof r.slug === "string" &&
		typeof r.shortTitle === "string" &&
		typeof r.summary === "string" &&
		typeof r.title === "string" &&
		typeof r.categoryId === "string"
	);
}

function validUnit(u: unknown): boolean {
	if (typeof u !== "object" || u === null) return false;
	const r = u as Record<string, unknown>;
	if (
		typeof r.id !== "string" ||
		typeof r.topicSlug !== "string" ||
		typeof r.shortTitle !== "string" ||
		typeof r.summary !== "string"
	) {
		return false;
	}
	if (!UNIT_KINDS.includes(r.kind as UnitKind)) return false;
	if (typeof r.anchors !== "object" || r.anchors === null) return false;
	const a = r.anchors as Record<string, unknown>;
	return isStringArray(a.files) && isStringArray(a.commits);
}

function validEdge(e: unknown): boolean {
	if (typeof e !== "object" || e === null) return false;
	const r = e as Record<string, unknown>;
	return (
		typeof r.from === "string" &&
		typeof r.to === "string" &&
		EDGE_TYPES.includes(r.type as EdgeType) &&
		typeof r.confidence === "number" &&
		typeof r.evidence === "string"
	);
}

/**
 * Restores a prior `KnowledgeGraph` (parsed graph.json) to the `DistilledGraph`
 * subset used as the incremental baseline: strips the derived join/rollup fields
 * from categories/topics, keeps `units`/`edges` verbatim.
 *
 * Runs a FIELD-SET check on every entity — NOT just referential integrity (which
 * {@link validateDistilledGraph} covers). If any reused entity is missing a
 * required field or has the wrong type, the baseline is structurally
 * incompatible and this returns `null` so the caller degrades to a safe full
 * rebuild. Also returns `null` when the top-level arrays are absent or non-array.
 *
 * SCOPE — this catches a CURRENTLY-REQUIRED field that is missing or mistyped in
 * the baseline (a removed/renamed field, a changed `kind`/edge-type enum, a
 * changed id format, or corruption). It CANNOT catch a baseline that predates a
 * NEWLY-ADDED field: a validator only checks fields it knows about, so an old
 * unit lacking a brand-new field still passes, and the explicit field-pick below
 * simply omits the new field (degraded display for reused entities until the next
 * full rebuild — never a crash). Guarding "added field" drift is the job of
 * {@link GRAPH_SCHEMA_VERSION}: bumping it on any output-shape change makes the
 * baseline version-mismatch → full rebuild before `toDistilled` is even reached.
 */
export function toDistilled(graph: unknown): DistilledGraph | null {
	if (typeof graph !== "object" || graph === null) return null;
	const g = graph as Record<string, unknown>;
	const { categories, topics, units, edges } = g;
	if (!Array.isArray(categories) || !Array.isArray(topics) || !Array.isArray(units) || !Array.isArray(edges)) {
		return null;
	}
	if (!categories.every(validCategory) || !topics.every(validTopic)) return null;
	if (!units.every(validUnit) || !edges.every(validEdge)) return null;

	const cats = categories as DistilledCategory[];
	const tops = topics as (DistilledTopic & Record<string, unknown>)[];
	const us = units as DistilledUnit[];
	const es = edges as GraphEdge[];
	return {
		categories: cats.map((c) => ({ id: c.id, shortTitle: c.shortTitle, summary: c.summary })),
		topics: tops.map((t) => ({
			slug: t.slug,
			shortTitle: t.shortTitle,
			summary: t.summary,
			title: t.title,
			categoryId: t.categoryId,
		})),
		units: us.map((u) => ({
			id: u.id,
			topicSlug: u.topicSlug,
			kind: u.kind,
			shortTitle: u.shortTitle,
			summary: u.summary,
			anchors: { files: [...u.anchors.files], commits: [...u.anchors.commits] },
		})),
		edges: es.map((e) => ({
			from: e.from,
			to: e.to,
			type: e.type,
			confidence: e.confidence,
			evidence: e.evidence,
		})),
	};
}

/**
 * Validates the prior graph.json's `topicFingerprints` baseline: a plain object
 * whose every value is a string. A malformed value (null, array, primitive, or
 * non-string entries — only reachable via hand-corruption or a future bug) means
 * the baseline can't be diffed, so the caller treats it like any other unusable
 * baseline (schema mismatch / `toDistilled` null) → one-time full rebuild that
 * heals it, rather than throwing in `diffTopics` (`"x" in 5` throws) and getting
 * stuck "no graph" every build. This is NOT a fallback from a recoverable
 * incremental hiccup (those keep the old graph) — it's "no usable starting point".
 */
export function isFingerprintMap(v: unknown): v is Record<string, string> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	return Object.values(v).every((x) => typeof x === "string");
}

// -- Incremental categories merge --------------------------------------------

/** What the `graph-categories-delta` LLM call yields: newly-invented categories
 * plus the changed topics' (re)assignments. */
export interface CategoriesDelta {
	readonly newCategories: DistilledCategory[];
	readonly topics: DistilledTopic[];
}

/** Minimal current-topic shape the merge needs (slug/title/summary, in order). */
export interface MergeTopicInput {
	readonly slug: string;
	readonly title: string;
	readonly summary: string;
}

/**
 * Merges the incremental categories layer (pure, no LLM): keeps the prior
 * category list as authoritative, folds in only genuinely-new delta categories,
 * and rebuilds the topic→category assignment.
 *
 * - **clean** topics keep their baseline categoryId / shortTitle / summary →
 *   stable category ids → stable layout.
 * - **changed** topics (dirty ∪ new) take the delta's assignment.
 * - **id collision**: a delta category whose id already exists is dropped (the
 *   existing category wins; its topic just resolves to the kept one).
 * - **shortTitle collision**: a delta category whose normalized label matches an
 *   existing one is folded into that existing id (avoids two cards with the same
 *   label, since the viz keys cards by id — a delta-path-only hazard).
 * - **uncategorized invariant**: any topic whose categoryId doesn't resolve falls
 *   into `uncategorized`, which is added to the list iff used. (Empty categories
 *   are pruned later by {@link assembleGraph}.)
 *
 * Topics absent from both delta and baseline get a minimal fallback so a topic is
 * never silently dropped. `title` always comes from the current input (the LLM is
 * told to keep it unchanged, but the input is authoritative).
 */
export function mergeCategoryLayer(
	prevCategories: ReadonlyArray<DistilledCategory>,
	prevTopics: ReadonlyArray<DistilledTopic>,
	delta: CategoriesDelta,
	currentTopics: ReadonlyArray<MergeTopicInput>,
	changedSlugs: ReadonlySet<string>,
): { categories: DistilledCategory[]; topics: DistilledTopic[] } {
	const norm = (s: string): string => s.trim().toLowerCase();

	const catById = new Map<string, DistilledCategory>();
	const idByShortTitle = new Map<string, string>();
	for (const c of prevCategories) {
		if (catById.has(c.id)) continue; // keep-first on a duplicated baseline id
		catById.set(c.id, c);
		if (!idByShortTitle.has(norm(c.shortTitle))) idByShortTitle.set(norm(c.shortTitle), c.id);
	}

	// remap: a delta category id folded into an existing one (by shortTitle) → kept id.
	const remap = new Map<string, string>();
	for (const c of delta.newCategories) {
		if (catById.has(c.id)) continue; // id already exists → reuse existing (keep its metadata)
		const existingByTitle = idByShortTitle.get(norm(c.shortTitle));
		if (existingByTitle) {
			remap.set(c.id, existingByTitle);
			continue;
		}
		catById.set(c.id, c);
		idByShortTitle.set(norm(c.shortTitle), c.id);
	}

	const deltaBySlug = new Map(delta.topics.map((t) => [t.slug, t]));
	const prevBySlug = new Map(prevTopics.map((t) => [t.slug, t]));
	const topics: DistilledTopic[] = [];
	let needUncategorized = false;
	for (const ct of currentTopics) {
		const src = changedSlugs.has(ct.slug) ? deltaBySlug.get(ct.slug) : prevBySlug.get(ct.slug);
		let categoryId = src ? (remap.get(src.categoryId) ?? src.categoryId) : UNCATEGORIZED_CATEGORY_ID;
		const shortTitle = src ? src.shortTitle : ct.title.slice(0, 80);
		const summary = src ? src.summary : ct.summary;
		if (!catById.has(categoryId)) categoryId = UNCATEGORIZED_CATEGORY_ID;
		if (categoryId === UNCATEGORIZED_CATEGORY_ID) needUncategorized = true;
		topics.push({ slug: ct.slug, title: ct.title, shortTitle, summary, categoryId });
	}
	if (needUncategorized && !catById.has(UNCATEGORIZED_CATEGORY_ID)) {
		catById.set(UNCATEGORIZED_CATEGORY_ID, {
			id: UNCATEGORIZED_CATEGORY_ID,
			shortTitle: "Uncategorized",
			summary: "Topics not yet grouped.",
		});
	}

	return { categories: [...catById.values()], topics };
}
