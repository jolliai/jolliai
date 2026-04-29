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
import { basename, isAbsolute, join } from "node:path";
import { createLogger } from "../Logger.js";
import type { KBConfig } from "./KBTypes.js";
import { MetadataManager } from "./MetadataManager.js";

const log = createLogger("KBPathResolver");

const KB_PARENT = join(homedir(), "Documents", "jolli");

/**
 * Resolves the KB root path for a repository.
 */
export function resolveKBPath(repoName: string, remoteUrl: string | null, customPath?: string): string {
	let parent = KB_PARENT;
	if (customPath) {
		if (!isAbsolute(customPath) || customPath.includes("..")) {
			log.warn(
				"Invalid customPath '%s': must be absolute and not contain '..'. Falling back to default.",
				customPath,
			);
		} else {
			parent = customPath;
		}
	}
	const basePath = join(parent, repoName);

	if (!existsSync(basePath)) return basePath;

	const existingConfig = readKBConfig(basePath);
	if (existingConfig && isSameRepo(existingConfig, remoteUrl, repoName)) {
		return basePath;
	}

	return findAvailablePath(parent, repoName, remoteUrl);
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

/** Extracts the repository name from a project path. */
export function extractRepoName(projectPath: string): string {
	return basename(projectPath) || "unknown";
}

/** Gets the remote origin URL for a repository, or null if not configured. */
export function getRemoteUrl(projectPath: string): string | null {
	try {
		const output = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd: projectPath,
			encoding: "utf-8",
			timeout: 5000,
		}).trim();
		return output || null;
	} catch {
		return null;
	}
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
