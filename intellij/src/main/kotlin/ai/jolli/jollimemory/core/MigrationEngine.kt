package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.GsonBuilder

/**
 * MigrationEngine — migrates data from OrphanBranchStorage to FolderStorage.
 *
 * Reads all summaries, transcripts, plans, and plan-progress from the orphan
 * branch and writes them through FolderStorage, which automatically generates
 * visible markdown files and stores hidden JSON.
 *
 * Features:
 * - Idempotent: skips files already in the manifest (by fileId/commitHash)
 * - Resumable: tracks progress in .jolli/migration.json
 * - Non-destructive: orphan branch data is never modified or deleted
 *
 * Part of JOLLI-1309 / Phase 2, Step 2.2.
 */
class MigrationEngine(
    private val orphanStorage: OrphanBranchStorage,
    private val folderStorage: FolderStorage,
    private val metadataManager: MetadataManager,
) {
    private val log = JmLogger.create("MigrationEngine")
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    /**
     * Runs the full migration from orphan branch to KB folder.
     *
     * @param onProgress callback with (migrated, total) counts
     * @return the final MigrationState
     */
    fun runMigration(onProgress: ((Int, Int) -> Unit)? = null): MigrationState {
        log.info("=== Migration started ===")

        // Load index from orphan branch
        val indexJson = orphanStorage.readFile("index.json")
        if (indexJson == null) {
            log.info("No index.json on orphan branch — nothing to migrate")
            return saveMigrationState(MigrationState(status = "completed"))
        }

        val index = try {
            gson.fromJson(indexJson, SummaryIndex::class.java)
        } catch (e: Exception) {
            log.error("Failed to parse index.json: %s", e.message)
            return saveMigrationState(MigrationState(status = "failed"))
        }

        // Get root entries (parentCommitHash == null) — these are the top-level summaries
        val rootEntries = index.entries.filter { it.parentCommitHash == null }
        val totalEntries = rootEntries.size

        saveMigrationState(MigrationState(
            status = "in_progress",
            totalEntries = totalEntries,
        ))

        var migrated = 0
        var skipped = 0

        for (entry in rootEntries) {
            val hash = entry.commitHash

            // Skip if already migrated — but backfill missing title
            val existing = metadataManager.findById(hash)
            if (existing != null) {
                if (existing.title == null) {
                    backfillTitle(hash, existing)
                }
                skipped++
                migrated++
                onProgress?.invoke(migrated, totalEntries)
                continue
            }

            try {
                migrateSummary(hash)
                migrateTranscript(hash)
                migrated++
            } catch (e: Exception) {
                log.warn("Failed to migrate %s: %s", hash.take(8), e.message)
                migrated++ // count as processed even if failed
            }

            onProgress?.invoke(migrated, totalEntries)

            saveMigrationState(MigrationState(
                status = "in_progress",
                totalEntries = totalEntries,
                migratedEntries = migrated,
                lastMigratedHash = hash,
            ))
        }

        // Migrate all summaries (including non-root ones missed by the entry loop)
        migrateAllSummaries()

        // Migrate all transcripts (including non-root ones missed by the entry loop)
        migrateAllTranscripts()

        // Migrate plans
        migratePlans()

        // Migrate notes
        migrateNotes()

        // Migrate plan-progress
        migratePlanProgress()

        // Write the full index to folder
        folderStorage.writeFiles(
            listOf(FileWrite("index.json", indexJson)),
            "Migration: copy index",
        )

        val finalState = MigrationState(
            status = "completed",
            totalEntries = totalEntries,
            migratedEntries = migrated,
        )
        saveMigrationState(finalState)

        log.info("=== Migration completed: %d migrated, %d skipped ===", migrated - skipped, skipped)
        return finalState
    }

    /**
     * Validates that migration was successful by comparing counts.
     */
    fun validateMigration(): Boolean {
        val indexJson = orphanStorage.readFile("index.json") ?: return true
        val index = try {
            gson.fromJson(indexJson, SummaryIndex::class.java)
        } catch (_: Exception) {
            return false
        }

        val rootEntries = index.entries.filter { it.parentCommitHash == null }
        val manifest = metadataManager.readManifest()
        val commitEntries = manifest.files.filter { it.type == "commit" }

        val valid = commitEntries.size >= rootEntries.size
        if (!valid) {
            log.warn("Validation failed: orphan has %d root entries, manifest has %d commit entries",
                rootEntries.size, commitEntries.size)
        }
        return valid
    }

    /**
     * Loads migration state from .jolli/migration.json.
     */
    fun loadMigrationState(): MigrationState {
        val json = metadataManager.readMigrationState()
        return json ?: MigrationState()
    }

    // ── Internal migration methods ─────────────────────────────────────────

    /** Backfills the title field for an existing manifest entry (from summary JSON). */
    private fun backfillTitle(commitHash: String, existing: ManifestEntry) {
        val json = orphanStorage.readFile("summaries/$commitHash.json") ?: return
        try {
            val summary = gson.fromJson(json, CommitSummary::class.java) ?: return
            metadataManager.updateManifest(existing.copy(title = summary.commitMessage))
            log.info("Backfilled title for %s: %s", commitHash.take(8), summary.commitMessage.take(50))
        } catch (_: Exception) {}
    }

    private fun migrateSummary(commitHash: String) {
        val json = orphanStorage.readFile("summaries/$commitHash.json") ?: return
        folderStorage.writeFiles(
            listOf(FileWrite("summaries/$commitHash.json", json)),
            "Migration: summary $commitHash",
        )
    }

    private fun migrateTranscript(commitHash: String) {
        val json = orphanStorage.readFile("transcripts/$commitHash.json") ?: return
        folderStorage.writeFiles(
            listOf(FileWrite("transcripts/$commitHash.json", json)),
            "Migration: transcript $commitHash",
        )
    }

    private fun migratePlans() {
        val planFiles = orphanStorage.listFiles("plans/")
        for (path in planFiles) {
            val content = orphanStorage.readFile(path) ?: continue
            folderStorage.writeFiles(
                listOf(FileWrite(path, content)),
                "Migration: plan $path",
            )
        }
        if (planFiles.isNotEmpty()) {
            log.info("Migrated %d plan file(s)", planFiles.size)
        }
    }

    private fun migratePlanProgress() {
        val progressFiles = orphanStorage.listFiles("plan-progress/")
        for (path in progressFiles) {
            val content = orphanStorage.readFile(path) ?: continue
            folderStorage.writeFiles(
                listOf(FileWrite(path, content)),
                "Migration: plan-progress $path",
            )
        }
        if (progressFiles.isNotEmpty()) {
            log.info("Migrated %d plan-progress file(s)", progressFiles.size)
        }
    }

    private fun migrateNotes() {
        val noteFiles = orphanStorage.listFiles("notes/")
        for (path in noteFiles) {
            val content = orphanStorage.readFile(path) ?: continue
            folderStorage.writeFiles(
                listOf(FileWrite(path, content)),
                "Migration: note $path",
            )
        }
        if (noteFiles.isNotEmpty()) {
            log.info("Migrated %d note file(s)", noteFiles.size)
        }
    }

    private fun migrateAllSummaries() {
        val summaryFiles = orphanStorage.listFiles("summaries/")
        var migrated = 0
        for (path in summaryFiles) {
            val existing = folderStorage.readFile(path)
            if (existing != null) continue
            val content = orphanStorage.readFile(path) ?: continue
            folderStorage.writeFiles(
                listOf(FileWrite(path, content)),
                "Migration: summary $path",
            )
            migrated++
        }
        if (migrated > 0) {
            log.info("Migrated %d additional summary file(s)", migrated)
        }
    }

    private fun migrateAllTranscripts() {
        val transcriptFiles = orphanStorage.listFiles("transcripts/")
        var migrated = 0
        for (path in transcriptFiles) {
            val existing = folderStorage.readFile(path)
            if (existing != null) continue
            val content = orphanStorage.readFile(path) ?: continue
            folderStorage.writeFiles(
                listOf(FileWrite(path, content)),
                "Migration: transcript $path",
            )
            migrated++
        }
        if (migrated > 0) {
            log.info("Migrated %d additional transcript file(s)", migrated)
        }
    }

    private fun saveMigrationState(state: MigrationState): MigrationState {
        metadataManager.saveMigrationState(state)
        return state
    }
}
