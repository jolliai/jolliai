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
import { createLogger, errMsg } from "../Logger.js";
import type { CommitSummary, FileWrite, SummaryIndex, SummaryIndexEntry } from "../Types.js";
import { MetadataManager } from "./MetadataManager.js";
import type { HealOptions, HealResult, StorageProvider } from "./StorageProvider.js";
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

	/**
	 * Remove ONLY the visible <branch>/<slug>-<hash8>.md file for this entry.
	 * Leaves .jolli/summaries/<hash>.json and .jolli/index.json in place;
	 * drops the manifest entry on successful delete (mirrors cleanupSuperseded-
	 * Descendants — keeping a manifest record for a deleted file would let
	 * future scans re-trip on a ghost path). Idempotent on a missing file.
	 *
	 * Fingerprint-guarded: skips deletion when the on-disk SHA differs from
	 * the manifest's recorded fingerprint, since that means a user has
	 * hand-edited the file. Same protection cleanupSupersededDescendants
	 * applies at write time, lifted into the StorageProvider boundary so
	 * tail-cleanup (QueueWorker) and migration callers inherit it.
	 *
	 * See StorageProvider.deleteVisibleMarkdown for the contract.
	 */
	async deleteVisibleMarkdown(entry: SummaryIndexEntry): Promise<void> {
		const slug = FolderStorage.slugify(entry.commitMessage);
		const hash8 = entry.commitHash.substring(0, 8);
		await this.deleteVisibleArtifact(entry.commitHash, entry.branch, `${slug}-${hash8}.md`);
	}

	/**
	 * See StorageProvider.deletePlanVisible for the contract. Delegates to the
	 * shared `deleteVisibleArtifact` helper with the plan's manifest fileId
	 * (`plan:<slug>`) and the conventional `plan--<slug>.md` filename.
	 */
	async deletePlanVisible(slug: string, branch: string): Promise<void> {
		await this.deleteVisibleArtifact(`plan:${slug}`, branch, `plan--${slug}.md`);
	}

	/**
	 * See StorageProvider.deleteNoteVisible for the contract. Delegates to the
	 * shared `deleteVisibleArtifact` helper with the note's manifest fileId
	 * (`note:<id>`) and the conventional `note--<id>.md` filename.
	 */
	async deleteNoteVisible(id: string, branch: string): Promise<void> {
		await this.deleteVisibleArtifact(`note:${id}`, branch, `note--${id}.md`);
	}

	/**
	 * Shared body for `deleteVisibleMarkdown` (summary), `deletePlanVisible`,
	 * and `deleteNoteVisible`. Looks up the manifest entry by `fileId`, falls
	 * back to a convention-based `<branchFolder>/<fallbackFileName>` path when
	 * the manifest record is missing, fingerprint-guards against hand-edits,
	 * and drops the manifest record on successful delete (or when the file is
	 * already gone — keeping a manifest entry for a deleted file would let
	 * future scans re-trip on a ghost path).
	 */
	private async deleteVisibleArtifact(fileId: string, branch: string, fallbackFileName: string): Promise<void> {
		const manifestEntry = this.metadataManager.findById(fileId);
		const branchFolder = this.metadataManager.resolveFolderForBranch(branch);
		const relativePath = manifestEntry?.path ?? `${branchFolder}/${fallbackFileName}`;
		const absPath = join(this.rootPath, relativePath);

		if (!existsSync(absPath)) {
			if (manifestEntry) this.metadataManager.removeFromManifest(fileId);
			return;
		}

		if (manifestEntry?.fingerprint) {
			let onDiskFingerprint: string;
			try {
				onDiskFingerprint = MetadataManager.sha256(readFileSync(absPath, "utf-8"));
				/* v8 ignore start -- defensive: readFileSync only fails after existsSync passed if the file is replaced by a directory or the fs throws EACCES mid-flow. Not reachable from a single-process unit test without mocking node:fs. */
			} catch (err) {
				log.warn("Cannot read %s for fingerprint check: %s — keeping file", relativePath, String(err));
				return;
			}
			/* v8 ignore stop */
			if (onDiskFingerprint !== manifestEntry.fingerprint) {
				log.warn(
					"Skipping cleanup of %s — file modified since manifest record (likely hand-edited)",
					relativePath,
				);
				return;
			}
		}

		try {
			unlinkSync(absPath);
			if (manifestEntry) this.metadataManager.removeFromManifest(fileId);
			log.info("Deleted visible MD: %s", relativePath);
			/* v8 ignore start -- TOCTOU defense: a concurrent writer removes the file between existsSync and unlinkSync. Requires multi-process scheduling to reproduce; the ENOENT-vs-rethrow split is asserted at code-review level. */
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				if (manifestEntry) this.metadataManager.removeFromManifest(fileId);
				return;
			}
			throw err;
		}
		/* v8 ignore stop */
	}

	/**
	 * Re-emit the visible <branch>/<slug>-<hash8>.md from the hidden
	 * .jolli/summaries/<hash>.json source. Idempotent: a `.md` already on disk
	 * causes an early return.
	 *
	 * Returns true when the `.md` ended up on disk (regenerated or already
	 * present), false when the hidden JSON was missing or unparseable.
	 * See StorageProvider.regenerateVisibleMarkdown for the contract.
	 *
	 * Does NOT reuse `generateSummaryMarkdown`. That path has two side
	 * effects we must avoid when restoring a previously written entry:
	 *   - it overwrites the manifest `title` field, clobbering user-edited
	 *     titles that `backfillTitle` is contractually obligated to preserve;
	 *   - it calls `cleanupSupersededDescendants`, which only makes sense
	 *     after a fresh write where a new root has just superseded older
	 *     children — not when we're merely restoring a previously deleted head.
	 */
	async regenerateVisibleMarkdown(entry: SummaryIndexEntry): Promise<boolean> {
		const branchFolder = this.metadataManager.resolveFolderForBranch(entry.branch);
		const slug = FolderStorage.slugify(entry.commitMessage);
		const hash8 = entry.commitHash.substring(0, 8);
		const relativePath = `${branchFolder}/${slug}-${hash8}.md`;
		const absPath = join(this.rootPath, relativePath);
		if (existsSync(absPath)) return true;

		const summaryJson = await this.readFile(`summaries/${entry.commitHash}.json`);
		if (!summaryJson) {
			log.warn("regenerateVisibleMarkdown: hidden summaries/%s.json missing", entry.commitHash.substring(0, 8));
			return false;
		}
		let summary: CommitSummary;
		try {
			summary = JSON.parse(summaryJson) as CommitSummary;
		} catch (err) {
			log.warn(
				"regenerateVisibleMarkdown: malformed summaries/%s.json — %s",
				entry.commitHash.substring(0, 8),
				errMsg(err),
			);
			return false;
		}

		const frontmatter = this.buildYamlFrontmatter(summary);
		const body = buildMarkdown(summary);
		const markdown = `${frontmatter}\n${body}`;
		this.atomicWrite(absPath, markdown);

		// Update manifest to track the regenerated .md, but preserve any
		// existing title — backfillTitle's contract is "do not touch entries
		// that already have a title", and regenerate is its companion.
		const existing = this.metadataManager.findById(entry.commitHash);
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
			title: existing?.title ?? summary.commitMessage,
		});
		log.info("Regenerated visible MD: %s", relativePath);
		return true;
	}

	/**
	 * See StorageProvider.healMissingVisibleMarkdown for the contract.
	 *
	 * Implementation notes (the non-obvious bits):
	 *
	 *   - The hidden `.jolli/summaries/<hash>.json` is the single source of
	 *     truth for `branch` + `commitMessage`. Manifest derivatives drift:
	 *     `source.branch` is optional (legacy pre-backfill rows omit it; a
	 *     `?? ""` fallback would route through `transcodeBranchName("")` →
	 *     `"default"` and pollute `branches.json`), and `title` is preserved
	 *     across regenerate to honour user edits.
	 *   - ENOENT on the hidden JSON is treated differently from other read
	 *     errors. ENOENT is "really gone" and (when the caller opts in)
	 *     eligible for manifest drop; EACCES / EBUSY / EIO are transient and
	 *     NEVER drop — the manifest row is the last record we have.
	 *   - Manifest drops are batched into a single rewrite at the end. The
	 *     prior per-row `removeFromManifest` was O(N²) on ghost-heavy
	 *     manifests and could leave the file half-cleaned on mid-loop failure.
	 *   - When the recomputed `${branchFolder}/${slug}-${hash8}.md` differs
	 *     from the manifest's existing `entry.path` (e.g. user renamed a
	 *     branch folder by hand, or slugify changed across versions), we WARN
	 *     and skip rather than silently rewriting the manifest path.
	 */
	async healMissingVisibleMarkdown(opts?: HealOptions): Promise<HealResult> {
		const manifest = this.metadataManager.readManifest();
		const commitEntries = manifest.files.filter((f) => f.type === "commit");

		let healed = 0;
		let skipped = 0;
		let failed = 0;
		const dropCandidates: string[] = [];

		for (const entry of commitEntries) {
			const absPath = join(this.rootPath, entry.path);
			if (existsSync(absPath)) {
				skipped++;
				continue;
			}

			const hiddenJsonAbs = join(this.rootPath, ".jolli", "summaries", `${entry.fileId}.json`);
			let summaryJson: string;
			try {
				summaryJson = readFileSync(hiddenJsonAbs, "utf-8");
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					failed++;
					if (opts?.dropOrphanedManifestEntries) {
						dropCandidates.push(entry.fileId);
						log.warn(
							"healMissingVisibleMarkdown: hidden JSON missing for %s — will drop manifest entry",
							entry.fileId.substring(0, 8),
						);
					} else {
						log.warn(
							"healMissingVisibleMarkdown: hidden JSON missing for %s — keeping manifest entry (no truth source to repopulate)",
							entry.fileId.substring(0, 8),
						);
					}
					continue;
				}
				// EACCES / EBUSY / EIO / antivirus lock: never drop on a
				// transient read failure — the manifest row is the last
				// breadcrumb. Caller (reconcile / CLI) will retry next pass.
				failed++;
				log.warn(
					"healMissingVisibleMarkdown: hidden JSON read failed for %s [%s]: %s — keeping manifest entry",
					entry.fileId.substring(0, 8),
					code ?? "?",
					errMsg(err),
				);
				continue;
			}

			let summary: CommitSummary;
			try {
				summary = JSON.parse(summaryJson) as CommitSummary;
			} catch (err) {
				failed++;
				log.warn(
					"healMissingVisibleMarkdown: malformed hidden JSON for %s: %s",
					entry.fileId.substring(0, 8),
					errMsg(err),
				);
				continue;
			}

			// Compute where regenerate WILL write, then compare against the
			// manifest's recorded path. A mismatch means the manifest has
			// drifted (rename, slugify-rule change, branch-folder collision
			// suffix); rewriting it silently would orphan whatever the user
			// has been navigating to. WARN and skip — let the next reconcile
			// pick this up explicitly.
			const branchFolder = this.metadataManager.resolveFolderForBranch(summary.branch);
			const slug = FolderStorage.slugify(summary.commitMessage);
			const hash8 = summary.commitHash.substring(0, 8);
			const computedRelPath = `${branchFolder}/${slug}-${hash8}.md`;
			if (computedRelPath !== entry.path) {
				// Path drift is not a heal failure: the hidden JSON is intact,
				// readable, and parseable — we're choosing not to overwrite the
				// manifest path silently. Count it as skipped so the CLI's
				// `failed` summary (which says "hidden JSON missing, malformed,
				// or read-blocked") stays accurate. Reconcile is the right tool
				// to resolve drift.
				skipped++;
				log.warn(
					"healMissingVisibleMarkdown: manifest path drift for %s — manifest=%s computed=%s — keeping manifest entry, run reconcile",
					entry.fileId.substring(0, 8),
					entry.path,
					computedRelPath,
				);
				continue;
			}

			const syntheticEntry: SummaryIndexEntry = {
				commitHash: summary.commitHash,
				parentCommitHash: null,
				commitMessage: summary.commitMessage,
				commitDate: summary.commitDate,
				branch: summary.branch,
				generatedAt: summary.generatedAt,
			};

			try {
				const wrote = await this.regenerateVisibleMarkdown(syntheticEntry);
				if (wrote) {
					healed++;
				} else {
					// regenerate could not recover (hidden JSON disappeared
					// between our read above and regenerate's re-read — TOCTOU
					// — or the parse inside regenerate failed). Source was
					// intact a moment ago; treat as transient, keep the row.
					failed++;
					log.warn(
						"healMissingVisibleMarkdown: regenerate returned false for %s — retry on next pass",
						entry.fileId.substring(0, 8),
					);
				}
			} catch (err) {
				failed++;
				log.warn(
					"healMissingVisibleMarkdown: regenerate failed for %s: %s",
					entry.fileId.substring(0, 8),
					errMsg(err),
				);
			}
		}

		// Batch drop — one manifest read+write covers every orphaned row,
		// instead of N rewrites inside the loop.
		const droppedIds = dropCandidates.length > 0 ? this.dropManifestEntries(dropCandidates) : [];

		if (healed > 0 || failed > 0) {
			log.info(
				"healMissingVisibleMarkdown: healed=%d skipped=%d failed=%d dropped=%d",
				healed,
				skipped,
				failed,
				droppedIds.length,
			);
		}
		// Only surface droppedIds when there's something to report — keeps the
		// no-op result shape `{healed:0,skipped:N,failed:0}` simple.
		return droppedIds.length > 0 ? { healed, skipped, failed, droppedIds } : { healed, skipped, failed };
	}

	private dropManifestEntries(fileIds: readonly string[]): string[] {
		if (fileIds.length === 0) return [];
		const drop = new Set(fileIds);
		const before = this.metadataManager.readManifest();
		// Return what was actually in the manifest at write time, not the
		// caller's wish list. Heal collects candidates from an earlier read,
		// so a concurrent writer (git hook QueueWorker, migration) may have
		// removed some rows in between. Reporting candidate IDs would tell the
		// user we dropped rows that were already gone.
		const actuallyDropped = before.files.filter((f) => drop.has(f.fileId)).map((f) => f.fileId);
		if (actuallyDropped.length === 0) return [];
		const kept = before.files.filter((f) => !drop.has(f.fileId));
		this.metadataManager.replaceFiles(kept);
		return actuallyDropped;
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

		// After amend/squash, the new root's tree wraps the prior root(s) as
		// children. Their visible MD copies were written by earlier writeFiles()
		// calls; only the latest root surfaces in Memories now, so the prior
		// copies are dead weight that pollute the KB folder and any push to
		// a remote KB. Delete them — but skip any whose on-disk fingerprint no
		// longer matches the manifest, since that means a human edited the file.
		if (summary.children && summary.children.length > 0) {
			this.cleanupSupersededDescendants(summary.children, relativePath);
		}
	}

	private cleanupSupersededDescendants(children: ReadonlyArray<CommitSummary>, newRootRelPath: string): void {
		const hashes: string[] = [];
		FolderStorage.collectDescendantHashes(children, hashes);

		for (const hash of hashes) {
			const entry = this.metadataManager.findById(hash);
			if (!entry || entry.type !== "commit") continue;
			// Defensive: never delete what we just wrote (would only happen in
			// a hash-prefix collision, but the cost of guarding is one compare).
			if (entry.path === newRootRelPath) continue;

			const absPath = join(this.rootPath, entry.path);
			if (!existsSync(absPath)) {
				// Already gone (prior cleanup pass, or user removed manually);
				// just drop the manifest entry so we stop tracking a ghost.
				this.metadataManager.removeFromManifest(hash);
				continue;
			}

			let onDiskFingerprint: string;
			try {
				onDiskFingerprint = MetadataManager.sha256(readFileSync(absPath, "utf-8"));
			} catch (err) {
				log.warn("Cannot read %s for fingerprint check: %s — keeping file", entry.path, String(err));
				continue;
			}

			if (onDiskFingerprint !== entry.fingerprint) {
				log.warn(
					"Skipping cleanup of %s — file modified since manifest record (likely hand-edited)",
					entry.path,
				);
				continue;
			}

			try {
				unlinkSync(absPath);
				this.metadataManager.removeFromManifest(hash);
				log.info("Cleaned up superseded MD: %s", entry.path);
			} catch (err) {
				log.warn("Failed to delete superseded MD %s: %s", entry.path, String(err));
			}
		}
	}

	private static collectDescendantHashes(nodes: ReadonlyArray<CommitSummary>, out: string[]): void {
		for (const node of nodes) {
			out.push(node.commitHash);
			if (node.children && node.children.length > 0) {
				FolderStorage.collectDescendantHashes(node.children, out);
			}
		}
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
		// String.split always returns a non-empty array, so the last element
		// is never undefined — no `?? ""` fallback needed.
		const hash8 = slug.split("-").at(-1) as string;
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
