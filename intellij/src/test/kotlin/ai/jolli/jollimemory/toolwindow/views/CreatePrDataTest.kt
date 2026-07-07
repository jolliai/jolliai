package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.E2eTestScenario
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class CreatePrDataTest {

    private fun summary(hash: String, message: String, e2e: List<E2eTestScenario>? = null, jolliUrl: String? = null) =
        CommitSummary(
            commitHash = hash,
            commitMessage = message,
            commitAuthor = "Dev",
            commitDate = "2026-01-01T00:00:00Z",
            branch = "feature/x",
            generatedAt = "2026-01-01T00:00:00Z",
            e2eTestGuide = e2e,
            jolliDocUrl = jolliUrl,
        )

    @Nested
    inner class ParseNameStatus {
        @Test
        fun `parses modified, added, and rename rows with normalized status and dir`() {
            val raw = "M\tsrc/app/A.kt\nA\tREADME.md\nR100\told/x.kt\tnew/y.kt\n"
            val rows = CreatePrData.parseNameStatus(raw)
            rows shouldHaveSize 3
            rows[0] shouldBe CreatePrData.FileRow("src/app/A.kt", "src/app", "M")
            rows[1] shouldBe CreatePrData.FileRow("README.md", "", "A")
            // Rename → status "R", path is the NEW path.
            rows[2] shouldBe CreatePrData.FileRow("new/y.kt", "new", "R")
        }

        @Test
        fun `skips blank and malformed lines`() {
            CreatePrData.parseNameStatus("\n   \nnotabs\n") shouldHaveSize 0
        }
    }

    @Nested
    inner class ParseNumstat {
        @Test
        fun `sums insertions and deletions, skipping binary rows`() {
            val raw = "10\t2\tsrc/a.kt\n-\t-\tassets/logo.png\n5\t3\tb.kt"
            CreatePrData.parseNumstat(raw) shouldBe (15 to 5)
        }

        @Test
        fun `empty input yields zero`() {
            CreatePrData.parseNumstat("") shouldBe (0 to 0)
        }
    }

    @Nested
    inner class Assemble {
        @Test
        fun `derives title, body, memories, files, and e2e from the anchor and inputs`() {
            val e2e = listOf(E2eTestScenario(title = "Scenario A", steps = listOf("step 1"), expectedResults = listOf("ok")))
            // newest-first: anchor is the first element.
            val summaries = listOf(
                summary("aaaaaaaa1111", "feat: newest change\n\nbody", e2e = e2e),
                summary("bbbbbbbb2222", "fix: older change"),
            )
            val files = listOf(CreatePrData.FileRow("src/A.kt", "src", "M"))
            val vm = CreatePrData.assemble(
                branch = "feature/x",
                mainBranch = "main",
                summaries = summaries,
                stats = CreatePrData.Stats(10, 2, 1),
                files = files,
                existingPr = null,
                signedIn = true,
            )

            vm.title shouldBe "feat: newest change"
            vm.memoryCount shouldBe 2
            vm.insertions shouldBe 10
            vm.deletions shouldBe 2
            vm.filesChanged shouldBe 1
            vm.files shouldBe files
            vm.memories.map { it.hash } shouldContainExactly listOf("aaaaaaaa1111", "bbbbbbbb2222")
            vm.memories[0].title shouldBe "feat: newest change"
            vm.e2eScenarios shouldBe e2e
            vm.existingPr shouldBe null
            vm.signedIn shouldBe true
            vm.includedSummaries shouldHaveSize 2
        }

        @Test
        fun `carries existing PR when present`() {
            val vm = CreatePrData.assemble(
                "feature/x", "main",
                listOf(summary("h1", "only change")),
                CreatePrData.Stats(0, 0, 0), emptyList(),
                existingPr = CreatePrData.ExistingPr(42, "https://github.com/o/r/pull/42"),
                signedIn = false,
            )
            vm.existingPr shouldBe CreatePrData.ExistingPr(42, "https://github.com/o/r/pull/42")
            vm.signedIn shouldBe false
        }

        @Test
        fun `threads branch token totals into the view model`() {
            val totals = ai.jolli.jollimemory.toolwindow.BranchTokenTotals(
                input = 100, output = 50, cacheRead = 0, cacheWrite = 10,
                partial = false, estimatedCostUsd = 0.12,
            )
            val vm = CreatePrData.assemble(
                "feature/x", "main",
                listOf(summary("h1", "only change")),
                CreatePrData.Stats(0, 0, 0), emptyList(),
                existingPr = null, signedIn = true,
                branchTokenTotals = totals,
            )
            vm.branchTokenTotals shouldBe totals
        }

        @Test
        fun `defaults branch token totals to null`() {
            val vm = CreatePrData.assemble(
                "feature/x", "main",
                listOf(summary("h1", "only change")),
                CreatePrData.Stats(0, 0, 0), emptyList(),
                existingPr = null, signedIn = true,
            )
            vm.branchTokenTotals shouldBe null
        }
    }
}
