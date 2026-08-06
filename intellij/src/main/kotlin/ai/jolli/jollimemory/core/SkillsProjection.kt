package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.JsonObject

/**
 * SkillsProjection — bridge adapter for the CLI's skill read and render surface
 * (`cli/src/core/skills/SkillProjection.ts` + `cli/src/core/SkillsAggregateMarkdown.ts`).
 *
 * Everything here is one `shared-store` call. Nothing about skills is computed in
 * Kotlin, and that is deliberate rather than lazy:
 *
 *  - **Which rows are still uncommitted** is not readable off a registry row. A
 *    skill row keeps accumulating across sessions and is GUARDED rather than deleted
 *    on archive, so "uncommitted" means the counters moved past the archived
 *    baseline — and the reported figures must be that delta, not the running total,
 *    or a re-used skill overstates the pending commit by everything already frozen
 *    onto earlier ones. VS Code hand-copied that rule once and every re-used skill
 *    vanished from its panel.
 *  - **The table and its one-line summary must agree** with the `skills--<hash8>.md`
 *    file the CLI writes into the Memory Bank, and with what VS Code shows. A second
 *    renderer is a second set of rounding, ordering and em-dash-vs-zero decisions.
 *
 * Every call is remote, so callers must stay OFF the EDT — the daemon is 5-20ms warm
 * but 500ms-2s on its first spawn, which is well past IntelliJ's slow-EDT threshold.
 * The existing callers fetch inside an off-EDT bundle and render from the result.
 */
object SkillsProjection {

    private val log = JmLogger.create("SkillsProjection")
    private val gson = Gson()

    /**
     * One captured skill as the CLI projects it.
     *
     * Field names must match `ActiveSkill` in `SkillProjection.ts` exactly — Gson
     * silently leaves a renamed field at its default instead of failing to compile.
     * Defaults are supplied throughout for the same reason: a field the CLI stops
     * sending degrades to empty rather than to a null-dereference.
     */
    data class ActiveSkill(
        /** plans.json.skills map key `<source>:<skill>` — the exclusion key, not a display value. */
        val mapKey: String = "",
        val source: String = "",
        val skill: String = "",
        val plugin: String? = null,
        val invocationCount: Int = 0,
        val firstUsedAt: String? = null,
        val lastUsedAt: String? = null,
        /** Absent when the source could not attribute tokens — must never render as a zero. */
        val usage: SkillUsage? = null,
        /** "heuristic" when the invocation was inferred from a file read rather than observed. */
        val detection: String? = null,
        val lastModified: String = "",
    )

    /**
     * The active rows plus the label that goes on the single aggregate row.
     *
     * One row for however many skills were captured: a session routinely enters a
     * dozen, and no Context surface can absorb a dozen affordance-free rows. The
     * per-skill figures live one click away in [liveMarkdown].
     */
    data class ActiveSkills(
        val skills: List<ActiveSkill> = emptyList(),
        val summaryLabel: String = "",
    ) {
        val isEmpty: Boolean get() = skills.isEmpty()

        /**
         * Exclusion keys for every captured skill — what the aggregate checkbox writes.
         * Named for its purpose rather than `mapKeys`, which reads as Kotlin's
         * `Map.mapKeys` transform at the call site.
         */
        val exclusionKeys: List<String> get() = skills.map { it.mapKey }

        /** True when any row was inferred rather than observed, so the label can say so. */
        val anyInferred: Boolean get() = skills.any { it.detection == "heuristic" }
    }

    /** Skills captured but not yet archived onto a commit. Empty on any bridge failure. */
    fun readActive(projectDir: String): ActiveSkills {
        return try {
            gson.fromJson(run(projectDir, request("skills-active")), ActiveSkills::class.java) ?: ActiveSkills()
        } catch (ex: Exception) {
            log.warn("readActive failed: %s", ex.message)
            ActiveSkills()
        }
    }

    /**
     * The uncommitted aggregate table, or null when nothing is captured.
     *
     * Null is the normal state right after a commit (archival empties the working
     * registry), so the caller should say that in words rather than show an empty table.
     *
     * Throws when the bridge cannot answer — see [markdownOf] for why this one does
     * not degrade the way the read paths above do.
     */
    fun liveMarkdown(projectDir: String): String? = markdownOf(projectDir, request("skills-live-markdown"))

    /**
     * The summary label for an ARCHIVED set, read off a [CommitSummary] rather than the
     * working registry — which no longer holds these rows once they are committed.
     */
    fun committedLabel(projectDir: String, skills: List<SkillCommitRef>): String? {
        return try {
            val response = run(
                projectDir,
                request("skills-label").apply { add("skills", gson.toJsonTree(skills)) },
            ).asJsonObject
            response.get("label")?.takeIf { !it.isJsonNull }?.asString
        } catch (ex: Exception) {
            log.warn("committedLabel failed: %s", ex.message)
            null
        }
    }

    /**
     * One commit's archived skills table, rendered from the summary.
     *
     * Rendered rather than read from `skills--<hash8>.md`: that file exists only in the
     * Memory Bank's visible layer, which is absent in orphan-branch-only storage mode
     * and for a foreign repo whose folder this machine has never seen.
     *
     * Throws when the bridge cannot answer — see [markdownOf]. Null here means the
     * summary really carried no skills, which for this caller is close to unreachable:
     * its row is only drawn when `summary.skills` is non-empty.
     */
    fun committedMarkdown(projectDir: String, summary: CommitSummary): String? =
        markdownOf(projectDir, request("skills-committed-markdown").apply { add("summary", gson.toJsonTree(summary)) })

    /**
     * Renders one of the two tables, THROWING on a bridge failure rather than
     * degrading to null.
     *
     * The read paths above degrade because their null means "draw nothing", which is
     * an honest thing to do with no data. Here null means the opposite: both callers
     * turn it into a sentence asserting something about the memory ("no archived
     * skill usage"). Swallowing made a daemon that was merely unreachable say that —
     * and in the committed case the row the user just clicked was drawn from the
     * summary on disk, so the panel would be contradicting data it had already read.
     * Callers separate the two and say which happened.
     */
    private fun markdownOf(projectDir: String, request: JsonObject): String? =
        run(projectDir, request).asJsonObject.get("markdown")?.takeIf { !it.isJsonNull }?.asString

    private fun request(operation: String): JsonObject = JsonObject().apply { addProperty("operation", operation) }

    private fun run(cwd: String, request: JsonObject) =
        CliIntegrations.runIdeBridge(cwd, "shared-store", gson.toJson(request))
}
