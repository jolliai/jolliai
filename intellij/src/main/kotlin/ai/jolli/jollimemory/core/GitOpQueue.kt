package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.io.File

/**
 * GitOpQueue — Kotlin port of the CLI's git-op-queue (cli/src/hooks/PostCommitHook.ts
 * enqueue + cli/src/core/SessionTracker.ts dequeueAllGitOperations).
 *
 * Each git operation (commit / amend / squash / cherry-pick / revert) is written as
 * one timestamped JSON file under `.jolli/jollimemory/git-op-queue/`. A single drain
 * worker processes them in chronological order. This replaces the old
 * "spawn one worker per commit, serialized by a lock" model whose loser (a second
 * commit that arrived while the first worker held the lock) silently dropped its
 * summary — the exact bug the CLI queue was built to fix for rapid amend/rebase.
 *
 * File name: `{epochMillis}-{hash8}.json`. The 13-digit ms prefix sorts
 * lexicographically == chronologically (until year 2286), but we sort by the parsed
 * numeric prefix to be safe.
 */
object GitOpQueue {

    private val log = JmLogger.create("GitOpQueue")
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    private const val QUEUE_DIR = "git-op-queue"

    /** Entries older than 24h are pruned on dequeue (mirrors the CLI GIT_OP_QUEUE_STALE_MS). */
    private const val STALE_MS = 24L * 60 * 60 * 1000

    /**
     * One queued git operation. Field shape matches the CLI `GitOperation` so a queue
     * written by either engine is readable by the other.
     *
     * @param type one of: commit, amend, squash, cherry-pick, revert, rebase-pick, rebase-squash
     * @param commitHash the (new) commit hash this op produced
     * @param sourceHashes old hashes — [oldHash] for amend, the merged source hashes for squash
     * @param commitSource "cli" or "plugin"
     * @param createdAt ISO-8601 timestamp at enqueue time (transcript-attribution cutoff)
     */
    data class GitOperation(
        val type: String,
        val commitHash: String,
        val branch: String? = null,
        val sourceHashes: List<String>? = null,
        val commitSource: String? = null,
        val createdAt: String,
    )

    private fun queueDir(cwd: String?): File = File(JmLogger.getJolliMemoryDir(cwd), QUEUE_DIR)

    /** Synchronous, <5ms: append one operation as its own file. Must never throw into the git hook. */
    fun enqueue(op: GitOperation, cwd: String? = null): Boolean {
        return try {
            val dir = queueDir(cwd)
            dir.mkdirs()
            val fileName = "${System.currentTimeMillis()}-${op.commitHash.take(8)}.json"
            File(dir, fileName).writeText(gson.toJson(op), Charsets.UTF_8)
            log.info("Enqueued %s op for %s", op.type, op.commitHash.take(8))
            true
        } catch (e: Exception) {
            log.error("Failed to enqueue git op: %s", e.message)
            false
        }
    }

    /**
     * Reads all queued operations in chronological order. Stale entries (>24h) and
     * unparseable files are pruned (deleted) and skipped. Returns (op, file) pairs so
     * the caller can [deleteEntry] each after processing.
     */
    fun dequeueAll(cwd: String? = null): List<Pair<GitOperation, File>> {
        val dir = queueDir(cwd)
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") } ?: return emptyList()
        val now = System.currentTimeMillis()
        val out = mutableListOf<Pair<GitOperation, File>>()
        for (file in files.sortedBy { parseTimestamp(it.name) }) {
            val ts = parseTimestamp(file.name)
            if (ts > 0 && now - ts > STALE_MS) {
                log.info("Pruning stale queue entry (%dh old): %s", (now - ts) / 3600000, file.name)
                deleteEntry(file)
                continue
            }
            val op = try {
                gson.fromJson(file.readText(Charsets.UTF_8), GitOperation::class.java)
            } catch (e: Exception) {
                log.warn("Unparseable queue entry %s — deleting: %s", file.name, e.message)
                deleteEntry(file)
                null
            }
            if (op?.commitHash?.isNotBlank() == true && op.type.isNotBlank()) out.add(op to file)
            else if (op != null) deleteEntry(file)
        }
        return out
    }

    fun deleteEntry(file: File) {
        try {
            file.delete()
        } catch (e: Exception) {
            log.warn("Failed to delete queue entry %s: %s", file.name, e.message)
        }
    }

    /** True when the queue directory holds at least one `.json` entry. */
    fun hasEntries(cwd: String? = null): Boolean =
        (queueDir(cwd).listFiles { f -> f.isFile && f.name.endsWith(".json") }?.isNotEmpty()) == true

    /** Parse the `{epochMillis}-...` prefix; returns 0 when the name has no numeric prefix. */
    private fun parseTimestamp(name: String): Long =
        name.substringBefore('-', "").toLongOrNull() ?: 0L
}
