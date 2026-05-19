/**
 * DualWriteStorage — StorageProvider that writes to both orphan branch and folder.
 *
 * Primary (OrphanBranchStorage) is the source of truth for reads.
 * Shadow (FolderStorage) receives a copy of every write. Shadow failures
 * are logged as warnings but never block the primary write path.
 */

import { createLogger, errMsg } from "../Logger.js";
import type { FileWrite, SummaryIndexEntry } from "../Types.js";
import type { StorageProvider } from "./StorageProvider.js";

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
