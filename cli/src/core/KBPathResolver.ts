/**
 * KBPathResolver — resolves the Knowledge Base root folder for a given repository.
 *
 * Default location: ~/Documents/jolli/{repoName}/
 * Custom path is treated as parent directory, repoName always appended.
 *
 * Collision handling:
 * - Folder exists + matching remoteUrl → reuse
 * - Folder exists + unclaimed stub config (no identity, no real content) → adopt in place
 * - Folder exists + different remoteUrl → add suffix: {repoName}-2, -3, etc.
 *
 * Atomicity contract: `resolveKBPath` always returns a path whose
 * `.jolli/config.json` has the caller's identity written. Callers no longer
 * need to follow up with `initializeKBFolder`. This was a frequent regression
 * source — every new caller (e.g. SyncBootstrap, StaleChildMarkdownCleanup)
 * that forgot the follow-up wrote a phantom `{repo}-2`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createLogger } from "../Logger.js";
import { execFileSyncHidden } from "../util/Subprocess.js";
import type { KBConfig } from "./KBTypes.js";
import { MetadataManager } from "./MetadataManager.js";

const log = createLogger("KBPathResolver");

// Evaluated per call so test mocks of `node:os.homedir` take effect and
// users who change `$HOME` mid-process (rare but possible) see the new
// value. Cheap — `homedir()` reads the env var.
function defaultKbParent(): string {
	return join(homedir(), "Documents", "jolli");
}

/**
 * Validates a user-configured KB parent path (`localFolder`) and returns the
 * effective parent dir. Falls back to the default `~/Documents/jolli/` when
 * the input is missing or unsafe. Centralized so `resolveKBPath`, the legacy
 * migration helper, and `KBRepoDiscoverer` all agree on the parent dir.
 */
export function resolveKbParent(customPath?: string): string {
	if (!customPath) return defaultKbParent();
	if (!isValidLocalFolder(customPath)) {
		log.warn(
			"Invalid customPath '%s': must be absolute and not contain '..'. Falling back to default.",
			customPath,
		);
		return defaultKbParent();
	}
	return customPath;
}

/**
 * Pure predicate used by `resolveKbParent` and `assertValidLocalFolder`.
 * `undefined`/empty is "no override" (treated as valid — defaults will apply);
 * any present value must be absolute and free of `..` segments.
 */
export function isValidLocalFolder(customPath: string | undefined): boolean {
	if (!customPath) return true;
	return isAbsolute(customPath) && !customPath.includes("..");
}

/**
 * Error raised by `assertValidLocalFolder` when the user configured an
 * unusable `localFolder`. Sync paths catch this and surface it to the user
 * via the status bar instead of silently falling back to the default
 * `~/Documents/jolli/` (which leaves Settings showing the user's chosen
 * path while git writes elsewhere — a "content disappeared" hallucination).
 */
export class InvalidLocalFolderError extends Error {
	constructor(public readonly value: string) {
		super(`Invalid Memory Bank folder '${value}': must be an absolute path with no '..' segments.`);
		this.name = "InvalidLocalFolderError";
	}
}

/**
 * Strict variant of {@link resolveKbParent}'s validation. Throws when the
 * user configured a relative or `..`-containing `localFolder`. Use this on
 * write paths (sync engine, git init) where silently using the fallback
 * would split state across two folders.
 */
export function assertValidLocalFolder(customPath: string | undefined): void {
	if (!isValidLocalFolder(customPath)) {
		throw new InvalidLocalFolderError(customPath as string);
	}
}

/**
 * Resolves the KB root path for a repository AND claims it by writing identity
 * to `.jolli/config.json`. The returned path is guaranteed to have a
 * fully-populated config (`remoteUrl` + `repoName`) on return.
 */
export function resolveKBPath(repoName: string, remoteUrl: string | null, customPath?: string): string {
	const parent = resolveKbParent(customPath);
	const basePath = join(parent, repoName);

	// Case A: basePath is unused → claim it fresh.
	if (!existsSync(basePath)) {
		writeKBIdentity(basePath, repoName, remoteUrl);
		return basePath;
	}

	const existingConfig = readKBConfig(basePath);

	// Case B: basePath already belongs to us → reuse.
	if (existingConfig && isSameRepo(existingConfig, remoteUrl, repoName)) {
		return basePath;
	}

	// Case C: basePath holds an unclaimed stub (schema-default config left by
	// `MetadataManager.ensure()` with no real content alongside it). Adopt in
	// place rather than spawning a phantom `-N`. This is what closes the
	// recurring "config.json missing repoUrl + repoName" regression.
	if (existingConfig && isUnclaimedStub(basePath, existingConfig)) {
		writeKBIdentity(basePath, repoName, remoteUrl);
		return basePath;
	}

	// Case D: basePath truly belongs to a different repo → allocate `-N`.
	return findAvailablePathAndClaim(parent, repoName, remoteUrl);
}

