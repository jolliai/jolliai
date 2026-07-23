package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.JsonObject
import java.nio.file.Path

/** DTO/process adapter for CLI `MetadataManager.ts`. */
class MetadataManager(private val jolliDir: Path) {
	private val gson = Gson()

	fun ensure() { run(request("metadata-ensure")) }
	fun readManifest(): Manifest = gson.fromJson(run(request("metadata-read-manifest")), Manifest::class.java)
	fun readIndex(): SummaryIndex? = run(request("metadata-read-index")).takeUnless { it.isJsonNull }
		?.let { gson.fromJson(it, SummaryIndex::class.java) }
	fun readConfig(): KBConfig = gson.fromJson(run(request("metadata-read-config")), KBConfig::class.java)

	fun findByPath(path: String): ManifestEntry? {
		val value = run(request("metadata-find-by-path").apply { addProperty("path", path) }).asJsonObject.get("entry")
		return value?.takeUnless { it.isJsonNull }?.let { gson.fromJson(it, ManifestEntry::class.java) }
	}

	fun updatePath(fileId: String, newPath: String): Boolean =
		run(request("metadata-update-path").apply {
			addProperty("fileId", fileId)
			addProperty("newPath", newPath)
		}).asJsonObject.get("changed")?.asBoolean == true

	fun renameBranchFolder(oldFolder: String, newFolder: String): Int =
		run(request("metadata-rename-branch-folder").apply {
			addProperty("oldFolder", oldFolder)
			addProperty("newFolder", newFolder)
		}).asJsonObject.get("count")?.asInt ?: 0

	fun removeBranchFolder(folder: String): Int =
		run(request("metadata-remove-branch-folder").apply { addProperty("folder", folder) })
			.asJsonObject.get("count")?.asInt ?: 0

	fun removeFromManifest(fileId: String): Boolean =
		run(request("metadata-remove-manifest").apply { addProperty("fileId", fileId) })
			.asJsonObject.get("changed")?.asBoolean == true

	fun reconcile(kbRoot: Path): Int =
		run(request("metadata-reconcile").apply { addProperty("kbRoot", kbRoot.toString()) })
			.asJsonObject.get("count")?.asInt ?: 0

	fun saveMigrationState(state: MigrationState) {
		run(request("metadata-save-migration").apply { add("state", gson.toJsonTree(state)) })
	}

	private fun request(operation: String): JsonObject = JsonObject().apply {
		addProperty("operation", operation)
		addProperty("jolliDir", jolliDir.toString())
	}

	/**
	 * The daemon lookup in [CliIntegrations.findDaemonForCwd] matches against an
	 * open project's basePath / mainRepoRoot — never against a Memory Bank
	 * folder. Passing `jolliDir.parent` (a KB folder outside any project)
	 * skipped the fast path on every metadata call. The actual `jolliDir` still
	 * travels in the request body, so the daemon knows which KB to touch.
	 */
	private fun run(request: JsonObject) =
		CliIntegrations.runIdeBridge(CliIntegrations.resolveDefaultCwd(), "kb", gson.toJson(request))
}
