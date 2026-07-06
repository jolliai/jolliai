package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class PlanGroupingTest {

    private fun plan(slug: String, updatedAt: String, docId: Int? = null, url: String? = null) =
        PlanReference(slug = slug, title = "t", editCount = 1, addedAt = updatedAt, updatedAt = updatedAt, jolliPlanDocId = docId, jolliPlanDocUrl = url)

    @Test
    fun `planBaseKey strips an 8-hex commit suffix`() {
        PlanGrouping.planBaseKey("refactor-auth-a1b2c3d4") shouldBe "refactor-auth"
        PlanGrouping.planBaseKey("refactor-auth") shouldBe "refactor-auth"
        // Not an 8-hex suffix → unchanged.
        PlanGrouping.planBaseKey("plan-v2") shouldBe "plan-v2"
    }

    @Test
    fun `latestPlanPerName keeps one per base name, newest wins`() {
        val out = PlanGrouping.latestPlanPerName(
            listOf(
                plan("auth-11111111", "2026-01-01T00:00:00Z"),
                plan("auth-22222222", "2026-02-01T00:00:00Z"),
                plan("other-33333333", "2026-01-15T00:00:00Z"),
            ),
        )
        out shouldHaveSize 2
        // Newest 'auth' snapshot is the Feb one.
        out.first { PlanGrouping.planBaseKey(it.slug) == "auth" }.slug shouldBe "auth-22222222"
    }

    @Test
    fun `latest snapshot inherits a docId from an older pushed sibling`() {
        val out = PlanGrouping.latestPlanPerName(
            listOf(
                plan("auth-11111111", "2026-01-01T00:00:00Z", docId = 42, url = "u42"),
                plan("auth-22222222", "2026-02-01T00:00:00Z"), // newest, not yet pushed
            ),
        )
        out shouldHaveSize 1
        val winner = out.single()
        winner.slug shouldBe "auth-22222222"
        // Inherits the older sibling's docId so the push updates the one Space doc.
        winner.jolliPlanDocId shouldBe 42
        winner.jolliPlanDocUrl shouldBe "u42"
    }
}
