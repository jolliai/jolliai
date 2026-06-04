/// <reference path="../Globals.d.ts" />

/**
 * Shared CLI utility functions extracted from Cli.ts.
 *
 * Provides version checking, argument validation, project directory resolution,
 * interactive prompt helpers, and other common CLI helpers.
 */

import { createInterface } from "node:readline";
import type { AmbiguousHashError } from "../core/SummaryStore.js";
import {
	CLI_PACKAGE_NAME,
	claimRefreshSpawn,
	computeCliUpdateNotice,
	computePluginUpdateNotices,
	isCacheStale,
	REFRESH_COMMAND,
	readUpdateCache,
	spawnDetachedRefresh,
} from "../core/UpdateCheck.js";
import { inspectPlugins, type PluginDiagnostic } from "../PluginLoader.js";
import { execFileSyncHidden } from "../util/Subprocess.js";

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
 * Prints upgrade hints to stderr when a newer version of the CLI — or of an
 * installed plugin — is published on npm. "Newer" is decided solely from the
 * cached registry `latest` in `update-check.json`: the cache is read-only here,
 * and when it is stale a *detached* refresh process is spawned (it re-invokes
 * this CLI with {@link REFRESH_COMMAND}) and the current invocation continues
 * without waiting.
 *
 * Local `dist-paths/<surface>` versions are intentionally NOT consulted — the
 * CLI and the IDE extensions are independent release lines, so another surface's
 * version is not a comparable `@jolli.ai/cli` version (see
 * {@link computeCliUpdateNotice}).
 *
 * The locally-installed versions (CLI = {@link VERSION}, plugins = their
 * `package.json`) are always read live, never cached. Never throws — every
 * failure path degrades to "no hint" so the version check cannot block the CLI.
 *
 * `pluginDiagnostics` is the snapshot {@link loadPlugins} already produced this
 * invocation; passing it in avoids a second plugin-discovery walk on the
 * startup hot path. When omitted (direct callers, tests) it falls back to a
 * fresh {@link inspectPlugins} scan.
 *
 * Skipped entirely in `dev` (tsx) builds and inside the detached refresh process
 * itself (the {@link REFRESH_COMMAND} re-entrancy guard) to avoid a spawn loop.
 */
