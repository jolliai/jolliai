package ai.jolli.jollimemory.core

import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.time.Instant

/**
 * BranchTagsStore — Persists branch tags for conversation sessions.
 *
 * Each session can be tagged to zero or more git branch names.
 * Stored as `<projectDir>/.jolli/jollimemory/branch-tags.json`.
 */
object BranchTagsStore {

	private val log = JmLogger.create("BranchTagsStore")
	private val gson = GsonBuilder().setPrettyPrinting().create()

	private const val TAGS_FILE = "branch-tags.json"
	private const val VERSION = 1

	private const val LOCK_WAIT_MS = 2000L
	private const val LOCK_STALE_MS = 10_000L
	private const val LOCK_POLL_MS = 25L

	// ── Key ─────────────────────────────────────────────────────────────────

	fun tagKey(source: String, sessionId: String): String = "$source:$sessionId"
	fun tagKey(source: TranscriptSource, sessionId: String): String = "${source.name}:$sessionId"

	// ── Load ────────────────────────────────────────────────────────────────

	fun loadRegistry(projectDir: String): BranchTagsRegistry {
		val file = File(JmLogger.getJolliMemoryDir(projectDir), TAGS_FILE)
		if (!file.exists()) return BranchTagsRegistry()
		return try {
			val raw = file.readText(Charsets.UTF_8)
			val obj = JsonParser.parseString(raw).asJsonObject
			val version = obj.get("version")?.asInt
			if (version != VERSION) {
				log.warn("loadRegistry version mismatch (got %s) — ignoring file", version)
				return BranchTagsRegistry()
			}
			gson.fromJson(raw, BranchTagsRegistry::class.java) ?: BranchTagsRegistry()
		} catch (e: Exception) {
			log.warn("loadRegistry failed: %s", e.message)
			BranchTagsRegistry()
		}
	}

	// ── Query ───────────────────────────────────────────────────────────────

	fun getTagsForSession(projectDir: String, source: TranscriptSource, sessionId: String): List<String> {
		val registry = loadRegistry(projectDir)
		return registry.entries[tagKey(source, sessionId)]?.branches ?: emptyList()
	}

	fun getSessionsForBranch(projectDir: String, branch: String): List<Pair<String, String>> {
		val registry = loadRegistry(projectDir)
		return registry.entries
			.filter { (_, tags) -> branch in tags.branches }
			.map { (_, tags) -> Pair(tags.source, tags.sessionId) }
	}

	// ── Write ───────────────────────────────────────────────────────────────

	fun setTagsForSession(
		projectDir: String,
		source: TranscriptSource,
		sessionId: String,
		branches: List<String>,
	): BranchTagsRegistry {
		val dir = File(JmLogger.getJolliMemoryDir(projectDir))
		dir.mkdirs()
		val finalFile = File(dir, TAGS_FILE)
		val lockFile = File("${finalFile.absolutePath}.lock")
		acquireLock(lockFile)
		try {
			val current = loadRegistry(projectDir)
			val key = tagKey(source, sessionId)
			val nextEntries = current.entries.toMutableMap()
			if (branches.isEmpty()) {
				nextEntries.remove(key)
			} else {
				nextEntries[key] = ConversationBranchTags(
					source = source.name,
					sessionId = sessionId,
					branches = branches,
					updatedAt = Instant.now().toString(),
				)
			}
			val next = BranchTagsRegistry(VERSION, nextEntries)
			val tmpFile = File("${finalFile.absolutePath}.tmp")
			tmpFile.writeText(gson.toJson(next), Charsets.UTF_8)
			Files.move(tmpFile.toPath(), finalFile.toPath(), StandardCopyOption.REPLACE_EXISTING)
			return next
		} finally {
			try { lockFile.delete() } catch (e: Exception) {
				log.debug("Lock release failed: %s", e.message)
			}
		}
	}

	// ── Locking ─────────────────────────────────────────────────────────────

	private fun acquireLock(lockFile: File) {
		val start = System.currentTimeMillis()
		while (true) {
			try {
				Files.write(
					lockFile.toPath(),
					ProcessHandle.current().pid().toString().toByteArray(),
					StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE,
				)
				return
			} catch (_: java.nio.file.FileAlreadyExistsException) {
				// Lock held by someone else
			}
			try {
				if (lockFile.exists() && System.currentTimeMillis() - lockFile.lastModified() > LOCK_STALE_MS) {
					lockFile.delete()
					continue
				}
			} catch (_: Exception) {
				continue
			}
			if (System.currentTimeMillis() - start > LOCK_WAIT_MS) {
				throw RuntimeException("BranchTagsStore: lock contention timeout (${LOCK_WAIT_MS}ms)")
			}
			Thread.sleep(LOCK_POLL_MS)
		}
	}
}
