package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.E2eTestScenario
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.PrService
import com.intellij.openapi.project.Project

/**
 * CreatePrData — assembles the branch-level view model rendered by the dedicated
 * "Create PR" webview. Kotlin port of the VS Code `CreatePrData.ts`: it aggregates
 * every committed memory on the branch (not just the newest one) so the pane can
 * show the mockup's meta-strip, "Memories included" list, and branch-wide
 * "Files changed".
 *
 * The **anchor** is the newest memory ([JolliMemoryService.getBranchCommits] returns
 * newest-first). Title, body, and E2E scenarios are drawn from the anchor, mirroring
 * the current single-memory create flow; the full memory set is listed separately.
 *
 * The pure functions ([assemble], [parseNameStatus], [parseNumstat]) are split out
 * from [build] so they are unit-testable without an IDE/git surface.
 */
object CreatePrData {

    private val log = JmLogger.create("CreatePrData")

    data class FileRow(val path: String, val dir: String, val status: String)

    data class MemoryRow(val hash: String, val title: String, val jolliDocUrl: String?)

    data class ExistingPr(val number: Int, val url: String)

    data class ViewModel(
        val branch: String,
        val mainBranch: String,
        val memoryCount: Int,
        val insertions: Int,
        val deletions: Int,
        val filesChanged: Int,
        /** PR title — first line of the newest memory's commit message. */
        val title: String,
        /** Raw PR body markdown (no idempotent markers; wrapped on submit). */
        val bodyMarkdown: String,
        val memories: List<MemoryRow>,
        val files: List<FileRow>,
        val e2eScenarios: List<E2eTestScenario>,
        /** Open PR already on this branch — renders "Update PR" + link when present. */
        val existingPr: ExistingPr?,
        /** True when a Jolli site key is configured — gates the "also share to Jolli" copy + action. */
        val signedIn: Boolean,
        /** Summaries included in this PR, newest-first — the payload the share step pushes. */
        val includedSummaries: List<CommitSummary>,
        /**
         * True when the branch has local commits not yet on its remote (something to
         * push). In Update mode the primary button dims when this is false — there's
         * nothing new to push, mirroring the commit-level push UI. Defaults to true
         * (enabled) so create-mode and tests aren't accidentally disabled.
         */
        val hasUnpushedChanges: Boolean = true,
    )

    /**
     * Gathers real branch data and builds the view model. Returns null when the
     * branch has no committed memories (caller shows the "commit first" hint).
     * Call from a pooled thread — it shells out to git/gh.
     */
    fun build(project: Project, mainBranch: String = "main"): ViewModel? {
        val service = project.getService(JolliMemoryService::class.java) ?: return null
        val cwd = service.mainRepoRoot ?: project.basePath ?: return null
        val git = service.getGitOps() ?: return null

        val summaries = service.getBranchCommits()
            .filter { it.hasSummary }
            .mapNotNull { service.getSummary(it.hash) }
        if (summaries.isEmpty()) return null

        val anchor = summaries.first() // newest-first
        val branch = anchor.branch.ifBlank { git.getCurrentBranch()?.trim() ?: "" }

        val base = resolveDeltaBase(git, branch, mainBranch)
        val (stats, files) = computeStats(git, base)

        val existingPr = when (val lookup = PrService.findPrForBranch(cwd, branch)) {
            is PrService.PrLookup.Found -> ExistingPr(lookup.pr.number, lookup.pr.url)
            else -> null
        }
        val signedIn = !SessionTracker.loadConfig(cwd).jolliApiKey.isNullOrBlank()
        // Something to push = HEAD isn't on the remote yet (unpushed commits, or a
        // branch never pushed). After a create/update with no new commits this is
        // false, so the Update button dims — matching the commit-level push UI.
        val hasUnpushedChanges = !git.isHeadPushed()

        return assemble(branch, mainBranch, summaries, stats, files, existingPr, signedIn, hasUnpushedChanges)
    }

    /** Aggregate insertions/deletions/filesChanged. */
    data class Stats(val insertions: Int, val deletions: Int, val filesChanged: Int)

