/**
 * Summarizer Module
 *
 * Calls the Anthropic API to generate a multi-topic structured summary
 * from a conversation context and git diff.
 *
 * Each commit is decomposed into 1-N independent topics (one per user goal
 * or problem discussed in the session). Each topic captures:
 *   - title:     short scannable label
 *   - trigger:   problem or need that prompted this
 *   - response:  technical changes made
 *   - decisions: key design choices and rationale
 *   - todo: deferred work / tech debt (optional)
 *
 * Defaults to claude-sonnet-4-6 (configurable via the `model` field — accepts
 * a short alias like `sonnet` / `haiku` or a full Anthropic model ID).
 */

import { createLogger } from "../Logger.js";
import type {
	CommitInfo,
	CommitMessageParams,
	DiffStats,
	E2eTestScenario,
	LlmCallMetadata,
	LlmConfig,
	TopicCategory,
	TopicImportance,
	TopicSummary,
} from "../Types.js";
import { callLlm } from "./LlmClient.js";

const log = createLogger("Summarizer");

/** Default model alias (config stores short aliases, resolved to full IDs at call time) */
const DEFAULT_MODEL_ALIAS = "sonnet";

/**
 * Maps short model aliases stored in config to actual Anthropic model IDs.
 * When Anthropic releases new versions, only this table needs updating.
 * Unknown values are passed through as-is for forward compatibility.
 */
const MODEL_ALIAS_MAP: Readonly<Record<string, string>> = {
	haiku: "claude-haiku-4-5-20251001",
	sonnet: "claude-sonnet-4-6",
	opus: "claude-opus-4-6",
};

/** Resolves a model alias (e.g. "sonnet") to its full Anthropic model ID. */
export function resolveModelId(aliasOrId: string | undefined): string {
	const key = aliasOrId?.trim() || DEFAULT_MODEL_ALIAS;
	return MODEL_ALIAS_MAP[key] ?? key;
}

/**
 * Maximum output tokens for summary generation.
 * Set to Haiku's maximum (8192) to avoid truncation when decisions fields
 * are detailed or when a large commit produces many topics (up to 12 x ~500 tokens each).
 * Cost is based on actual tokens used, not this ceiling.
 */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Result from generateSummary -- fields to be spread onto a CommitSummary.
 * Replaces the deprecated SummaryRecord as the return type.
 */
export interface SummaryResult {
	readonly transcriptEntries: number;
	readonly conversationTurns?: number;
	readonly llm: LlmCallMetadata;
	readonly stats: DiffStats;
	readonly topics: ReadonlyArray<TopicSummary>;
	/** Ticket/issue identifier extracted by LLM from commit message, branch, or conversation */
	readonly ticketId?: string;
	/** Quick recap paragraph extracted by LLM (Consolidate-Hoist field; see CommitSummary.recap) */
	readonly recap?: string;
}

/** Parameters for generating a summary */
export interface SummarizeParams {
	readonly conversation: string;
	readonly diff: string;
	readonly commitInfo: CommitInfo;
	readonly diffStats: DiffStats;
	readonly transcriptEntries: number;
	/** Actual conversation turns (count of human-role entries); computed by caller */
	readonly conversationTurns?: number;
	/** LLM credentials and model selection loaded by the caller */
	readonly config: LlmConfig;
}

/**
 * Generates a summary by calling the Anthropic API.
 *
 * Flow:
 *   1. Build the prompt from conversation + diff + commit info
 *   2. Call the API with the configured model
 *   3. Parse the delimited-text response into topics (JSON fallback for older models)
 *   4. Build and return the SummaryResult
 *
 * The caller spreads the result onto a CommitSummary to build the full node.
 */
