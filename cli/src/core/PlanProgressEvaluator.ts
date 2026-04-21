/**
 * Plan Progress Evaluator
 *
 * Pure, single-plan evaluator that calls the LLM to assess which plan steps
 * moved forward in a commit. No registry access, no filesystem writes.
 *
 * The evaluator:
 * 1. Produces a brief summary of what the developer was working on
 * 2. Judges which plan steps moved forward based on the diff
 * 3. Writes rationale-rich per-step notes using conversation topics
 * 4. Surfaces human-flagged signals from the conversation transcript
 */

import { createLogger } from "../Logger.js";
import type { JolliMemoryConfig, LlmCallMetadata, PlanProgressEvalResult, PlanStep, TopicSummary } from "../Types.js";
import { callLlm } from "./LlmClient.js";
import { resolveModelId } from "./Summarizer.js";

const log = createLogger("PlanProgressEvaluator");

/** Maximum output tokens for the plan progress evaluation */
const MAX_TOKENS = 4096;

/** Raw JSON shape returned by the LLM */
interface LlmPlanProgressResponse {
	readonly summary: string;
	readonly steps: ReadonlyArray<{
		readonly id: string;
		readonly description: string;
		readonly status: string;
		readonly note: string | null;
	}>;
}

/** Renders topic summaries into a compact text block for the LLM prompt */
function renderTopics(topics: ReadonlyArray<TopicSummary>): string {
	if (topics.length === 0) return "(no topics available)";

	return topics
		.map((t, i) => {
			const lines = [`Topic ${i + 1}: ${t.title}`, `  Trigger: ${t.trigger}`, `  Decisions: ${t.decisions}`];
			if (t.todo) lines.push(`  Todo: ${t.todo}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

/** Validates that a status string is a valid PlanStepStatus */
function isValidStatus(status: string): status is PlanStep["status"] {
	return status === "completed" || status === "in_progress" || status === "not_started";
}

/**
 * Evaluates plan progress for a single plan against a commit's diff and conversation.
 *
 * @param planMarkdown - Full markdown content of the plan file
 * @param diff - Git diff for the commit
 * @param topics - Conversation summary topics from the commit
 * @param conversation - Raw conversation transcript text
 * @param config - LLM configuration (API keys, model selection)
 * @returns Evaluation result (summary, steps, llm metadata), or null on failure (never blocks the pipeline).
 *          The caller is responsible for constructing the full PlanProgressArtifact with commit metadata.
 */
export async function evaluatePlanProgress(
	planMarkdown: string,
	diff: string,
	topics: ReadonlyArray<TopicSummary>,
	conversation: string,
	config: JolliMemoryConfig,
): Promise<PlanProgressEvalResult | null> {
	const topicsText = renderTopics(topics);

	let llmResult: Awaited<ReturnType<typeof callLlm>>;
	try {
		llmResult = await callLlm({
			action: "plan-progress",
			params: {
				planContent: planMarkdown,
				diff,
				topics: topicsText,
				conversation,
			},
			maxTokens: MAX_TOKENS,
			apiKey: config.apiKey,
			model: resolveModelId(config.model ?? "haiku"),
			jolliApiKey: config.jolliApiKey,
		});
	} catch (error: unknown) {
		log.warn("Plan progress LLM call failed: %s", (error as Error).message);
		return null;
	}

	if (!llmResult.text) {
		log.warn("Plan progress LLM returned empty text");
		return null;
	}

	// Strip markdown code fences if present (matches Summarizer pattern)
	let jsonText = llmResult.text;
	const fenced = llmResult.text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		jsonText = fenced[1].trim();
	}

	// Parse the JSON response
	let parsed: LlmPlanProgressResponse;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		log.warn("Plan progress LLM returned invalid JSON: %s", llmResult.text.substring(0, 200));
		return null;
	}

	// Validate structure
	if (!parsed.summary || !Array.isArray(parsed.steps)) {
		log.warn("Plan progress LLM response missing required fields (summary, steps)");
		return null;
	}

	// Validate and normalize steps
	const steps: PlanStep[] = [];
	for (const step of parsed.steps) {
		if (!step.id || !step.description || !step.status) {
			log.warn("Skipping plan step with missing fields: %s", JSON.stringify(step).substring(0, 100));
			continue;
		}
		const status = isValidStatus(step.status) ? step.status : "not_started";
		steps.push({
			id: step.id,
			description: step.description,
			status,
			note: step.note ?? null,
		});
	}

	const llm: LlmCallMetadata = {
		model: llmResult.model ?? resolveModelId(config.model ?? "haiku"),
		inputTokens: llmResult.inputTokens,
		outputTokens: llmResult.outputTokens,
		apiLatencyMs: llmResult.apiLatencyMs,
		stopReason: llmResult.stopReason ?? null,
	};

	return { summary: parsed.summary, steps, llm };
}
