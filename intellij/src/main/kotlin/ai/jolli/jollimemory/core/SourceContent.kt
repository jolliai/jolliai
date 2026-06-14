package ai.jolli.jollimemory.core

import com.google.gson.Gson
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/**
 * SourceContent — projects a [SourceRef] into the two shapes the ingest pipeline
 * needs: a one-line `headline` (route classifier) and the full `content` body
 * (per-page reconcile).
 *
 * Kotlin port of `cli/src/core/SourceContent.ts`. The TS orphan-only fallbacks
 * (plans.json registry / cwd-based scan) are omitted: the compile path always
 * has a folder `kbRoot`.
 */
object SourceContent {

    private val log = JmLogger.create("SourceContent")
    private val gson = Gson()

    /** Splits a userfile id (`<path>@<fingerprint>`) back into its parts. */
    private fun splitUserfileId(id: String): Pair<String, String> {
        val at = id.lastIndexOf("@")
        return if (at == -1) id to "" else id.substring(0, at) to id.substring(at + 1)
    }

    private fun getSummary(id: String, storage: StorageProvider): CommitSummary? {
        val raw = storage.readFile("summaries/$id.json") ?: return null
        return try {
            gson.fromJson(raw, CommitSummary::class.java)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Full body for reconcile. Returns null when the source has vanished or
     * changed (deleted plan/note, or a userfile whose fingerprint no longer
     * matches — the new fingerprint resurfaces as a fresh pending source).
     */
    fun loadSourceContent(ref: SourceRef, kbRoot: Path, storage: StorageProvider): String? {
        return when (ref.type) {
            SourceType.SUMMARY -> getSummary(ref.id, storage)?.let { KnowledgeCompiler.formatSummaryForCompile(it) }
            SourceType.PLAN, SourceType.NOTE -> FolderPlanNoteSource.loadFolderPlanNoteContent(kbRoot, ref)
            SourceType.USERFILE -> {
                val (path, fingerprint) = splitUserfileId(ref.id)
                // `path` is relative to the Memory Bank root (kbRoot.parent), the
                // same base the scanner used. A changed/vanished file fails the
                // fingerprint check → null → resurfaces as a fresh pending source.
                val content = readTextOrNull(kbRoot.parent.resolve(path)) ?: return null
                val fp = FolderStorage.sha256(content)
                if (fp != fingerprint) {
                    log.warn("Userfile %s changed since scan (fingerprint mismatch) — skipped this batch", path)
                    return null
                }
                content
            }
            else -> null
        }
    }

    /** Cheap one-line headline for the route classifier. Guaranteed newline-free. */
    fun loadSourceHeadline(ref: SourceRef, kbRoot: Path, storage: StorageProvider): String =
        toSingleLine(rawSourceHeadline(ref, kbRoot, storage))

    private fun rawSourceHeadline(ref: SourceRef, kbRoot: Path, storage: StorageProvider): String {
        return when (ref.type) {
            SourceType.SUMMARY -> {
                val summary = getSummary(ref.id, storage)
                formatSourceHeadline("summary", summary?.branch ?: "?", ref.timestamp, summary?.commitMessage ?: ref.id)
            }
            SourceType.PLAN, SourceType.NOTE -> FolderPlanNoteSource.loadFolderPlanNoteHeadline(kbRoot, ref)
            SourceType.USERFILE -> {
                val (path, _) = splitUserfileId(ref.id)
                "(userfile, ${ref.timestamp}) $path"
            }
            else -> "(${ref.type}, ${ref.timestamp}) ${ref.id}"
        }
    }

    private fun readTextOrNull(path: Path): String? =
        try {
            Files.readString(path, StandardCharsets.UTF_8)
        } catch (e: Exception) {
            log.warn("Cannot read source file %s: %s", path.toString(), e.message)
            null
        }

    /** Collapses embedded newlines (and surrounding whitespace) into single spaces. */
    private fun toSingleLine(s: String): String = s.replace(Regex("\\s*\\r?\\n\\s*"), " ").trim()
}
