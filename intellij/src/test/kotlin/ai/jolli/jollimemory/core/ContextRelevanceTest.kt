package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.core.ContextRelevance.ContextItem
import ai.jolli.jollimemory.core.ContextRelevance.ContextKind
import ai.jolli.jollimemory.core.ContextRelevance.ContextRelevanceResult
import ai.jolli.jollimemory.core.ContextRelevance.RelevanceTier
import ai.jolli.jollimemory.core.references.ReferenceEntry
import ai.jolli.jollimemory.core.references.SourceId
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.mockk.every
import io.mockk.mockkObject
import io.mockk.unmockkObject
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class ContextRelevanceTest {

    private fun item(kind: ContextKind, id: String, title: String, content: String) =
        ContextItem(kind, id, title, content)

    // ── stripFrontmatter ─────────────────────────────────────────────────

    @Nested
    inner class StripFrontmatter {
        @Test
        fun `strips a leading YAML frontmatter block`() {
            val body = "---\ntitle: X\ntags: [a]\n---\nReal content here"
            ContextRelevance.stripFrontmatter(body) shouldBe "Real content here"
        }

        @Test
        fun `leaves content without frontmatter untouched`() {
            val body = "No frontmatter\n---\nnot a boundary"
            ContextRelevance.stripFrontmatter(body) shouldBe body
        }
    }

    // ── buildSkeleton ────────────────────────────────────────────────────

    @Nested
    inner class BuildSkeleton {
        @Test
        fun `captures headings, files, and overview`() {
            val body = buildString {
                appendLine("Lead paragraph describing the change area.")
                appendLine()
                appendLine("# Section One")
                appendLine("First sentence of one. Second ignored.")
                appendLine("## Section Two")
                appendLine("Touches src/core/Foo.kt heavily.")
            }
            val out = ContextRelevance.buildSkeleton(ContextKind.plan, "My Plan", body, 4500)
            out shouldContain "mechanical skeleton"
            out shouldContain "Title: My Plan"
            out shouldContain "Overview: Lead paragraph"
            out shouldContain "Sections: Section One / Section Two"
            out shouldContain "src/core/Foo.kt"
        }

        @Test
        fun `ignores headings inside code fences`() {
            val body = "Intro line.\n\n```\n# Not a heading\n```\n# Real Heading\nBody."
            val out = ContextRelevance.buildSkeleton(ContextKind.note, "T", body, 4500)
            out shouldContain "Sections: Real Heading"
            out shouldNotContain "Not a heading"
        }

        @Test
        fun `truncates output at the cap`() {
            val body = "x".repeat(10_000)
            val out = ContextRelevance.buildSkeleton(ContextKind.plan, "T", body, 200)
            (out.length <= 200 + "\n[…truncated]".length) shouldBe true
            out shouldContain "[…truncated]"
        }
    }

    // ── extractCandidateRepr ─────────────────────────────────────────────

    @Nested
    inner class ExtractCandidateRepr {
        @Test
        fun `sends small plan whole`() {
            val repr = ContextRelevance.extractCandidateRepr(item(ContextKind.plan, "p", "T", "short body"))
            repr shouldBe "short body"
        }

        @Test
        fun `skeletonizes a large plan`() {
            val big = "# Heading\n" + "word ".repeat(3000)
            val repr = ContextRelevance.extractCandidateRepr(item(ContextKind.plan, "p", "T", big))
            repr shouldContain "mechanical skeleton"
        }

        @Test
        fun `strips reference frontmatter before the whole-cap check`() {
            val ref = "---\ntitle: X\n---\nbody text"
            val repr = ContextRelevance.extractCandidateRepr(item(ContextKind.reference, "r", "T", ref))
            repr shouldBe "body text"
        }
    }

    // ── buildItemsBlock ──────────────────────────────────────────────────

    @Nested
    inner class BuildItemsBlock {
        @Test
        fun `numbers items 1-based and maps index to id`() {
            val items = listOf(
                item(ContextKind.plan, "alpha", "Alpha", "a"),
                item(ContextKind.note, "beta", "Beta", "b"),
            )
            val result = ContextRelevance.buildItemsBlock(items)
            result.indexToId[1] shouldBe "alpha"
            result.indexToId[2] shouldBe "beta"
            result.block shouldContain "[1] (plan) Alpha"
            result.block shouldContain "[2] (note) Beta"
            result.dropped shouldBe 0
        }

        @Test
        fun `drops tail items over the total budget`() {
            val items = (1..5).map { item(ContextKind.plan, "p$it", "T$it", "x".repeat(100)) }
            val result = ContextRelevance.buildItemsBlock(items, totalBudget = 150)
            result.dropped shouldBe 4
            result.indexToId.size shouldBe 1
        }
    }

    // ── parseRankContextResponse ─────────────────────────────────────────

    @Nested
    inner class ParseRankContextResponse {
        @Test
        fun `parses well-formed ITEM blocks`() {
            val text = """
                ===ITEM===
                index: 1
                relevant: yes
                score: 0.87
                reason: overlaps the changed files
                ===ITEM===
                index: 2
                relevant: no
                score: 0.10
                reason: unrelated area
            """.trimIndent()
            val parsed = ContextRelevance.parseRankContextResponse(text)
            parsed shouldHaveSize 2
            parsed[0].index shouldBe 1
            parsed[0].relevant shouldBe true
            parsed[0].score shouldBe 0.87
            parsed[0].reason shouldBe "overlaps the changed files"
            parsed[1].relevant shouldBe false
            parsed[1].score shouldBe 0.10
        }

        @Test
        fun `skips a block with an unparseable index`() {
            val text = "===ITEM===\nrelevant: yes\nscore: 0.5\n===ITEM===\nindex: 3\nrelevant: yes\nscore: 0.9"
            val parsed = ContextRelevance.parseRankContextResponse(text)
            parsed shouldHaveSize 1
            parsed[0].index shouldBe 3
        }

        @Test
        fun `defaults score conservatively when omitted`() {
            val relevant = ContextRelevance.parseRankContextResponse("===ITEM===\nindex: 1\nrelevant: yes")
            relevant[0].score shouldBe 0.7
            val notRel = ContextRelevance.parseRankContextResponse("===ITEM===\nindex: 1\nrelevant: no")
            notRel[0].score shouldBe 0.2
        }

        @Test
        fun `treats missing relevant field as relevant`() {
            val parsed = ContextRelevance.parseRankContextResponse("===ITEM===\nindex: 1\nscore: 0.4")
            parsed[0].relevant shouldBe true
        }
    }

    // ── tierForRank / isBottomRank ───────────────────────────────────────

    @Nested
    inner class TierByPosition {
        @Test
        fun `single item is always high`() {
            ContextRelevance.tierForRank(1, 1) shouldBe RelevanceTier.high
            ContextRelevance.isBottomRank(1, 1) shouldBe false
        }

        @Test
        fun `top third high, middle mid, bottom low`() {
            val total = 9 // frac = (rank-1)/8
            ContextRelevance.tierForRank(1, total) shouldBe RelevanceTier.high // 0.0
            ContextRelevance.tierForRank(3, total) shouldBe RelevanceTier.high // 0.25 <= 1/3
            ContextRelevance.tierForRank(4, total) shouldBe RelevanceTier.mid  // 0.375 > 1/3
            ContextRelevance.tierForRank(5, total) shouldBe RelevanceTier.mid  // 0.5
            ContextRelevance.tierForRank(9, total) shouldBe RelevanceTier.low  // 1.0
            ContextRelevance.isBottomRank(9, total) shouldBe true
            ContextRelevance.isBottomRank(5, total) shouldBe false
        }
    }

    // ── mergeAndRank ─────────────────────────────────────────────────────

    @Nested
    inner class MergeAndRank {
        @Test
        fun `ranks by score desc and assigns tier + autoExclude by position`() {
            val items = listOf(
                item(ContextKind.plan, "low", "Low", "x"),
                item(ContextKind.note, "high", "High", "y"),
                item(ContextKind.reference, "mid", "Mid", "z"),
            )
            val indexToId = mapOf(1 to "low", 2 to "high", 3 to "mid")
            val parsed = listOf(
                ContextRelevance.ParsedItem(1, relevant = false, score = 0.1, reason = "no"),
                ContextRelevance.ParsedItem(2, relevant = true, score = 0.9, reason = "yes"),
                ContextRelevance.ParsedItem(3, relevant = true, score = 0.5, reason = "maybe"),
            )
            val ranked = ContextRelevance.mergeAndRank(items, indexToId, parsed)
            ranked.map { it.id } shouldContainExactly listOf("high", "mid", "low")
            ranked[0].tier shouldBe RelevanceTier.high
            ranked[2].tier shouldBe RelevanceTier.low
            // Bottom-third AND not relevant → autoExclude.
            ranked[2].autoExclude shouldBe true
            ranked[0].autoExclude shouldBe false
        }

        @Test
        fun `does not auto-exclude a not-relevant item that is not bottom-third`() {
            val items = (1..3).map { item(ContextKind.plan, "p$it", "T$it", "x") }
            val indexToId = mapOf(1 to "p1", 2 to "p2", 3 to "p3")
            // p1 top score but marked not-relevant → top rank, not bottom → kept.
            val parsed = listOf(
                ContextRelevance.ParsedItem(1, relevant = false, score = 0.99, reason = "r"),
                ContextRelevance.ParsedItem(2, relevant = true, score = 0.5, reason = "r"),
                ContextRelevance.ParsedItem(3, relevant = true, score = 0.4, reason = "r"),
            )
            val ranked = ContextRelevance.mergeAndRank(items, indexToId, parsed)
            ranked.first { it.id == "p1" }.autoExclude shouldBe false
        }
    }

    // ── extractSymbols ───────────────────────────────────────────────────

    @Nested
    inner class ExtractSymbols {
        @Test
        fun `extracts declared symbols from added lines only`() {
            val diff = """
                +++ b/File.kt
                +class Foo {
                +fun bar() {}
                -class Removed
                 val untouched = 1
            """.trimIndent()
            val symbols = ContextRelevance.extractSymbols(diff)
            symbols shouldContain "Foo"
            symbols shouldContain "bar"
            symbols shouldNotContain "Removed"
        }
    }

    // ── rankContextRelevance (LLM boundary) ──────────────────────────────

    @Nested
    inner class RankContextRelevance {
        @Test
        fun `returns empty for no items`() {
            ContextRelevance.rankContextRelevance(
                ContextRelevance.ChangeSignal("m", emptyList(), emptyList()),
                emptyList(),
                JolliMemoryConfig(),
            ).shouldBeEmpty()
        }

        @Test
        fun `fails open to keepAll when the LLM call throws`() {
            val items = listOf(item(ContextKind.plan, "p1", "T", "x"), item(ContextKind.note, "n1", "T", "y"))
            mockkObject(LlmClient)
            try {
                every { LlmClient.callLlm(any(), any(), any(), any(), any(), any(), any(), any()) } throws RuntimeException("boom")
                val result = ContextRelevance.rankContextRelevance(
                    ContextRelevance.ChangeSignal("m", emptyList(), emptyList()), items, JolliMemoryConfig(),
                )
                result shouldHaveSize 2
                result.all { it.relevant && !it.autoExclude } shouldBe true
            } finally {
                unmockkObject(LlmClient)
            }
        }

        @Test
        fun `parses a successful ranking response end-to-end`() {
            val items = listOf(
                item(ContextKind.plan, "p1", "Alpha", "x"),
                item(ContextKind.note, "n1", "Beta", "y"),
                item(ContextKind.reference, "r1", "Gamma", "z"),
            )
            val response = """
                ===ITEM===
                index: 1
                relevant: no
                score: 0.05
                reason: unrelated
                ===ITEM===
                index: 2
                relevant: yes
                score: 0.95
                reason: core
                ===ITEM===
                index: 3
                relevant: yes
                score: 0.55
                reason: adjacent
            """.trimIndent()
            mockkObject(LlmClient)
            try {
                every { LlmClient.callLlm(any(), any(), any(), any(), any(), any(), any(), any()) } returns
                    LlmClient.LlmCallResult(response, "m", 1, 1, 1L, "end_turn")
                val result = ContextRelevance.rankContextRelevance(
                    ContextRelevance.ChangeSignal("m", listOf("a.kt"), emptyList()), items, JolliMemoryConfig(apiKey = "sk-x"),
                )
                result.map { it.id } shouldContainExactly listOf("n1", "r1", "p1")
                result.first { it.id == "p1" }.autoExclude shouldBe true
            } finally {
                unmockkObject(LlmClient)
            }
        }
    }

    // ── assessContextRelevance (partition) ───────────────────────────────

    @Nested
    inner class AssessContextRelevance {
        private fun plan(slug: String, title: String) =
            PlanEntry(slug = slug, title = title, sourcePath = "/nonexistent/$slug.md", addedAt = "", updatedAt = "", commitHash = null)

        private fun note(id: String, title: String) =
            NoteEntry(id = id, title = title, format = NoteFormat.markdown, addedAt = "", updatedAt = "", branch = "main", commitHash = null, sourcePath = null)

        private fun ref(nativeId: String, title: String) =
            ReferenceEntry(SourceId.linear, nativeId, title, "https://x/$nativeId", "/nonexistent/$nativeId.md", "", "", "linear")

        @Test
        fun `keeps everything and excludes nothing when no items`() {
            val decision = ContextRelevance.assessContextRelevance(
                ContextRelevance.RawContextEntries(emptyList(), emptyList(), emptyList()),
                ContextRelevance.ChangeSignal("m", emptyList(), emptyList()),
                JolliMemoryConfig(),
            )
            decision.excludedContext.shouldBeEmpty()
        }

        @Test
        fun `partitions kept vs soft-excluded from ranker results`() {
            val raw = ContextRelevance.RawContextEntries(
                plans = listOf(plan("p1", "Plan One")),
                notes = listOf(note("n1", "Note One")),
                references = listOf(ref("JOLLI-9", "Ref One")),
            )
            // Fake ranker: plan kept, note auto-excluded, reference auto-excluded.
            val fakeRanker: (ContextRelevance.ChangeSignal, List<ContextItem>) -> List<ContextRelevanceResult> = { _, _ ->
                listOf(
                    ContextRelevanceResult("p1", ContextKind.plan, relevant = true, score = 0.9, tier = RelevanceTier.high, reason = "keep", rank = 1, autoExclude = false),
                    ContextRelevanceResult("n1", ContextKind.note, relevant = false, score = 0.1, tier = RelevanceTier.low, reason = "note unrelated", rank = 2, autoExclude = true),
                    ContextRelevanceResult("linear:JOLLI-9", ContextKind.reference, relevant = false, score = 0.05, tier = RelevanceTier.low, reason = "ref unrelated", rank = 3, autoExclude = true),
                )
            }
            val decision = ContextRelevance.assessContextRelevance(
                raw, ContextRelevance.ChangeSignal("m", emptyList(), emptyList()), JolliMemoryConfig(), fakeRanker,
            )

            decision.plans.map { it.slug } shouldContainExactly listOf("p1")
            decision.notes.shouldBeEmpty()
            decision.references.shouldBeEmpty()
            decision.excludedContext shouldHaveSize 2
            val noteExcl = decision.excludedContext.first { it.kind == "note" }
            noteExcl.key shouldBe "n1"
            noteExcl.title shouldBe "Note One"
            noteExcl.reason shouldBe "note unrelated"
            val refExcl = decision.excludedContext.first { it.kind == "reference" }
            refExcl.key shouldBe "linear:JOLLI-9"
            // Reference label = "<nativeId> — <title>"
            refExcl.title shouldBe "JOLLI-9 — Ref One"
        }
    }
}
