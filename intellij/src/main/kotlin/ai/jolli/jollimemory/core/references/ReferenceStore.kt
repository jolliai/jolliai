package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.JmLogger
import java.io.File
import java.security.MessageDigest

/**
 * ReferenceStore — Kotlin port of ReferenceStore.ts
 *
 * Per-reference markdown I/O: write, read, parse, hash, delete.
 * Each reference is stored at `<jolliMemoryDir>/references/<source>/<key>.md`.
 *
 * Frontmatter format: YAML-style with JSON-encoded values. The `fields:` list
 * holds one JSON object per item. The body after `---` is the description.
 */
object ReferenceStore {

	private val log = JmLogger.create("ReferenceStore")

	/** Absolute directory `<jolliMemoryDir>/references/<source>`. */
	fun referenceDir(cwd: String, source: SourceId): String {
		val dir = JmLogger.getJolliMemoryDir(cwd)
		return "$dir/references/${source.name}"
	}

	/** Absolute path to the per-reference markdown file. */
	fun referencePath(cwd: String, source: SourceId, key: String): String =
		"${referenceDir(cwd, source)}/$key.md"

	/**
	 * Returns the safe file stem for a given source's nativeId.
	 *
	 * Linear / Jira / Notion: identity (filesystem-safe).
	 * GitHub: `<owner>/<repo>#<n>` → replace unsafe chars + sha256 suffix.
	 */
	fun sanitizeNativeIdForPath(source: SourceId, nativeId: String): String {
		if (source == SourceId.github) {
			val safe = nativeId.replace(Regex("[^\\w.-]"), "-")
			val suffix = sha256(nativeId).substring(0, 8)
			return "$safe-$suffix"
		}
		// linear / jira / notion: identity, with path-traversal guard.
		if (".." in nativeId || Regex("[/\\\\]").containsMatchIn(nativeId)) {
			throw IllegalArgumentException("Refusing unsafe ${source.name} nativeId for path: \"$nativeId\"")
		}
		return nativeId
	}

	data class WriteResult(val sourcePath: String, val contentHash: String)

	/**
	 * Write or overwrite `<jolliMemoryDir>/references/<source>/<key>.md`.
	 * Idempotent: skips write if content unchanged.
	 */
	fun writeReferenceMarkdown(ref: Reference, cwd: String): WriteResult {
		val key = sanitizeNativeIdForPath(ref.source, ref.nativeId)
		val sourcePath = referencePath(cwd, ref.source, key)
		val content = renderMarkdown(ref)
		val contentHash = hashReferenceContent(ref)

		val file = File(sourcePath)
		val existing = try { file.readText(Charsets.UTF_8) } catch (_: Exception) { null }
		if (existing == content) {
			log.debug("Reference markdown unchanged, skipping write: %s", sourcePath)
			return WriteResult(sourcePath, contentHash)
		}

		file.parentFile.mkdirs()
		file.writeText(content, Charsets.UTF_8)
		log.debug("Wrote reference markdown: %s (%d chars)", sourcePath, content.length)
		return WriteResult(sourcePath, contentHash)
	}

	/**
	 * Read and parse a reference markdown file. Returns null if missing or malformed.
	 */
	fun readReferenceMarkdown(sourcePath: String): Reference? {
		val content = try { File(sourcePath).readText(Charsets.UTF_8) } catch (_: Exception) { return null }
		return parseMarkdown(content)
	}

	/** Parse a reference markdown string (e.g. from orphan branch). */
	fun readReferenceMarkdownFromString(content: String): Reference? = parseMarkdown(content)

	/**
	 * SHA-256 of the rendered markdown with referencedAt zeroed.
	 * Used as the contentHashAtCommit guard.
	 */
	fun hashReferenceContent(ref: Reference): String =
		sha256(renderMarkdown(ref.copy(referencedAt = "")))

	/** Best-effort delete of a reference markdown file. */
	fun deleteReferenceMarkdown(sourcePath: String) {
		File(sourcePath).delete()
	}

	/** Read raw markdown bytes from a file. Returns null on error. */
	fun readMarkdownFileContent(sourcePath: String): String? =
		try { File(sourcePath).readText(Charsets.UTF_8) } catch (_: Exception) { null }

	// ── Markdown rendering / parsing ────────────────────────────────────────

	private fun stripBodyEdges(body: String): String =
		body.replace(Regex("^\\n+"), "").replace(Regex("\\n+$"), "")

