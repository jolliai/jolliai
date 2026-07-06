import { TRANSCRIPT_SOURCE_LABELS } from "../../../cli/src/core/TranscriptSourceLabel.js";

/**
 * Shared client-side source-label lookup for the Conversations panel.
 *
 * Returns a self-contained JS source string that defines a global
 * 'getSourceLabel(source)' function, generated from the TS-side
 * TRANSCRIPT_SOURCE_LABELS map so the extension host and the webview always
 * agree on labels. The returned string is concatenated into
 * SummaryScriptBuilder's script, which uses it for the inline Conversations
 * rows' source badge and the conversations-stats line.
 *
 * This module used to also emit a `renderTranscriptEntries` function backing
 * the Commit Memory panel's old per-message transcript-editing modal; that
 * modal was retired when the panel was redesigned around whole-session
 * detach (per-message editing lives on in the separate
 * ConversationDetailsPanel, which has its own self-contained script — see
 * ConversationDetailsScriptBuilder's docstring), so only the label lookup
 * remains here.
 *
 * NO backticks allowed in the returned string body — the result is
 * spliced into a parent template literal, and a stray backtick (even
 * in a comment) would prematurely terminate that literal.
 */
export function buildSourceLabelScript(): string {
	// Generate the `if (source === 'X') return 'Y';` lines for every non-Claude
	// entry from the shared TS map. Claude is the fallback (return at the end).
	const labelBranches = Object.entries(TRANSCRIPT_SOURCE_LABELS)
		.filter(([key]) => key !== "claude")
		.map(([key, label]) => `    if (source === '${key}') return '${label}';`);
	return [
		"  function getSourceLabel(source) {",
		...labelBranches,
		"    return 'Claude';",
		"  }",
	].join("\n");
}
