package ai.jolli.jollimemory.core

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/**
 * FolderPlanNoteSource — reads plan/note compile sources straight from the
 * Memory Bank folder (`<kbRoot>/.jolli/manifest.json` + `plans|notes/<id>.md`),
 * so compile doesn't need the working repo's plans.json registry.
 *
 * Kotlin port of `cli/src/core/FolderPlanNoteSource.ts`. The TS `metaCache`
 * (mtime-keyed memo) is an optimization and is intentionally omitted; each call
 * re-reads the manifest.
 */
object FolderPlanNoteSource {

    private data class PlanNoteMeta(
        val type: String, // "plan" | "note"
        val id: String,
        val title: String,
        val branch: String,
        val timestamp: String,
    )

    /** fileId shapes: `plan:<slug>` / `note:<id>` (also tolerates `plan-<slug>` / `note-<id>` legacy). */
    private fun idFromFileId(fileId: String): String {
        val colon = fileId.indexOf(":")
        if (colon != -1) return fileId.substring(colon + 1)
        if (fileId.startsWith("plan-")) return fileId.removePrefix("plan-")
        if (fileId.startsWith("note-")) return fileId.removePrefix("note-")
        return fileId
    }

    private fun hiddenPath(kbRoot: Path, type: String, id: String): Path {
        val dir = if (type == "plan") "plans" else "notes"
        return kbRoot.resolve(".jolli").resolve(dir).resolve("$id.md")
    }

    /** mtime fallback when the manifest entry predates `updatedAt` stamping. */
    private fun mtimeOrEmpty(path: Path): String =
        try {
            Files.getLastModifiedTime(path).toInstant().toString()
        } catch (_: Exception) {
            ""
        }

    /** Reverse-derive branch from the visible path's first segment. */
    private fun branchFromPath(meta: MetadataManager, path: String): String =
        meta.folderToBranch(path.split("/")[0])

    private data class MetaCacheEntry(val mtimeMs: Long, val metas: List<PlanNoteMeta>)

    /**
     * Per-kbRoot memo of parsed plan/note metadata, invalidated by the manifest's
     * mtime. A single ingest batch calls readMeta once per plan/note headline, each
     * of which would otherwise re-read + re-parse the same manifest.json. Thread-safe
     * for the reconcile fan-out (ConcurrentHashMap). Mirrors the CLI metaCache.
     */
    private val metaCache = java.util.concurrent.ConcurrentHashMap<String, MetaCacheEntry>()

    private fun readMeta(kbRoot: Path): List<PlanNoteMeta> {
        val manifestPath = kbRoot.resolve(".jolli").resolve("manifest.json")
        val mtimeMs = try {
            Files.getLastModifiedTime(manifestPath).toMillis()
        } catch (_: Exception) {
            -1L
        }
        val key = kbRoot.toAbsolutePath().normalize().toString()
        val cached = metaCache[key]
        if (cached != null && mtimeMs != -1L && cached.mtimeMs == mtimeMs) return cached.metas

        val meta = MetadataManager(kbRoot.resolve(".jolli"))
        val out = mutableListOf<PlanNoteMeta>()
        for (e in meta.readManifest().files) {
            if (e.type != "plan" && e.type != "note") continue
            val id = idFromFileId(e.fileId)
            val branch = e.source.branch ?: branchFromPath(meta, e.path)
            val timestamp = e.updatedAt ?: mtimeOrEmpty(hiddenPath(kbRoot, e.type, id))
            out.add(PlanNoteMeta(type = e.type, id = id, title = e.title ?: id, branch = branch, timestamp = timestamp))
        }
        if (mtimeMs != -1L) metaCache[key] = MetaCacheEntry(mtimeMs, out)
        return out
    }

    /** Enumerate plan + note sources (not summaries/wiki) for the timeline fold. */
    fun listFolderPlanNoteRefs(kbRoot: Path): List<SourceRef> =
        readMeta(kbRoot).map { SourceRef(type = it.type, id = it.id, timestamp = it.timestamp, branch = it.branch) }

    /** Full body for reconcile. null when the hidden source is missing (drops from the fold). */
    fun loadFolderPlanNoteContent(kbRoot: Path, ref: SourceRef): String? {
        if (ref.type != "plan" && ref.type != "note") return null
        return try {
            Files.readString(hiddenPath(kbRoot, ref.type, ref.id), StandardCharsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    /** One-line headline for the route classifier. */
    fun loadFolderPlanNoteHeadline(kbRoot: Path, ref: SourceRef): String {
        val m = readMeta(kbRoot).find { it.type == ref.type && it.id == ref.id }
        return formatSourceHeadline(ref.type, m?.branch ?: "?", ref.timestamp, m?.title ?: ref.id)
    }
}
