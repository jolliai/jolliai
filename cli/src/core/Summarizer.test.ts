import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmCallOptions, LlmCallResult } from "./LlmClient.js";

const mockCallLlm = vi.fn<(options: LlmCallOptions) => Promise<LlmCallResult>>();
vi.mock("./LlmClient.js", () => ({
	callLlm: (options: LlmCallOptions) => mockCallLlm(options),
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import type { CommitInfo, CommitMessageParams, DiffStats } from "../Types.js";
import {
	extractTicketIdFromMessage,
	formatSourceCommitsForSquash,
	generateCommitMessage,
	generateE2eTest,
	generateRecap,
	generateSquashConsolidation,
	generateSquashMessage,
	generateSummary,
	isFormatCompliant,
	mechanicalConsolidate,
	parseE2eTestResponse,
	parseRecapResponse,
	parseSummaryResponse,
	parseTopLevelFields,
	resolveModelId,
	type SquashConsolidationSource,
	TOP_LEVEL_MARKERS,
	translateToEnglish,
} from "./Summarizer.js";

const mockCommitInfo: CommitInfo = {
	hash: "abc123def456789",
	message: "Fix login validation bug",
	author: "John Doe",
	date: "2026-02-19T10:00:00+08:00",
};

const mockDiffStats: DiffStats = {
	filesChanged: 3,
	insertions: 45,
	deletions: 12,
};

const mockConfig = { apiKey: "test-key" };

const mockCommitMessageParams: CommitMessageParams = {
	stagedDiff: "diff --git a/src/Foo.ts\n+++ added line",
	branch: "feature/proj-123-add-commit-message",
	stagedFiles: ["src/Foo.ts"],
	config: mockConfig,
};

const mockTopics = [
	{
		title: "Add drag-to-reorder for articles",
		trigger: "Users wanted to reorder articles in a Space",
		response: "Implemented drag-and-drop reordering via the chat agent",
		decisions: "Used a simple swap algorithm for reliability",
		category: "feature" as const,
		importance: "major" as const,
	},
	{
		title: "Fix login timeout on slow networks",
		trigger: "Users on slow networks were getting logged out",
		response: "Increased session timeout from 5m to 30m",
		decisions: "Chose 30m based on industry standard",
		category: "bugfix" as const,
		importance: "major" as const,
	},
];

function summaryLlmResult(text: string, overrides: Partial<LlmCallResult> = {}): LlmCallResult {
	return {
		text,
		model: "claude-sonnet-4-6",
		inputTokens: 100,
		outputTokens: 50,
		apiLatencyMs: 123,
		stopReason: "end_turn",
		...overrides,
	};
}

function delimited(fields: {
	title: string;
	trigger: string;
	response: string;
	decisions: string;
	todo?: string;
	filesAffected?: string;
	category?: string;
	importance?: string;
}): string {
	let s = "===TOPIC===\n";
	s += `---TITLE---\n${fields.title}\n`;
	s += `---TRIGGER---\n${fields.trigger}\n`;
	s += `---RESPONSE---\n${fields.response}\n`;
	s += `---DECISIONS---\n${fields.decisions}`;
	if (fields.todo) s += `\n---TODO---\n${fields.todo}`;
	if (fields.filesAffected) s += `\n---FILESAFFECTED---\n${fields.filesAffected}`;
	if (fields.category) s += `\n---CATEGORY---\n${fields.category}`;
	if (fields.importance) s += `\n---IMPORTANCE---\n${fields.importance}`;
	return s;
}

describe("Summarizer", () => {
	beforeEach(() => {
		mockCallLlm.mockReset();
	});

	describe("isFormatCompliant", () => {
		it("treats empty / whitespace-only response as compliant (rule 16: trivial commit)", () => {
			expect(isFormatCompliant("")).toBe(true);
			expect(isFormatCompliant("   ")).toBe(true);
			expect(isFormatCompliant("\n\n\n")).toBe(true);
		});

		it("accepts each top-level marker as a valid first line", () => {
			expect(isFormatCompliant("===SUMMARY===\n---TICKETID---\nPROJ-1")).toBe(true);
			expect(isFormatCompliant("===TOPIC===\n---TITLE---\nFoo")).toBe(true);
			expect(isFormatCompliant("---TICKETID---\nPROJ-1")).toBe(true);
			expect(isFormatCompliant("---RECAP---\nA recap.")).toBe(true);
		});

		it("ignores leading whitespace before the first marker", () => {
			expect(isFormatCompliant("\n\n===TOPIC===\n...")).toBe(true);
			expect(isFormatCompliant("  \n  ---RECAP---\nfoo")).toBe(true);
		});

		it("rejects markdown headers as the first line", () => {
			expect(isFormatCompliant("## Jolli Memory Summary")).toBe(false);
			expect(isFormatCompliant("# A heading")).toBe(false);
			expect(isFormatCompliant("### Topics")).toBe(false);
		});

		it("rejects prose introductions and arbitrary text", () => {
			expect(isFormatCompliant("Here is the summary:\n\n===TOPIC===")).toBe(false);
			expect(isFormatCompliant("brief no-marker response")).toBe(false);
		});

		it("rejects markdown tables and code fences as first line", () => {
			expect(isFormatCompliant("| Col | Col |\n|---|---|\n| a | b |")).toBe(false);
			expect(isFormatCompliant("```\n===TOPIC===\n```")).toBe(false);
		});

		it("rejects topic-internal field markers (which must NEVER be the first line)", () => {
			expect(isFormatCompliant("---TITLE---\nFoo")).toBe(false);
			expect(isFormatCompliant("---DECISIONS---\nbar")).toBe(false);
		});

		it("rejects a marker line with trailing content (parser also wouldn't recognize it)", () => {
			expect(isFormatCompliant("===TOPIC=== please check")).toBe(false);
		});

		it("TOP_LEVEL_MARKERS is the single source of truth (smoke test)", () => {
			expect(TOP_LEVEL_MARKERS.has("===TOPIC===")).toBe(true);
			expect(TOP_LEVEL_MARKERS.has("---TICKETID---")).toBe(true);
			expect(TOP_LEVEL_MARKERS.has("---RECAP---")).toBe(true);
			// Topic-internal field markers must NOT be in the set.
			expect(TOP_LEVEL_MARKERS.has("---TITLE---")).toBe(false);
			expect(TOP_LEVEL_MARKERS.has("---DECISIONS---")).toBe(false);
		});
	});

	describe("parseSummaryResponse", () => {
		it("parses a valid delimited response with optional fields", () => {
			const result = parseSummaryResponse(
				delimited({
					title: "Fix email validation in login form",
					trigger: "Users were able to submit malformed emails.",
					response: "Added regex check in LoginValidator.ts.",
					decisions: "Used native regex instead of a library.",
					todo: "Add server-side validation follow-up",
					filesAffected: "src/Auth.ts, src/Middleware.ts",
					category: "Feature",
					importance: "Major",
				}),
			);

			expect(result.topics).toHaveLength(1);
			expect(result.topics[0]).toMatchObject({
				title: "Fix email validation in login form",
				todo: "Add server-side validation follow-up",
				filesAffected: ["src/Auth.ts", "src/Middleware.ts"],
				category: "feature",
				importance: "major",
			});
		});

		it("filters out topics with placeholder decisions", () => {
			const result = parseSummaryResponse(
				[
					delimited({ title: "A", trigger: "t", response: "r", decisions: "No design decisions recorded" }),
					delimited({ title: "B", trigger: "t", response: "r", decisions: "Chose X for performance." }),
				].join("\n"),
			);

			expect(result.topics).toHaveLength(1);
			expect(result.topics[0].title).toBe("B");
		});

		it("extracts ticketId when response has no topics (no ===TOPIC=== markers)", () => {
			const result = parseSummaryResponse("---TICKETID---\nPROJ-123");
			expect(result.ticketId).toBe("PROJ-123");
			expect(result.topics).toEqual([]);
		});

		it("does not split when delimiters appear inline in content", () => {
			const result = parseSummaryResponse(`===TOPIC===
---TITLE---
Switch format from JSON to delimited text
---TRIGGER---
LLM JSON parsing was failing
---RESPONSE---
Replaced the JSON template with a \`===TOPIC===\` / \`---fieldName---\` format.
---DECISIONS---
Using \`===TOPIC===\` as the topic separator avoids JSON encoding issues.`);

			expect(result.topics).toHaveLength(1);
			expect(result.topics[0].response).toContain("===TOPIC===");
			expect(result.topics[0].decisions).toContain("===TOPIC===");
		});

		it("returns empty topics for unstructured text", () => {
			expect(parseSummaryResponse("not structured at all").topics).toHaveLength(0);
		});

		it("strips markdown code fences before parsing", () => {
			const result = parseSummaryResponse(
				`\`\`\`\n${delimited({
					title: "Fenced topic",
					trigger: "t",
					response: "r",
					decisions: "Some real decisions",
				})}\n\`\`\``,
			);
			expect(result.topics).toHaveLength(1);
			expect(result.topics[0].title).toBe("Fenced topic");
		});

		it("parses plain delimited text without code fences", () => {
			const result = parseSummaryResponse(
				delimited({
					title: "Plain topic",
					trigger: "t",
					response: "r",
					decisions: "Decided without fences",
				}),
			);
			expect(result.topics).toHaveLength(1);
			expect(result.topics[0].title).toBe("Plain topic");
		});

		it("warns when delimited format is detected but yields 0 valid topics", () => {
			// ===TOPIC=== present at end with no content after it — parseDelimitedTopics returns null
			const result = parseSummaryResponse("Some preamble\n===TOPIC===\n");
			expect(result.topics).toHaveLength(0);
		});

		it("filters topics with empty decisions string", () => {
			const result = parseSummaryResponse(delimited({ title: "A", trigger: "t", response: "r", decisions: "" }));
			expect(result.topics).toHaveLength(0);
		});

		it("filters topics with N/A decisions", () => {
			const result = parseSummaryResponse(
				delimited({ title: "A", trigger: "t", response: "r", decisions: "N/A" }),
			);
			expect(result.topics).toHaveLength(0);
		});

		it("returns ticketId from preamble with ===TOPIC=== present", () => {
			const result = parseSummaryResponse(
				`---TICKETID---\nPROJ-999\n${delimited({
					title: "A",
					trigger: "t",
					response: "r",
					decisions: "Real decisions",
				})}`,
			);
			expect(result.ticketId).toBe("PROJ-999");
			expect(result.topics).toHaveLength(1);
		});

		it("returns undefined ticketId when not present", () => {
			const result = parseSummaryResponse(
				delimited({ title: "A", trigger: "t", response: "r", decisions: "Real decisions" }),
			);
			expect(result.ticketId).toBeUndefined();
		});

		it("appends unknown field content to previous known field", () => {
			const result = parseSummaryResponse(
				"===TOPIC===\n---TITLE---\nTest\n---TRIGGER---\nBug found\n---UNKNOWNFIELD---\nExtra content\n---RESPONSE---\nFixed it\n---DECISIONS---\nDecided this way",
			);
			expect(result.topics).toHaveLength(1);
			// Unknown field appended to TRIGGER (the last known field before it)
			expect(result.topics[0].trigger).toContain("Extra content");
		});

		it("ignores unknown fields that appear before any known field", () => {
			const result = parseSummaryResponse(
				"===TOPIC===\n---UNKNOWNFIELD---\nIgnored\n---TITLE---\nTest\n---TRIGGER---\nBug found\n---RESPONSE---\nFixed it\n---DECISIONS---\nDecided this way",
			);

			expect(result.topics).toHaveLength(1);
			expect(result.topics[0].title).toBe("Test");
			expect(result.topics[0].trigger).not.toContain("Ignored");
		});

		it("handles topics missing optional fields (no TODO, CATEGORY, IMPORTANCE)", () => {
			const result = parseSummaryResponse(
				delimited({ title: "Minimal", trigger: "t", response: "r", decisions: "Minimal decisions" }),
			);
			expect(result.topics).toHaveLength(1);
			expect(result.topics[0].todo).toBeUndefined();
			expect(result.topics[0].category).toBeUndefined();
			expect(result.topics[0].importance).toBeUndefined();
			expect(result.topics[0].filesAffected).toBeUndefined();
		});

		it("handles topics with invalid category and importance values", () => {
			const result = parseSummaryResponse(
				delimited({
					title: "Bad metadata",
					trigger: "t",
					response: "r",
					decisions: "Some decision",
					category: "invalid-category",
					importance: "unknown-importance",
				}),
			);
			expect(result.topics).toHaveLength(1);
			expect(result.topics[0].category).toBeUndefined();
			expect(result.topics[0].importance).toBeUndefined();
		});

		it("validates all known category values", () => {
			for (const cat of [
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
			]) {
				const result = parseSummaryResponse(
					delimited({ title: "T", trigger: "t", response: "r", decisions: "d", category: cat }),
				);
				expect(result.topics[0].category).toBe(cat);
			}
		});

		it("validates importance values", () => {
			for (const imp of ["major", "minor"]) {
				const result = parseSummaryResponse(
					delimited({ title: "T", trigger: "t", response: "r", decisions: "d", importance: imp }),
				);
				expect(result.topics[0].importance).toBe(imp);
			}
		});

		it("fills placeholder text for missing required fields", () => {
			// A topic with only DECISIONS (no TITLE, TRIGGER, RESPONSE)
			const result = parseSummaryResponse("===TOPIC===\n---DECISIONS---\nSome decision made");
			expect(result.topics).toHaveLength(1);
			expect(result.topics[0].title).toBe("Topic 1");
			expect(result.topics[0].trigger).toBe("No trigger provided");
			expect(result.topics[0].response).toBe("No response details provided");
			expect(result.topics[0].decisions).toBe("Some decision made");
		});

		it("filters placeholder TODO values", () => {
			const result = parseSummaryResponse(
				delimited({ title: "A", trigger: "t", response: "r", decisions: "d", todo: "None" }),
			);
			expect(result.topics[0].todo).toBeUndefined();
		});

		it("keeps valid TODO values", () => {
			const result = parseSummaryResponse(
				delimited({ title: "A", trigger: "t", response: "r", decisions: "d", todo: "Add unit tests" }),
			);
			expect(result.topics[0].todo).toBe("Add unit tests");
		});

		it("parses filesAffected from comma-separated list", () => {
			const result = parseSummaryResponse(
				delimited({
					title: "A",
					trigger: "t",
					response: "r",
					decisions: "d",
					filesAffected: "src/A.ts, src/B.ts",
				}),
			);
			expect(result.topics[0].filesAffected).toEqual(["src/A.ts", "src/B.ts"]);
		});

		it("parses filesAffected from newline-separated list", () => {
			const result = parseSummaryResponse(
				delimited({
					title: "A",
					trigger: "t",
					response: "r",
					decisions: "d",
					filesAffected: "src/A.ts\nsrc/B.ts",
				}),
			);
			expect(result.topics[0].filesAffected).toEqual(["src/A.ts", "src/B.ts"]);
		});

		it("omits filesAffected when the field only contains empty items", () => {
			const result = parseSummaryResponse(
				delimited({
					title: "A",
					trigger: "t",
					response: "r",
					decisions: "d",
					filesAffected: ",  ,\n   ",
				}),
			);

			expect(result.topics[0].filesAffected).toBeUndefined();
		});
	});

	describe("generateSummary", () => {
		it("uses the unified summarize action and forwards the standard input params", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(`---TICKETID---
PROJ-123
${delimited({
	title: "Fix email validation in login form",
	trigger: "Users were able to submit malformed emails.",
	response: "Added regex check in LoginValidator.ts.",
	decisions: "Used native regex instead of a library.",
})}`),
			);

			const record = await generateSummary({
				conversation: "User: Fix login bug\nAssistant: Done",
				diff: "diff --git a/src/login.ts",
				commitInfo: mockCommitInfo,
				diffStats: { filesChanged: 1, insertions: 50, deletions: 20 },
				transcriptEntries: 10,
				conversationTurns: 5,
				config: mockConfig,
			});

			// Topic-count guidance now lives inside the prompt itself; CLI no longer
			// passes topicGuidance / workSize. params is just the standard input set.
			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "summarize",
					params: {
						commitHash: mockCommitInfo.hash,
						commitMessage: mockCommitInfo.message,
						commitAuthor: mockCommitInfo.author,
						commitDate: mockCommitInfo.date,
						conversation: "User: Fix login bug\nAssistant: Done",
						diff: "diff --git a/src/login.ts",
					},
				}),
			);
			expect(record.ticketId).toBe("PROJ-123");
			expect(record.conversationTurns).toBe(5);
			expect(record.topics).toHaveLength(1);
		});

		it("does not pass any size-derived hint regardless of diff size", async () => {
			mockCallLlm.mockResolvedValue(summaryLlmResult(""));

			// medium-ish: 250 + 100 = 350 lines
			await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: { filesChanged: 1, insertions: 250, deletions: 100 },
				transcriptEntries: 0,
				config: mockConfig,
			});
			// large-ish: 450 + 100 = 550 lines
			await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: { filesChanged: 1, insertions: 450, deletions: 100 },
				transcriptEntries: 0,
				config: mockConfig,
			});

			// Action is always "summarize" and params shape is identical regardless
			// of diff size — bucketing now lives in the prompt itself, not in CLI.
			const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<
				[{ action: string; params: Record<string, unknown> }]
			>;
			for (const call of calls) {
				expect(call[0].action).toBe("summarize");
				expect(call[0].params).not.toHaveProperty("topicGuidance");
				expect(call[0].params).not.toHaveProperty("workSize");
			}
		});

		it("omits conversationTurns from result when not provided", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(delimited({ title: "A", trigger: "t", response: "r", decisions: "d" })),
			);

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.conversationTurns).toBeUndefined();
		});

		it("uses llmResult.model when provided by LLM client", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(delimited({ title: "A", trigger: "t", response: "r", decisions: "d" }), {
					model: "claude-opus-4-6",
				}),
			);

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.llm.model).toBe("claude-opus-4-6");
		});

		it("falls back to resolveModelId when llmResult.model is null", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(delimited({ title: "A", trigger: "t", response: "r", decisions: "d" }), {
					model: null as unknown as string,
				}),
			);

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: { apiKey: "k", model: "haiku" },
			});

			expect(record.llm.model).toBe("claude-haiku-4-5-20251001");
		});

		it("uses llmResult.stopReason when provided", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(delimited({ title: "A", trigger: "t", response: "r", decisions: "d" }), {
					stopReason: "max_tokens",
				}),
			);

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.llm.stopReason).toBe("max_tokens");
		});

		it("sets stopReason to null when llmResult.stopReason is null", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(delimited({ title: "A", trigger: "t", response: "r", decisions: "d" }), {
					stopReason: null as unknown as string,
				}),
			);

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.llm.stopReason).toBeNull();
		});

		it("omits ticketId from result when not present in response", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(delimited({ title: "A", trigger: "t", response: "r", decisions: "d" })),
			);

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.ticketId).toBeUndefined();
		});

		it("parses a response that begins with the ===SUMMARY=== sentinel", async () => {
			// The prompt instructs the LLM to start its response with ===SUMMARY===.
			// When the model complies, the parser must recognise and strip that
			// leading sentinel so the rest of the body is parsed as usual.
			const sentinelResponse = [
				"===SUMMARY===",
				"---TICKETID---",
				"PROJ-7",
				"",
				"---RECAP---",
				"A short recap.",
				"",
				delimited({ title: "Sentinel topic", trigger: "t", response: "r", decisions: "d" }),
			].join("\n");
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult(sentinelResponse));

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.topics).toHaveLength(1);
			expect(record.topics[0].title).toBe("Sentinel topic");
			expect(record.ticketId).toBe("PROJ-7");
			expect(record.recap).toBe("A short recap.");
		});

		it("recovers a trailing ---RECAP--- emitted after the last topic (production failure mode)", async () => {
			// Real strict-retry response observed for commit 922f603e: the LLM
			// emitted topics first and the recap at the end, instead of putting
			// the recap in the preamble. The old preamble-only parser silently
			// dropped the recap AND the trailing marker polluted the last
			// topic's IMPORTANCE field via the unknown-field fallthrough.
			const trailingRecapResponse = [
				delimited({
					title: "First topic",
					trigger: "t1",
					response: "r1",
					decisions: "d1",
					importance: "major",
				}),
				delimited({
					title: "Last topic",
					trigger: "t2",
					response: "r2",
					decisions: "d2",
					importance: "minor",
				}),
				"",
				"---RECAP---",
				"This commit summary recap appears after the last topic.",
				"",
			].join("\n");
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult(trailingRecapResponse));

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.topics).toHaveLength(2);
			// Recap was extracted despite trailing position.
			expect(record.recap).toBe("This commit summary recap appears after the last topic.");
			// Last topic's importance survived intact (no recap content glued onto it).
			expect(record.topics[1].title).toBe("Last topic");
			expect(record.topics[1].importance).toBe("minor");
		});

		it("returns empty topics when both first call and strict-retry are format-incompliant garbage", async () => {
			// First call: non-compliant prose (no top-level marker on first line)
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("random garbage with no structure"));
			// Strict retry: also non-compliant -- code accepts the first-response empty result
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("still no markers, just prose"));

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(mockCallLlm).toHaveBeenCalledTimes(2);
			expect(record.topics).toHaveLength(0);
		});

		it("propagates LLM client errors", async () => {
			mockCallLlm.mockRejectedValueOnce(new Error("No LLM provider available"));

			await expect(
				generateSummary({
					conversation: "",
					diff: "",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 0,
					config: mockConfig,
				}),
			).rejects.toThrow("No LLM provider available");
		});

		it("includes ticketId in result when present in response", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(
					`---TICKETID---\nPROJ-42\n${delimited({ title: "A", trigger: "t", response: "r", decisions: "d" })}`,
				),
			);

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.ticketId).toBe("PROJ-42");
		});

		it("handles empty LLM response (no ===TOPIC=== sections)", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult(""));

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.topics).toHaveLength(0);
		});

		it("handles llmResult.text being null", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("", { text: null as unknown as string }));

			const record = await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: mockDiffStats,
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(record.topics).toHaveLength(0);
		});

		describe("strict-retry on format failure", () => {
			// A long-but-malformed first response: > 100 chars, no ===TOPIC=== / ---TICKETID--- /
			// ---RECAP---. This is the failure mode the retry mechanism guards against
			// (LLM mimics transcript markdown style instead of emitting delimited format).
			const malformedMarkdown =
				"## Session Summary\n\n### Topics\n\n#### 1. Some change\nThis is the first topic in markdown form, with prose only.\n\n#### 2. Another change\nMore prose, no delimiters.\n";

			it("retries with summarize-strict when first response is substantive but parses to zero topics", async () => {
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult(malformedMarkdown))
					.mockResolvedValueOnce(
						summaryLlmResult(
							delimited({ title: "Recovered topic", trigger: "t", response: "r", decisions: "d" }),
						),
					);

				const record = await generateSummary({
					conversation: "transcript with markdown that confused the model",
					diff: "diff",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 5,
					config: mockConfig,
				});

				expect(mockCallLlm).toHaveBeenCalledTimes(2);
				const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<
					[{ action: string; params: Record<string, string> }]
				>;
				expect(calls[0][0].action).toBe("summarize");
				expect(calls[1][0].action).toBe("summarize-strict");
				// Strict retry receives the same standard params plus the failed response.
				expect(calls[1][0].params.previousResponse).toContain("## Session Summary");
				expect(calls[1][0].params.commitHash).toBe(mockCommitInfo.hash);
				expect(record.topics).toHaveLength(1);
				expect(record.topics[0].title).toBe("Recovered topic");
			});

			it("sums LLM metadata across the two calls when retry succeeds", async () => {
				mockCallLlm
					.mockResolvedValueOnce(
						summaryLlmResult(malformedMarkdown, { inputTokens: 100, outputTokens: 50, apiLatencyMs: 1000 }),
					)
					.mockResolvedValueOnce(
						summaryLlmResult(
							delimited({ title: "Recovered topic", trigger: "t", response: "r", decisions: "d" }),
							{ inputTokens: 30, outputTokens: 80, apiLatencyMs: 500 },
						),
					);

				const record = await generateSummary({
					conversation: "x",
					diff: "y",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 1,
					config: mockConfig,
				});

				expect(record.llm.inputTokens).toBe(130);
				expect(record.llm.outputTokens).toBe(130);
				expect(record.llm.apiLatencyMs).toBe(1500);
			});

			it("accepts empty result when both first call and strict-retry produce no topics", async () => {
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult(malformedMarkdown))
					.mockResolvedValueOnce(summaryLlmResult("still markdown ## not delimited format"));

				const record = await generateSummary({
					conversation: "x",
					diff: "y",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 1,
					config: mockConfig,
				});

				expect(mockCallLlm).toHaveBeenCalledTimes(2);
				expect(record.topics).toHaveLength(0);
			});

			it("does NOT retry when first response is empty (legitimate per rule 16)", async () => {
				mockCallLlm.mockResolvedValueOnce(summaryLlmResult(""));

				const record = await generateSummary({
					conversation: "",
					diff: "",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 0,
					config: mockConfig,
				});

				expect(mockCallLlm).toHaveBeenCalledTimes(1);
				expect(record.topics).toHaveLength(0);
			});

			it("does NOT retry when first response is a legitimate recap-only output", async () => {
				// Recap-only is a valid output per rules 16 + 19 (trivial commit, no topics warranted,
				// but recap describes work). First line is `---RECAP---` -- format-compliant.
				mockCallLlm.mockResolvedValueOnce(
					summaryLlmResult(
						"---RECAP---\nThe developer made a small adjustment to formatting in the article sidebar that makes the spacing more consistent across screen sizes.",
					),
				);

				const record = await generateSummary({
					conversation: "x",
					diff: "y",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 1,
					config: mockConfig,
				});

				expect(mockCallLlm).toHaveBeenCalledTimes(1);
				expect(record.topics).toHaveLength(0);
				expect(record.recap).toBeDefined();
			});

			it("does NOT retry when first response is a legitimate ticket-only output", async () => {
				// First line is `---TICKETID---` -- format-compliant even without topics or recap.
				mockCallLlm.mockResolvedValueOnce(summaryLlmResult("---TICKETID---\nPROJ-9"));

				const record = await generateSummary({
					conversation: "x",
					diff: "y",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 1,
					config: mockConfig,
				});

				expect(mockCallLlm).toHaveBeenCalledTimes(1);
				expect(record.ticketId).toBe("PROJ-9");
			});

			it("DOES retry even on a short non-compliant first response (length is no longer the gate)", async () => {
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult("brief no-marker response"))
					.mockResolvedValueOnce(
						summaryLlmResult(
							delimited({ title: "Recovered", trigger: "t", response: "r", decisions: "d" }),
						),
					);

				const record = await generateSummary({
					conversation: "",
					diff: "",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 0,
					config: mockConfig,
				});

				expect(mockCallLlm).toHaveBeenCalledTimes(2);
				expect(record.topics).toHaveLength(1);
				expect(record.topics[0].title).toBe("Recovered");
			});

			it("falls back to first-response result when strict-retry call throws", async () => {
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult(malformedMarkdown))
					.mockRejectedValueOnce(new Error("transient backend error"));

				const record = await generateSummary({
					conversation: "x",
					diff: "y",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 1,
					config: mockConfig,
				});

				expect(mockCallLlm).toHaveBeenCalledTimes(2);
				// First-response had no topics; we accept it.
				expect(record.topics).toHaveLength(0);
			});

			it("truncates very long previousResponse before embedding into the strict retry prompt", async () => {
				const huge = `${"## Header\n".repeat(1000)}`; // ~10000 chars
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult(huge))
					.mockResolvedValueOnce(
						summaryLlmResult(
							delimited({ title: "Recovered", trigger: "t", response: "r", decisions: "d" }),
						),
					);

				await generateSummary({
					conversation: "x",
					diff: "y",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 1,
					config: mockConfig,
				});

				const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<
					[{ action: string; params: Record<string, string> }]
				>;
				const previousResponse = calls[1][0].params.previousResponse;
				expect(previousResponse.length).toBeLessThan(huge.length);
				expect(previousResponse).toContain("[... truncated");
			});

			it("retry result is used even when only ticketId or recap (no topics) is recovered", async () => {
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult(malformedMarkdown))
					.mockResolvedValueOnce(
						summaryLlmResult("---TICKETID---\nPROJ-9\n---RECAP---\nA short recap describing the work."),
					);

				const record = await generateSummary({
					conversation: "x",
					diff: "y",
					commitInfo: mockCommitInfo,
					diffStats: mockDiffStats,
					transcriptEntries: 1,
					config: mockConfig,
				});

				expect(record.topics).toHaveLength(0);
				expect(record.ticketId).toBe("PROJ-9");
				expect(record.recap).toBe("A short recap describing the work.");
			});
		});
	});

	describe("generateCommitMessage", () => {
		it("returns the generated message and only sends action + params", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult('"Part of PROJ-123: Add generateCommitMessage function"'),
			);

			const message = await generateCommitMessage(mockCommitMessageParams);

			expect(message).toBe("Part of PROJ-123: Add generateCommitMessage function");
			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "commit-message",
					params: {
						stagedDiff: "diff --git a/src/Foo.ts\n+++ added line",
						branch: "feature/proj-123-add-commit-message",
						fileList: "src/Foo.ts",
					},
				}),
			);
		});

		it("uses (none) for empty stagedFiles list", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("Update config"));

			await generateCommitMessage({ ...mockCommitMessageParams, stagedFiles: [] });

			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					params: expect.objectContaining({ fileList: "(none)" }),
				}),
			);
		});

		it("handles null text from LLM result", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("", { text: null as unknown as string }));

			const message = await generateCommitMessage(mockCommitMessageParams);
			expect(message).toBe("");
		});

		it("strips single quotes from generated message", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("'Fix the login bug'"));

			const message = await generateCommitMessage(mockCommitMessageParams);
			expect(message).toBe("Fix the login bug");
		});

		it("uses an empty-diff fallback when needed", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("Fix empty diff handling"));

			await generateCommitMessage({ ...mockCommitMessageParams, stagedDiff: "" });

			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					params: expect.objectContaining({
						stagedDiff: "(empty diff -- no staged changes)",
					}),
				}),
			);
		});
	});

	describe("generateSquashMessage", () => {
		it("builds squash params inline and returns the generated message", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("Closes PROJ-123: Improve login reliability"));

			const message = await generateSquashMessage({
				ticketId: "PROJ-123",
				commits: [
					{
						message: "Add login validation",
						topics: [{ title: "Fix login checks", trigger: "Users could bypass login checks" }],
					},
					{
						message: "Refine email handling",
						topics: [{ title: "Fix email regex", trigger: "Malformed emails still slipped through" }],
					},
				],
				isFullSquash: true,
				config: mockConfig,
			});

			expect(message).toBe("Closes PROJ-123: Improve login reliability");
			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "squash-message",
					params: expect.objectContaining({
						ticketLine: "PROJ-123",
						scopeLine: expect.stringContaining("Full squash"),
						commitsBlock: expect.stringContaining("Add login validation"),
					}),
				}),
			);
		});

		it("generates partial squash scope line", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("Partial squash message"));

			await generateSquashMessage({
				ticketId: "PROJ-100",
				commits: [{ message: "First commit", topics: [{ title: "A", trigger: "B" }] }],
				isFullSquash: false,
				config: mockConfig,
			});

			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					params: expect.objectContaining({
						scopeLine: expect.stringContaining("Partial squash"),
					}),
				}),
			);
		});

		it("uses fallback ticketLine when no ticketId provided", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("No ticket message"));

			await generateSquashMessage({
				commits: [{ message: "Fix bug", topics: [] }],
				isFullSquash: true,
				config: mockConfig,
			});

			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					params: expect.objectContaining({
						ticketLine: "No ticket associated",
					}),
				}),
			);
		});

		it("handles null text from squash LLM result", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("", { text: null as unknown as string }));

			const message = await generateSquashMessage({
				commits: [{ message: "Fix", topics: [] }],
				isFullSquash: true,
				config: mockConfig,
			});
			expect(message).toBe("");
		});

		it("shows '(no summary available)' for commits without topics", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("Message"));

			await generateSquashMessage({
				commits: [{ message: "Fix it", topics: [] }],
				isFullSquash: true,
				config: mockConfig,
			});

			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					params: expect.objectContaining({
						commitsBlock: expect.stringContaining("(no summary available)"),
					}),
				}),
			);
		});
	});

	describe("resolveModelId", () => {
		it("resolves known aliases and passes unknown IDs through", () => {
			expect(resolveModelId("haiku")).toBe("claude-haiku-4-5-20251001");
			expect(resolveModelId("sonnet")).toBe("claude-sonnet-4-6");
			expect(resolveModelId("opus")).toBe("claude-opus-4-6");
			expect(resolveModelId(undefined)).toBe("claude-sonnet-4-6");
			expect(resolveModelId("")).toBe("claude-sonnet-4-6");
			expect(resolveModelId("   ")).toBe("claude-sonnet-4-6");
			expect(resolveModelId("claude-future-5-0")).toBe("claude-future-5-0");
		});
	});

	describe("parseE2eTestResponse", () => {
		it("parses delimited scenarios", () => {
			const result = parseE2eTestResponse(`===SCENARIO===
---TITLE---
Article reordering
---PRECONDITIONS---
Have a Space with 3+ articles
---STEPS---
1. Open the app and navigate to a Space
2. Open the chat and type "Move article A up"
---EXPECTED---
- Article A should be one position higher
- Chat shows a confirmation message`);

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				title: "Article reordering",
				preconditions: "Have a Space with 3+ articles",
				steps: ["Open the app and navigate to a Space", 'Open the chat and type "Move article A up"'],
			});
			expect(result[0].expectedResults).toHaveLength(2);
		});

		it("parses scenarios without code fences", () => {
			const result = parseE2eTestResponse(`===SCENARIO===
---TITLE---
Plain scenario
---STEPS---
1. Do something
---EXPECTED---
- It works`);
			expect(result).toHaveLength(1);
			expect(result[0].title).toBe("Plain scenario");
		});

		it("omits preconditions when field is missing", () => {
			const result = parseE2eTestResponse(`===SCENARIO===
---TITLE---
No preconditions
---STEPS---
1. Open app
---EXPECTED---
- Works fine`);
			expect(result).toHaveLength(1);
			expect(result[0].preconditions).toBeUndefined();
		});

		it("appends unknown field content to the last known field", () => {
			const result = parseE2eTestResponse(`===SCENARIO===
---TITLE---
Unknown field test
---STEPS---
1. Do something
---CUSTOM---
This is unknown content
---EXPECTED---
- It works`);

			expect(result).toHaveLength(1);
			expect(result[0].title).toBe("Unknown field test");
			// The unknown CUSTOM field's content should be appended to STEPS (the last known field)
			expect(result[0].steps[0]).toContain("Do something");
		});

		it("ignores unknown fields that appear before any known E2E field", () => {
			const result = parseE2eTestResponse(`===SCENARIO===
---CUSTOM---
Ignored
---TITLE---
Known title
---STEPS---
1. Open app
---EXPECTED---
- Works`);

			expect(result).toHaveLength(1);
			expect(result[0].title).toBe("Known title");
			expect(result[0].steps[0]).not.toContain("Ignored");
		});

		it("skips scenarios with a missing title", () => {
			const result = parseE2eTestResponse(`===SCENARIO===
---STEPS---
1. Open app
---EXPECTED---
- Works`);

			expect(result).toEqual([]);
		});

		it("should handle scenario with steps but no EXPECTED field", () => {
			const result = parseE2eTestResponse(`===SCENARIO===
---TITLE---
No expected results
---STEPS---
1. Do something
2. Check something`);
			expect(result).toHaveLength(1);
			expect(result[0].title).toBe("No expected results");
			expect(result[0].steps).toHaveLength(2);
			expect(result[0].expectedResults).toEqual([]);
		});

		it("should handle scenario with missing STEPS field by defaulting to empty", () => {
			const result = parseE2eTestResponse(`===SCENARIO===
---TITLE---
No steps scenario
---EXPECTED---
- Should work`);
			// No steps → scenario excluded
			expect(result).toHaveLength(0);
		});

		it("handles fenced responses and ignores malformed scenarios", () => {
			const result = parseE2eTestResponse(`\`\`\`
===SCENARIO===
---TITLE---
Fenced scenario
---STEPS---
1. Open app
---EXPECTED---
- Works
===SCENARIO===
---TITLE---
Missing steps
---EXPECTED---
- Not included
\`\`\``);

			expect(result).toHaveLength(1);
			expect(result[0].title).toBe("Fenced scenario");
		});
	});

	describe("generateE2eTest", () => {
		it("passes topics summary and max scenario count", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(`===SCENARIO===
---TITLE---
Test reordering
---STEPS---
1. Open the app
2. Reorder articles
---EXPECTED---
- Articles reorder correctly`),
			);

			const scenarios = await generateE2eTest({
				topics: mockTopics,
				commitMessage: "Fix reorder",
				diff: "diff content",
				config: mockConfig,
			});

			expect(scenarios).toHaveLength(1);
			// Scenario count cap is now embedded in the e2e-test prompt (rule 12);
			// CLI no longer passes a maxScenarios placeholder. The LLM gauges the
			// cap from the topicsSummary content directly.
			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "e2e-test",
					params: expect.objectContaining({
						commitMessage: "Fix reorder",
						diff: "diff content",
						topicsSummary: expect.stringContaining("Add drag-to-reorder for articles"),
					}),
				}),
			);
			const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<[{ params: Record<string, unknown> }]>;
			expect(calls[0][0].params).not.toHaveProperty("maxScenarios");
		});

		it("does not pass any topic-count-derived hint regardless of topic count", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult(""));

			await generateE2eTest({
				topics: Array.from({ length: 5 }, (_, i) => ({
					title: `Topic ${i}`,
					trigger: "t",
					response: "r",
					decisions: "d",
				})),
				commitMessage: "Big change",
				diff: "diff",
				config: mockConfig,
			});

			// The scenario-count tier rule lives in the prompt itself; the CLI
			// passes no scenario hint placeholder.
			const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<[{ params: Record<string, unknown> }]>;
			expect(calls[0][0].params).not.toHaveProperty("maxScenarios");
		});

		it("filters out minor topics before sending to the LLM (saves tokens, focuses on user-visible changes)", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult(""));

			await generateE2eTest({
				topics: [
					{
						title: "User-facing feature",
						trigger: "t",
						response: "r",
						decisions: "d",
						importance: "major",
					},
					{
						title: "Tiny formatting tweak",
						trigger: "t",
						response: "r",
						decisions: "d",
						importance: "minor",
					},
					{
						title: "Topic with no importance set (defaults to included)",
						trigger: "t",
						response: "r",
						decisions: "d",
					},
				],
				commitMessage: "Mixed change",
				diff: "diff",
				config: mockConfig,
			});

			const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<[{ params: Record<string, string> }]>;
			const summary = calls[0][0].params.topicsSummary;
			expect(summary).toContain("User-facing feature");
			expect(summary).toContain("Topic with no importance set");
			expect(summary).not.toContain("Tiny formatting tweak");
		});

		it("returns no scenarios and skips the LLM call when every topic is minor", async () => {
			const result = await generateE2eTest({
				topics: [
					{ title: "x", trigger: "t", response: "r", decisions: "d", importance: "minor" },
					{ title: "y", trigger: "t", response: "r", decisions: "d", importance: "minor" },
				],
				commitMessage: "Trivia only",
				diff: "diff",
				config: mockConfig,
			});

			expect(result).toEqual([]);
			expect(mockCallLlm).not.toHaveBeenCalled();
		});
	});

	describe("generateE2eTest — null text fallback", () => {
		it("should return empty array when LLM returns null text", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("", { text: null as unknown as string }));

			const result = await generateE2eTest({
				commitMessage: "Fix bug",
				topics: [{ title: "Fix", trigger: "Bug", response: "Fixed", decisions: "D" }],
				diff: "+1 -1",
				config: mockConfig,
			});

			expect(result).toEqual([]);
		});
	});

	describe("parseRecapResponse", () => {
		it("strips the leading ---RECAP--- marker and returns the body trimmed", () => {
			const text = `---RECAP---\nThe developer added drag-handle reordering.\n\nA second paragraph follows.\n`;
			expect(parseRecapResponse(text)).toBe(
				"The developer added drag-handle reordering.\n\nA second paragraph follows.",
			);
		});

		it("returns empty string for empty input", () => {
			expect(parseRecapResponse("")).toBe("");
			expect(parseRecapResponse("   \n\t  ")).toBe("");
		});

		it("falls back to whole text when the marker is missing", () => {
			// Defensive against LLMs that occasionally drop the leading marker.
			expect(parseRecapResponse("The developer added X.")).toBe("The developer added X.");
		});

		it("strips an echoed closing ---RECAP--- marker if the model wraps the body", () => {
			const text = `---RECAP---\nA recap paragraph.\n---RECAP---\n`;
			expect(parseRecapResponse(text)).toBe("A recap paragraph.");
		});

		it("handles surrounding whitespace before the marker", () => {
			const text = `\n\n   \n---RECAP---\nText after whitespace.\n`;
			expect(parseRecapResponse(text)).toBe("Text after whitespace.");
		});
	});

	describe("generateRecap", () => {
		it("returns the parsed recap and skips the diff in the LLM payload", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult("---RECAP---\nThe developer reorganised the article sidebar."),
			);

			const recap = await generateRecap({
				topics: mockTopics,
				commitMessage: "Refactor sidebar",
				config: mockConfig,
			});

			expect(recap).toBe("The developer reorganised the article sidebar.");
			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "recap",
					params: expect.objectContaining({
						commitMessage: "Refactor sidebar",
						topicsSummary: expect.stringContaining("Add drag-to-reorder for articles"),
					}),
				}),
			);
			const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<[{ params: Record<string, unknown> }]>;
			// Recap re-generation deliberately does NOT pass the diff (token-saving;
			// recap is a narrative over already-extracted topics, not fresh code analysis).
			expect(calls[0][0].params).not.toHaveProperty("diff");
		});

		it("formats topicsSummary using narrative fields only (no response field leakage)", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("---RECAP---\nx"));

			await generateRecap({
				topics: mockTopics,
				commitMessage: "msg",
				config: mockConfig,
			});

			const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<[{ params: Record<string, string> }]>;
			const summary = calls[0][0].params.topicsSummary;
			// Title, Trigger, Decisions are present (narrative).
			expect(summary).toContain("Add drag-to-reorder for articles");
			expect(summary).toContain("**Trigger:** Users wanted to reorder articles");
			expect(summary).toContain("**Decisions:** Used a simple swap algorithm");
			// Response is implementation-detail and must not appear.
			expect(summary).not.toContain("Implemented drag-and-drop reordering via the chat agent");
		});

		it("filters out minor topics before sending to the LLM", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("---RECAP---\ny"));

			await generateRecap({
				topics: [
					{
						title: "Major change",
						trigger: "t",
						response: "r",
						decisions: "d",
						importance: "major",
					},
					{
						title: "Tiny tweak",
						trigger: "t",
						response: "r",
						decisions: "d",
						importance: "minor",
					},
				],
				commitMessage: "Mixed",
				config: mockConfig,
			});

			const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<[{ params: Record<string, string> }]>;
			const summary = calls[0][0].params.topicsSummary;
			expect(summary).toContain("Major change");
			expect(summary).not.toContain("Tiny tweak");
		});

		it("returns empty string and skips the LLM call when every topic is minor", async () => {
			const result = await generateRecap({
				topics: [
					{ title: "x", trigger: "t", response: "r", decisions: "d", importance: "minor" },
					{ title: "y", trigger: "t", response: "r", decisions: "d", importance: "minor" },
				],
				commitMessage: "Trivia only",
				config: mockConfig,
			});

			expect(result).toBe("");
			expect(mockCallLlm).not.toHaveBeenCalled();
		});

		it("returns empty string when the LLM produces no text", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("", { text: null as unknown as string }));

			const result = await generateRecap({
				topics: mockTopics,
				commitMessage: "msg",
				config: mockConfig,
			});

			expect(result).toBe("");
		});

		it("uses the configured model alias", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("---RECAP---\ntext"));

			await generateRecap({
				topics: mockTopics,
				commitMessage: "msg",
				config: { model: "haiku" },
			});

			expect(mockCallLlm).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5-20251001" }));
		});
	});

	describe("translateToEnglish", () => {
		it("returns translated text and sends only action + params", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("# Implementation Plan\n\n## Step 1\n\nModify files"));

			const result = await translateToEnglish({
				content: "# 实施计划\n\n## 步骤一\n\n修改文件",
				config: mockConfig,
			});

			expect(result).toBe("# Implementation Plan\n\n## Step 1\n\nModify files");
			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "translate",
					params: { content: "# 实施计划\n\n## 步骤一\n\n修改文件" },
				}),
			);
		});

		it("uses the configured model alias", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("translated"));

			await translateToEnglish({ content: "test", config: { model: "haiku" } });

			expect(mockCallLlm).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-4-5-20251001" }));
		});

		it("should return empty string when LLM returns null text", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("", { text: null as unknown as string }));

			const result = await translateToEnglish({ content: "test", config: mockConfig });

			expect(result).toBe("");
		});
	});

	// ── Squash consolidation API ──────────────────────────────────

	describe("parseTopLevelFields", () => {
		it("returns nothing when the text is empty", () => {
			const out = parseTopLevelFields("");
			expect(out.ticketId).toBeUndefined();
			expect(out.recap).toBeUndefined();
			expect(out.sanitizedText).toBe("");
		});

		it("extracts a TICKETID-only preamble", () => {
			const out = parseTopLevelFields("---TICKETID---\nPROJ-7\n");
			expect(out.ticketId).toBe("PROJ-7");
			expect(out.recap).toBeUndefined();
		});

		it("extracts a RECAP-only preamble (recap-only commit)", () => {
			const out = parseTopLevelFields("---RECAP---\nA paragraph about the work.\n");
			expect(out.recap).toContain("A paragraph");
			expect(out.ticketId).toBeUndefined();
		});

		it("extracts both TICKETID and RECAP when both are present in preamble", () => {
			const out = parseTopLevelFields(
				"---TICKETID---\nPROJ-9\n\n---RECAP---\nDid stuff.\n\n===TOPIC===\n---TITLE---\nT",
			);
			expect(out.ticketId).toBe("PROJ-9");
			expect(out.recap).toBe("Did stuff.");
			// Sanitized text starts with ===TOPIC=== — preamble fields excised.
			expect(out.sanitizedText.trimStart()).toMatch(/^===TOPIC===/);
		});

		it("normalises lowercase ---ticketId--- (legacy responses)", () => {
			const out = parseTopLevelFields("---ticketId---\nproj-1\n");
			expect(out.ticketId).toBe("proj-1");
		});

		it("preserves multi-line recap content", () => {
			const out = parseTopLevelFields("---RECAP---\nLine A.\n\nLine B.\n");
			expect(out.recap).toContain("Line A.");
			expect(out.recap).toContain("Line B.");
		});

		it("extracts RECAP that appears AFTER the last topic (production failure mode)", () => {
			// Real LLM strict-retry output observed in production for commit
			// 922f603e: the model emitted topics first and the recap at the end.
			// The old preamble-only parser silently dropped this recap and the
			// trailing marker polluted the last topic's IMPORTANCE field.
			const text = [
				"===TOPIC===",
				"---TITLE---",
				"First topic",
				"---IMPORTANCE---",
				"major",
				"",
				"===TOPIC===",
				"---TITLE---",
				"Last topic",
				"---IMPORTANCE---",
				"minor",
				"",
				"---RECAP---",
				"Trailing recap that summarises both topics.",
				"",
			].join("\n");
			const out = parseTopLevelFields(text);
			expect(out.recap).toBe("Trailing recap that summarises both topics.");
			// Sanitized text must keep both topics intact and drop the trailing recap.
			expect(out.sanitizedText).toContain("===TOPIC===");
			expect(out.sanitizedText).not.toContain("---RECAP---");
			expect(out.sanitizedText).not.toContain("Trailing recap");
			// Last topic's IMPORTANCE block must still be parseable as "minor"
			// (no recap content glued onto it via the unknown-field fallthrough).
			expect(out.sanitizedText).toMatch(/---IMPORTANCE---\s*\n\s*minor\s*$/m);
		});

		it("peels the leading ===SUMMARY=== sentinel (new format) and parses the body normally", () => {
			const text = [
				"===SUMMARY===",
				"---TICKETID---",
				"PROJ-7",
				"",
				"---RECAP---",
				"Quick recap.",
				"",
				"===TOPIC===",
				"---TITLE---",
				"T",
			].join("\n");
			const out = parseTopLevelFields(text);
			expect(out.ticketId).toBe("PROJ-7");
			expect(out.recap).toBe("Quick recap.");
			// Sanitized body starts with ===TOPIC=== (sentinel + preamble fields stripped).
			expect(out.sanitizedText.trimStart()).toMatch(/^===TOPIC===/);
		});

		it("treats a ===SUMMARY===-only response as a valid empty summary", () => {
			const out = parseTopLevelFields("===SUMMARY===\n");
			expect(out.ticketId).toBeUndefined();
			expect(out.recap).toBeUndefined();
			expect(out.sanitizedText.trim()).toBe("");
		});

		it("first-occurrence wins when LLM emits the same field twice", () => {
			const text = [
				"---RECAP---",
				"Canonical preamble recap.",
				"",
				"===TOPIC===",
				"---TITLE---",
				"T",
				"",
				"---RECAP---",
				"Duplicate trailing recap.",
			].join("\n");
			const out = parseTopLevelFields(text);
			expect(out.recap).toBe("Canonical preamble recap.");
			// Both marker+content regions excised.
			expect(out.sanitizedText).not.toContain("Canonical preamble recap.");
			expect(out.sanitizedText).not.toContain("Duplicate trailing recap.");
		});
	});

	describe("extractTicketIdFromMessage", () => {
		it("extracts a canonical PROJ-N ticket from a commit message", () => {
			expect(extractTicketIdFromMessage("PROJ-1: do thing")).toBe("PROJ-1");
		});

		it("returns the canonical (already-uppercased) form when the message has it", () => {
			expect(extractTicketIdFromMessage("Part of FEAT-7: title")).toBe("FEAT-7");
		});

		it("does not match lowercase tickets in commit messages (canonical form is required)", () => {
			// extractTicketIdFromMessage is intentionally strict on the prefix case --
			// commit messages should already carry the canonical PROJ-N form. Loose
			// matching belongs in the branch fallback (SummaryFormat.extractTicketFallback).
			expect(extractTicketIdFromMessage("part of feat-7")).toBeUndefined();
		});

		it("returns undefined when the message has no ticket-shaped token", () => {
			expect(extractTicketIdFromMessage("just a regular commit")).toBeUndefined();
		});
	});

	describe("formatSourceCommitsForSquash", () => {
		const baseSource: SquashConsolidationSource = {
			commitHash: "aaaaaaaa11111111",
			commitDate: "2026-03-15T10:00:00Z",
			commitMessage: "first",
			topics: [{ title: "T1", trigger: "tr", response: "re", decisions: "de" }],
		};

		it("renders a single source without a recap line when recap is absent", () => {
			const block = formatSourceCommitsForSquash([baseSource]);
			expect(block).toContain("=== Commit 1 of 1 ===");
			expect(block).toContain("Hash: aaaaaaaa");
			expect(block).toContain("Message: first");
			expect(block).not.toContain("Recap:");
		});

		it("emits a Recap line when a source carries one", () => {
			const block = formatSourceCommitsForSquash([{ ...baseSource, recap: "Brief paragraph." }]);
			expect(block).toContain("Recap: Brief paragraph.");
		});

		it("sorts by commitDate ascending so the prompt is always oldest-first", () => {
			const a: SquashConsolidationSource = { ...baseSource, commitDate: "2026-03-15T10:00:00Z" };
			const b: SquashConsolidationSource = {
				...baseSource,
				commitHash: "bbbbbbbb22222222",
				commitDate: "2026-03-10T10:00:00Z",
				commitMessage: "earlier",
			};
			const block = formatSourceCommitsForSquash([a, b]);
			const earlierIdx = block.indexOf("Message: earlier");
			const laterIdx = block.indexOf("Message: first");
			expect(earlierIdx).toBeGreaterThan(-1);
			expect(earlierIdx).toBeLessThan(laterIdx);
		});

		it("emits the '(no topics recorded)' marker when a source has zero topics", () => {
			const block = formatSourceCommitsForSquash([{ ...baseSource, topics: [] }]);
			expect(block).toContain("(no topics recorded for this commit)");
		});

		it("renders all optional topic fields when present", () => {
			const block = formatSourceCommitsForSquash([
				{
					...baseSource,
					ticketId: "JM-9",
					topics: [
						{
							title: "Full topic",
							trigger: "tr",
							response: "re",
							decisions: "de",
							todo: "follow up",
							category: "feature",
							importance: "major",
							filesAffected: ["src/A.ts", "src/B.ts"],
						},
					],
				},
			]);
			expect(block).toContain("Ticket: JM-9");
			expect(block).toContain("Todo: follow up");
			expect(block).toContain("Category: feature");
			expect(block).toContain("Importance: major");
			expect(block).toContain("Files: src/A.ts, src/B.ts");
		});
	});

	describe("mechanicalConsolidate", () => {
		const src = (
			hash: string,
			date: string,
			topicTitle: string,
			ticketId?: string,
			recap?: string,
		): SquashConsolidationSource => ({
			commitHash: hash,
			commitDate: date,
			commitMessage: `msg ${hash}`,
			...(ticketId && { ticketId }),
			...(recap && { recap }),
			topics: [{ title: topicTitle, trigger: "t", response: "r", decisions: "d" }],
		});

		it("concatenates topics and recaps in oldest-first order", () => {
			const a = src("a", "2026-03-10T00:00:00Z", "older");
			const b = src("b", "2026-03-20T00:00:00Z", "newer", undefined, "B's recap");
			const c = src("c", "2026-03-15T00:00:00Z", "middle", undefined, "C's recap");
			const result = mechanicalConsolidate([b, a, c]); // intentionally unsorted
			expect(result.topics.map((t) => t.title)).toEqual(["older", "middle", "newer"]);
			// Recap concatenation also follows oldest-first.
			expect(result.recap).toBe("C's recap\n\nB's recap");
		});

		it("returns recap undefined when no source carries one", () => {
			const result = mechanicalConsolidate([src("a", "2026-03-10T00:00:00Z", "x")]);
			expect(result.recap).toBeUndefined();
		});

		it("prefers the outerTicketId argument over per-source ticketIds", () => {
			const a = src("a", "2026-03-10T00:00:00Z", "x", "PER-1");
			const b = src("b", "2026-03-15T00:00:00Z", "y", "PER-2");
			expect(mechanicalConsolidate([a, b], "OUTER-99").ticketId).toBe("OUTER-99");
		});

		it("falls back to the earliest source's ticketId when outerTicketId is undefined", () => {
			const a = src("a", "2026-03-10T00:00:00Z", "x", "PER-A");
			const b = src("b", "2026-03-15T00:00:00Z", "y", "PER-B");
			expect(mechanicalConsolidate([b, a]).ticketId).toBe("PER-A");
		});

		it("returns ticketId undefined when neither outer nor any source carries one", () => {
			const a = src("a", "2026-03-10T00:00:00Z", "x");
			expect(mechanicalConsolidate([a]).ticketId).toBeUndefined();
		});
	});

	describe("generateSquashConsolidation", () => {
		const sourceWithTopic = (hash: string, date: string, ticketId?: string): SquashConsolidationSource => ({
			commitHash: hash,
			commitDate: date,
			commitMessage: `msg ${hash}`,
			...(ticketId && { ticketId }),
			topics: [{ title: "Topic", trigger: "t", response: "r", decisions: "Real decision" }],
		});

		const params = (sources: ReadonlyArray<SquashConsolidationSource>, outer?: string) => ({
			squashCommitMessage: "Squash commit",
			...(outer && { ticketId: outer }),
			sources,
			config: mockConfig,
		});

		it("returns null when there are no sources", async () => {
			const result = await generateSquashConsolidation(params([]));
			expect(result).toBeNull();
			expect(mockCallLlm).not.toHaveBeenCalled();
		});

		it("returns null when every source has empty topics and no recap", async () => {
			const empty: SquashConsolidationSource = {
				commitHash: "a",
				commitDate: "2026-03-10T00:00:00Z",
				commitMessage: "m",
				topics: [],
			};
			const result = await generateSquashConsolidation(params([empty]));
			expect(result).toBeNull();
			expect(mockCallLlm).not.toHaveBeenCalled();
		});

		it("invokes the LLM with the squash-consolidate action and returns parsed topics", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(
					"---TICKETID---\nPROJ-1\n\n---RECAP---\nA recap.\n\n===TOPIC===\n---TITLE---\nMerged topic\n---TRIGGER---\nt\n---RESPONSE---\nr\n---DECISIONS---\nReal decision\n",
				),
			);
			const result = await generateSquashConsolidation(params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]));
			expect(result).not.toBeNull();
			expect(result?.topics[0].title).toBe("Merged topic");
			expect(result?.recap).toBe("A recap.");
			expect(result?.ticketId).toBe("PROJ-1");
			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "squash-consolidate",
					params: expect.objectContaining({
						squashMessage: "Squash commit",
						sourceCommitsBlock: expect.stringContaining("=== Commit 1 of 1 ==="),
					}),
				}),
			);
		});

		it("recovers a trailing ---RECAP--- emitted after the last topic (production failure mode)", async () => {
			// Squash shares parseSummaryResponse with the commit/amend path, so the
			// trailing-recap fix in parseTopLevelFields applies here too. This test
			// pins that contract: a future refactor that bypasses parseTopLevelFields
			// in the squash orchestrator would lose recap on the same failure mode
			// observed for commit 922f603e.
			const trailingRecapResponse = [
				"===TOPIC===",
				"---TITLE---",
				"First merged topic",
				"---TRIGGER---",
				"t1",
				"---RESPONSE---",
				"r1",
				"---DECISIONS---",
				"Real decision",
				"---IMPORTANCE---",
				"major",
				"",
				"===TOPIC===",
				"---TITLE---",
				"Last merged topic",
				"---TRIGGER---",
				"t2",
				"---RESPONSE---",
				"r2",
				"---DECISIONS---",
				"Real decision",
				"---IMPORTANCE---",
				"minor",
				"",
				"---RECAP---",
				"Consolidated recap that arrived after the last topic.",
				"",
			].join("\n");
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult(trailingRecapResponse));

			const result = await generateSquashConsolidation(params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]));

			expect(result).not.toBeNull();
			expect(result?.topics).toHaveLength(2);
			expect(result?.recap).toBe("Consolidated recap that arrived after the last topic.");
			// Last topic's importance survived intact (no recap content glued onto it).
			expect(result?.topics[1].title).toBe("Last merged topic");
			expect(result?.topics[1].importance).toBe("minor");
		});

		it("prefers the outer ticketId over the LLM-extracted one (priority chain)", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(
					"---TICKETID---\nLLM-1\n\n===TOPIC===\n---TITLE---\nT\n---TRIGGER---\nt\n---RESPONSE---\nr\n---DECISIONS---\nReal decision\n",
				),
			);
			const result = await generateSquashConsolidation(
				params([sourceWithTopic("a", "2026-03-10T00:00:00Z", "PER-A")], "OUTER-99"),
			);
			expect(result?.ticketId).toBe("OUTER-99");
		});

		it("falls back to the earliest source's ticketId when no outer ticketId and the LLM omits one", async () => {
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(
					"===TOPIC===\n---TITLE---\nT\n---TRIGGER---\nt\n---RESPONSE---\nr\n---DECISIONS---\nReal decision\n",
				),
			);
			const result = await generateSquashConsolidation(
				params([
					sourceWithTopic("a", "2026-03-10T00:00:00Z", "FROM-A"),
					sourceWithTopic("b", "2026-03-20T00:00:00Z", "FROM-B"),
				]),
			);
			expect(result?.ticketId).toBe("FROM-A");
		});

		it("returns null when the LLM produces no topics and no recap", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult(""));
			const result = await generateSquashConsolidation(params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]));
			expect(result).toBeNull();
		});

		it("retries once on transient API failure and returns the second attempt's result", async () => {
			mockCallLlm.mockRejectedValueOnce(new Error("transient"));
			mockCallLlm.mockResolvedValueOnce(
				summaryLlmResult(
					"===TOPIC===\n---TITLE---\nRetried\n---TRIGGER---\nt\n---RESPONSE---\nr\n---DECISIONS---\nReal decision\n",
				),
			);
			const result = await generateSquashConsolidation(params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]));
			expect(result?.topics[0].title).toBe("Retried");
			expect(mockCallLlm).toHaveBeenCalledTimes(2);
		});

		it("returns null when both attempts fail", async () => {
			mockCallLlm.mockRejectedValueOnce(new Error("first")).mockRejectedValueOnce(new Error("second"));
			const result = await generateSquashConsolidation(params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]));
			expect(result).toBeNull();
			expect(mockCallLlm).toHaveBeenCalledTimes(2);
		});

		describe("strict-retry on format failure", () => {
			const malformedMarkdown =
				"## Consolidated Summary\n\n### Squashed Topics\n\nThis squash combined several commits into one cohesive feature, with prose-only formatting and no delimiter markers anywhere.\n";

			it("retries with squash-consolidate-strict when first response is substantive but parses to zero topics + no recap", async () => {
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult(malformedMarkdown))
					.mockResolvedValueOnce(
						summaryLlmResult(
							"===TOPIC===\n---TITLE---\nRecovered\n---TRIGGER---\nt\n---RESPONSE---\nr\n---DECISIONS---\nReal decision\n",
						),
					);
				const result = await generateSquashConsolidation(
					params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]),
				);
				expect(mockCallLlm).toHaveBeenCalledTimes(2);
				const calls = mockCallLlm.mock.calls as unknown as ReadonlyArray<
					[{ action: string; params: Record<string, string> }]
				>;
				expect(calls[0][0].action).toBe("squash-consolidate");
				expect(calls[1][0].action).toBe("squash-consolidate-strict");
				expect(calls[1][0].params.previousResponse).toContain("## Consolidated Summary");
				expect(result?.topics[0].title).toBe("Recovered");
			});

			it("sums LLM tokens across the two calls when squash strict-retry succeeds", async () => {
				mockCallLlm
					.mockResolvedValueOnce(
						summaryLlmResult(malformedMarkdown, {
							inputTokens: 200,
							outputTokens: 100,
							apiLatencyMs: 2000,
						}),
					)
					.mockResolvedValueOnce(
						summaryLlmResult(
							"===TOPIC===\n---TITLE---\nRecovered\n---TRIGGER---\nt\n---RESPONSE---\nr\n---DECISIONS---\nReal decision\n",
							{ inputTokens: 50, outputTokens: 80, apiLatencyMs: 700 },
						),
					);
				const result = await generateSquashConsolidation(
					params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]),
				);
				expect(result?.llm?.inputTokens).toBe(250);
				expect(result?.llm?.outputTokens).toBe(180);
				expect(result?.llm?.apiLatencyMs).toBe(2700);
			});

			it("falls through to null when both squash-consolidate and squash-consolidate-strict fail format check", async () => {
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult(malformedMarkdown))
					.mockResolvedValueOnce(summaryLlmResult("more markdown ## still no delimiters"));
				const result = await generateSquashConsolidation(
					params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]),
				);
				expect(mockCallLlm).toHaveBeenCalledTimes(2);
				expect(result).toBeNull();
			});

			it("does NOT retry strict when first response is empty (format-compliant but no consolidation)", async () => {
				// Empty response is format-compliant. Squash needs SOMETHING to consolidate, so
				// we fall through to null (caller does mechanicalConsolidate) without burning a retry.
				mockCallLlm.mockResolvedValueOnce(summaryLlmResult(""));
				const result = await generateSquashConsolidation(
					params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]),
				);
				expect(mockCallLlm).toHaveBeenCalledTimes(1);
				expect(result).toBeNull();
			});

			it("DOES retry strict on short non-compliant first response (length is no longer the gate)", async () => {
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult("brief"))
					.mockResolvedValueOnce(
						summaryLlmResult(
							"===TOPIC===\n---TITLE---\nRecovered\n---TRIGGER---\nt\n---RESPONSE---\nr\n---DECISIONS---\nReal decision\n",
						),
					);
				const result = await generateSquashConsolidation(
					params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]),
				);
				expect(mockCallLlm).toHaveBeenCalledTimes(2);
				expect(result?.topics[0].title).toBe("Recovered");
			});

			it("falls through to null when squash-consolidate-strict throws", async () => {
				mockCallLlm
					.mockResolvedValueOnce(summaryLlmResult(malformedMarkdown))
					.mockRejectedValueOnce(new Error("strict retry transient error"));
				const result = await generateSquashConsolidation(
					params([sourceWithTopic("a", "2026-03-10T00:00:00Z")]),
				);
				expect(mockCallLlm).toHaveBeenCalledTimes(2);
				expect(result).toBeNull();
			});
		});
	});
});