	internal fun renderMarkdown(ref: Reference): String {
		val lines = mutableListOf("---")
		lines.add("source: ${jsonString(ref.source.name)}")
		lines.add("nativeId: ${jsonString(ref.nativeId)}")
		lines.add("title: ${jsonString(ref.title)}")
		lines.add("url: ${jsonString(ref.url)}")
		if (!ref.fields.isNullOrEmpty()) {
			lines.add("fields:")
			for (f in ref.fields) lines.add("  - ${jsonField(f)}")
		}
		lines.add("referencedAt: ${jsonString(ref.referencedAt)}")
		lines.add("sourceToolName: ${jsonString(ref.toolName)}")
		lines.add("---")
		lines.add("")
		if (ref.description != null) {
			val body = stripBodyEdges(ref.description)
			if (body.isNotEmpty()) lines.add(body)
		}
		return lines.joinToString("\n") + "\n"
	}

	private fun parseMarkdown(content: String): Reference? {
		val lines = content.split("\n")
		if (lines.firstOrNull()?.trim() != "---") return null
		var closingIdx = -1
		for (i in 1 until lines.size) {
			if (lines[i].trim() == "---") { closingIdx = i; break }
		}
		if (closingIdx == -1) return null

		val frontmatter = lines.subList(1, closingIdx)
		val body = stripBodyEdges(lines.subList(closingIdx + 1, lines.size).joinToString("\n"))

		val scalars = mutableMapOf<String, String>()
		val refFields = mutableListOf<ReferenceField>()
		var inFieldsList = false

		for (line in frontmatter) {
			if (inFieldsList) {
				val m = Regex("^\\s+- (.+)$").find(line)
				if (m != null) {
					try {
						val parsed = com.google.gson.JsonParser.parseString(m.groupValues[1])
						if (parsed.isJsonObject) {
							val obj = parsed.asJsonObject
							val key = obj.get("key")?.takeIf { it.isJsonPrimitive }?.asString
							val label = obj.get("label")?.takeIf { it.isJsonPrimitive }?.asString
							val value = obj.get("value")?.takeIf { it.isJsonPrimitive }?.asString
							val icon = obj.get("icon")?.takeIf { it.isJsonPrimitive }?.asString
							if (key != null && label != null && value != null && Regex("^[\\w-]+$").matches(key)) {
								refFields.add(ReferenceField(key, label, value, icon))
							}
						}
					} catch (_: Exception) { /* skip malformed */ }
					continue
				}
				inFieldsList = false
			}
			if (line.trim() == "fields:") { inFieldsList = true; continue }
			val kv = Regex("^([a-zA-Z]+):\\s*(.+)$").find(line) ?: continue
			scalars[kv.groupValues[1]] = kv.groupValues[2]
		}

		fun readString(key: String): String? {
			val raw = scalars[key] ?: return null
			return try {
				val v = com.google.gson.JsonParser.parseString(raw)
				if (v.isJsonPrimitive && v.asJsonPrimitive.isString) v.asString else null
			} catch (_: Exception) { null }
		}

		val sourceStr = readString("source") ?: return null
		val source = try { SourceId.valueOf(sourceStr) } catch (_: Exception) { return null }
		val nativeId = readString("nativeId") ?: return null
		val title = readString("title") ?: return null
		val url = readString("url") ?: return null
		val referencedAt = readString("referencedAt") ?: return null
		val sourceToolName = readString("sourceToolName") ?: return null

		return Reference(
			mapKey = "${source.name}:$nativeId",
			source = source,
			nativeId = nativeId,
			title = title,
			url = url,
			referencedAt = referencedAt,
			toolName = sourceToolName,
			fields = refFields.takeIf { it.isNotEmpty() },
			description = body.takeIf { it.isNotEmpty() },
		)
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	private fun sha256(s: String): String {
		val digest = MessageDigest.getInstance("SHA-256")
		return digest.digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
	}

	/** JSON-encode a string value for frontmatter. */
	private fun jsonString(s: String): String {
		val sb = StringBuilder("\"")
		for (c in s) {
			when (c) {
				'"' -> sb.append("\\\"")
				'\\' -> sb.append("\\\\")
				'\n' -> sb.append("\\n")
				'\r' -> sb.append("\\r")
				'\t' -> sb.append("\\t")
				else -> sb.append(c)
			}
		}
		sb.append('"')
		return sb.toString()
	}

	/** JSON-encode a ReferenceField for the fields: list. */
	private fun jsonField(f: ReferenceField): String {
		val parts = mutableListOf<String>()
		parts.add("\"key\":${jsonString(f.key)}")
		parts.add("\"label\":${jsonString(f.label)}")
		parts.add("\"value\":${jsonString(f.value)}")
		if (f.icon != null) parts.add("\"icon\":${jsonString(f.icon)}")
		return "{${parts.joinToString(",")}}"
	}
}
