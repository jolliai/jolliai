package ai.jolli.jollimemory.sync

import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest

/**
 * Path derivation for `vault-write.lock` — the per-vault writer lock.
 *
 * Port of `cli/src/sync/VaultLockPath.ts`.
 *
 * Lock location: `~/.jolli/jollimemory/locks/vault-<sha256(canonical)>.lock`.
 */

private val isWindows = System.getProperty("os.name").lowercase().contains("win")
private val isMac = System.getProperty("os.name").lowercase().contains("mac")
private val isCaseInsensitive = isWindows || isMac

/**
 * Canonicalises a local folder path into a stable identifier suitable for
 * hashing into the lock filename.
 *
 * Steps:
 *   1. Expand leading `~` to the user's home directory.
 *   2. Resolve to a lexical absolute path.
 *   3. Walk up to the nearest existing ancestor and realpath it, then
 *      re-append the non-existent tail segments.
 *   4. Case-fold on case-insensitive filesystems (Windows, macOS).
 *   5. Normalize separators to platform native, collapse duplicates,
 *      trim trailing separator.
 */
fun canonicaliseLocalFolder(s: String): String {
	require(s.isNotEmpty()) { "canonicaliseLocalFolder: empty input" }

	// Step 1 — tilde expansion.
	var p = s
	val home = System.getProperty("user.home")
	if (p == "~") {
		p = home
	} else if (p.startsWith("~/") || p.startsWith("~\\")) {
		p = home + p.substring(1)
	}

	// Step 2 — resolve to absolute.
	p = Path.of(p).toAbsolutePath().normalize().toString()

	// Step 3 — realpath nearest existing ancestor.
	p = resolvePartialRealpath(p)

	// Step 4 — case-fold on case-insensitive filesystems.
	if (isCaseInsensitive) {
		p = p.lowercase()
	}

	// Step 5 — collapse duplicate separators, trim trailing.
	p = p.replace(Regex("[/\\\\]+"), File.separator)
	if (p.length > 1 && p.endsWith(File.separator)) {
		p = p.dropLast(1)
	}

	return p
}

/**
 * Walks up [p] to the nearest existing ancestor, realpaths it (resolving
 * symlinks), and re-appends the non-existent tail segments.
 */
private fun resolvePartialRealpath(p: String): String {
	val tail = mutableListOf<String>()
	var cur = Path.of(p)
	while (true) {
		if (Files.exists(cur)) {
			val real = cur.toRealPath().toString()
			return if (tail.isEmpty()) real else {
				var result = real
				for (seg in tail) {
					result = result + File.separator + seg
				}
				result
			}
		}
		val parent = cur.parent ?: return p
		if (parent == cur) return p
		tail.add(0, cur.fileName.toString())
		cur = parent
	}
}

/**
 * Returns the absolute path to the vault-write lock file for the given
 * [vaultRoot]. Respects `JOLLI_VAULT_LOCK_DIR` env override.
 */
fun getVaultWriteLockPath(vaultRoot: String): Path {
	val override = System.getenv("JOLLI_VAULT_LOCK_DIR")
	val dir = if (!override.isNullOrEmpty()) {
		Path.of(override)
	} else {
		Path.of(System.getProperty("user.home"), ".jolli", "jollimemory", "locks")
	}
	val canonical = canonicaliseLocalFolder(vaultRoot)
	val hash = MessageDigest.getInstance("SHA-256")
		.digest(canonical.toByteArray())
		.joinToString("") { "%02x".format(it) }
	return dir.resolve("vault-$hash.lock")
}
