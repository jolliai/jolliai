package ai.jolli.jollimemory.toolwindow

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Pure-logic coverage for [BreadcrumbHeaderPanel.resolveRestoredRepoSelection].
 * The Swing surface is heavy to bring up in isolation, so the selection-restore
 * rule is factored into a static companion helper — this test locks down the
 * cross-mode transitions.
 *
 * Regression guard for the bug where switching from Memory Bank
 * (REPO_FILTER, `[All repos, repo-a, repo-b]`) to Current Branch
 * (BRANCH, `[repo-a, repo-b]`) used to leak the literal `"All repos"` into the
 * Branch view — see AGENTS.md's discussion of the picker item lists.
 */
class BreadcrumbHeaderPanelSelectionTest {

    private val ALL_REPOS = BreadcrumbHeaderPanel.ALL_REPOS_LABEL

    @Test
    fun `restores the previous selection when it is a member of the new items`() {
        val restored = BreadcrumbHeaderPanel.resolveRestoredRepoSelection(
            previous = "repo-a",
            newItems = listOf("repo-a", "repo-b"),
        )
        restored shouldBe "repo-a"
    }

    @Test
    fun `restores previous selection across REPO_FILTER to BRANCH when the repo carries over`() {
        // REPO_FILTER items are [ALL_REPOS] + repoNames; BRANCH items are just repoNames.
        // A real repo picked in Memory Bank must survive the switch as-is.
        val restored = BreadcrumbHeaderPanel.resolveRestoredRepoSelection(
            previous = "repo-b",
            newItems = listOf("repo-a", "repo-b"),
        )
        restored shouldBe "repo-b"
    }

    @Test
    fun `drops All repos when transitioning to BRANCH mode and falls back to the workspace repo`() {
        // The regression: previously, `"All repos"` was retained even though it
        // is NOT in the BRANCH item list. `onBranchSelected` would then hand
        // it to `onSelectionChanged` as the repo name.
        val restored = BreadcrumbHeaderPanel.resolveRestoredRepoSelection(
            previous = ALL_REPOS,
            newItems = listOf("repo-a", "repo-b"),
        )
        restored shouldBe "repo-a"
    }

    @Test
    fun `keeps All repos when transitioning to a mode whose items include All repos`() {
        // The other direction (BRANCH → REPO_FILTER) doesn't happen with an
        // "All repos" previous, but if code ever re-enters REPO_FILTER after
        // having selected "All repos" on a prior visit, that must survive.
        val restored = BreadcrumbHeaderPanel.resolveRestoredRepoSelection(
            previous = ALL_REPOS,
            newItems = listOf(ALL_REPOS, "repo-a", "repo-b"),
        )
        restored shouldBe ALL_REPOS
    }

    @Test
    fun `null previous selection falls back to the first non-All-repos item`() {
        // Cold-start into REPO_FILTER: the caller hasn't picked anything yet.
        // Skip the synthetic entry — the default UX is scoped to the workspace
        // repo, not "All repos".
        val restored = BreadcrumbHeaderPanel.resolveRestoredRepoSelection(
            previous = null,
            newItems = listOf(ALL_REPOS, "workspace-repo", "other"),
        )
        restored shouldBe "workspace-repo"
    }

    @Test
    fun `returns null when there is no real repo to fall back to`() {
        // Empty items — the caller may enter REPO_FILTER mode during panel
        // construction before refresh() populates repos. Nothing to restore
        // and nothing to fall back to. setMode's downstream broadcast is
        // separately guarded on `repos.isNotEmpty()`, so returning null here
        // is also what stops a rebuild against an empty cache.
        BreadcrumbHeaderPanel.resolveRestoredRepoSelection(previous = "stale", newItems = emptyList())
            .shouldBeNull()
        // Only "All repos" available (REPO_FILTER cold-start with an empty repos
        // list): the fallback deliberately skips ALL_REPOS_LABEL (default UX is
        // scoped to the workspace repo, not "All repos"), so with no real repo
        // in the list the function returns null. The broadcast-time
        // `repos.isNotEmpty()` guard is what prevents a downstream rebuild in
        // that case.
        BreadcrumbHeaderPanel.resolveRestoredRepoSelection(previous = null, newItems = listOf(ALL_REPOS))
            .shouldBeNull()
    }
}
