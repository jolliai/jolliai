package ai.jolli.jollimemory.core.plans

import com.google.gson.Gson
import java.io.File

/** Result of scanning a transcript for plan signals. */
data class PlanScanResult(
    val slugs: Set<String>,
    val externalPlans: Set<String>,
    val totalLines: Int,
)

/**
 * ClaudePlanScanner — Kotlin port of ClaudePlanScanner.ts.
 *
 * Reads a Claude Code transcript (JSONL) for two plan signal classes:
 *   1. Plan mode: a `"slug":"xxx"` field → canonical `~/.claude/plans/<slug>`.
 *   2. Write/Edit tool_use targeting a `.md` path → `~/.claude/plans/` paths key
 *      by slug; every other `.md` is collected as an UNFILTERED external path
 *      (the `isExternalPlanCandidate` policy lives in the driver so it is shared).
 */
object ClaudePlanScanner {

    /** Regex to extract slug from plan-mode transcript lines: "slug":"xxx" */
    private val SLUG_REGEX = Regex("\"slug\":\"([^\"]+)\"")

    /** Regex to detect Write/Edit tool calls */
    private val WRITE_EDIT_REGEX = Regex("\"name\":\"(?:Write|Edit)\"")

    /**
     * Regex to extract slug from file_path values targeting ~/.claude/plans/.
     * Uses [/\\]{1,2} to handle both raw paths (/) and JSON-escaped Windows paths (\\).
     */
    private val PLANS_PATH_SLUG_REGEX = Regex("[/\\\\]{1,2}\\.claude[/\\\\]{1,2}plans[/\\\\]{1,2}([^/\\\\.]+)\\.md")

    /**
     * Fallback regex: matches any Write/Edit tool_use file_path ending in .md.
     * Runs only when PLANS_PATH_SLUG_REGEX misses, so ~/.claude/plans/ stays
     * handled by the slug-keyed code path.
     */
    private val ANY_MD_PATH_REGEX = Regex("\"file_path\":\"([^\"]+\\.md)\"")

    private val gson = Gson()

    /**
     * Scans [transcriptPath] from [fromLine] (exclusive) up to [toLine] (inclusive,
     * default EOF), collecting plan-mode slugs and external `.md` paths. Returns the
     * furthest line number reached (so the caller can advance the discovery cursor).
     */
    fun scan(transcriptPath: String, fromLine: Int, toLine: Int = Int.MAX_VALUE): PlanScanResult {
        val slugs = mutableSetOf<String>()
        val externalPlans = mutableSetOf<String>()
        var lineNumber = 0

        try {
            File(transcriptPath).bufferedReader(Charsets.UTF_8).useLines { lines ->
                for (line in lines) {
                    lineNumber++
                    if (lineNumber <= fromLine || lineNumber > toLine) continue

                    // Detect plan-mode slug: "slug":"xxx"
                    if (line.contains("\"slug\":\"")) {
                        SLUG_REGEX.find(line)?.groupValues?.get(1)?.let { if (it.isNotEmpty()) slugs.add(it) }
                    }

                    // Detect Write/Edit tool calls. First try the slug-keyed
                    // ~/.claude/plans/ path; only fall back to the generic .md regex
                    // when that misses, so existing behavior is preserved.
                    if (line.contains("\"type\":\"tool_use\"") && WRITE_EDIT_REGEX.containsMatchIn(line)) {
                        val pathSlug = PLANS_PATH_SLUG_REGEX.find(line)?.groupValues?.get(1)
                        if (!pathSlug.isNullOrEmpty()) {
                            slugs.add(pathSlug)
                        } else {
                            val raw = ANY_MD_PATH_REGEX.find(line)?.groupValues?.get(1)
                            if (raw != null) {
                                // JSONL: the captured substring lives inside a JSON string
                                // literal, so `\\`, `\"`, `\n`, `\uXXXX` etc. are all possible.
                                // Decode via Gson to handle every escape uniformly — a simple
                                // replace(\\\\ → \\) misses unicode-escaped filenames.
                                val absPath = try {
                                    gson.fromJson("\"$raw\"", String::class.java)
                                } catch (_: Exception) {
                                    null
                                }
                                if (absPath != null) externalPlans.add(absPath)
                            }
                        }
                    }
                }
            }
        } catch (_: Exception) {
            // Defensive: rare stream failure — return what we have so far.
        }

        return PlanScanResult(slugs, externalPlans, lineNumber)
    }
}
