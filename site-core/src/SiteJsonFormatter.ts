/**
 * SiteJsonFormatter — renders `ValidationIssueLocated`s into one of two
 * human-or-machine-readable forms:
 *
 *   "human"  — multi-line code-frame block with optional ANSI color,
 *              meant for terminal output and error messages
 *   "github" — single-line GitHub Actions workflow commands so CI
 *              workflows can surface issues as inline annotations
 *
 * Pure module. Takes the raw site.json text + the located issues +
 * options; returns a single string. No I/O, no terminal sniffing —
 * the consumer decides whether to enable color.
 */

import type { ValidationIssueLocated } from "./SiteJsonValidator.js";

// ─── Public surface ─────────────────────────────────────────────────────────

export type FormatIssuesOutput = "human" | "github";

export interface FormatIssuesOptions {
	/** Filename printed in the location prefix and in the GitHub annotation. Defaults to `"site.json"`. */
	filename?: string;
	/** When `true`, decorate the human output with ANSI escape codes. Default: `false`. */
	color?: boolean;
	/** `"human"` (default) for terminal output; `"github"` for CI annotations. */
	format?: FormatIssuesOutput;
	/** Lines of source shown before AND after the offending line in human mode. Default: 2. */
	contextLines?: number;
}

/**
 * Renders an array of located issues into a single string. Empty issues
 * → empty string (so the caller can unconditionally `console.error(out)`
 * after `formatIssues(...)` without spamming an empty line).
 *
 * Issues are rendered in the order given. The validator emits them in
 * document order already, so the resulting block reads top-to-bottom
 * matching the source.
 */
export function formatIssues(
	rawText: string,
	issues: readonly ValidationIssueLocated[],
	options: FormatIssuesOptions = {},
): string {
	if (issues.length === 0) return "";

	const filename = options.filename ?? "site.json";
	const format: FormatIssuesOutput = options.format ?? "human";

	if (format === "github") {
		return issues.map((issue) => formatGitHubLine(filename, issue)).join("\n");
	}

	const color = options.color ?? false;
	const contextLines = options.contextLines ?? 2;
	const sourceLines = rawText.split("\n");
	return issues.map((issue) => formatHumanBlock(sourceLines, filename, issue, color, contextLines)).join("\n\n");
}

// ─── GitHub Actions format ──────────────────────────────────────────────────

/**
 * GitHub Actions workflow command syntax — a single line per issue.
 * Reference: https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
 *
 * Message and title are escaped per GitHub's rules: newlines → `%0A`,
 * carriage returns → `%0D`, colons → `%3A`, commas → `%2C`. The escape
 * set is intentionally narrow — backslashes and other characters pass
 * through untouched because GitHub's parser only special-cases the four
 * above.
 */
function formatGitHubLine(filename: string, issue: ValidationIssueLocated): string {
	const sev = issue.severity === "error" ? "error" : "warning";
	// Escape each user-supplied piece BEFORE concatenation. The hint
	// separator `%0AHint%3A ` is a literal joiner — those `%` sequences
	// are GitHub-recognised escape codes for newline + colon, and double-
	// escaping them (turning `%0A` into `%250A`) would just print the
	// literal `%0A` text in the annotation instead of a real newline.
	const escMessage = escapeForWorkflowCommand(issue.message);
	const body = issue.hint ? `${escMessage}%0AHint%3A ${escapeForWorkflowCommand(issue.hint)}` : escMessage;
	return (
		`::${sev} ` +
		`file=${filename},` +
		`line=${issue.line},col=${issue.column},` +
		`endLine=${issue.endLine},endColumn=${issue.endColumn},` +
		`title=${escapeForWorkflowCommand(issue.code)}::` +
		body
	);
}

function escapeForWorkflowCommand(s: string): string {
	return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/:/g, "%3A").replace(/,/g, "%2C");
}

// ─── Human format ───────────────────────────────────────────────────────────

function formatHumanBlock(
	sourceLines: readonly string[],
	filename: string,
	issue: ValidationIssueLocated,
	color: boolean,
	contextLines: number,
): string {
	const { line, column, endLine, endColumn, code, severity, message, hint } = issue;

	// ── Header line ────────────────────────────────────────────────────────
	const sevText = severity === "error" ? "error" : "warning";
	const header = `${filename}:${line}:${column} — ${tint(color, severity, sevText)}[${tint(color, "dim", code)}]`;

	// ── Code frame ─────────────────────────────────────────────────────────
	const startLine = Math.max(1, line - contextLines);
	const lastLine = Math.min(sourceLines.length, line + contextLines);
	const gutterWidth = String(lastLine).length;
	const blankGutter = " ".repeat(gutterWidth);

	const frameLines: string[] = [];
	for (let n = startLine; n <= lastLine; n++) {
		const numStr = String(n).padStart(gutterWidth, " ");
		const content = sourceLines[n - 1] ?? "";

		if (n === line) {
			// Target line — prefix with `>` and append a pointer line below.
			frameLines.push(`${tint(color, severity, ">")} ${numStr} | ${content}`);

			// Pointer line. Underline spans from `column` to the end of the
			// target span on the same line. If the span continues to a later
			// line, just underline to the end of the current line.
			const ptrStart = Math.max(1, column);
			const sameLineEnd = endLine === line ? endColumn : content.length + 1;
			const ptrEnd = Math.max(ptrStart + 1, sameLineEnd);
			const caretCount = ptrEnd - ptrStart;
			const pointer = " ".repeat(ptrStart - 1) + tint(color, severity, "^".repeat(caretCount));
			frameLines.push(`  ${blankGutter} | ${pointer}`);
		} else {
			frameLines.push(`  ${numStr} | ${content}`);
		}
	}

	// ── Message + optional hint ───────────────────────────────────────────
	const out: string[] = [header, ""];
	out.push(`  ${message}`, "");
	out.push(...frameLines);
	if (hint) {
		out.push("", `  ${tint(color, "cyan", "hint:")} ${hint}`);
	}
	return out.join("\n");
}

// ─── ANSI helpers ───────────────────────────────────────────────────────────

type TintColor = "error" | "warning" | "dim" | "cyan";

const ANSI_CODES: Record<TintColor, string> = {
	error: "\x1b[31m", // red
	warning: "\x1b[33m", // yellow
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
};
const ANSI_RESET = "\x1b[0m";

function tint(enabled: boolean, kind: TintColor, text: string): string {
	if (!enabled) return text;
	return `${ANSI_CODES[kind]}${text}${ANSI_RESET}`;
}
