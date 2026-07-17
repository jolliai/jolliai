/**
 * GraphDistiller — LLM step that turns topic-KB pages into the distilled graph
 * (categories + topics + units + edges). Reuses the product's single LLM
 * abstraction (`callLlm`) and bounded-concurrency helper exactly as
 * `IngestPipeline` does, so it inherits provider routing, streaming watchdogs,
 * and proxy support for free. Emits the prototype's schema (unit-to-unit edges),
 * which is what the viz runtime renders.
 *
 * Three phases:
 *   1. graph-categories — one call: group all topics into categories.
 *   2. graph-units      — one call per topic (fanned out): distil units.
 *   3. graph-edges      — one call: typed relationships across all units.
 */

import { mapWithConcurrency } from "../core/Concurrency.js";
import { callLlm, llmCredentials, llmFanoutLimit } from "../core/LlmClient.js";
import { resolveModelId } from "../core/Summarizer.js";
import { createLogger } from "../Logger.js";
import type { LlmConfig } from "../Types.js";
import {
	type CategoriesDelta,
	type DistilledCategory,
	type DistilledGraph,
	type DistilledTopic,
	type DistilledUnit,
	EDGE_TYPES,
	type EdgeType,
	type GraphEdge,
	mergeCategoryLayer,
	type TopicDiff,
	UNCATEGORIZED_CATEGORY_ID,
	UNIT_KINDS,
	type UnitKind,
} from "./GraphSchema.js";

const log = createLogger("GraphDistiller");

const CATEGORIES_MAX_TOKENS = 16_384;
const UNITS_MAX_TOKENS = 4_096;
const EDGES_MAX_TOKENS = 32_000;
const UNITS_CONCURRENCY = 4;

/**
 * Reports a one-line, human-readable progress message for UI surfaces (the VS
 * Code "Building knowledge wiki…" notification). Distinct from the CLI debug
 * log: this is throttle-free, transient, and never persisted.
 */
export type GraphProgressReporter = (message: string) => void;

/** One topic fed into distillation: identity + index summary + page body. */
export interface DistillTopicInput {
	readonly slug: string;
	readonly title: string;
	readonly summary: string;
	readonly content: string;
}

export interface DistillInput {
	readonly topics: ReadonlyArray<DistillTopicInput>;
}

/** Strips markdown code fences then parses; returns null on any failure. */
function parseJsonObject<T>(text: string | undefined): T | null {
	if (!text) return null;
	let s = text.trim();
	// Drop a leading ```json / ``` fence and trailing ``` if present.
	s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	// Fall back to the outermost {...} span if there is leading/trailing prose.
	if (!s.startsWith("{")) {
		const first = s.indexOf("{");
		const last = s.lastIndexOf("}");
		if (first === -1 || last <= first) return null;
		s = s.slice(first, last + 1);
	}
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
}

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

/** Like {@link asString} but treats a blank / whitespace-only value as missing,
 * so an LLM that emits `""` for a title or summary still gets the fallback
 * rather than rendering a blank, unsearchable card. */
function asNonBlank(v: unknown, fallback: string): string {
	const s = asString(v);
	return s.trim().length > 0 ? s : fallback;
}

function asStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function clampConfidence(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n)) return 0.7;
	return Math.min(1, Math.max(0.5, n));
}

interface RawCategory {
	id?: unknown;
	shortTitle?: unknown;
	summary?: unknown;
}
interface RawTopic {
	slug?: unknown;
	title?: unknown;
	shortTitle?: unknown;
	summary?: unknown;
	categoryId?: unknown;
}
interface CategoriesResponse {
	categories?: RawCategory[];
	topics?: RawTopic[];
}
interface RawUnit {
	id?: unknown;
	kind?: unknown;
	shortTitle?: unknown;
	summary?: unknown;
	anchors?: { files?: unknown; commits?: unknown };
}
interface UnitsResponse {
	units?: RawUnit[];
}
interface RawEdge {
	from?: unknown;
	to?: unknown;
	type?: unknown;
	confidence?: unknown;
	evidence?: unknown;
}
interface EdgesResponse {
	edges?: RawEdge[];
}

