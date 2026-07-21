/**
 * Shared remediation copy for the "local `claude` login expired" failure — a
 * LocalAgentAuthError surfaced as a `summaryError: "local-agent-auth"` marker.
 *
 * Two surfaces show it and MUST stay consistent, so the wording lives here once:
 *   - the SessionStart reminder ({@link AUTH_FAILURE_REMINDER_TEXT}) — shown on
 *     the next session when the newest commit failed on auth; and
 *   - the post-commit inline output ({@link AUTH_FAILURE_CAPTURE_TEXT}) — shown
 *     right after the failing commit via the capture-progress watcher.
 *
 * The two fix options are identical; only the framing line and indentation
 * differ (the reminder is prose injected into context; the capture line sits in
 * an indented progress block).
 */

/** The SEPARATE-login clarification — the crux of the user's confusion. */
const SEPARATE_NOTE = "(This login is SEPARATE from Claude Desktop — Desktop stays signed in on its own.)";

/** The two remediation paths, shared verbatim by both surfaces. */
const FIX_LINES = [
	"1) Re-authenticate the CLI:  claude auth login",
	"2) Or switch the provider:   jolli configure --set aiProvider=anthropic --set apiKey=sk-ant-…",
	"                             (or  --set aiProvider=jolli  to use your Jolli Space)",
];

/**
 * SessionStart reminder variant — refers to "a recent commit" and notes the
 * self-clearing behavior (there is no manual dismiss for a transient failure).
 */
export const AUTH_FAILURE_REMINDER_TEXT = [
	"[Jolli Memory] Memory generation failed for a recent commit: the Claude login used for local generation has expired.",
	SEPARATE_NOTE,
	"→ Fix with either:",
	...FIX_LINES.map((l) => `    ${l}`),
	"This message clears automatically once memory generation succeeds again.",
].join("\n");

/**
 * Post-commit inline variant — refers to "this commit", indented to sit under
 * the capture-progress block. No self-clearing note: this is a one-shot line
 * for the commit that just happened, not a persistent reminder.
 */
export const AUTH_FAILURE_CAPTURE_TEXT = [
	"⚠ Jolli Memory: couldn't generate memory — the Claude login used for local generation has expired.",
	`  ${SEPARATE_NOTE}`,
	"  → Fix with either:",
	...FIX_LINES.map((l) => `      ${l}`),
].join("\n");
