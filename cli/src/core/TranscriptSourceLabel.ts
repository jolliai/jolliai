import type { TranscriptSource } from "../Types.js";

/**
 * Single source of truth for transcript source → friendly label.
 *
 * Consumers:
 *   - Extension host (confirm-dialog detail strings) — import this map / helper directly.
 *   - Webview JS — `TranscriptEntryRenderer.buildTranscriptEntriesScript()` emits an
 *     equivalent `getSourceLabel()` function string from this map, so the in-iframe
 *     behavior stays byte-equivalent.
 *
 * Default fallback is "Claude": pre-existing webview behavior treated unknown /
 * undefined sources as Claude (Claude was the first integration). Keeping the
 * fallback aligned avoids a silent UI change in conversation-stats rendering.
 */
export const TRANSCRIPT_SOURCE_LABELS: Readonly<Record<TranscriptSource, string>> = {
	claude: "Claude",
	codex: "Codex",
	cursor: "Cursor",
	copilot: "Copilot",
	"copilot-chat": "Copilot Chat",
	gemini: "Gemini",
	opencode: "OpenCode",
};

export function transcriptSourceLabel(source: TranscriptSource | undefined): string {
	if (source === undefined) return "Claude";
	return TRANSCRIPT_SOURCE_LABELS[source] ?? "Claude";
}
