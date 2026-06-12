package ai.jolli.jollimemory.sync

/**
 * Pure path classifier for vault staging.
 *
 * Port of `cli/src/sync/VaultPathClassifier.ts`.
 *
 * [classifyVaultPath] returns the kind of vault-owned content the path
 * represents, or null if the path is not a FolderStorage / RepoMapping output.
 *
 * Caller contract:
 *   - Forward slashes only (git status --porcelain -z emits POSIX on every platform).
 *   - No leading `./` or `/`.
 *   - No `..` segments.
 */

/** SHA-1 partial hash, 7-64 lowercase hex chars. */
val HASH_PARTIAL_RE = Regex("^[0-9a-f]{7,64}$")

/** 8-char hex prefix used in visible-summary basenames. */
val HASH8_RE = Regex("^[0-9a-f]{8}$")

/** FolderStorage.slugify output: lowercase a-z0-9 and dashes, or "untitled". */
val SUMMARY_SLUG_RE = Regex("^(?:[a-z0-9]+(?:-[a-z0-9]+)*|untitled)$")

/**
 * Plan / note ID grammar: `[A-Za-z0-9._-]`, no leading dot or dash,
 * no `..` substring, length cap 200.
 */
val PLAN_NOTE_ID_RE = Regex("^(?!\\.)(?!.*\\.\\.)[A-Za-z0-9._-]{1,200}$")

/**
 * Safe segment regex for repo folder and branch names. Rejects:
 *   - Path separators, control chars (0x00-0x1F, 0x7F), backslash
 *   - Leading `.`, `-`, or whitespace
 *   - `..` substring
 *   - Trailing `.`, `-`, or whitespace
 *   - Length > 200
 */
private val SAFE_SEGMENT_RE = Regex(
	"^(?![.\\-\\s])(?!.*\\.\\.)[^\\x00-\\x1f\\x7f/\\\\]{1,200}(?<![.\\-\\s])$"
)

val REPO_FOLDER_RE = SAFE_SEGMENT_RE
val BRANCH_FOLDER_RE = SAFE_SEGMENT_RE

/**
 * Classify a POSIX-style forward-slash-separated relative path from the
 * vault root. Returns the [OwnedPathKind] or null if unrecognized.
 */
fun classifyVaultPath(relPath: String): OwnedPathKind? {
	val strict = classifyStrict(relPath)
	if (strict != null) return strict
	return classifyFallthrough(relPath)
}

private fun classifyStrict(relPath: String): OwnedPathKind? {
	if (relPath.isEmpty()) return null
	if (relPath.startsWith("/") || relPath.startsWith("./")) return null
	if (relPath.contains("..")) return null
	if (relPath.contains("\\")) return null

	// Root-level files.
	if (relPath == ".gitignore") return OwnedPathKind.ROOT_GITIGNORE
	if (relPath == ".jolli/repos.json") return OwnedPathKind.ROOT_REPOS

	val segments = relPath.split("/")
	if (segments.size < 2) return null

	val repoFolder = segments[0]
	if (!REPO_FOLDER_RE.matches(repoFolder)) return null

	// <repoFolder>/.jolli/...
	if (segments[1] == ".jolli") {
		if (segments.size == 3) {
			return when (segments[2]) {
				"config.json" -> OwnedPathKind.REPO_CONFIG
				"index.json" -> OwnedPathKind.REPO_INDEX
				"manifest.json" -> OwnedPathKind.REPO_MANIFEST
				"branches.json" -> OwnedPathKind.REPO_BRANCHES
				"catalog.json" -> OwnedPathKind.REPO_CATALOG
				"migration.json" -> OwnedPathKind.REPO_MIGRATION
				"shadow-status.json" -> null // per-device, never synced
				else -> null
			}
		}
		if (segments.size == 4) {
			val dir = segments[2]
			val file = segments[3]
			return when (dir) {
				"summaries" -> {
					val base = stripExt(file, ".json") ?: return null
					if (HASH_PARTIAL_RE.matches(base)) OwnedPathKind.SUMMARY else null
				}
				"transcripts" -> {
					val base = stripExt(file, ".json") ?: return null
					if (HASH_PARTIAL_RE.matches(base)) OwnedPathKind.TRANSCRIPT else null
				}
				"plans" -> {
					val base = stripExt(file, ".md") ?: return null
					if (PLAN_NOTE_ID_RE.matches(base)) OwnedPathKind.PLAN else null
				}
				"plan-progress" -> {
					val base = stripExt(file, ".json") ?: return null
					if (PLAN_NOTE_ID_RE.matches(base)) OwnedPathKind.PLAN_PROGRESS else null
				}
				"notes" -> {
					val base = stripExt(file, ".md") ?: return null
					if (PLAN_NOTE_ID_RE.matches(base)) OwnedPathKind.NOTE else null
				}
				else -> null
			}
		}
		return null
	}

	// <repoFolder>/<branch>/<file> — visible markdown.
	if (segments.size == 3) {
		val branch = segments[1]
		val file = segments[2]
		if (!BRANCH_FOLDER_RE.matches(branch)) return null

		// plan--<slug>.md
		if (file.startsWith("plan--") && file.endsWith(".md")) {
			val slug = file.removePrefix("plan--").removeSuffix(".md")
			return if (PLAN_NOTE_ID_RE.matches(slug)) OwnedPathKind.VISIBLE_PLAN else null
		}
		// note--<id>.md
		if (file.startsWith("note--") && file.endsWith(".md")) {
			val id = file.removePrefix("note--").removeSuffix(".md")
			return if (PLAN_NOTE_ID_RE.matches(id)) OwnedPathKind.VISIBLE_NOTE else null
		}
		// <slug>-<hex8>.md
		if (file.endsWith(".md")) {
			val stem = file.removeSuffix(".md")
			val dashIdx = stem.lastIndexOf('-')
			if (dashIdx <= 0 || dashIdx >= stem.length - 1) return null
			val slug = stem.substring(0, dashIdx)
			val hex8 = stem.substring(dashIdx + 1)
			if (!HASH8_RE.matches(hex8)) return null
			if (!SUMMARY_SLUG_RE.matches(slug)) return null
			return OwnedPathKind.VISIBLE_SUMMARY
		}
		return null
	}

	return null
}

private fun classifyFallthrough(relPath: String): OwnedPathKind? {
	if (relPath.isEmpty()) return null
	if (relPath.startsWith("/") || relPath.startsWith("./")) return null
	if (relPath.contains("..")) return null
	if (relPath.contains("\\")) return null
	val segments = relPath.split("/")
	for (seg in segments) {
		if (!SAFE_SEGMENT_RE.matches(seg)) return null
	}
	val leaf = segments.last()
	if (leaf == "shadow-status.json") return null
	return OwnedPathKind.USER_CONTENT
}

private fun stripExt(name: String, ext: String): String? {
	return if (name.endsWith(ext)) name.dropLast(ext.length) else null
}
