package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.JmLogger

/**
 * Renders reference data into XML prompt blocks for LLM summarization.
 *
 * Each source gets its own wrapper tag (e.g. `<linear-issues>`, `<jira-issues>`,
 * `<github-issues>`, `<notion-pages>`) containing per-item elements.
 * Budget-constrained: newest references are prioritized within per-source limits.
 *
 * Port of CLI's per-adapter `renderPromptBlock` + `assembleReferenceBlocks`.
 */
object PromptRenderer {

	private val log = JmLogger.create("PromptRenderer")
	private const val DEFAULT_MAX_CHARS_PER_REF = 4000
	private const val DEFAULT_MAX_TOTAL_CHARS = 30000

	// ── XML escaping ────────────────────────────────────────────────────────

	/** Escape XML attribute value: &, <, >, ", ' */
	fun escapeForAttr(s: String): String {
		return s
			.replace("&", "&amp;")
			.replace("<", "&lt;")
			.replace(">", "&gt;")
			.replace("\"", "&quot;")
			.replace("'", "&apos;")
	}

	/** Escape XML element text content: &, <, > */
	fun escapeForText(s: String): String {
		return s
			.replace("&", "&amp;")
			.replace("<", "&lt;")
			.replace(">", "&gt;")
	}

	private fun truncate(s: String, max: Int): String {
		if (s.length <= max) return s
		return "${s.take(max)}\n…[truncated, ${s.length - max} more chars]"
	}

	// ── Per-item rendering ──────────────────────────────────────────────────

	/** Render a single issue-like reference (Linear, Jira, GitHub) as XML. */
	private fun renderIssue(ref: Reference, maxChars: Int): String {
		val attrs = mutableListOf("id=\"${escapeForAttr(ref.nativeId)}\"")
		for (f in ref.fields ?: emptyList()) {
			attrs.add("${f.key}=\"${escapeForAttr(f.value)}\"")
		}
		val lines = mutableListOf("<issue ${attrs.joinToString(" ")}>")
		lines.add("  <title>${escapeForText(ref.title)}</title>")
		lines.add("  <url>${escapeForText(ref.url.orEmpty())}</url>")
		if (ref.description != null) {
			lines.add("  <description>")
			lines.add(escapeForText(truncate(ref.description, maxChars)))
			lines.add("  </description>")
		}
		lines.add("</issue>")
		return lines.joinToString("\n")
	}

	/** Render a Slack thread reference as XML. `url` may be absent (linkless thread). */
	private fun renderThread(ref: Reference, maxChars: Int): String {
		val attrs = mutableListOf("id=\"${escapeForAttr(ref.nativeId)}\"")
		for (f in ref.fields ?: emptyList()) {
			attrs.add("${f.key}=\"${escapeForAttr(f.value)}\"")
		}
		val lines = mutableListOf("<thread ${attrs.joinToString(" ")}>")
		lines.add("  <title>${escapeForText(ref.title)}</title>")
		if (!ref.url.isNullOrEmpty()) lines.add("  <url>${escapeForText(ref.url)}</url>")
		if (ref.description != null) {
			lines.add("  <messages>")
			lines.add(escapeForText(truncate(ref.description, maxChars)))
			lines.add("  </messages>")
		}
		lines.add("</thread>")
		return lines.joinToString("\n")
	}

	/** Render a Notion page reference as XML. */
	private fun renderPage(ref: Reference, maxChars: Int): String {
		val lines = mutableListOf("<page id=\"${escapeForAttr(ref.nativeId)}\">")
		lines.add("  <title>${escapeForText(ref.title)}</title>")
		lines.add("  <url>${escapeForText(ref.url.orEmpty())}</url>")
		if (ref.description != null) {
			lines.add("  <content>")
			lines.add(escapeForText(truncate(ref.description, maxChars)))
			lines.add("  </content>")
		}
		lines.add("</page>")
		return lines.joinToString("\n")
	}

	// ── Per-source block rendering ──────────────────────────────────────────

	private data class SourceConfig(
		val wrapperTag: String,
		val renderer: (Reference, Int) -> String,
	)

	private val SOURCE_CONFIGS = mapOf(
		SourceId.linear to SourceConfig("linear-issues", ::renderIssue),
		SourceId.jira to SourceConfig("jira-issues", ::renderIssue),
		SourceId.github to SourceConfig("github-issues", ::renderIssue),
		SourceId.notion to SourceConfig("notion-pages", ::renderPage),
		SourceId.slack to SourceConfig("slack-threads", ::renderThread),
	)

	/** Render all references for a single source into an XML block. */
	fun renderPromptBlock(
		refs: List<Reference>,
		source: SourceId,
		maxCharsPerRef: Int = DEFAULT_MAX_CHARS_PER_REF,
		maxTotalChars: Int = DEFAULT_MAX_TOTAL_CHARS,
	): String {
		if (refs.isEmpty()) return ""
		val config = SOURCE_CONFIGS[source] ?: return ""

		// Newest first for budget selection
		val sorted = refs.sortedBy { it.referencedAt }
		val reversed = sorted.reversed()

		val selected = mutableListOf<Reference>()
		var total = 0
		for (r in reversed) {
			val rendered = config.renderer(r, maxCharsPerRef)
			if (total + rendered.length > maxTotalChars) break
			selected.add(r)
			total += rendered.length
		}
		if (selected.isEmpty()) return ""

		// Restore chronological order
		selected.reverse()

		val items = selected.joinToString("\n") { config.renderer(it, maxCharsPerRef) }
		return "<${config.wrapperTag}>\n$items\n</${config.wrapperTag}>"
	}

	// ── Full assembly ───────────────────────────────────────────────────────

	/** Source ordering for prompt blocks — matches CLI's ALL_ADAPTERS order. */
	private val SOURCE_ORDER = listOf(SourceId.linear, SourceId.jira, SourceId.github, SourceId.notion, SourceId.slack)

	/**
	 * Load reference markdown files, parse back to [Reference], filter exclusions,
	 * group by source, and render one XML block per source.
	 *
	 * Returns the joined blocks string ready for the `referenceBlocks` prompt parameter.
	 */
	fun assembleReferenceBlocks(
		entries: Map<String, ReferenceEntry>,
		excludedKeys: Set<String> = emptySet(),
	): String {
		// Filter excluded, read markdown, parse to Reference, group by source
		val refsBySource = mutableMapOf<SourceId, MutableList<Reference>>()

		for ((mapKey, entry) in entries) {
			if (mapKey in excludedKeys) continue
			val ref = ReferenceStore.readReferenceMarkdown(entry.sourcePath) ?: continue
			refsBySource.getOrPut(ref.source) { mutableListOf() }.add(ref)
		}

		val parts = mutableListOf<String>()
		for (source in SOURCE_ORDER) {
			val refs = refsBySource[source] ?: continue
			val block = renderPromptBlock(refs, source)
			if (block.isNotEmpty()) parts.add(block)
		}

		val result = parts.joinToString("\n")
		if (result.isNotEmpty()) {
			log.info("Assembled reference blocks: %d source(s), %d chars", parts.size, result.length)
		}
		return result
	}
}
