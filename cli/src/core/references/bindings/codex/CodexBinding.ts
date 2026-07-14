/**
 * CodexNormalizer — one cohesive declaration per `codex_apps` connector source of
 * how Codex's rollout payloads map onto the shared `SourceDefinition` shape.
 *
 * Match identity (namespace suffix, `function_call` names, `mcp_tool_call_end`
 * invocation tools) lives in `SourceDefinition.match.codex` and is resolved by
 * the `SourceDefinitionRegistry`; by the time a `CodexNormalizer` is looked up
 * (via `getCodexNormalizer(def.id)`), the source is already known. What stays
 * here is genuine transform logic the declarative DSL can't express: JSON
 * reshaping, ADF→text conversion, and the malformed-output recovery stitch.
 *
 * An LLM does NOT always fetch an entity directly — it commonly searches first
 * (`_search_issues`, `_list_*`, …) and the search result carries the entity,
 * often partial (id only in the URL). So `normalize` handles both a single
 * entity AND a search/list collection.
 *
 * Adding a newly-observed tool/shape = extend one binding file's `normalize`
 * (add a collection key, or a URL backfill) plus the registry's match identity;
 * never touch the parser.
 */

import type { SourceId } from "../../../../Types.js";

export interface CodexNormalizer {
	readonly id: SourceId;
	/** Stable synthetic tool name persisted as `Reference.toolName`/`sourceToolName`
	 *  (the connector's real tool name is mapped to this). Not a match guard —
	 *  the purified `SourceEngine.extractRef` no longer inspects tool names. */
	readonly canonicalToolName: string;
	/**
	 * Normalize the connector business payload — a single entity OR a search/list
	 * collection — into the shape the shared definition reads. `toolInput` is the
	 * parsed `function_call` `arguments` (undefined when absent); only sources that
	 * gate on their input read it (monday's `itemIds`). Every other binding ignores
	 * it. Implementations use {@link normalizeEntities} so both shapes are handled
	 * uniformly.
	 */
	normalize(business: unknown, toolInput?: unknown): unknown;

	/**
	 * OPTIONAL recovery — **not** the main path. The normal path is: parse the
	 * `function_call_output` JSON, normalize, extract. This hook fires ONLY when
	 * that parse FAILS (malformed JSON) yet a valid `mcp_tool_call_end` event for
	 * the SAME call exists — a last-ditch stitch of the two partial copies.
	 *
	 * Real case (Jira): the heavy-expand `function_call_output` is sometimes
	 * invalid JSON (one bad escape in the rich `renderedFields`/`changelog`), and
	 * it is the ONLY copy carrying the tenant `webUrl`. The `mcp_tool_call_end`
	 * event is valid JSON and carries `key` + the summary (in
	 * `versionedRepresentations`) but NOT `webUrl` (its `self` is the gateway URL).
	 * So `recover` reads the safe fields from the valid `eventPayload` and salvages
	 * just `webUrl` from the raw malformed string via a narrow regex.
	 *
	 * Returns the stitched payload, or `null` when nothing usable can be built.
	 * Bindings without this brittle edge omit it entirely.
	 */
	recover?(eventPayload: unknown, rawOutput: string): unknown;
}