/* v8 ignore start -- VERSION is always "dev" in tests; the freshness logic is unit-tested in UpdateCheck.test.ts */
export async function checkVersionMismatch(opts?: { pluginDiagnostics?: PluginDiagnostic[] }): Promise<void> {
	try {
		if (VERSION === "dev") return;
		// Re-entrancy guard: the detached refresh re-invokes this CLI with
		// REFRESH_COMMAND; it must not trigger yet another refresh spawn.
		if (process.argv.includes(REFRESH_COMMAND)) return;

		const diagnostics = opts?.pluginDiagnostics ?? (await inspectPlugins(VERSION));
		const installedPlugins = diagnostics.filter((p) => p.state !== "absent");
		const cache = await readUpdateCache();

		// Refresh in the background when the cache is stale and no recent refresh
		// is still within the debounce window; the current command continues
		// immediately and uses whatever the cache already holds.
		if (isCacheStale(cache, Date.now()) && (await claimRefreshSpawn())) {
			spawnDetachedRefresh([CLI_PACKAGE_NAME, ...installedPlugins.map((p) => p.packageName)]);
		}

		const notices: string[] = [];
		const cliNotice = computeCliUpdateNotice({
			currentVersion: VERSION,
			registryLatest: cache?.packages[CLI_PACKAGE_NAME]?.latest,
		});
		if (cliNotice) notices.push(cliNotice);
		notices.push(...computePluginUpdateNotices(installedPlugins, cache));

		if (notices.length > 0) {
			process.stderr.write(`\nWarning:\n${notices.map((n) => `  ${n}`).join("\n")}\n\n`);
		}
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
		_cachedProjectDir = execFileSyncHidden("git", ["rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			// Capture git's stderr so a non-git cwd doesn't leak
			// "fatal: not a git repository …" to the user's terminal before
			// any of jolli's own output. The non-zero exit is already handled
			// below — we just don't need git's complaint to escape with it.
			stdio: ["ignore", "pipe", "pipe"],
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
 * Hard cap on `--arg-stdin` payload size. The flag only ever carries a branch
 * name or short keyword query (skill templates pipe a single line via here-doc).
 * 64 KiB is many orders of magnitude above any legitimate input but small
 * enough that a compromised or buggy upstream cannot OOM the CLI by streaming
 * gigabytes into stdin.
 */
export const STDIN_MAX_BYTES = 64 * 1024;

/**
 * Reads the entire contents of `process.stdin` to a string, trims one trailing
 * newline (LF or CRLF) if present, and returns the result.
 *
 * Used by `recall --arg-stdin` / `search --arg-stdin` to receive user-supplied
 * argument text without it ever passing through the shell's argv parser. Skill
 * templates pipe the user's input via a here-doc, so the argument cannot trigger
 * `$()` / backtick expansion — that's the whole reason this exists.
 *
 * Behavior:
 *   - Rejects immediately when stdin is an interactive TTY. The flag is only
 *     meaningful with piped input; calling it interactively would otherwise
 *     hang forever waiting for EOF with no prompt to the user.
 *   - Reads all chunks from stdin until EOF; binary safe (concatenates as UTF-8).
 *   - Rejects when the cumulative byte count exceeds {@link STDIN_MAX_BYTES}.
 *   - Trims a single trailing `\n` or `\r\n` (a here-doc always appends one).
 *     Inner newlines are preserved verbatim — the caller decides whether to
 *     accept a multi-line argument.
 *   - Resolves to `""` on empty stdin (the caller distinguishes that from a
 *     missing flag).
 */
export function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		if (stdin.isTTY) {
			reject(
				new Error(
					"--arg-stdin requires piped stdin; it cannot be used interactively. Pipe the argument via a here-doc or echo.",
				),
			);
			return;
		}
		const chunks: Buffer[] = [];
		let total = 0;
		let rejected = false;
		stdin.on("data", (chunk: Buffer | string) => {
			if (rejected) return;
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			total += buf.length;
			if (total > STDIN_MAX_BYTES) {
				rejected = true;
				reject(new Error(`--arg-stdin payload exceeds ${STDIN_MAX_BYTES} bytes`));
				return;
			}
			chunks.push(buf);
		});
		stdin.on("end", () => {
			if (rejected) return;
			let text = Buffer.concat(chunks).toString("utf-8");
			if (text.endsWith("\r\n")) text = text.slice(0, -2);
			else if (text.endsWith("\n")) text = text.slice(0, -1);
			resolve(text);
		});
		/* v8 ignore start -- defensive: stdin error events are rare in practice */
		stdin.on("error", reject);
		/* v8 ignore stop */
	});
}

const AMBIGUOUS_DISPLAY_LIMIT = 10;

/**
 * Prints a git-style "abbreviation is ambiguous" message for {@link AmbiguousHashError}.
 *
 * Shared by `view` / `export` / any future command whose `--commit <ref>` calls
 * `getSummary` with potentially abbreviated input. Caller is responsible for
 * setting `process.exitCode` so a single helper covers both quiet (subcommand)
 * and noisy (top-level) callers without surprising them.
 *
 * Writes to **stderr** so downstream `tee` / pipe consumers don't see the hint
 * mixed into stdout (the project's `SearchCommand.emitError` follows the same
 * convention for text-mode error output). Trims `matches` to
 * {@link AMBIGUOUS_DISPLAY_LIMIT} so a 1-2 character prefix against a multi-
 * thousand-commit repo doesn't flood the terminal.
 */
export function printAmbiguousHash(error: AmbiguousHashError): void {
	console.error(`\n  abbreviation \`${error.prefix}\` is ambiguous; please use a longer prefix.`);
	console.error(`  Matched ${error.matches.length} commits:`);
	const head = error.matches.slice(0, AMBIGUOUS_DISPLAY_LIMIT);
	for (const hash of head) {
		console.error(`    ${hash}`);
	}
	if (error.matches.length > AMBIGUOUS_DISPLAY_LIMIT) {
		console.error(`    … and ${error.matches.length - AMBIGUOUS_DISPLAY_LIMIT} more`);
	}
	console.error("");
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
