package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.CommitInfo
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SummaryStore

/**
 * PostRewriteHook — Kotlin port of PostRewriteHook.ts
 *
 * Invoked by git after rebase/amend. Reads old→new hash mappings from stdin
 * and migrates summaries accordingly.
 */
object PostRewriteHook {

    private val log = JmLogger.create("PostRewriteHook")

    fun run(args: Array<String>) {
        val cwd = System.getProperty("user.dir")
        JmLogger.setLogDir(cwd)
        val command = args.getOrNull(0) ?: "unknown"
        log.info("=== Post-rewrite hook started (command: %s) ===", command)

        val input = try { readStdin() } catch (e: Exception) {
            log.warn("Failed to read stdin: %s", e.message)
            return
        }
        if (input.isBlank()) return

        val git = GitOps(cwd)
        val store = SummaryStore(cwd, git)

        // Parse hash mappings: "oldHash newHash" per line
        val mappings = input.lines()
            .filter { it.isNotBlank() }
            .mapNotNull { line ->
                val parts = line.trim().split("\\s+".toRegex())
                if (parts.size >= 2) parts[0] to parts[1] else null
            }

        log.info("Processing %d hash mapping(s)", mappings.size)

        // Group by newHash: during rebase squash/fixup, multiple old hashes map to the same new hash.
        // Processing them individually via migrateOneToOne would overwrite earlier migrations.
        val groupedByNew = mappings.groupBy({ it.second }, { it.first })

        for ((newHash, oldHashes) in groupedByNew) {
            // Resolve commit info for the new hash
            val commitInfoStr = git.exec("log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI", newHash)
            if (commitInfoStr == null) {
                log.warn("Cannot get info for new hash %s", newHash.take(8))
                continue
            }
            val parts = commitInfoStr.split("\u0000")
            if (parts.size < 4) continue
            val newCommitInfo = CommitInfo(parts[0], parts[1], parts[2], parts[3])

            // Collect all old summaries for this new hash
            val oldSummaries = oldHashes.mapNotNull { oldHash ->
                store.getSummary(oldHash) ?: run {
                    val rootHash = store.findRootHash(oldHash)
                    if (rootHash != null) store.getSummary(rootHash) else null
                }
            }

            if (oldSummaries.isEmpty()) {
                log.debug("No summaries for old hashes → %s — skipping", newHash.take(8))
                continue
            }

            if (oldSummaries.size == 1) {
                store.migrateOneToOne(oldSummaries.first(), newCommitInfo)
            } else {
                log.info("Merging %d summaries into %s (squash/fixup rebase)", oldSummaries.size, newHash.take(8))
                store.mergeManyToOne(oldSummaries, newCommitInfo)
            }
        }

        log.info("=== Post-rewrite hook finished ===")
    }
}
