/**
 * DualWriteStorage — StorageProvider that writes to both orphan branch and folder.
 *
 * Primary (OrphanBranchStorage) is the source of truth for reads.
 * Shadow (FolderStorage) receives a copy of every write. Shadow failures
 * are logged as warnings but never block the primary write path.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { FileWrite, SummaryIndexEntry } from "../Types.js";
import type { HealOptions, HealResult, StorageProvider } from "./StorageProvider.js";

const log = createLogger("DualWriteStorage");

export class DualWriteStorage implements StorageProvider {
	constructor(
		private readonly primary: StorageProvider,
		private readonly shadow: StorageProvider,
	) {}

	async readFile(path: string): Promise<string | null> {
		return this.primary.readFile(path);
	}

	// Primary writes first because it's the source of truth (orphan branch).
	// Shadow (folder KB) is best-effort — failures are swallowed so a flaky
	// filesystem never blocks the critical git-based write path.
	async writeFiles(files: FileWrite[], message: string): Promise<void> {
		await this.primary.writeFiles(files, message);
		try {
			await this.shadow.writeFiles(files, message);
			this.shadow.clearDirty?.();
		} catch (e) {
			log.warn("Shadow write failed (folder storage): %s", e instanceof Error ? e.message : String(e));
			this.shadow.markDirty?.(message);
		}
	}

	async deleteVisibleMarkdown(entry: SummaryIndexEntry): Promise<void> {
		if (!this.shadow.deleteVisibleMarkdown) return;
		try {
			await this.shadow.deleteVisibleMarkdown(entry);
		} catch (err) {
			const hash8 = entry.commitHash.substring(0, 8);
			log.warn(
				"Shadow deleteVisibleMarkdown failed (folder storage) for %s/%s: %s",
				entry.branch,
				hash8,
				errMsg(err),
			);
			this.shadow.markDirty?.(`deleteVisibleMarkdown ${entry.branch}/${hash8}`);
		}
	}

	async regenerateVisibleMarkdown(entry: SummaryIndexEntry): Promise<boolean> {
		if (!this.shadow.regenerateVisibleMarkdown) return false;
		try {
			return await this.shadow.regenerateVisibleMarkdown(entry);
		} catch (err) {
			const hash8 = entry.commitHash.substring(0, 8);
			log.warn(
				"Shadow regenerateVisibleMarkdown failed (folder storage) for %s/%s: %s",
				entry.branch,
				hash8,
				errMsg(err),
			);
			this.shadow.markDirty?.(`regenerateVisibleMarkdown ${entry.branch}/${hash8}`);
			return false;
		}
	}

	async deletePlanVisible(slug: string, branch: string): Promise<void> {
		if (!this.shadow.deletePlanVisible) return;
		try {
			await this.shadow.deletePlanVisible(slug, branch);
		} catch (err) {
			log.warn("Shadow deletePlanVisible failed (folder storage) for %s on %s: %s", slug, branch, errMsg(err));
			this.shadow.markDirty?.(`deletePlanVisible ${branch}/${slug}`);
		}
	}

	async deleteNoteVisible(id: string, branch: string): Promise<void> {
		if (!this.shadow.deleteNoteVisible) return;
		try {
			await this.shadow.deleteNoteVisible(id, branch);
		} catch (err) {
			log.warn("Shadow deleteNoteVisible failed (folder storage) for %s on %s: %s", id, branch, errMsg(err));
			this.shadow.markDirty?.(`deleteNoteVisible ${branch}/${id}`);
		}
	}

	async healMissingVisibleMarkdown(opts?: HealOptions): Promise<HealResult> {
		// Heal target is the visible layer — only the folder side has one.
		// Try shadow first (the canonical wiring in StorageFactory), then
		// primary as a fallback in case the two are ever swapped at construction.
		const target = this.shadow.healMissingVisibleMarkdown
			? this.shadow
			: this.primary.healMissingVisibleMarkdown
				? this.primary
				: null;
		if (!target) return { healed: 0, skipped: 0, failed: 0 };
		// The orphan branch is the system of record in dual-write mode, so a
		// manifest row whose hidden JSON is also missing can be re-sourced by
		// migration / enable. Pass through the caller's flag, defaulting to
		// true at this seam: callers reach DualWriteStorage exactly when there
		// IS a truth source to repopulate from.
		const dropOrphanedManifestEntries = opts?.dropOrphanedManifestEntries ?? true;
		// Pick a log label that names which side actually ran so post-mortems
		// of error logs don't have to re-derive it from context. "Shadow" is
		// the canonical wiring; the primary fallback is rare but reachable.
		const targetLabel = target === this.shadow ? "shadow" : "primary";
		try {
			// The optional-chain guard at construction above guarantees the
			// method exists on `target`; the `?.` here is for the linter.
			const result = await target.healMissingVisibleMarkdown?.({ dropOrphanedManifestEntries });
			return result ?? { healed: 0, skipped: 0, failed: 0 };
		} catch (err) {
			// Prepend the errno when present so the CLI surface and debug log
			// both name the failure category. `errMsg` alone gives the raw
			// message which often lacks the code (e.g. EACCES vs ENOSPC vs
			// EBUSY) that drives the operator's next step.
			const code = (err as NodeJS.ErrnoException)?.code;
			const message = code ? `[${code}] ${errMsg(err)}` : errMsg(err);
			log.warn("%s healMissingVisibleMarkdown failed: %s", targetLabel, message);
			target.markDirty?.("healMissingVisibleMarkdown");
			return { healed: 0, skipped: 0, failed: 0, error: message };
		}
	}

	async listFiles(prefix: string): Promise<string[]> {
		return this.primary.listFiles(prefix);
	}

	async exists(): Promise<boolean> {
		return this.primary.exists();
	}

	async ensure(): Promise<void> {
		await this.primary.ensure();
		try {
			await this.shadow.ensure();
		} catch (e) {
			log.warn("Shadow ensure failed: %s", e instanceof Error ? e.message : String(e));
		}
	}
}
