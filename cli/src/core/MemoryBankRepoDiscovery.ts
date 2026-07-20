/**
 * MemoryBankRepoDiscovery — enumerates compile targets under the Memory Bank
 * root. Source of truth is the filesystem (a child dir with `.jolli/index.json`
 * has compilable data); `repos.json` is consulted only to label a target with
 * its repoIdentity. `repos.json` is NOT the discovery source — it is the sync
 * engine's map and is incomplete for local-only repos.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../Logger.js";

const log = createLogger("MemoryBankRepoDiscovery");

export interface RepoTarget {
	readonly folder: string;
	readonly kbRoot: string;
	readonly repoIdentity?: string;
}

/** Minimal glob: exact match, or `*` wildcards. */
function matchesAny(name: string, patterns: ReadonlyArray<string>): boolean {
	return patterns.some((p) => {
		if (!p.includes("*")) return p === name;
		const re = new RegExp(
			`^${p
				.split("*")
				.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*")}$`,
		);
		return re.test(name);
	});
}

/**
 * Whether `pattern` is a well-formed folder-exclude glob. Same dialect
 * `discoverRepos` matches against (exact string, or `*` wildcards — no `?`,
 * `**`, or bracket classes). UI surfaces (desktop Settings, VS Code
 * preferences) call this to validate user input before persisting a stray
 * value into `compileExcludeFolders`. Never throws; the boolean + optional
 * `error` are for inline form-field messages.
 */
export function validateExcludeGlob(pattern: string): { readonly valid: boolean; readonly error?: string } {
	if (typeof pattern !== "string") return { valid: false, error: "pattern must be a string" };
	const trimmed = pattern.trim();
	if (trimmed.length === 0) return { valid: false, error: "pattern must not be empty" };
	// Reject path separators — the matcher only sees the leaf folder name, so
	// `foo/bar` or `foo\bar` would never match anything and would silently
	// mislead the user.
	if (trimmed.includes("/") || trimmed.includes("\\")) {
		return { valid: false, error: "path separators are not allowed — match on the folder name only" };
	}
	// Reject glob features we don't implement so the user isn't surprised by
	// a `?` or `**` pattern that silently degrades to a literal.
	if (trimmed.includes("?") || trimmed.includes("[") || trimmed.includes("]") || trimmed.includes("**")) {
		return { valid: false, error: "only exact names and `*` wildcards are supported" };
	}
	return { valid: true };
}

function readRepoIdentities(localFolder: string): Map<string, string> {
	const out = new Map<string, string>();
	try {
		const json = JSON.parse(readFileSync(join(localFolder, ".jolli", "repos.json"), "utf-8")) as {
			mappings?: Array<{ repoIdentity: string; folder: string }>;
		};
		for (const m of json.mappings ?? []) out.set(m.folder, m.repoIdentity);
	} catch {
		// no repos.json — labels stay undefined
	}
	return out;
}

/**
 * Returns every compilable repo folder under `localFolder`, excluding folders
 * whose name matches `excludeFolders`. Deterministic order (folder name asc).
 */
export async function discoverRepos(localFolder: string, excludeFolders: ReadonlyArray<string>): Promise<RepoTarget[]> {
	if (!existsSync(localFolder)) return [];
	const identities = readRepoIdentities(localFolder);
	const targets: RepoTarget[] = [];
	for (const entry of readdirSync(localFolder, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (matchesAny(entry.name, excludeFolders)) continue;
		const kbRoot = join(localFolder, entry.name);
		if (!existsSync(join(kbRoot, ".jolli", "index.json"))) continue;
		targets.push({ folder: entry.name, kbRoot, repoIdentity: identities.get(entry.name) });
	}
	targets.sort((a, b) => a.folder.localeCompare(b.folder));
	log.info("Discovered %d repo target(s) under %s", targets.length, localFolder);
	return targets;
}