/** Phase 1: categories + per-topic shortTitle/summary/categoryId. */
async function distillCategories(
	input: DistillInput,
	config: LlmConfig,
): Promise<{ categories: DistilledCategory[]; topics: DistilledTopic[] }> {
	const topicsBlock = input.topics.map((t) => `- ${t.slug} -- ${t.title}: ${t.summary}`).join("\n");
	const result = await callLlm({
		action: "graph-categories",
		params: { topics: topicsBlock || "(none)" },
		model: resolveModelId(config.model),
		maxTokens: CATEGORIES_MAX_TOKENS,
		forceStreaming: true,
		...llmCredentials(config),
	});
	const parsed = parseJsonObject<CategoriesResponse>(result.text);

	// Drop empty ids AND deduplicate by id (keep first): the frontend keys cards,
	// the categoriesById map, and ELK node ids off category id, so a repeated id
	// would render duplicate cards and corrupt the layout. shortTitle falls back
	// to the id so a category never renders a blank label.
	const categoryIds = new Set<string>();
	const categories: DistilledCategory[] = [];
	for (const c of parsed?.categories ?? []) {
		const id = asString(c.id);
		if (id.length === 0 || categoryIds.has(id)) continue;
		categoryIds.add(id);
		categories.push({ id, shortTitle: asNonBlank(c.shortTitle, id), summary: asString(c.summary) });
	}

	// Keep only LLM topics that map to a real input slug; index by slug.
	const inputBySlug = new Map(input.topics.map((t) => [t.slug, t]));
	const llmTopics = new Map<string, DistilledTopic>();
	for (const t of parsed?.topics ?? []) {
		const slug = asString(t.slug);
		const src = inputBySlug.get(slug);
		if (!src) continue; // hallucinated slug
		const categoryId = categoryIds.has(asString(t.categoryId)) ? asString(t.categoryId) : UNCATEGORIZED_CATEGORY_ID;
		llmTopics.set(slug, {
			slug,
			title: asString(t.title, src.title),
			shortTitle: asString(t.shortTitle, src.title).slice(0, 80),
			summary: asString(t.summary, src.summary),
			categoryId,
		});
	}

	// Backfill any topic the LLM dropped, so the graph never silently loses one
	// (the prototype's known 44-vs-43 defect). Backfilled + bad-categoryId topics
	// land in an "uncategorized" bucket.
	const topics: DistilledTopic[] = [];
	let needsUncategorized = false;
	for (const src of input.topics) {
		const t = llmTopics.get(src.slug);
		if (t) {
			topics.push(t);
			if (t.categoryId === UNCATEGORIZED_CATEGORY_ID) needsUncategorized = true;
		} else {
			topics.push({
				slug: src.slug,
				title: src.title,
				shortTitle: src.title.slice(0, 80),
				summary: src.summary,
				categoryId: UNCATEGORIZED_CATEGORY_ID,
			});
			needsUncategorized = true;
		}
	}
	if (needsUncategorized && !categoryIds.has(UNCATEGORIZED_CATEGORY_ID)) {
		categories.push({
			id: UNCATEGORIZED_CATEGORY_ID,
			shortTitle: "Uncategorized",
			summary: "Topics not yet grouped.",
		});
	}

	return { categories, topics };
}

/**
 * Phase 2: units for one topic. Returns globally-namespaced units.
 *
 * `strict` (incremental path) turns an UNPARSEABLE response into a throw so the
 * caller fails the round and keeps the prior good graph — a dirty topic's units
 * must never be silently overwritten with nothing. On the full path `strict` is
 * off: a parse failure degrades to no units for that topic (there is no prior
 * graph to protect). A response that parses to `{units:[]}` (a topic the LLM
 * legitimately found no units in) is NOT a failure and never throws.
 */
async function distillUnitsForTopic(
	topic: DistillTopicInput,
	config: LlmConfig,
	opts?: { readonly strict?: boolean },
): Promise<DistilledUnit[]> {
	const result = await callLlm({
		action: "graph-units",
		params: { topicTitle: topic.title, content: topic.content || "(empty)" },
		model: resolveModelId(config.model),
		maxTokens: UNITS_MAX_TOKENS,
		...llmCredentials(config),
	});
	const parsed = parseJsonObject<UnitsResponse>(result.text);
	// Strict (incremental): require an actual `units` ARRAY, not merely parseable JSON.
	// `{}` / `{"foo":1}` parse fine but would degrade to zero units and overwrite a
	// dirty topic's baseline units — so a missing/non-array field fails the round too.
	// `{"units":[]}` (array present, empty) is a legitimate "no units" and does not throw.
	if (opts?.strict && !Array.isArray(parsed?.units)) {
		throw new Error(`graph-units returned no units array for topic ${topic.slug}`);
	}
	const units: DistilledUnit[] = [];
	const seenLocal = new Set<string>();
	for (const u of parsed?.units ?? []) {
		const localId = asString(u.id).trim();
		const kind = asString(u.kind) as UnitKind;
		if (!localId || !UNIT_KINDS.includes(kind)) continue;
		// Namespace per topic to guarantee global uniqueness; suffix on collision.
		let local = localId;
		let n = 2;
		while (seenLocal.has(local)) local = `${localId}-${n++}`;
		seenLocal.add(local);
		// Fall back to the local id / shortTitle so a unit whose title or summary
		// the LLM dropped never renders as a blank, unsearchable card.
		const shortTitle = asNonBlank(u.shortTitle, local).slice(0, 80);
		units.push({
			id: `${topic.slug}::${local}`,
			topicSlug: topic.slug,
			kind,
			shortTitle,
			summary: asNonBlank(u.summary, shortTitle),
			anchors: { files: asStringArray(u.anchors?.files), commits: asStringArray(u.anchors?.commits) },
		});
	}
	return units;
}

