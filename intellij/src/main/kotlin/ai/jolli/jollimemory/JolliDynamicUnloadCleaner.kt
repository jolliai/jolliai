package ai.jolli.jollimemory

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.telemetry.Telemetry
import ai.jolli.jollimemory.services.JolliAuthService
import com.intellij.ide.plugins.DynamicPluginListener
import com.intellij.ide.plugins.IdeaPluginDescriptor

/**
 * Releases the plugin's **app-level (`object`-held) background resources** right
 * before a dynamic unload, so they don't pin the plugin classloader.
 *
 * Project-scoped resources (the tool window, project service, panels, watchers,
 * Swing timers, message-bus connections) are released by their own Disposable
 * chains when the project service / tool-window content is disposed. The static
 * singletons below have no such owner — without this hook their executor threads
 * and listener lists keep the classloader alive after unload, which leaves
 * `FileBasedIndexTumbler` with the file index turned off and never turned back
 * on (the IDE then hangs in perpetual "indexing").
 */
class JolliDynamicUnloadCleaner : DynamicPluginListener {
	override fun beforePluginUnload(pluginDescriptor: IdeaPluginDescriptor, isUpdate: Boolean) {
		if (pluginDescriptor.pluginId.idString != PLUGIN_ID) return
		JolliAuthService.shutdownForUnload()
		Telemetry.shutdown()
		// Stop the log writer LAST so the lines above can still be recorded.
		JmLogger.shutdown()
	}

	private companion object {
		const val PLUGIN_ID = "ai.jolli.jollimemory"
	}
}
