package ai.jolli.jollimemory.actions

import ai.jolli.jollimemory.core.PlanEntry
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.services.JolliMemoryService
import ai.jolli.jollimemory.services.PlanService
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import java.time.Instant

/**
 * Adds a plan from ~/.claude/plans/ to the plans registry.
 * Shows a popup picker of available plans that aren't already registered.
 */
class AddPlanAction : AnAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = project.getService(JolliMemoryService::class.java)
        val cwd = service.mainRepoRoot ?: project.basePath ?: return

        // Load existing plan slugs to exclude them from the picker
        val registry = SessionTracker.loadPlansRegistry(cwd)
        val existingSlugs = registry.plans.keys

        val available = PlanService.listAvailablePlans(existingSlugs)
        if (available.isEmpty()) {
            com.intellij.openapi.ui.Messages.showInfoMessage(
                project,
                "No new plans found in ~/.claude/plans/.\nPlans are created by Claude Code during coding sessions.",
                "Add Plan",
            )
            return
        }

        // Show popup picker
        val step = object : BaseListPopupStep<PlanService.PlanInfo>("Select a plan to add", available) {
            override fun getTextFor(value: PlanService.PlanInfo): String = value.title

            override fun onChosen(selectedValue: PlanService.PlanInfo, finalChoice: Boolean): PopupStep<*>? {
                if (finalChoice) {
                    ApplicationManager.getApplication().executeOnPooledThread {
                        addPlanToRegistry(selectedValue, cwd, service)
                    }
                }
                return PopupStep.FINAL_CHOICE
            }
        }

        JBPopupFactory.getInstance().createListPopup(step).showInBestPositionFor(e.dataContext)
    }

    private fun addPlanToRegistry(plan: PlanService.PlanInfo, cwd: String, service: JolliMemoryService) {
        val registry = SessionTracker.loadPlansRegistry(cwd)
        val now = Instant.now().toString()
        val git = service.getGitOps()
        val branch = git?.getCurrentBranch() ?: "unknown"

        val entry = PlanEntry(
            slug = plan.slug,
            title = plan.title,
            sourcePath = plan.filePath,
            addedAt = now,
            updatedAt = now,
            branch = branch,
            commitHash = null,
            editCount = 0,
        )

        val updatedPlans = registry.plans.toMutableMap()
        updatedPlans[plan.slug] = entry

        SessionTracker.savePlansRegistry(
            registry.copy(plans = updatedPlans),
            cwd,
        )

        // Trigger UI refresh
        service.refreshStatus()
    }

    override fun update(e: AnActionEvent) {
        val status = e.project?.getService(JolliMemoryService::class.java)?.getStatus()
        e.presentation.isEnabled = status != null && status.enabled
    }
}
