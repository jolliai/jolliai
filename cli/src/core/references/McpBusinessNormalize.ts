/**
 * McpBusinessNormalize — the shared MCP business-payload normalizer.
 *
 * Extracted verbatim from ClaudeEnvelopeParser so that any agent whose MCP calls
 * use the Claude-style `mcp__<server>__<tool>` naming (Claude itself, and Kimi
 * Code CLI, which uses the identical scheme) can normalise a tool result WITHOUT
 * a divergent second copy of the context-normalizer machinery.
 *
 * The MCP payload for a given tool is identical regardless of which agent fired
 * it, so the normalisation is genuinely source-agnostic: the only source-specific
 * concern is the transcript ENVELOPE (how a line encodes "a call + its result"),
 * which stays in each `TranscriptEnvelopeParser`.
 *
 * `normalizeMcpBusiness` is the single entry point:
 *   - identity (returns `parsedPayload` unchanged) when the def has no
 *     context-normalizer — the common case, matching the old `identity` hook;
 *   - the registered context-normalizer otherwise (Slack / zoom-doc / confluence /
 *     monday / context7 / jollimemory), which may return `null` to VOID the
 *     reference.
 *
 * `CONTEXT_NORMALIZER_IDS` is exported too: the Claude parser reads it to decide
 * whether to retain a tool_use's `input` (only context sources need it), and it
 * is the membership gate a caller uses to tell a context source from an
 * identity one.
 */

import type { FigmaLink } from "./FigmaLink.js";
import { isObject } from "./guards.js";
import type { SourceDefinition } from "./SourceDefinition.js";
import { normalizeConfluence } from "./sources/ConfluenceNormalize.js";
import { normalizeContext7 } from "./sources/Context7Normalize.js";
import { normalizeFigma } from "./sources/FigmaNormalize.js";
import { normalizeJolliMemory } from "./sources/JolliMemoryNormalize.js";
import { normalizeMonday, readItemIds } from "./sources/MondayNormalize.js";
import { normalizeSentry } from "./sources/SentryNormalize.js";
import { normalizeSlackThread } from "./sources/SlackNormalize.js";
import { normalizeZoomDoc } from "./sources/ZoomDocNormalize.js";
import type { ExtractOptions } from "./TranscriptEnvelopeParser.js";

/** `{channel_id, message_ts}` off a Slack tool_use's `input`, or undefined if malformed. */
function readSlackToolInput(input: unknown): { channelId: string; messageTs: string } | undefined {
	/* v8 ignore start -- defensive: real `slack_read_thread` tool_use input always carries both string fields; guarded for totality against a malformed/future MCP shape. */
	if (!isObject(input)) return undefined;
	const channelId = (input as { channel_id?: unknown }).channel_id;
	const messageTs = (input as { message_ts?: unknown }).message_ts;
	if (typeof channelId !== "string" || typeof messageTs !== "string") return undefined;
	/* v8 ignore stop */
	return { channelId, messageTs };
}

/** `{fileId}` off a zoom-doc tool_use's `input`, or undefined if malformed. */
function readZoomDocToolInput(input: unknown): { fileId: string } | undefined {
	/* v8 ignore start -- defensive: real `hub_get_file_content` tool_use input always carries fileId; guarded for totality against a malformed/future MCP shape. */
	if (!isObject(input)) return undefined;
	const fileId = (input as { fileId?: unknown }).fileId;
	if (typeof fileId !== "string" || fileId.length === 0) return undefined;
	/* v8 ignore stop */
	return { fileId };
}

/**
 * Parse-scoped context a context-aware normalizer may read beyond the tool
 * result payload: the pasted-permalink map and the caller's `ExtractOptions`
 * (workspace url, etc.).
 */
interface ContextNormalizeEnv {
	readonly permalinks: Map<string, string>;
	readonly opts: ExtractOptions;
	/**
	 * The MCP tool name that produced this call. A source matching a SINGLE tool can
	 * ignore it (every source here does today). A source matching several tools of one
	 * server cannot always recover which one fired from the arguments alone — two tools
	 * may take no arguments at all, making their inputs byte-identical — so the name
	 * has to be threaded rather than inferred.
	 */
	readonly toolName: string;
	/**
	 * Figma links the user pasted, keyed by the key the TOOL CALL carries (the branch
	 * key for a branch link). OPTIONAL and DISPLAY-ONLY: a producer that has not wired
	 * the scan omits it and every Figma reference still gets a working url built from
	 * the file key alone — only the title falls back to a synthesized label.
	 */
	readonly figmaLinks?: ReadonlyMap<string, FigmaLink>;
	/**
	 * The RAW result text, supplied only for an `argumentsDerived` source — whose result
	 * is prose the parser would otherwise discard after `JSON.parse` fails.
	 *
	 * OPTIONAL and DISPLAY-ONLY. A producer that has not wired it omits it (the Kimi
	 * parser does), and every reference is still complete: identity, dedupe and the url
	 * are built from the ARGUMENTS alone. Only a display field degrades — sentry's title
	 * falls back from the error description to `Issue <id>`.
	 *
	 * Nothing that decides identity may read this. A best-effort parse that succeeds
	 * sometimes would otherwise split one entity across two nativeIds.
	 */
	readonly rawResultText?: string;
}

