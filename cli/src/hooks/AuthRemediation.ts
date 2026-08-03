/**
 * Host-aware remediation copy for a local-agent authentication failure.
 *
 * `summaryError: "local-agent-auth"` is provider-neutral: Claude, Codex, Cursor,
 * and OpenCode backends can all emit it. Keep the wording derived from the tool id
 * so a Codex failure can never tell the user to run `claude auth login`.
 *
 * Both variants carry the SEPARATE-login note when the tool has one
 * ({@link localAgentToolSeparateLoginNote}) — that line is why this message is
 * actionable at all. The failure users actually hit is a CLI OAuth token going
 * stale while the desktop app stays signed in, so "authentication expired" reads as
 * simply false to someone looking at a signed-in app. The note is what makes them
 * check the right credential. It is per-tool and optional: a tool with no desktop
 * app (or an unconfirmed one) omits the line rather than asserting something wrong.
 */

import {
	localAgentToolLabel,
	localAgentToolLoginHint,
	localAgentToolSeparateLoginNote,
} from "../core/localagent/ToolMeta.js";
import type { LocalAgentToolId } from "../Types.js";

function fixLines(tool: LocalAgentToolId): string[] {
	return [
		`1) Re-authenticate ${localAgentToolLabel(tool)}:  ${localAgentToolLoginHint(tool)}`,
		"2) Or switch the provider:   jolli configure --set aiProvider=anthropic --set apiKey=sk-ant-…",
		"                             (or --set aiProvider=jolli to use Jolli)",
	];
}

/** The note as its own line, indented for the caller's block, or nothing at all. */
function separateNoteLines(tool: LocalAgentToolId, indent: string): string[] {
	const note = localAgentToolSeparateLoginNote(tool);
	return note === null ? [] : [`${indent}${note}`];
}

export function buildAuthFailureReminderText(tool: LocalAgentToolId): string {
	return [
		`[Jolli Memory] Memory generation failed for a recent commit: ${localAgentToolLabel(tool)} authentication expired or is unavailable.`,
		...separateNoteLines(tool, ""),
		"→ Fix with either:",
		...fixLines(tool).map((line) => `    ${line}`),
		"This message clears automatically once memory generation succeeds again.",
	].join("\n");
}

export function buildAuthFailureCaptureText(tool: LocalAgentToolId): string {
	return [
		`⚠ Jolli Memory: couldn't generate memory — ${localAgentToolLabel(tool)} authentication expired or is unavailable.`,
		...separateNoteLines(tool, "  "),
		"  → Fix with either:",
		...fixLines(tool).map((line) => `      ${line}`),
	].join("\n");
}
