import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig, TopicSummary } from "../Types.js";
import type { LlmCallResult } from "./LlmClient.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCallLlm = vi.fn<(opts: unknown) => Promise<LlmCallResult>>();
const mockLogWarn = vi.fn();

vi.mock("./LlmClient.js", () => ({
	callLlm: (opts: unknown) => mockCallLlm(opts),
}));

vi.mock("../Logger.js", () => ({
	createLogger: () => ({
		info: vi.fn(),
		warn: mockLogWarn,
		debug: vi.fn(),
		error: vi.fn(),
	}),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a mock LlmCallResult with the given text */
function llmResult(text: string, overrides: Partial<LlmCallResult> = {}): LlmCallResult {
	return {
		text,
		model: "claude-haiku-4-5-20251001",
		inputTokens: 500,
		outputTokens: 200,
		apiLatencyMs: 350,
		stopReason: "end_turn",
		...overrides,
	};
}

/** A valid plan progress JSON response */
function validResponse(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		summary: "Implemented the plan progress evaluator and wired it into the pipeline.",
		steps: [
			{
				id: "1",
				description: "Add types",
				status: "completed",
				note: "Added PlanStep and PlanProgressArtifact types.",
			},
			{
				id: "2",
				description: "Create evaluator",
				status: "in_progress",
				note: "Evaluator exists but needs tests.",
			},
			{ id: "3", description: "Wire into pipeline", status: "not_started", note: null },
		],
		...overrides,
	});
}

const config: JolliMemoryConfig = { apiKey: "sk-ant-test" };
const planMarkdown = "# My Plan\n\n1. Add types\n2. Create evaluator\n3. Wire into pipeline";
const diff = "diff --git a/foo.ts b/foo.ts\n+added line";
const conversation = "Human: Let's start\nAssistant: Sure";

function makeTopic(overrides: Partial<TopicSummary> = {}): TopicSummary {
	return {
		title: "Add plan progress",
		trigger: "Need to track plan completion",
		response: "Implemented evaluator",
		decisions: "Use Haiku for speed",
		...overrides,
	};
}

// ── Import under test (after mocks) ─────────────────────────────────────────

const { evaluatePlanProgress } = await import("./PlanProgressEvaluator.js");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("evaluatePlanProgress", () => {
	beforeEach(() => {
		mockCallLlm.mockReset();
		mockLogWarn.mockReset();
	});

	describe("valid LLM response parsing", () => {
		it("parses a well-formed JSON response into a PlanProgressEvalResult", async () => {
			mockCallLlm.mockResolvedValueOnce(llmResult(validResponse()));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).not.toBeNull();
			expect(result?.summary).toBe("Implemented the plan progress evaluator and wired it into the pipeline.");
			expect(result?.steps).toHaveLength(3);
			expect(result?.steps[0]).toEqual({
				id: "1",
				description: "Add types",
				status: "completed",
				note: "Added PlanStep and PlanProgressArtifact types.",
			});
			expect(result?.steps[1].status).toBe("in_progress");
			expect(result?.steps[2].status).toBe("not_started");
			expect(result?.steps[2].note).toBeNull();
		});

		it("returns only evaluation fields — no commit metadata (caller constructs full artifact)", async () => {
			mockCallLlm.mockResolvedValueOnce(llmResult(validResponse()));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).not.toBeNull();
			// Should only have summary, steps, llm — no commit metadata
			const keys = Object.keys(result ?? {}).sort();
			expect(keys).toEqual(["llm", "steps", "summary"]);
		});

		it("populates LLM metadata from the call result", async () => {
			mockCallLlm.mockResolvedValueOnce(
				llmResult(validResponse(), {
					model: "claude-haiku-4-5-20251001",
					inputTokens: 1234,
					outputTokens: 567,
					apiLatencyMs: 890,
					stopReason: "end_turn",
				}),
			);

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result?.llm).toEqual({
				model: "claude-haiku-4-5-20251001",
				inputTokens: 1234,
				outputTokens: 567,
				apiLatencyMs: 890,
				stopReason: "end_turn",
			});
		});
	});

	describe("code-fence stripping", () => {
		it("strips ```json fences from the response", async () => {
			const fenced = `\`\`\`json\n${validResponse()}\n\`\`\``;
			mockCallLlm.mockResolvedValueOnce(llmResult(fenced));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).not.toBeNull();
			expect(result?.steps).toHaveLength(3);
		});

		it("strips bare ``` fences without language tag", async () => {
			const fenced = `\`\`\`\n${validResponse()}\n\`\`\``;
			mockCallLlm.mockResolvedValueOnce(llmResult(fenced));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).not.toBeNull();
			expect(result?.summary).toBe("Implemented the plan progress evaluator and wired it into the pipeline.");
		});
	});

	describe("invalid JSON handling", () => {
		it("returns null for non-JSON text", async () => {
			mockCallLlm.mockResolvedValueOnce(llmResult("This is not JSON at all"));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).toBeNull();
			expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("invalid JSON"), expect.any(String));
		});

		it("returns null for truncated JSON", async () => {
			mockCallLlm.mockResolvedValueOnce(llmResult('{"summary": "test", "steps": ['));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).toBeNull();
		});
	});

	describe("missing required fields", () => {
		it("returns null when summary is missing", async () => {
			const noSummary = JSON.stringify({
				steps: [{ id: "1", description: "x", status: "completed", note: null }],
			});
			mockCallLlm.mockResolvedValueOnce(llmResult(noSummary));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).toBeNull();
			expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("missing required fields"));
		});

		it("returns null when steps is missing", async () => {
			const noSteps = JSON.stringify({ summary: "Did stuff" });
			mockCallLlm.mockResolvedValueOnce(llmResult(noSteps));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).toBeNull();
		});

		it("returns null when steps is not an array", async () => {
			const stepsNotArray = JSON.stringify({ summary: "Did stuff", steps: "not-array" });
			mockCallLlm.mockResolvedValueOnce(llmResult(stepsNotArray));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).toBeNull();
		});

		it("skips steps with missing id, description, or status", async () => {
			const response = JSON.stringify({
				summary: "Partial progress",
				steps: [
					{ id: "1", description: "Valid step", status: "completed", note: "Done" },
					{ description: "Missing id", status: "completed", note: null },
					{ id: "3", status: "completed", note: null },
					{ id: "4", description: "Missing status", note: null },
				],
			});
			mockCallLlm.mockResolvedValueOnce(llmResult(response));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).not.toBeNull();
			expect(result?.steps).toHaveLength(1);
			expect(result?.steps[0].id).toBe("1");
		});
	});

	describe("invalid status normalization", () => {
		it("normalizes unknown status values to not_started", async () => {
			const response = JSON.stringify({
				summary: "Working on it",
				steps: [
					{ id: "1", description: "Step one", status: "done", note: "Finished" },
					{ id: "2", description: "Step two", status: "partial", note: "Halfway" },
					{ id: "3", description: "Step three", status: "completed", note: "Legit" },
				],
			});
			mockCallLlm.mockResolvedValueOnce(llmResult(response));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result?.steps[0].status).toBe("not_started");
			expect(result?.steps[1].status).toBe("not_started");
			expect(result?.steps[2].status).toBe("completed");
		});
	});

	describe("empty text response", () => {
		it("returns null when LLM returns empty text", async () => {
			mockCallLlm.mockResolvedValueOnce(llmResult("", { text: "" }));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).toBeNull();
			expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining("empty text"));
		});

		it("returns null when LLM returns undefined text", async () => {
			mockCallLlm.mockResolvedValueOnce(llmResult("unused", { text: undefined }));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).toBeNull();
		});
	});

	describe("topic rendering", () => {
		it("passes rendered topics to the LLM call", async () => {
			const topics: TopicSummary[] = [
				makeTopic({
					title: "Feature A",
					trigger: "User request",
					decisions: "Used approach X",
					todo: "Revisit later",
				}),
				makeTopic({ title: "Bug fix B", trigger: "Error report", decisions: "Patched inline" }),
			];
			mockCallLlm.mockResolvedValueOnce(llmResult(validResponse()));

			await evaluatePlanProgress(planMarkdown, diff, topics, conversation, config);

			expect(mockCallLlm).toHaveBeenCalledOnce();
			const callArgs = mockCallLlm.mock.calls[0][0] as Record<string, unknown>;
			const params = callArgs.params as Record<string, string>;
			expect(params.topics).toContain("Topic 1: Feature A");
			expect(params.topics).toContain("Trigger: User request");
			expect(params.topics).toContain("Decisions: Used approach X");
			expect(params.topics).toContain("Todo: Revisit later");
			expect(params.topics).toContain("Topic 2: Bug fix B");
			// Topic without todo should not have Todo line
			expect(params.topics).not.toContain("Todo: undefined");
		});

		it("renders '(no topics available)' for empty topics", async () => {
			mockCallLlm.mockResolvedValueOnce(llmResult(validResponse()));

			await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			const callArgs = mockCallLlm.mock.calls[0][0] as Record<string, unknown>;
			const params = callArgs.params as Record<string, string>;
			expect(params.topics).toBe("(no topics available)");
		});
	});

	describe("LLM call failure", () => {
		it("returns null when the LLM call throws", async () => {
			mockCallLlm.mockRejectedValueOnce(new Error("API rate limit exceeded"));

			const result = await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(result).toBeNull();
			expect(mockLogWarn).toHaveBeenCalledWith(
				expect.stringContaining("LLM call failed"),
				"API rate limit exceeded",
			);
		});
	});

	describe("LLM call parameters", () => {
		it("calls LLM with correct action, model, and maxTokens", async () => {
			mockCallLlm.mockResolvedValueOnce(llmResult(validResponse()));

			await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "plan-progress",
					maxTokens: 4096,
					apiKey: "sk-ant-test",
				}),
			);
		});

		it("passes plan content and diff in params", async () => {
			mockCallLlm.mockResolvedValueOnce(llmResult(validResponse()));

			await evaluatePlanProgress(planMarkdown, diff, [], conversation, config);

			const callArgs = mockCallLlm.mock.calls[0][0] as Record<string, unknown>;
			const params = callArgs.params as Record<string, string>;
			expect(params.planContent).toBe(planMarkdown);
			expect(params.diff).toBe(diff);
			expect(params.conversation).toBe(conversation);
		});
	});
});