/**
 * Closed registry of context-aware normalizers, keyed by source id. A source
 * belongs here IFF the default `identity` path cannot produce its canonical
 * shape — either because that shape needs out-of-payload context (the
 * originating tool_use `input`, and/or parse-scoped state like the permalink
 * map / workspace url), OR because it requires a payload-internal shape
 * coercion the DSL cannot express (e.g. Confluence's ADF-object → string body
 * flattening). Every other MCP source's `normalize` is `identity` and never
 * appears here.
 *
 * Returning null voids the reference. Adding a fourth such source is one entry
 * here, not a new `def.id === …` branch in the caller.
 */
const CONTEXT_NORMALIZERS: Record<
	string,
	(payload: unknown, toolInput: unknown, env: ContextNormalizeEnv) => object | null
> = {
	slack: (payload, toolInput, env) => {
		const slackInput = readSlackToolInput(toolInput);
		/* v8 ignore start -- defensive: paired with a real slack_read_thread tool_use, input is always well-formed. */
		if (slackInput === undefined) return null;
		/* v8 ignore stop */
		const { channelId, messageTs } = slackInput;
		const url =
			env.permalinks.get(`${channelId}:${messageTs}`) ??
			(env.opts.slackWorkspaceUrl !== undefined
				? `${env.opts.slackWorkspaceUrl}/archives/${channelId}/p${messageTs.replace(".", "")}`
				: undefined);
		return normalizeSlackThread(payload, { channelId, url });
	},
	"zoom-doc": (payload, toolInput) => {
		const zoomInput = readZoomDocToolInput(toolInput);
		/* v8 ignore start -- defensive: paired with a real hub_get_file_content tool_use, input is always well-formed. */
		if (zoomInput === undefined) return null;
		/* v8 ignore stop */
		return normalizeZoomDoc(payload, { fileId: zoomInput.fileId });
	},
	confluence: (payload) => normalizeConfluence(payload),
	monday: (payload, toolInput) => normalizeMonday(payload, { itemIds: readItemIds(toolInput) }),
	context7: (_payload, toolInput) => normalizeContext7(toolInput),
	// The only normalizer that reads `env.toolName`: this source matches three tools,
	// and a bare `recall()` arrives with the same empty input as the tools it must NOT
	// capture, so the name is the only thing that can distinguish them.
	jollimemory: (_payload, toolInput, env) => normalizeJolliMemory(toolInput, env.toolName),
	// Reads the tool name (five tools, and a nodeId-less `get_metadata` is shape-
	// identical to nothing else) plus the harvested pasted-link map, which is
	// display-only — the url is derivable from the arguments alone.
	figma: (_payload, toolInput, env) => normalizeFigma(toolInput, env.toolName, env.figmaLinks),
	// Registered here for the load-bearing reason, not merely because it needs the input:
	// `CONTEXT_NORMALIZER_IDS` is what makes the Claude parser retain `toolInput` at all.
	// A definition that sets `argumentsDerived` WITHOUT an entry here gets `{}` as its
	// payload AND `undefined` as its input — it extracts nothing, forever, with no error
	// anywhere.
	//
	// Reads the tool name (two tools spelling the same fact with different argument keys)
	// and the raw prose result, which is display-only — see `SentryNormalize`.
	sentry: (_payload, toolInput, env) => normalizeSentry(toolInput, env.toolName, env.rawResultText),
};

/**
 * Own-key ids of {@link CONTEXT_NORMALIZERS}. Membership is checked through this
 * set (own enumerable keys only) so a prototype-chain id (`toString`,
 * `constructor`) can never resolve a normalizer — the same closed-registry
 * boundary as SourceEngine's `TRANSFORM_NAMES`.
 */
export const CONTEXT_NORMALIZER_IDS: ReadonlySet<string> = new Set(Object.keys(CONTEXT_NORMALIZERS));

/**
 * Parse-scoped context passed to {@link normalizeMcpBusiness}. Identical to
 * {@link ContextNormalizeEnv} minus `toolName`, which the helper threads in
 * from its own argument.
 */
export interface McpNormalizeEnv {
	readonly permalinks: Map<string, string>;
	readonly opts: ExtractOptions;
	/** See {@link ContextNormalizeEnv.figmaLinks} — optional, display-only. */
	readonly figmaLinks?: ReadonlyMap<string, FigmaLink>;
	/** See {@link ContextNormalizeEnv.rawResultText} — optional, display-only. */
	readonly rawResultText?: string;
}

/**
 * Normalize one MCP tool result's business payload to its canonical shape.
 *
 * Identity (returns `parsedPayload`) when `def` has no registered
 * context-normalizer; runs the context-normalizer otherwise. Returns `null`
 * only when a context-normalizer voided the reference — an identity result is
 * never null.
 */
export function normalizeMcpBusiness(
	def: SourceDefinition,
	toolName: string,
	toolInput: unknown,
	parsedPayload: unknown,
	env: McpNormalizeEnv,
): unknown | null {
	const contextNormalize = CONTEXT_NORMALIZER_IDS.has(def.id) ? CONTEXT_NORMALIZERS[def.id] : undefined;
	if (contextNormalize === undefined) return parsedPayload;
	return contextNormalize(parsedPayload, toolInput, { ...env, toolName });
}
