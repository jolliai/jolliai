package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import ai.jolli.jollimemory.bridge.GitOps
import com.google.gson.Gson
import com.google.gson.JsonObject

/**
 * Creates the thin JVM adapter for the CLI-owned storage provider stack.
 *
 * The [git] parameter is retained for source compatibility with existing IDE
 * composition code; the CLI-backed provider resolves storage entirely from
 * [projectPath], so the [GitOps] value itself is never dereferenced here.
 */
object StorageFactory {

	fun create(
		@Suppress("UNUSED_PARAMETER") git: GitOps,
		projectPath: String,
	): StorageProvider = CliStorageProvider(projectPath)
}

private class CliStorageProvider(private val projectPath: String) : StorageProvider {

	private val gson = Gson()

	override fun readFile(path: String): String? =
		run("read", "path" to path).asJsonObject.get("content")?.takeUnless { it.isJsonNull }?.asString

	override fun writeFiles(files: List<FileWrite>, message: String) {
		val request = JsonObject().apply {
			addProperty("operation", "write")
			add("files", gson.toJsonTree(files))
			addProperty("message", message)
		}
		CliIntegrations.runIdeBridge(projectPath, "storage", gson.toJson(request))
	}

	override fun listFiles(prefix: String): List<String> {
		val paths = run("list", "prefix" to prefix).asJsonObject.getAsJsonArray("paths") ?: return emptyList()
		return paths.map { it.asString }
	}

	override fun exists(): Boolean = run("exists").asJsonObject.get("exists")?.asBoolean == true

	override fun ensure() {
		run("ensure")
	}

	private fun run(operation: String, vararg fields: Pair<String, String>): com.google.gson.JsonElement {
		val request = JsonObject().apply {
			addProperty("operation", operation)
			for ((key, value) in fields) addProperty(key, value)
		}
		return CliIntegrations.runIdeBridge(projectPath, "storage", gson.toJson(request))
	}
}
