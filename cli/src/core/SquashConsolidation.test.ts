import { describe, expect, it, vi } from "vitest";
import type { CommitSummary } from "../Types.js";

vi.mock("./Summarizer.js", async () => {
	const actual = await vi.importActual<typeof import("./Summarizer.js")>("./Summarizer.js");
	return {
		...actual,
		generateSquashConsolidation: vi.fn(),
	};
});

const { generateSquashConsolidation } = await import("./Summarizer.js");
const { consolidateSquashSources } = await import("./SquashConsolidation.js");

function src(hash: string): CommitSummary {
	return {
		version: 5,
		commitHash: hash,
		commitMessage: `m ${hash}`,
		commitAuthor: "T",
		commitDate: "2026-08-17T00:00:00.000Z",
		branch: "main",
		generatedAt: "2026-08-17T00:00:00.000Z",
		topics: [{ title: `t-${hash}`, trigger: "trig", response: "resp", decisions: "dec" }],
		recap: `r-${hash}`,
	};
}

describe("consolidateSquashSources", () => {
	it("returns the LLM result when the call succeeds", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({
			status: "ok",
			topics: [{ title: "merged" }],
			recap: "merged recap",
			llm: { model: "m" },
		} as never);

		const out = await consolidateSquashSources([src("a"), src("b")], "squashed", {
			onFailure: "throw",
			useLlm: true,
		});
		expect(out?.status).toBe("llm");
		expect(out?.topics).toEqual([{ title: "merged" }]);
	});

	it("reports the expanded SOURCE counts so callers need not re-expand for logging", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({
			status: "ok",
			topics: [{ title: "merged" }],
			llm: { model: "m" },
		} as never);

		// Two sources, one topic each → 2 sources, 2 source-topics. These describe
		// the INPUTS, not the merged result (which has one topic).
		const out = await consolidateSquashSources([src("a"), src("b")], "squashed", {
			onFailure: "throw",
			useLlm: true,
		});
		expect(out.sourceCount).toBe(2);
		expect(out.sourceTopicCount).toBe(2);
	});

	it("reports source counts on the mechanical path too", async () => {
		const out = await consolidateSquashSources([src("a"), src("b"), src("c")], "squashed", {
			onFailure: "throw",
			useLlm: false,
		});
		expect(out.status).toBe("mechanical");
		expect(out.sourceCount).toBe(3);
		expect(out.sourceTopicCount).toBe(3);
	});

	it("throws under the throw policy when the LLM errors", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({ status: "llm-error" } as never);

		await expect(
			consolidateSquashSources([src("a")], "squashed", { onFailure: "throw", useLlm: true }),
		).rejects.toThrow(/--no-llm/);
	});

	it("degrades to a mechanical merge under the mechanical policy", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({ status: "llm-error" } as never);

		const out = await consolidateSquashSources([src("a"), src("b")], "squashed", {
			onFailure: "mechanical",
			useLlm: true,
		});
		expect(out?.status).toBe("mechanical");
		expect(out?.topics.length).toBeGreaterThan(0);
	});

	it("never calls the LLM when useLlm is false", async () => {
		vi.mocked(generateSquashConsolidation).mockClear();
		const out = await consolidateSquashSources([src("a")], "squashed", {
			onFailure: "throw",
			useLlm: false,
		});
		expect(generateSquashConsolidation).not.toHaveBeenCalled();
		expect(out?.status).toBe("mechanical");
	});

	it("inherits summaryError from a degraded source under the mechanical fallback", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({ status: "llm-error" } as never);
		const degraded: CommitSummary = { ...src("a"), summaryError: "llm-failed" };

		const out = await consolidateSquashSources([degraded, src("b")], "squashed", {
			onFailure: "mechanical",
			useLlm: true,
		});
		expect(out?.status).toBe("mechanical");
		expect((out as { summaryError?: string } | undefined)?.summaryError).toBe("llm-failed");
	});

	it("does not mark summaryError on a healthy no-content mechanical fallback", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({ status: "no-content" } as never);

		const out = await consolidateSquashSources([src("a")], "squashed", {
			onFailure: "mechanical",
			useLlm: true,
		});
		expect(out?.status).toBe("mechanical");
		expect((out as { summaryError?: string } | undefined)?.summaryError).toBeUndefined();
	});

	it("does not throw when there is nothing to consolidate, even under the throw policy", async () => {
		vi.mocked(generateSquashConsolidation).mockResolvedValue({ status: "no-content" } as never);

		const out = await consolidateSquashSources([src("a")], "squashed", { onFailure: "throw", useLlm: true });

		expect(out?.status).toBe("mechanical");
		expect(out?.summaryError).toBeUndefined();
	});

	// A runtime throw from inside the try (a `loadConfig` failure, a malformed
	// outcome object) is a different arm from every `llm-error` case above:
	// those RETURN before the catch, so `mockResolvedValue` never reaches it.
	// Both policies' catch arms are covered here, which is the only way the
	// "mechanical" one is exercised at all.
	it("re-throws a runtime failure under the throw policy", async () => {
		vi.mocked(generateSquashConsolidation).mockRejectedValue(new Error("loadConfig exploded"));

		await expect(
			consolidateSquashSources([src("a")], "squashed", { onFailure: "throw", useLlm: true }),
		).rejects.toThrow(/loadConfig exploded/);
	});

	it("degrades a runtime failure to a marked mechanical merge under the mechanical policy", async () => {
		vi.mocked(generateSquashConsolidation).mockRejectedValue(new Error("loadConfig exploded"));

		const out = await consolidateSquashSources([src("a"), src("b")], "squashed", {
			onFailure: "mechanical",
			useLlm: true,
		});
		expect(out.status).toBe("mechanical");
		// Unconditionally marked: this is a real failure, not inherited state.
		expect(out.summaryError).toBeDefined();
		expect(out.topics.length).toBeGreaterThan(0);
	});
});
