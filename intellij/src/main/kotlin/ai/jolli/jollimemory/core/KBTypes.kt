package ai.jolli.jollimemory.core

/**
 * Data classes for the local Knowledge Base (.jolli/ metadata layer).
 *
 * Part of JOLLI-1309 / Step 1.2–1.3: FolderStorage + MetadataManager.
 */

// ── Manifest ───────────────────────────────────────────────────────────────

/** Source tracking for AI-generated files */
data class ManifestSource(
    val commitHash: String? = null,
    val branch: String? = null,
    val generatedAt: String? = null,
)

/** A single entry in .jolli/manifest.json */
data class ManifestEntry(
    val path: String,
    val fileId: String,
    val type: String,            // "commit" | "plan" | "note"
    val fingerprint: String,
    val source: ManifestSource,
    val title: String? = null,   // human-readable display name (e.g. commit message)
)

/** .jolli/manifest.json — tracks AI-generated files in the KB folder */
data class Manifest(
    val version: Int = 1,
    val files: List<ManifestEntry> = emptyList(),
)

// ── Branch mapping ─────────────────────────────────────────────────────────

/** Maps a git branch name to a transcoded folder name */
data class BranchMapping(
    val folder: String,
    val branch: String,
    val createdAt: String,
)

/** .jolli/branches.json — branch ↔ folder mapping registry */
data class BranchesJson(
    val version: Int = 1,
    val mappings: List<BranchMapping> = emptyList(),
)

// ── KB Config ──────────────────────────────────────────────────────────────

/** .jolli/config.json — Knowledge Base settings */
data class KBConfig(
    val version: Int = 1,
    val sortOrder: String = "date",   // "date" | "name"
    val remoteUrl: String? = null,    // origin remote URL for repo identity
    val repoName: String? = null,     // repo name used to create this KB folder
)

// ── Migration state ────────────────────────────────────────────────────────

/** .jolli/migration.json — tracks orphan→folder migration progress */
data class MigrationState(
    val status: String = "pending",   // "pending" | "in_progress" | "completed" | "failed"
    val totalEntries: Int = 0,
    val migratedEntries: Int = 0,
    val lastMigratedHash: String? = null,
)
