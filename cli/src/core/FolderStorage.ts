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

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createLogger, errMsg } from "../Logger.js";
import { safeAtomicWriteSync } from "../sync/VaultSymlinkGuard.js";
import type { CommitSummary, FileWrite, SummaryIndex, SummaryIndexEntry } from "../Types.js";
import type { ManifestEntry } from "./KBTypes.js";
import { MetadataManager } from "./MetadataManager.js";
import { toForwardSlash } from "./PathUtils.js";
import type { HealOptions, HealResult, StorageProvider } from "./StorageProvider.js";
import { buildMarkdown } from "./SummaryMarkdownBuilder.js";
import type { TopicPage } from "./TopicKBTypes.js";
import {
	renderTopicImpl,
	renderTopicKBIndex,
	topicPageToCompiledTopic,
	type WikiRenderContext,
} from "./WikiMarkdownBuilder.js";

const log = createLogger("FolderStorage");

/**
 * Outcome of {@link FolderStorage.forceRegenerateVisibleMarkdown}. The
 * three failure modes are distinct user-recoverable states — collapsing
 * them into a boolean costs the UI its ability to point the user at the
 * right next step.
 */
export type ForceRegenerateResult = { ok: true } | { ok: false; reason: "missing" | "malformed" | "unlinkFailed" };

export class FolderStorage implements StorageProvider {
	constructor(
		private readonly rootPath: string,
		private readonly metadataManager: MetadataManager,
	) {}

	/**
	 * The vault root that contains this FolderStorage's per-repo dir.
	 * Computed once: `<vaultRoot>/<repoFolder>` is `rootPath`, so vault
	 * root is `dirname(rootPath)`. Used by the symlink-safe write helper
	 * to walk the chain from the vault root down to each target path
	 * and refuse the write if any intermediate segment is a symlink
	 * (replaces the deleted SymlinkSweep tree-walk guard).
	 */
	private get vaultRoot(): string {
		return dirname(this.rootPath);
	}

