package ai.jolli.jollimemory.sync

import com.google.gson.Gson
import com.google.gson.JsonSyntaxException

/**
 * Vault-side `repoIdentity → folder` directory.
 *
 * Lives at `<memoryBankRoot>/.jolli/repos.json`. Merge logic for Tier 1.5
 * conflict resolution and cross-device folder allocation.
 *
 * Port of `cli/src/sync/RepoMapping.ts`.
 */

/** Vault-relative path to the mapping file. */
const val REPO_MAPPING_PATH = ".jolli/repos.json"

/** A single `repoIdentity → folder` mapping row. */
data class RepoMappingEntry(
	val repoIdentity: String,
	val folder: String,
)

/** Shape of `<memoryBankRoot>/.jolli/repos.json`. */
data class RepoMappingFile(
	val version: Int, // 1
	val mappings: List<RepoMappingEntry>,
)

/** Folder claimed by 2+ different `repoIdentity` values after merge. */
data class RepoMappingConflict(
	val folder: String,
	val identities: List<String>,
)

/** Parses an in-memory string into a [RepoMappingFile], or null on garbage. */
fun parseRepoMapping(raw: String): RepoMappingFile? {
	return try {
		val doc = Gson().fromJson(raw, RepoMappingFile::class.java) ?: return null
		if (doc.version != 1) return null
		if (doc.mappings == null) return null
		for (m in doc.mappings) {
			if (m.repoIdentity == null || m.folder == null) return null
		}
		doc
	} catch (_: JsonSyntaxException) {
		null
	}
}

/** Serializes to canonical 2-space-indented JSON + trailing newline. */
fun serializeRepoMapping(mapping: RepoMappingFile): String {
	val gson = com.google.gson.GsonBuilder().setPrettyPrinting().create()
	return "${gson.toJson(mapping)}\n"
}

/**
 * Tier 1.5 merge for `repos.json`. Dedupe by `repoIdentity` (union; ties
 * resolved last-write-wins favouring remote). Folder collisions across
 * different identities are detected but not renamed — both keep their
 * original claim, and the conflict is reported for UI surfacing.
 */
fun mergeRepoMapping(
	local: RepoMappingFile,
	remote: RepoMappingFile,
): MergeRepoMappingResult {
	// First pass: union by repoIdentity (remote overrides).
	val byIdentity = LinkedHashMap<String, RepoMappingEntry>()
	for (m in local.mappings) byIdentity[m.repoIdentity] = m
	for (m in remote.mappings) byIdentity[m.repoIdentity] = m

	// Second pass: detect folder collisions across different identities.
	val byFolder = mutableMapOf<String, MutableList<RepoMappingEntry>>()
	for (m in byIdentity.values) {
		byFolder.getOrPut(m.folder) { mutableListOf() }.add(m)
	}
	val conflicts = byFolder
		.filter { it.value.size > 1 }
		.map { (folder, entries) ->
			RepoMappingConflict(
				folder = folder,
				identities = entries.map { it.repoIdentity }.sorted(),
			)
		}

	// Stable output: sort by repoIdentity for byte-stable JSON across devices.
	val merged = byIdentity.values.sortedBy { it.repoIdentity }
	return MergeRepoMappingResult(
		merged = RepoMappingFile(version = 1, mappings = merged),
		conflicts = conflicts,
	)
}

data class MergeRepoMappingResult(
	val merged: RepoMappingFile,
	val conflicts: List<RepoMappingConflict>,
)

/** Reads `<memoryBankRoot>/.jolli/repos.json`, returning an empty mapping on failure. */
fun loadRepoMapping(memoryBankRoot: String): RepoMappingFile {
	val path = java.nio.file.Path.of(memoryBankRoot, REPO_MAPPING_PATH)
	val raw = try {
		java.nio.file.Files.readString(path)
	} catch (_: Exception) {
		return emptyMapping()
	}
	return parseRepoMapping(raw) ?: emptyMapping()
}

/** Writes `<memoryBankRoot>/.jolli/repos.json`. Creates parent dir if needed. */
fun saveRepoMapping(memoryBankRoot: String, mapping: RepoMappingFile) {
	val path = java.nio.file.Path.of(memoryBankRoot, REPO_MAPPING_PATH)
	java.nio.file.Files.createDirectories(path.parent)
	java.nio.file.Files.writeString(path, serializeRepoMapping(mapping))
}

/** Scans for folder collisions (2+ identities claiming the same folder). */
fun findRepoMappingConflicts(mapping: RepoMappingFile): List<RepoMappingConflict> {
	val byFolder = mutableMapOf<String, MutableList<RepoMappingEntry>>()
	for (m in mapping.mappings) {
		byFolder.getOrPut(m.folder) { mutableListOf() }.add(m)
	}
	return byFolder
		.filter { it.value.size > 1 }
		.map { (folder, entries) ->
			RepoMappingConflict(folder, entries.map { it.repoIdentity }.sorted())
		}
}

/**
 * Looks up or assigns the vault folder for the given repo identity.
 * Returns the effective folder and an updated mapping (if changed), or null mapping if no change.
 */
fun resolveOrAssignFolder(
	mapping: RepoMappingFile,
	repoIdentity: String,
	authoritativeFolder: String,
): ResolveOrAssignResult {
	val existing = mapping.mappings.find { it.repoIdentity == repoIdentity }
	if (existing != null) {
		if (existing.folder == authoritativeFolder) {
			return ResolveOrAssignResult(existing.folder, null)
		}
		val updated = RepoMappingFile(
			version = 1,
			mappings = mapping.mappings.map {
				if (it.repoIdentity == repoIdentity) it.copy(folder = authoritativeFolder) else it
			},
		)
		return ResolveOrAssignResult(authoritativeFolder, updated)
	}
	val updated = RepoMappingFile(
		version = 1,
		mappings = mapping.mappings + RepoMappingEntry(repoIdentity, authoritativeFolder),
	)
	return ResolveOrAssignResult(authoritativeFolder, updated)
}

data class ResolveOrAssignResult(
	val folder: String,
	val updatedMapping: RepoMappingFile?,
)

private fun emptyMapping() = RepoMappingFile(version = 1, mappings = emptyList())
