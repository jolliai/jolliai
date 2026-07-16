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
 *   3. graph-edges      — one call PER CATEGORY (fanned out): typed relationships
 *      among that category's units only. Cross-category relationships are NOT an
 *      LLM job — they are the deterministic co-change layer (`CoChangeEdges.ts`).
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
	normalizeKinds,
	type TopicDiff,
	UNCATEGORIZED_CATEGORY_ID,
} from "./GraphSchema.js";

const log = createLogger("GraphDistiller");

const CATEGORIES_MAX_TOKENS = 16_384;
const UNITS_MAX_TOKENS = 4_096;
const EDGES_MAX_TOKENS = 32_000;
const UNITS_CONCURRENCY = 4;
const EDGES_CONCURRENCY = 4;
/** graph-units attempts per topic. A malformed / unparseable body (or one whose
 * every unit is unusable) is retried — the failures are independent, so 2 retries
 * cut the observed ~20% single-topic miss rate to ~1%. A genuine `{units:[]}` is
 * accepted on the first try, never retried. */
const UNITS_MAX_ATTEMPTS = 3;

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
	/** Canonical multi-label form. */
	kinds?: unknown;
	/** Legacy scalar; still accepted at ingestion and coerced to `[kind]`. */
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
 * Builds canonical units from a raw `units[]`, skipping any entry with no id or no
 * recognizable kind. Shared across every attempt of {@link distillUnitsForTopic}.
 */
function buildUnitsFromRaw(topic: DistillTopicInput, rawUnits: RawUnit[]): DistilledUnit[] {
	const units: DistilledUnit[] = [];
	const seenLocal = new Set<string>();
	for (const u of rawUnits) {
		const localId = asString(u.id).trim();
		// Canonical `kinds[]` (deduped, ≤3); also coerces a legacy scalar `kind`.
		// A unit with no valid id or no valid kind is unusable → skip it.
		const kinds = normalizeKinds(u);
		if (!localId || kinds.length === 0) continue;
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
			kinds,
			shortTitle,
			summary: asNonBlank(u.summary, shortTitle),
			anchors: { files: asStringArray(u.anchors?.files), commits: asStringArray(u.anchors?.commits) },
		});
	}
	return units;
}

/**
 * Phase 2: units for one topic. Returns globally-namespaced units.
 *
 * graph-units occasionally returns an unparseable body (or one whose every unit is
 * unusable) for a large, code-heavy topic even when the same page distills fine on
 * the next try — the failures are independent, so we retry up to
 * {@link UNITS_MAX_ATTEMPTS} times. A parseable `{units:[]}` is a legitimate "no
 * units" answer, returned immediately and never retried.
 *
 * After the last attempt still yields nothing usable, this THROWS. The CALLER
 * decides fatality by whether it passes an onError to mapWithConcurrency:
 *   - full build (`distillGraph`) passes one that logs a VISIBLE warning and
 *     degrades this one topic to [] — so a distillation miss is no longer a silent
 *     0-units topic;
 *   - incremental (`distillGraphIncremental`) passes none, so the throw aborts the
 *     round and the prior good graph is kept (a dirty topic's units are never
 *     silently overwritten with nothing).
 */
