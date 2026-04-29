/**
 * Data types for the local Knowledge Base (.jolli/ metadata layer).
 */

/** Source tracking for AI-generated files */
export interface ManifestSource {
	readonly commitHash?: string;
	readonly branch?: string;
	readonly generatedAt?: string;
}

/** A single entry in .jolli/manifest.json */
export interface ManifestEntry {
	readonly path: string;
	readonly fileId: string;
	readonly type: "commit" | "plan" | "note";
	readonly fingerprint: string;
	readonly source: ManifestSource;
	readonly title?: string; // human-readable display name
}

/** .jolli/manifest.json — tracks AI-generated files in the KB folder */
export interface Manifest {
	readonly version: number;
	readonly files: ManifestEntry[];
}

/** Maps a git branch name to a transcoded folder name */
export interface BranchMapping {
	readonly folder: string;
	readonly branch: string;
	readonly createdAt: string;
}

/** .jolli/branches.json — branch ↔ folder mapping registry */
export interface BranchesJson {
	readonly version: number;
	readonly mappings: BranchMapping[];
}

/** .jolli/config.json — Knowledge Base settings */
export interface KBConfig {
	readonly version: number;
	readonly sortOrder: "date" | "name";
	readonly remoteUrl?: string;
	readonly repoName?: string;
}

/** .jolli/migration.json — tracks orphan→folder migration progress */
export interface MigrationState {
	readonly status: "pending" | "in_progress" | "completed" | "partial" | "failed";
	readonly totalEntries: number;
	readonly migratedEntries: number;
	readonly failedHashes?: readonly string[];
	readonly lastMigratedHash?: string;
}
