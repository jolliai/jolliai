package ai.jolli.jollimemory.sync

import com.google.gson.Gson
import com.google.gson.JsonObject
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/**
 * Vault identity marker — proves that `<memoryBankRoot>/.git/` belongs to the
 * Jolli sync engine and points at the expected personal-space repo.
 *
 * Port of `cli/src/sync/VaultMarker.ts`.
 */

/** Path of the marker relative to `<memoryBankRoot>`. Inside `.git/` on purpose. */
val VAULT_MARKER_REL_PATH: String = ".git${File.separator}jolli-vault-identity.json"

data class VaultMarkerData(
	val kind: String,
	val version: Int,
	val createdAt: String,
	val gitUrl: String,
	val repoFullName: String,
	val defaultBranch: String,
)

sealed class VaultVerdict {
	data class Ok(val needsRewrite: Boolean = false) : VaultVerdict()
	data class Failed(val reason: String, val message: String) : VaultVerdict()
}

/**
 * Hosts whose owner/repo path is case-insensitive (GitHub, GitLab, Bitbucket).
 */
private val CASE_INSENSITIVE_PATH_HOSTS = setOf("github.com", "gitlab.com", "bitbucket.org")

private val GIT_URL_REGEX = Regex("^(https://)(?:[^@/]+@)?([^/]+)(/.+?)/?$", RegexOption.IGNORE_CASE)

/**
 * Normalizes a git URL for safe comparison. Strips auth, trailing `.git`,
 * trailing slash. Lowercases host always; lowercases path only for
 * case-insensitive forges.
 */
fun normalizeGitUrl(url: String): String {
	val trimmed = url.trim()
	val match = GIT_URL_REGEX.find(trimmed) ?: return trimmed
	val scheme = match.groupValues[1].lowercase()
	val host = match.groupValues[2].lowercase()
	var path = match.groupValues[3]
	if (path.lowercase().endsWith(".git")) {
		path = path.dropLast(4)
	}
	if (host in CASE_INSENSITIVE_PATH_HOSTS) {
		path = path.lowercase()
	}
	return "$scheme$host$path"
}

private val gson = Gson()

/**
 * Writes (or rewrites) the marker for [memoryBankRoot]. Idempotent.
 */
fun writeVaultMarker(memoryBankRoot: String, creds: GitCredentials) {
	val path = Path.of(memoryBankRoot, VAULT_MARKER_REL_PATH)
	Files.createDirectories(path.parent)
	val marker = JsonObject().apply {
		addProperty("kind", "jolli-memory-bank")
		addProperty("version", 1)
		addProperty("createdAt", Instant.now().toString())
		addProperty("gitUrl", normalizeGitUrl(creds.gitUrl))
		addProperty("repoFullName", creds.repoFullName)
		addProperty("defaultBranch", creds.defaultBranch)
	}
	Files.writeString(path, gson.toJson(marker) + "\n")
}

/**
 * Reads the marker if present and well-formed. Returns null for any error.
 */
fun readVaultMarker(memoryBankRoot: String): VaultMarkerData? {
	return try {
		val raw = Files.readString(Path.of(memoryBankRoot, VAULT_MARKER_REL_PATH))
		val parsed = gson.fromJson(raw, JsonObject::class.java) ?: return null
		val kind = parsed.get("kind")?.asString ?: return null
		val version = parsed.get("version")?.asInt ?: return null
		if (kind != "jolli-memory-bank" || version != 1) return null
		val gitUrl = parsed.get("gitUrl")?.asString
		if (gitUrl.isNullOrEmpty()) return null
		VaultMarkerData(
			kind = kind,
			version = version,
			createdAt = parsed.get("createdAt")?.asString ?: "",
			gitUrl = gitUrl,
			repoFullName = parsed.get("repoFullName")?.asString ?: "",
			defaultBranch = parsed.get("defaultBranch")?.asString ?: "",
		)
	} catch (_: Exception) {
		null
	}
}

/**
 * Verifies that [memoryBankRoot] carries a marker that matches the freshly-
 * minted credentials. Both marker URL and live origin URL must match.
 */
fun verifyVaultMarker(memoryBankRoot: String, originUrl: String?, creds: GitCredentials): VaultVerdict {
	val marker = readVaultMarker(memoryBankRoot) ?: return VaultVerdict.Failed(
		reason = "missing_marker",
		message = "$memoryBankRoot already contains a .git directory but no Jolli vault marker. Refusing to write — pick a different Memory Bank folder.",
	)

	val expected = normalizeGitUrl(creds.gitUrl)
	val storedNormalized = normalizeGitUrl(marker.gitUrl)
	if (storedNormalized != expected) {
		return VaultVerdict.Failed(
			reason = "url_mismatch",
			message = "Vault marker remembers ${marker.gitUrl} but credentials point at $expected. Refusing to write.",
		)
	}

	val needsRewrite = storedNormalized != marker.gitUrl

	if (originUrl == null) {
		return VaultVerdict.Failed(
			reason = "url_mismatch",
			message = "Vault at $memoryBankRoot has no origin remote configured. Refusing to write.",
		)
	}

	val actual = normalizeGitUrl(originUrl)
	if (actual != expected) {
		return VaultVerdict.Failed(
			reason = "url_mismatch",
			message = "Vault origin remote is $actual but credentials point at $expected. Refusing to write.",
		)
	}

	return if (needsRewrite) VaultVerdict.Ok(needsRewrite = true) else VaultVerdict.Ok()
}
