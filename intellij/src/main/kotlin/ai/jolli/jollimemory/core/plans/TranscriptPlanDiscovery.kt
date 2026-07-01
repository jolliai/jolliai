package ai.jolli.jollimemory.core.plans

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.PlanEntry
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.TranscriptSource
import ai.jolli.jollimemory.core.normalizePathForMatch
import ai.jolli.jollimemory.core.references.TranscriptReferenceDiscovery
import ai.jolli.jollimemory.services.PlanService
import java.io.File
import java.security.MessageDigest
import java.time.Instant

/**
 * TranscriptPlanDiscovery — Kotlin port of TranscriptPlanDiscovery.ts.
 *
 * `scanPlansFrom` is a pure scan + upsert: it runs [ClaudePlanScanner], applies the
 * shared external-plan exclusion policy, then upserts each surviving plan into
 * plans.json (archive-guard revive, note dedup, resolveUniqueSlug, concurrent
 * per-slug merge). It does NOT own the discovery cursor — the caller (StopHook)
 * persists the merged line target.
 *
 * This replaces the old directory-scan (`PlanService.autoRegisterNewPlans`) so that,
 * like the CLI/VS Code, a plan enters the registry only when the user actually
 * created/edited it in a tracked session — never by enumerating ~/.claude/plans/.
 */
object TranscriptPlanDiscovery {

    private val log = JmLogger.create("PlanDiscovery")

    private val PLANS_DIR = File(System.getProperty("user.home"), ".claude/plans")

    /** Path segments excluded from external plan detection (case-insensitive). */
    private val EXTERNAL_EXCLUDE_SEGMENTS = listOf(
        Regex("[/\\\\]\\.claude[/\\\\]", RegexOption.IGNORE_CASE),
        Regex("[/\\\\]node_modules[/\\\\]", RegexOption.IGNORE_CASE),
        Regex("[/\\\\]\\.github[/\\\\]", RegexOption.IGNORE_CASE),
    )

    /** Basenames excluded — stored lowercase, compared after lowercasing input. */
    private val EXTERNAL_EXCLUDE_BASENAMES = setOf(
        "claude.md",
        "claude.local.md",
        "agents.md",
        "readme.md",
        "changelog.md",
        "contributing.md",
        "license.md",
        "security.md",
        "code_of_conduct.md",
    )

