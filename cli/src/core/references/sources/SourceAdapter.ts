/**
 * SourceAdapter — registry interface for multi-source MCP reference extraction.
 *
 * Each `SourceAdapter` (Linear / Jira / GitHub / Notion / …) implements two
 * independent concerns:
 *   1. `extractRef` — parse one MCP tool_result payload into a `Reference`.
 *   2. `renderPromptBlock` — render a slice of refs into the XML block
 *      injected into the SUMMARIZE prompt.
 *
 * The extractor main loop (cli/src/core/references/ReferenceExtractor.ts) is the
 * shared driver — adapters never call each other and never share helpers
 * (HTML-entity decoding, XML envelope stripping, field-name mapping live
 * inside each adapter).
 */

import type { Reference, SourceId } from "../../../Types.js";

export interface RenderOptions {
	readonly maxCharsPerReference?: number;
	readonly maxTotalChars?: number;
}

export interface SourceAdapter {
	/** Stable id matching the `Reference.source` field. */
	readonly id: SourceId;
	/** MCP tool name prefix used to short-circuit non-matching tool_use lines. */
	readonly mcpPrefix: string;
	/** Default cap on description size when rendering one reference. Adapter-specific. */
	readonly maxCharsPerReference: number;
	/**
	 * Parse one MCP tool_result payload. Return `null` if the payload is not
	 * recognised (wrong shape, wrong tool, validation failed). Caller filters
	 * `null`s — adapters never throw on bad input.
	 */
	extractRef(payload: unknown, toolName: string, referencedAt: string): Reference | null;
	/**
	 * Top-level keys to descend into when the payload itself isn't a recognised
	 * reference (e.g. `{"items":[…]}` or `{"issues":{"nodes":[…]}}`). The walker
	 * tries each key in order; first array/object match wins.
	 */
	readonly wrapperKeys: ReadonlyArray<string>;
	/**
	 * Render the prompt XML block for this source's refs. Return "" when the
	 * input is empty so the caller can skip writing an empty wrapper.
	 */
	renderPromptBlock(refs: ReadonlyArray<Reference>, opts?: RenderOptions): string;
}
