package ai.jolli.jollimemory.sync

/**
 * Type definitions for the four `.jolli/<aggregate>.json` files and the
 * content-addressed per-commit summary files (JOLLI-1316 §2 schema).
 *
 * Port of `cli/src/sync/AggregateTypes.ts`.
 *
 * Pure data — no runtime logic — so every consumer imports from one source.
 */

// ── manifest.json ──────────────────────────────────────────────────────

data class ManifestSource(
	val commitHash: String,
	val branch: String,
	val generatedAt: String, // ISO8601
)

data class ManifestEntry(
	val path: String,
	val fileId: String,
	val type: String, // "commit"
	val fingerprint: String,
	val title: String,
	val source: ManifestSource,
)

data class ManifestEnvelope(
	val version: Int, // 1
	val files: List<ManifestEntry>,
)

// ── index.json ─────────────────────────────────────────────────────────

data class DiffStats(
	val filesChanged: Int,
	val insertions: Int,
	val deletions: Int,
)

data class IndexEntry(
	val commitHash: String,
	val parentCommitHash: String?, // null when no parent
	val treeHash: String,
	val commitType: String, // "commit" | "amend"
	val commitMessage: String,
	val commitDate: String, // ISO8601
	val branch: String,
	val generatedAt: String, // ISO8601
	val topicCount: Int? = null,
	val diffStats: DiffStats? = null,
)

data class IndexEnvelope(
	val version: Int, // 3
	val entries: List<IndexEntry>,
)

// ── branches.json ──────────────────────────────────────────────────────

data class BranchEntry(
	val folder: String,
	val branch: String,
	val createdAt: String, // ISO8601
)

data class BranchesEnvelope(
	val version: Int, // 1
	val mappings: List<BranchEntry>,
)

// ── catalog.json ───────────────────────────────────────────────────────

data class CatalogTopic(
	val title: String,
	val decisions: String,
	val category: String,
	val importance: String,
	val filesAffected: List<String>,
)

data class CatalogEntry(
	val commitHash: String,
	val recap: String,
	val ticketId: String,
	val topics: List<CatalogTopic>,
)

data class CatalogEnvelope(
	val version: Int, // 1
	val entries: List<CatalogEntry>,
)
