package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import java.nio.file.Files
import java.nio.file.Path

/**
 * db → git first-bind migration writer.
 *
 * One-shot — runs only when `/credentials` reports `alreadyVaultBound === false`.
 * Backend's [LegacyDoc] list gets written into `<memoryBankRoot>/<doc.path>`,
 * idempotent under re-application (same path + same content = zero diff).
 *
 * Port of `cli/src/sync/LegacyMigration.ts`.
 */
class LegacyMigration(
	private val memoryBankRoot: String,
	private val transcripts: Boolean,
) {

	private val log = JmLogger.create("LegacyMigration")

	/**
	 * Writes legacy DB docs into `<memoryBankRoot>/<doc.path>`.
	 *
	 * Returns the number of files written (0 if [response] is already migrated
	 * or has no docs).
	 */
	fun apply(response: LegacyContentResponse): Int {
		if (response.alreadyMigrated || response.docs.isEmpty()) {
			return 0
		}
		var filesWritten = 0
		for (doc in response.docs) {
			if (doc.docType == "folder") continue
			val targetRel = mapLegacyDocToVaultPath(doc)
			if (!isAllowedPath(targetRel, AllowListOpts(syncTranscripts = transcripts))) {
				log.warn("apply: rejected by allow-list path=$targetRel id=${doc.id}")
				continue
			}
			val absPath = Path.of(memoryBankRoot, targetRel)

			// Idempotent re-apply: skip if target already has identical content.
			try {
				val existing = Files.readString(absPath)
				if (existing == doc.content) continue
			} catch (e: java.nio.file.NoSuchFileException) {
				// Missing — fall through to write.
			}

			Files.createDirectories(absPath.parent)
			Files.writeString(absPath, doc.content)
			filesWritten++
		}
		log.info("apply: wrote $filesWritten files from ${response.docs.size} docs")
		return filesWritten
	}
}

/**
 * Maps a [LegacyDoc] into the vault-relative on-disk path. The backend's
 * `path` field is the authoritative file path including filename + extension;
 * this function only sanitizes dot-segments and (when path is missing) falls
 * back to a slug-derived name.
 */
internal fun mapLegacyDocToVaultPath(doc: LegacyDoc): String {
	val sanitizedPath = sanitizeLegacyPath(doc.path)
	if (sanitizedPath.isNotEmpty()) return sanitizedPath
	val extension = pickExtensionForContentType(doc.contentType)
	return "${doc.slug.ifEmpty { "doc" }}$extension"
}

private fun pickExtensionForContentType(contentType: String): String {
	val ct = contentType.lowercase()
	return when {
		"markdown" in ct -> ".md"
		"json" in ct -> ".json"
		else -> ".md"
	}
}

private fun sanitizeLegacyPath(rawPath: String): String {
	return rawPath
		.split("/")
		.map { it.trim() }
		.filter { it.isNotEmpty() && it != "." && it != ".." }
		.joinToString("/")
}