/**
 * Pure-read sibling of `resolveKBPath` — returns the path that `resolveKBPath`
 * WOULD claim, without creating directories or writing config. Use this when
 * you need to look up a repo's KB folder without potentially claiming a fresh
 * one — most notably the Rebuild / Migrate-to-Memory-Bank flow, which must
 * be able to detect "no old folder exists yet" without inadvertently
 * creating one.
 */
export function peekKBPath(repoName: string, remoteUrl: string | null, customPath?: string): string {
	const parent = resolveKbParent(customPath);
	const basePath = join(parent, repoName);

	if (!existsSync(basePath)) return basePath;

	const existingConfig = readKBConfig(basePath);
	if (existingConfig && isSameRepo(existingConfig, remoteUrl, repoName)) return basePath;
	if (existingConfig && isUnclaimedStub(basePath, existingConfig)) return basePath;

	for (let suffix = 2; suffix <= 99; suffix++) {
		const candidate = join(parent, `${repoName}-${suffix}`);
		if (!existsSync(candidate)) return candidate;
		const config = readKBConfig(candidate);
		if (config && isSameRepo(config, remoteUrl, repoName)) return candidate;
		if (config && isUnclaimedStub(candidate, config)) return candidate;
	}
	return join(parent, `${repoName}-${Date.now()}`);
}

/**
 * Returns the next unused `-N`-suffixed KB path, even when the base path
 * belongs to the same repo. Used by Rebuild Knowledge Base, which deliberately
 * avoids reusing the current KB folder.
 */
export function findFreshKBPath(repoName: string, customPath?: string): string {
	const parent = resolveKbParent(customPath);
	const basePath = join(parent, repoName);
	if (!existsSync(basePath)) return basePath;
	for (let suffix = 2; suffix <= 99; suffix++) {
		const candidate = join(parent, `${repoName}-${suffix}`);
		if (!existsSync(candidate)) return candidate;
	}
	return join(parent, `${repoName}-${Date.now()}`);
}

/**
 * Writes repo identity (`remoteUrl` + `repoName`) into `<kbRoot>/.jolli/config.json`,
 * creating the directory and seeding default metadata files if missing.
 *
 * In the standard flow this is now called internally by `resolveKBPath`,
 * which is the only entry point most callers need. This export remains for
 * the **Migrate-to-Memory-Bank** flow, where the caller pairs it with
 * `findFreshKBPath` to allocate a fresh `-N` path it then claims, and for
 * the Repoint flow that re-tags an existing folder's identity.
 */
export function initializeKBFolder(kbRoot: string, repoName: string, remoteUrl: string | null): void {
	writeKBIdentity(kbRoot, repoName, remoteUrl);
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
		// `mainRepoDir` is the parent of `.git` — i.e. the main repo's
		// working tree. Skip the filesystem-root / cwd-marker cases so a
		// `basename` of `/` or `.` doesn't slip through.
		if (mainRepoDir && mainRepoDir !== "/" && mainRepoDir !== ".") {
			return basename(mainRepoDir);
		}
	}

	return basename(projectPath) || "unknown";
}

