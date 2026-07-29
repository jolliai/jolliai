import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import {
	type Candidate,
	isPresent,
	type PresenceOpts,
	type ProbeFn,
	__resetResolverCacheForTest as reset,
	resolveExecutable,
} from "./ExecutableResolver.js";
import type { ResolvedExecutable } from "./Types.js";

export type { ProbeFn };
export const __resetResolverCacheForTest = reset;

const CLAUDE_SPEC = {
	binName: "claude",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32"
			? [
					pathWin32.join(home, ".local", "bin", "claude.exe"),
					pathWin32.join(home, ".claude", "local", "claude.exe"),
				]
			: [pathPosix.join(home, ".local/bin/claude"), pathPosix.join(home, ".claude/local/claude")],
	// MUST stay in sync with ClaudeCodeBackend.buildInvocation flags.
	probeArgs: ["--permission-mode", "dontAsk", "--version"] as const,
} as const;

interface ResolveOpts {
	readonly overridePath?: string;
	readonly probe?: ProbeFn;
	readonly candidates?: () => readonly Candidate[];
	readonly now?: () => number;
	readonly platform?: NodeJS.Platform;
}

/** Resolves the `claude` binary to use. Thin wrapper over {@link resolveExecutable}. */
export function resolveClaudeExecutable(opts: ResolveOpts = {}): ResolvedExecutable {
	return resolveExecutable(CLAUDE_SPEC, opts);
}

/**
 * Presence-only counterpart of {@link resolveClaudeExecutable}: true when a
 * `claude` binary is discoverable, WITHOUT probing that it runs. Kept beside the
 * resolver so the Claude spec stays in one file.
 */
export function isClaudeCodePresent(opts: PresenceOpts = {}): boolean {
	return isPresent(CLAUDE_SPEC, opts);
}
