package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.CliIntegrations
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import java.io.File

/** Thin JVM adapter for CLI-owned config, plans, lock and pending-operation state. */
object SessionTracker {
	private val gson: Gson = GsonBuilder().serializeNulls().create()

	/** Bootstrap path used by NodeRuntime itself; cannot depend on spawning the CLI. */
	fun getGlobalConfigDir(): String =
		File(System.getProperty("user.home"), ".jolli/jollimemory").absolutePath

	fun loadConfig(cwd: String? = null): JolliMemoryConfig =
		loadConfigFromBridge(cwd ?: CliIntegrations.resolveDefaultCwd(), null)

	fun loadConfigFromDir(dir: String): JolliMemoryConfig =
		loadConfigFromBridge(CliIntegrations.resolveDefaultCwd(), dir)

	fun saveConfigToDir(config: JolliMemoryConfig, dir: String) {
		val request = request("config-save").apply {
			addProperty("dir", dir)
			add("config", gson.toJsonTree(config))
		}
		run(CliIntegrations.resolveDefaultCwd(), request)
	}

	fun saveGlobalInstructions(value: String?) {
		val dir = getGlobalConfigDir()
		saveConfigToDir(loadConfigFromDir(dir).copy(globalInstructions = value), dir)
	}

	fun saveDcoSignoff(value: Boolean?) {
		val dir = getGlobalConfigDir()
		saveConfigToDir(loadConfigFromDir(dir).copy(dcoSignoff = value), dir)
	}

	fun saveSharedProviderConfig(
		aiProvider: String?,
		apiKey: String?,
		localAgentTool: String?,
		localAgentPath: String? = null,
	) {
		val dir = getGlobalConfigDir()
		val current = loadConfigFromDir(dir)
		saveConfigToDir(
			current.copy(
				aiProvider = aiProvider,
				apiKey = apiKey,
				localAgentTool = localAgentTool,
				localAgentPath = localAgentPath ?: current.localAgentPath,
			),
			dir,
		)
	}

	/**
	 * Host-side freshness check on `worker.lock` (mtime within 5 min). Never spawns
	 * a Node subprocess: routing this through `jolli ide-bridge` would cold-start
	 * Node on every NIO watcher event and click-time re-check.
	 *
	 * The 5-minute window must stay in lockstep with `LOCK_TIMEOUT_MS` in
	 * `cli/src/core/LockPrimitives.ts` and the equivalent VS Code helper. If that
	 * constant changes, update all three.
	 */
	fun isWorkerBusy(cwd: String? = null): Boolean {
		val dir = cwd ?: CliIntegrations.resolveDefaultCwd()
		val lock = File(dir, ".jolli/jollimemory/worker.lock")
		val mtime = lock.lastModified()
		if (mtime == 0L) return false
		return System.currentTimeMillis() - mtime < WORKER_LOCK_TIMEOUT_MS
	}

	/** Freshness window for `worker.lock`. Mirrors LOCK_TIMEOUT_MS in the CLI. */
	private const val WORKER_LOCK_TIMEOUT_MS: Long = 5 * 60 * 1000

	fun savePluginSource(cwd: String? = null) {
		run(cwd ?: CliIntegrations.resolveDefaultCwd(), request("save-plugin-source"))
	}

	fun saveSquashPending(sourceHashes: List<String>, expectedParentHash: String, cwd: String? = null) {
		val request = request("save-squash-pending").apply {
			add("sourceHashes", gson.toJsonTree(sourceHashes))
			addProperty("expectedParentHash", expectedParentHash)
		}
		run(cwd ?: CliIntegrations.resolveDefaultCwd(), request)
	}

	fun loadPlansRegistry(cwd: String? = null): PlansRegistry {
		val result = run(cwd ?: CliIntegrations.resolveDefaultCwd(), request("plans-load"))
		return gson.fromJson(result, PlansRegistry::class.java)
	}

	fun savePlansRegistry(registry: PlansRegistry, cwd: String? = null) {
		val request = request("plans-save").apply { add("registry", gson.toJsonTree(registry)) }
		run(cwd ?: CliIntegrations.resolveDefaultCwd(), request)
	}

	fun getNotesDir(cwd: String? = null): String =
		run(cwd ?: CliIntegrations.resolveDefaultCwd(), request("notes-dir"))
			.asJsonObject.get("path").asString

	/**
	 * Acquires `plans.lock` in the CLI daemon on our behalf. The daemon writes
	 * its own PID into the lock file and holds it until [releaseLock] fires (or
	 * the file goes stale), so this call serializes IntelliJ's load-mutate-save
	 * on `plans.json` with the CLI's own writers (QueueWorker / StopHook /
	 * Codex tick), all of which wrap their RMW in `withPlansLock`.
	 *
	 * Callers must treat a false return as "no lock held" and either skip or
	 * write without exclusion — never assume success. Any bridge failure counts
	 * as "not acquired". The bridge uses [DEFAULT_PLANS_LOCK_TIMEOUT_MS] (5 s)
	 * as the poll budget by default.
	 */
	fun acquireLock(cwd: String): Boolean = try {
		val response = run(cwd, request("acquire-lock"))
		response.asJsonObject?.get("acquired")?.asBoolean == true
	} catch (_: Exception) {
		false
	}

	/**
	 * Releases the `plans.lock` previously acquired by [acquireLock]. The CLI
	 * daemon PID-checks the file before deleting — a release from a caller that
	 * never acquired (or whose acquire returned false) is a safe no-op on the
	 * daemon side — but callers should still gate the call on the paired
	 * acquireLock result for clarity. Best-effort: bridge failures are swallowed
	 * so a partial release does not mask the original write result; the CLI's
	 * own staleness timeout reclaims a leaked lock in [WORKER_LOCK_TIMEOUT_MS].
	 */
	fun releaseLock(cwd: String) {
		try {
			run(cwd, request("release-lock"))
		} catch (_: Exception) {
			// Best-effort: the CLI's own timeout logic will reclaim the lock.
		}
	}

	private fun loadConfigFromBridge(cwd: String, dir: String?): JolliMemoryConfig {
		val request = request("config-load").apply { if (dir != null) addProperty("dir", dir) }
		return gson.fromJson(run(cwd, request), JolliMemoryConfig::class.java)
	}

	private fun request(operation: String): JsonObject = JsonObject().apply { addProperty("operation", operation) }

	private fun run(cwd: String, request: JsonObject): com.google.gson.JsonElement =
		CliIntegrations.runIdeBridge(cwd, "session-state", gson.toJson(request))
}
