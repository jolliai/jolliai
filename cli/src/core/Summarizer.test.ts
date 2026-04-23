import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmCallResult } from "./LlmClient.js";

const mockCallLlm = vi.fn<() => Promise<LlmCallResult>>();
vi.mock("./LlmClient.js", () => ({
	callLlm: (...args: unknown[]) => mockCallLlm(...args),
}));

vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

import type { CommitInfo, CommitMessageParams, DiffStats } from "../Types.js";
import {
	generateCommitMessage,
	generateE2eTest,
	generateSquashMessage,
	generateSummary,
	parseE2eTestResponse,
	parseSummaryResponse,
	resolveModelId,
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

		it("extracts ticketId and supports explicit no-topics responses", () => {
			const result = parseSummaryResponse("---TICKETID---\nPROJ-123\n\n===NO_TOPICS===");
			expect(result.ticketId).toBe("PROJ-123");
			expect(result.topics).toEqual([]);
			expect(result.intentionallyEmpty).toBe(true);
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
		it("uses summarize:small and forwards params without a prompt", async () => {
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

			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "summarize:small",
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

		it("switches summarize action based on diff size", async () => {
			mockCallLlm.mockResolvedValue(summaryLlmResult("===NO_TOPICS==="));

			await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: { filesChanged: 1, insertions: 250, deletions: 100 },
				transcriptEntries: 0,
				config: mockConfig,
			});
			await generateSummary({
				conversation: "",
				diff: "",
				commitInfo: mockCommitInfo,
				diffStats: { filesChanged: 1, insertions: 450, deletions: 100 },
				transcriptEntries: 0,
				config: mockConfig,
			});

			expect(mockCallLlm.mock.calls[0][0]).toMatchObject({ action: "summarize:medium" });
			expect(mockCallLlm.mock.calls[1][0]).toMatchObject({ action: "summarize:large" });
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

		it("logs error-level response when parsing yields zero topics", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("random garbage with no structure"));

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

		it("handles intentionallyEmpty response (NO_TOPICS)", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("===NO_TOPICS==="));

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
			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					action: "e2e-test",
					params: expect.objectContaining({
						commitMessage: "Fix reorder",
						diff: "diff content",
						maxScenarios: "5",
						topicsSummary: expect.stringContaining("Add drag-to-reorder for articles"),
					}),
				}),
			);
		});

		it("uses a larger scenario cap for larger topic counts", async () => {
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

			expect(mockCallLlm).toHaveBeenCalledWith(
				expect.objectContaining({
					params: expect.objectContaining({ maxScenarios: "10" }),
				}),
			);
		});
	});

	describe("generateE2eTest — null text fallback", () => {
		it("should return empty array when LLM returns null text", async () => {
			mockCallLlm.mockResolvedValueOnce(summaryLlmResult("", { text: null as unknown as string }));

			const result = await generateE2eTest({
				commitMessage: "Fix bug",
				topics: [{ title: "Fix", trigger: "Bug", response: "Fixed", decisions: "D" }],
				diffSummary: "+1 -1",
				config: mockConfig,
			});

			expect(result).toEqual([]);
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
});
