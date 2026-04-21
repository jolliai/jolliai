/**
 * Summary Migration Module
 *
 * Handles migration of summaries from the legacy v1 orphan branch
 * (flat `records` array format) to the current v3 orphan branch
 * (tree-based `children` format matching CommitSummary version 3).
 *
 * Isolated from SummaryStore to keep the main store focused on
 * current-format read/write operations.
 */

import { createLogger, ORPHAN_BRANCH, ORPHAN_BRANCH_V1 } from "../Logger.js";
import type { CommitSummary, FileWrite, LegacyCommitSummary, SummaryIndex, SummaryRecord } from "../Types.js";
import {
	execGit,
	listFilesInBranch,
	orphanBranchExists,
	readFileFromBranch,
	writeFileToBranch,
	writeMultipleFilesToBranch,
} from "./GitOps.js";

const log = createLogger("SummaryMigration");

const INDEX_FILE = "index.json";

/**
 * Checks whether the legacy v1 orphan branch exists.
 */
export async function hasV1Branch(cwd?: string): Promise<boolean> {
	return orphanBranchExists(ORPHAN_BRANCH_V1, cwd);
}

/**
 * Migrates all summaries from the v1 orphan branch to v3 tree format.
 *
 * Conversion rules:
 *   - Single record: promote record fields (topics, stats, llm, etc.) to top level
 *   - Multi records: all records become children (pure container at top),
 *     each record is promoted to a full CommitSummary leaf node
 *
 * Reads from v1, writes to the current orphan branch. Does NOT delete the
 * v1 branch (caller handles cleanup).
 *
 * @returns Migration statistics
 */
export async function migrateV1toV3(cwd?: string): Promise<{ migrated: number; skipped: number }> {
	const v1Exists = await orphanBranchExists(ORPHAN_BRANCH_V1, cwd);
	if (!v1Exists) {
		log.info("V1 branch does not exist — nothing to migrate");
		return { migrated: 0, skipped: 0 };
	}

	// Read all summary files from v1
	const v1Files = await listFilesInBranch(ORPHAN_BRANCH_V1, "summaries/", cwd);
	log.info("Found %d summary files in v1 branch", v1Files.length);

	let migrated = 0;
	let skipped = 0;
	const filesToWrite: FileWrite[] = [];

	for (const filePath of v1Files) {
		const content = await readFileFromBranch(ORPHAN_BRANCH_V1, filePath, cwd);
		if (!content) {
			continue;
		}

		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(content) as Record<string, unknown>;
		} catch {
			log.warn("Skipping unparseable file: %s", filePath);
			skipped++;
			continue;
		}

		// Already in tree format (no records array) — copy as-is
		if (!Array.isArray(raw.records)) {
			filesToWrite.push({ path: filePath, content });
			skipped++;
			continue;
		}

		const converted = convertLegacyToTree(raw as unknown as LegacyCommitSummary);
		filesToWrite.push({ path: filePath, content: JSON.stringify(converted, null, "\t") });
		migrated++;
		log.info("Queued migration for %s", String(raw.commitHash ?? "").substring(0, 8));
	}

	// Rebuild index from v1 index, keeping only entries whose summary files were
	// successfully written. This avoids dangling index entries when a v1 file was
	// unparseable (skipped) or unreadable (null content).
	const rebuiltIndex = await rebuildIndexFromV1(filesToWrite, cwd);
	if (rebuiltIndex) {
		filesToWrite.push({ path: INDEX_FILE, content: rebuiltIndex });
	}

	if (filesToWrite.length > 0) {
		await writeMultipleFilesToBranch(
			ORPHAN_BRANCH,
			filesToWrite,
			`Migrate ${migrated} summaries from v1 to v3 tree format`,
			cwd,
		);
		log.info("Migration complete: %d migrated, %d skipped", migrated, skipped);
	} else {
		log.info("No summaries to migrate");
	}

	return { migrated, skipped };
}

