/**
 * db → git first-bind migration writer.
 *
 * One-shot — runs only when `/credentials` reports
 * `alreadyVaultBound === false`. Backend's `LegacyDoc[]` get written
 * into `<memoryBankRoot>/legacy/...`, idempotent under re-application (same
 * path + same content = zero diff). On content-equal target this `apply()`
 * skips; otherwise it overwrites. Aggregate-file conflicts that surface
 * later during `pull --rebase` go through `ConflictResolver.tryAggregateMerge`
 * (Tier 1.5) — this writer itself does not merge.
 *
 * Kept in its own module (not in `MemoryBankBootstrap.ts`) because the
 * lifecycle is fundamentally different — bootstrap runs every round to
 * maintain `.gitignore`; legacy migration runs once per personal-space
 * and the code can be removed entirely once all v1-era users are
 * migrated.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../Logger.js";
import { isAllowedPath } from "./AllowList.js";
import type { LegacyContentResponse, LegacyDoc } from "./SyncTypes.js";

const log = createLogger("Sync:LegacyMigration");

export interface LegacyMigrationOpts {
	readonly memoryBankRoot: string;
	readonly transcripts: boolean;
}

export class LegacyMigration {
	private readonly memoryBankRoot: string;
	private readonly transcripts: boolean;

	constructor(opts: LegacyMigrationOpts) {
		this.memoryBankRoot = opts.memoryBankRoot;
		this.transcripts = opts.transcripts;
	}

	/**
	 * Writes legacy DB docs into `<memoryBankRoot>/<doc.path>`.
	 *
	 * `response.alreadyMigrated === true` short-circuits to filesWritten=0.
	 * `docType === "folder"` rows are skipped (folders are implicit — the
	 * parent dir of a file row is mkdir'd on demand).
	 * Allow-list-rejected paths are skipped with `warn` rather than
	 * aborting the migration.
	 *
	 * Backend's `LegacyDoc.path` is the full vault-relative file path
	 * (e.g. `Untitled.md`, `new-test/Jolli design.md`) — the slug is just
	 * an internal id, not part of the on-disk layout. The previous version
	 * treated `path` as a directory and appended `<slug>.md`, producing a
	 * mirror that didn't match the source personal space.
	 */
	async apply(response: LegacyContentResponse): Promise<{ readonly filesWritten: number }> {
		if (response.alreadyMigrated || response.docs.length === 0) {
			return { filesWritten: 0 };
		}
		let filesWritten = 0;
		for (const doc of response.docs) {
			if (doc.docType === "folder") continue;
			const targetRel = mapLegacyDocToVaultPath(doc);
			if (!isAllowedPath(targetRel, { syncTranscripts: this.transcripts })) {
				log.warn("apply: rejected by allow-list path=%s id=%d", targetRel, doc.id);
				continue;
			}
			const absPath = join(this.memoryBankRoot, targetRel);

			// Idempotent re-apply: skip if target already has identical content.
			try {
				const existing = await readFile(absPath, "utf-8");
				if (existing === doc.content) continue;
			} catch (e) {
				// Only ENOENT means "missing — fall through to write". Any
				// other error (EACCES, EISDIR, EIO, …) must surface; pre-§I5
				// the catch-all swallowed e.g. EACCES on a user-owned but
				// unreadable file and then `writeFile` silently clobbered
				// the existing content.
				if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			}

			await mkdir(dirname(absPath), { recursive: true });
			await writeFile(absPath, doc.content);
			filesWritten++;
		}
		log.info("apply: wrote %d files from %d docs", filesWritten, response.docs.length);
		return { filesWritten };
	}
}

/**
 * Maps a `LegacyDoc` into the vault-relative on-disk path. The backend's
 * `path` field is the authoritative file path including filename + extension
 * (e.g. `Untitled.md`, `new-test/design.md`); this function only sanitizes
 * dot-segments and (when path is missing) falls back to a slug-derived name.
 * Exported for testing.
 */
export function mapLegacyDocToVaultPath(doc: LegacyDoc): string {
	const sanitizedPath = sanitizeLegacyPath(doc.path);
	if (sanitizedPath.length > 0) return sanitizedPath;
	// Fallback for malformed rows with no `path` — preserve the doc instead
	// of silently dropping it. `.md` because backend already filters binary
	// content; worst case is a tiny .md with non-prose body.
	const extension = pickExtensionForContentType(doc.contentType);
	return `${doc.slug || "doc"}${extension}`;
}

function pickExtensionForContentType(contentType: string): string {
	const ct = contentType.toLowerCase();
	if (ct.includes("markdown")) return ".md";
	if (ct.includes("json")) return ".json";
	return ".md";
}

function sanitizeLegacyPath(rawPath: string): string {
	return rawPath
		.split("/")
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
		.join("/");
}
