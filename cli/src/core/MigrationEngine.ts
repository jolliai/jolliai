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

import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary, SummaryIndex } from "../Types.js";
import type { MigrationState } from "./KBTypes.js";
import type { MetadataManager } from "./MetadataManager.js";
import { cleanupAllBranchesStaleChildMarkdown } from "./StaleChildMarkdownCleanup.js";
import type { StorageProvider } from "./StorageProvider.js";
import { bucket, track } from "./Telemetry.js";

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
		track("memory_bank_migrated", {
			repos: 1,
			outcome: finalState.status,
			entries_bucket: bucket(migrated),
		});

		log.info(
			"=== Migration %s: %d migrated, %d skipped, %d failed ===",
			finalState.status,
			migrated - skipped,
			skipped,
			failedHashes.length,
		);

		// v3 step: regenerate any head visible .md files that 0.99.2's inverted
		// leaf cleanup wrongly deleted, then drain the stale-child backlog left
		// by amend / rebase / squash sequences from before this code shipped.
		// Idempotent. See runStaleChildCleanup for details.
		try {
			await this.runStaleChildCleanup();
		} catch (err) {
			log.warn("stale-child cleanup raised: %s", errMsg(err));
		}

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

	/**
	 * v3 step (replaces the inverted v2 `runLeafCleanup` from 0.99.2): reconciles
	 * the visible .md layer with the v4 Hoist storage model in two phases that
	 * have DIFFERENT lifecycles:
	 *
	 *   1. (ONE-SHOT) Regenerate any head .md (`parentCommitHash == null` entry)
	 *      whose visible file is missing — undoes the damage of 0.99.2's
	 *      leaf-only pass which inverted the semantics and deleted heads while
	 *      keeping hoisted older children. This is a historical repair, gated on
	 *      `state.staleChildCleanup.completedAt`: once it runs cleanly it never
	 *      runs again.
	 *   2. (EVERY INVOCATION) Delete every stale-child .md
	 *      (`parentCommitHash != null`) — older versions hoisted into a head's
	 *      `children[]` that must not surface as standalone Memories. This is an
	 *      idempotent reconciliation, NOT a one-shot repair: it runs on every
	 *      activate so the "visible folder shows only heads" invariant is
	 *      self-healing. The QueueWorker tail cleanup only sweeps the branch of a
	 *      live git op, so children hoisted on a now-inactive / merged branch are
	 *      otherwise never revisited and their orphaned .md accumulate forever.
	 *
	 * The `state.staleChildCleanup.completedAt` stamp gates ONLY phase 1; an
	 * existing stamp is preserved verbatim rather than re-stamped each run. The
	 * legacy `state.leafCleanup` field from 0.99.2 is intentionally NOT consulted
	 * — users who ran 0.99.2 must run phase 1 exactly once to repair the inverted
	 * state, regardless of what `leafCleanup.completedAt` says.
	 *
	 * Called from `runMigration` after v1 completes; also invoked directly from
	 * VS Code/IDE activate paths on every startup.
	 */
	async runStaleChildCleanup(): Promise<MigrationState & { readonly swept: number }> {
		const existing = this.metadataManager.readMigrationState();
		const priorStamp = existing?.staleChildCleanup?.completedAt;

		// Phase 1 (ONE-SHOT, gated): regenerate head .md that 0.99.2's inverted
		// pass deleted. Once the stamp is set this historical repair never runs
		// again — a head missing for some later reason is healMissingVisibleMarkdown's
		// job, not this pass's.
		const regenAlreadyDone = Boolean(priorStamp);
		let regen = { regenerated: 0, skipped: 0, failed: 0 };
		if (regenAlreadyDone) {
			log.info("0.99.2 head-regen already completed at %s — skipping phase 1", priorStamp);
		} else {
			log.info("=== 0.99.2 head-regen (one-shot) started ===");
			regen = await this.regenerateMissingHeadMarkdown();
			log.info(
				"Head regenerate: regenerated=%d skipped=%d failed=%d",
				regen.regenerated,
				regen.skipped,
				regen.failed,
			);
		}

		// Phase 2 (EVERY INVOCATION): delete every stale-child visible .md. This
		// is an idempotent reconciliation that runs on every activate so the
		// "visible folder shows only heads" invariant self-heals — children
		// hoisted on a now-inactive / merged branch are never revisited by the
		// QueueWorker tail cleanup and would otherwise accumulate forever.
		const result = await cleanupAllBranchesStaleChildMarkdown(undefined, this.folderStorage);
		log.info("Stale-child sweep: deleted=%d failed=%d", result.deleted, result.failed);
		// Phase 2 failures no longer gate the stamp (it gates phase 1 only), but a
		// persistently undeletable .md — EACCES/EBUSY — leaves a ghost child in the
		// visible folder that no later run surfaces. Warn independently so the
		// failure isn't swallowed at info level (silent under _silentConsole).
		if (result.failed > 0) {
			log.warn("Stale-child sweep left %d visible .md undeleted — ghost entries may persist", result.failed);
		}

		// The stamp gates ONLY phase 1, so it depends solely on a clean regen
		// run; a failed regen withholds it so the next activate retries the
		// one-shot repair (a premature stamp would silently lose the head .md we
		// claimed to regenerate). An existing stamp is preserved verbatim — phase
		// 2's recurring sweep must not bump the timestamp on every startup.
		const regenClean = regenAlreadyDone || regen.failed === 0;
		const completedAt = priorStamp ?? (regenClean ? new Date().toISOString() : undefined);
		const merged: MigrationState = {
			status: existing?.status ?? "completed",
			totalEntries: existing?.totalEntries ?? 0,
			migratedEntries: existing?.migratedEntries ?? 0,
			...(existing?.failedHashes ? { failedHashes: existing.failedHashes } : {}),
			...(existing?.lastMigratedHash ? { lastMigratedHash: existing.lastMigratedHash } : {}),
			// Preserve the legacy 0.99.2 field if present so we don't accidentally
			// invalidate it for any host code that still reads it during transition.
			...(existing?.leafCleanup ? { leafCleanup: existing.leafCleanup } : {}),
			...(completedAt ? { staleChildCleanup: { completedAt } } : {}),
		};
		if (!regenClean) {
			log.warn(
				"0.99.2 head-regen did not finish cleanly (regen.failed=%d) — will retry phase 1 on next invocation",
				regen.failed,
			);
		}
		this.metadataManager.saveMigrationState(merged);
		// `swept` is a transient signal for the caller (how many visible .md the
		// run actually changed) — NOT persisted: `saveMigrationState` only writes
		// the clean `merged` MigrationState above. It sums BOTH phases' real
		// mutations: stale-child .md deleted (phase 2) AND head .md regenerated
		// (phase 1) — the one-shot repair can regenerate a head while deleting no
		// stale child, and that head must still appear immediately. The VS Code
		// activate path uses swept>0 to refresh the sidebar ONLY when the visible
		// layer actually changed, so a no-op reconcile doesn't reset the folder
		// tree. `result.deleted` now counts real unlinks (already-gone .md return
		// false), so a steady-state reconcile reports swept=0.
		return { ...merged, swept: result.deleted + regen.regenerated };
	}

	/**
	 * Walk every head entry (`parentCommitHash == null`) in the folder index
	 * and re-emit its visible `.md` from the hidden JSON source if missing.
	 * Idempotent (skips entries whose `.md` is already on disk). Used by
	 * runStaleChildCleanup to recover heads that 0.99.2 erroneously deleted.
	 */
	private async regenerateMissingHeadMarkdown(): Promise<{
		regenerated: number;
		skipped: number;
		failed: number;
	}> {
		if (!this.folderStorage.regenerateVisibleMarkdown) {
			return { regenerated: 0, skipped: 0, failed: 0 };
		}
		const indexJson = await this.folderStorage.readFile("index.json");
		if (!indexJson) {
			// Folder index.json should always exist by the time this runs (runMigration
			// writes it; the VS Code activate caller only invokes us when migration has
			// previously completed). Missing index here implies corruption / wipe, not
			// a legitimately-empty state — surface as failure so runStaleChildCleanup
			// withholds its idempotency stamp and retries on the next invocation.
			log.warn("regenerateMissingHeadMarkdown: folder index.json missing — treating as failure");
			return { regenerated: 0, skipped: 0, failed: 1 };
		}
		let index: SummaryIndex;
		try {
			index = JSON.parse(indexJson) as SummaryIndex;
		} catch (e) {
			log.warn("regenerateMissingHeadMarkdown: cannot parse index.json — %s", errMsg(e));
			return { regenerated: 0, skipped: 0, failed: 1 };
		}
		const heads = index.entries.filter((e) => e.parentCommitHash == null);

		let regenerated = 0;
		let skipped = 0;
		let failed = 0;
		for (const head of heads) {
			try {
				const wrote = await this.folderStorage.regenerateVisibleMarkdown(head);
				if (wrote) regenerated++;
				else skipped++;
			} catch (err) {
				failed++;
				log.warn(
					"regenerateVisibleMarkdown failed for %s on %s: %s",
					head.commitHash.substring(0, 8),
					head.branch,
					errMsg(err),
				);
			}
		}
		return { regenerated, skipped, failed };
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
			type: "commit" | "plan" | "note" | "wiki";
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
		/* v8 ignore start -- defensive: split() always returns ≥1 element, so the ?? "" fallbacks are unreachable for any string input */
		const basename =
			filePath
				.split("/")
				.pop()
				?.replace(/\.\w+$/, "") ?? "";
		const hash8 = basename.split("-").pop() ?? "";
		/* v8 ignore stop */
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
