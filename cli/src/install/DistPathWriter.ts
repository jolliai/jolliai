/**
 * DistPathWriter — Writes per-source `dist-paths/<sourceTag>` files.
 *
 * Extracted into its own module so that `migrateLegacyDistPath()` in
 * DistPathResolver.ts can call it via a normal import (no circular
 * dependency with Installer.ts) and tests can mock it cleanly.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "../core/AtomicWrite.js";
import { createLogger } from "../Logger.js";
import { isValidSourceTag } from "./DistSourceTag.js";

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
 * The version is the `@jolli.ai/cli` core version (`__CLI_PKG_VERSION__`), not
 * the IDE extension's own release version. CLI, VS Code, Cursor, etc. all bundle
 * the same `@jolli.ai/cli` core, so versions are directly comparable — runtime
 * selection picks the surface carrying the newest *core*. `__CLI_PKG_VERSION__`
 * (rather than `__PKG_VERSION__`) is required because under the VSCode bundle
 * `__PKG_VERSION__` is the extension's own release number, which diverges from
 * the bundled core's version (see Globals.d.ts).
 *
 * The read-modify-write below (read existing entry → keep-or-overwrite by
 * completeness → atomic write) is deliberately NOT internally locked: every
 * caller runs it under the machine-global `withRuntimeRegistryLock` (see
 * `Installer.reconcileRuntime` and `PostInstall`), which serializes concurrent
 * writers to `dist-paths/<sourceTag>` across processes and surfaces. A future
 * caller MUST hold that lock too, or it reintroduces a read-modify-write race.
 * The write itself is atomic (temp + rename), so the file is never left torn
 * even if that invariant is ever violated — only the keep/overwrite decision
 * could race.
 *
 * @param sourceTag - Source identifier ("cli", "vscode", "cursor", ...).
 *   Becomes the filename inside `dist-paths/`.
 * @param distDir - Absolute path to the dist directory. Defaults to the
 *   caller's own dist/.
 * @param version - Core version. Defaults to `__CLI_PKG_VERSION__`.
 *
 * @returns `true` on success, `false` on filesystem failure (logged as warning).
 */
export async function installDistPath(
	sourceTag: string,
	distDir?: string,
	version?: string,
	globalDir?: string,
): Promise<boolean> {
	// The tag becomes a filename under `dist-paths/`. Re-validate at this write
	// boundary (not only at the `--source-tag` CLI flag) so a `/` or `..` can never
	// traverse out of the directory, regardless of which caller supplied it.
	if (!isValidSourceTag(sourceTag)) {
		log.warn("Refusing to write dist-paths entry for unsafe source tag: %s", JSON.stringify(sourceTag));
		return false;
	}
	const currentDir = distDir ?? dirname(fileURLToPath(import.meta.url));
	/* v8 ignore start -- compile-time ternary: __CLI_PKG_VERSION__ is always defined in bundled builds */
	const ver = version ?? (typeof __CLI_PKG_VERSION__ !== "undefined" ? __CLI_PKG_VERSION__ : "dev");
	/* v8 ignore stop */
	const distPathsDir = join(globalDir ?? join(homedir(), ".jolli", "jollimemory"), "dist-paths");
	const distPathFile = join(distPathsDir, sourceTag);

	try {
		await mkdir(distPathsDir, { recursive: true });
		// 2-line format: version, then absolute dist path. Source tag is the filename.
		const next = `${ver}\n${currentDir}`;
		let existing: string | undefined;
		try {
			existing = await readFile(distPathFile, "utf-8");
		} catch {
			// Missing entry is written below.
		}
		if (existing) {
			const [existingVersion, existingDir] = existing.split("\n");
			const existingComplete = Boolean(existingVersion && existingDir && isCompleteRuntimeDist(existingDir));
			// Keep the existing entry ONLY when it is complete and the candidate is not.
			// An incomplete dist can't serve `run-hook`, so it must never replace a
			// working one — not even at a higher version. Otherwise a corrupt/partial
			// build would brick a single-source install: the only registered dist would
			// resolve to no runnable hook.
			//
			// This gate deliberately does NOT compare versions. It used to also keep the
			// existing entry on `compareSemver(existingVersion, ver) >= 0`, which reads as
			// "monotonic same-source update" but is wrong for a registry keyed by source
			// tag ALONE, never by path: two builds of the SAME version compete for one
			// slot, and the incumbent won forever. A same-version rebuild in another
			// worktree — or a global reinstall at a new path — then kept dispatching to
			// the old dist while the write reported success, with only a debug-log line
			// to show for it. Re-registering the same path is already a no-op via the
			// `existing !== next` check below, so the version arm could only ever freeze
			// a stale path. Don't re-add it: reaching this function at all means an
			// install or enable ran, which is an explicit claim on the slot.
			if (existingComplete && !isCompleteRuntimeDist(currentDir)) {
				log.info(
					"Kept complete dist-paths/%s (version=%s) — candidate dist is incomplete: %s",
					sourceTag,
					existingVersion,
					currentDir,
				);
				return true;
			}
		}
		if (existing !== next) await atomicWriteFile(distPathFile, next);
		log.info("Wrote dist-paths/%s (version=%s, distDir=%s)", sourceTag, ver, currentDir);
		return true;
	} catch (error: unknown) {
		log.warn("Failed to write dist-paths/%s: %s", sourceTag, (error as Error).message);
		return false;
	}
}

const REQUIRED_RUNTIME_FILES = [
	"Cli.js",
	"StopHook.js",
	"SessionStartHook.js",
	"PostCommitHook.js",
	"PostRewriteHook.js",
	"PrepareMsgHook.js",
	"PostMergeHook.js",
	"PrePushHook.js",
	"QueueWorker.js",
	"PrePushWorker.js",
] as const;

function isCompleteRuntimeDist(distDir: string): boolean {
	return REQUIRED_RUNTIME_FILES.every((file) => existsSync(join(distDir, file)));
}
