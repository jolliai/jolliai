/**
 * KBRepoDiscoverer — enumerates every Knowledge Base repo under the user's
 * Memory Bank parent folder (`localFolder`).
 *
 * A "KB repo" is any direct child directory of `<kbParent>` that contains a
 * `.jolli/config.json` — the same shape IntelliJ uses (see
 * `intellij/src/main/kotlin/ai/jolli/jollimemory/core/KBRepoDiscoverer.kt`).
 * Directories without `.jolli/config.json` are ignored so that users can drop
 * unrelated content into `<kbParent>` without it being mis-classified as a
 * KB repo.
 *
 * The result is sorted so the current project's repo is first; remaining
 * repos follow alphabetically. Mirrors IntelliJ's ordering exactly so the
 * VS Code and IntelliJ Memory Bank views agree on layout.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../Logger.js";
import { resolveKbParent } from "./KBPathResolver.js";
import type { KBConfig } from "./KBTypes.js";

const log = createLogger("KBRepoDiscoverer");

export interface DiscoveredRepo {
	/** Absolute path to the repo's KB root (`<kbParent>/<dirname>`). */
	readonly kbRoot: string;
	/** Display name — `config.repoName` if present, else the directory basename. */
	readonly repoName: string;
	/** Directory basename under `<kbParent>` (may carry `-2`, `-3`, … suffixes). */
	readonly dirName: string;
	readonly remoteUrl: string | null;
	readonly isCurrentRepo: boolean;
}

/**
 * Scans `<kbParent>` for valid KB folders.
 *
 * @param currentRepoName  — basename of the current project's repo (used as a
 *   fallback identity when `currentRemoteUrl` is null on either side).
 * @param currentRemoteUrl — remote.origin.url of the current project; the
 *   preferred identity for matching, since it survives folder renames.
 * @param customParent     — overrides the default `~/Documents/jolli/`.
 *   Validated by {@link resolveKbParent}; invalid values fall back to default.
 */
export function discoverRepos(
	currentRepoName: string | null,
	currentRemoteUrl: string | null,
	customParent?: string,
): DiscoveredRepo[] {
	const parent = resolveKbParent(customParent);
	let dirents: string[];
	try {
		dirents = readdirSync(parent);
	} catch (err) {
		// Missing/unreadable parent is normal — fresh install, or the user has
		// reconfigured `localFolder` to a path that hasn't been created yet.
		// Return empty so the caller can render "no memories yet" instead of
		// erroring.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
		log.warn("Failed to scan KB parent '%s': %s", parent, (err as Error).message);
		return [];
	}

	const repos: DiscoveredRepo[] = [];
	for (const name of dirents) {
		const kbRoot = join(parent, name);
		try {
			if (!statSync(kbRoot).isDirectory()) continue;
		} catch {
			continue;
		}
		const config = readKbConfig(kbRoot);
		if (!config) continue;
		const repoName = config.repoName ?? name;
		const remoteUrl = config.remoteUrl ?? null;
		repos.push({
			kbRoot,
			repoName,
			dirName: name,
			remoteUrl,
			isCurrentRepo: isCurrentRepo(repoName, remoteUrl, currentRepoName, currentRemoteUrl),
		});
	}

	repos.sort((a, b) => {
		if (a.isCurrentRepo !== b.isCurrentRepo) return a.isCurrentRepo ? -1 : 1;
		return a.repoName.localeCompare(b.repoName);
	});
	return repos;
}

function readKbConfig(kbRoot: string): KBConfig | null {
	try {
		const raw = readFileSync(join(kbRoot, ".jolli", "config.json"), "utf-8");
		return JSON.parse(raw) as KBConfig;
	} catch {
		return null;
	}
}

function isCurrentRepo(
	repoName: string,
	remoteUrl: string | null,
	currentRepoName: string | null,
	currentRemoteUrl: string | null,
): boolean {
	if (currentRemoteUrl && remoteUrl) {
		return normalizeUrl(remoteUrl) === normalizeUrl(currentRemoteUrl);
	}
	return currentRepoName != null && repoName === currentRepoName;
}

function normalizeUrl(url: string): string {
	return url
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}