function tryGitCommand(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSyncHidden("git", args, {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
			// Capture git's stderr instead of inheriting the parent process's
			// stderr (Node's default for execFileSync). Without this, running
			// `jolli` in a non-git directory leaks a "fatal: not a git
			// repository …" line to the user's terminal before any of jolli's
			// own output — even though the JS catches the non-zero exit and
			// returns null cleanly.
			stdio: ["ignore", "pipe", "pipe"],
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
	return foldGitTransportToHttps(url)
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}

/**
 * Folds the SSH transport forms of a git remote URL into the https form so
 * all transports of the same repo compare equal:
 *
 *   - `ssh://[user@]host[:port]/path` (and `git+ssh://`) → `https://host[:port]/path`.
 *     The scheme's DEFAULT port (22) is dropped — it carries no identity —
 *     but a non-default port is preserved: two self-hosted forges on
 *     `host:2222` and `host:2223` are distinct repos and must not collapse.
 *     Same rule as `vscode/src/util/GitRemoteUtils.ts` (the server binding
 *     key), so the two canonicalizers agree on self-hosted SSH remotes.
 *   - `git://host[:port]/path` → `https://host[:port]/path` (default 9418
 *     dropped, same rule).
 *   - SCP form `user@host:path` → `https://host/path`. The `user@` part is
 *     REQUIRED on purpose: a bare `host:path` was never folded by earlier
 *     releases either, and requiring the `@` keeps non-URL strings that
 *     happen to contain a `:` (a basename can legally contain one on Linux,
 *     `C:/repos/foo` is a Windows drive path) from being mangled into fake
 *     https URLs. Hosted-git SSH remotes universally use `git@`, so the
 *     constraint costs nothing in practice. The absolute-vs-relative
 *     distinction of the SCP path is preserved (`host:/srv/repo` →
 *     `…host//srv/repo` vs `host:srv/repo` → `…host/srv/repo`).
 *
 * Anything else (https, file paths, bare names) passes through unchanged.
 *
 * Shared by the local folder-reuse predicate (`isSameRepo` above) and the
 * vault identity normalizer (`sync/RepoIdentity.ts`) so "is this the same
 * repo?" gets one answer on both sides — they diverged once and the same
 * repo cloned via SSH on one device and https on another produced duplicate
 * `repos.json` rows plus a split local folder (`<repo>` / `<repo>-2`).
 *
 * The IntelliJ plugin carries a Kotlin port (`KBPathResolver.kt
 * foldGitTransportToHttps`) that must stay in lockstep — both IDEs resolve
 * folders in the same Memory Bank, and divergent folding sends them to
 * different folders for the same repo.
 */
/**
 * Hosts whose owner/repo path is case-insensitive on the wire — clones typed
 * with different casing all resolve to the same repo, so canonicalizers must
 * lower-case the path for these hosts (and ONLY these: self-hosted forges may
 * be case-sensitive). Single shared source of truth for every comparer:
 * `sync/RepoIdentity.ts` (vault identity), `vscode/src/util/GitRemoteUtils.ts`
 * (server binding key — imports this set), and the whole-string-lowercasing
 * comparers (`normalizeRemoteUrl` above, `KBRepoDiscoverer`) which fold case
 * unconditionally and need no per-host check. Add new entries only after
 * confirming the host actually treats the path as case-insensitive (assuming
 * wrong here merges distinct repos).
 */
export const CASE_INSENSITIVE_PATH_HOSTS: ReadonlySet<string> = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

export function foldGitTransportToHttps(url: string): string {
	const ssh = url.match(/^(?:git\+)?ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/i);
	if (ssh) return `https://${ssh[1]}${nonDefaultPortSegment(ssh[2], "22")}/${ssh[3]}`;
	const git = url.match(/^git:\/\/([^/:]+)(?::(\d+))?\/(.+)$/i);
	if (git) return `https://${git[1]}${nonDefaultPortSegment(git[2], "9418")}/${git[3]}`;
	const scp = url.match(/^[^@/:]+@([^/:]+):(.+)$/);
	if (scp) return `https://${scp[1]}/${scp[2]}`;
	return url;
}

/** `:<port>` when present and not the scheme's default, else empty. */
function nonDefaultPortSegment(port: string | undefined, schemeDefault: string): string {
	if (port === undefined || port === schemeDefault) return "";
	return `:${port}`;
}

function findAvailablePathAndClaim(parent: string, repoName: string, remoteUrl: string | null): string {
	for (let suffix = 2; suffix <= 99; suffix++) {
		const candidate = join(parent, `${repoName}-${suffix}`);
		if (!existsSync(candidate)) {
			writeKBIdentity(candidate, repoName, remoteUrl);
			return candidate;
		}
		const config = readKBConfig(candidate);
		if (config && isSameRepo(config, remoteUrl, repoName)) return candidate;
		if (config && isUnclaimedStub(candidate, config)) {
			writeKBIdentity(candidate, repoName, remoteUrl);
			return candidate;
		}
	}
	const fallback = join(parent, `${repoName}-${Date.now()}`);
	writeKBIdentity(fallback, repoName, remoteUrl);
	return fallback;
}

/**
 * Atomically writes identity into `<kbRoot>/.jolli/config.json`. The schema
 * default files (`manifest.json`, `branches.json`) are seeded by
 * `MetadataManager.ensure()`; this then overwrites the schema-default config
 * with one that carries `remoteUrl` and `repoName`.
 */
function writeKBIdentity(kbRoot: string, repoName: string, remoteUrl: string | null): void {
	const manager = new MetadataManager(join(kbRoot, ".jolli"));
	manager.ensure();
	const config = manager.readConfig();
	manager.saveConfig({ ...config, remoteUrl: remoteUrl ?? undefined, repoName });
}

/**
 * Detects an unclaimed schema-default stub: config has neither `remoteUrl`
 * nor `repoName`. The folder is adopted as-is regardless of whether
 * `summaries/`, `index.json`, etc. contain data — that is exactly the
 * regression's signature (real KB content sitting in a folder whose
 * identity was never written), and refusing to adopt would leave the user's
 * accumulated data orphaned and re-spawn the death spiral on every launch.
 *
 * Safety: `basePath` is always `<parent>/<repoName>`, so a stub folder can
 * only be reached by a caller whose `repoName` already matches the folder
 * name. The "stub content belongs to a different repo" scenario requires
 * two distinct GitHub repos to share the same basename (e.g. forks). In
 * that rare case pre-fix behaviour already produced orphaned `-N` data, so
 * adoption is no worse — and it eliminates the death spiral.
 */
function isUnclaimedStub(_kbRoot: string, config: KBConfig): boolean {
	return config.remoteUrl == null && config.repoName == null;
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
