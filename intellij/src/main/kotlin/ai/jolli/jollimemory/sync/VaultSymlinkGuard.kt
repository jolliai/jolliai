package ai.jolli.jollimemory.sync

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

/**
 * Symlink-safety guard for vault writes.
 *
 * Port of `cli/src/sync/VaultSymlinkGuard.ts`.
 *
 * Walks the path chain from [vaultRoot] to [absTargetPath] (exclusive of the
 * final basename) and verifies every existing segment is a real directory,
 * not a symlink.
 *
 * Throws if any intermediate segment is a symlink or if [absTargetPath] is
 * not inside [vaultRoot].
 */
fun assertNoSymlinksInPath(vaultRoot: String, absTargetPath: String) {
	val vaultPath = Path.of(vaultRoot).toAbsolutePath()
	val targetPath = Path.of(absTargetPath).toAbsolutePath()

	require(targetPath.isAbsolute) { "assertNoSymlinksInPath: absTargetPath must be absolute, got $absTargetPath" }
	require(vaultPath.isAbsolute) { "assertNoSymlinksInPath: vaultRoot must be absolute, got $vaultRoot" }

	val rel = vaultPath.relativize(targetPath)
	val relStr = rel.toString()
	if (relStr.isEmpty() || relStr.startsWith("..") || rel.isAbsolute) {
		throw IllegalArgumentException(
			"assertNoSymlinksInPath: target $absTargetPath is not inside vault $vaultRoot"
		)
	}

	// Walk down the path one segment at a time, excluding the final segment.
	val segments = relStr.split(File.separator)
	var cur = vaultPath
	for (i in 0 until segments.size - 1) {
		val seg = segments[i]
		if (seg.isEmpty()) continue
		cur = cur.resolve(seg)

		val attrs = try {
			Files.readAttributes(cur, java.nio.file.attribute.BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
		} catch (_: java.nio.file.NoSuchFileException) {
			// Segment doesn't exist yet — fine, mkdir will create it.
			// Deeper segments are guaranteed non-existent too.
			return
		}

		if (attrs.isSymbolicLink) {
			throw IllegalStateException(
				"Refused vault write: path segment is a symlink at $cur (target $absTargetPath). Inspect and unlink before retrying."
			)
		}
		if (!attrs.isDirectory) {
			throw IllegalStateException(
				"Refused vault write: path segment is not a directory at $cur (target $absTargetPath)."
			)
		}
	}
}
