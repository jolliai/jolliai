/**
 * EngineManager — manages the shared site engine at ~/.jolli/site-engine/.
 *
 * Instead of running `npm install` per project (~200MB each), all projects
 * share one engine with pre-installed dependencies. Per-project build
 * directories get a symlink: `node_modules → ~/.jolli/site-engine/node_modules`.
 *
 * The engine is automatically created on first use and reinstalled when
 * dependency versions change (detected via hash comparison).
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NEXTRA_DEPENDENCIES, NEXTRA_DEV_DEPENDENCIES } from "./NextraProjectWriter.js";
import type { NpmRunResult } from "./Types.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

/** Returns the shared engine directory path. */
export function getEngineDir(): string {
	return join(homedir(), ".jolli", "site-engine");
}

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Engine metadata ────────────────────────────────────────────────────────

interface EngineMetadata {
	depsHash: string;
	installedAt: string;
}

// ─── computeDepsHash ────────────────────────────────────────────────────────

/**
 * Computes a SHA-256 hash of the dependency version specs.
 * Changes when dependency versions are updated in NextraProjectWriter.
 */
export function computeDepsHash(): string {
	const combined = JSON.stringify({ ...NEXTRA_DEPENDENCIES, ...NEXTRA_DEV_DEPENDENCIES });
	return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

// ─── engineNeedsInstall ─────────────────────────────────────────────────────

/**
 * Returns `true` if the shared engine needs (re)installation:
 *   - engine.json missing
 *   - node_modules missing
 *   - depsHash mismatch (dependency versions changed)
 */
export function engineNeedsInstall(): boolean {
	const engineDir = getEngineDir();
	const engineJsonPath = join(engineDir, "engine.json");

	if (!existsSync(engineJsonPath)) return true;
	if (!existsSync(join(engineDir, "node_modules"))) return true;

	try {
		const meta: EngineMetadata = JSON.parse(readFileSync(engineJsonPath, "utf-8"));
		return meta.depsHash !== computeDepsHash();
	} catch {
		return true;
	}
}

// ─── ensureEngine ───────────────────────────────────────────────────────────

/**
 * Ensures the shared engine is installed and up to date.
 * Creates the engine directory, writes package.json, runs npm install,
 * and writes engine.json with version metadata.
 *
 * Uses a lockfile for parallel safety — if another process is installing,
 * this function waits for it to finish.
 */
export async function ensureEngine(): Promise<NpmRunResult> {
	if (!engineNeedsInstall()) {
		return { success: true, output: "" };
	}

	const engineDir = getEngineDir();
	const engineJsonPath = join(engineDir, "engine.json");
	const lockPath = join(engineDir, ".install-lock");

	// Acquire lock for parallel safety
	const lockAcquired = await acquireLock(engineDir, lockPath);
	if (!lockAcquired) {
		const waited = await waitForLock(lockPath);
		if (waited && !engineNeedsInstall()) {
			return { success: true, output: "" };
		}
	}

	try {
		await mkdir(engineDir, { recursive: true });

		// Write engine package.json
		const pkg = {
			name: "jolli-site-engine",
			version: "0.0.1",
			private: true,
			dependencies: { ...NEXTRA_DEPENDENCIES },
			devDependencies: { ...NEXTRA_DEV_DEPENDENCIES },
		};
		await writeFile(join(engineDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");

		// Run npm install
		const { spawnSync } = await import("node:child_process");
		const npm = process.platform === "win32" ? /* v8 ignore next */ "npm.cmd" : "npm";
		const result = spawnSync(npm, ["install"], {
			cwd: engineDir,
			stdio: "pipe",
		});

		const stdout = result.stdout ? result.stdout.toString() : "";
		const stderr = result.stderr ? result.stderr.toString() : "";
		const output = [stdout, stderr].filter(Boolean).join("\n");

		if (result.status !== 0) {
			return { success: false, output };
		}

		// Write engine.json metadata
		const meta: EngineMetadata = {
			depsHash: computeDepsHash(),
			installedAt: new Date().toISOString(),
		};
		await writeFile(engineJsonPath, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");

		return { success: true, output };
	} finally {
		await releaseLock(lockPath);
	}
}

// ─── linkEngineModules ──────────────────────────────────────────────────────

/**
 * Creates a symlink from `buildDir/node_modules` to the shared engine's
 * `node_modules`. Removes any existing node_modules (real or stale symlink).
 */
export async function linkEngineModules(buildDir: string): Promise<void> {
	const engineDir = getEngineDir();
	const target = join(engineDir, "node_modules");
	const linkPath = join(buildDir, "node_modules");

	// Remove existing node_modules if present
	if (existsSync(linkPath)) {
		const stat = lstatSync(linkPath);
		if (stat.isSymbolicLink()) {
			unlinkSync(linkPath);
		} else {
			await rm(linkPath, { recursive: true, force: true });
		}
	}

	await mkdir(buildDir, { recursive: true });
	await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

// ─── Lock helpers ───────────────────────────────────────────────────────────

async function acquireLock(engineDir: string, lockPath: string): Promise<boolean> {
	try {
		await mkdir(engineDir, { recursive: true });
		await writeFile(lockPath, String(Date.now()), { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

async function releaseLock(lockPath: string): Promise<void> {
	try {
		if (existsSync(lockPath)) unlinkSync(lockPath);
	} catch {
		// Ignore
	}
}

/* v8 ignore start -- lock polling is tested via integration, not unit tests */
async function waitForLock(lockPath: string): Promise<boolean> {
	const pollInterval = 1000;
	const maxWait = LOCK_TIMEOUT_MS;
	let elapsed = 0;

	while (elapsed < maxWait) {
		if (!existsSync(lockPath)) return true;

		try {
			const lockTime = Number.parseInt(await readFile(lockPath, "utf-8"), 10);
			if (Date.now() - lockTime > LOCK_TIMEOUT_MS) {
				await releaseLock(lockPath);
				return true;
			}
		} catch {
			return true;
		}

		await new Promise((resolve) => setTimeout(resolve, pollInterval));
		elapsed += pollInterval;
	}

	await releaseLock(lockPath);
	return false;
}
/* v8 ignore stop */
