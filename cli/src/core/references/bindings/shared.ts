/**
 * Shared, agent-agnostic normalization primitives for reference bindings.
 *
 * These exist because "the LLM searched first, then resolved" is the norm across
 * connectors/agents, not a single source's quirk: a search/list result returns a
 * collection of entities, often partial, with the stable id only in the URL.
 * Any producer binding (Codex MCP, future CLI, future agents) can reuse these.
 */

export function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The common "search-then-resolve" handler. A connector tool returns EITHER a
 * single entity OR `{ <collectionKey>: [ entity, … ] }` (a search/list result).
 * This maps every entity through `normalizeEntity` while KEEPING the wrapper, so
 * the shared `walkPayload` descends the wrapper key and the adapter sees one
 * flat entity at a time — whether the LLM fetched directly or searched first.
 * Non-object input (e.g. a bare number from a malformed output) is returned
 * as-is for the adapter to reject downstream.
 */
export function normalizeEntities(
	business: unknown,
	collectionKeys: readonly string[],
	normalizeEntity: (raw: unknown) => unknown,
): unknown {
	if (!isObject(business)) return business;
	for (const key of collectionKeys) {
		const arr = business[key];
		if (Array.isArray(arr)) {
			return { ...business, [key]: arr.map(normalizeEntity) };
		}
	}
	return normalizeEntity(business);
}

// Note: deriving a missing identifier from an entity's URL ("search hits leave the
// id null but carry the URL") is currently a source-specific concern done inline
// in the relevant normalizer (see sources/GitHubNormalize.ts). When a second
// producer/source needs it, promote a generic `backfillFromUrl(entity, field,
// urlField, pattern, transform)` here — a binding-layer consumer keeps the
// dependency direction correct (bindings → sources, never the reverse).
