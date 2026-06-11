import { describe, expect, it } from "vitest";
import type { CommitSummary } from "../../../cli/src/Types.js";
import { buildSummaryErrorBanner } from "./SummaryErrorBanner.js";

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

describe("buildSummaryErrorBanner", () => {
	it("returns empty string for a healthy summary", () => {
		expect(buildSummaryErrorBanner(baseSummary)).toBe("");
	});

	it("renders banner with #summaryErrorRegenerateBtn when summaryError is set", () => {
		const html = buildSummaryErrorBanner({ ...baseSummary, summaryError: "llm-failed" });
		expect(html).toContain('class="summary-error-banner"');
		expect(html).toContain('id="summaryErrorRegenerateBtn"');
		expect(html).toContain("Summary generation failed");
		expect(html).toContain('role="status"');
	});

	it("renders banner for legacy summaries with llm.stopReason === 'error'", () => {
		const legacy: CommitSummary = {
			...baseSummary,
			llm: { model: "claude", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "error" },
		};
		expect(buildSummaryErrorBanner(legacy)).toContain('class="summary-error-banner"');
	});

	it("does NOT render banner when stopReason is 'max_tokens' (truncation, not failure)", () => {
		const truncated: CommitSummary = {
			...baseSummary,
			llm: { model: "claude", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "max_tokens" },
		};
		expect(buildSummaryErrorBanner(truncated)).toBe("");
	});

	it("does NOT render banner when stopReason is 'end_turn' (healthy)", () => {
		const healthy: CommitSummary = {
			...baseSummary,
			llm: { model: "claude", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "end_turn" },
		};
		expect(buildSummaryErrorBanner(healthy)).toBe("");
	});

	it("readOnly mode omits the Regenerate button and CTA text", () => {
		// Foreign-readonly / stale-readonly hide the Regenerate button via CSS.
		// Emitting a "Click Regenerate" CTA in those modes would be a dead
		// instruction. The banner still renders so the user knows the summary
		// is degraded, but without the button or the misleading instruction.
		const html = buildSummaryErrorBanner({ ...baseSummary, summaryError: "llm-failed" }, { readOnly: true });
		expect(html).toContain('class="summary-error-banner"');
		expect(html).not.toContain('id="summaryErrorRegenerateBtn"');
		expect(html).not.toContain("Click Regenerate");
		expect(html).toContain("incomplete");
	});

	it("readOnly mode still renders banner for legacy stopReason='error'", () => {
		const legacy: CommitSummary = {
			...baseSummary,
			llm: { model: "claude", inputTokens: 0, outputTokens: 0, apiLatencyMs: 0, stopReason: "error" },
		};
		const html = buildSummaryErrorBanner(legacy, { readOnly: true });
		expect(html).toContain('class="summary-error-banner"');
		expect(html).not.toContain('id="summaryErrorRegenerateBtn"');
	});

	it("needsGeneration renders the Generate-memory variant with #generateMemoryBtn", () => {
		// A never-summarized commit is not a failed one — distinct copy + a
		// Generate (not Regenerate) button wired to the from-scratch path.
		const html = buildSummaryErrorBanner(baseSummary, { needsGeneration: true });
		expect(html).toContain('class="summary-error-banner"');
		expect(html).toContain('id="generateMemoryBtn"');
		expect(html).toContain("No memory has been generated");
		expect(html).not.toContain('id="summaryErrorRegenerateBtn"');
	});

	it("needsGeneration takes precedence over a healthy summary (no isSummaryError needed)", () => {
		// The placeholder shell passed on the open-empty path has no summaryError
		// marker, so the needsGeneration flag must drive the variant on its own.
		const html = buildSummaryErrorBanner(baseSummary, { needsGeneration: true });
		expect(html).not.toBe("");
		expect(html).toContain('id="generateMemoryBtn"');
	});

	it("needsGeneration + readOnly omits the Generate button (foreign repo)", () => {
		// Generating writes the workspace orphan branch — never offer it for a
		// foreign-repo placeholder.
		const html = buildSummaryErrorBanner(baseSummary, { needsGeneration: true, readOnly: true });
		expect(html).toContain('class="summary-error-banner"');
		expect(html).not.toContain('id="generateMemoryBtn"');
		expect(html).toContain("Open its home repository");
	});
});
