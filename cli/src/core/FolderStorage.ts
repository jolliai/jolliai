/**
 * FolderStorage — StorageProvider backed by a local filesystem folder.
 *
 * Two-layer storage:
 * - Hidden (.jolli/): JSON data files for programmatic access
 * - Visible (root): human-readable markdown files organized by branch
 *
 * When writing summaries/*.json, FolderStorage:
 * 1. Stores JSON at .jolli/summaries/*.json (hidden)
 * 2. Parses CommitSummary and generates markdown with YAML frontmatter
 * 3. Writes markdown to {branch}/{slug}-{hash8}.md (visible)
 * 4. Updates manifest to track the AI-generated file
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createLogger } from "../Logger.js";
import type { CommitSummary, FileWrite, SummaryIndex } from "../Types.js";
import { MetadataManager } from "./MetadataManager.js";
import type { StorageProvider } from "./StorageProvider.js";
import { buildMarkdown } from "./SummaryMarkdownBuilder.js";

const log = createLogger("FolderStorage");

export class FolderStorage implements StorageProvider {
	constructor(
		private readonly rootPath: string,
		private readonly metadataManager: MetadataManager,
	) {}

	async readFile(path: string): Promise<string | null> {
		const file = join(this.rootPath, ".jolli", path);
		if (!existsSync(file)) return null;
		try {
			return readFileSync(file, "utf-8");
		} catch {
			return null;
		}
	}

	async writeFiles(files: FileWrite[], message: string): Promise<void> {
		await this.ensure();
		let written = 0;
		let deleted = 0;

		for (const file of files) {
			if (file.delete) {
				if (this.deleteHiddenFile(file.path)) deleted++;
			} else {
				this.writeHiddenFile(file.path, file.content);
				written++;

				// Generate visible markdown for summary files
				if (file.path.startsWith("summaries/") && file.path.endsWith(".json")) {
					this.generateSummaryMarkdown(file.content);
				}

				// Generate visible copy for plan files
				if (file.path.startsWith("plans/") && file.path.endsWith(".md")) {
					this.generatePlanMarkdown(file.path, file.content, file.branch);
				}

				// Generate visible copy for note files
				if (file.path.startsWith("notes/") && file.path.endsWith(".md")) {
					this.generateNoteMarkdown(file.path, file.content, file.branch);
				}
			}
		}
		log.info("Wrote %d files, deleted %d (%s)", written, deleted, message);
	}

	async listFiles(prefix: string): Promise<string[]> {
		const dir = join(this.rootPath, ".jolli", prefix);
		if (!existsSync(dir)) return [];
		const jolliDir = join(this.rootPath, ".jolli");
		const result: string[] = [];
		this.walkDir(dir, jolliDir, result);
		return result.sort();
	}

	async exists(): Promise<boolean> {
		return existsSync(this.rootPath);
	}

	async ensure(): Promise<void> {
		mkdirSync(this.rootPath, { recursive: true });
		this.metadataManager.ensure();
	}

	markDirty(message: string): void {
		const statusPath = join(this.rootPath, ".jolli", "shadow-status.json");
		const status = { dirty: true, lastFailedAt: new Date().toISOString(), message };
		try {
			mkdirSync(dirname(statusPath), { recursive: true });
			writeFileSync(statusPath, JSON.stringify(status, null, "\t"), "utf-8");
		} catch {
			/* best effort */
		}
	}

	clearDirty(): void {
		const statusPath = join(this.rootPath, ".jolli", "shadow-status.json");
		try {
			if (existsSync(statusPath)) unlinkSync(statusPath);
		} catch {
			/* best effort */
		}
	}

	isDirty(): boolean {
		const statusPath = join(this.rootPath, ".jolli", "shadow-status.json");
		return existsSync(statusPath);
	}

	// ── Markdown generation ────────────────────────────────────────────────

	private generateSummaryMarkdown(summaryJson: string): void {
		let summary: CommitSummary;
		try {
			summary = JSON.parse(summaryJson) as CommitSummary;
		} catch {
			return;
		}

		const branchFolder = this.metadataManager.resolveFolderForBranch(summary.branch);
		const slug = FolderStorage.slugify(summary.commitMessage);
		const hash8 = summary.commitHash.substring(0, 8);
		const fileName = `${slug}-${hash8}.md`;
		const relativePath = `${branchFolder}/${fileName}`;

		const frontmatter = this.buildYamlFrontmatter(summary);
		const body = buildMarkdown(summary);
		const markdown = `${frontmatter}\n${body}`;

		const targetPath = join(this.rootPath, relativePath);
		this.atomicWrite(targetPath, markdown);

		const fingerprint = MetadataManager.sha256(markdown);
		this.metadataManager.updateManifest({
			path: relativePath,
			fileId: summary.commitHash,
			type: "commit",
			fingerprint,
			source: {
				commitHash: summary.commitHash,
				branch: summary.branch,
				generatedAt: summary.generatedAt,
			},
			title: summary.commitMessage,
		});

		log.info("Markdown generated: %s", relativePath);
	}

	private buildYamlFrontmatter(summary: CommitSummary): string {
		const lines = ["---"];
		lines.push(`commitHash: ${summary.commitHash}`);
		lines.push(`branch: ${summary.branch}`);
		lines.push(`author: ${summary.commitAuthor}`);
		lines.push(`date: ${summary.commitDate}`);
		lines.push("type: commit");
		if (summary.commitType) lines.push(`commitType: ${summary.commitType}`);
		if (summary.stats) {
			lines.push(`filesChanged: ${summary.stats.filesChanged}`);
			lines.push(`insertions: ${summary.stats.insertions}`);
			lines.push(`deletions: ${summary.stats.deletions}`);
		}
		lines.push("---");
		return lines.join("\n");
	}

	/**
	 * Generates a visible markdown copy of a plan file.
	 * Resolves the branch folder from the commit hash embedded in the slug.
	 */
	private generatePlanMarkdown(filePath: string, content: string, branch?: string): void {
		const slug = filePath.replace(/^plans\//, "").replace(/\.md$/, "");
		const branchFolder = branch
			? this.metadataManager.resolveFolderForBranch(branch)
			: this.resolveBranchFromSlug(slug);
		const fileName = `plan--${slug}.md`;
		const relativePath = `${branchFolder}/${fileName}`;

		const frontmatter = ["---", `type: plan`, `slug: ${slug}`, "---"].join("\n");
		const markdown = `${frontmatter}\n\n${content}`;

		this.atomicWrite(join(this.rootPath, relativePath), markdown);

		const fingerprint = MetadataManager.sha256(markdown);
		this.metadataManager.updateManifest({
			path: relativePath,
			fileId: `plan:${slug}`,
			type: "plan",
			fingerprint,
			source: {},
			title: this.extractTitle(content) ?? slug,
		});

		log.info("Plan markdown generated: %s", relativePath);
	}

	/**
	 * Generates a visible markdown copy of a note file.
	 * Resolves the branch folder from the commit hash embedded in the note id.
	 */
	private generateNoteMarkdown(filePath: string, content: string, branch?: string): void {
		const id = filePath.replace(/^notes\//, "").replace(/\.md$/, "");
		const branchFolder = branch
			? this.metadataManager.resolveFolderForBranch(branch)
			: this.resolveBranchFromSlug(id);
		const fileName = `note--${id}.md`;
		const relativePath = `${branchFolder}/${fileName}`;

		const frontmatter = ["---", `type: note`, `id: ${id}`, "---"].join("\n");
		const markdown = `${frontmatter}\n\n${content}`;

		this.atomicWrite(join(this.rootPath, relativePath), markdown);

		const fingerprint = MetadataManager.sha256(markdown);
		this.metadataManager.updateManifest({
			path: relativePath,
			fileId: `note:${id}`,
			type: "note",
			fingerprint,
			source: {},
			title: this.extractTitle(content) ?? id,
		});

		log.info("Note markdown generated: %s", relativePath);
	}

	/**
	 * Resolves a branch folder from a slug containing a commit hash suffix.
	 * Slugs follow the pattern "name-{hash8}". Looks up the manifest for a
	 * commit entry matching the hash to find the branch.
	 * Falls back to "_shared" if no matching commit is found.
	 */
	private resolveBranchFromSlug(slug: string): string {
		const hash8 = slug.split("-").pop() ?? "";
		if (hash8.length >= 7) {
			// Check manifest first (root commits)
			const manifest = this.metadataManager.readManifest();
			const manifestEntry = manifest.files.find(
				(f) => f.type === "commit" && f.source?.commitHash?.startsWith(hash8),
			);
			if (manifestEntry?.source?.branch) {
				return this.metadataManager.resolveFolderForBranch(manifestEntry.source.branch);
			}
			// Fall back to index.json (includes children from squash/amend)
			const indexPath = join(this.rootPath, ".jolli", "index.json");
			if (existsSync(indexPath)) {
				try {
					const index = JSON.parse(readFileSync(indexPath, "utf-8")) as SummaryIndex;
					const indexEntry = index.entries.find((e) => e.commitHash.startsWith(hash8));
					if (indexEntry?.branch) {
						return this.metadataManager.resolveFolderForBranch(indexEntry.branch);
					}
				} catch {
					/* ignore */
				}
			}
		}
		return "_shared";
	}

	/** Extracts the first markdown heading as a title. */
	private extractTitle(content: string): string | null {
		const match = content.match(/^#\s+(.+)/m);
		return match ? match[1].trim() : null;
	}

	// ── Hidden file operations ─────────────────────────────────────────────

	private writeHiddenFile(path: string, content: string): void {
		const target = join(this.rootPath, ".jolli", path);
		this.atomicWrite(target, content);
	}

	private deleteHiddenFile(path: string): boolean {
		const target = join(this.rootPath, ".jolli", path);
		if (!existsSync(target)) return false;
		try {
			unlinkSync(target);
			return true;
		} catch {
			return false;
		}
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	private walkDir(dir: string, baseDir: string, result: string[]): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				this.walkDir(fullPath, baseDir, result);
			} else {
				result.push(relative(baseDir, fullPath));
			}
		}
	}

	private atomicWrite(targetPath: string, content: string): void {
		mkdirSync(dirname(targetPath), { recursive: true });
		const tmp = `${targetPath}.tmp`;
		writeFileSync(tmp, content, "utf-8");
		renameSync(tmp, targetPath);
	}

	static slugify(text: string): string {
		let result = text
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-{2,}/g, "-")
			.replace(/^-+|-+$/g, "");
		if (result.length > 50) result = result.substring(0, 50).replace(/-+$/, "");
		return result || "untitled";
	}
}
