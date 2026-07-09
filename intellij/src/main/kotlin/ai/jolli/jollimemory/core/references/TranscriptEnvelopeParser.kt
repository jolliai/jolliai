package ai.jolli.jollimemory.core.references

import ai.jolli.jollimemory.core.TranscriptSource

/**
 * TranscriptEnvelopeParser — per-source "envelope" parsing for reference extraction.
 *
 * The one genuinely source-specific concern is the envelope: how to recognise,
 * in one transcript line, "an MCP tool call + the payload it returned". This
 * interface isolates that concern so the shared driver can stay identical
 * across Claude, Codex, and any future agent.
 */

/** Options threaded from [extractReferencesFromTranscript] into the parser. */
data class ExtractOptions(
	/** Drop tool_results with timestamp > this ISO 8601 cutoff. */
	val beforeTimestamp: String? = null,
	/** Skip lines before this 0-based line index (cursor for incremental reads). */
	val fromLineNumber: Int? = null,
	/** Which envelope parser to use. Defaults to claude. */
	val source: TranscriptSource? = null,
	/**
	 * Configured Slack workspace base URL (normalized origin, e.g.
	 * `https://my-team.slack.com`). Used to reconstruct a thread permalink for a
	 * `slack_read_thread` result when the user never pasted one — the MCP payload
	 * carries neither a url nor the workspace subdomain. Slack-only; ignored by
	 * every other source.
	 */
	val slackWorkspaceUrl: String? = null,
)

/** One MCP tool result, normalised across agents and ready for the shared payload walk. */
data class NormalizedToolResult(
	/** The adapter that matched this tool call. */
	val adapter: SourceAdapter,
	/** The tool name carried through to [Reference.toolName]. */
	val toolName: String,
	/** Already-parsed, envelope-stripped payload object. */
	val payload: Any?,
	/** 1-based line number where the result was found (for the incremental cursor). */
	val lineNumber: Int,
	/** The result's timestamp. Empty string when the result line carries no timestamp. */
	val referencedAt: String,
)

data class EnvelopeParseResult(
	val results: List<NormalizedToolResult>,
	/** 1-based index of the last line traversed. Suitable for persisting as the next [ExtractOptions.fromLineNumber]. */
	val lastLineNumberScanned: Int,
)

interface TranscriptEnvelopeParser {
	/**
	 * Scan [lines] from [ExtractOptions.fromLineNumber], producing normalised
	 * tool results in transcript order.
	 */
	fun parse(lines: List<String>, opts: ExtractOptions, adapters: List<SourceAdapter>): EnvelopeParseResult
}

/** Resolve the envelope parser for a transcript source. */
fun getEnvelopeParser(source: TranscriptSource = TranscriptSource.claude): TranscriptEnvelopeParser {
	return when (source) {
		TranscriptSource.codex -> CodexEnvelopeParser
		else -> ClaudeEnvelopeParser
	}
}