export async function generateSummary(params: SummarizeParams): Promise<SummaryResult> {
	const { conversation, diff, commitInfo, diffStats, transcriptEntries } = params;

	log.info("Generating summary for commit %s", commitInfo.hash.substring(0, 8));

	log.info(
		"Context: transcript=%d, files=%d, lines=%d+%d",
		transcriptEntries,
		diffStats.filesChanged,
		diffStats.insertions,
		diffStats.deletions,
	);

	const { config } = params;

	// The `summarize` prompt is self-contained: topic-count guidance is embedded
	// as a three-bucket rule (rule 6) in the prompt itself, so the LLM gauges
	// scope from the diff directly. We previously bucketed in the CLI by total
	// changed lines, but that leaked an implementation detail across the
	// caller/backend boundary and risked silent failure if a caller forgot the
	// associated `topicGuidance` placeholder param. Self-contained prompt =
	// one less contract to misconfigure.
	const sharedParams = {
		commitHash: commitInfo.hash,
		commitMessage: commitInfo.message,
		commitAuthor: commitInfo.author,
		commitDate: commitInfo.date,
		conversation,
		diff,
	};
	const llmResult = await callLlm({
		action: "summarize",
		params: sharedParams,
		maxTokens: DEFAULT_MAX_TOKENS,
		apiKey: config.apiKey,
		model: resolveModelId(config.model),
		jolliApiKey: config.jolliApiKey,
	});

	// Parse raw LLM text (both direct and proxy modes return raw text)
	let responseText = llmResult.text ?? "";
	log.debug("=== LLM raw response START ===");
	log.debug("%s", responseText);
	log.debug("=== LLM raw response END ===");

	let parsed = parseSummaryResponse(responseText);
	log.info("Summary parsed: %d topic(s), response length: %d chars", parsed.topics.length, responseText.length);

	// Format-failure retry: when the first response is non-empty AND its first
	// non-blank line is not a recognized top-level marker, the model emitted
	// markdown / prose instead of the delimited format (typically when the
	// transcript itself is markdown-heavy). Retry once with the strict template,
	// which prepends the failed response and a correction header. Single-shot
	// retry only -- if the second call also fails format compliance, accept the
	// first-response result rather than spend further LLM cost.
	//
	// Empty responses and legitimate recap-only / ticket-only responses ARE
	// format-compliant by isFormatCompliant() and skip the retry path entirely.
	let llmMeta: LlmCallMetadata = {
		model: llmResult.model ?? resolveModelId(config.model),
		inputTokens: llmResult.inputTokens,
		outputTokens: llmResult.outputTokens,
		apiLatencyMs: llmResult.apiLatencyMs,
		stopReason: llmResult.stopReason ?? null,
	};
	if (!isFormatCompliant(responseText)) {
		log.error("=== LLM raw response (format-incompliant) START ===");
		log.error("%s", responseText);
		log.error("=== LLM raw response (format-incompliant) END ===");
		log.warn(
			"First response was format-incompliant (length=%d, first line did not match any top-level marker) -- retrying with strict format reminder",
			responseText.length,
		);
		try {
			const retryResult = await callLlm({
				action: "summarize-strict",
				params: {
					...sharedParams,
					previousResponse: truncateForRetry(responseText),
				},
				maxTokens: DEFAULT_MAX_TOKENS,
				apiKey: config.apiKey,
				model: resolveModelId(config.model),
				jolliApiKey: config.jolliApiKey,
			});
			const retryText = retryResult.text ?? "";
			log.debug("=== LLM strict-retry response START ===");
			log.debug("%s", retryText);
			log.debug("=== LLM strict-retry response END ===");
			if (isFormatCompliant(retryText)) {
				const retryParsed = parseSummaryResponse(retryText);
				log.info(
					"Strict-retry produced format-compliant response (%d topic(s), %d chars) -- using retry result",
					retryParsed.topics.length,
					retryText.length,
				);
				parsed = retryParsed;
				responseText = retryText;
				llmMeta = {
					model: retryResult.model ?? resolveModelId(config.model),
					inputTokens: llmMeta.inputTokens + retryResult.inputTokens,
					outputTokens: llmMeta.outputTokens + retryResult.outputTokens,
					apiLatencyMs: llmMeta.apiLatencyMs + retryResult.apiLatencyMs,
					stopReason: retryResult.stopReason ?? null,
				};
			} else {
				log.warn("Strict-retry response was also format-incompliant -- accepting first-response result");
			}
		} catch (err) {
			log.warn(
				"Strict-retry call failed: %s -- accepting first-response result",
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	for (const [i, topic] of parsed.topics.entries()) {
		log.info("  Topic %d: %s", i + 1, topic.title.substring(0, 80));
	}
	if (parsed.ticketId) {
		log.info("Ticket ID: %s", parsed.ticketId);
	}
	if (parsed.recap) {
		log.info("Recap (%d chars): %s", parsed.recap.length, parsed.recap.substring(0, 120));
	}

	return {
		transcriptEntries,
		...(params.conversationTurns !== undefined && { conversationTurns: params.conversationTurns }),
		llm: llmMeta,
		stats: diffStats,
		topics: parsed.topics,
		...(parsed.ticketId && { ticketId: parsed.ticketId }),
		...(parsed.recap && { recap: parsed.recap }),
	};
}

/**
 * Truncates a failed response before embedding it into the strict-retry prompt.
 * Bounded so the retry's input tokens stay reasonable; the model only needs to
 * see the head + tail of the malformed output to recognize the format mistake.
 */
function truncateForRetry(text: string): string {
	const MAX = 4000;
	if (text.length <= MAX) return text;
	const head = text.slice(0, MAX - 200);
	const tail = text.slice(-200);
	return `${head}\n\n[... truncated ${text.length - MAX} chars ...]\n\n${tail}`;
}

/**
 * Parses the AI response text into a topics-containing object.
 * Kept for backward compatibility with tests.
 */
/** Placeholder patterns that indicate no real decisions were recorded */
const EMPTY_DECISIONS_RE = /^(no\s+(design\s+)?decisions?\s+recorded|n\/?a|none\.?)$/i;

export function parseSummaryResponse(responseText: string): {
	topics: ReadonlyArray<TopicSummary>;
	ticketId?: string;
	recap?: string;
} {
	const { topics: raw, ticketId, recap } = parseTopicsResponse(responseText);
	// Drop topics whose decisions field is empty or a placeholder --
	// a topic with no meaningful decisions adds noise, not value.
	const topics = raw.filter((t) => t.decisions.trim().length > 0 && !EMPTY_DECISIONS_RE.test(t.decisions.trim()));
	if (topics.length < raw.length) {
		log.info("Filtered %d topic(s) with empty/placeholder decisions", raw.length - topics.length);
	}
	return {
		topics,
		...(ticketId && { ticketId }),
		...(recap && { recap }),
	};
}

// --- Delimited text format constants ------------------------------------------

/**
 * Regex that matches the topic delimiter ONLY when it appears on its own line
 * (with optional surrounding whitespace). This prevents false splits when the
 * LLM mentions the delimiter inline, e.g. inside backticks or prose.
 */
const TOPIC_DELIMITER_RE = /^\s*===TOPIC===\s*$/m;

/** Recognised field names in the delimited format (allowlist for safe splitting, UPPERCASE) */
const KNOWN_FIELDS = new Set([
	"TITLE",
	"TRIGGER",
	"RESPONSE",
	"DECISIONS",
	"TODO",
	"FILESAFFECTED",
	"CATEGORY",
	"IMPORTANCE",
]);

/**
 * Top-level markers that may legitimately appear as the first non-blank line
 * of an LLM response. Single source of truth for the format-compliance check
 * used by the strict-retry trigger in generateSummary / generateSquashConsolidation.
 *
 * **When extending the delimited format with a NEW top-level field, this is
 * one of FIVE coordinated touch points:**
 *   1. Add the marker to this Set.
 *   2. Update SUMMARIZE / SQUASH_CONSOLIDATE prompt rules + example block in
 *      [PromptTemplates.ts](./PromptTemplates.ts) so the LLM knows about it.
 *   3. Update parseTopLevelFields() and TOP_LEVEL_FIELD_NAMES (plus the regex
 *      alternation in TOP_LEVEL_SCAN_RE) to extract the new field's value
 *      from anywhere in the LLM response.
 *   4. Add the field to SummaryResult / CommitSummary types in
 *      [Types.ts](../Types.ts) and the Hoist strip helpers in SummaryStore.ts.
 *   5. Update display builders -- SummaryMarkdownBuilder, the VSCode HTML
 *      builder, and the PR markdown builder -- to render the new field.
 *
 * Topic-internal field markers (---TITLE---, ---DECISIONS---, etc. -- see
 * KNOWN_FIELDS above) are NOT in this Set: they appear only INSIDE a
 * ===TOPIC=== block, never as the first line of a response.
 */
export const TOP_LEVEL_MARKERS: ReadonlySet<string> = new Set([
	"===SUMMARY===",
	"===TOPIC===",
	"---TICKETID---",
	"---RECAP---",
]);

/**
 * Sentinel that marks the start of a structured summary response. Required as
 * the first line of every SUMMARIZE / SQUASH_CONSOLIDATE response (new format,
 * v3+); also used as the assistant-turn prefill so the model physically cannot
 * drift into markdown / prose at the start of its response.
 *
 * Legacy responses (no sentinel — old prompt seeded in proxy backends) are still
 * accepted: parseTopLevelFields treats the leading sentinel as optional.
 */
export const SUMMARY_SENTINEL = "===SUMMARY===";

// NOTE: Assistant-turn prefill (passing `===SUMMARY===` as a pre-filled
// assistant message so the model physically cannot drift to markdown) was
// prototyped on top of this sentinel but had to be removed: claude-sonnet-4-6
// returned 400 "This model does not support assistant message prefill" in
// production (commit 9ef56ce4, 2026-04-28). The sentinel itself remains
// useful — the prompt instructs the LLM to start with it, and the parser
// peels it via stripSummarySentinel when present. If a future model variant
// re-enables prefill, see git history for the LlmCallOptions.assistantPrefill
// + callDirect messages-array wiring; until then the format-compliance
// guarantee comes from prompt hardening + strict-retry alone.

/**
 * Returns true when the LLM response either (a) is empty after trim
 * (legitimate "trivial commit" output per SUMMARIZE rule 16), or (b) has its
 * first non-blank line equal to / starting with one of the top-level markers.
 *
 * Used as the strict-retry trigger: format-incompliant responses (markdown
 * headers, prose introductions, tables) yield false here and trigger a single
 * retry against the strict template. Compliant responses -- including
 * empty-but-legitimate ones -- are accepted as-is.
 *
 * **Why startsWith for ===SUMMARY===:** with assistant-turn prefill the
 * response always starts with `===SUMMARY===` followed by the model's
 * continuation. Claude usually emits a `\n` immediately after, but if it
 * occasionally elides the newline (e.g. continues with `---RECAP---` directly
 * on the same line) the first line becomes `===SUMMARY===---RECAP---`. The
 * parser handles both via stripSummarySentinel, so isFormatCompliant accepts
 * any first line that starts with the sentinel rather than demanding exact
 * equality.
 */
export function isFormatCompliant(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;
	const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (firstLine.startsWith(SUMMARY_SENTINEL)) return true;
	return TOP_LEVEL_MARKERS.has(firstLine);
}

/**
 * Parses an AI response in delimited plain-text format into TopicSummary objects.
 *
 * Format:
 *   ===TOPIC===
 *   ---TITLE---
 *   Fix email validation
 *   ---TRIGGER---
 *   Users could submit malformed emails.
 *   ---RESPONSE---
 *   - Added regex check in LoginValidator.ts
 *   ---DECISIONS---
 *   Used native regex to avoid adding a dependency.
 *   ---FILESAFFECTED---
 *   src/LoginValidator.ts, src/Middleware.ts
 *   ---CATEGORY---
 *   bugfix
 *   ---IMPORTANCE---
 *   major
 *
 * Multi-line content between field markers is preserved naturally.
 * Unknown field names (not in KNOWN_FIELDS) are treated as part of the
 * preceding field's content rather than creating a new split.
 */
function parseDelimitedTopics(text: string): ReadonlyArray<TopicSummary> | null {
	// Split by ===TOPIC=== -- first segment is preamble (ticketId etc.), skip it
	const allSegments = text.split(TOPIC_DELIMITER_RE);
	// Drop the preamble (everything before the first ===TOPIC===)
	const segments = allSegments.slice(1).filter((s) => s.trim().length > 0);
	if (segments.length === 0) return null;

	const topics: TopicSummary[] = [];

	for (const [segIdx, segment] of segments.entries()) {
		// Split by ---FIELDNAME--- lines, capturing the field name
		const parts = segment.split(/^---(\w+)---$/m);
		// parts alternates: [preamble, fieldName1, content1, fieldName2, content2, ...]

		const fields: Record<string, string> = {};
		let lastField: string | null = null;

		for (let i = 1; i < parts.length; i += 2) {
			const fieldName = parts[i].toUpperCase();
			/* v8 ignore start -- RegExp split always yields a paired content slot (possibly empty string) for captured delimiters */
			const content = (parts[i + 1] ?? "").trim();
			/* v8 ignore stop */

			if (KNOWN_FIELDS.has(fieldName)) {
				fields[fieldName] = content;
				lastField = fieldName;
				/* v8 ignore start -- defensive: topic parser only sees unknown fields in malformed LLM output */
			} else if (lastField) {
				// Unknown field name -- append back to previous field's content
				fields[lastField] += `\n---${parts[i]}---\n${content}`;
			}
			/* v8 ignore stop */
		}

		// Map UPPERCASE keys back to camelCase for TopicSummary compatibility
		const mapped: Record<string, string> = {};
		if (fields.TITLE) mapped.title = fields.TITLE;
		if (fields.TRIGGER) mapped.trigger = fields.TRIGGER;
		if (fields.RESPONSE) mapped.response = fields.RESPONSE;
		if (fields.DECISIONS) mapped.decisions = fields.DECISIONS;
		if (fields.TODO) mapped.todo = fields.TODO;
		if (fields.CATEGORY) mapped.category = fields.CATEGORY;
		if (fields.IMPORTANCE) mapped.importance = fields.IMPORTANCE;

		// Convert FILESAFFECTED from comma/newline-separated string to array
		const filesRaw = fields.FILESAFFECTED;
		const filesAffected = filesRaw
			? filesRaw
					.split(/[,\n]/)
					.map((f) => f.trim())
					.filter((f) => f.length > 0)
			: undefined;

		const raw: Record<string, unknown> = {
			...mapped,
			...(filesAffected && { filesAffected }),
		};

		topics.push(validateTopicSummary(raw, segIdx));
	}

	/* v8 ignore start -- once a non-empty segment exists, validateTopicSummary always yields at least one topic object */
	return topics.length > 0 ? topics : null;
	/* v8 ignore stop */
}

// --- Unified response parser -------------------------------------------------

/**
 * Internal helper: parses response text into a TopicSummary array plus any
 * pre-topic fields (ticketId, recap).
 *
 * Routing strategy:
 *   1. If the text contains ===TOPIC===, parse as delimited plain text.
 *   2. Otherwise return empty topics (no sentinel needed — the presence/absence
 *      of ===TOPIC=== markers is the only signal the parser needs).
 *
 * Top-level fields (TICKETID, RECAP, plus any future fields) are always
 * extracted via parseTopLevelFields, which scans the entire response (not
 * just the preamble) so a trailing ---RECAP--- after the last topic is still
 * recovered. Topic body is parsed from the sanitized text returned by that
 * helper, with marker+content excised so it cannot leak into the last topic's
 * field-fallthrough path.
 */
interface ParsedResponse {
	readonly topics: ReadonlyArray<TopicSummary>;
	readonly ticketId?: string;
	readonly recap?: string;
}

function parseTopicsResponse(responseText: string): ParsedResponse {
	// Strip markdown code fences if present (handles both formats)
	let text = responseText;
	const fenced = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		text = fenced[1].trim();
	}

	// Extract top-level fields (ticketId, recap) from anywhere outside
	// ===TOPIC=== blocks, returning a sanitized text with marker+content
	// excised. This is robust to the LLM placing ---RECAP--- at the end of the
	// response (after the last topic) instead of in the preamble: a real LLM
	// failure mode observed in production where the recap was silently dropped
	// AND the trailing marker polluted the last topic's IMPORTANCE field.
	const { sanitizedText, ticketId, recap } = parseTopLevelFields(text);

	// -- Route 1: delimited plain-text format --
	// Use line-anchored regex to avoid false positives when the LLM mentions
	// the delimiter inline (e.g. inside backticks or prose about the format).
	const hasDelimitedFormat = TOPIC_DELIMITER_RE.test(sanitizedText);
	if (hasDelimitedFormat) {
		const topics = parseDelimitedTopics(sanitizedText);
		if (topics && topics.length > 0) {
			log.info("Parsed %d topic(s) from delimited text format", topics.length);
			return {
				topics,
				...(ticketId && { ticketId }),
				...(recap && { recap }),
			};
		}
		log.warn("Delimited format detected but parsing yielded 0 topics");
	}

	// -- Fallback: no ===TOPIC=== markers found --
	// This is the expected outcome when rule 16 omits all topics. Return
	// empty topics (with any extracted ticketId / recap). If the response was
	// malformed, the caller's error-level log will capture it.
	log.info("No ===TOPIC=== sections in LLM response -- returning empty topics");
	return {
		topics: [],
		...(ticketId && { ticketId }),
		...(recap && { recap }),
	};
}

/**
 * Top-level field marker names (paired set with TOP_LEVEL_MARKERS, but for the
 * `---FIELDNAME---` form rather than the full marker line). Per rule 18 the LLM
 * is forbidden from emitting these markers inside topic content, which makes
 * "any ---TICKETID--- / ---RECAP--- line outside a ===TOPIC=== block is a real
 * top-level field" a safe parsing invariant.
 */
const TOP_LEVEL_FIELD_NAMES: ReadonlySet<string> = new Set(["TICKETID", "RECAP"]);

/**
 * Combined regex for one-pass scan: matches either a ===TOPIC=== anchor or a
 * top-level field marker (---TICKETID--- / ---RECAP---) on its own line. Case-
 * insensitive for back-compat with older summaries that used `---ticketId---`.
 */
const TOP_LEVEL_SCAN_RE = /^[ \t]*(?:(===TOPIC===)|---(TICKETID|RECAP)---)[ \t]*$/gim;

/**
 * Strips the leading `===SUMMARY===` sentinel line if present. The sentinel
 * marks the start of a structured response (new format, v3+); legacy responses
 * without it still parse correctly because we only strip when the very first
 * non-blank line matches.
 */
function stripSummarySentinel(text: string): string {
	return text.replace(/^\s*===SUMMARY===[ \t]*\r?\n?/i, "");
}

/**
 * Extracts top-level fields (TICKETID, RECAP) from anywhere in the LLM response
 * outside ===TOPIC=== blocks, and returns a sanitized text with those marker+
 * content regions excised so downstream topic parsing does not absorb them.
 *
 * **Why scan the whole text, not just the preamble:** the prompt asks the LLM
 * to put ---RECAP--- before the first ===TOPIC===, but the strict-retry path
 * reliably produces the recap AT THE END (after the last topic) in some cases
 * — observed in production on commit 922f603e. The preamble-only parser
 * silently dropped the recap AND the trailing marker polluted the last topic's
 * IMPORTANCE field via the unknown-field-fallthrough in parseDelimitedTopics.
 *
 * **Excision strategy:** for every ---TICKETID--- / ---RECAP--- match, the
 * field's content runs from end-of-marker to the next match (===TOPIC=== or
 * another top-level marker) or EOF. We strip the entire marker+content span
 * from the sanitized output so parseDelimitedTopics sees a clean topic body.
 *
 * **First-occurrence wins:** if the LLM emits the same field twice (e.g. once
 * in preamble and again at the end), the first occurrence wins. This matches
 * the prompt's expectation that the preamble copy is canonical when present.
 */
export function parseTopLevelFields(text: string): {
	sanitizedText: string;
	ticketId?: string;
	recap?: string;
} {
	// Peel the leading ===SUMMARY=== sentinel (new format) before scanning so
	// the rest of the parser sees a clean preamble. Legacy responses without
	// the sentinel are unaffected — stripSummarySentinel is a no-op when the
	// first line is something else.
	const peeled = stripSummarySentinel(text);
	const matches = [...peeled.matchAll(TOP_LEVEL_SCAN_RE)];

	const fields: { ticketId?: string; recap?: string } = {};
	let cursor = 0;
	let sanitized = "";

	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		// m[1] = "===TOPIC===" (when topic anchor matched), m[2] = "TICKETID"|"RECAP" (when field marker matched)
		const fieldName = m[2]?.toUpperCase();
		/* v8 ignore start -- matchAll always provides .index for /g regex matches */
		const startOfMarker = m.index ?? 0;
		/* v8 ignore stop */
		const endOfMarker = startOfMarker + m[0].length;
		const nextMatchStart = i + 1 < matches.length ? (matches[i + 1].index ?? peeled.length) : peeled.length;

		if (!fieldName) {
			// ===TOPIC=== — leave it (and its body) intact for parseDelimitedTopics
			sanitized += peeled.substring(cursor, endOfMarker);
			cursor = endOfMarker;
			continue;
		}

		// Top-level field marker: capture content (first occurrence wins) and
		// excise marker+content from the sanitized stream.
		const content = peeled.substring(endOfMarker, nextMatchStart).trim();
		if (content.length > 0 && TOP_LEVEL_FIELD_NAMES.has(fieldName)) {
			if (fieldName === "TICKETID" && fields.ticketId === undefined) {
				fields.ticketId = content;
			} else if (fieldName === "RECAP" && fields.recap === undefined) {
				fields.recap = content;
			}
		}

		// Append text up to (not including) the marker; skip over marker+content.
		sanitized += peeled.substring(cursor, startOfMarker);
		cursor = nextMatchStart;
	}

	sanitized += peeled.substring(cursor);

	return { sanitizedText: sanitized, ...fields };
}

/**
 * Generates a single-line commit message by calling the Anthropic API.
 *
 * Only the staged diff and branch name are sent -- no conversation transcripts.
 * This keeps the call fast and cheap. The full transcript context is reserved
 * for the post-commit hook which generates the detailed structured summary.
 */
export async function generateCommitMessage(params: CommitMessageParams): Promise<string> {
	log.info("Generating commit message for branch %s", params.branch);

	const { config } = params;
	const fileList = params.stagedFiles.join(", ") || "(none)";
	const llmResult = await callLlm({
		action: "commit-message",
		params: {
			stagedDiff: params.stagedDiff || "(empty diff -- no staged changes)",
			branch: params.branch,
			fileList,
		},
		maxTokens: 256,
		apiKey: config.apiKey,
		model: resolveModelId(config.model),
		jolliApiKey: config.jolliApiKey,
	});

	const message = (llmResult.text ?? "").trim().replace(/^["']|["']$/g, "");
	log.info("Generated commit message: %s", message);
	return message;
}

// --- Squash commit message generation -----------------------------------------

/** A commit's message paired with its summary topics (title + trigger). */
interface CommitWithTopics {
	readonly message: string;
	readonly topics: ReadonlyArray<{ title: string; trigger: string }>;
}

/** Parameters for generating a squash commit message via LLM. */
export interface SquashMessageParams {
	readonly ticketId?: string;
	readonly commits: ReadonlyArray<CommitWithTopics>;
	readonly isFullSquash: boolean;
	/** LLM credentials and model selection loaded by the caller */
	readonly config: LlmConfig;
}

/**
 * Builds the template params for squash commit message generation.
 */
function buildSquashParams(params: SquashMessageParams): {
	ticketLine: string;
	commitsBlock: string;
	scopeLine: string;
} {
	const ticketLine = params.ticketId ?? "No ticket associated";

	const commitsBlock = params.commits
		.map((c, i) => {
			const topicLines =
				c.topics.length > 0
					? c.topics.map((t) => `   - ${t.title}\n     Why: ${t.trigger}`).join("\n")
					: "   (no summary available)";
			return `${i + 1}. ${c.message}\n   Topics:\n${topicLines}`;
		})
		.join("\n\n");

	const scopeLine = params.isFullSquash
		? "Full squash: ALL commits on this branch are being merged into one. This represents completed work."
		: "Partial squash: only some commits are being merged. Other commits remain on the branch.";

	return { ticketLine, commitsBlock, scopeLine };
}

/**
 * Generates a squash commit message by calling the Anthropic API.
 *
 * Takes the individual commit messages and their summary topics, then asks the
 * LLM to synthesize a concise single-line message. Falls through to the caller
 * for fallback if the API call fails.
 */
export async function generateSquashMessage(params: SquashMessageParams): Promise<string> {
	log.info("Generating squash message for %d commits", params.commits.length);

	const { config } = params;
	const { ticketLine, commitsBlock, scopeLine } = buildSquashParams(params);

	log.debug(
		"generateSquashMessage params: ticketLine=%s scopeLine=%s commitsBlock=%s",
		ticketLine,
		scopeLine,
		commitsBlock,
	);

	const llmResult = await callLlm({
		action: "squash-message",
		params: { ticketLine, commitsBlock, scopeLine },
		maxTokens: 256,
		apiKey: config.apiKey,
		model: resolveModelId(config.model),
		jolliApiKey: config.jolliApiKey,
	});

	const message = (llmResult.text ?? "").trim().replace(/^["']|["']$/g, "");
	log.info("Generated squash message: %s", message);
	return message;
}

// --- E2E Test Guide generation ------------------------------------------------

/** Parameters for generating E2E test scenarios */
export interface E2eTestParams {
	readonly topics: ReadonlyArray<TopicSummary>;
	readonly commitMessage: string;
	readonly diff: string;
	/** LLM credentials and model selection loaded by the caller */
	readonly config: LlmConfig;
}

/** Regex matching the scenario delimiter only on its own line */
const SCENARIO_DELIMITER_RE = /^\s*===SCENARIO===\s*$/m;

/** Recognised field names in the E2E scenario delimited format */
const E2E_KNOWN_FIELDS = new Set(["TITLE", "PRECONDITIONS", "STEPS", "EXPECTED"]);

/**
 * Builds the prompt for generating E2E test scenarios from a commit summary.
 *
 * Inputs provided to the AI:
 * - All topics' title + trigger + response (structured summary context)
 * - Commit message
 * - Code diff (may be truncated)
 *
 * The prompt instructs the AI to produce user-facing, non-technical test steps.
 */

/**
 * Parses an AI response in delimited format into E2eTestScenario objects.
 *
 * Format:
 *   ===SCENARIO===
 *   ---TITLE---
 *   Article reordering
 *   ---PRECONDITIONS---
 *   Have a Space with 3+ articles
 *   ---STEPS---
 *   1. Open the app...
 *   2. Click on...
 *   ---EXPECTED---
 *   - The page should display...
 */
export function parseE2eTestResponse(text: string): ReadonlyArray<E2eTestScenario> {
	// Strip markdown code fences if present
	let cleaned = text;
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		cleaned = fenced[1].trim();
	}

	const segments = cleaned.split(SCENARIO_DELIMITER_RE).filter((s) => s.trim().length > 0);
	if (segments.length === 0) return [];

	const scenarios: E2eTestScenario[] = [];

	for (const segment of segments) {
		const parts = segment.split(/^---(\w+)---$/m);
		const fields: Record<string, string> = {};
		let lastField: string | null = null;

		for (let i = 1; i < parts.length; i += 2) {
			const fieldName = parts[i].toUpperCase();
			/* v8 ignore start -- RegExp split always yields a paired content slot (possibly empty string) for captured delimiters */
			const content = (parts[i + 1] ?? "").trim();
			/* v8 ignore stop */

			if (E2E_KNOWN_FIELDS.has(fieldName)) {
				fields[fieldName] = content;
				lastField = fieldName;
				/* v8 ignore start -- defensive: E2E parser only sees unknown fields in malformed LLM output */
			} else if (lastField) {
				fields[lastField] += `\n---${parts[i]}---\n${content}`;
			}
			/* v8 ignore stop */
		}

		const title = fields.TITLE?.trim();
		if (!title) continue;

		// Parse steps: numbered lines (1. 2. 3. ...)
		const steps = parseNumberedList(fields.STEPS ?? "");
		// Parse expected results: bullet lines (- item) or numbered
		const expectedResults = parseBulletOrNumberedList(fields.EXPECTED ?? "");

		if (steps.length === 0) continue;

		const scenario: E2eTestScenario = {
			title,
			...(fields.PRECONDITIONS?.trim() && { preconditions: fields.PRECONDITIONS.trim() }),
			steps,
			expectedResults,
		};

		scenarios.push(scenario);
	}

	return scenarios;
}

/** Parses numbered list lines (e.g. "1. Do this\n2. Do that") into an array of strings. */
function parseNumberedList(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.replace(/^\d+\.\s*/, "").trim())
		.filter((line) => line.length > 0);
}

/** Parses bullet or numbered list lines into an array of strings. */
function parseBulletOrNumberedList(text: string): string[] {
	return text
		.split("\n")
		.map((line) =>
			line
				.replace(/^[-*]\s+/, "")
				.replace(/^\d+\.\s*/, "")
				.trim(),
		)
		.filter((line) => line.length > 0);
}

/**
 * Generates E2E test scenarios by calling the Anthropic API.
 *
 * Takes the commit's topics, message, and diff as input, calls the LLM with
 * a specialised prompt, and returns structured E2eTestScenario objects.
 */
export async function generateE2eTest(params: E2eTestParams): Promise<ReadonlyArray<E2eTestScenario>> {
	log.info("Generating E2E test guide for: %s", params.commitMessage.substring(0, 60));

	const { config } = params;
	// Filter to major topics before building topicsSummary. Minor topics
	// (formatting, config tweaks, version bumps, doc-only changes) are not
	// worth a manual E2E walkthrough; the prompt's rule 12 caps total scenarios
	// aggressively, so spending one of those slots on a minor topic crowds out
	// the user-facing changes that actually need verification.
	//
	// Topics without an `importance` field default to inclusion -- legacy
	// summaries from before the field existed get a scenario, matching the
	// previous behaviour (the LLM still applies rule 7 to skip non-verifiable
	// internal-only changes).
	const majorTopics = params.topics.filter((t) => t.importance !== "minor");
	if (majorTopics.length === 0) {
		log.info("E2E test guide: no major topics to test -- returning 0 scenarios");
		return [];
	}

	const topicsSummary = majorTopics
		.map((t, i) => `### Topic ${i + 1}: ${t.title}\n- **Trigger:** ${t.trigger}\n- **Response:** ${t.response}`)
		.join("\n\n");
	const llmResult = await callLlm({
		action: "e2e-test",
		params: {
			commitMessage: params.commitMessage,
			topicsSummary,
			diff: params.diff,
		},
		maxTokens: DEFAULT_MAX_TOKENS,
		apiKey: config.apiKey,
		model: resolveModelId(config.model),
		jolliApiKey: config.jolliApiKey,
	});

	const scenarios = parseE2eTestResponse(llmResult.text ?? "");
	log.info("E2E test guide parsed: %d scenario(s) from %d major topic(s)", scenarios.length, majorTopics.length);
	return scenarios;
}

// --- Recap regeneration ------------------------------------------------------

/** Parameters for the standalone recap regeneration call. */
export interface RecapParams {
	readonly topics: ReadonlyArray<TopicSummary>;
	readonly commitMessage: string;
	/** LLM credentials and model selection loaded by the caller. */
	readonly config: LlmConfig;
}

/**
 * Extracts the recap text from a `RECAP` template response.
 *
 * The expected output starts with a `---RECAP---` marker on its own line
 * followed by the recap paragraph(s). This function:
 *   1. Finds the marker and returns everything after it (trimmed).
 *   2. Falls back to the whole response if the marker is missing -- some LLMs
 *      occasionally drop the leading delimiter when the rest of the prompt
 *      has been internalised. Treating that as the recap text is safer than
 *      returning empty (the caller can still display whatever was generated).
 *   3. Strips a trailing `---RECAP---` if the model echoes it at the bottom
 *      (defensive against the model wrapping the content in a closing tag).
 */
export function parseRecapResponse(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";

	const markerRe = /^\s*---RECAP---\s*$/m;
	const match = markerRe.exec(trimmed);
	const body = match ? trimmed.slice(match.index + match[0].length) : trimmed;

	// Drop any echoed closing marker so we don't render it as content.
	return body.replace(/^\s*---RECAP---\s*$/m, "").trim();
}

/**
 * Generates a single Quick Recap paragraph for an existing commit summary.
 *
 * Topics are filtered to `importance: major` (legacy topics without the field
 * are included) before being formatted as the prompt's `topicsSummary` input.
 * Returns an empty string when no major topics exist -- the caller decides
 * whether to keep or clear an existing recap in that case.
 *
 * Unlike `generateE2eTest`, this call does NOT take the diff: the recap is a
 * narrative over already-extracted topics, not a fresh analysis of code.
 * Keeping the diff out of the input also keeps token cost low for an action
 * users may invoke repeatedly until the wording feels right.
 */
export async function generateRecap(params: RecapParams): Promise<string> {
	log.info("Regenerating recap for: %s", params.commitMessage.substring(0, 60));

	const { config } = params;
	const majorTopics = params.topics.filter((t) => t.importance !== "minor");
	if (majorTopics.length === 0) {
		log.info("Recap regenerate: no major topics -- returning empty recap");
		return "";
	}

	// The narrative fields (title, trigger, decisions) are what the recap is
	// built from; response is a detail field and would push the LLM toward
	// implementation-level prose, which the recap rules explicitly forbid.
	const topicsSummary = majorTopics
		.map((t, i) => `### Topic ${i + 1}: ${t.title}\n- **Trigger:** ${t.trigger}\n- **Decisions:** ${t.decisions}`)
		.join("\n\n");

	const llmResult = await callLlm({
		action: "recap",
		params: {
			commitMessage: params.commitMessage,
			topicsSummary,
		},
		maxTokens: DEFAULT_MAX_TOKENS,
		apiKey: config.apiKey,
		model: resolveModelId(config.model),
		jolliApiKey: config.jolliApiKey,
	});

	const recap = parseRecapResponse(llmResult.text ?? "");
	log.info("Recap regenerate: produced %d chars from %d major topic(s)", recap.length, majorTopics.length);
	return recap;
}

// --- Translation --------------------------------------------------------------

/** Parameters for the translateToEnglish function. */
export interface TranslateParams {
	/** Markdown content to translate. */
	readonly content: string;
	/** LLM credentials and model selection loaded by the caller */
	readonly config: LlmConfig;
}

/**
 * Translates a Markdown document to English using the Anthropic API.
 * Returns the translated content as a string.
 */
export async function translateToEnglish(params: TranslateParams): Promise<string> {
	log.info("Translating plan to English (%d chars)", params.content.length);

	const { config } = params;
	const llmResult = await callLlm({
		action: "translate",
		params: { content: params.content },
		maxTokens: DEFAULT_MAX_TOKENS,
		apiKey: config.apiKey,
		model: resolveModelId(config.model),
		jolliApiKey: config.jolliApiKey,
	});

	return llmResult.text ?? "";
}

// --- Validation constants -----------------------------------------------------

const VALID_CATEGORIES = new Set<TopicCategory>([
	"feature",
	"bugfix",
	"refactor",
	"tech-debt",
	"performance",
	"security",
	"test",
	"docs",
	"ux",
	"devops",
]);

const VALID_IMPORTANCES = new Set<TopicImportance>(["major", "minor"]);

/** Matches placeholder strings the LLM produces when it has nothing to say */
const PLACEHOLDER_RE = /^(none|n\/?a|no\s+.{0,40}(recorded|provided|identified|noted|applicable))\.?$/i;

const MAX_FILES_AFFECTED = 5;

// --- Validation helpers -------------------------------------------------------

/** Returns the trimmed string if non-empty and non-placeholder, otherwise undefined. */
function validateOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || PLACEHOLDER_RE.test(trimmed)) return undefined;
	return trimmed;
}

/** Validates and normalises the filesAffected array. */
function validateFilesAffected(value: unknown): ReadonlyArray<string> | undefined {
	if (!Array.isArray(value)) return undefined;
	const files = value
		.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		.map((v) => v.trim())
		.slice(0, MAX_FILES_AFFECTED);
	/* v8 ignore start -- parseDelimitedTopics never produces an empty filesAffected array */
	return files.length > 0 ? files : undefined;
	/* v8 ignore stop */
}

/** Validates and normalises the category field. */
function validateCategory(value: unknown): TopicCategory | undefined {
	if (typeof value !== "string") return undefined;
	const lower = value.trim().toLowerCase() as TopicCategory;
	return VALID_CATEGORIES.has(lower) ? lower : undefined;
}

/** Validates and normalises the importance field. */
function validateImportance(value: unknown): TopicImportance | undefined {
	if (typeof value !== "string") return undefined;
	const lower = value.trim().toLowerCase() as TopicImportance;
	return VALID_IMPORTANCES.has(lower) ? lower : undefined;
}

/**
 * Validates and normalises a raw parsed object into a TopicSummary.
 * Defensive: fills in placeholder text for any missing required fields.
 */
function validateTopicSummary(item: unknown, index: number): TopicSummary {
	/* v8 ignore start -- defensive: parseDelimitedTopics always passes an object-like record */
	const obj = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
	/* v8 ignore stop */

	const base: TopicSummary = {
		title: typeof obj.title === "string" ? obj.title : `Topic ${index + 1}`,
		trigger: typeof obj.trigger === "string" ? obj.trigger : "No trigger provided",
		response: typeof obj.response === "string" ? obj.response : "No response details provided",
		decisions: typeof obj.decisions === "string" ? obj.decisions : "No design decisions recorded",
	};

	// Collect optional fields, omitting undefined values
	const todo = validateOptionalString(obj.todo);
	const filesAffected = validateFilesAffected(obj.filesAffected);
	const category = validateCategory(obj.category);
	const importance = validateImportance(obj.importance);

	return {
		...base,
		...(todo !== undefined && { todo }),
		...(filesAffected !== undefined && { filesAffected }),
		...(category !== undefined && { category }),
		...(importance !== undefined && { importance }),
	};
}

// --- Squash consolidation ----------------------------------------------------

/**
 * Pattern matching a project ticket prefix in a commit message or branch name.
 * Recognises forms like "PROJ-123", "FEAT-456", "JOLLI-789".
 */
const TICKET_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

/**
 * Extracts the canonical (uppercase) ticket identifier from a commit message,
 * branch name, or any text that may contain a "PROJ-123" style reference.
 * Returns undefined when no recognisable ticket appears in the input.
 *
 * Used by:
 *   - runSquashPipeline to derive the outer ticketId hint from the squash
 *     commit message (highest-priority hint, beats per-source ticketIds).
 *   - SummaryFormat.buildPanelTitle as the legacy fallback for older summaries
 *     written before the structured ticketId field existed.
 */
export function extractTicketIdFromMessage(text: string): string | undefined {
	const match = text.match(TICKET_PATTERN);
	return match ? match[0].toUpperCase() : undefined;
}

/**
 * One squashed source commit fed into squash-consolidate.
 *
 * `ticketId` is per-source -- the ticket recorded for that individual commit
 * (extracted at its own summarize time). Callers MAY pass any source order;
 * generateSquashConsolidation sorts internally before rendering the prompt.
 */
export interface SquashConsolidationSource {
	readonly commitHash: string;
	readonly commitDate: string;
	readonly commitMessage: string;
	readonly ticketId?: string;
	readonly recap?: string;
	readonly topics: ReadonlyArray<TopicSummary>;
}

/** Parameters for generateSquashConsolidation. */
export interface SquashConsolidationParams {
	readonly squashCommitMessage: string;
	/**
	 * Explicit ticket extracted from the squash commit message itself (highest
	 * priority hint to the LLM and to the post-call ticketId resolution).
	 * When unset, generateSquashConsolidation falls back to the first source's
	 * ticketId (after oldest-first sort), then to the LLM-extracted value.
	 */
	readonly ticketId?: string;
	readonly sources: ReadonlyArray<SquashConsolidationSource>;
	readonly config: LlmConfig;
}

/** Output from generateSquashConsolidation when the LLM call succeeds. */
export interface SquashConsolidationResult {
	readonly topics: ReadonlyArray<TopicSummary>;
	readonly recap?: string;
	readonly ticketId?: string;
	readonly llm: LlmCallMetadata;
}

/**
 * Sorts sources by commitDate ascending (oldest first). Internal contract of
 * generateSquashConsolidation and mechanicalConsolidate -- callers MAY pass
 * any order, the prompt always renders oldest-first per "Source Commits
 * (oldest first -- authoritative chronological order)" rule.
 */
function sortSourcesOldestFirst(
	sources: ReadonlyArray<SquashConsolidationSource>,
): ReadonlyArray<SquashConsolidationSource> {
	return [...sources].sort((a, b) => new Date(a.commitDate).getTime() - new Date(b.commitDate).getTime());
}

/**
 * Renders a {{sourceCommitsBlock}} for the squash-consolidate prompt. Each
 * source becomes a "=== Commit i of N ===" block with its hash, date, message,
 * optional recap, and per-topic summary. Missing fields drop entire lines (no
 * placeholder strings) -- the prompt itself forbids "None" / "N/A" output.
 *
 * Exported so the Worker can compute prompt previews if needed; primary caller
 * is generateSquashConsolidation.
 */
export function formatSourceCommitsForSquash(sources: ReadonlyArray<SquashConsolidationSource>): string {
	const ordered = sortSourcesOldestFirst(sources);
	const total = ordered.length;
	return ordered
		.map((src, i) => {
			const lines: string[] = [`=== Commit ${i + 1} of ${total} ===`];
			lines.push(`Hash: ${src.commitHash.substring(0, 8)}`);
			lines.push(`Date: ${src.commitDate.substring(0, 10)}`);
			lines.push(`Message: ${src.commitMessage}`);
			if (src.ticketId) lines.push(`Ticket: ${src.ticketId}`);
			if (src.recap) lines.push(`Recap: ${src.recap}`);

			if (src.topics.length === 0) {
				lines.push("(no topics recorded for this commit)");
			} else {
				src.topics.forEach((t, ti) => {
					lines.push("");
					lines.push(`Topic ${ti + 1}`);
					lines.push(` Title: ${t.title}`);
					lines.push(` Trigger: ${t.trigger}`);
					lines.push(` Response: ${t.response}`);
					lines.push(` Decisions: ${t.decisions}`);
					if (t.todo) lines.push(` Todo: ${t.todo}`);
					if (t.category) lines.push(` Category: ${t.category}`);
					if (t.importance) lines.push(` Importance: ${t.importance}`);
					if (t.filesAffected && t.filesAffected.length > 0) {
						lines.push(` Files: ${t.filesAffected.join(", ")}`);
					}
				});
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

/**
 * Mechanical fallback when the LLM is unavailable (network failure, parse
 * failure after retry). Concatenates source topics in oldest-first order and
 * joins recaps with paragraph breaks. The result is "complete but unconsolidated"
 * -- duplicates and supersede candidates remain, but no data is lost.
 *
 * The Hoist invariant still holds: caller writes this back to the root and
 * strips children, so display still works through a single root-authoritative
 * path.
 */
export function mechanicalConsolidate(
	sources: ReadonlyArray<SquashConsolidationSource>,
	outerTicketId?: string,
): {
	topics: ReadonlyArray<TopicSummary>;
	recap?: string;
	ticketId?: string;
} {
	const sorted = sortSourcesOldestFirst(sources);
	const topics = sorted.flatMap((s) => s.topics);
	const recaps = sorted.map((s) => s.recap).filter((r): r is string => !!r);
	const recap = recaps.length > 0 ? recaps.join("\n\n") : undefined;
	const ticketId = outerTicketId ?? sorted.find((s) => s.ticketId)?.ticketId;
	return {
		topics,
		...(recap !== undefined && { recap }),
		...(ticketId !== undefined && { ticketId }),
	};
}

/**
 * Single LLM call that consolidates topics + recap across multiple squashed
 * source commits. Caller MAY pass sources in any order; the function sorts
 * internally and emits an oldest-first {{sourceCommitsBlock}} into the prompt.
 *
 * Returns null when:
 *   - There are no sources at all.
 *   - All sources have empty topics AND empty recap (nothing to consolidate).
 *   - Both LLM call attempts (1 retry) fail.
 *
 * On null, the caller (runSquashPipeline / handleAmendPipeline) falls back to
 * mechanicalConsolidate so the Hoist invariant always completes.
 *
 * ticketId resolution priority on success: params.ticketId (squash message)
 *   > earliest source's ticketId > LLM-extracted ticketId from response.
 */
export async function generateSquashConsolidation(
	params: SquashConsolidationParams,
): Promise<SquashConsolidationResult | null> {
	const { sources, squashCommitMessage, ticketId: outerTicketId, config } = params;

	if (sources.length === 0) {
		log.info("generateSquashConsolidation: no sources -- returning null");
		return null;
	}

	const allEmpty = sources.every((s) => s.topics.length === 0 && !s.recap);
	if (allEmpty) {
		log.info("generateSquashConsolidation: all sources have no topics or recap -- returning null");
		return null;
	}

	const sourceCommitsBlock = formatSourceCommitsForSquash(sources);
	// Sort once and reuse for ticketLine + post-call resolution: both should
	// fall back to the OLDEST source's ticketId, not "first encountered" in
	// caller order (which varies between callers and is non-deterministic).
	const sortedSources = sortSourcesOldestFirst(sources);
	const ticketLine = outerTicketId ?? sortedSources.find((s) => s.ticketId)?.ticketId ?? "No ticket associated";

	const baseParams = { squashMessage: squashCommitMessage, ticketLine, sourceCommitsBlock };

	// Single network call (action = "squash-consolidate" or "squash-consolidate-strict").
	// Returns the raw response text + parsed object so the orchestrator can decide
	// between accepting / strict-retrying / falling through to mechanical.
	const callOnce = async (
		action: "squash-consolidate" | "squash-consolidate-strict",
		extraParams: Record<string, string> = {},
	): Promise<{
		responseText: string;
		parsed: ReturnType<typeof parseSummaryResponse>;
		llm: LlmCallMetadata;
	}> => {
		const llmResult = await callLlm({
			action,
			params: { ...baseParams, ...extraParams },
			maxTokens: DEFAULT_MAX_TOKENS,
			apiKey: config.apiKey,
			model: resolveModelId(config.model),
			jolliApiKey: config.jolliApiKey,
		});
		const responseText = llmResult.text ?? "";
		log.debug("=== %s raw response START ===", action);
		log.debug("%s", responseText);
		log.debug("=== %s raw response END ===", action);
		const parsed = parseSummaryResponse(responseText);
		const llm: LlmCallMetadata = {
			model: llmResult.model ?? resolveModelId(config.model),
			inputTokens: llmResult.inputTokens,
			outputTokens: llmResult.outputTokens,
			apiLatencyMs: llmResult.apiLatencyMs,
			stopReason: llmResult.stopReason ?? null,
		};
		return { responseText, parsed, llm };
	};

	const buildResult = (
		parsed: ReturnType<typeof parseSummaryResponse>,
		llm: LlmCallMetadata,
	): SquashConsolidationResult => {
		const resolvedTicketId = outerTicketId ?? sortedSources.find((s) => s.ticketId)?.ticketId ?? parsed.ticketId;
		return {
			topics: parsed.topics,
			...(parsed.recap !== undefined && { recap: parsed.recap }),
			...(resolvedTicketId !== undefined && { ticketId: resolvedTicketId }),
			llm,
		};
	};

	// First attempt: standard squash-consolidate template. Network errors retry
	// once with the same template (transient failure recovery). Format failures
	// (substantive response but parser found nothing) retry with the strict
	// template instead, which embeds the failed response and a correction header.
	let first: { responseText: string; parsed: ReturnType<typeof parseSummaryResponse>; llm: LlmCallMetadata };
	try {
		first = await callOnce("squash-consolidate");
	} catch (err) {
		log.warn("generateSquashConsolidation first attempt failed: %s -- retrying once", (err as Error).message);
		try {
			first = await callOnce("squash-consolidate");
		} catch (err2) {
			log.error("generateSquashConsolidation retry failed: %s", (err2 as Error).message);
			return null;
		}
	}

	if (first.parsed.topics.length > 0 || first.parsed.recap) {
		return buildResult(first.parsed, first.llm);
	}

	// First call extracted no usable content (no topics, no recap). Two cases:
	//   (a) Response is format-incompliant (markdown / prose) -- strict retry
	//       might recover the consolidation work.
	//   (b) Response is format-compliant but empty / placeholder-only -- the
	//       LLM tried and produced nothing meaningful. Retrying same input is
	//       unlikely to help; fall through to mechanicalConsolidate.
	if (!isFormatCompliant(first.responseText)) {
		log.error("=== squash-consolidate raw response (format-incompliant) START ===");
		log.error("%s", first.responseText);
		log.error("=== squash-consolidate raw response (format-incompliant) END ===");
		log.warn(
			"squash-consolidate first response was format-incompliant (length=%d) -- retrying with strict format reminder",
			first.responseText.length,
		);
		try {
			const strict = await callOnce("squash-consolidate-strict", {
				previousResponse: truncateForRetry(first.responseText),
			});
			if (isFormatCompliant(strict.responseText) && (strict.parsed.topics.length > 0 || strict.parsed.recap)) {
				log.info("Strict-retry produced format-compliant squash-consolidation output -- using retry result");
				const mergedLlm: LlmCallMetadata = {
					model: strict.llm.model,
					inputTokens: first.llm.inputTokens + strict.llm.inputTokens,
					outputTokens: first.llm.outputTokens + strict.llm.outputTokens,
					apiLatencyMs: first.llm.apiLatencyMs + strict.llm.apiLatencyMs,
					stopReason: strict.llm.stopReason,
				};
				return buildResult(strict.parsed, mergedLlm);
			}
			log.warn(
				"squash-consolidate-strict also produced no usable output -- falling through to mechanical fallback",
			);
		} catch (err) {
			log.warn(
				"squash-consolidate-strict call failed: %s -- falling through to mechanical fallback",
				err instanceof Error ? err.message : String(err),
			);
		}
	} else {
		log.warn(
			"generateSquashConsolidation: LLM produced format-compliant but empty consolidation -- falling through to mechanical fallback",
		);
	}
	return null;
}