async function distillUnitsForTopic(topic: DistillTopicInput, config: LlmConfig): Promise<DistilledUnit[]> {
	for (let attempt = 1; attempt <= UNITS_MAX_ATTEMPTS; attempt++) {
		const result = await callLlm({
			action: "graph-units",
			params: { topicTitle: topic.title, content: topic.content || "(empty)" },
			model: resolveModelId(config.model),
			maxTokens: UNITS_MAX_TOKENS,
			...llmCredentials(config),
		});
		const rawUnits = parseJsonObject<UnitsResponse>(result.text)?.units;

		if (Array.isArray(rawUnits)) {
			const units = buildUnitsFromRaw(topic, rawUnits);
			if (units.length > 0) return units;
			// `{units:[]}` (array present, empty) is a legitimate "no units" — accept it.
			if (rawUnits.length === 0) return units;
			// Array present and non-empty, but every entry was unusable (no id / no kind).
			if (attempt < UNITS_MAX_ATTEMPTS) {
				log.warn(
					"graph-units for topic %s: %d raw unit(s) but none had a valid id + kinds (attempt %d/%d) -- retrying",
					topic.slug,
					rawUnits.length,
					attempt,
					UNITS_MAX_ATTEMPTS,
				);
				continue;
			}
			throw new Error(
				`graph-units for topic ${topic.slug}: ${rawUnits.length} raw unit(s) but none had a valid id + kinds (after ${UNITS_MAX_ATTEMPTS} attempts)`,
			);
		}

		// Unparseable JSON, or a parseable object with no `units` array.
		if (attempt < UNITS_MAX_ATTEMPTS) {
			log.warn(
				"graph-units for topic %s returned no units array (attempt %d/%d) -- retrying",
				topic.slug,
				attempt,
				UNITS_MAX_ATTEMPTS,
			);
			continue;
		}
		throw new Error(
			`graph-units returned no units array for topic ${topic.slug} (after ${UNITS_MAX_ATTEMPTS} attempts)`,
		);
	}
	// Unreachable: each loop iteration returns or throws. Present for the type checker.
	throw new Error(`graph-units for topic ${topic.slug}: exhausted ${UNITS_MAX_ATTEMPTS} attempts`);
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

/** Groups units by their topic's category id. Units whose topic is absent from
 * `topics` are dropped (defensive; assembleGraph would reject a dangling unit). */
function groupUnitsByCategory(
	units: ReadonlyArray<DistilledUnit>,
	topics: ReadonlyArray<DistilledTopic>,
): Map<string, DistilledUnit[]> {
	const categoryOf = new Map(topics.map((t) => [t.slug, t.categoryId]));
	const groups = new Map<string, DistilledUnit[]>();
	for (const u of units) {
		const c = categoryOf.get(u.topicSlug);
		if (c === undefined) continue;
		let arr = groups.get(c);
		if (!arr) {
			arr = [];
			groups.set(c, arr);
		}
		arr.push(u);
	}
	return groups;
}

/**
 * Phase 3 (per-category): runs the edge LLM once per category, over ONLY that
 * category's units, and concatenates the results. This replaces the old single
 * global call. Two consequences fall out of the structure, not extra logic:
 *   - each call is bounded by one category's unit count (no single call grows
 *     with the whole graph → no truncation on large repos);
 *   - cross-category unit edges are impossible (the LLM never sees two categories
 *     at once) — those relationships are the deterministic co-change layer
 *     (`CoChangeEdges.ts`) instead. `distillEdges` further drops any returned edge
 *     whose endpoint is outside the category batch, so this is enforced twice.
 *
 * `onlyCategories`, when given, restricts the calls to those category ids (the
 * incremental path's "affected categories"); otherwise every category runs (full
 * build). `strict` propagates to each `distillEdges` call: strict means a thrown
 * error fails the whole round (incremental keeps the prior graph); non-strict
 * degrades a failed category to no edges (full build has no prior graph to keep).
 */
async function distillEdgesForCategories(
	units: ReadonlyArray<DistilledUnit>,
	topics: ReadonlyArray<DistilledTopic>,
	config: LlmConfig,
	opts?: { readonly strict?: boolean; readonly onlyCategories?: ReadonlyArray<string> },
): Promise<GraphEdge[]> {
	const groups = groupUnitsByCategory(units, topics);
	const targets = opts?.onlyCategories ?? [...groups.keys()];
	const perCategory = await mapWithConcurrency(
		targets,
		EDGES_CONCURRENCY,
		(catId) => distillEdges(groups.get(catId) ?? [], config, { strict: opts?.strict }),
		opts?.strict
			? undefined // strict: a throw must fail the round (keep prior graph) — never swallow
			: (catId, err) => {
					log.warn("Edge distillation failed for category %s (non-fatal): %s", catId, (err as Error).message);
					return [];
				},
	);
	return perCategory.flat();
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

	// Phase 3/3 — edges (one call per category, fanned out; intra-category only).
	const t2 = performance.now();
	onProgress?.(
		`distilling intra-category edges (${categories.length} categor${categories.length === 1 ? "y" : "ies"})`,
	);
	const edges = await distillEdgesForCategories(units, topics, config);
	log.info(
		"graph phase 3/3 edges: %d edge(s) over %d unit(s) in %d categor%s (%dms)",
		edges.length,
		units.length,
		categories.length,
		categories.length === 1 ? "y" : "ies",
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
 * layout), and recomputes edges ONLY for the categories that contain a changed
 * topic ("affected categories"), merging the fresh edges with the baseline:
 * clean–clean edges (neither endpoint's topic changed) are kept from the baseline
 * verbatim so unchanged links never re-shuffle (keep / drop / recompute at edge
 * granularity); only edges touching a changed topic take the fresh LLM result.
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
		// Fail closed: NO onError swallow. A dirty/new topic's unit re-distillation
		// that throws (LLM error, or an unparseable / all-invalid response that
		// survived distillUnitsForTopic's retries) must abort the round so
		// `buildKnowledgeGraph`'s non-fatal catch keeps the prior good graph.
		// Swallowing to `[]` would emit a topic with zero units over a baseline that
		// had them — data loss, not degradation. (The full path deliberately tolerates
		// this via its own onError: it has no prior graph to protect.)
		const perTopic = await mapWithConcurrency(
			changedTopics,
			llmFanoutLimit(UNITS_CONCURRENCY, config),
			async (topic) => {
				const r = await distillUnitsForTopic(topic, config);
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
		// Affected categories = categories that (after re-categorization) contain a
		// changed topic. Only these are re-run through the edge LLM; every other
		// category's intra edges are clean–clean and reused from the baseline.
		const categoryOf = new Map(topics.map((t) => [t.slug, t.categoryId]));
		const affected = new Set<string>();
		for (const t of topics) if (changedSlugs.has(t.slug)) affected.add(t.categoryId);
		onProgress?.(
			`distilling intra-category edges (${affected.size} affected categor${affected.size === 1 ? "y" : "ies"})`,
		);
		const fresh = await distillEdgesForCategories(units, topics, config, {
			strict: true,
			onlyCategories: [...affected],
		});

		// Merge baseline + fresh at edge granularity (keep / drop / recompute):
		//   - KEEP a baseline edge that is clean–clean (neither endpoint's topic
		//     changed), intra-category, and whose endpoints still exist → no flicker;
		//   - TAKE a fresh edge only when it TOUCHES a changed topic (drop fresh
		//     clean–clean: the baseline copy wins, so untouched links never reshuffle).
		// Fresh edges are already intra-category (per-category batch). Filtering kept
		// baseline edges to intra-category too guarantees no stale cross-category unit
		// edge survives from an older baseline (cross-category is the co-change layer).
		const unitTopic = new Map(units.map((u) => [u.id, u.topicSlug]));
		const unitIds = new Set(units.map((u) => u.id));
		const isCleanClean = (e: GraphEdge): boolean => {
			const tf = unitTopic.get(e.from);
			const tt = unitTopic.get(e.to);
			return tf !== undefined && tt !== undefined && !changedSlugs.has(tf) && !changedSlugs.has(tt);
		};
		const isIntraCategory = (e: GraphEdge): boolean => {
			const cf = categoryOf.get(unitTopic.get(e.from) ?? "");
			const ct = categoryOf.get(unitTopic.get(e.to) ?? "");
			return cf !== undefined && cf === ct;
		};
		const keptBaseline = prev.edges.filter(
			(e) => unitIds.has(e.from) && unitIds.has(e.to) && isCleanClean(e) && isIntraCategory(e),
		);
		const freshTouching = fresh.filter((e) => !isCleanClean(e));
		const seen = new Set<string>();
		edges = [];
		for (const e of [...keptBaseline, ...freshTouching]) {
			const key = `${e.from}|${e.to}|${e.type}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push(e);
		}
	} else {
		// Pure deletion: removing units can only invalidate edges, never create
		// them. Drop any edge whose endpoint no longer exists; no LLM.
		const unitIds = new Set(units.map((u) => u.id));
		edges = prev.edges.filter((e) => unitIds.has(e.from) && unitIds.has(e.to));
	}

	return { categories, topics, units, edges };
}
