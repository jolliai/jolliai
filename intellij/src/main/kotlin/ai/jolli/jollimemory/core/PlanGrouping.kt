package ai.jolli.jollimemory.core

/**
 * PlanGrouping — Kotlin port of vscode/src/util/PlanGrouping.ts (the push-relevant subset).
 *
 * A plan committed to a commit is archived under a slug that embeds the commit
 * hash (`<base-slug>-<shortHash>`). Squash consolidation hoists every source
 * commit's plans into the consolidated commit, so the same logical plan appears
 * once per source commit — same title, different slug. These helpers collapse
 * those snapshots by base name and pick the latest, so the push path never mints
 * duplicate same-named Space documents.
 */
object PlanGrouping {

    private val HASH_SUFFIX = Regex("-[0-9a-f]{8}$")

    /**
     * Strips a trailing archived commit-hash suffix (`-<8 hex>`) to get the base name.
     * Committed snapshots (`refactor-auth-a1b2c3d4`) and an uncommitted base
     * (`refactor-auth`) collapse to the same key.
     */
    fun planBaseKey(slug: String): String = slug.replace(HASH_SUFFIX, "")

    /**
     * Compares two plans newest-first by `updatedAt`, tiebroken by `slug` so the
     * order is deterministic.
     */
    private fun byUpdatedAtDesc(a: PlanReference, b: PlanReference): Int {
        if (a.updatedAt != b.updatedAt) return if (a.updatedAt < b.updatedAt) 1 else -1
        return a.slug.compareTo(b.slug)
    }

    /**
     * Returns exactly one plan per base name — the latest snapshot — preserving the
     * newest-first order. Used to avoid pushing duplicate same-named documents to Jolli.
     *
     * Same-named plans share an identical server push identity (the slug is NOT sent),
     * so `jolliPlanDocId` is the only thing that tells the server to UPDATE rather than
     * CREATE. When a previously pushed older snapshot carries the docId but the latest
     * snapshot does not, the latest inherits that docId/url so the push updates the
     * existing article instead of creating a duplicate.
     */
    fun latestPlanPerName(plans: List<PlanReference>): List<PlanReference> {
        val sorted = plans.sortedWith(::byUpdatedAtDesc)
        // Newest already-pushed docId/url per base name (first hit wins = newest).
        val pushedDoc = HashMap<String, Pair<Int, String?>>()
        for (plan in sorted) {
            val key = planBaseKey(plan.slug)
            if (plan.jolliPlanDocId != null && !pushedDoc.containsKey(key)) {
                pushedDoc[key] = plan.jolliPlanDocId to plan.jolliPlanDocUrl
            }
        }
        val seen = HashSet<String>()
        val result = ArrayList<PlanReference>()
        for (plan in sorted) {
            val key = planBaseKey(plan.slug)
            if (!seen.add(key)) continue
            if (plan.jolliPlanDocId == null) {
                val inherited = pushedDoc[key]
                if (inherited != null) {
                    result.add(plan.copy(jolliPlanDocId = inherited.first, jolliPlanDocUrl = inherited.second))
                    continue
                }
            }
            result.add(plan)
        }
        return result
    }
}