/**
 * Phase 3: typed edges across all units. Filters to valid endpoints/types.
 *
 * `strict` (incremental path) turns an UNPARSEABLE response into a throw: because
 * the incremental path recomputes edges in full every run, silently degrading to
 * `[]` would overwrite the prior graph's entire edge layer with nothing. On the
 * full path `strict` is off and a parse failure degrades to no edges. A response
 * that parses to `{edges:[]}` is a legitimate "no edges found", not a failure, and
 * never throws (nor does `< 2` units, which skips the call).
 */
async function distillEdges(
	units: ReadonlyArray<DistilledUnit>,
	config: LlmConfig,
	opts?: { readonly strict?: boolean },
): Promise<GraphEdge[]> {
	if (units.length < 2) return [];
	const unitsBlock = units.map((u) => `- ${u.id} [${u.topicSlug}] ${u.shortTitle}: ${u.summary}`).join("\n");
	const result = await callLlm({
		action: "graph-edges",
		params: { units: unitsBlock },
		model: resolveModelId(config.model),
		maxTokens: EDGES_MAX_TOKENS,
		forceStreaming: true,
		...llmCredentials(config),
	});
	const truncated = result.stopReason === "max_tokens";
	const parsed = parseJsonObject<EdgesResponse>(result.text);
	// Strict (incremental): require an actual `edges` ARRAY. `{}` parses but would wipe
	// the whole edge layer (edges are recomputed in full each incremental run), so a
	// missing/non-array field fails the round. `{"edges":[]}` ("no edges") is fine.
	if (opts?.strict && !Array.isArray(parsed?.edges)) {
		// Truncation is the usual cause of an unparseable strict response: a graph with
		// enough units blows EDGES_MAX_TOKENS, the cut-off JSON won't parse, and the
		// fail-closed throw keeps the prior graph. Unlike the full path (which degrades
		// to the edges that DID parse), the incremental path abandons the whole round —
		// so a repo whose edge set stays above the limit gets stuck on its old graph
		// indefinitely. Log that explicitly: otherwise "graph never updates" gives no
		// clue why (raise EDGES_MAX_TOKENS or split the graph if this repeats).
		if (truncated) {
			log.warn(
				"graph-edges truncated (max_tokens) and unparseable in strict mode -- abandoning incremental round, keeping prior graph",
			);
		}
		throw new Error(
			truncated
				? "graph-edges returned no edges array (response truncated at max_tokens)"
				: "graph-edges returned no edges array",
		);
	}
	if (truncated) {
		log.warn("graph-edges truncated (max_tokens) -- keeping the edges that parsed");
	}
	const unitIds = new Set(units.map((u) => u.id));
	const seen = new Set<string>();
	const edges: GraphEdge[] = [];
	for (const e of parsed?.edges ?? []) {
		const from = asString(e.from);
		const to = asString(e.to);
		const type = asString(e.type) as EdgeType;
		if (from === to || !unitIds.has(from) || !unitIds.has(to) || !EDGE_TYPES.includes(type)) continue;
		const key = `${from}|${to}|${type}`;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({ from, to, type, confidence: clampConfidence(e.confidence), evidence: asString(e.evidence) });
	}
	return edges;
}

