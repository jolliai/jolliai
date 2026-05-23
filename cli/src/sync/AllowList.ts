/**
 * Path-based allow-list for the vault mirror.
 *
 * Enforces source plan §2.4 + JOLLI-1316 aggregate-file decisions:
 *
 *   - Content area files: `.md` and `.json` only
 *   - `.jolli/transcripts/<commitHash>.json` allowed only when
 *     `syncTranscripts: true`. Mirrors FolderStorage's on-disk layout and
 *     the `**\/.jolli/transcripts/*.json` allow-line written by
 *     `MemoryBankBootstrap`'s `.gitignore`.
 *   - `.jolli/manifest.json` / `index.json` / `branches.json` / `catalog.json`
 *     allowed (JOLLI-1316 aggregate files — see
 *     `jolli-1316-aggregate-merge-design.md §1`)
 *   - `.jolli/summaries/<commitHash>.json` allowed (content-addressed per-commit
 *     summaries; hash must be 7-64 lowercase hex)
 *   - `.jolli/config.json` allowed — carries cross-device identity
 *     (`remoteUrl`, `repoName`). Originally treated as per-device prefs and
 *     excluded, which caused phantom `<repo>-N` folders on the receiving
 *     device: pull brought down the data but not the identity → first
 *     `FolderStorage.ensure()` wrote a stub → `resolveKBPath` saw mixed
 *     identity → allocated a fresh `<repo>-2`. The `sortOrder` per-device
 *     pref piggy-backed on this file accepts cross-device overwrites as
 *     the cost of the simpler model.
 *   - Any other dot-prefixed file or directory: rejected
 *   - Symlinks: rejected (a separate on-disk check; this module is pure
 *     path-shape logic)
 *
 * The repo's `.gitignore` is the second line of defence — we don't trust
 * either layer alone, but applying allow-list rules in the mirror avoids
 * even writing rejected files to the vault working tree (which would be a
 * waste of I/O even if `.gitignore` then excluded them).
 */

import { lstat } from "node:fs/promises";
import { extname } from "node:path";

/** Extensions allowed in the content area (outside `.jolli/`). */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".json"]);

/**
 * Aggregate JSON files allowed under `.jolli/` per JOLLI-1316 §1. Each is
 * client-side-mergeable.
 *
 * `repos.json` is the vault-side `repoIdentity → folder` mapping
 * (see `RepoMapping`). It's vault-owned (never sourced from `<folderRoot>`)
 * but still mirror-allowlisted so `pruneDir` doesn't accidentally drop it
 * when scanning `.jolli/` for stale targets.
 *
 * `config.json` carries the per-folder repo identity (`remoteUrl`,
 * `repoName`) plus the per-device `sortOrder` UI preference. Identity
 * MUST sync — the previous "never sync" rule produced phantom `<repo>-N`
 * folders when a receiving device pulled data without identity, fell
 * back to a stub config, and then failed `KBPathResolver.isSameRepo` on
 * the next round. Git's default 3-way merge handles non-conflicting
 * field edits; concurrent `sortOrder` edits resolve last-write-wins.
 */
export const ALLOWED_AGGREGATE_FILES: ReadonlySet<string> = new Set([
	"manifest.json",
	"index.json",
	"branches.json",
	"catalog.json",
	"repos.json",
	"config.json",
]);

/** Lowercase-hex commit hash, 7-64 chars (covers SHA-1 abbrev … SHA-256 full). */
const SUMMARY_HASH_REGEX = /^[0-9a-f]{7,64}\.json$/;

