package ai.jolli.jollimemory.core

import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class RoutePlanTest {

    private fun batch(n: Int) = (0 until n).map { SourceRef(SourceType.SUMMARY, "h$it", "2026-01-01T00:00:0${it}Z") }

    @Test
    fun `parses updates and newTopics, mapping ordinals to refs`() {
        val b = batch(2)
        val text = """{"updates":[{"stableSlug":"existing","sourceIndexes":[0]}],"newTopics":[{"stableSlug":"fresh","title":"Fresh","sourceIndexes":[1]}]}"""
        val plan = RoutePlanParser.parseRoutePlan(text, null, b)
        plan.error shouldBe null
        plan.assignments["existing"]!!.isNew.shouldBeFalse()
        plan.assignments["existing"]!!.refs shouldBe listOf(b[0])
        plan.assignments["fresh"]!!.isNew.shouldBeTrue()
        plan.assignments["fresh"]!!.title shouldBe "Fresh"
        plan.assignments["fresh"]!!.refs shouldBe listOf(b[1])
    }

    @Test
    fun `strips a json code fence`() {
        val text = "```json\n{\"newTopics\":[{\"stableSlug\":\"t\",\"sourceIndexes\":[0]}]}\n```"
        val plan = RoutePlanParser.parseRoutePlan(text, null, batch(1))
        plan.error shouldBe null
        plan.assignments["t"].shouldNotBeNull()
    }

    @Test
    fun `fails loud on max_tokens, invalid JSON, and out-of-range index`() {
        RoutePlanParser.parseRoutePlan("{}", "max_tokens", batch(1)).error.shouldNotBeNull()
        RoutePlanParser.parseRoutePlan("not json", null, batch(1)).error.shouldNotBeNull()
        val oob = RoutePlanParser.parseRoutePlan("""{"updates":[{"stableSlug":"t","sourceIndexes":[5]}]}""", null, batch(2))
        oob.error.shouldNotBeNull()
        oob.assignments.isEmpty().shouldBeTrue()
    }

    @Test
    fun `union-merges a slug present in both updates and newTopics`() {
        val b = batch(2)
        val text = """{"updates":[{"stableSlug":"t","sourceIndexes":[0]}],"newTopics":[{"stableSlug":"t","title":"T","sourceIndexes":[1]}]}"""
        val plan = RoutePlanParser.parseRoutePlan(text, null, b)
        val a = plan.assignments["t"]!!
        a.isNew.shouldBeTrue() // new flag preserved
        a.title shouldBe "T"
        a.refs shouldBe listOf(b[0], b[1])
    }

    @Test
    fun `drops entries with no valid refs`() {
        val plan = RoutePlanParser.parseRoutePlan("""{"updates":[{"stableSlug":"t","sourceIndexes":[]}]}""", null, batch(1))
        plan.error shouldBe null
        plan.assignments.isEmpty().shouldBeTrue()
    }
}
