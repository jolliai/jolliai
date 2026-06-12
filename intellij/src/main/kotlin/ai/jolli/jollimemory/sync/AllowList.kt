package ai.jolli.jollimemory.sync

import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

/**
 * Path-based allow-list for the vault mirror.
 *
 * Port of `cli/src/sync/AllowList.ts`.
 *
 * Enforces which files may be staged in the vault:
 *   - Content area: `.md` and `.json` only
 *   - `.jolli/summaries/<hash>.json`, `.jolli/transcripts/<hash>.json` (opt-in)
 *   - Aggregate files under `.jolli/`
 *   - Plans and notes under `.jolli/plans/`, `.jolli/notes/`
 *   - Rejects symlinks, dot-prefixed dirs (except `.jolli/`)
 */

/** Extensions allowed in the content area (outside `.jolli/`). */
val ALLOWED_EXTENSIONS = setOf(".md", ".json")

/** Aggregate JSON files allowed under `.jolli/`. */
val ALLOWED_AGGREGATE_FILES = setOf(
	"manifest.json", "index.json", "branches.json",
	"catalog.json", "repos.json", "config.json",
)

/** Lowercase-hex commit hash, 7-64 chars. */
private val SUMMARY_HASH_REGEX = Regex("^[0-9a-f]{7,64}\\.json$")

/** Slug-style filename for plans/notes. */
private val PLAN_OR_NOTE_REGEX = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\\.md$")
private val PLAN_PROGRESS_REGEX = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\\.json$")

data class AllowListOpts(val syncTranscripts: Boolean)

/**
 * Returns true if a path relative to the vault working tree is allowed by
 * the allow-list rules. Pure path-shape check — no disk I/O.
 */
fun isAllowedPath(relPath: String, opts: AllowListOpts): Boolean {
	val segments = relPath.split(Regex("[/\\\\]+")).filter { it.isNotEmpty() }
	if (segments.isEmpty()) return false

	val first = segments[0]

	// `.jolli/` is the only dot-prefixed top-level we accept.
	if (first == ".jolli") {
		if (segments.size == 1) return false
		if (segments.size == 2) {
			return segments[1] in ALLOWED_AGGREGATE_FILES
		}
		if (segments.size == 3 && segments[1] == "summaries") {
			return SUMMARY_HASH_REGEX.matches(segments[2])
		}
		if (segments.size == 3 && segments[1] == "transcripts") {
			if (!opts.syncTranscripts) return false
			return SUMMARY_HASH_REGEX.matches(segments[2])
		}
		if (segments.size == 3 && segments[1] == "plans") {
			return PLAN_OR_NOTE_REGEX.matches(segments[2])
		}
		if (segments.size == 3 && segments[1] == "plan-progress") {
			return PLAN_PROGRESS_REGEX.matches(segments[2])
		}
		if (segments.size == 3 && segments[1] == "notes") {
			return PLAN_OR_NOTE_REGEX.matches(segments[2])
		}
		return false
	}

	// Reject any other dot-prefixed segment.
	if (segments.any { it.startsWith(".") }) return false

	// Content-area extension check.
	val ext = relPath.substringAfterLast('.', "").let { if (it.isEmpty()) "" else ".$it" }.lowercase()
	return ext in ALLOWED_EXTENSIONS
}

/**
 * Combines [isAllowedPath] with an on-disk symlink check via lstat.
 * Returns false for symlinks regardless of extension.
 */
fun isAllowedPathOnDisk(absPath: String, relPath: String, opts: AllowListOpts): Boolean {
	if (!isAllowedPath(relPath, opts)) return false
	return try {
		val attrs = Files.readAttributes(
			Path.of(absPath),
			java.nio.file.attribute.BasicFileAttributes::class.java,
			LinkOption.NOFOLLOW_LINKS,
		)
		!attrs.isSymbolicLink
	} catch (_: Exception) {
		false
	}
}
