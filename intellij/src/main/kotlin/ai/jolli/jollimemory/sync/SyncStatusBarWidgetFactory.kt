package ai.jolli.jollimemory.sync

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory

/**
 * Factory that registers [SyncStatusBarWidget] with IntelliJ's status bar.
 *
 * Declared in `plugin.xml` as a `<statusBarWidgetFactory>` extension.
 */
class SyncStatusBarWidgetFactory : StatusBarWidgetFactory {

	override fun getId(): String = SyncStatusBarWidget.ID

	override fun getDisplayName(): String = "Jolli Memory Sync"

	override fun createWidget(project: Project): StatusBarWidget =
		SyncStatusBarWidget(project)

	override fun isAvailable(project: Project): Boolean = true
}
