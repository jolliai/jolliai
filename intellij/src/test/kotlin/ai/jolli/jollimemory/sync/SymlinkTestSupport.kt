package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assumptions
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path

/**
 * Creates a symbolic link for tests, aborting (skipping) the test instead of
 * failing when the platform forbids symlink creation.
 *
 * On Windows, `Files.createSymbolicLink` requires the SeCreateSymbolicLinkPrivilege
 * (administrator or Developer Mode); a normal user account throws
 * `FileSystemException: A required privilege is not held by the client`. Such a
 * machine simply cannot exercise the symlink-guard paths, so the correct outcome
 * is a skipped test, not a failure.
 */
fun createSymbolicLinkOrSkip(link: Path, target: Path): Path =
	try {
		Files.createSymbolicLink(link, target)
	} catch (e: IOException) {
		Assumptions.abort<Path>("Skipping: cannot create symlinks on this platform (${e.message})")
	} catch (e: UnsupportedOperationException) {
		Assumptions.abort<Path>("Skipping: symlinks unsupported on this platform (${e.message})")
	}
