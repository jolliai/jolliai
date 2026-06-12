package ai.jolli.jollimemory.sync

/**
 * Deterministic client-side merge for the four `.jolli/<aggregate>.json`
 * files (JOLLI-1316 §3). Pure functions — order-independent, no I/O, no
 * randomness — so the same `(local, remote)` pair on two devices produces
 * byte-identical output regardless of which side ran first.
 *
 * Port of `cli/src/sync/AggregateMerge.ts`.
 *
 * Sorting uses [String.compareTo] (UTF-16 code-unit ordering, NOT
 * locale-dependent collation) so cross-device output is stable.
 */

/**
 * Manifest merge — dedupe by `fileId`, keep the row with the newer
 * `source.generatedAt`. Ties on `generatedAt` keep the first occurrence
 * (i.e. `local` before `remote`).
 */
fun mergeManifest(
	local: List<ManifestEntry>,
	remote: List<ManifestEntry>,
): List<ManifestEntry> {
	val byId = LinkedHashMap<String, ManifestEntry>()
	for (entry in local) byId[entry.fileId] = entry
	for (entry in remote) {
		val existing = byId[entry.fileId]
		if (existing == null) {
			byId[entry.fileId] = entry
			continue
		}
		// Strict `>` keeps the earlier-inserted (local) entry on a tie.
		if (entry.source.generatedAt > existing.source.generatedAt) {
			byId[entry.fileId] = entry
		}
	}
	return byId.values.sortedBy { it.fileId }
}

/**
 * Index merge — dedupe by `commitHash`, with the 2×2 tiebreak:
 *
 * | local.parent | remote.parent | winner |
 * |---|---|---|
 * | set    | set    | newer `generatedAt` (strict `>`, ties keep local) |
 * | null   | null   | newer `generatedAt` |
 * | set    | null   | local |
 * | null   | set    | remote |
 *
 * A non-null `parentCommitHash` outranks a null-parent row.
 */
fun mergeIndex(
	local: List<IndexEntry>,
	remote: List<IndexEntry>,
): List<IndexEntry> {
	val byHash = LinkedHashMap<String, IndexEntry>()
	for (entry in local) byHash[entry.commitHash] = entry
	for (entry in remote) {
		val existing = byHash[entry.commitHash]
		if (existing == null) {
			byHash[entry.commitHash] = entry
			continue
		}
		val existingHasParent = existing.parentCommitHash != null
		val incomingHasParent = entry.parentCommitHash != null
		if (existingHasParent == incomingHasParent) {
			if (entry.generatedAt > existing.generatedAt) {
				byHash[entry.commitHash] = entry
			}
		} else if (incomingHasParent) {
			byHash[entry.commitHash] = entry
		}
		// else: existing has parent, incoming is null → keep existing.
	}
	return byHash.values.sortedBy { it.commitHash }
}

/**
 * Branches merge — dedupe by `branch`. Last-write-wins: `remote` overrides
 * `local` for any shared key.
 */
fun mergeBranches(
	local: List<BranchEntry>,
	remote: List<BranchEntry>,
): List<BranchEntry> {
	val byBranch = LinkedHashMap<String, BranchEntry>()
	for (entry in local) byBranch[entry.branch] = entry
	for (entry in remote) byBranch[entry.branch] = entry
	return byBranch.values.sortedBy { it.branch }
}

/**
 * Catalog merge — dedupe by `commitHash`. Last-write-wins: `remote`
 * overrides `local`.
 */
fun mergeCatalog(
	local: List<CatalogEntry>,
	remote: List<CatalogEntry>,
): List<CatalogEntry> {
	val byHash = LinkedHashMap<String, CatalogEntry>()
	for (entry in local) byHash[entry.commitHash] = entry
	for (entry in remote) byHash[entry.commitHash] = entry
	return byHash.values.sortedBy { it.commitHash }
}

/**
 * Canonical folder name for a branch — NFKD → lowercase → replace
 * non-`[a-z0-9-]` runs with a single `-` → collapse repeats → trim
 * leading/trailing `-`. Empty/all-junk input collapses to `"branch"`.
 */
fun canonicalBranchFolder(branch: String): String {
	val normalized = java.text.Normalizer.normalize(branch, java.text.Normalizer.Form.NFKD)
		.lowercase()
		.replace(Regex("[^a-z0-9-]+"), "-")
		.replace(Regex("-+"), "-")
		.replace(Regex("^-+|-+$"), "")
	return if (normalized.isEmpty()) "branch" else normalized
}
