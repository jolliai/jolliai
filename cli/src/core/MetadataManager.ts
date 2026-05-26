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
import { tryMarkHiddenOnWindows } from "../util/WindowsHidden.js";
import type { BranchesJson, BranchMapping, KBConfig, Manifest, ManifestEntry, MigrationState } from "./KBTypes.js";
import { toForwardSlash } from "./PathUtils.js";

const log = createLogger("MetadataManager");

/** Single index.json row — head iff `parentCommitHash === null`. */
export interface IndexHeadEntry {
	readonly commitHash: string;
	readonly branch: string;
	readonly parentCommitHash: string | null;
}

interface IndexFile {
	readonly version: number;
	readonly entries: ReadonlyArray<IndexHeadEntry>;
}

export class MetadataManager {
	private readonly manifestPath: string;
	private readonly branchesPath: string;
	private readonly configPath: string;
	private readonly migrationPath: string;
	private readonly indexPath: string;

	constructor(private readonly jolliDir: string) {
		this.manifestPath = join(jolliDir, "manifest.json");
		this.branchesPath = join(jolliDir, "branches.json");
		this.configPath = join(jolliDir, "config.json");
		this.migrationPath = join(jolliDir, "migration.json");
		this.indexPath = join(jolliDir, "index.json");
	}

	/** Ensures the .jolli/ directory and default files exist. */
	ensure(): void {
		const created = mkdirSync(this.jolliDir, { recursive: true });
		if (created !== undefined) {
			// Dot prefix does not auto-hide on Windows; set NTFS hidden once at creation only.
			tryMarkHiddenOnWindows(this.jolliDir);
		}
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

	/**
	 * Replace the manifest's files array in a single atomic write. Used by
	 * batch operations (heal-folder, migration cleanup) where touching the
	 * manifest once per row would be O(N²) and leave half-cleaned state on
	 * mid-loop failure.
	 */
	replaceFiles(files: readonly ManifestEntry[]): void {
		const manifest = this.readManifest();
		this.atomicWrite(this.manifestPath, JSON.stringify({ ...manifest, files: [...files] }, null, "\t"));
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

	/**
	 * Removes the mapping for `branchName` from `branches.json`.
	 *
	 * Used by `StaleChildMarkdownCleanup` once a branch has lost its last
	 * head (e.g. every entry was hoisted into another head's `children[]`
	 * during squash / amend, leaving no `parentCommitHash == null` row for
	 * that branch). Leaving the mapping in place would surface the branch
	 * in the UI even though it has zero visible content.
	 *
	 * Idempotent — no-op when the branch isn't currently mapped. Returns
	 * true if a row was actually removed, false otherwise (lets callers
	 * skip logging on the no-op path).
	 */
	removeBranchMapping(branchName: string): boolean {
		const branches = this.readBranches();
		const filtered = branches.mappings.filter((m) => m.branch !== branchName);
		if (filtered.length === branches.mappings.length) return false;
		this.atomicWrite(this.branchesPath, JSON.stringify({ ...branches, mappings: filtered }, null, "\t"));
		log.info("Branch mapping removed: %s (no remaining head)", branchName);
		return true;
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

	/**
	 * Removes the `branches.json` mapping for every branch in `branches` without
	 * touching the manifest. Used by `StaleChildMarkdownCleanup` to prune the
	 * "ghost branch" mappings left behind when cross-branch hoist relocates the
	 * head to a different branch and all surviving entries on the original
	 * branch are children with `parentCommitHash != null`. Manifest rows are
	 * NOT removed here — by the time cleanup invokes this method the hoisted
	 * children's visible `.md` is already gone, and the matching manifest rows
	 * (if any) are independently policed by `reconcile` / heal. Returns the
	 * number of mappings actually removed (input may contain duplicates or
	 * branches that were never registered; both are no-ops).
	 */
	unregisterBranches(branches: Iterable<string>): number {
		const drop = new Set(branches);
		if (drop.size === 0) return 0;
		const current = this.readBranches();
		const kept = current.mappings.filter((m) => !drop.has(m.branch));
		const removed = current.mappings.length - kept.length;
		if (removed === 0) return 0;
		this.atomicWrite(this.branchesPath, JSON.stringify({ ...current, mappings: kept }, null, "\t"));
		log.info("Branch mappings unregistered: %d", removed);
		return removed;
	}

	readBranches(): BranchesJson {
		return this.readJson<BranchesJson>(this.branchesPath) ?? { version: 1, mappings: [] };
	}

	listBranchMappings(): BranchMapping[] {
		return this.readBranches().mappings;
	}

	/**
	 * Returns every "head" entry (`parentCommitHash === null`) from
	 * `index.json` — used by the UI to filter `branches.json` mappings
	 * down to branches that actually have visible content. Returns an
	 * empty array when `index.json` is missing or unparseable; callers
	 * treat that as "no heads → suppress every mapping" defensively.
	 */
	listIndexHeads(): IndexHeadEntry[] {
		const file = this.readJson<IndexFile>(this.indexPath);
		if (!file || !Array.isArray(file.entries)) return [];
		return file.entries.filter(
			(e): e is IndexHeadEntry =>
				typeof e?.commitHash === "string" &&
				typeof e.branch === "string" &&
				(e.parentCommitHash === null || typeof e.parentCommitHash === "string") &&
				e.parentCommitHash === null,
		);
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

		// Cheap fast-path: skip the full walk when every recorded path is
		// still on disk. M existsSync calls (manifest entry count) replace
		// an O(N) recursive readdir + per-file readFile + sha256 across the
		// whole kbRoot, which is what made the previous "reconcile every
		// repo listing" approach too expensive to wire in unconditionally.
		const anyStale = manifest.files.some((f) => !existsSync(join(kbRoot, f.path)));
		if (!anyStale) return 0;

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
					map.set(fp, toForwardSlash(relative(kbRoot, fullPath)));
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

	// Content fingerprint for FolderStorage cache invalidation — never used for
	// password or credential hashing. CodeQL js/insufficient-password-hash may
	// flag indirect taint from API tokens via summary URLs; the hashed input is
	// always user-authored markdown or on-disk file bytes.
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
