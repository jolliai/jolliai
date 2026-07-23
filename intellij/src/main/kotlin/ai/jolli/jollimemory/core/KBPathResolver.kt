package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.JsonObject
import java.nio.file.Path

/** Path/identity adapter for CLI `KBPathResolver.ts`. */
object KBPathResolver {
	private val gson = Gson()
	val KB_PARENT: Path = Path.of(System.getProperty("user.home"), "Documents", "jolli")

	fun resolve(repoName: String, remoteUrl: String?, customPath: String? = null): Path =
		path(run(request("resolve").apply {
			addProperty("repoName", repoName)
			if (remoteUrl != null) addProperty("remoteUrl", remoteUrl)
			if (customPath != null) addProperty("customPath", customPath)
		}))

	fun initializeKBFolder(kbRoot: Path, repoName: String, remoteUrl: String?) {
		run(request("initialize").apply {
			addProperty("kbRoot", kbRoot.toString())
			addProperty("repoName", repoName)
			if (remoteUrl != null) addProperty("remoteUrl", remoteUrl)
		})
	}

	fun findRepoFolders(repoName: String, remoteUrl: String?, customPath: String? = null): List<Path> {
		val result = run(request("find-repo-folders").apply {
			addProperty("repoName", repoName)
			if (remoteUrl != null) addProperty("remoteUrl", remoteUrl)
			if (customPath != null) addProperty("customPath", customPath)
		}).asJsonObject.getAsJsonArray("paths") ?: return emptyList()
		return result.map { Path.of(it.asString) }
	}

	fun findFreshKBPath(repoName: String, customPath: String? = null): Path =
		path(run(request("find-fresh").apply {
			addProperty("repoName", repoName)
			if (customPath != null) addProperty("customPath", customPath)
		}))

	fun archiveKBFolder(kbRoot: Path, customPath: String? = null): Path? {
		val value = run(request("archive").apply {
			addProperty("kbRoot", kbRoot.toString())
			if (customPath != null) addProperty("customPath", customPath)
		}).asJsonObject.get("path") ?: return null
		return if (value.isJsonNull) null else Path.of(value.asString)
	}

	fun extractRepoName(projectPath: String): String = value("extract-repo-name", projectPath)

	fun getRemoteUrl(projectPath: String): String? {
		val result = run(request("get-remote-url").apply { addProperty("projectPath", projectPath) }).asJsonObject.get("value")
		return result?.takeUnless { it.isJsonNull }?.asString
	}

	private fun value(operation: String, projectPath: String): String =
		run(request(operation).apply { addProperty("projectPath", projectPath) }).asJsonObject.get("value").asString

	private fun path(result: com.google.gson.JsonElement): Path = Path.of(result.asJsonObject.get("path").asString)
	private fun request(operation: String): JsonObject = JsonObject().apply { addProperty("operation", operation) }
	private fun run(request: JsonObject) = CliIntegrations.runIdeBridge(CliIntegrations.resolveDefaultCwd(), "kb", gson.toJson(request))
}
