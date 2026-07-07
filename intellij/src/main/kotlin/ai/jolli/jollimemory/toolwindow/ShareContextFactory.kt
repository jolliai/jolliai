package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.bridge.GitRemoteUtils
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StorageFactory
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.services.BranchShareModal
import ai.jolli.jollimemory.services.JolliApiClient
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.JolliPushOrchestrator
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project

/**
 * Builds a single-slot [BranchShareModal.ShareModalContext] shared by both share surfaces —
 * the native Swing [ShareDialog] (sidebar / branch share) and the in-webview JCEF modal
 * ([SummaryPanel] commit share). Gathers config, owner, org directory, and git contributors;
 * MUST be called off the EDT (it does git + network I/O).
 */
object ShareContextFactory {

    private val log = JmLogger.create("ShareContext")

    fun build(
        project: Project,
        branch: String,
        subjectTitle: String,
        commitHash: String?,
        commitSummary: CommitSummary?,
    ): BranchShareModal.ShareModalContext {
        val service = project.getService(JolliMemoryService::class.java)
        val cwd = service?.mainRepoRoot ?: project.basePath ?: ""
        val config = SessionTracker.loadConfig(cwd)
        val apiKey = config.jolliApiKey?.takeIf { it.isNotBlank() }
        val keyMeta = apiKey?.let { JolliApiClient.parseJolliApiKey(it) }
        val git = service?.getGitOps() ?: GitOps(cwd)
        val store = SummaryStore(cwd, git, StorageFactory.create(git, cwd))

        val owner = BranchShareModal.ShareMember(
            name = git.exec("config", "user.name")?.trim().orEmpty(),
            email = git.exec("config", "user.email")?.trim().orEmpty(),
        )
        val accountMembers = if (apiKey != null) {
            JolliApiClient.listOrgMembers(keyMeta?.u, apiKey).map { BranchShareModal.ShareMember(it.name, it.email) }
        } else {
            emptyList()
        }
        val accountEmails = accountMembers.map { it.email.trim().lowercase() }.toHashSet()
        val gitCollaborators = repoContributors(git).filter { it.email.trim().lowercase() !in accountEmails }

        return BranchShareModal.ShareModalContext(
            workspaceRoot = cwd,
            branch = branch,
            apiKey = apiKey,
            commitHash = commitHash,
            commitSummary = commitSummary,
            subjectTitle = subjectTitle,
            canOrg = keyMeta?.o != null,
            owner = owner,
            accountMembers = accountMembers,
            gitCollaborators = gitCollaborators,
            loadBranchSummaries = {
                service?.getBranchCommits()
                    ?.filter { it.hasSummary }
                    ?.mapNotNull { service.getSummary(it.hash) }
                    ?.reversed() // getBranchCommits is newest-first; share wants oldest-first
                    ?: emptyList()
            },
            storeSummary = { s, _ -> store.storeSummary(s, force = true) },
            readPlanFromBranch = { slug -> store.readPlanFromBranch(slug) },
            readNoteBody = { id -> service?.readArchivedNote(id) },
            resolveBinding = { repoUrl -> resolveBindingViaChooser(project, repoUrl, keyMeta?.u, apiKey) },
            nowMs = System.currentTimeMillis(),
        )
    }

    /** Distinct repo contributors (name + email) from git history, capped. */
    private fun repoContributors(git: GitOps): List<BranchShareModal.ShareMember> {
        val out = LinkedHashMap<String, BranchShareModal.ShareMember>()
        val raw = git.exec("log", "--format=%an%x00%ae", "-500") ?: return emptyList()
        for (line in raw.split("\n")) {
            val parts = line.split(" ")
            if (parts.size < 2) continue
            val email = parts[1].trim()
            if (email.isEmpty()) continue
            val key = email.lowercase()
            if (!out.containsKey(key)) out[key] = BranchShareModal.ShareMember(parts[0].trim(), email)
            if (out.size >= 50) break
        }
        return out.values.toList()
    }

    /**
     * Resolves an unbound repo by showing [BindingChooserDialog] on the EDT and blocking the
     * calling (pooled) thread until the user finishes.
     */
    fun resolveBindingViaChooser(
        project: Project,
        repoUrl: String,
        baseUrl: String?,
        apiKey: String?,
    ): JolliPushOrchestrator.BindingOutcome {
        if (apiKey == null || baseUrl == null) return JolliPushOrchestrator.BindingOutcome.FAILED
        val spacesResult = try {
            JolliApiClient.listSpaces(baseUrl, apiKey)
        } catch (e: Exception) {
            log.warn("resolveBinding: listSpaces failed: ${e.message}")
            return JolliPushOrchestrator.BindingOutcome.FAILED
        }
        val suggestedRepoName = GitRemoteUtils.deriveRepoNameFromUrl(repoUrl).ifEmpty { "repo" }
        var outcome = JolliPushOrchestrator.BindingOutcome.FAILED
        ApplicationManager.getApplication().invokeAndWait {
            if (BindingChooserDialog.isAlreadyOpen(repoUrl)) {
                outcome = JolliPushOrchestrator.BindingOutcome.ANOTHER_OPEN
                return@invokeAndWait
            }
            val dialog = BindingChooserDialog.open(
                project, repoUrl, suggestedRepoName,
                spacesResult.spaces, spacesResult.defaultSpaceId, baseUrl, apiKey,
            )
            dialog.show()
            outcome = when (dialog.getOutcome()) {
                is BindingChooserOutcome.Selected -> JolliPushOrchestrator.BindingOutcome.BOUND
                is BindingChooserOutcome.Cancelled -> JolliPushOrchestrator.BindingOutcome.CANCELLED
                is BindingChooserOutcome.AnotherOpen -> JolliPushOrchestrator.BindingOutcome.ANOTHER_OPEN
            }
        }
        return outcome
    }
}
