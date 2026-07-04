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
        hasUnpushedChanges: Boolean = true,
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
        hasUnpushedChanges = hasUnpushedChanges,
    )

    @Test
    fun `renders create mode with meta strip, memories, files, and body data`() {
        val html = CreatePrHtmlBuilder.buildHtml(vm(), isDark = true, bridgeScript = "")
        html shouldContain "Create Pull Request"
        html shouldContain """id="cmdCreatePr""""
        html shouldContain ">Create PR</button>"
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
        html shouldContain ">Update PR</button>"
        html shouldContain "PR #42"
        html shouldContain """data-pr-url="https://github.com/o/r/pull/42""""
    }

    @Test
    fun `keeps Update PR enabled even with no unpushed commits (body-only updates are valid), with an informational hint`() {
        val pr = CreatePrData.ExistingPr(42, "https://github.com/o/r/pull/42")
        // Update mode, nothing new to push: the button must NOT be disabled — the PR body
        // is memory-derived and can change without a commit — but an informational hint shows.
        val upToDate = CreatePrHtmlBuilder.buildHtml(vm(existingPr = pr, hasUnpushedChanges = false), true, "")
        upToDate shouldContain """id="cmdCreatePr" data-uptodate="true">Update PR</button>"""
        upToDate shouldNotContain """id="cmdCreatePr" data-uptodate="true" disabled"""
        upToDate shouldContain """<span class="up-to-date">"""
        // Update mode with unpushed commits → enabled, no hint.
        val hasChanges = CreatePrHtmlBuilder.buildHtml(vm(existingPr = pr, hasUnpushedChanges = true), true, "")
        hasChanges shouldContain """id="cmdCreatePr" data-uptodate="false">Update PR</button>"""
        hasChanges shouldNotContain """<span class="up-to-date">"""
        // Create mode: enabled, no hint.
        val create = CreatePrHtmlBuilder.buildHtml(vm(existingPr = null, hasUnpushedChanges = false), true, "")
        create shouldContain """id="cmdCreatePr" data-uptodate="false">Create PR</button>"""
        create shouldNotContain """<span class="up-to-date">"""
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
    fun `edits title and body in place — no separate edit form — and includes a copy toast`() {
        val html = CreatePrHtmlBuilder.buildHtml(vm(), isDark = true, bridgeScript = "")
        // Inline editors live inside the Title/Body panels (hidden until Edit).
        html shouldContain """id="prTitleDisplay""""
        html shouldContain """id="prTitleInput" class="pr-input hidden""""
        html shouldContain """id="prBodyInput" class="pr-textarea hidden""""
        // Toast target for the copy confirmation.
        html shouldContain """id="prToast""""
        // The old separate edit form is gone.
        html shouldNotContain """id="editForm""""
        html shouldNotContain "cmdCreateEdited"
    }

    @Test
    fun `escapes HTML in the title to prevent injection`() {
        val html = CreatePrHtmlBuilder.buildHtml(vm(title = "<img src=x onerror=alert(1)>"), true, "")
        html shouldContain "&lt;img src=x onerror=alert(1)&gt;"
        html shouldNotContain "<img src=x onerror=alert(1)>"
    }
}
