import { join } from "node:path";
import { type ProbeFn, __resetResolverCacheForTest as reset, resolveExecutable } from "./ExecutableResolver.js";
import type { ResolvedExecutable } from "./Types.js";

export type { ProbeFn };
export const __resetResolverCacheForTest = reset;

const CLAUDE_SPEC = {
	binName: "claude",
	knownPaths: (home: string, platform: NodeJS.Platform) =>
		platform === "win32"
			? [join(home, ".local/bin/claude.exe"), join(home, ".claude/local/claude.exe")]
			: [join(home, ".local/bin/claude"), join(home, ".claude/local/claude")],
	// MUST stay in sync with ClaudeCodeBackend.buildInvocation flags.
	probeArgs: ["--permission-mode", "dontAsk", "--version"] as const,
} as const;

interface ResolveOpts {
	readonly overridePath?: string;
	readonly probe?: ProbeFn;
	readonly candidates?: () => string[];
	readonly now?: () => number;
	readonly platform?: NodeJS.Platform;
}

/** Resolves the `claude` binary to use. Thin wrapper over {@link resolveExecutable}. */
export function resolveClaudeExecutable(opts: ResolveOpts = {}): ResolvedExecutable {
	return resolveExecutable(CLAUDE_SPEC, opts);
}

/**
 * Non-throwing liveness check for the local Claude Code CLI: true when a
 * compatible `claude` is resolvable (present on PATH / known locations AND it
 * accepts the flags we pass), false otherwise. Thin wrapper over
 * {@link resolveClaudeExecutable} so interactive callers (the guided front door,
 * `promptSetup`) can branch on availability without a try/catch.
 *
 * Exported as its own function on purpose: it is the seam tests mock so they
 * never shell out to a real `claude`. Cost is one `resolveClaudeExecutable`
 * call — a successful resolution is cached for {@link RESOLUTION_CACHE_TTL_MS},
 * but a failure is never cached, so a just-installed / just-fixed binary is
 * picked up on the next call.
 */
export function isClaudeCodeUsable(opts: ResolveOpts = {}): boolean {
	try {
		resolveClaudeExecutable(opts);
		return true;
	} catch {
		return false;
	}
}