	/**
	 * The per-repo folder root (`<localFolder>/<repo>/`). Lets compile resolve
	 * the folder from the active storage instead of re-deriving it from a git cwd
	 * (multi-repo sweep targets have no git working tree).
	 */
	get kbRoot(): string {
		return this.rootPath;
	}

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
			// Path-chain symlink check + O_NOFOLLOW on the tmp leaf is the
			// per-write defence that replaces the deleted SymlinkSweep.
			// `markDirty` is best-effort historically (catch-and-swallow);
			// keep that — if the vault root contains a hostile symlink we
			// log via the guard but don't fail the caller.
			safeAtomicWriteSync(this.vaultRoot, statusPath, JSON.stringify(status, null, "\t"));
		} catch (e) {
			// Surface the suppressed failure so operators can spot a hostile
			// symlink in the vault root (the guard's own warn fires before
			// the throw, but a second line tied to `markDirty` makes the
			// suppressed shadow-status update visible in log triage).
			log.warn("markDirty suppressed: %s", errMsg(e));
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
	async deleteVisibleMarkdown(entry: SummaryIndexEntry): Promise<boolean> {
		const slug = FolderStorage.slugify(entry.commitMessage);
		const hash8 = entry.commitHash.substring(0, 8);
		return this.deleteVisibleArtifact(entry.commitHash, entry.branch, `${slug}-${hash8}.md`);
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
	 * See StorageProvider.pruneBranchMappings for the contract. Forwards to
	 * `MetadataManager.unregisterBranches`, which performs an atomic
	 * `branches.json` rewrite and leaves the manifest untouched.
	 *
	 * Disk-side cleanup: after the metadata row is gone, attempt to remove
	 * the on-disk `<rootPath>/<folder>` directory if it is empty. Without
	 * this, the Folders sidebar tree (which enumerates via `fs.readdir`)
	 * would keep showing the orphaned branch directory even though the
	 * mapping is gone. ENOTEMPTY is a no-op so user-dropped files and other
	 * non-tracked content keep the folder alive.
	 */
	async pruneBranchMappings(branches: readonly string[]): Promise<number> {
		// Snapshot mappings BEFORE unregister so we still know each branch's
		// transcoded folder name after the row is dropped.
		const folderByBranch = new Map<string, string>();
		const drop = new Set(branches);
		for (const m of this.metadataManager.listBranchMappings()) {
			if (drop.has(m.branch)) folderByBranch.set(m.branch, m.folder);
		}
		const removed = this.metadataManager.unregisterBranches(branches);
		if (removed === 0) return 0;
		await Promise.all([...folderByBranch.values()].map((folder) => this.rmdirIfEmpty(join(this.rootPath, folder))));
		return removed;
	}

	private async rmdirIfEmpty(dir: string): Promise<void> {
		try {
			await rmdir(dir);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
			log.warn("rmdir(%s) failed (non-fatal): %s", dir, errMsg(err));
		}
	}

	/**
	 * Reverse-lookup a registered branch name from its transcoded folder name.
	 * Returns null when no `branches.json` mapping matches. Used by the revert
	 * command's fallback path when a plan/note manifest entry is missing its
	 * `source.branch` (legacy entries written before this field was persisted),
	 * to route the regenerate back to the branchFolder embedded in the
	 * manifest entry's `path` instead of silently defaulting to "main".
	 */
	resolveBranchForFolder(folder: string): string | null {
		const mapping = this.metadataManager.listBranchMappings().find((m) => m.folder === folder);
		return mapping?.branch ?? null;
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
	private async deleteVisibleArtifact(fileId: string, branch: string, fallbackFileName: string): Promise<boolean> {
		const manifestEntry = this.metadataManager.findById(fileId);
		const branchFolder = this.metadataManager.resolveFolderForBranch(branch);
		const relativePath = manifestEntry?.path ?? `${branchFolder}/${fallbackFileName}`;
		const absPath = join(this.rootPath, relativePath);

		if (!existsSync(absPath)) {
			if (manifestEntry) this.metadataManager.removeFromManifest(fileId);
			return false;
		}

		if (manifestEntry?.fingerprint && this.isUserEditedOnDisk(absPath, manifestEntry.fingerprint)) {
			log.warn("Skipping cleanup of %s — file modified since manifest record (likely hand-edited)", relativePath);
			return false;
		}

		try {
			unlinkSync(absPath);
			if (manifestEntry) this.metadataManager.removeFromManifest(fileId);
			log.info("Deleted visible MD: %s", relativePath);
			return true;
			/* v8 ignore start -- TOCTOU defense: a concurrent writer removes the file between existsSync and unlinkSync. Requires multi-process scheduling to reproduce; the ENOENT-vs-rethrow split is asserted at code-review level. */
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				if (manifestEntry) this.metadataManager.removeFromManifest(fileId);
				return false;
			}
			throw err;
		}
		/* v8 ignore stop */
	}

	/**
	 * Like {@link regenerateVisibleMarkdown} but actively overwrites any
	 * existing on-disk `.md`. Used by the revert command: when the user has
	 * edited the visible markdown and wants to discard those edits, we
	 * unlink the diverged file and let `regenerateVisibleMarkdown` write a
	 * fresh copy from the hidden JSON.
	 *
	 * Validates the hidden source BEFORE unlinking. The revert path is the
	 * one place where the visible `.md` is the user's only copy of their
	 * edits — destroying it before we know the hidden JSON can produce a
	 * replacement turns the safety command into a data-loss path for
	 * exactly the corrupted-manifest / missing-source cases it should
	 * handle most defensively.
	 *
	 * Returns `{ ok: true }` when the regenerate succeeded. On failure the
	 * `reason` distinguishes three recoverable states the UI surfaces with
	 * distinct hints:
	 *   - `"missing"`: hidden `summaries/<hash>.json` is absent.
	 *   - `"malformed"`: hidden JSON exists but does not parse.
	 *   - `"unlinkFailed"`: cannot remove the existing diverged visible file.
	 * In every failure mode the visible file is left untouched.
	 */
	async forceRegenerateVisibleMarkdown(entry: SummaryIndexEntry): Promise<ForceRegenerateResult> {
		const summaryJson = await this.readFile(`summaries/${entry.commitHash}.json`);
		if (!summaryJson) {
			log.warn(
				"forceRegenerateVisibleMarkdown: hidden summaries/%s.json missing — leaving visible file intact",
				entry.commitHash.substring(0, 8),
			);
			return { ok: false, reason: "missing" };
		}
		try {
			JSON.parse(summaryJson);
		} catch (err) {
			log.warn(
				"forceRegenerateVisibleMarkdown: malformed summaries/%s.json (%s) — leaving visible file intact",
				entry.commitHash.substring(0, 8),
				errMsg(err),
			);
			return { ok: false, reason: "malformed" };
		}

		const branchFolder = this.metadataManager.resolveFolderForBranch(entry.branch);
		const slug = FolderStorage.slugify(entry.commitMessage);
		const hash8 = entry.commitHash.substring(0, 8);
		const relativePath = `${branchFolder}/${slug}-${hash8}.md`;
		const absPath = join(this.rootPath, relativePath);

		if (existsSync(absPath)) {
			try {
				unlinkSync(absPath);
				/* v8 ignore start -- defensive: unlinkSync only fails after existsSync if a concurrent process removed the file or the fs throws EACCES mid-flow. */
			} catch (err) {
				log.warn("forceRegenerateVisibleMarkdown: cannot unlink %s [%s]", relativePath, String(err));
				return { ok: false, reason: "unlinkFailed" };
			}
			/* v8 ignore stop */
		}

		// The hidden JSON validated successfully above, so a false return
		// from regenerateVisibleMarkdown here can only mean a TOCTOU race
		// where the JSON vanished between our checks and the inner read.
		// Report it as "missing" so the user gets the same recovery hint
		// they would for the up-front missing case.
		const ok = await this.regenerateVisibleMarkdown(entry);
		return ok ? { ok: true } : { ok: false, reason: "missing" };
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
					/* v8 ignore next -- defensive: node:fs throws always carry a `code`; the `?? "?"` is a fallback for non-fs error shapes */
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
		/* v8 ignore next -- defensive: caller (healMissingVisibleMarkdown) guards `dropCandidates.length > 0` before invoking this method */
		if (fileIds.length === 0) return [];
		const drop = new Set(fileIds);
		const before = this.metadataManager.readManifest();
		// Return what was actually in the manifest at write time, not the
		// caller's wish list. Heal collects candidates from an earlier read,
		// so a concurrent writer (git hook QueueWorker, migration) may have
		// removed some rows in between. Reporting candidate IDs would tell the
		// user we dropped rows that were already gone.
		const actuallyDropped = before.files.filter((f) => drop.has(f.fileId)).map((f) => f.fileId);
		/* v8 ignore next -- defensive: TOCTOU between heal's earlier read and this write; requires multi-process scheduling to reproduce */
		if (actuallyDropped.length === 0) return [];
		const kept = before.files.filter((f) => !drop.has(f.fileId));
		this.metadataManager.replaceFiles(kept);
		return actuallyDropped;
	}

	/**
	 * Returns true when `absPath` exists on disk AND its sha256 differs from
	 * `manifestFingerprint`. Used by every write/delete path that must not
	 * clobber files a user has hand-edited.
	 *
	 * Public (no `private` modifier): the VS Code extension's bridge calls
	 * this directly to drive divergence-aware UI. Not part of the
	 * StorageProvider interface because only the folder backend has visible
	 * markdown to be edited.
	 *
	 * Returns false when the file is missing OR when no baseline fingerprint
	 * is available (legacy manifest entries written before fingerprint
	 * tracking). Legacy entries will be brought under protection on their
	 * next system-side write, which populates the fingerprint.
	 *
	 * On a readFileSync failure we return true ("treat as edited"). The
	 * two pre-existing inline implementations of this check both kept the
	 * file on read errors; preserving that behaviour means callers stay
	 * conservative without needing exception-handling boilerplate.
	 */
	isUserEditedOnDisk(absPath: string, manifestFingerprint: string | undefined): boolean {
		if (!existsSync(absPath)) return false;
		if (!manifestFingerprint) return false;
		let diskFingerprint: string;
		try {
			diskFingerprint = MetadataManager.sha256(readFileSync(absPath, "utf-8"));
			/* v8 ignore start -- defensive: readFileSync only fails after existsSync passed if the file is replaced by a directory or the fs throws EACCES mid-flow. Not reachable from a single-process unit test without mocking node:fs. */
		} catch (err) {
			log.warn("isUserEditedOnDisk: cannot read %s [%s] — treating as edited", absPath, String(err));
			return true;
		}
		/* v8 ignore stop */
		return diskFingerprint !== manifestFingerprint;
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

		const existingEntry = this.metadataManager.findByPath(relativePath);
		if (this.isUserEditedOnDisk(targetPath, existingEntry?.fingerprint)) {
			log.info("FolderStorage: skip overwrite of user-edited %s", relativePath);
			return;
		}

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

			if (!entry.fingerprint) {
				// Legacy entry without fingerprint baseline — preserve the previous
				// inline-check behavior of skipping cleanup so we don't delete a file
				// we cannot prove the system wrote.
				log.warn("Skipping cleanup of %s — legacy entry has no fingerprint baseline", entry.path);
				continue;
			}
			if (this.isUserEditedOnDisk(absPath, entry.fingerprint)) {
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
	 * Read the hidden `.jolli/plans/<slug>.md` source and rewrite the
	 * visible `<branchFolder>/plan--<slug>.md`. Used by the revert command
	 * when a user wants to discard hand-edits to the visible plan.
	 *
	 * Unlinks any existing visible file first so the underlying
	 * generatePlanMarkdown write succeeds.
	 *
	 * Returns true on success, false when the hidden source is missing.
	 */
	async regenerateVisiblePlan(slug: string, branch: string): Promise<boolean> {
		const hiddenContent = await this.readFile(`plans/${slug}.md`);
		if (!hiddenContent) {
			log.warn("regenerateVisiblePlan: hidden plans/%s.md missing", slug);
			return false;
		}

		const branchFolder = this.metadataManager.resolveFolderForBranch(branch);
		const visiblePath = join(this.rootPath, branchFolder, `plan--${slug}.md`);
		if (existsSync(visiblePath)) {
			try {
				unlinkSync(visiblePath);
				/* v8 ignore start -- defensive: see forceRegenerateVisibleMarkdown */
			} catch (err) {
				log.warn("regenerateVisiblePlan: cannot unlink %s [%s]", visiblePath, String(err));
				return false;
			}
			/* v8 ignore stop */
		}

		this.generatePlanMarkdown(`plans/${slug}.md`, hiddenContent, branch);
		return true;
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

		const targetPath = join(this.rootPath, relativePath);

		const existingEntry = this.metadataManager.findByPath(relativePath);
		if (this.isUserEditedOnDisk(targetPath, existingEntry?.fingerprint)) {
			log.info("FolderStorage: skip overwrite of user-edited %s", relativePath);
			return;
		}

		this.atomicWrite(targetPath, markdown);

		const fingerprint = MetadataManager.sha256(markdown);
		this.metadataManager.updateManifest({
			path: relativePath,
			fileId: `plan:${slug}`,
			type: "plan",
			fingerprint,
			updatedAt: new Date().toISOString(),
			// Persist branch so the revert command can route the regenerate
			// back to the correct branchFolder. Without this, Extension.ts
			// falls back to "main" for any plan written from a feature branch
			// and overwrites the wrong file. When the explicit branch arg is
			// absent, leave source empty — the revert command has a path-
			// based reverse-lookup fallback for that case.
			source: branch ? { branch } : {},
			title: this.extractTitle(content) ?? slug,
		});

		log.info("Plan markdown generated: %s", relativePath);
	}

	/**
	 * Read the hidden `.jolli/notes/<id>.md` source and rewrite the visible
	 * `<branchFolder>/note--<id>.md`. Used by the revert command.
	 *
	 * Unlinks any existing visible file first so the underlying
	 * generateNoteMarkdown write succeeds.
	 *
	 * Returns true on success, false when the hidden source is missing.
	 */
	async regenerateVisibleNote(id: string, branch: string): Promise<boolean> {
		const hiddenContent = await this.readFile(`notes/${id}.md`);
		if (!hiddenContent) {
			log.warn("regenerateVisibleNote: hidden notes/%s.md missing", id);
			return false;
		}

		const branchFolder = this.metadataManager.resolveFolderForBranch(branch);
		const visiblePath = join(this.rootPath, branchFolder, `note--${id}.md`);
		if (existsSync(visiblePath)) {
			try {
				unlinkSync(visiblePath);
				/* v8 ignore start -- defensive: see forceRegenerateVisibleMarkdown */
			} catch (err) {
				log.warn("regenerateVisibleNote: cannot unlink %s [%s]", visiblePath, String(err));
				return false;
			}
			/* v8 ignore stop */
		}

		this.generateNoteMarkdown(`notes/${id}.md`, hiddenContent, branch);
		return true;
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

		const targetPath = join(this.rootPath, relativePath);

		const existingEntry = this.metadataManager.findByPath(relativePath);
		if (this.isUserEditedOnDisk(targetPath, existingEntry?.fingerprint)) {
			log.info("FolderStorage: skip overwrite of user-edited %s", relativePath);
			return;
		}

		this.atomicWrite(targetPath, markdown);

		const fingerprint = MetadataManager.sha256(markdown);
		this.metadataManager.updateManifest({
			path: relativePath,
			fileId: `note:${id}`,
			type: "note",
			fingerprint,
			// See generatePlanMarkdown for the source-branch rationale.
			source: branch ? { branch } : {},
			title: this.extractTitle(content) ?? id,
			updatedAt: new Date().toISOString(),
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
				// Forward-slash form — matches OrphanBranchStorage.listFiles (git
				// emits POSIX paths regardless of host) so downstream regex /
				// prefix consumers (e.g. SummaryStore.getTranscriptHashes) work
				// uniformly across both storage backends. Without this, Windows
				// produced `transcripts\<hash>.json` and every consumer regex that
				// hard-coded `transcripts/` silently returned an empty set.
				result.push(toForwardSlash(relative(baseDir, fullPath)));
			}
		}
	}

	/**
	 * SP3 — render the visible wiki from topic-KB pages. Full rebuild (wipe + rewrite).
	 *
	 * Best-effort relative to the hidden JSON source of truth (`topics/*.json`):
	 * the manifest+disk wipe happens before the rewrite, so a crash mid-render can
	 * leave `_wiki/` empty. That is recoverable — the next ingest re-renders from
	 * the canonical topic pages. The `_wiki/` layer is generated, never a source of truth.
	 */
	async renderTopicWiki(pages: ReadonlyArray<TopicPage>): Promise<void> {
		const wikiDir = join(this.rootPath, "_wiki");
		this.wipeWikiArtifacts(wikiDir);
		const ctx = this.buildWikiRenderContext();
		mkdirSync(wikiDir, { recursive: true });
		const compiled: ReturnType<typeof topicPageToCompiledTopic>[] = [];
		for (const page of pages) {
			try {
				const topic = topicPageToCompiledTopic(page);
				compiled.push(topic);
				const relPath = `_wiki/topic--${topic.stableSlug}.md`;
				const md = renderTopicImpl(topic, page.relatedBranches, page.lastUpdatedAt, ctx);
				this.atomicWrite(join(this.rootPath, relPath), md);
				this.metadataManager.updateManifest({
					path: relPath,
					fileId: `wiki-topic-${topic.stableSlug}`,
					type: "wiki",
					fingerprint: MetadataManager.sha256(md),
					source: { generatedAt: page.lastUpdatedAt },
					title: topic.title,
				});
			} catch (e) {
				log.warn("renderTopicWiki: failed to render topic %s: %s", page.stableSlug, errMsg(e));
			}
		}
		try {
			const indexMd = renderTopicKBIndex(compiled, ctx);
			const indexRel = "_wiki/_index.md";
			this.atomicWrite(join(this.rootPath, indexRel), indexMd);
			this.metadataManager.updateManifest({
				path: indexRel,
				fileId: "wiki-index",
				type: "wiki",
				fingerprint: MetadataManager.sha256(indexMd),
				source: { generatedAt: new Date().toISOString() },
				title: `${ctx.repoName} Knowledge Wiki`,
			});
		} catch (e) {
			log.warn("renderTopicWiki: failed to render index: %s", errMsg(e));
		}
		log.info("Topic-KB wiki regenerated: %d topics under %s", pages.length, wikiDir);
	}

	/**
	 * `_wiki/_index.md` is written on every successful render, so its presence is
	 * the cheap proxy for "the visible wiki exists". Lets the post-commit ingest
	 * re-render a user-deleted `_wiki/` even when no new sources were ingested.
	 */
	isTopicWikiPresent(): boolean {
		return existsSync(join(this.rootPath, "_wiki", "_index.md"));
	}

	/**
	 * Wipes every `.md` under `<rootPath>/_wiki/` and unregisters all manifest
	 * rows of `type: "wiki"`. Called as the first step of every wiki rebuild
	 * (per spec 110 Decision 3: merge is source of truth, no stale residue).
	 */
	private wipeWikiArtifacts(wikiDir: string): void {
		// Manifest unregister first — even if the disk wipe fails, the next
		// scan will treat orphan `_wiki/*.md` as user files (recoverable),
		// not as ghost generated entries.
		this.metadataManager.unregisterFilesByType("wiki");

		if (!existsSync(wikiDir)) return;
		try {
			for (const entry of readdirSync(wikiDir)) {
				if (!entry.endsWith(".md")) continue;
				try {
					unlinkSync(join(wikiDir, entry));
				} catch (e) {
					log.warn("FolderStorage.wipeWikiArtifacts: failed to unlink %s: %s", entry, errMsg(e));
				}
			}
		} catch (e) {
			log.warn("FolderStorage.wipeWikiArtifacts: failed to list %s: %s", wikiDir, errMsg(e));
		}
	}

	/**
	 * Builds the {@link WikiRenderContext} used by {@link WikiMarkdownBuilder}.
	 * Lookups go through {@link MetadataManager} so renames / dirty manifest
	 * rows reflect the same source the visible layer was written from.
	 */
	private buildWikiRenderContext(): WikiRenderContext {
		const repoConfig = this.metadataManager.readConfig();
		const branchMappings = this.metadataManager.listBranchMappings();
		const branchByName = new Map(branchMappings.map((m) => [m.branch, m.folder]));

		// Pre-index manifest by short commit hash so per-topic lookups don't
		// rescan the manifest array each call.
		const manifest = this.metadataManager.readManifest();
		const byShortHash = new Map<string, ManifestEntry>();
		for (const entry of manifest.files) {
			if (entry.type === "commit" && entry.source.commitHash) {
				byShortHash.set(entry.source.commitHash.substring(0, 8), entry);
			}
		}

		return {
			repoName: repoConfig.repoName ?? "Memory Bank",
			resolveCommitVisiblePath: (hash8) => {
				const entry = byShortHash.get(hash8);
				if (!entry) return null;
				// entry.path is relative to kbRoot; wiki links are relative to <kbRoot>/_wiki/.
				return `../${entry.path}`;
			},
			resolveBranchFolder: (branch) => branchByName.get(branch) ?? null,
			resolveCommitMessage: (hash8) => byShortHash.get(hash8)?.title ?? null,
		};
	}

	private atomicWrite(targetPath: string, content: string): void {
		// Routes through `safeAtomicWriteSync` so every FolderStorage write
		// gets the path-chain symlink check + leaf-level O_NOFOLLOW. This
		// is the per-write defence that replaces the deleted SymlinkSweep
		// quarantine pass. Throws if any intermediate path segment under
		// `vaultRoot` is a symlink — callers should surface that error;
		// silently swallowing it would risk a follow-up writeFileSync
		// against the same path (e.g. a retry loop) actually traversing
		// the link.
		safeAtomicWriteSync(this.vaultRoot, targetPath, content);
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
