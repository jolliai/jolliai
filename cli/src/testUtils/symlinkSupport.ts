/**
 * Detects whether the current process can create symlinks, so symlink-dependent
 * tests can be skipped (not failed) on machines that forbid them.
 *
 * On Windows, `symlinkSync` requires the SeCreateSymbolicLinkPrivilege
 * (administrator, or a normal account with Developer Mode enabled). A plain
 * user account throws `EPERM: operation not permitted`. Such a machine simply
 * cannot exercise the symlink-guard code paths, so the correct outcome is a
 * skipped test, not a build failure — mirroring the IntelliJ side's
 * `createSymbolicLinkOrSkip` (which aborts via a JUnit assumption).
 *
 * Usage in a test file:
 *
 *   import { it } from "vitest";
 *   import { symlinksSupported } from "../testUtils/symlinkSupport.js";
 *   const itIfSymlinks = symlinksSupported ? it : it.skip;
 *   itIfSymlinks("rejects a symlinked path segment", () => { ... });
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Probes symlink capability by actually creating one in a throwaway temp dir.
 * Returns `true` only if the symlink was created without error. Account-level
 * (not just platform-level), so an elevated/Developer-Mode Windows box returns
 * `true` and exercises the real symlink tests.
 */
export function canCreateSymlinks(): boolean {
	const dir = mkdtempSync(join(tmpdir(), "jolli-symlink-probe-"));
	try {
		writeFileSync(join(dir, "target"), "x");
		symlinkSync(join(dir, "target"), join(dir, "link"), "file");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Cached single-probe result — symlink capability does not change mid-run. */
export const symlinksSupported: boolean = canCreateSymlinks();
