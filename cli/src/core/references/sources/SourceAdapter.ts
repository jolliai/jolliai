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
	/** Default cap on description size when rendering one reference. Adapter-specific. */
	readonly maxCharsPerReference: number;
	/**
	 * Parse one MCP tool_result payload into a `Reference`, or `null` if the
	 * payload shape isn't a valid reference. The adapter is agent-agnostic and
	 * does NOT recognise tool names — source recognition and tool-level business
	 * scope live in the producer bindings; by the time `extractRef` runs the
	 * source is already known, so this is a pure shape check. `toolName` is still
	 * passed through to `Reference.toolName`. Adapters never throw on bad input.
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
