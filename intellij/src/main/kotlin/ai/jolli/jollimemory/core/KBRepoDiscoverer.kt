package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.JsonObject
import java.nio.file.Path

/** Discovery adapter for CLI `KBRepoDiscoverer.ts`. */
object KBRepoDiscoverer {
	private val gson = Gson()
	data class DiscoveredRepo(val kbRoot: Path, val repoName: String, val remoteUrl: String?, val isCurrentRepo: Boolean)
	private data class CliRepo(val kbRoot: String, val repoName: String, val remoteUrl: String?, val isCurrentRepo: Boolean)

	fun discover(currentRepoName: String?, currentRemoteUrl: String?, customParent: String? = null): List<DiscoveredRepo> {
		val request = JsonObject().apply {
			addProperty("operation", "discover")
			if (currentRepoName != null) addProperty("currentRepoName", currentRepoName)
			if (currentRemoteUrl != null) addProperty("currentRemoteUrl", currentRemoteUrl)
			if (customParent != null) addProperty("customParent", customParent)
		}
		val rows = CliIntegrations.runIdeBridge(CliIntegrations.resolveDefaultCwd(), "kb", gson.toJson(request))
			.asJsonObject.getAsJsonArray("repos") ?: return emptyList()
		return rows.map { gson.fromJson(it, CliRepo::class.java) }
			.map { DiscoveredRepo(Path.of(it.kbRoot), it.repoName, it.remoteUrl, it.isCurrentRepo) }
	}
}
