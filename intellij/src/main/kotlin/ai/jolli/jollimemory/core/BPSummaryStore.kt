package ai.jolli.jollimemory.core

import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.time.Instant

/**
 * BPSummaryStore — Persists bullet point summaries for conversation sessions.
 *
 * Each session accumulates bullet points over time as commits are made.
 * Stored as `<projectDir>/.jolli/jollimemory/bp-summaries.json`.
 */
object BPSummaryStore {

	private val log = JmLogger.create("BPSummaryStore")
	private val gson = GsonBuilder().setPrettyPrinting().create()

	private const val BP_FILE = "bp-summaries.json"
	private const val VERSION = 1

	private const val LOCK_WAIT_MS = 2000L
	private const val LOCK_STALE_MS = 10_000L
	private const val LOCK_POLL_MS = 25L

	// ── Key ─────────────────────────────────────────────────────────────────

	fun bpKey(source: String, sessionId: String): String = "$source:$sessionId"

	// ── Load ────────────────────────────────────────────────────────────────

	fun loadRegistry(projectDir: String): BPSummaryRegistry {
		val file = File(JmLogger.getJolliMemoryDir(projectDir), BP_FILE)
		if (!file.exists()) return BPSummaryRegistry()
		return try {
			val raw = file.readText(Charsets.UTF_8)
			val obj = JsonParser.parseString(raw).asJsonObject
			val version = obj.get("version")?.asInt
			if (version != VERSION) {
				log.warn("loadRegistry version mismatch (got %s) — ignoring file", version)
				return BPSummaryRegistry()
			}
			gson.fromJson(raw, BPSummaryRegistry::class.java) ?: BPSummaryRegistry()
		} catch (e: Exception) {
			log.warn("loadRegistry failed: %s", e.message)
			BPSummaryRegistry()
		}
	}

	// ── Query ───────────────────────────────────────────────────────────────

	fun getSummary(projectDir: String, source: String, sessionId: String): List<BulletPointItem> {
		val registry = loadRegistry(projectDir)
		return registry.entries[bpKey(source, sessionId)]?.bullets ?: emptyList()
	}

	// ── Write ───────────────────────────────────────────────────────────────

	fun appendBullets(
		projectDir: String,
		source: String,
		sessionId: String,
		newBullets: List<BulletPointItem>,
	): BPSummaryRegistry {
		if (newBullets.isEmpty()) return loadRegistry(projectDir)

		val dir = File(JmLogger.getJolliMemoryDir(projectDir))
		dir.mkdirs()
		val finalFile = File(dir, BP_FILE)
		val lockFile = File("${finalFile.absolutePath}.lock")
		acquireLock(lockFile)
		try {
			val current = loadRegistry(projectDir)
			val key = bpKey(source, sessionId)
			val existing = current.entries[key]
			val existingBullets = existing?.bullets ?: emptyList()

			// Dedupe by text (case-sensitive)
			val existingTexts = existingBullets.map { it.text }.toSet()
			val deduped = newBullets.filter { it.text !in existingTexts }
			if (deduped.isEmpty()) {
				return current
			}

			val merged = existingBullets + deduped
			val nextEntries = current.entries.toMutableMap()
			nextEntries[key] = ConversationBPSummary(
				source = source,
				sessionId = sessionId,
				bullets = merged,
				updatedAt = Instant.now().toString(),
			)
			val next = BPSummaryRegistry(VERSION, nextEntries)
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
				throw RuntimeException("BPSummaryStore: lock contention timeout (${LOCK_WAIT_MS}ms)")
			}
			Thread.sleep(LOCK_POLL_MS)
		}
	}
}
