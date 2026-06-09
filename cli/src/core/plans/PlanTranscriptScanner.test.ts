import { describe, expect, it } from "vitest";
import { claudePlanScanner } from "./ClaudePlanScanner.js";
import { codexPlanScanner } from "./CodexPlanScanner.js";
import { getPlanScanner } from "./PlanTranscriptScanner.js";

describe("getPlanScanner", () => {
	it('returns the Codex scanner for "codex"', () => {
		expect(getPlanScanner("codex")).toBe(codexPlanScanner);
	});

	it('returns the Claude scanner for "claude"', () => {
		expect(getPlanScanner("claude")).toBe(claudePlanScanner);
	});

	it("defaults to the Claude scanner when no source is passed", () => {
		expect(getPlanScanner()).toBe(claudePlanScanner);
	});

	it("falls back to the Claude scanner for an unknown/other source", () => {
		expect(getPlanScanner("gemini")).toBe(claudePlanScanner);
		expect(getPlanScanner("opencode")).toBe(claudePlanScanner);
	});
});
