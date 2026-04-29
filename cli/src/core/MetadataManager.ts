/**
 * MetadataManager — manages the .jolli/ metadata directory inside a KB root folder.
 *
 * Responsible for:
 * - manifest.json: tracking AI-generated files (commit summaries, plans, notes)
 * - branches.json: branch name ↔ folder name mapping
 * - config.json: KB-level settings
 * - migration.json: migration state
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createLogger } from "../Logger.js";
import type { BranchesJson, BranchMapping, KBConfig, Manifest, ManifestEntry, MigrationState } from "./KBTypes.js";

const log = createLogger("MetadataManager");

export class MetadataManager {
	private readonly manifestPath: string;
	private readonly branchesPath: string;
	private readonly configPath: string;
	private readonly migrationPath: string;

	constructor(private readonly jolliDir: string) {
		this.manifestPath = join(jolliDir, "manifest.json");
		this.branchesPath = join(jolliDir, "branches.json");
		this.configPath = join(jolliDir, "config.json");
		this.migrationPath = join(jolliDir, "migration.json");
	}

	/** Ensures the .jolli/ directory and default files exist. */
	ensure(): void {
		mkdirSync(this.jolliDir, { recursive: true });
		if (!existsSync(this.manifestPath)) {
			this.atomicWrite(this.manifestPath, JSON.stringify({ version: 1, files: [] }, null, "\t"));
		}
		if (!existsSync(this.branchesPath)) {
			this.atomicWrite(this.branchesPath, JSON.stringify({ version: 1, mappings: [] }, null, "\t"));
		}
		if (!existsSync(this.configPath)) {
			this.atomicWrite(this.configPath, JSON.stringify({ version: 1, sortOrder: "date" }, null, "\t"));
		}
	}

	// ── Manifest ───────────────────────────────────────────────────────────

	readManifest(): Manifest {
		return this.readJson<Manifest>(this.manifestPath) ?? { version: 1, files: [] };
	}

	updateManifest(entry: ManifestEntry): void {
		const manifest = this.readManifest();
		const updated = manifest.files.filter((f) => f.fileId !== entry.fileId);
		updated.push(entry);
		this.atomicWrite(this.manifestPath, JSON.stringify({ ...manifest, files: updated }, null, "\t"));
		log.info("Manifest updated: %s (%s)", entry.path, entry.type);
	}

	removeFromManifest(fileId: string): boolean {
		const manifest = this.readManifest();
		const filtered = manifest.files.filter((f) => f.fileId !== fileId);
		if (filtered.length === manifest.files.length) return false;
		this.atomicWrite(this.manifestPath, JSON.stringify({ ...manifest, files: filtered }, null, "\t"));
		return true;
	}

	findByPath(path: string): ManifestEntry | undefined {
		return this.readManifest().files.find((f) => f.path === path);
	}

	findById(fileId: string): ManifestEntry | undefined {
		return this.readManifest().files.find((f) => f.fileId === fileId);
	}

	updatePath(fileId: string, newPath: string): boolean {
		const manifest = this.readManifest();
		const entry = manifest.files.find((f) => f.fileId === fileId);
		if (!entry) return false;
		const updated = manifest.files.map((f) => (f.fileId === fileId ? { ...f, path: newPath } : f));
		this.atomicWrite(this.manifestPath, JSON.stringify({ ...manifest, files: updated }, null, "\t"));
		return true;
	}

	// ── Branch mapping ─────────────────────────────────────────────────────

	resolveFolderForBranch(branchName: string): string {
		const branches = this.readBranches();
		const existing = branches.mappings.find((m) => m.branch === branchName);
		if (existing) return existing.folder;

		const folder = MetadataManager.transcodeBranchName(branchName);
		const mapping: BranchMapping = {
			folder,
			branch: branchName,
			createdAt: new Date().toISOString(),
		};
		const updated = { ...branches, mappings: [...branches.mappings, mapping] };
		this.atomicWrite(this.branchesPath, JSON.stringify(updated, null, "\t"));
		log.info("Branch mapping created: %s → %s", branchName, folder);
		return folder;
	}

	renameBranchFolder(oldFolder: string, newFolder: string): number {
		const branches = this.readBranches();
		const updatedMappings = branches.mappings.map((m) =>
			m.folder === oldFolder ? { ...m, folder: newFolder } : m,
		);
		this.atomicWrite(this.branchesPath, JSON.stringify({ ...branches, mappings: updatedMappings }, null, "\t"));

		const manifest = this.readManifest();
		let count = 0;
		const updatedFiles = manifest.files.map((f) => {
			if (f.path.startsWith(`${oldFolder}/`)) {
				count++;
				return { ...f, path: f.path.replace(`${oldFolder}/`, `${newFolder}/`) };
			}
			return f;
		});
		if (count > 0) {
			this.atomicWrite(this.manifestPath, JSON.stringify({ ...manifest, files: updatedFiles }, null, "\t"));
		}
		return count;
	}

	removeBranchFolder(folder: string): number {
		const branches = this.readBranches();
		this.atomicWrite(
			this.branchesPath,
			JSON.stringify({ ...branches, mappings: branches.mappings.filter((m) => m.folder !== folder) }, null, "\t"),
		);

		const manifest = this.readManifest();
		const remaining = manifest.files.filter((f) => !f.path.startsWith(`${folder}/`));
		const removed = manifest.files.length - remaining.length;
		if (removed > 0) {
			this.atomicWrite(this.manifestPath, JSON.stringify({ ...manifest, files: remaining }, null, "\t"));
		}
		return removed;
	}

	readBranches(): BranchesJson {
		return this.readJson<BranchesJson>(this.branchesPath) ?? { version: 1, mappings: [] };
	}

	listBranchMappings(): BranchMapping[] {
		return this.readBranches().mappings;
	}

	// ── Config ─────────────────────────────────────────────────────────────

	readConfig(): KBConfig {
		return this.readJson<KBConfig>(this.configPath) ?? { version: 1, sortOrder: "date" };
	}

	saveConfig(config: KBConfig): void {
		this.atomicWrite(this.configPath, JSON.stringify(config, null, "\t"));
	}

	// ── Migration state ───────────────────────────────────────────────────

	readMigrationState(): MigrationState | null {
		return this.readJson<MigrationState>(this.migrationPath);
	}

	saveMigrationState(state: MigrationState): void {
		this.atomicWrite(this.migrationPath, JSON.stringify(state, null, "\t"));
	}

	// ── Reconciliation ────────────────────────────────────────────────────

	reconcile(kbRoot: string): number {
		const manifest = this.readManifest();
		if (manifest.files.length === 0) return 0;

		// Build fingerprint → path map for move detection
		const currentFiles = new Map<string, string>();
		try {
			this.walkDir(kbRoot, kbRoot, currentFiles);
		} catch {
			/* ignore */
		}

		let fixed = 0;
		const updatedFiles: ManifestEntry[] = [];
		for (const entry of manifest.files) {
			const filePath = join(kbRoot, entry.path);
			if (existsSync(filePath)) {
				updatedFiles.push(entry);
			} else {
				const newPath = currentFiles.get(entry.fingerprint);
				if (newPath && newPath !== entry.path) {
					updatedFiles.push({ ...entry, path: newPath });
					fixed++;
				} else {
					log.warn(
						"Manifest entry '%s' (id=%s) not found on disk — keeping entry to avoid data loss",
						entry.path,
						entry.fileId,
					);
					updatedFiles.push(entry);
				}
			}
		}

		if (fixed > 0) {
			this.atomicWrite(this.manifestPath, JSON.stringify({ ...manifest, files: updatedFiles }, null, "\t"));
		}
		return fixed;
	}

	private walkDir(dir: string, kbRoot: string, map: Map<string, string>): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				this.walkDir(fullPath, kbRoot, map);
			} else if (entry.name.endsWith(".md")) {
				try {
					const content = readFileSync(fullPath, "utf-8");
					const fp = MetadataManager.sha256(content);
					map.set(fp, relative(kbRoot, fullPath));
				} catch {
					/* ignore */
				}
			}
		}
	}

	// ── Branch name transcoding ────────────────────────────────────────────

	static transcodeBranchName(branch: string): string {
		let result = branch.replace(/[/\\:*?~^]/g, "-");
		result = result.replace(/-{3,}/g, "-");
		result = result.replace(/\.\./g, "--");
		result = result.replace(/^[.-]+|[.-]+$/g, "");
		return result || "default";
	}

	static sha256(content: string): string {
		return createHash("sha256").update(content, "utf-8").digest("hex");
	}

	// ── Internal helpers ───────────────────────────────────────────────────

	private readJson<T>(path: string): T | null {
		if (!existsSync(path)) return null;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as T;
		} catch {
			return null;
		}
	}

	private atomicWrite(targetPath: string, content: string): void {
		const dir = dirname(targetPath);
		mkdirSync(dir, { recursive: true });
		const tmp = `${targetPath}.tmp`;
		writeFileSync(tmp, content, "utf-8");
		renameSync(tmp, targetPath);
	}
}