/**
 * Deletes the legacy v1 orphan branch reference.
 * Safe to call even if the branch does not exist.
 */
export async function deleteV1Branch(cwd?: string): Promise<void> {
	const exists = await orphanBranchExists(ORPHAN_BRANCH_V1, cwd);
	if (!exists) {
		return;
	}

	await execGit(["update-ref", "-d", `refs/heads/${ORPHAN_BRANCH_V1}`], cwd);
	log.info("Deleted legacy v1 branch: %s", ORPHAN_BRANCH_V1);
}

const MIGRATION_META_FILE = "migration-meta.json";
/** Hours to keep the v1 branch after migration as a safety net. */
const V1_RETENTION_HOURS = 48;

/** Metadata written to the v3 branch after migration completes. */
interface MigrationMeta {
	readonly v1MigratedAt: string;
}

/**
 * Checks whether migration has already been completed by looking for
 * `migration-meta.json` in the v3 branch. Used to skip re-migration
 * when the v1 branch is still retained (48h safety window).
 */
export async function hasMigrationMeta(cwd?: string): Promise<boolean> {
	const content = await readFileFromBranch(ORPHAN_BRANCH, MIGRATION_META_FILE, cwd);
	return content !== null;
}

/**
 * Records the migration timestamp in the v3 branch so the v1 branch
 * can be cleaned up after 48 hours instead of immediately.
 */
export async function writeMigrationMeta(cwd?: string): Promise<void> {
	const meta: MigrationMeta = { v1MigratedAt: new Date().toISOString() };
	await writeFileToBranch(
		ORPHAN_BRANCH,
		MIGRATION_META_FILE,
		JSON.stringify(meta, null, "\t"),
		"Record v1→v3 migration timestamp",
		cwd,
	);
	log.info("Wrote migration metadata to %s", MIGRATION_META_FILE);
}

/**
 * Deletes the v1 branch if migration happened more than 48 hours ago.
 * Reads `migration-meta.json` from the v3 branch to check the timestamp.
 * Safe to call repeatedly — no-ops if v1 is already gone or not yet expired.
 */
