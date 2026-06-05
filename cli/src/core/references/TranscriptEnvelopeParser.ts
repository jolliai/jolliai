/**
 * TranscriptEnvelopeParser — per-source "envelope" parsing for reference extraction.
 *
 * The reference pipeline is ~95% source-agnostic. The one genuinely
 * source-specific concern is the *envelope*: how to recognise, in one transcript
 * line, "an MCP tool call + the payload it returned". This interface isolates
 * that concern so the shared driver (ReferenceExtractor.extractReferencesFromTranscript)
 * can stay identical across Claude, Codex, and any future agent.
 *
 * A parser turns raw JSONL lines into a flat, transcript-ordered sequence of
 * NormalizedToolResult — each carrying the matched SourceAdapter, the (already
 * JSON-parsed, envelope-stripped) payload, and the line/timestamp metadata the
 * driver needs for the incremental cursor and dedupe. The driver then walks each
 * payload through `adapter.extractRef` exactly as before.
 *
 * No runtime import cycle: ClaudeEnvelopeParser imports only the *types* below
 * (erased at compile time), while this module imports the parser *value*.
 */

import type { TranscriptSource } from "../../Types.js";
import { claudeEnvelopeParser } from "./ClaudeEnvelopeParser.js";
import { codexEnvelopeParser } from "./CodexEnvelopeParser.js";
import type { SourceAdapter } from "./sources/SourceAdapter.js";

/**
 * Options threaded from `extractReferencesFromTranscript` into the parser.
 * Defined here (not in ReferenceExtractor) so the parser interface can reference
 * it without a circular import.
 */
export interface ExtractOptions {
	/** Drop tool_results with timestamp > this ISO 8601 cutoff. */
	readonly beforeTimestamp?: string;
	/** Skip lines before this 0-based line index (cursor for incremental reads). */
	readonly fromLineNumber?: number;
	/**
	 * Which envelope parser to use. Defaults to "claude" so existing callers
	 * (StopHook + every existing test) keep their exact behaviour without
	 * passing this. The Codex polling path passes "codex".
	 */
	readonly source?: TranscriptSource;
}

/**
 * One MCP tool result, normalised across agents and ready for the shared
 * payload walk. Produced by a TranscriptEnvelopeParser, consumed by the driver.
 */
export interface NormalizedToolResult {
	/**
	 * The adapter that matched this tool call — carried as a reference, NOT
	 * re-derived from a SourceId. Claude's `mcp__claude_ai_Atlassian__`→jira /
	 * `mcp__claude_ai_Notion__`→notion are prefix≠SourceId, so a mechanical
	 * derivation would be wrong; the parser already knows which adapter matched.
	 */
	readonly adapter: SourceAdapter;
	/**
	 * The tool name passed to `adapter.extractRef` for its business guard.
	 * Claude: the raw `block.name` (e.g. `mcp__github__issue_read`) — passed
	 * through verbatim. Codex: a canonical name the adapter's guard accepts
	 * (the CodexEnvelopeParser maps the connector tool name to it).
	 */
	readonly toolName: string;
	/** Already-`JSON.parse`d, envelope-stripped payload object. */
	readonly payload: unknown;
	/** 1-based line number where the result was found (for the incremental cursor). */
	readonly lineNumber: number;
	/**
	 * The result's timestamp (NOT the originating tool_use's). Empty string when
	 * the result line carries no timestamp — matches the historical Claude
	 * behaviour relied upon by dedupe ordering.
	 */
	readonly referencedAt: string;
}

export interface EnvelopeParseResult {
	readonly results: NormalizedToolResult[];
	/**
	 * 1-based index of the last line traversed (NOT just the last line that
	 * produced a result). Equals the historical `lastConsumed`; suitable for
	 * persisting as the next `fromLineNumber`.
	 */
	readonly lastLineNumberScanned: number;
}

export interface TranscriptEnvelopeParser {
	/**
	 * Scan `lines` from `opts.fromLineNumber` (default 0), producing normalised
	 * tool results in transcript order. Implementations MUST:
	 *  - apply `opts.beforeTimestamp` (drop results whose timestamp > cutoff),
	 *  - emit results in transcript line order (dedupe is "later-seen wins" on
	 *    timestamp ties; reordering changes results),
	 *  - return `lastLineNumberScanned` = the last line index traversed.
	 */
	parse(lines: string[], opts: ExtractOptions, adapters: readonly SourceAdapter[]): EnvelopeParseResult;
}

/**
 * Resolve the envelope parser for a transcript source. Stage A ships only the
 * Claude parser; Stage B adds "codex". Unknown/other sources fall back to the
 * Claude parser (its substring pre-filter simply produces no results on a
 * non-Claude transcript, preserving the pre-refactor "no references" outcome).
 */
export function getEnvelopeParser(source: TranscriptSource = "claude"): TranscriptEnvelopeParser {
	switch (source) {
		case "codex":
			return codexEnvelopeParser;
		default:
			return claudeEnvelopeParser;
	}
}
