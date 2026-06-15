package ai.jolli.jollimemory.core.references

/**
 * XML escape helpers for prompt-block rendering.
 *
 * Two functions cover the two contexts in prompt XML blocks:
 *   - [escapeForAttr]: attribute values — escapes &, <, >, ", '
 *   - [escapeForText]: element text content — escapes &, <, >
 */
object PromptXmlEscape {

	/** Escape XML attribute value: &, <, >, ", ' */
	fun escapeForAttr(s: String): String = s
		.replace("&", "&amp;")
		.replace("<", "&lt;")
		.replace(">", "&gt;")
		.replace("\"", "&quot;")
		.replace("'", "&apos;")

	/** Escape XML element text content: &, <, > (preserves " and ' as text) */
	fun escapeForText(s: String): String = s
		.replace("&", "&amp;")
		.replace("<", "&lt;")
		.replace(">", "&gt;")
}
