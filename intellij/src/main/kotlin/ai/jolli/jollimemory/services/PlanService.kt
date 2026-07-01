package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.FileWrite
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.PlanReference
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.SummaryStore
import java.io.File
import java.security.MessageDigest
import java.time.Instant

/**
 * PlanService — Kotlin port of PlanService.ts
 *
 * Central service for plan management operations:
 * - Discovery: listing available plan files from ~/.claude/plans/
 * - Archive: archiving plan files to the orphan branch on commit
 * - Association: linking/unlinking plans to commits via plans.json registry
 */
object PlanService {

    private val log = JmLogger.create("PlanService")

    /** Directory where Claude Code stores plan files. */
    private val PLANS_DIR = File(System.getProperty("user.home"), ".claude/plans")

    /** Lightweight plan info for display in UI (e.g. QuickPick / list). */
    data class PlanInfo(
        val slug: String,
        val title: String,
        val filePath: String,
        val lastModified: Long,
    )

    /**
     * Lists all plan files in ~/.claude/plans/ that are NOT in the exclude set.
     * Returns a sorted list (newest first) of PlanInfo objects.
     *
     * @param excludeSlugs Slugs to exclude (e.g. already-associated plans)
     * @return List of available plans sorted by modification time (newest first)
     */
    fun listAvailablePlans(excludeSlugs: Set<String>): List<PlanInfo> {
        if (!PLANS_DIR.exists() || !PLANS_DIR.isDirectory) {
            return emptyList()
        }

        val files = PLANS_DIR.listFiles { file -> file.extension == "md" } ?: return emptyList()

        return files
            .mapNotNull { file ->
                val slug = file.nameWithoutExtension
                if (slug in excludeSlugs) return@mapNotNull null

                val title = extractPlanTitle(file.readText(Charsets.UTF_8))
                val lastModified = file.lastModified()

                PlanInfo(
                    slug = slug,
                    title = title,
                    filePath = file.absolutePath,
                    lastModified = lastModified,
                )
            }
            .sortedByDescending { it.lastModified }
    }

    /**
     * Archives a plan and associates it with a commit.
     *
     * Mirrors PostCommitHook's archive logic: renames slug to slug-hash,
     * sets archive guard on original slug (contentHashAtCommit), and stores
     * the plan file in the orphan branch.
     *
     * @param slug Plan slug (filename without .md)
     * @param commitHash Full commit hash to associate with
     * @param store SummaryStore for writing to the orphan branch
     * @param cwd Working directory (project root)
     * @return PlanReference for inclusion in CommitSummary.plans, or null on failure
     */
    fun archivePlanForCommit(
        slug: String,
        commitHash: String,
        store: SummaryStore,
        cwd: String,
    ): PlanReference? {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        var entry = registry.plans[slug]

        // If slug is not in the registry (e.g., picked from ~/.claude/plans/
        // but never auto-discovered from transcript), create a fresh entry.
        if (entry == null) {
            val planFile = File(PLANS_DIR, "$slug.md")
            if (!planFile.exists()) {
                log.warn("Plan file not found: %s", planFile.absolutePath)
                return null
            }

            val now = Instant.now().toString()
            val branch = getCurrentBranch(cwd)
            entry = ai.jolli.jollimemory.core.PlanEntry(
                slug = slug,
                title = extractPlanTitle(planFile.readText(Charsets.UTF_8)),
                sourcePath = planFile.absolutePath,
                addedAt = now,
                updatedAt = now,
                branch = branch,
                commitHash = null,
                editCount = 0,
            )
        }

        val now = Instant.now().toString()
        val shortHash = commitHash.take(8)
        val newSlug = "$slug-$shortHash"

        // Compute content hash for archive guard
        val contentHashAtCommit = computeContentHash(entry.sourcePath)

        // Update plans.json: original slug becomes guard, new slug is the committed entry
        val updatedPlans = registry.plans.toMutableMap()

        // Original slug: mark as committed with archive guard
        updatedPlans[slug] = entry.copy(
            commitHash = commitHash,
            updatedAt = now,
            contentHashAtCommit = contentHashAtCommit,
            ignored = null,
        )

        // New slug: committed entry linked to the specific commit
        updatedPlans[newSlug] = ai.jolli.jollimemory.core.PlanEntry(
            slug = newSlug,
            title = entry.title,
            sourcePath = entry.sourcePath,
            addedAt = entry.addedAt,
            updatedAt = now,
            branch = entry.branch,
            commitHash = commitHash,
            editCount = entry.editCount,
        )

        SessionTracker.savePlansRegistry(
            registry.copy(plans = updatedPlans),
            cwd,
        )

        // Store plan file in orphan branch under new slug
        val planFile = File(PLANS_DIR, "$slug.md")
        if (planFile.exists()) {
            val content = planFile.readText(Charsets.UTF_8)
            store.storePlanFiles(
                listOf(FileWrite(path = "plans/$newSlug.md", content = content)),
                "Associate plan $newSlug with commit $shortHash",
            )
        }

        log.info("Archived plan %s -> %s for commit %s", slug, newSlug, shortHash)

        return PlanReference(
            slug = newSlug,
            title = entry.title,
            editCount = entry.editCount,
            addedAt = entry.addedAt,
            updatedAt = now,
        )
    }

    /**
     * Removes a plan's association with a commit.
     * Clears commitHash in plans.json so the plan becomes unassociated.
     */
    fun unassociatePlanFromCommit(slug: String, cwd: String) {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        val entry = registry.plans[slug] ?: return

        val updatedPlans = registry.plans.toMutableMap()
        updatedPlans[slug] = entry.copy(commitHash = null)

        SessionTracker.savePlansRegistry(
            registry.copy(plans = updatedPlans),
            cwd,
        )

        log.info("Unassociated plan %s from commit", slug)
    }

    /**
     * Extracts the first "# " heading from markdown content.
     * Falls back to "Untitled" if no heading is found.
     */
    fun extractPlanTitle(content: String): String {
        val match = Regex("^#\\s+(.+)", RegexOption.MULTILINE).find(content)
        return match?.groupValues?.get(1)?.trim() ?: "Untitled"
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    /** Computes a SHA-256 hash of a file's content for archive guard comparison. */
    private fun computeContentHash(filePath: String): String? {
        return try {
            val file = File(filePath)
            if (!file.exists()) return null
            val bytes = file.readBytes()
            val digest = MessageDigest.getInstance("SHA-256")
            digest.update(bytes)
            digest.digest().joinToString("") { "%02x".format(it) }
        } catch (_: Exception) {
            null
        }
    }

    /** Returns the current git branch name, or "unknown" on failure. */
    private fun getCurrentBranch(cwd: String): String {
        return try {
            val process = ProcessBuilder("git", "rev-parse", "--abbrev-ref", "HEAD")
                .directory(File(cwd))
                .redirectErrorStream(false)
                .start()

            val completed = process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS)
            if (!completed || process.exitValue() != 0) return "unknown"
            process.inputStream.bufferedReader().use { it.readText().trim() }
        } catch (_: Exception) {
            "unknown"
        }
    }
}
