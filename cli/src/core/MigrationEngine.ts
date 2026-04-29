/**
 * MigrationEngine — migrates data from OrphanBranchStorage to FolderStorage.
 *
 * Reads all summaries, transcripts, plans, and plan-progress from the orphan
 * branch and writes them through FolderStorage, which automatically generates
 * visible markdown files and stores hidden JSON.
 *
 * Features:
 * - Idempotent: skips files already in the manifest (by fileId/commitHash)
 * - Resumable: tracks progress in .jolli/migration.json
 * - Non-destructive: orphan branch data is never modified or deleted
 * - Backfills missing titles on re-migration
 */

import { createLogger } from "../Logger.js";
import type { CommitSummary, SummaryIndex } from "../Types.js";
import type { MigrationState } from "./KBTypes.js";
import type { MetadataManager } from "./MetadataManager.js";
import type { StorageProvider } from "./StorageProvider.js";

const log = createLogger("MigrationEngine");

export class MigrationEngine {
	private index: SummaryIndex | null = null;

	constructor(
		private readonly orphanStorage: StorageProvider,
		private readonly folderStorage: StorageProvider,
		private readonly metadataManager: MetadataManager,
	) {}

	/**
	 * Runs the full migration from orphan branch to KB folder.
	 * @param onProgress callback with (migrated, total) counts
	 */
	async runMigration(onProgress?: (migrated: number, total: number) => void): Promise<MigrationState> {
		log.info("=== Migration started ===");

		const indexJson = await this.orphanStorage.readFile("index.json");
		if (!indexJson) {
			log.info("No index.json on orphan branch — nothing to migrate");
			return this.saveMigrationState({ status: "completed", totalEntries: 0, migratedEntries: 0 });
		}

		let index: SummaryIndex;
		try {
			index = JSON.parse(indexJson) as SummaryIndex;
			this.index = index;
		} catch (e) {
			log.error("Failed to parse index.json: %s", e instanceof Error ? e.message : String(e));
			return this.saveMigrationState({ status: "failed", totalEntries: 0, migratedEntries: 0 });
		}

		const rootEntries = index.entries.filter((e) => e.parentCommitHash == null);
		const totalEntries = rootEntries.length;

		this.saveMigrationState({ status: "in_progress", totalEntries, migratedEntries: 0 });

		let migrated = 0;
		let skipped = 0;
		const failedHashes: string[] = [];

		for (const entry of rootEntries) {
			const hash = entry.commitHash;

			// Skip if already migrated — but backfill missing title
			const existing = this.metadataManager.findById(hash);
			if (existing) {
				if (!existing.title) {
					await this.backfillTitle(hash, existing);
				}
				skipped++;
				migrated++;
				onProgress?.(migrated + failedHashes.length, totalEntries);
				continue;
			}

			try {
				await this.migrateSummary(hash);
				await this.migrateTranscript(hash);
				migrated++;
			} catch (e) {
				log.warn("Failed to migrate %s: %s", hash.substring(0, 8), e instanceof Error ? e.message : String(e));
				failedHashes.push(hash);
			}

			onProgress?.(migrated + failedHashes.length, totalEntries);

			this.saveMigrationState({
				status: "in_progress",
				totalEntries,
				migratedEntries: migrated,
				failedHashes: failedHashes.length > 0 ? failedHashes : undefined,
				lastMigratedHash: hash,
			});
		}

		// Migrate all summaries (including children not covered by per-root migration)
		await this.migrateAllSummaries();

		// Migrate plans
		await this.migratePlans();

		// Migrate notes
		await this.migrateNotes();

		// Migrate plan-progress
		await this.migratePlanProgress();

		// Migrate all transcripts (including children not covered by per-root migration)
		await this.migrateAllTranscripts();

		// Copy index to folder
		await this.folderStorage.writeFiles([{ path: "index.json", content: indexJson }], "Migration: copy index");

		const finalState: MigrationState = {
			status: failedHashes.length > 0 ? "partial" : "completed",
			totalEntries,
			migratedEntries: migrated,
			failedHashes: failedHashes.length > 0 ? failedHashes : undefined,
		};
		this.saveMigrationState(finalState);

		log.info(
			"=== Migration %s: %d migrated, %d skipped, %d failed ===",
			finalState.status,
			migrated - skipped,
			skipped,
			failedHashes.length,
		);
		return finalState;
	}

	/** Validates that migration was successful by comparing counts and checking for failures. */
	async validateMigration(): Promise<boolean> {
		const state = this.loadMigrationState();
		if (state?.failedHashes && state.failedHashes.length > 0) {
			log.warn("Validation failed: %d hashes failed during migration", state.failedHashes.length);
			return false;
		}

		const indexJson = await this.orphanStorage.readFile("index.json");
		if (!indexJson) return true;

		let index: SummaryIndex;
		try {
			index = JSON.parse(indexJson) as SummaryIndex;
		} catch {
			return false;
		}

		const rootEntries = index.entries.filter((e) => e.parentCommitHash == null);
		const manifest = this.metadataManager.readManifest();
		const commitEntries = manifest.files.filter((f) => f.type === "commit");

		const valid = commitEntries.length >= rootEntries.length;
		if (!valid) {
			log.warn(
				"Validation failed: orphan has %d root entries, manifest has %d commit entries",
				rootEntries.length,
				commitEntries.length,
			);
		}
		return valid;
	}

