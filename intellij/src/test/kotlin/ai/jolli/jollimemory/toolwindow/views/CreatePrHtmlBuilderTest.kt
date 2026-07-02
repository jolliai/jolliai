package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.E2eTestScenario
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Test

class CreatePrHtmlBuilderTest {

    private fun summary(hash: String, message: String) = CommitSummary(
        commitHash = hash, commitMessage = message, commitAuthor = "Dev",
        commitDate = "t", branch = "feature/x", generatedAt = "t",
    )

    private fun vm(
        existingPr: CreatePrData.ExistingPr? = null,
        signedIn: Boolean = true,
        title: String = "feat: redesign",
        e2e: List<E2eTestScenario> = emptyList(),
    ) = CreatePrData.ViewModel(
        branch = "feature/x",
        mainBranch = "main",
        memoryCount = 2,
        insertions = 10,
        deletions = 2,
        filesChanged = 1,
        title = title,
        bodyMarkdown = "## Summary\n\nDid the thing.",
        memories = listOf(
            CreatePrData.MemoryRow("aaaaaaaa1111", "feat: redesign", jolliDocUrl = null),
            CreatePrData.MemoryRow("bbbbbbbb2222", "fix: bug", jolliDocUrl = "https://x/articles?doc=1"),
        ),
        files = listOf(CreatePrData.FileRow("src/App.kt", "src", "M")),
        e2eScenarios = e2e,
        existingPr = existingPr,
        signedIn = signedIn,
        includedSummaries = listOf(summary("aaaaaaaa1111", "feat: redesign")),
    )

    @Test
    fun `renders create mode with meta strip, memories, files, and body data`() {
        val html = CreatePrHtmlBuilder.buildHtml(vm(), isDark = true, bridgeScript = "")
        html shouldContain "Create Pull Request"
        html shouldContain """id="cmdCreatePr">Create PR"""
        html shouldContain """<span class="meta-branch">feature/x</span>"""
        html shouldContain "drafted from 2 memories"
        html shouldContain "+10 −2 · 1 file"
        // memory + file rows
        html shouldContain """data-hash="aaaaaaaa1111""""
        html shouldContain """data-path="src/App.kt""""
        html shouldContain """gs gs-M"""
        // body markdown carried for client-side rendering (not raw <pre>)
        html shouldContain """id="prBody""""
        html shouldContain "## Summary"
    }

    @Test
    fun `renders update mode with PR link when an open PR exists`() {
        val html = CreatePrHtmlBuilder.buildHtml(
            vm(existingPr = CreatePrData.ExistingPr(42, "https://github.com/o/r/pull/42")),
            isDark = false, bridgeScript = "",
        )
        html shouldContain "Update Pull Request"
        html shouldContain """id="cmdCreatePr">Update PR"""
        html shouldContain "PR #42"
        html shouldContain """data-pr-url="https://github.com/o/r/pull/42""""
    }

    @Test
    fun `shows signed-in share copy when signed in, sign-in prompt otherwise`() {
        CreatePrHtmlBuilder.buildHtml(vm(signedIn = true), true, "") shouldContain "also shares the included memories to Jolli"
        val signedOut = CreatePrHtmlBuilder.buildHtml(vm(signedIn = false), true, "")
        signedOut shouldContain "prSignInLink"
        signedOut shouldContain "stays a normal git PR"
    }

    @Test
    fun `renders E2E panel with scenario count when scenarios exist`() {
        val html = CreatePrHtmlBuilder.buildHtml(
            vm(e2e = listOf(E2eTestScenario(title = "S1", steps = listOf("do"), expectedResults = listOf("ok")))),
            true, "",
        )
        html shouldContain "E2E Test Guide"
        html shouldContain "1 SCENARIO"
    }

    @Test
    fun `escapes HTML in the title to prevent injection`() {
        val html = CreatePrHtmlBuilder.buildHtml(vm(title = "<img src=x onerror=alert(1)>"), true, "")
        html shouldContain "&lt;img src=x onerror=alert(1)&gt;"
        html shouldNotContain "<img src=x onerror=alert(1)>"
    }
}
