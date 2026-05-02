/**
 * KBPathResolver — resolves the Knowledge Base root folder for a given repository.
 *
 * Default location: ~/Documents/jolli/{repoName}/
 * Custom path is treated as parent directory, repoName always appended.
 *
 * Collision handling:
 * - Folder exists + matching remoteUrl → reuse
 * - Folder exists + different remoteUrl → add suffix: {repoName}-2, -3, etc.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createLogger } from "../Logger.js";
import type { KBConfig } from "./KBTypes.js";
import { MetadataManager } from "./MetadataManager.js";

const log = createLogger("KBPathResolver");

const KB_PARENT = join(homedir(), "Documents", "jolli");

/**
 * Validates a user-configured KB parent path (`localFolder`) and returns the
 * effective parent dir. Falls back to the default `~/Documents/jolli/` when
 * the input is missing or unsafe. Centralized so `resolveKBPath` and the
 * legacy migration helper agree on the parent dir.
 */
function resolveParentDir(customPath?: string): string {
	if (!customPath) return KB_PARENT;
	if (!isAbsolute(customPath) || customPath.includes("..")) {
		log.warn(
			"Invalid customPath '%s': must be absolute and not contain '..'. Falling back to default.",
			customPath,
		);
		return KB_PARENT;
	}
	return customPath;
}

/**
 * Resolves the KB root path for a repository.
 */
export function resolveKBPath(repoName: string, remoteUrl: string | null, customPath?: string): string {
	const parent = resolveParentDir(customPath);
	const basePath = join(parent, repoName);

	if (!existsSync(basePath)) return basePath;

	const existingConfig = readKBConfig(basePath);
	if (existingConfig && isSameRepo(existingConfig, remoteUrl, repoName)) {
		return basePath;
	}

	return findAvailablePath(parent, repoName, remoteUrl);
}

/**
 * Returns the next unused `-N`-suffixed KB path, even when the base path
 * belongs to the same repo. Used by Rebuild Knowledge Base, which deliberately
 * avoids reusing the current KB folder.
 */
export function findFreshKBPath(repoName: string, customPath?: string): string {
	const parent = resolveParentDir(customPath);
	const basePath = join(parent, repoName);
	if (!existsSync(basePath)) return basePath;
	for (let suffix = 2; suffix <= 99; suffix++) {
		const candidate = join(parent, `${repoName}-${suffix}`);
		if (!existsSync(candidate)) return candidate;
	}
	return join(parent, `${repoName}-${Date.now()}`);
}

/**
 * Initializes the KB folder by writing repo identity to .jolli/config.json.
 */
export function initializeKBFolder(kbRoot: string, repoName: string, remoteUrl: string | null): void {
	const manager = new MetadataManager(join(kbRoot, ".jolli"));
	manager.ensure();

	const config = manager.readConfig();
	manager.saveConfig({ ...config, remoteUrl: remoteUrl ?? undefined, repoName });
	log.info("KB folder initialized: %s (remote=%s)", kbRoot, remoteUrl ?? "none");
}

/**
 * Extracts the repository name for KB-folder identification.
 *
 * Three-layer fallback so a git worktree resolves to its main repo's name
 * (avoiding the bug where `<localFolder>/<worktree-dirname>/` and
 * `<localFolder>/<mainrepo-dirname>/` end up holding parallel KBs):
 *
 *   1. `git config --get remote.origin.url` basename — the GitHub canonical
 *      name. Survives renames, applies identically to main repo and any
 *      worktree of it.
 *   2. `git rev-parse --git-common-dir` parent basename — when there's no
 *      remote (local-only repo), follows the worktree pointer back to the
 *      main repo's `.git` and uses the main repo dir name.
 *   3. `basename(projectPath)` — last resort for non-git directories.
 *
 * Layer 3 is the only path that can produce a worktree dirname, and only
 * when the directory isn't a git repo at all (in which case there's no
 * better identity).
 */
export function extractRepoName(projectPath: string): string {
	const url = tryGitCommand(projectPath, ["config", "--get", "remote.origin.url"]);
	if (url) {
		const m = url.match(/\/([^/]+?)(?:\.git)?$/);
		if (m?.[1]) return m[1];
	}

	const commonDir = tryGitCommand(projectPath, ["rev-parse", "--git-common-dir"]);
	if (commonDir) {
		const abs = isAbsolute(commonDir) ? commonDir : join(projectPath, commonDir);
		const mainRepoDir = dirname(abs);
		if (mainRepoDir && mainRepoDir !== "/" && mainRepoDir !== ".") {
			const name = basename(mainRepoDir);
			if (name) return name;
		}
	}

	return basename(projectPath) || "unknown";
}

function tryGitCommand(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		}).trim();
		return out || null;
	} catch {
		return null;
	}
}

/** Gets the remote origin URL for a repository, or null if not configured. */
export function getRemoteUrl(projectPath: string): string | null {
	return tryGitCommand(projectPath, ["remote", "get-url", "origin"]);
}

// ── Internal ───────────────────────────────────────────────────────────

function isSameRepo(config: KBConfig, remoteUrl: string | null, repoName: string): boolean {
	if (config.remoteUrl && remoteUrl) {
		return normalizeRemoteUrl(config.remoteUrl) === normalizeRemoteUrl(remoteUrl);
	}
	if (!config.remoteUrl && !remoteUrl) {
		return config.repoName == null || config.repoName === repoName;
	}
	return false;
}

function normalizeRemoteUrl(url: string): string {
	return url
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}

function findAvailablePath(parent: string, repoName: string, remoteUrl: string | null): string {
	for (let suffix = 2; suffix <= 99; suffix++) {
		const candidate = join(parent, `${repoName}-${suffix}`);
		if (!existsSync(candidate)) return candidate;
		const config = readKBConfig(candidate);
		if (config && isSameRepo(config, remoteUrl, repoName)) return candidate;
	}
	return join(parent, `${repoName}-${Date.now()}`);
}

function readKBConfig(kbRoot: string): KBConfig | null {
	const configPath = join(kbRoot, ".jolli", "config.json");
	if (!existsSync(configPath)) return null;
	try {
		return JSON.parse(readFileSync(configPath, "utf-8")) as KBConfig;
	} catch {
		return null;
	}
}
