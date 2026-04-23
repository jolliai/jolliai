/**
 * DistPathWriter — Writes per-source `dist-paths/<sourceTag>` files.
 *
 * Extracted into its own module so that `migrateLegacyDistPath()` in
 * DistPathResolver.ts can call it via a normal import (no circular
 * dependency with Installer.ts) and tests can mock it cleanly.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../Logger.js";

const log = createLogger("DistPathWriter");

/**
 * Writes the caller's dist/ directory to a per-source file at
 * `~/.jolli/jollimemory/dist-paths/<sourceTag>`.
 *
 * Each install source (CLI, VS Code, Cursor, Windsurf, ...) writes its own
 * file. Runtime selection picks the highest available version across all
 * registered sources via the `run-hook` shell script.
 *
 * File format (two lines):
 *   <version>
 *   /absolute/path/to/dist
 *
 * The version is the `@jolli.ai/cli` core version (`__PKG_VERSION__`), not the
 * IDE extension's own release version. CLI, VS Code, Cursor, etc. all bundle
 * the same `@jolli.ai/cli` core, so versions are directly comparable.
 *
 * @param sourceTag - Source identifier ("cli", "vscode", "cursor", ...).
 *   Becomes the filename inside `dist-paths/`.
 * @param distDir - Absolute path to the dist directory. Defaults to the
 *   caller's own dist/.
 * @param version - Core version. Defaults to `__PKG_VERSION__`.
 *
 * @returns `true` on success, `false` on filesystem failure (logged as warning).
 */
export async function installDistPath(sourceTag: string, distDir?: string, version?: string): Promise<boolean> {
	const currentDir = distDir ?? dirname(fileURLToPath(import.meta.url));
	/* v8 ignore start -- compile-time ternary: __PKG_VERSION__ is always defined in bundled builds */
	const ver = version ?? (typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev");
	/* v8 ignore stop */
	const distPathsDir = join(homedir(), ".jolli", "jollimemory", "dist-paths");
	const distPathFile = join(distPathsDir, sourceTag);

	try {
		await mkdir(distPathsDir, { recursive: true });
		// 2-line format: version, then absolute dist path. Source tag is the filename.
		await writeFile(distPathFile, `${ver}\n${currentDir}`, "utf-8");
		log.info("Wrote dist-paths/%s (version=%s, distDir=%s)", sourceTag, ver, currentDir);
		return true;
	} catch (error: unknown) {
		log.warn("Failed to write dist-paths/%s: %s", sourceTag, (error as Error).message);
		return false;
	}
}
