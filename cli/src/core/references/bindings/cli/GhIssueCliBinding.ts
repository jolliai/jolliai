/**
 * GhIssueCliBinding — `gh issue view … --json` → GitHub issue reference.
 *
 * Recognition is a minimal tokenization (pad shell metacharacters, then split on
 * whitespace — good enough for gh invocations; perfect shell quote/escape handling
 * is out of scope, the envelope's exit-code/is_error gate is the second line of
 * defense). It requires a `gh`/`gh.exe` executable at a COMMAND POSITION (so
 * `echo "gh issue view --json"`, a `#` comment, or a quoted mention don't match),
 * the `issue view` subcommand as a consecutive token pair (tolerating global
 * flags like `--repo o/r` before it), and a standalone `--json` / `--json=<fields>`
 * flag (rejects `--jsonfoo`).
 *
 * Normalization reuses the shared `reshapeGitHubIssue` (gh's `--json` output maps
 * onto it verbatim) plus a gh-only `state` lowercasing — gh emits `"CLOSED"`
 * while the MCP path emits `"closed"`; lowercasing is confined here so the shared
 * reshape (and the Codex MCP path that also uses it) stays byte-identical.
 */

import { reshapeGitHubIssue } from "../../sources/GitHubNormalize.js";
import type { CliBinding } from "./CliBinding.js";

/** Shell operators after which a `gh` token is a fresh command (the executable). */
const COMMAND_BOUNDARIES = new Set(["&&", "||", "|", ";", "&", "(", "{"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GH_EXECUTABLE = /(^|[/\\])gh(\.exe)?$/i;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A `gh` token at index `i` is at a command position: line start, after a shell
 *  operator, or preceded only by `VAR=val` env assignments. */
function atCommandPosition(tokens: readonly string[], i: number): boolean {
	let j = i - 1;
	while (j >= 0 && ENV_ASSIGN.test(tokens[j])) j--;
	return j < 0 || COMMAND_BOUNDARIES.has(tokens[j]);
}

/** A standalone `--json` flag (`--json` or `--json=<fields>`); rejects `--jsonfoo`. */
function isJsonFlag(token: string): boolean {
	return token === "--json" || token.startsWith("--json=");
}

function lineHasGhIssueView(line: string): boolean {
	// Pad shell metacharacters so operators glued to a neighbour become their own
	// tokens (e.g. `cd /repo; gh …` → `… /repo ; gh …`, `x&&gh` → `x & & gh`).
	// Without this, atCommandPosition can't see the boundary before `gh`.
	const all = line
		.replace(/([;|&(){}])/g, " $1 ")
		.split(/\s+/)
		.filter((t) => t.length > 0);
	// Drop a trailing `#` comment up front so neither the executable scan nor the
	// `issue view` pair search reaches into commented-out text (e.g. the second
	// `gh …` in `gh foo # gh issue view 1 --json`).
	const hash = all.indexOf("#");
	const tokens = hash === -1 ? all : all.slice(0, hash);
	for (let i = 0; i < tokens.length; i++) {
		if (!GH_EXECUTABLE.test(tokens[i]) || !atCommandPosition(tokens, i)) continue;
		const rest = tokens.slice(i + 1);
		// gh accepts global flags (e.g. `--repo o/r`, `-R o/r`) BEFORE the subcommand
		// — verified on gh 2.85.0 — so require `issue view` as a CONSECUTIVE token
		// pair anywhere in the args, not merely adjacent to `gh`. A standalone
		// `--json` flag (`--json` or `--json=<fields>`) is still required.
		//   - `gh issue --json view` is correctly missed (pair not consecutive).
		//   - `gh --json issue view` matches here, but gh rejects it with a non-zero
		//     exit (`unknown command "view"`), so the exit-code/is_error gate drops it.
		const hasIssueViewPair = rest.some((t, k) => t === "issue" && rest[k + 1] === "view");
		if (!hasIssueViewPair) continue;
		if (rest.some(isJsonFlag)) return true;
	}
	return false;
}

/**
 * Match each newline-separated statement independently: a `gh …` on its own line
 * is then at a command position (not glued to the previous statement's tail), and
 * a `#` comment scopes to just its line.
 */
function matchesGhIssueView(command: string): boolean {
	return command.split(/[\r\n]+/).some(lineHasGhIssueView);
}

/** Lowercase `state` only (gh "CLOSED" → "closed"); leave everything else as reshaped. */
function lowercaseState(reshaped: unknown): unknown {
	if (isObject(reshaped) && typeof reshaped.state === "string") {
		return { ...reshaped, state: reshaped.state.toLowerCase() };
	}
	return reshaped;
}

export const ghIssueCliBinding: CliBinding = {
	id: "github",
	matches: matchesGhIssueView,
	canonicalToolName: "mcp__github__issue_read",
	normalize: (business) => lowercaseState(reshapeGitHubIssue(business)),
};
