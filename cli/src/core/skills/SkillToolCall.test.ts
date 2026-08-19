import { describe, expect, it } from "vitest";
import type { SkillUse } from "../../Types.js";
import { skillUseToToolCall } from "./SkillToolCall.js";

describe("skillUseToToolCall", () => {
	it("keeps namespace, detection, usage and the newest valid invocation instant", () => {
		const use: SkillUse = {
			source: "codex",
			skill: "code-review",
			plugin: "superpowers",
			entryPaths: ["tool"],
			detection: "heuristic",
			invocations: [
				{ at: "not-a-date", ok: true, entryPath: "tool" },
				{ at: "2026-08-01T10:00:00.000Z", ok: true, entryPath: "tool" },
				{ at: "2026-08-01T11:00:00.000Z", ok: false, entryPath: "tool" },
			],
		};
		const usage = { input: 10, output: 5, cached: 2, confidence: "estimated" as const };

		expect(skillUseToToolCall(use, usage)).toEqual({
			name: "code-review",
			kind: "skill",
			calls: 3,
			plugin: "superpowers",
			lastCallAtMs: Date.parse("2026-08-01T11:00:00.000Z"),
			usage,
			invocations: use.invocations,
			detection: "heuristic",
		});
	});

	it("does not invent optional enrichment for an empty scan", () => {
		const use: SkillUse = {
			source: "opencode",
			skill: "plain",
			entryPaths: [],
			invocations: [],
		};
		expect(skillUseToToolCall(use, undefined)).toEqual({ name: "plain", kind: "skill", calls: 0 });
	});
});
