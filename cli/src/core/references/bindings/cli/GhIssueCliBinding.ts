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
 *
 * COMMAND FALLBACK: the `nativeId` and `url` the github `SourceDefinition` requires
 * come from the payload's `number`/`url`. A user who runs `gh issue view <n> --json
 * title,body` (omitting `number`/`url` from the field selection) yields a payload
 * that the definition voids. Rather than force a field selection, `normalize` can
 * recover both from the COMMAND itself — the issue selector (`<number>` or `<url>`
 * positional) and the `--repo`/`-R owner/repo` flag are all gh needs to identify
 * the issue, so they suffice to rebuild `number` + `url`. Command-derived values
 * only fill fields the payload lacks; a payload value always wins.
 */

import { isObject } from "../../guards.js";
import { reshapeGitHubIssue } from "../../sources/GitHubNormalize.js";
import type { CliBinding } from "./CliBinding.js";

/** Shell operators after which a `gh` token is a fresh command (the executable). */
const COMMAND_BOUNDARIES = new Set(["&&", "||", "|", ";", "&", "(", "{"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GH_EXECUTABLE = /(^|[/\\])gh(\.exe)?$/i;
/** A bare issue number positional (`gh issue view 1132`). */
const ISSUE_NUMBER = /^\d+$/;
/** A GitHub issue/PR URL positional (`gh issue view https://github.com/o/r/issues/1`). */
const ISSUE_URL = /^https?:\/\/\S+$/;
/** An `owner/repo` value for `--repo`/`-R`; rejects a URL (which carries a scheme). */
const OWNER_REPO = /^[^/\s:]+\/[^/\s:]+$/;

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

/**
 * Tokenize one line and return the args AFTER a `gh` executable that sits at a
 * command position and is followed by a consecutive `issue view` token pair.
 * Returns null when the line is not a `gh issue view` invocation. Shared by the
 * matcher (which additionally requires `--json`) and the command-fallback parser.
 */
function ghIssueViewArgs(line: string): string[] | null {
	// Pad shell control operators so ones glued to a neighbour become their own
	// tokens (e.g. `cd /repo; gh …` → `… /repo ; gh …`, `x&&gh` → `x && gh`).
	// Without this, atCommandPosition can't see the boundary before `gh`. A bare
	// single `&` is deliberately NOT padded — it also appears inside URL query
	// strings (`?a=1&b=2`), and splitting there would truncate an issue-URL
	// selector; a genuine background `&` before gh is whitespace-delimited in
	// practice and already tokenizes on its own.
	const all = line
		.replace(/(&&|\|\||[;|(){}])/g, " $1 ")
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
		// pair anywhere in the args, not merely adjacent to `gh`.
		//   - `gh issue --json view` is correctly missed (pair not consecutive).
		//   - `gh --json issue view` matches here, but gh rejects it with a non-zero
		//     exit (`unknown command "view"`), so the exit-code/is_error gate drops it.
		if (rest.some((t, k) => t === "issue" && rest[k + 1] === "view")) return rest;
	}
	return null;
}

function lineHasGhIssueView(line: string): boolean {
	const rest = ghIssueViewArgs(line);
	return rest?.some(isJsonFlag) ?? false;
}

/**
 * Match each newline-separated statement independently: a `gh …` on its own line
 * is then at a command position (not glued to the previous statement's tail), and
 * a `#` comment scopes to just its line.
 */
function matchesGhIssueView(command: string): boolean {
	return command.split(/[\r\n]+/).some(lineHasGhIssueView);
}

/** The `owner/repo` value of a `--repo`/`-R` flag (split or `=`-glued form), or undefined. */
function extractRepo(args: readonly string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const t = args[i];
		if (t === "--repo" || t === "-R") {
			const value = args[i + 1];
			if (value !== undefined && OWNER_REPO.test(value)) return value;
		} else if (t.startsWith("--repo=") || t.startsWith("-R=")) {
			const value = t.slice(t.indexOf("=") + 1);
			if (OWNER_REPO.test(value)) return value;
		}
	}
	return undefined;
}

/**
 * The issue selector positional (a bare number or a GitHub URL). No gh issue-view
 * flag takes a bare-integer or http-URL value, so scanning the args for the first
 * such token reliably finds the selector regardless of flag ordering.
 */
function extractSelector(args: readonly string[]): { number?: number; url?: string } {
	for (const t of args) {
		if (ISSUE_URL.test(t)) return { url: t };
		if (ISSUE_NUMBER.test(t)) return { number: Number(t) };
	}
	return {};
}

/**
 * Recover `{ number, url }` from a `gh issue view` command. A URL selector yields
 * `url` alone (the reshape/definition derive number + owner/repo from it). A bare
 * number selector needs a `--repo owner/repo` to synthesize the issue URL — a lone
 * number cannot identify the issue, so it is dropped.
 */
function deriveFromCommand(command: string): { number?: number; url?: string } {
	for (const line of command.split(/[\r\n]+/)) {
		const args = ghIssueViewArgs(line);
		// Only a statement carrying `--json` produced the payload we are backfilling.
		// Deriving from any other `gh issue view` line (e.g. a non-JSON `view` earlier
		// in the command) would attach a DIFFERENT issue's selector to this payload.
		if (args === null || !args.some(isJsonFlag)) continue;
		const selector = extractSelector(args);
		if (selector.url !== undefined) return { url: selector.url };
		if (selector.number !== undefined) {
			const repo = extractRepo(args);
			if (repo !== undefined) {
				return { number: selector.number, url: `https://github.com/${repo}/issues/${selector.number}` };
			}
		}
	}
	return {};
}

/** Fill `number`/`url` from the command only where the payload lacks them (payload wins). */
function applyCommandFallback(business: unknown, command: string): unknown {
	if (!isObject(business)) return business;
	const derived = deriveFromCommand(command);
	if (derived.number === undefined && derived.url === undefined) return business;
	const out = { ...business };
	if (typeof out.number !== "number" && derived.number !== undefined) out.number = derived.number;
	const hasUrl = typeof out.url === "string" || typeof out.html_url === "string";
	if (!hasUrl && derived.url !== undefined) out.url = derived.url;
	return out;
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
	normalize: (business, command) => {
		const enriched = command !== undefined ? applyCommandFallback(business, command) : business;
		return lowercaseState(reshapeGitHubIssue(enriched));
	},
};
