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

    /** fileId shapes: `plan:<slug>` / `note:<id>` (also tolerates `plan-<slug>` legacy). */
    private fun idFromFileId(fileId: String): String {
        val colon = fileId.indexOf(":")
        return if (colon == -1) fileId else fileId.substring(colon + 1)
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

    private fun readMeta(kbRoot: Path): List<PlanNoteMeta> {
        val meta = MetadataManager(kbRoot.resolve(".jolli"))
        val out = mutableListOf<PlanNoteMeta>()
        for (e in meta.readManifest().files) {
            if (e.type != "plan" && e.type != "note") continue
            val id = idFromFileId(e.fileId)
            val branch = e.source.branch ?: branchFromPath(meta, e.path)
            val timestamp = e.updatedAt ?: mtimeOrEmpty(hiddenPath(kbRoot, e.type, id))
            out.add(PlanNoteMeta(type = e.type, id = id, title = e.title ?: id, branch = branch, timestamp = timestamp))
        }
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
