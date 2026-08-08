import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmCallResult } from "../core/LlmClient.js";
import type { JolliMemoryConfig } from "../Types.js";

const mockCallLlm = vi.fn<(opts: unknown) => Promise<LlmCallResult>>();
const mockLogWarn = vi.fn();

vi.mock("../core/LlmClient.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/LlmClient.js")>()),
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

function llmResult(text: string | undefined, overrides: Partial<LlmCallResult> = {}): LlmCallResult {
	return {
		text,
		model: "claude-haiku-4-5-20251001",
		inputTokens: 50,
		outputTokens: 20,
		cachedTokens: 0,
		apiLatencyMs: 120,
		stopReason: "end_turn",
		source: "anthropic-config",
		...overrides,
	};
}

const config: JolliMemoryConfig = { apiKey: "sk-ant-test" };

const { getDecisionGist } = await import("./DecisionGist.js");

describe("getDecisionGist", () => {
	beforeEach(() => {
		mockCallLlm.mockReset();
		mockLogWarn.mockReset();
	});

	it("returns the trimmed one-sentence gist from a successful call", async () => {
		mockCallLlm.mockResolvedValueOnce(llmResult("  Picked SQLite for local durability.  "));

		const gist = await getDecisionGist(
			"commit-1",
			"- **Picked SQLite**: needed local durability without a server.",
			config,
		);

		expect(gist).toBe("Picked SQLite for local durability.");
		expect(mockCallLlm).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "decision-gist",
				params: { text: "- **Picked SQLite**: needed local durability without a server." },
				model: "claude-haiku-4-5-20251001",
			}),
		);
	});

	it("caches by commit hash and does not call the LLM again for the same commit", async () => {
		mockCallLlm.mockResolvedValueOnce(llmResult("Picked SQLite."));

		const first = await getDecisionGist("commit-2", "full decision text", config);
		const second = await getDecisionGist("commit-2", "full decision text", config);

		expect(first).toBe("Picked SQLite.");
		expect(second).toBe("Picked SQLite.");
		expect(mockCallLlm).toHaveBeenCalledTimes(1);
	});

	it("fails open (returns undefined) when the LLM call throws", async () => {
		mockCallLlm.mockRejectedValueOnce(new Error("no credentials configured"));

		const gist = await getDecisionGist("commit-3", "full decision text", config);

		expect(gist).toBeUndefined();
		expect(mockLogWarn).toHaveBeenCalled();
	});

	it("fails open (returns undefined) when the LLM returns empty text", async () => {
		mockCallLlm.mockResolvedValueOnce(llmResult(undefined));

		const gist = await getDecisionGist("commit-4", "full decision text", config);

		expect(gist).toBeUndefined();
	});

	it("caches a failed call so a repeated ask does not re-spend", async () => {
		// This is the only route on an unauthenticated GET that costs money, and the
		// Stats page re-asks every 30 s. A negative entry bounds the spend by the
		// number of distinct decisions ever seen instead of by request volume; the
		// cached answer ("show the raw text") is a fine one to keep for a process.
		mockCallLlm.mockRejectedValueOnce(new Error("timeout"));
		mockCallLlm.mockResolvedValueOnce(llmResult("Picked SQLite."));

		const first = await getDecisionGist("commit-5", "full decision text", config);
		const second = await getDecisionGist("commit-5", "full decision text", config);

		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(mockCallLlm).toHaveBeenCalledTimes(1);
	});

	it("re-asks when the SAME commit's decision text changed", async () => {
		// A regenerated summary keeps its hash and replaces its decision, so a
		// hash-only cache key served the old gist beside the new text forever.
		mockCallLlm.mockResolvedValueOnce(llmResult("First gist."));
		mockCallLlm.mockResolvedValueOnce(llmResult("Second gist."));

		expect(await getDecisionGist("commit-6", "original text", config)).toBe("First gist.");
		expect(await getDecisionGist("commit-6", "regenerated text", config)).toBe("Second gist.");
		expect(mockCallLlm).toHaveBeenCalledTimes(2);
	});
});
