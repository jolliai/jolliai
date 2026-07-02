package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.JmLogger
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * BranchShareStore — local persistence for branch share records.
 *
 * Stores share metadata (shareId, shareUrl, headCommitHash, etc.) in
 * `<projectDir>/.jolli/jollimemory/branch-shares.json` so the plugin
 * can detect stale shares and avoid redundant POST requests.
 */
object BranchShareStore {

	private val log = JmLogger.create("BranchShareStore")
	private val gson: Gson = GsonBuilder().setPrettyPrinting().create()
	private const val SHARES_FILE = "branch-shares.json"

	data class BranchShareRecord(
		val shareId: String? = null,
		val shareUrl: String? = null,
		val token8: String? = null,
		val headCommitHash: String? = null,
		val expiresAt: String? = null,
		val decisionCount: Int? = null,
		val confirmedPublic: Boolean = false,
	)

	data class BranchShareRegistry(
		val version: Int = 2,
		val branches: MutableMap<String, BranchShareRecord> = mutableMapOf(),
	)

	fun branchKey(branch: String): String = branch

	fun load(cwd: String): BranchShareRegistry {
		val file = File(JmLogger.getJolliMemoryDir(cwd), SHARES_FILE)
		if (!file.exists()) return BranchShareRegistry()
		return try {
			val text = file.readText(Charsets.UTF_8)
			gson.fromJson(text, BranchShareRegistry::class.java) ?: BranchShareRegistry()
		} catch (e: Exception) {
			log.warn("Failed to load branch-shares.json: ${e.message}")
			BranchShareRegistry()
		}
	}

	fun save(cwd: String, registry: BranchShareRegistry) {
		val dir = File(JmLogger.getJolliMemoryDir(cwd))
		dir.mkdirs()
		val file = File(dir, SHARES_FILE)
		val tmp = File(dir, "$SHARES_FILE.tmp")
		try {
			tmp.writeText(gson.toJson(registry), Charsets.UTF_8)
			Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
		} catch (e: Exception) {
			log.warn("Failed to save branch-shares.json: ${e.message}")
			tmp.delete()
		}
	}

	fun get(cwd: String, key: String): BranchShareRecord? {
		return load(cwd).branches[key]
	}

	fun put(cwd: String, key: String, record: BranchShareRecord) {
		val registry = load(cwd)
		val existing = registry.branches[key]
		val merged = if (existing != null && !record.confirmedPublic && existing.confirmedPublic) {
			record.copy(confirmedPublic = true)
		} else {
			record
		}
		registry.branches[key] = merged
		save(cwd, registry)
	}

	fun remove(cwd: String, key: String) {
		val registry = load(cwd)
		val existing = registry.branches[key] ?: return
		if (existing.confirmedPublic) {
			registry.branches[key] = BranchShareRecord(confirmedPublic = true)
		} else {
			registry.branches.remove(key)
		}
		save(cwd, registry)
	}

	fun isPublicConfirmed(cwd: String, branch: String): Boolean {
		return load(cwd).branches[branchKey(branch)]?.confirmedPublic == true
	}

	fun markPublicConfirmed(cwd: String, branch: String) {
		val registry = load(cwd)
		val key = branchKey(branch)
		val existing = registry.branches[key]
		if (existing != null) {
			registry.branches[key] = existing.copy(confirmedPublic = true)
		} else {
			registry.branches[key] = BranchShareRecord(confirmedPublic = true)
		}
		save(cwd, registry)
	}
}
