/**
 * `resolveProjectDir` — the git-worktree root every command anchors to.
 *
 * Split out of [`commands/CliUtils.ts`](../commands/CliUtils.ts) as a LEAF
 * module. Nothing about the function changed; what changed is what
 * importing it costs. `CliUtils` statically imports `PluginLoader` and
 * `SummaryStore`, so asking it for a `git rev-parse` pulled in plugin discovery,
 * the summary store and the whole storage stack — irrelevant to the answer, and
 * the dominant cost for a process whose entire job is to forward bytes.
 *
 * The MCP proxy is that process: it needs the worktree root and essentially
 * nothing else, and it is spawned once per AI session, so its resident set is
 * multiplied by every open session on the machine.
 *
 * `CliUtils` re-exports this, so the ~40 existing call sites are unaffected and
 * there is still exactly one cache.
 */

import { execFileSyncHidden } from "../util/Subprocess.js";

/** What {@link resolveProjectDirInfo} answers: the directory, plus how it was reached. */
export interface ProjectDirInfo {
	readonly dir: string;
	/** True when git named this directory; false when it is the `process.cwd()` fallback. */
	readonly fromGit: boolean;
}

/**
 * Cached because the git root cannot change during one CLI invocation, and
 * `resolveProjectDir` is called from many places on the startup path — without
 * the cache each would spawn its own `git` subprocess.
 */
let cachedProjectDir: ProjectDirInfo | undefined;

/**
 * Resolves the project root, and reports whether git actually named it.
 *
 * The `fromGit` bit exists because the two outcomes are indistinguishable once
 * collapsed to a string, and at least one caller must tell them apart. The MCP
 * proxy keys a shared per-worktree daemon on this directory; keyed on a
 * fallback cwd it would serve a directory that is not a repository at all —
 * measured on a real machine as seven VS Code sessions collapsing onto one
 * daemon rooted at `/`, each answering `recall` / `search` for nothing.
 *
 * Most callers only want a directory and should keep using
 * {@link resolveProjectDir}, which is this function's `dir`.
 */
export function resolveProjectDirInfo(): ProjectDirInfo {
	if (cachedProjectDir !== undefined) return cachedProjectDir;
	try {
		const dir = execFileSyncHidden("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			// Capture git's stderr so a non-git cwd doesn't leak
			// "fatal: not a git repository …" to the user's terminal before
			// any of jolli's own output. The non-zero exit is already handled
			// below — we just don't need git's complaint to escape with it.
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		cachedProjectDir = { dir, fromGit: true };
	} catch {
		cachedProjectDir = { dir: process.cwd(), fromGit: false };
	}
	return cachedProjectDir;
}

/**
 * Resolves the project root directory.
 * Auto-detects the git repository root via `git rev-parse --show-toplevel`.
 * Falls back to `process.cwd()` if not inside a git repo.
 */
export function resolveProjectDir(): string {
	return resolveProjectDirInfo().dir;
}

/** Test-only: clears the cached root so a suite can move between scratch repos. */
export function __resetProjectDirCache(): void {
	cachedProjectDir = undefined;
}