/** Runs the full three-phase distillation, logging + reporting each phase. */
export async function distillGraph(
	input: DistillInput,
	config: LlmConfig,
	onProgress?: GraphProgressReporter,
): Promise<DistilledGraph> {
	const topicCount = input.topics.length;

	// Phase 1/3 — categories (single call).
	const t0 = performance.now();
	onProgress?.(`categorizing ${topicCount} topic(s)`);
	const { categories, topics } = await distillCategories(input, config);
	log.info(
		"graph phase 1/3 categories: %d categories over %d topic(s) (%dms)",
		categories.length,
		topicCount,
		Math.round(performance.now() - t0),
	);

	// Phase 2/3 — units (one call per topic, fanned out). Report done/total as
	// each topic resolves so a long fan-out shows live progress, not a freeze.
	const t1 = performance.now();
	let unitsDone = 0;
	const reportUnits = () => onProgress?.(`extracting units ${unitsDone}/${topicCount}`);
	reportUnits();
	const perTopicUnits = await mapWithConcurrency(
		input.topics,
		llmFanoutLimit(UNITS_CONCURRENCY, config),
		async (topic) => {
			const result = await distillUnitsForTopic(topic, config);
			unitsDone++;
			reportUnits();
			return result;
		},
		(topic, err) => {
			unitsDone++;
			reportUnits();
			log.warn("Unit distillation failed for %s (non-fatal): %s", topic.slug, (err as Error).message);
			return [];
		},
	);
	const units = perTopicUnits.flat();
	log.info(
		"graph phase 2/3 units: %d unit(s) from %d topic(s) (%dms)",
		units.length,
		topicCount,
		Math.round(performance.now() - t1),
	);

	// Phase 3/3 — edges (single call over all units; the long pole on big repos).
	const t2 = performance.now();
	onProgress?.(`linking edges across ${units.length} unit(s)`);
	const edges = await distillEdges(units, config);
	log.info(
		"graph phase 3/3 edges: %d edge(s) over %d unit(s) (%dms)",
		edges.length,
		units.length,
		Math.round(performance.now() - t2),
	);

	return { categories, topics, units, edges };
}

interface DeltaCategoriesResponse {
	newCategories?: RawCategory[];
	topics?: RawTopic[];
}

/**
 * Incremental Phase 1: place ONLY the changed topics, reusing existing
 * categories. Returns the LLM's genuinely-new categories + each changed topic's
 * (re)assignment. Sanitizing mirrors {@link distillCategories} (drop empty/dup
 * ids, blank-label fallback); a proposed id that already exists is dropped (the
 * merge keeps the existing category). Hallucinated / not-in-changed-set slugs are
 * omitted — the caller's {@link mergeCategoryLayer} backfills any changed topic
 * the LLM dropped (a valid-but-incomplete response is tolerated this way).
 *
 * An UNPARSEABLE response, by contrast, throws: this is the incremental path, so
 * a failed delta must fail the round and keep the prior good graph rather than
 * dumping every changed topic into `uncategorized` over a still-good baseline.
 * (A raw LLM-call error already throws — `callLlm` is awaited here.)
 */
async function distillCategoriesDelta(
	existingCategories: ReadonlyArray<DistilledCategory>,
	changedTopics: ReadonlyArray<DistillTopicInput>,
	config: LlmConfig,
): Promise<CategoriesDelta> {
	const existingBlock =
		existingCategories.map((c) => `- ${c.id} -- ${c.shortTitle}: ${c.summary}`).join("\n") || "(none)";
	const topicsBlock = changedTopics.map((t) => `- ${t.slug} -- ${t.title}: ${t.summary}`).join("\n") || "(none)";
	const result = await callLlm({
		action: "graph-categories-delta",
		params: { existingCategories: existingBlock, topics: topicsBlock },
		model: resolveModelId(config.model),
		maxTokens: CATEGORIES_MAX_TOKENS,
		forceStreaming: true,
		...llmCredentials(config),
	});
	const parsed = parseJsonObject<DeltaCategoriesResponse>(result.text);
	// Incremental fails closed: require BOTH arrays the prompt contracts for
	// (`{newCategories:[],topics:[]}`). Unparseable JSON, `{}`, or a non-array field
	// would otherwise dump every changed topic into `uncategorized` over a still-good
	// baseline. Empty arrays are a legitimate response (handled by the backfill merge).
	if (!Array.isArray(parsed?.topics) || !Array.isArray(parsed?.newCategories)) {
		throw new Error("graph-categories-delta returned a malformed response (missing newCategories/topics array)");
	}

	const existingIds = new Set(existingCategories.map((c) => c.id));
	const seen = new Set<string>();
	const newCategories: DistilledCategory[] = [];
	for (const c of parsed?.newCategories ?? []) {
		const id = asString(c.id);
		if (id.length === 0 || seen.has(id) || existingIds.has(id)) continue;
		seen.add(id);
		newCategories.push({ id, shortTitle: asNonBlank(c.shortTitle, id), summary: asString(c.summary) });
	}

	const changedBySlug = new Map(changedTopics.map((t) => [t.slug, t]));
	const validIds = new Set([...existingIds, ...seen]);
	const topics: DistilledTopic[] = [];
	for (const t of parsed?.topics ?? []) {
		const slug = asString(t.slug);
		const src = changedBySlug.get(slug);
		if (!src) continue; // hallucinated / not in the changed set
		const categoryId = validIds.has(asString(t.categoryId)) ? asString(t.categoryId) : UNCATEGORIZED_CATEGORY_ID;
		topics.push({
			slug,
			title: asString(t.title, src.title),
			shortTitle: asNonBlank(t.shortTitle, src.title).slice(0, 80),
			summary: asNonBlank(t.summary, src.summary),
			categoryId,
		});
	}
	return { newCategories, topics };
}

