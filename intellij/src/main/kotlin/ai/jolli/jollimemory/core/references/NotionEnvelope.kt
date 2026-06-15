package ai.jolli.jollimemory.core.references

/**
 * Notion XML envelope parser used by NotionAdapter.
 *
 * `notion-fetch` returns a `text` field wrapping the page body inside:
 *
 *     <page>
 *       <title>Page title</title>
 *       <content>{markdown body}</content>
 *     </page>
 *
 * We only need the `<content>…</content>` body. Malformed input returns
 * empty content. The parser never throws.
 */
object NotionEnvelope {

	private val CONTENT_BLOCK_RE = Regex("<content\\b[^>]*>([\\s\\S]*?)</content>")

	data class Parsed(val content: String)

	fun parse(text: String?): Parsed {
		if (text.isNullOrEmpty()) return Parsed("")
		val m = CONTENT_BLOCK_RE.find(text) ?: return Parsed("")
		return Parsed(m.groupValues[1])
	}
}
