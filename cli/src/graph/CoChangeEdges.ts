/**
 * CoChangeEdges — deterministic, zero-LLM producer of topic↔topic co-change edges.
 *
 * The parallel edge layer to the LLM-distilled unit↔unit `edges`. Two topics in
 * DIFFERENT categories are linked when their units touch the same source files
 * (a "co-change" / logical-coupling signal). Pure data shaping: no fs, no LLM, no
 * storage — `GraphBuilder` calls it on every build and passes the result into
 * `assembleGraph`, which validates + embeds it. It lives in its own parallel
 * array so the unit-edge schema and validation stay untouched.
 *
 * Why topic-level, cross-category only:
 *   - Within a category, relationships are already expressed as unit↔unit edges by
 *     the per-category LLM pass — a parallel co-change layer there would duplicate.
 *   - Lifting cross-category links to the topic level (vs unit↔unit) avoids the
 *     "god file" hairball: one shared utility file touched by many units would
 *     otherwise emit O(n²) unit edges; here it contributes at most one topic pair.
 *
 * "God files" (touched by >= `godFileCategoryThreshold` distinct categories) are
 * excluded entirely before pairing: a file every subsystem edits (e.g. a central
 * types module) carries no real coupling signal and would link everything.
 */

import type { CoChangeTopicEdge, DistilledTopic, DistilledUnit } from "./GraphSchema.js";

/** Tunables for {@link computeCoChangeTopicEdges}. v1 uses the defaults below;
 * GraphBuilder passes none. Made overridable only so callers/tests can tighten it
 * without threading a global config (the options deliberately do NOT live in
 * `LlmConfig` or `assembleGraph`). */
export interface CoChangeEdgeOptions {
	/** A file touched by >= this many distinct categories is a "god file" and is
	 * dropped before pairing (it links everything, signalling nothing). */
	readonly godFileCategoryThreshold: number;
	/** Minimum shared (non-god) files for two topics to be linked. */
	readonly minSharedFiles: number;
}

export const DEFAULT_COCHANGE_OPTIONS: CoChangeEdgeOptions = {
	godFileCategoryThreshold: 3,
	minSharedFiles: 1,
};

/**
 * Computes the deterministic cross-category co-change topic edges for a distilled
 * graph. Pure + order-stable: topics are paired in their input order, shared-file
 * lists are sorted, and each unordered topic pair is emitted at most once with
 * `fromTopic < toTopic` (the canonical ordering `validateCoChangeTopicEdges`
 * enforces). Returns `[]` when there are < 2 topics or no qualifying overlaps.
 */
export function computeCoChangeTopicEdges(
	units: ReadonlyArray<DistilledUnit>,
	topics: ReadonlyArray<DistilledTopic>,
	opts: CoChangeEdgeOptions = DEFAULT_COCHANGE_OPTIONS,
): CoChangeTopicEdge[] {
	const categoryOf = new Map(topics.map((t) => [t.slug, t.categoryId]));

	// file -> distinct categories that touch it (via the unit's topic's category).
	const fileCategories = new Map<string, Set<string>>();
	for (const u of units) {
		const category = categoryOf.get(u.topicSlug);
		if (category === undefined) continue; // unit whose topic isn't in the graph
		for (const file of u.anchors.files) {
			let cats = fileCategories.get(file);
			if (!cats) {
				cats = new Set();
				fileCategories.set(file, cats);
			}
			cats.add(category);
		}
	}

	// "God files" touch >= threshold distinct categories → carry no coupling signal.
	// Precomputed as a set so the per-file lookup below is a plain membership test.
	const godFiles = new Set<string>();
	for (const [file, cats] of fileCategories) {
		if (cats.size >= opts.godFileCategoryThreshold) godFiles.add(file);
	}

	// topic -> set of its non-god files (union across the topic's units).
	const topicFiles = new Map<string, Set<string>>();
	for (const u of units) {
		if (!categoryOf.has(u.topicSlug)) continue;
		let files = topicFiles.get(u.topicSlug);
		if (!files) {
			files = new Set();
			topicFiles.set(u.topicSlug, files);
		}
		for (const file of u.anchors.files) {
			if (!godFiles.has(file)) files.add(file);
		}
	}

	// Pair every two topics in DIFFERENT categories; emit when their non-god file
	// sets overlap by >= minSharedFiles. Iterate in input order so output is stable.
	const edges: CoChangeTopicEdge[] = [];
	for (let i = 0; i < topics.length; i++) {
		const a = topics[i];
		const aFiles = topicFiles.get(a.slug);
		if (!aFiles || aFiles.size === 0) continue;
		for (let j = i + 1; j < topics.length; j++) {
			const b = topics[j];
			if (a.categoryId === b.categoryId) continue; // cross-category only
			const bFiles = topicFiles.get(b.slug);
			if (!bFiles || bFiles.size === 0) continue;
			const shared: string[] = [];
			for (const file of aFiles) {
				if (bFiles.has(file)) shared.push(file);
			}
			if (shared.length < opts.minSharedFiles) continue;
			shared.sort();
			// Canonical ordering fromTopic < toTopic (slugs are unique).
			const [fromTopic, toTopic] = a.slug < b.slug ? [a.slug, b.slug] : [b.slug, a.slug];
			edges.push({ fromTopic, toTopic, kind: "co-change", sharedFiles: shared, sharedFileCount: shared.length });
		}
	}
	return edges;
}