/**
 * Incremental distillation. Reuses clean topics' units verbatim from the
 * baseline, re-distills only dirty/new topics, re-categorizes the changed topics
 * via the delta call (clean topics keep their baseline assignment → stable
 * layout), and — when any topic changed — recomputes edges in full over the final
 * unit set (full edges sidesteps unit-id instability and edge merge entirely).
 *
 * A pure-deletion change (dirty ∪ new empty) runs NO LLM: it filters out the
 * deleted topics' units and drops any edge whose endpoint disappeared.
 *
 * `prev` is the field-validated baseline (from `toDistilled`); `diff` is the
 * topic partition. Returns a complete `DistilledGraph` for `assembleGraph`.
 */
export async function distillGraphIncremental(
	input: DistillInput,
	prev: DistilledGraph,
	diff: TopicDiff,
	config: LlmConfig,
	onProgress?: GraphProgressReporter,
): Promise<DistilledGraph> {
	const changedSlugs = new Set([...diff.dirty, ...diff.added]);
	const cleanSlugs = new Set(diff.clean);
	const currentSlugs = new Set(input.topics.map((t) => t.slug));
	// `diffTopics` derives dirty/added from the SAME current-topic set as `input`,
	// so changedSlugs ⊆ currentSlugs and `changedTopics.length > 0 ⇔ changedSlugs.size > 0`.
	// We branch every phase on `changedTopics.length` for one consistent predicate.
	const changedTopics = input.topics.filter((t) => changedSlugs.has(t.slug));

	// --- units --- reuse clean topics' units (WHITE-LIST by the current clean set,
	// never a "not-dirty" black-list — that would drag deleted topics' units back).
	const reusedUnits = prev.units.filter((u) => cleanSlugs.has(u.topicSlug));
	let newUnits: DistilledUnit[] = [];
	if (changedTopics.length > 0) {
		let done = 0;
		const report = (): void => onProgress?.(`extracting units ${done}/${changedTopics.length}`);
		report();
		// Fail closed: NO onError swallow + `strict: true`. A dirty/new topic's unit
		// re-distillation that throws (LLM error) or returns unparseable JSON must
		// abort the round so `buildKnowledgeGraph`'s non-fatal catch keeps the prior
		// good graph. Swallowing to `[]` would emit a topic with zero units over a
		// baseline that had them — data loss, not degradation. (The full path
		// deliberately tolerates this: it has no prior graph to protect.)
		const perTopic = await mapWithConcurrency(
			changedTopics,
			llmFanoutLimit(UNITS_CONCURRENCY, config),
			async (topic) => {
				const r = await distillUnitsForTopic(topic, config, { strict: true });
				done++;
				report();
				return r;
			},
		);
		newUnits = perTopic.flat();
	}
	const units = [...reusedUnits, ...newUnits];

	// --- categories ---
	let categories: DistilledCategory[];
	let topics: DistilledTopic[];
	if (changedTopics.length > 0) {
		onProgress?.(`categorizing ${changedTopics.length} changed topic(s)`);
		const delta = await distillCategoriesDelta(prev.categories, changedTopics, config);
		const merged = mergeCategoryLayer(prev.categories, prev.topics, delta, input.topics, changedSlugs);
		categories = merged.categories;
		topics = merged.topics;
	} else {
		// Pure deletion: keep baseline categories/topics minus the deleted topics.
		// assembleGraph prunes any category left empty by the deletion.
		categories = [...prev.categories];
		topics = prev.topics.filter((t) => currentSlugs.has(t.slug));
	}

	// --- edges ---
	let edges: GraphEdge[];
	if (changedTopics.length > 0) {
		onProgress?.(`linking edges across ${units.length} unit(s)`);
		edges = await distillEdges(units, config, { strict: true });
	} else {
		// Pure deletion: removing units can only invalidate edges, never create
		// them. Drop any edge whose endpoint no longer exists; no LLM.
		const unitIds = new Set(units.map((u) => u.id));
		edges = prev.edges.filter((e) => unitIds.has(e.from) && unitIds.has(e.to));
	}

	return { categories, topics, units, edges };
}
