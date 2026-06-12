package ai.jolli.jollimemory.sync

import ai.jolli.jollimemory.core.JmLogger
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * Pre-stage corrupt-JSON quarantine.
 *
 * Validates every dirty JSON file under `.jolli/` BEFORE staging. Files that fail
 * `JSON.parse` are moved to `<memoryBankRoot>/.jolli-quarantine-corrupt/`
 * so they never enter the orphan history.
 *
 * Port of `cli/src/sync/CorruptJsonQuarantine.ts`.
 */

private val log = JmLogger.create("CorruptJsonQuarantine")

const val QUARANTINE_CORRUPT_DIR = ".jolli-quarantine-corrupt"

data class CorruptJsonReport(
	val quarantined: Int,
	val paths: List<String>,
)

/**
 * Walks [dirtyPaths] (relative to [memoryBankRoot]), validates each
 * JSON files under `.jolli/` are parseable, and quarantines the ones that aren't.
 */
fun quarantineCorruptJson(
	memoryBankRoot: String,
	dirtyPaths: List<String>,
): CorruptJsonReport {
	val candidates = dirtyPaths.filter(::isValidatableJson)
	if (candidates.isEmpty()) return CorruptJsonReport(0, emptyList())

	val found = mutableListOf<String>()
	for (rel in candidates) {
		val abs = Path.of(memoryBankRoot, rel)
		try {
			if (!Files.isRegularFile(abs)) continue
		} catch (_: Exception) {
			continue // missing
		}
		val content: String
		try {
			content = Files.readString(abs)
		} catch (_: Exception) {
			continue
		}
		try {
			com.google.gson.JsonParser.parseString(content)
		} catch (_: Exception) {
			found.add(rel)
		}
	}

	if (found.isEmpty()) return CorruptJsonReport(0, emptyList())

	val quarantineDir = Path.of(memoryBankRoot, QUARANTINE_CORRUPT_DIR)
	val dirOk = ensureQuarantineDir(quarantineDir)
	if (!dirOk) {
		log.warn("Quarantine dir unusable — ${found.size} corrupt JSON file(s) left in place")
		return CorruptJsonReport(0, emptyList())
	}

	var quarantined = 0
	val moved = mutableListOf<String>()
	for (rel in found) {
		val src = Path.of(memoryBankRoot, rel)
		val safeName = rel.replace(Regex("[/\\\\]"), "-")
		val dst = quarantineDir.resolve(safeName)
		// Clean stale destination first.
		try { Files.deleteIfExists(dst) } catch (_: Exception) {}
		try {
			Files.move(src, dst, StandardCopyOption.REPLACE_EXISTING)
			quarantined++
			moved.add(rel)
			log.warn("Quarantined corrupt JSON: $rel → ${Path.of(memoryBankRoot).relativize(dst)}")
		} catch (e: Exception) {
			log.warn("Failed to quarantine corrupt JSON $rel (non-fatal): ${e.message}")
		}
	}
	return CorruptJsonReport(quarantined, moved)
}

/**
 * Returns true iff this relative path should be validated: ends in `.json`
 * AND is under the `.jolli/` subtree.
 */
internal fun isValidatableJson(rel: String): Boolean {
	if (!rel.endsWith(".json")) return false
	val segments = rel.split(Regex("[/\\\\]+"))
	return segments.contains(".jolli")
}

private fun ensureQuarantineDir(quarantineDir: Path): Boolean {
	try {
		if (Files.isSymbolicLink(quarantineDir)) {
			log.warn("Quarantine path $quarantineDir is a symlink — unlinking")
			try { Files.delete(quarantineDir) } catch (_: Exception) { return false }
		} else if (Files.isDirectory(quarantineDir)) {
			return true
		} else if (Files.exists(quarantineDir)) {
			log.warn("Quarantine path $quarantineDir exists but is not a directory — refusing")
			return false
		}
	} catch (_: Exception) {
		// stat failed — treat as missing
	}
	return try {
		Files.createDirectory(quarantineDir)
		true
	} catch (e: Exception) {
		log.warn("Failed to create quarantine dir $quarantineDir: ${e.message}")
		false
	}
}