    /**
     * Scans the transcript for plan file references from [fromLine] (exclusive) up to
     * EOF and upserts them into plans.json. Returns the furthest line scanned.
     *
     * Covers three scenarios (Claude): plan-mode `"slug"`, direct write to
     * ~/.claude/plans/, and external `.md` files not excluded by
     * [isExternalPlanCandidate]. `source` is accepted for parity with the CLI driver;
     * only Claude transcripts are scanned today.
     */
    fun scanPlansFrom(transcriptPath: String, fromLine: Int, cwd: String, source: TranscriptSource): Int {
        val scan = ClaudePlanScanner.scan(transcriptPath, fromLine)

        // Apply the shared external-plan exclusion policy here (not in the scanner).
        val filteredExternal = scan.externalPlans.filter { isExternalPlanCandidate(it) }.toSet()

        if (scan.slugs.isEmpty() && filteredExternal.isEmpty()) {
            return scan.totalLines
        }

        // Load registry right before writing to minimize the race window with the worker.
        val registry = SessionTracker.loadPlansRegistry(cwd)
        val plans = registry.plans.toMutableMap()
        val now = Instant.now().toString()
        // Stamp the branch on newly-created rows so the panel can branch-scope CONTEXT.
        // Omit on an "unknown" git lookup so the row stays branch-less (visible everywhere).
        val discoveredBranch = TranscriptReferenceDiscovery.getCurrentBranchSafe(cwd)
        val branchField: String? = if (discoveredBranch.isNotEmpty() && discoveredBranch != "unknown") discoveredBranch else null
        var changed = false
        val touchedSlugs = mutableSetOf<String>()

        // Paths already owned by a markdown note — never also register them as a plan
        // (would shadow the note, double-archive, and surface the same file twice).
        val noteSourcePaths = mutableSetOf<String>()
        for (note in (registry.notes ?: emptyMap()).values) {
            note.sourcePath?.let { if (it.isNotBlank()) noteSourcePaths.add(normalizePath(it)) }
        }

        fun upsertEntry(slug: String, planFile: File) {
            val existing = plans[slug]
            when {
                existing?.contentHashAtCommit != null -> {
                    // Archived guard: revive when the source file diverged from the guard hash.
                    val currentHash = sha256(planFile.readText(Charsets.UTF_8))
                    if (currentHash != existing.contentHashAtCommit) {
                        plans[slug] = PlanEntry(
                            slug = slug,
                            title = titleOf(planFile),
                            sourcePath = planFile.absolutePath,
                            addedAt = now,
                            updatedAt = now,
                            branch = branchField,
                            commitHash = null,
                        )
                        changed = true
                        touchedSlugs.add(slug)
                        log.info("Plan discovery: archived plan %s file changed — creating new entry", slug)
                    }
                }
                existing != null -> {
                    if (existing.commitHash == null) {
                        plans[slug] = existing.copy(updatedAt = now)
                        changed = true
                        touchedSlugs.add(slug)
                    }
                }
                else -> {
                    plans[slug] = PlanEntry(
                        slug = slug,
                        title = titleOf(planFile),
                        sourcePath = planFile.absolutePath,
                        addedAt = now,
                        updatedAt = now,
                        branch = branchField,
                        commitHash = null,
                    )
                    changed = true
                    touchedSlugs.add(slug)
                }
            }
        }

        // 1. Canonical ~/.claude/plans/ slugs — routed through resolveUniqueSlug so an
        //    external entry registered first under the same slug isn't overwritten.
        for (rawSlug in scan.slugs) {
            val planFile = File(PLANS_DIR, "$rawSlug.md")
            if (!planFile.exists()) continue
            if (noteSourcePaths.contains(normalizePath(planFile.absolutePath))) {
                log.info("Plan discovery: %s already a note — skipping plan registration", planFile.absolutePath)
                continue
            }
            val slug = resolveUniqueSlug(rawSlug, planFile.absolutePath, plans)
            upsertEntry(slug, planFile)
        }

        // 2. External .md paths — already filtered to candidates. existsSync is the ONLY
        //    success gate, intentionally: scanners read the write REQUEST, not the result.
        for (absPath in filteredExternal) {
            val file = File(absPath)
            if (!file.exists()) continue
            if (noteSourcePaths.contains(normalizePath(absPath))) {
                log.info("Plan discovery: %s already a note — skipping plan registration", absPath)
                continue
            }
            val baseSlug = basenameNoExt(absPath, ".md")
            val slug = resolveUniqueSlug(baseSlug, absPath, plans)
            upsertEntry(slug, file)
        }

        if (changed) {
            // Re-read under lock and merge per-slug onto the freshest snapshot so a
            // sibling writer (PostCommitHook archival, a parallel StopHook, an
            // extension delete) between our load and save is not clobbered.
            val locked = SessionTracker.acquireLock(cwd)
            if (!locked) {
                log.warn("scanPlansFrom: could not acquire lock — writing without lock")
            }
            try {
                val freshRegistry = SessionTracker.loadPlansRegistry(cwd)
                val merged = freshRegistry.plans.toMutableMap()
                for (slug in touchedSlugs) {
                    val ours = plans[slug] ?: continue
                    val fresh = freshRegistry.plans[slug]
                    val freshCommitHash = fresh?.commitHash
                    val existedAtLoad = registry.plans.containsKey(slug)
                    val originalCommitHash = registry.plans[slug]?.commitHash
                    when {
                        // A sibling (typically the worker) transitioned this slug to
                        // archived (set commitHash + contentHashAtCommit) — take it whole.
                        fresh != null && freshCommitHash != null && freshCommitHash != originalCommitHash -> {
                            merged[slug] = fresh
                        }
                        // Write our version unless it was concurrently hard-deleted.
                        fresh != null || !existedAtLoad -> {
                            merged[slug] = ours
                        }
                        // else: fresh == null && existedAtLoad → concurrent hard delete;
                        // leave `merged` without it so the explicit delete wins.
                    }
                }
                // Preserve notes/references written by sibling pipelines between load and save.
                SessionTracker.savePlansRegistry(freshRegistry.copy(version = 1, plans = merged), cwd)
            } finally {
                if (locked) SessionTracker.releaseLock(cwd)
            }
            log.info(
                "Plan discovery: upserted %d slug(s) + %d external path(s) into plans.json",
                scan.slugs.size,
                filteredExternal.size,
            )
        }

        return scan.totalLines
    }

    /**
     * Whether an external .md path is a plan candidate. Excludes any path under
     * `.claude/`, `node_modules/`, or `.github/`, plus common non-plan filenames.
     */
    private fun isExternalPlanCandidate(absPath: String): Boolean {
        if (EXTERNAL_EXCLUDE_SEGMENTS.any { it.containsMatchIn(absPath) }) return false
        val base = absPath.split('/', '\\').last().lowercase()
        return !EXTERNAL_EXCLUDE_BASENAMES.contains(base)
    }

    /** Platform-agnostic basename with the given extension stripped (case-insensitive). */
    private fun basenameNoExt(absPath: String, ext: String): String {
        val last = absPath.split('/', '\\').last()
        return if (last.lowercase().endsWith(ext.lowercase())) last.dropLast(ext.length) else last
    }

    /**
     * Returns a unique registry slug for [absPath]:
     *   1. Reverse-lookup: a slug whose sourcePath normalize-equals absPath (idempotent).
     *   2. baseSlug free → baseSlug.
     *   3. baseSlug taken by a different file → `<baseSlug>-<sha256(normPath)[0:8]>`.
     */
    private fun resolveUniqueSlug(baseSlug: String, absPath: String, plans: Map<String, PlanEntry>): String {
        val targetNorm = normalizePath(absPath)
        for ((slug, entry) in plans) {
            if (normalizePath(entry.sourcePath) == targetNorm) return slug
        }
        if (!plans.containsKey(baseSlug)) return baseSlug
        return "$baseSlug-${sha256(targetNorm).take(8)}"
    }

    /** First `# ` heading of the plan file, falling back to the basename. */
    private fun titleOf(planFile: File): String {
        val content = try {
            planFile.readText(Charsets.UTF_8)
        } catch (_: Exception) {
            return planFile.name
        }
        val match = Regex("^#\\s+(.+)", RegexOption.MULTILINE).find(content)
        return match?.groupValues?.get(1)?.trim() ?: planFile.name
    }

    private fun normalizePath(p: String): String = normalizePathForMatch(p)

    private fun sha256(s: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
