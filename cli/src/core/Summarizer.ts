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

	// Classify work size to select the appropriate template variant
	const totalLines = diffStats.insertions + diffStats.deletions;
	const workSize = totalLines <= 100 ? "small" : totalLines <= 500 ? "medium" : "large";

	const llmResult = await callLlm({
		action: `summarize:${workSize}`,
		params: {
			commitHash: commitInfo.hash,
			commitMessage: commitInfo.message,
			commitAuthor: commitInfo.author,
			commitDate: commitInfo.date,
			conversation,
			diff,
		},
		maxTokens: DEFAULT_MAX_TOKENS,
		apiKey: config.apiKey,
		model: resolveModelId(config.model),
		jolliApiKey: config.jolliApiKey,
	});

	// Parse raw LLM text (both direct and proxy modes return raw text)
	const responseText = llmResult.text ?? "";
	log.debug("=== LLM raw response START ===");
	log.debug("%s", responseText);
	log.debug("=== LLM raw response END ===");

	const parsed = parseSummaryResponse(responseText);
	log.info("Summary parsed: %d topic(s), response length: %d chars", parsed.topics.length, responseText.length);

	// Log full LLM response only on true parse failure (not intentional rule-16 empty).
	// Uses error level to guarantee file persistence regardless of configured log level.
	if (parsed.topics.length === 0 && !parsed.intentionallyEmpty) {
		log.error("=== LLM raw response (no topics parsed) START ===");
		log.error("%s", responseText);
		log.error("=== LLM raw response (no topics parsed) END ===");
	}
	for (const [i, topic] of parsed.topics.entries()) {
		log.info("  Topic %d: %s", i + 1, topic.title.substring(0, 80));
	}
	if (parsed.ticketId) {
		log.info("Ticket ID: %s", parsed.ticketId);
	}

	const llm: LlmCallMetadata = {
		model: llmResult.model ?? resolveModelId(config.model),
		inputTokens: llmResult.inputTokens,
		outputTokens: llmResult.outputTokens,
		apiLatencyMs: llmResult.apiLatencyMs,
		stopReason: llmResult.stopReason ?? null,
	};

	return {
		transcriptEntries,
		...(params.conversationTurns !== undefined && { conversationTurns: params.conversationTurns }),
		llm,
		stats: diffStats,
		topics: parsed.topics,
		...(parsed.ticketId && { ticketId: parsed.ticketId }),
	};
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
	intentionallyEmpty?: boolean;
} {
	const { topics: raw, ticketId, intentionallyEmpty } = parseTopicsResponse(responseText);
	// Drop topics whose decisions field is empty or a placeholder --
	// a topic with no meaningful decisions adds noise, not value.
	const topics = raw.filter((t) => t.decisions.trim().length > 0 && !EMPTY_DECISIONS_RE.test(t.decisions.trim()));
	if (topics.length < raw.length) {
		log.info("Filtered %d topic(s) with empty/placeholder decisions", raw.length - topics.length);
	}
	return { topics, ticketId, intentionallyEmpty };
}

// --- Delimited text format constants ------------------------------------------

/**
 * Regex that matches the explicit "no topics" signal on its own line.
 * The LLM emits this when rule 16 causes all topics to be omitted.
 */
const NO_TOPICS_RE = /^\s*===NO_TOPICS===\s*$/m;

/**
 * Regex that matches the topic delimiter ONLY when it appears on its own line
 * (with optional surrounding whitespace). This prevents false splits when the
 * LLM mentions the delimiter inline, e.g. inside backticks or prose.
 */
const TOPIC_DELIMITER_RE = /^\s*===TOPIC===\s*$/m;

/** Recognised field names in the delimited format (whitelist for safe splitting, UPPERCASE) */
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
 * Internal helper: parses response text into a TopicSummary array.
 *
 * Routing strategy:
 *   1. If the text contains ===TOPIC===, parse as delimited plain text.
 *   2. If only ---TICKETID--- is present (no topics), return empty topics.
 *   3. Last-resort fallback: store raw text as a single error topic.
 */
interface ParsedResponse {
	readonly topics: ReadonlyArray<TopicSummary>;
	readonly ticketId?: string;
	/** True when the LLM explicitly signalled no topics via ===NO_TOPICS=== (rule 16). */
	readonly intentionallyEmpty?: boolean;
}

function parseTopicsResponse(responseText: string): ParsedResponse {
	// Strip markdown code fences if present (handles both formats)
	let text = responseText;
	const fenced = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		text = fenced[1].trim();
	}

	// Extract pre-topic ticketId (appears before the first ===TOPIC===)
	const ticketId = extractPreTopicTicketId(text);

	// -- Route 1: delimited plain-text format --
	// Use line-anchored regex to avoid false positives when the LLM mentions
	// the delimiter inline (e.g. inside backticks or prose about the format).
	const hasDelimitedFormat = TOPIC_DELIMITER_RE.test(text);
	if (hasDelimitedFormat) {
		const topics = parseDelimitedTopics(text);
		if (topics && topics.length > 0) {
			log.info("Parsed %d topic(s) from delimited text format", topics.length);
			return { topics, ticketId };
		}
		log.warn("Delimited format detected but parsing yielded 0 topics");
	}

	// -- Route 2: explicit "no topics" signal --
	// LLM emits ===NO_TOPICS=== when rule 16 causes all topics to be omitted.
	// This is an intentional empty response, not a parse failure.
	if (NO_TOPICS_RE.test(text)) {
		log.info("LLM signalled no topics (rule 16 applied)");
		return { topics: [], ticketId, intentionallyEmpty: true };
	}

	// -- Fallback: no structured topics found --
	// Return empty topics -- the raw LLM response is already in debug.log
	// (logged by the caller before parsing). No need to store garbage data
	// in the summary tree.
	log.warn("No structured topics found in LLM response -- returning empty summary");
	return { topics: [], ticketId };
}

/**
 * Extracts the ---TICKETID--- field from the text before the first ===TOPIC===.
 * Also accepts lowercase ---ticketId--- for backward compatibility.
 * Returns undefined if not found.
 */
function extractPreTopicTicketId(text: string): string | undefined {
	const topicIdx = text.search(TOPIC_DELIMITER_RE);
	const preamble = topicIdx >= 0 ? text.substring(0, topicIdx) : text;
	const match = preamble.match(/^---(?:TICKETID|ticketId)---\s*\n(.+)/m);
	if (match) {
		const id = match[1].trim();
		/* v8 ignore start -- regex uses .+, so a matched ticket line is never empty after trimming */
		return id.length > 0 ? id : undefined;
		/* v8 ignore stop */
	}
	return undefined;
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
	const maxScenarios = params.topics.length <= 3 ? 5 : 10;
	const topicsSummary = params.topics
		.map((t, i) => `### Topic ${i + 1}: ${t.title}\n- **Trigger:** ${t.trigger}\n- **Response:** ${t.response}`)
		.join("\n\n");
	const llmResult = await callLlm({
		action: "e2e-test",
		params: {
			commitMessage: params.commitMessage,
			topicsSummary,
			diff: params.diff,
			maxScenarios: String(maxScenarios),
		},
		maxTokens: DEFAULT_MAX_TOKENS,
		apiKey: config.apiKey,
		model: resolveModelId(config.model),
		jolliApiKey: config.jolliApiKey,
	});

	const scenarios = parseE2eTestResponse(llmResult.text ?? "");
	log.info("E2E test guide parsed: %d scenario(s)", scenarios.length);
	return scenarios;
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