    /** Pure assembly from already-fetched inputs — the unit-test seam. */
    fun assemble(
        branch: String,
        mainBranch: String,
        summaries: List<CommitSummary>,
        stats: Stats,
        files: List<FileRow>,
        existingPr: ExistingPr?,
        signedIn: Boolean,
        hasUnpushedChanges: Boolean = true,
    ): ViewModel {
        val anchor = summaries.first()
        return ViewModel(
            branch = branch,
            mainBranch = mainBranch,
            memoryCount = summaries.size,
            insertions = stats.insertions,
            deletions = stats.deletions,
            filesChanged = stats.filesChanged,
            title = firstLine(anchor.commitMessage),
            bodyMarkdown = SummaryPrMarkdownBuilder.buildPrMarkdown(anchor),
            memories = summaries.map { MemoryRow(it.commitHash, firstLine(it.commitMessage), it.jolliDocUrl) },
            files = files,
            e2eScenarios = anchor.e2eTestGuide ?: emptyList(),
            existingPr = existingPr,
            signedIn = signedIn,
            includedSummaries = summaries,
            hasUnpushedChanges = hasUnpushedChanges,
        )
    }

    private fun firstLine(s: String): String = s.substringBefore("\n").trim()

    /**
     * Resolves the base commit for the branch delta (`base..HEAD`), matching the
     * merge-base + reflog-creation-point logic in [JolliMemoryService.getBranchCommits]
     * so the stats/files line up with the listed commits. Returns null when there is
     * no common ancestor.
     */
    private fun resolveDeltaBase(git: GitOps, branch: String, mainBranch: String): String? {
        val baseRef = listOf("origin/$mainBranch", "upstream/$mainBranch", mainBranch)
            .firstOrNull { git.exec("rev-parse", "--verify", it) != null } ?: mainBranch
        val headHash = git.getHeadHash()
        val mergeBase = git.exec("merge-base", "HEAD", baseRef)?.trim()?.takeIf { it.isNotBlank() } ?: return null
        // A fresh branch with no own commits (base == HEAD) has an empty delta.
        if (mergeBase == headHash) return mergeBase
        return git.resolveOwnCommitsBase(branch, mergeBase)
    }

    /** Runs numstat + name-status over `base..HEAD` and parses both. */
    private fun computeStats(git: GitOps, base: String?): Pair<Stats, List<FileRow>> {
        if (base == null) return Stats(0, 0, 0) to emptyList()
        val numstat = git.exec("diff", "--numstat", base, "HEAD") ?: ""
        val nameStatus = git.exec("diff", "--name-status", base, "HEAD") ?: ""
        val (ins, del) = parseNumstat(numstat)
        val files = parseNameStatus(nameStatus)
        return Stats(ins, del, files.size) to files
    }

    /**
     * Sums insertions/deletions from `git diff --numstat` output. Each line is
     * `<ins>\t<del>\t<path>`; binary files use `-` for the counts and are skipped.
     */
    fun parseNumstat(raw: String): Pair<Int, Int> {
        var ins = 0
        var del = 0
        for (line in raw.split("\n")) {
            val entry = line.trimEnd('\r')
            if (entry.isBlank()) continue
            val parts = entry.split("\t")
            if (parts.size < 3) continue
            ins += parts[0].toIntOrNull() ?: 0
            del += parts[1].toIntOrNull() ?: 0
        }
        return ins to del
    }

    /**
     * Parses `git diff --name-status` output into [FileRow]s. Each line is
     * `<STATUS>\t<path>` or `R<pct>\t<old>\t<new>` for renames; rename codes like
     * "R100" normalise to "R". Mirrors the VS Code `parseNameStatus`.
     */
    fun parseNameStatus(raw: String): List<FileRow> {
        val rows = mutableListOf<FileRow>()
        for (line in raw.split("\n")) {
            val entry = line.trimEnd('\r')
            if (entry.isBlank() || !entry.contains("\t")) continue
            val parts = entry.split("\t")
            val rawStatus = parts[0]
            val status = if (rawStatus.startsWith("R")) "R" else rawStatus
            val filePath = if (status == "R" && parts.size >= 3) parts[2] else parts[1]
            val lastSlash = filePath.lastIndexOf("/")
            val dir = if (lastSlash >= 0) filePath.substring(0, lastSlash) else ""
            rows.add(FileRow(path = filePath, dir = dir, status = status))
        }
        return rows
    }
}
