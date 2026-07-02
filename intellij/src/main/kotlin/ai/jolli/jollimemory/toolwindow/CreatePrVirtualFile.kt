package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.toolwindow.views.CreatePrData
import com.intellij.testFramework.LightVirtualFile

/**
 * Lightweight virtual file carrying a [CreatePrData.ViewModel]. Opens the dedicated
 * Create-PR webview as an editor tab. Identity is the branch, so re-triggering
 * "Create PR" on the same branch reuses the existing tab instead of stacking tabs.
 */
class CreatePrVirtualFile(
    val vm: CreatePrData.ViewModel,
) : LightVirtualFile("✨ Create PR — ${vm.branch}", "") {

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is CreatePrVirtualFile) return false
        return vm.branch == other.vm.branch
    }

    override fun hashCode(): Int = vm.branch.hashCode()

    override fun isWritable(): Boolean = false
}
