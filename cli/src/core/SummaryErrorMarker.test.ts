import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../Types.js";
import { isSummaryError, LLM_FAILED, withSummaryError } from "./SummaryErrorMarker.js";

const baseSummary: CommitSummary = {
	version: 4,
	commitHash: "a".repeat(40),
	commitMessage: "msg",
	commitAuthor: "x",
	commitDate: "2026-01-01T00:00:00.000Z",
	branch: "main",
	generatedAt: "2026-01-01T00:00:00.000Z",
	transcriptEntries: 0,
	stats: { filesChanged: 0, insertions: 0, deletions: 0 },
	topics: [],
};

describe("SummaryErrorMarker", () => {
	it("isSummaryError returns true when summaryError is set", () => {
		expect(isSummaryError({ ...baseSummary, summaryError: LLM_FAILED })).toBe(true);
	});

	it("isSummaryError returns true on legacy stopReason='error' summaries", () => {
		const legacy: CommitSummary = {
			...baseSummary,
			llm: {
				model: "claude-x",
				inputTokens: 0,
				outputTokens: 0,
				apiLatencyMs: 0,
				stopReason: "error",
			},
		};
		expect(isSummaryError(legacy)).toBe(true);
	});

	it("isSummaryError returns false on healthy summaries", () => {
		expect(isSummaryError(baseSummary)).toBe(false);
	});

	it("isSummaryError returns false when stopReason is 'end_turn'", () => {
		const healthy: CommitSummary = {
			...baseSummary,
			llm: {
				model: "claude-x",
				inputTokens: 0,
				outputTokens: 0,
				apiLatencyMs: 0,
				stopReason: "end_turn",
			},
		};
		expect(isSummaryError(healthy)).toBe(false);
	});

	it("isSummaryError returns false when stopReason is 'max_tokens' (truncation, not failure)", () => {
		const truncated: CommitSummary = {
			...baseSummary,
			llm: {
				model: "claude-x",
				inputTokens: 0,
				outputTokens: 0,
				apiLatencyMs: 0,
				stopReason: "max_tokens",
			},
		};
		expect(isSummaryError(truncated)).toBe(false);
	});

	it("isSummaryError returns false when stopReason is null", () => {
		const nullStop: CommitSummary = {
			...baseSummary,
			llm: {
				model: "claude-x",
				inputTokens: 0,
				outputTokens: 0,
				apiLatencyMs: 0,
				stopReason: null,
			},
		};
		expect(isSummaryError(nullStop)).toBe(false);
	});

	it("withSummaryError attaches the marker", () => {
		const marked = withSummaryError(baseSummary);
		expect(marked.summaryError).toBe(LLM_FAILED);
	});

	it("withSummaryError is idempotent on already-marked summaries", () => {
		const marked = withSummaryError({ ...baseSummary, summaryError: LLM_FAILED });
		expect(marked.summaryError).toBe(LLM_FAILED);
	});

	it("withSummaryError does not mutate the input summary", () => {
		const input = { ...baseSummary };
		withSummaryError(input);
		expect(input.summaryError).toBeUndefined();
	});
});
