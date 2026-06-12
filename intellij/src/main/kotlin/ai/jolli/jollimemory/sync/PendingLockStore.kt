package ai.jolli.jollimemory.sync

import com.google.gson.Gson
import com.google.gson.JsonObject
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Persists the most recent `lockOwnerToken` returned by
 * `POST /api/mb-sync/credentials` so the engine can decide, on a later
 * 423 vault_locked, whether the lock is self-held vs peer-held.
 *
 * Port of `cli/src/sync/PendingLockStore.ts`.
 *
 * File location: `~/.jolli/jollimemory/pending-lock.json`
 */

data class ReadPendingLockResult(
	val lockOwnerToken: String,
	val mintedAt: Long,
)

object PendingLockStore {

	private const val STATE_VERSION = 1
	private const val KEY_HASH_SALT = "jolli:pending-lock:key-hash:v1"
	private const val KEY_HASH_ITERATIONS = 210_000
	private const val KEY_HASH_BYTES = 32

	private val gson = Gson()

	/** Per-process memoization of PBKDF2 hash. */
	private var cachedKey: String? = null
	private var cachedHash: String? = null

	private fun getPath(): Path {
		return Path.of(System.getProperty("user.home"), ".jolli", "jollimemory", "pending-lock.json")
	}

	private fun hashKey(jolliApiKey: String): String {
		if (jolliApiKey == cachedKey && cachedHash != null) return cachedHash!!
		val spec = PBEKeySpec(
			jolliApiKey.toCharArray(),
			KEY_HASH_SALT.toByteArray(),
			KEY_HASH_ITERATIONS,
			KEY_HASH_BYTES * 8,
		)
		val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
		val digest = factory.generateSecret(spec).encoded
		val hex = digest.joinToString("") { "%02x".format(it) }.take(32)
		cachedKey = jolliApiKey
		cachedHash = hex
		return hex
	}

	/**
	 * Returns the persisted entry iff it matches the supplied [jolliApiKey].
	 * Returns null for missing, corrupt, version mismatch, or wrong key.
	 */
	fun read(jolliApiKey: String): ReadPendingLockResult? {
		val path = getPath()
		val raw = try {
			Files.readString(path)
		} catch (_: Exception) {
			return null
		}

		val parsed = try {
			gson.fromJson(raw, JsonObject::class.java) ?: return null
		} catch (_: Exception) {
			return null
		}

		if (!parsed.has("version") || parsed.get("version").asInt != STATE_VERSION) return null
		val keyHash = parsed.get("keyHash")?.asString ?: return null
		val lockOwnerToken = parsed.get("lockOwnerToken")?.asString ?: return null
		val mintedAt = parsed.get("mintedAt")?.asLong ?: return null

		if (keyHash != hashKey(jolliApiKey)) return null
		return ReadPendingLockResult(lockOwnerToken = lockOwnerToken, mintedAt = mintedAt)
	}

	/**
	 * Atomic write (tmp+rename) of the pending lock entry.
	 */
	fun write(jolliApiKey: String, lockOwnerToken: String, mintedAtMs: Long = System.currentTimeMillis()) {
		val path = getPath()
		Files.createDirectories(path.parent)

		val entry = JsonObject().apply {
			addProperty("version", STATE_VERSION)
			addProperty("keyHash", hashKey(jolliApiKey))
			addProperty("lockOwnerToken", lockOwnerToken)
			addProperty("mintedAt", mintedAtMs)
		}

		val tmp = path.resolveSibling("${path.fileName}.${ProcessHandle.current().pid()}.tmp")
		Files.writeString(tmp, gson.toJson(entry))
		Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING)
	}

	/** Removes the persisted entry. No-op when already absent. */
	fun clear() {
		try {
			Files.deleteIfExists(getPath())
		} catch (_: Exception) {
			// Best-effort.
		}
	}
}
