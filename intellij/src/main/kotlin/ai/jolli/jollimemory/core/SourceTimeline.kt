package ai.jolli.jollimemory.core

import com.google.gson.Gson
import java.nio.file.Path
import java.time.Instant
import java.time.OffsetDateTime

/**
 * SourceTimeline — turns the source streams into one deterministic, time-ordered
 * list of not-yet-ingested [SourceRef]s. Single source of truth for the
 * time-fold's "old → new" ordering: same disk snapshot + same processed set →
 * same ordered list.
 *
 * Kotlin port of `cli/src/core/SourceTimeline.ts`. The TS orphan-only legacy
 * path (plans.json registry) is omitted: the IntelliJ compile always runs
 * against the Memory Bank folder, so a `kbRoot` is always available.
 */
object SourceTimeline {

    private val gson = Gson()

    /** Fixed tie-break rank for equal-instant sources. */
    private val TYPE_RANK = mapOf(
        SourceType.SUMMARY to 0,
        SourceType.PLAN to 1,
        SourceType.NOTE to 2,
        SourceType.USERFILE to 3,
    )

    /**
     * Total order over [SourceRef]s: epoch ascending, then (type rank, id) tie-break.
     * Timestamps are parsed to epoch (NOT compared as strings) so timezone offsets
     * order correctly. Unparseable timestamps sort after all valid ones, then fall
     * through to the deterministic type/id tie-break.
     */
    fun compareSourceRefs(a: SourceRef, b: SourceRef): Int {
        val av = parseEpoch(a.timestamp)
        val bv = parseEpoch(b.timestamp)
        if (av != null && bv != null && av != bv) return av.compareTo(bv)
        if (av == null && bv != null) return 1 // NaN after valid
        if (bv == null && av != null) return -1
        if (a.type != b.type) return (TYPE_RANK[a.type] ?: Int.MAX_VALUE) - (TYPE_RANK[b.type] ?: Int.MAX_VALUE)
        return a.id.compareTo(b.id)
    }

    /**
     * Enumerates every source as a [SourceRef]. Root commit summaries only
     * (parentCommitHash null). User files scanned disk-driven across all branch
     * folders, deduped by `path@fingerprint`.
     */
    fun collectAllSourceRefs(kbRoot: Path, storage: StorageProvider): List<SourceRef> {
        val refs = mutableListOf<SourceRef>()

        val index = readIndex(storage)
        if (index != null) {
            for (e in index.entries) {
                if (e.parentCommitHash == null) {
                    refs.add(SourceRef(type = SourceType.SUMMARY, id = e.commitHash, timestamp = e.commitDate, branch = e.branch))
                }
            }
        }

        refs.addAll(FolderPlanNoteSource.listFolderPlanNoteRefs(kbRoot))

        val seenUserFiles = HashSet<String>()
        for (f in MemoryBankScanner.listAllUserKnowledgeFromRoot(kbRoot)) {
            val id = "${f.path}@${f.fingerprint}"
            if (!seenUserFiles.add(id)) continue
            refs.add(SourceRef(type = SourceType.USERFILE, id = id, timestamp = f.mtime))
        }

        return refs
    }

    /**
     * Returns all not-yet-ingested sources sorted old → new. Deterministic for a
     * given disk snapshot + processed set.
     */
    fun listPendingSources(kbRoot: Path, storage: StorageProvider, processed: ProcessedSet): List<SourceRef> =
        collectAllSourceRefs(kbRoot, storage)
            .filter { !ProcessedSourceStore.hasProcessed(processed, it) }
            .sortedWith(::compareSourceRefs)

    private fun readIndex(storage: StorageProvider): SummaryIndex? {
        val raw = storage.readFile("index.json") ?: return null
        return try {
            gson.fromJson(raw, SummaryIndex::class.java)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Parses an ISO-8601 timestamp to epoch millis (handling both `Z` and numeric
     * offsets), or null when unparseable — mirroring `Number.isNaN(Date.parse(...))`.
     */
    private fun parseEpoch(ts: String): Long? {
        if (ts.isBlank()) return null
        return try {
            OffsetDateTime.parse(ts).toInstant().toEpochMilli()
        } catch (_: Exception) {
            try {
                Instant.parse(ts).toEpochMilli()
            } catch (_: Exception) {
                null
            }
        }
    }
}
