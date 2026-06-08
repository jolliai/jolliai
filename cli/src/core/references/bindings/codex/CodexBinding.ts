/**
 * CodexBinding — one cohesive declaration per `codex_apps` connector source of
 * how Codex's rollout payloads map onto a shared `SourceAdapter`.
 *
 * This is the Codex MCP **producer** binding. An LLM does NOT always fetch an
 * entity directly — it commonly searches first (`_search_issues`, `_list_*`, …)
 * and the search result carries the entity, often partial (id only in the URL).
 * So each source declares the tool identities it is reached through (fetch AND
 * search), the canonical tool name persisted as `sourceToolName`, and how to
 * normalize its payload (single entity OR collection) into canonical shape.
 *
 * Adding a newly-observed tool/shape = extend one binding file (add a tool name,
 * a collection key, or a URL backfill), never touch the parser.
 */

import type { SourceId } from "../../../../Types.js";

export interface CodexBinding {
	readonly id: SourceId;
	/** namespace suffix after the shared `mcp__codex_apps__` prefix (e.g. "github", "atlassian_rovo"). */
	readonly namespaceSuffix: string;
	/** `function_call` short `name`s this source resolves entities through (fetch + search). */
	readonly functionCallNames: ReadonlySet<string>;
	/** `mcp_tool_call_end` `invocation.tool`s for the same set of operations. */
	readonly invocationTools: ReadonlySet<string>;
	/** Stable synthetic tool name persisted as `Reference.toolName`/`sourceToolName`
	 *  (the connector's real tool name is mapped to this). Not an adapter guard —
	 *  the purified adapter no longer inspects tool names. */
	readonly canonicalToolName: string;
	/**
	 * Normalize the connector business payload — a single entity OR a search/list
	 * collection — into the shape the shared adapter reads. Implementations use
	 * {@link normalizeEntities} so both shapes are handled uniformly.
	 */
	normalize(business: unknown): unknown;

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