	/** Loads migration state. */
	loadMigrationState(): MigrationState | null {
		return this.metadataManager.readMigrationState();
	}

	// ── Internal migration methods ─────────────────────────────────────────

	private async backfillTitle(
		commitHash: string,
		existing: {
			fileId: string;
			path: string;
			type: "commit" | "plan" | "note";
			fingerprint: string;
			source: { commitHash?: string; branch?: string; generatedAt?: string };
		},
	): Promise<void> {
		const json = await this.orphanStorage.readFile(`summaries/${commitHash}.json`);
		if (!json) return;
		try {
			const summary = JSON.parse(json) as CommitSummary;
			this.metadataManager.updateManifest({ ...existing, title: summary.commitMessage });
			log.info("Backfilled title for %s: %s", commitHash.substring(0, 8), summary.commitMessage.substring(0, 50));
		} catch {
			/* ignore */
		}
	}

	private async migrateSummary(commitHash: string): Promise<void> {
		const json = await this.orphanStorage.readFile(`summaries/${commitHash}.json`);
		if (!json) return;
		await this.folderStorage.writeFiles(
			[{ path: `summaries/${commitHash}.json`, content: json }],
			`Migration: summary ${commitHash.substring(0, 8)}`,
		);
	}

	private async migrateTranscript(commitHash: string): Promise<void> {
		const json = await this.orphanStorage.readFile(`transcripts/${commitHash}.json`);
		if (!json) return;
		await this.folderStorage.writeFiles(
			[{ path: `transcripts/${commitHash}.json`, content: json }],
			`Migration: transcript ${commitHash.substring(0, 8)}`,
		);
	}

	private async migratePlans(): Promise<void> {
		const planFiles = await this.orphanStorage.listFiles("plans/");
		for (const path of planFiles) {
			const content = await this.orphanStorage.readFile(path);
			if (!content) continue;
			const branch = this.resolveBranchFromPath(path);
			await this.folderStorage.writeFiles([{ path, content, branch }], `Migration: plan ${path}`);
		}
		if (planFiles.length > 0) log.info("Migrated %d plan file(s)", planFiles.length);
	}

	private async migratePlanProgress(): Promise<void> {
		const progressFiles = await this.orphanStorage.listFiles("plan-progress/");
		for (const path of progressFiles) {
			const content = await this.orphanStorage.readFile(path);
			if (!content) continue;
			await this.folderStorage.writeFiles([{ path, content }], `Migration: plan-progress ${path}`);
		}
		if (progressFiles.length > 0) log.info("Migrated %d plan-progress file(s)", progressFiles.length);
	}

	private async migrateAllSummaries(): Promise<void> {
		const summaryFiles = await this.orphanStorage.listFiles("summaries/");
		let migrated = 0;
		for (const path of summaryFiles) {
			const existingContent = await this.folderStorage.readFile(path);
			if (existingContent) continue;
			const content = await this.orphanStorage.readFile(path);
			if (!content) continue;
			await this.folderStorage.writeFiles([{ path, content }], `Migration: child summary ${path}`);
			migrated++;
		}
		if (migrated > 0) log.info("Migrated %d additional summary file(s)", migrated);
	}

	private async migrateNotes(): Promise<void> {
		const noteFiles = await this.orphanStorage.listFiles("notes/");
		for (const path of noteFiles) {
			const content = await this.orphanStorage.readFile(path);
			if (!content) continue;
			const branch = this.resolveBranchFromPath(path);
			await this.folderStorage.writeFiles([{ path, content, branch }], `Migration: note ${path}`);
		}
		if (noteFiles.length > 0) log.info("Migrated %d note file(s)", noteFiles.length);
	}

	private async migrateAllTranscripts(): Promise<void> {
		const transcriptFiles = await this.orphanStorage.listFiles("transcripts/");
		let migrated = 0;
		for (const path of transcriptFiles) {
			// Skip if already migrated by per-root migration
			const existingContent = await this.folderStorage.readFile(path);
			if (existingContent) continue;
			const content = await this.orphanStorage.readFile(path);
			if (!content) continue;
			await this.folderStorage.writeFiles([{ path, content }], `Migration: transcript ${path}`);
			migrated++;
		}
		if (migrated > 0) log.info("Migrated %d additional transcript file(s)", migrated);
	}

	/** Resolves branch from a file path containing a commit hash suffix (e.g. plans/name-{hash8}.md) */
	private resolveBranchFromPath(filePath: string): string | undefined {
		const basename =
			filePath
				.split("/")
				.pop()
				?.replace(/\.\w+$/, "") ?? "";
		const hash8 = basename.split("-").pop() ?? "";
		if (hash8.length >= 7 && this.index) {
			const entry = this.index.entries.find((e) => e.commitHash.startsWith(hash8));
			if (entry?.branch) return entry.branch;
		}
		return undefined;
	}

	private saveMigrationState(state: MigrationState): MigrationState {
		this.metadataManager.saveMigrationState(state);
		return state;
	}
}
