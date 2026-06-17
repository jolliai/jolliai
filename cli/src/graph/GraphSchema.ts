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

/** Schema version stamped onto the emitted graph; bump on a breaking shape change. */
export const GRAPH_SCHEMA_VERSION = 1;

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

	const categories: GraphCategory[] = distill.categories.map((c) => {
		const catTopics = topics.filter((t) => t.categoryId === c.id);
		return {
			...c,
			topicCount: catTopics.length,
			unitCount: catTopics.reduce((a, t) => a + t.unitCount, 0),
			commitCount: catTopics.reduce((a, t) => a + t.commitCount, 0),
		};
	});

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
		stats,
		categories,
		topics,
		units: distill.units,
		edges: distill.edges,
	};
}