export async function cleanupV1IfExpired(cwd?: string): Promise<void> {
	const v1Exists = await orphanBranchExists(ORPHAN_BRANCH_V1, cwd);
	if (!v1Exists) {
		return;
	}

	const metaContent = await readFileFromBranch(ORPHAN_BRANCH, MIGRATION_META_FILE, cwd);
	if (!metaContent) {
		// No meta file — migration hasn't run yet or meta was lost; skip cleanup
		log.debug("No migration-meta.json found — skipping v1 cleanup");
		return;
	}

	let meta: MigrationMeta;
	try {
		meta = JSON.parse(metaContent) as MigrationMeta;
	} catch {
		log.warn("Failed to parse migration-meta.json — skipping v1 cleanup");
		return;
	}

	const migratedAt = new Date(meta.v1MigratedAt).getTime();
	const hoursSinceMigration = (Date.now() - migratedAt) / (1000 * 60 * 60);

	if (hoursSinceMigration < V1_RETENTION_HOURS) {
		log.info(
			"V1 branch retained (%.1f hours since migration, keeping for %d hours)",
			hoursSinceMigration,
			V1_RETENTION_HOURS,
		);
		return;
	}

	await deleteV1Branch(cwd);
	log.info("V1 branch cleanup complete (%.1f hours since migration)", hoursSinceMigration);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Converts a legacy CommitSummary (with records array) to the new tree format.
 *
 * - Single record: promote fields to top level (leaf node)
 * - Multiple records: each record becomes a child CommitSummary (pure container at top)
 */
function convertLegacyToTree(legacy: LegacyCommitSummary): CommitSummary {
	const records = legacy.records;

	if (records.length === 1) {
		return promoteSingleRecord(legacy, records[0]);
	}

	// Multiple records: all become children, top level is a pure container
	const children = records.map((record) => recordToChildNode(legacy, record));

	// Sort children by commitDate descending (newest first)
	children.sort((a, b) => new Date(b.commitDate).getTime() - new Date(a.commitDate).getTime());

	return {
		version: 3,
		commitHash: legacy.commitHash,
		commitMessage: legacy.commitMessage,
		commitAuthor: legacy.commitAuthor,
		commitDate: legacy.commitDate,
		branch: legacy.branch,
		generatedAt: legacy.generatedAt,
		...(legacy.commitType && { commitType: legacy.commitType }),
		...(legacy.commitSource && { commitSource: legacy.commitSource }),
		...(legacy.jolliArticleUrl && { jolliDocUrl: legacy.jolliArticleUrl }),
		children,
	};
}

/**
 * Promotes a single SummaryRecord's fields to the top-level CommitSummary (leaf node).
 */
function promoteSingleRecord(legacy: LegacyCommitSummary, record: SummaryRecord): CommitSummary {
	return {
		version: 3,
		commitHash: legacy.commitHash,
		commitMessage: legacy.commitMessage,
		commitAuthor: legacy.commitAuthor,
		commitDate: legacy.commitDate,
		branch: legacy.branch,
		generatedAt: legacy.generatedAt,
		...(legacy.commitType && { commitType: legacy.commitType }),
		...(legacy.commitSource && { commitSource: legacy.commitSource }),
		transcriptEntries: record.transcriptEntries,
		...(record.conversationTurns !== undefined && { conversationTurns: record.conversationTurns }),
		...(record.llm && { llm: record.llm }),
		stats: record.stats,
		topics: record.topics,
		...(legacy.jolliArticleUrl && { jolliDocUrl: legacy.jolliArticleUrl }),
	};
}

/**
 * Converts a SummaryRecord to a standalone CommitSummary child node.
 * Fills in envelope fields (author, branch, generatedAt) from the parent legacy summary.
 */
function recordToChildNode(legacy: LegacyCommitSummary, record: SummaryRecord): CommitSummary {
	return {
		version: 3,
		commitHash: record.commitHash,
		commitMessage: record.commitMessage,
		commitAuthor: legacy.commitAuthor,
		commitDate: record.commitDate,
		branch: legacy.branch,
		generatedAt: legacy.generatedAt,
		transcriptEntries: record.transcriptEntries,
		...(record.conversationTurns !== undefined && { conversationTurns: record.conversationTurns }),
		...(record.llm && { llm: record.llm }),
		stats: record.stats,
		topics: record.topics,
	};
}

/**
 * Rebuilds the index from the v1 index, keeping only entries whose summary
 * files are present in `filesToWrite`. This prevents dangling index entries
 * when a v1 file was unparseable or unreadable.
 */
async function rebuildIndexFromV1(filesToWrite: ReadonlyArray<FileWrite>, cwd?: string): Promise<string | null> {
	const indexContent = await readFileFromBranch(ORPHAN_BRANCH_V1, INDEX_FILE, cwd);
	if (!indexContent) {
		return null;
	}

	let v1Index: SummaryIndex;
	try {
		v1Index = JSON.parse(indexContent) as SummaryIndex;
	} catch {
		log.warn("Failed to parse v1 index.json — skipping index migration");
		return null;
	}

	// Build a set of commit hashes that have a corresponding summary file in the write list
	const writtenHashes = new Set(
		filesToWrite
			.filter((f) => f.path.startsWith("summaries/") && f.path.endsWith(".json"))
			.map((f) => f.path.replace("summaries/", "").replace(".json", "")),
	);

	// Keep only index entries whose summary file was successfully queued for writing
	const filtered = v1Index.entries.filter((e) => writtenHashes.has(e.commitHash));
	const rebuilt: SummaryIndex = { version: 1, entries: filtered };
	return JSON.stringify(rebuilt, null, "\t");
}
