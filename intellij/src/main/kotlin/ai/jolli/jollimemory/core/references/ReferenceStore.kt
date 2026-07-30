package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.JmLogger
import java.io.File
import java.security.MessageDigest

/**
 * ReferenceStore — Kotlin port of ReferenceStore.ts
 *
 * Per-reference markdown I/O. Each reference is stored at
 * `<jolliMemoryDir>/references/<source>/<key>.md`. Frontmatter format:
 * YAML-style with JSON-encoded values. The `fields:` list holds one JSON
 * object per item. The body after `---` is the description.
 *
 * ── LIVE PRODUCTION SURFACE ──────────────────────────────────────────────
 * Only [readReferenceMarkdown] is called from `main/` today
 * ([ai.jolli.jollimemory.toolwindow.PlansPanel.buildReferencePopupContent]).
 * The write / render / delete / sanitize functions here are exercised by
 * `ReferenceStoreTest` only — the production write path moved to the CLI
 * (`SummaryStore.storeReferences`, `cli/src/core/references/ReferenceStore.ts`).
 * They are kept in-tree so the Kotlin format stays byte-for-byte aligned with
 * the CLI writer; any Kotlin caller that starts writing again picks up the
 * exact same layout the CLI already produces.
 */
object ReferenceStore {

	private val log = JmLogger.create("ReferenceStore")

	/** Absolute directory `<jolliMemoryDir>/references/<source>`. */
	fun referenceDir(cwd: String, source: SourceId): String {
		val dir = JmLogger.getJolliMemoryDir(cwd)
		return "$dir/references/${SourceIds.wireName(source)}"
	}

	/** Absolute path to the per-reference markdown file. */
	fun referencePath(cwd: String, source: SourceId, key: String): String =
		"${referenceDir(cwd, source)}/$key.md"

	/**
	 * Returns the safe file stem for a given source's nativeId — delegates to
	 * the canonical [SourceIds.pathKey] so any callers here and the bridge-side
	 * readers ([ai.jolli.jollimemory.bridge.FolderStorageReader],
	 * [ai.jolli.jollimemory.bridge.SummaryReader]) cannot drift.
	 *
	 * Kept alongside [writeReferenceMarkdown] / [renderMarkdown] as test-only
	 * infrastructure — the production write path lives in the CLI's
	 * `SummaryStore.storeReferences` (see AGENTS.md's "FolderStorage
	 * hidden-layer schema stays in lockstep" note); the read path here that IS
	 * production-live is [readReferenceMarkdown]. This function's behavior
	 * still has to match the CLI writer byte-for-byte, which is why it stays.
	 *
	 * Before delegating, keeps the strict path-traversal guard for
	 * `nativeIdPathSafe: true` sources (linear / jira / notion / …) — the
	 * shared helper falls through to identity for those, but a Linear id
	 * carrying `..` would still point at data any hypothetical writer must
	 * refuse (locked down by [ReferenceStoreTest]). The unsafe sources
	 * (github / context7) always go through the sanitize+sha8 branch, where
	 * `/` and `#` are folded and no traversal can survive.
	 */
	fun sanitizeNativeIdForPath(source: SourceId, nativeId: String): String {
		if (!SourceIds.isPathUnsafe(source)) {
			if (".." in nativeId || Regex("[/\\\\]").containsMatchIn(nativeId)) {
				throw IllegalArgumentException("Refusing unsafe ${source.name} nativeId for path: \"$nativeId\"")
			}
		}
		return SourceIds.pathKey(source, nativeId)
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
		// Use the wire name (with hyphen for zoom_doc/zoom_meeting) so the file
		// this writer emits parses cleanly through both the Kotlin parseMarkdown
		// above and the TS ReferenceStore.parseMarkdown that VSCode reads.
		lines.add("source: ${jsonString(SourceIds.wireName(ref.source))}")
		lines.add("nativeId: ${jsonString(ref.nativeId)}")
		lines.add("title: ${jsonString(ref.title)}")
		// url is optional (Slack can be linkless): omit the line entirely when absent
		// so parseMarkdown reads it back as null rather than an empty string.
		val url = ref.url
		if (!url.isNullOrEmpty()) lines.add("url: ${jsonString(url)}")
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
		// Lenient: accepts hyphenated ids like `zoom-doc` and returns null for
		// sources this enum hasn't caught up with yet. The caller (Reference
		// popup preview) handles the null-source path via SourceDisplay.unknown().
		val source = SourceIds.parse(sourceStr) ?: return null
		val nativeId = readString("nativeId") ?: return null
		val title = readString("title") ?: return null
		// url is optional (Slack can be linkless) — a missing url does not void the reference.
		val url = readString("url")
		val referencedAt = readString("referencedAt") ?: return null
		val sourceToolName = readString("sourceToolName") ?: return null

		return Reference(
			mapKey = "${SourceIds.wireName(source)}:$nativeId",
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
