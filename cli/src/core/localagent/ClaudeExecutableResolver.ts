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
	// DELIBERATELY NOT the full buildInvocation flag vector — the isolation flags
	// (`--strict-mcp-config`, `--disable-slash-commands`, `--setting-sources`)
	// are omitted on purpose, and adding them back is a regression.
	//
	// The probe canNOT validate them: `claude` pre-scans argv for `--version`
	// (and `--help`) BEFORE validating options, so an unrecognised flag here does
	// not fail the probe — measured on 2.1.220, `claude --permission-mode dontAsk
	// --bogus-flag --version` exits 0. Nor can a subcommand stand in: `claude
	// doctor --strict-mcp-config` rejects the top-level run flags outright.
	//
	// So listing them here buys nothing, and it is not free. That pre-scan was
	// only ever measured on a claude NEW enough to accept all three — precisely
	// not the population at risk. An older `claude` that validates options the
	// ordinary commander way would exit non-zero on the probe, and a failed probe
	// does not degrade: the candidate is discarded and discovery reports "no
	// compatible CLI found", with `LlmClient`'s flag degradation (which lives
	// downstream of discovery) never getting a chance to run. That is the exact
	// failure this whole mechanism exists to prevent, reintroduced one layer up.
	//
	// A version mismatch belongs at RUN time, where it is recoverable: `claude -p
	// … --bogus-flag` exits non-zero with `error: unknown option '…'` on stderr
	// and empty stdout, and `LlmClient` drops that one flag, retries, and records
	// it per tool+version (see `OptionalFlags.ts`). Keep this list to the flags
	// that are load-bearing for a run, not the ones that merely optimize it.
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
