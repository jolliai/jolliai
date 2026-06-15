package ai.jolli.jollimemory.core.references

/**
 * HTML entity decoder used by GitHubAdapter.
 *
 * Scope of decode (intentionally narrow):
 *   - Named entities: a fixed 5-entry table (amp, lt, gt, quot, apos).
 *   - Hex numeric: `&#xNN…;` (lowercase `x` only). Range-guarded.
 *   - Decimal numeric: `&#DD…;`, same range guard.
 *
 * Unknown named entities pass through unchanged.
 */
object HtmlEntities {

	private val NAMED = mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'")

	private val ENTITY_RE = Regex("&(#x[0-9a-fA-F]+|#\\d+|[a-zA-Z]+);")

	private fun isDecodableCodePoint(cp: Int): Boolean =
		cp in 0..0x10FFFF && cp !in 0xD800..0xDFFF

	fun decode(s: String): String = ENTITY_RE.replace(s) { match ->
		val body = match.groupValues[1]
		when {
			body.startsWith("#x") -> {
				val cp = body.substring(2).toIntOrNull(16)
				if (cp != null && isDecodableCodePoint(cp)) String(intArrayOf(cp), 0, 1)
				else match.value
			}
			body.startsWith("#") -> {
				val cp = body.substring(1).toIntOrNull(10)
				if (cp != null && isDecodableCodePoint(cp)) String(intArrayOf(cp), 0, 1)
				else match.value
			}
			else -> NAMED[body] ?: match.value
		}
	}
}
