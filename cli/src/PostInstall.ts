#!/usr/bin/env node
/**
 * PostInstall — npm postinstall hook for `@jolli.ai/cli`.
 *
 * Runs automatically after `npm install -g @jolli.ai/cli` or `npm update -g @jolli.ai/cli`.
 * Updates two things if the user has already opted in (has run `jolli enable`):
 *   1. `dist-paths/cli` — refreshed to point at THIS install's dist/
 *   2. Dispatch scripts (`resolve-dist-path`, `run-hook`, `run-cli`) — refreshed
 *      so they match the new package's expected behavior (path selection logic,
 *      hook entry names, etc.)
 *
 * Why both? Without (2), `npm update` would leave stale shell scripts written
 * by the old version, while the new package expects the new format. Result:
 * hooks break until the user next runs `jolli enable` or activates a VSCode
 * source. We refresh scripts too, so `npm update` alone keeps the system
 * consistent.
 *
 * Per-source registry model: no candidate collection, no version comparison
 * at install time. Each source unconditionally writes its own per-source file.
 * Runtime selection (highest available) happens in the `resolve-dist-path`
 * shell script; `run-hook` and `run-cli` are thin wrappers that delegate path
 * resolution to it.
 *
 * Constraints:
 *   - No stdout output (don't pollute npm install output)
 *   - Fails silently (never blocks npm install)
 *   - Idempotent (safe to run multiple times)
 *   - Skips project-local installs (`npm install --save-dev`); only global
 *     installs should affect the global registry.
 *   - Skips if user has never enabled (no `dist-paths/` or legacy `dist-path`).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateLegacyDistPath } from "./install/DistPathResolver.js";
import { installDistPath, installHookScripts } from "./install/Installer.js";

async function main(): Promise<void> {
	const globalDir = join(homedir(), ".jolli", "jollimemory");

	// Only act if the user has previously enabled (dist-paths/ exists OR legacy dist-path exists).
	// First-time install via npm shouldn't create the global config dir; user runs
	// `jolli enable` to opt in.
	const hasAnyDistPath = existsSync(join(globalDir, "dist-paths")) || existsSync(join(globalDir, "dist-path"));
	if (!hasAnyDistPath) return;

	// Skip project-local installs (`npm install --save-dev`). Only `npm install -g`
	// should update the global per-source registry. A local install lives under
	// <project>/node_modules/@jolli.ai/cli/dist.
	const callerDistDir = dirname(fileURLToPath(import.meta.url));
	const cwdNodeModules = join(process.cwd(), "node_modules");
	/* v8 ignore start -- only true during npm postinstall inside node_modules; tests always run from source tree */
	if (callerDistDir.startsWith(`${cwdNodeModules}/`) || callerDistDir.startsWith(`${cwdNodeModules}\\`)) return;
	/* v8 ignore stop */

	// Refresh dispatch scripts (resolve-dist-path / run-hook / run-cli) so they
	// match this version's expected behavior. Runs BEFORE the dist-paths write
	// so that even if installDistPath fails, scripts are already up to date for
	// other registered sources.
	await installHookScripts();

	// One-time migration: convert legacy single-file `dist-path` into
	// `dist-paths/<derived-tag>` and delete the legacy file. Without this,
	// `npm update` would leave the old file as a dead artifact (the new
	// resolve-dist-path script only reads dist-paths/*) and any IDE source
	// recorded in the legacy file would be unregistered until the IDE
	// re-enables itself. Idempotent — no-op if already migrated or no
	// legacy file exists.
	await migrateLegacyDistPath();

	// Update this CLI install's per-source entry to point at the new dist/.
	await installDistPath("cli", callerDistDir);
}

main().catch(() => {
	// Silent — never block npm install
});
