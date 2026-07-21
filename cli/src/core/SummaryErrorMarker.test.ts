import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../Types.js";
import { LocalAgentAuthError, LocalAgentSetupError } from "./localagent/Types.js";
import {
	classifyLlmFailure,
	isLocalAgentAuthError,
	isSummaryError,
	LLM_FAILED,
	LOCAL_AGENT_AUTH,
	withSummaryError,
} from "./SummaryErrorMarker.js";

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

	it("classifyLlmFailure maps a LocalAgentAuthError to the auth-specific kind", () => {
		expect(classifyLlmFailure(new LocalAgentAuthError("expired"))).toBe(LOCAL_AGENT_AUTH);
	});

	it("classifyLlmFailure maps any other error to the generic kind", () => {
		expect(classifyLlmFailure(new LocalAgentSetupError("boom"))).toBe(LLM_FAILED);
		expect(classifyLlmFailure(new Error("network"))).toBe(LLM_FAILED);
	});

	it("classifyLlmFailure matches by name so it survives esbuild class duplication", () => {
		// A structurally-equal object with the right `name` (mimicking a
		// cross-bundle copy where instanceof would fail) is still classified.
		expect(classifyLlmFailure({ name: "LocalAgentAuthError", message: "x" })).toBe(LOCAL_AGENT_AUTH);
	});

	it("classifyLlmFailure tolerates null / undefined", () => {
		expect(classifyLlmFailure(null)).toBe(LLM_FAILED);
		expect(classifyLlmFailure(undefined)).toBe(LLM_FAILED);
	});

	it("isLocalAgentAuthError is true only for the auth marker", () => {
		expect(isLocalAgentAuthError({ summaryError: LOCAL_AGENT_AUTH })).toBe(true);
		expect(isLocalAgentAuthError({ summaryError: LLM_FAILED })).toBe(false);
		expect(isLocalAgentAuthError({ summaryError: undefined })).toBe(false);
	});
});
