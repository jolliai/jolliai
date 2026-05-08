/// <reference path="../Globals.d.ts" />

/**
 * Shared CLI utility functions extracted from Cli.ts.
 *
 * Provides version checking, argument validation, project directory resolution,
 * interactive prompt helpers, and other common CLI helpers.
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { getGlobalConfigDir } from "../core/SessionTracker.js";
import { compareSemver, traverseDistPaths } from "../install/DistPathResolver.js";

/** Package version — injected by Vite at build time, falls back to "dev" when running via tsx. */
/* v8 ignore start -- compile-time ternary: always "dev" in test/tsx, always __PKG_VERSION__ in build */
export const VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "dev";
/* v8 ignore stop */

/**
 * Valid characters for branch/keyword arguments (security: prevent shell injection).
 *
 * Used by recall (which expects a branch name or short keyword identifier — not
 * a free-form sentence). Search uses the looser {@link isSafeQuery} instead, so
 * natural-language queries with `?`, `(`, `:`, etc. are accepted.
 *
 * Whitespace is intentionally restricted to ASCII space + tab (not the broader
 * `\s` which includes newlines, vertical tabs, form feeds, etc.). The skill
 * templates wrap user input in double quotes, but a literal newline would still
 * split a quoted bash string into two commands on some shells. Blocking newlines
 * at the validation layer is defense-in-depth.
 */
export const SAFE_ARGUMENT_PATTERN = /^[\p{L}\p{N} \t\-_./]+$/u;

/**
 * Characters that would escape a double-quoted bash argument or otherwise let
 * the user inject another command. Everything else is allowed for search
 * queries — including `?`, `#`, `(`, `)`, `:`, `,`, `'`, `!`, etc. that natural
 * language sentences rely on.
 *
 * Blocked set (matched as two passes by isSafeQuery):
 *   - `\\` — backslash (escape sequences / closes the quoted string)
 *   - `` ` `` — backtick (legacy command substitution)
 *   - `$`  — variable / `$()` expansion inside double quotes
 *   - `"`  — closes the wrapping double quote
 *   - any Unicode control character (`\p{Cc}` — newline, tab, form feed,
 *     NUL, DEL, etc.); a literal newline inside `"..."` can split a quoted
 *     string into multiple commands on some shells.
 */
const QUERY_DENY_LITERALS = /[\\`$"]/;
const QUERY_DENY_CONTROL = /\p{Cc}/u;

/**
 * Returns true when `query` is safe to interpolate inside a double-quoted
 * bash argument (e.g. `"${query}"`). Designed for free-form search queries
 * where natural punctuation must be preserved. Two-pass check: shell-meta
 * literals first, then any Unicode control character.
 */
export function isSafeQuery(query: string): boolean {
	return !QUERY_DENY_LITERALS.test(query) && !QUERY_DENY_CONTROL.test(query);
}

/**
 * Prints a warning to stderr if any registered source's dist-paths/<source>
 * file references a higher version than this CLI binary. This happens when,
 * for example, a VSCode extension with a newer core has been activated and
 * registered a higher version — hooks would run the newer code, but the
 * standalone `jolli` CLI binary on PATH remains at the old version.
 *
 * Reads only `dist-paths/<source>`; the legacy single `dist-path` file is
 * not consulted. Every `install()` migrates and deletes the legacy file, so
 * by the time this CLI runs it's either gone or will be on next
 * `jolli enable`. Never throws — silently returns on any error.
 */
/* v8 ignore start -- VERSION is always "dev" in tests; build-only code path */
export function checkVersionMismatch(): void {
	try {
		if (VERSION === "dev") return;
		const globalDir = getGlobalConfigDir();

		// Find the highest version across all registered sources
		let highestVersion: string | undefined;
		const sources = traverseDistPaths(globalDir);
		for (const entry of sources) {
			if (!entry.available) continue;
			if (!highestVersion || compareSemver(entry.version, highestVersion) > 0) {
				highestVersion = entry.version;
			}
		}

		if (!highestVersion || highestVersion === VERSION) return;
		if (compareSemver(highestVersion, VERSION) <= 0) return;

		process.stderr.write(
			"\nWarning:\n" + "  A newer version of jolli is available. Please upgrade: npm update -g @jolli.ai/cli\n\n",
		);
	} catch {
		// Never block CLI execution
	}
}
/* v8 ignore stop */

/** Parses a CLI option as a positive integer, returning undefined for invalid values. */
export function parsePositiveInt(value: string): number | undefined {
	const n = Number.parseInt(value, 10);
	/* v8 ignore next -- ternary: v8 counts the falsy path as a separate branch */
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolves the project root directory.
 * Auto-detects the git repository root via `git rev-parse --show-toplevel`.
 * Falls back to process.cwd() if not inside a git repo.
 * Result is cached since the git root won't change during a CLI invocation.
 */
let _cachedProjectDir: string | undefined;

export function resolveProjectDir(): string {
	if (_cachedProjectDir !== undefined) return _cachedProjectDir;
	try {
		_cachedProjectDir = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			windowsHide: true,
		}).trim();
	} catch {
		_cachedProjectDir = process.cwd();
	}
	return _cachedProjectDir;
}

/** Formats an ISO date string as "Mon DD" (e.g. "Apr 15"). Falls back to substring on invalid dates. */
export function formatShortDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso.substring(0, 10);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Returns true when stdin is an interactive terminal (not piped/CI). */
export function isInteractive(): boolean {
	return process.stdin.isTTY === true;
}

/**
 * Prompts the user for a visible text input.
 * Returns the trimmed input, or empty string if user presses Enter.
 */
export function promptText(question: string): Promise<string> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}
