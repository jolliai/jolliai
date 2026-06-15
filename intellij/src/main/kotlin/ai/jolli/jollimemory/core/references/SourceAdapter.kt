package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject

/**
 * SourceAdapter — registry interface for multi-source MCP reference extraction.
 *
 * Each adapter (Linear / Jira / GitHub / Notion / …) implements two
 * independent concerns:
 *   1. [extractRef] — parse one MCP tool_result payload into a [Reference].
 *   2. [renderPromptBlock] — render a slice of refs into the XML block
 *      injected into the SUMMARIZE prompt.
 *
 * Adapters are agent-agnostic: they never recognise tool names. Source
 * recognition and tool-level business scope live in the producer bindings.
 */
interface SourceAdapter {
	/** Stable id matching the [Reference.source] field. */
	val id: SourceId
	/** Default cap on description size when rendering one reference. */
	val maxCharsPerReference: Int
	/**
	 * Top-level keys to descend into when the payload itself isn't a recognised
	 * reference (e.g. `{"items":[…]}` or `{"issues":{"nodes":[…]}}`).
	 */
	val wrapperKeys: List<String>

	/**
	 * Parse one MCP tool_result payload into a [Reference], or `null` if the
	 * payload shape isn't a valid reference. Adapters never throw on bad input.
	 */
	fun extractRef(payload: JsonObject, toolName: String, referencedAt: String): Reference?

	/**
	 * Render the prompt XML block for this source's refs. Return "" when the
	 * input is empty so the caller can skip writing an empty wrapper.
	 */
	fun renderPromptBlock(refs: List<Reference>, opts: RenderOptions = RenderOptions()): String
}

data class RenderOptions(
	val maxCharsPerReference: Int? = null,
	val maxTotalChars: Int? = null,
)