/**
 * Slug-style filename for user-authored aggregates under `.jolli/plans/`,
 * `.jolli/plan-progress/`, and `.jolli/notes/`. Mirrors the shape
 * `SummaryStore.writePlan` / `writePlanProgress` / `writeNote` produces
 * (`PlanSlug.ts` + caller-supplied id), but enforced here defensively so
 * that a peer-pushed `<slug>` containing path-traversal, leading-dot, or
 * extension mismatch can't slip past the orphan branch into a mirror.
 *
 * Constraints:
 *   - First char must be `[A-Za-z0-9]` — blocks leading `.` (hidden),
 *     leading `-` (could parse as a flag), leading `_`.
 *   - Subsequent chars: `[A-Za-z0-9._-]` — letters, digits, dot,
 *     underscore, dash. Empirically real plans contain dots
 *     (`MemoryBankSyncSetup.en-455dcbda.md` for locale suffixes).
 *   - Total stem length 1-255 chars (filesystem-friendly).
 *   - Must end in the expected extension exactly (`.md` for plans/notes,
 *     `.json` for plan-progress).
 *
 * Path separators / `..` cannot reach this regex — `isAllowedPath` splits
 * on `[\\/]` before per-segment checks, so a `../escape.md` would be
 * three segments not two and bypass the depth-3 branch entirely.
 */
const PLAN_OR_NOTE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.md$/;
const PLAN_PROGRESS_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.json$/;

export interface AllowListOpts {
	readonly syncTranscripts: boolean;
}

/**
 * Returns true if a path relative to the vault working tree is allowed by
 * the allow-list rules (no on-disk I/O — call `isAllowedPathOnDisk` for the
 * full check including symlink rejection).
 *
 * The `relPath` is interpreted with forward-slash AND backslash separators
 * so callers don't need to normalize before calling; result is platform-
 * independent.
 */
export function isAllowedPath(relPath: string, opts: AllowListOpts): boolean {
	const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0);
	if (segments.length === 0) return false;

	const first = segments[0];

	// `.jolli/` is the only dot-prefixed top-level path we accept — JOLLI-1316
	// aggregate files, content-addressed per-commit summaries, and (opt-in)
	// transcripts. FolderStorage writes all of these under `.jolli/`; matching
	// the bootstrap-written `.gitignore` exactly avoids the previous skew
	// where the allow-list permitted a path the gitignore wouldn't sync.
	if (first === ".jolli") {
		if (segments.length === 1) return false; // bare directory
		// Layout:
		//   .jolli/<aggregate>.json          where <aggregate> ∈ ALLOWED_AGGREGATE_FILES
		//   .jolli/summaries/<hash>.json
		//   .jolli/transcripts/<hash>.json   only when syncTranscripts === true
		if (segments.length === 2) {
			return ALLOWED_AGGREGATE_FILES.has(segments[1] as string);
		}
		if (segments.length === 3 && segments[1] === "summaries") {
			return SUMMARY_HASH_REGEX.test(segments[2] as string);
		}
		if (segments.length === 3 && segments[1] === "transcripts") {
			if (!opts.syncTranscripts) return false;
			return SUMMARY_HASH_REGEX.test(segments[2] as string);
		}
		// User-authored cross-device artifacts. `SummaryStore` writes plans
		// + plan-progress per branch and notes per id. Pre-fix these were
		// rejected here, so the bootstrap-written `.gitignore` denied
		// them too, and FolderStorage's on-disk copies stayed device-local
		// (the orphan-branch source still synced via the legacy path, but
		// the new git-backed Memory Bank layer dropped them silently).
		if (segments.length === 3 && segments[1] === "plans") {
			return PLAN_OR_NOTE_REGEX.test(segments[2] as string);
		}
		if (segments.length === 3 && segments[1] === "plan-progress") {
			return PLAN_PROGRESS_REGEX.test(segments[2] as string);
		}
		if (segments.length === 3 && segments[1] === "notes") {
			return PLAN_OR_NOTE_REGEX.test(segments[2] as string);
		}
		return false;
	}

	// Reject any other dot-prefixed segment (hidden file or hidden directory).
	if (segments.some((s) => s.startsWith("."))) return false;

	// Content-area extension check.
	const ext = extname(relPath).toLowerCase();
	return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Combines `isAllowedPath` with an on-disk symlink check via `lstat`.
 * Returns false for symlinks regardless of their extension, and false for
 * any path the path-shape check would reject. Errors (ENOENT, EACCES) are
 * treated as rejection.
 */
export async function isAllowedPathOnDisk(absPath: string, relPath: string, opts: AllowListOpts): Promise<boolean> {
	if (!isAllowedPath(relPath, opts)) return false;
	try {
		const s = await lstat(absPath);
		if (s.isSymbolicLink()) return false;
		return true;
	} catch {
		return false;
	}
}
