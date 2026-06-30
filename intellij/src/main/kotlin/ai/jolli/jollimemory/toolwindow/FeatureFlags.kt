package ai.jolli.jollimemory.toolwindow

/**
 * Master switch for surfaces that exist in code but aren't finished yet. They are
 * built and wired but render only placeholder content, so they're gated off for
 * shipped builds. Flip to `true` to bring them all back once they're complete.
 *
 * Currently gates:
 * - The **Knowledge** view-switch tab (wiki + decision graph — placeholder card only).
 * - The **Agent Access** title-bar action ("coming soon" settings stub).
 */
object FeatureFlags {
	const val SHOW_UNFINISHED = false
}
