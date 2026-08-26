import { describe, expect, it } from "vitest";
import { skillOutcomeConfidence } from "./SkillOutcomeConfidence.js";

describe("skillOutcomeConfidence", () => {
	it("reports observed for the four mechanisms with a result record", () => {
		// Each of these was read off a real transcript: Claude's `tool_result`, Kimi's
		// paired `tool.result`, OpenCode's `state.status`, Hermes' paired `skill_view`
		// result row. See the module docblock.
		expect(skillOutcomeConfidence("claude", "tool")).toBe("observed");
		expect(skillOutcomeConfidence("kimi", "tool")).toBe("observed");
		expect(skillOutcomeConfidence("opencode", "tool")).toBe("observed");
		expect(skillOutcomeConfidence("hermes", "tool")).toBe("observed");
	});

	it("reports assumed when a result-capable mechanism has not produced its result yet", () => {
		expect(skillOutcomeConfidence("claude", "tool", false)).toBe("assumed");
		expect(skillOutcomeConfidence("kimi", "tool", false)).toBe("assumed");
		expect(skillOutcomeConfidence("hermes", "tool", false)).toBe("assumed");
	});

	it("does not let an explicit observation promote a mechanism outside the allowlist", () => {
		expect(skillOutcomeConfidence("codex", "tool", true)).toBe("assumed");
	});

	it("reports assumed for a Claude slash command, which has no result record", () => {
		// The path that matters most in practice: measured on one machine, five of seven
		// Claude skills were entered this way and none of them can report a failure.
		expect(skillOutcomeConfidence("claude", "command")).toBe("assumed");
	});

	it("reports assumed for both Codex paths", () => {
		// The injected block is a definite ENTRY but carries no outcome, and the shell
		// read is not an entry event at all — so neither can be believed about success.
		expect(skillOutcomeConfidence("codex", "command")).toBe("assumed");
		expect(skillOutcomeConfidence("codex", "tool")).toBe("assumed");
	});

	it("reports assumed when the mechanism is unknown", () => {
		// A stored history predating `entryPath` deserializes without it. An unknown
		// mechanism cannot have been verified to report outcomes, so it takes the weaker
		// answer rather than the likelier-looking one.
		expect(skillOutcomeConfidence("claude", undefined)).toBe("assumed");
		expect(skillOutcomeConfidence("kimi", undefined)).toBe("assumed");
	});

	it("reports assumed for a source the table does not name", () => {
		// The allowlist's whole point: a source added without a verified reading of its
		// outcome field degrades to "we cannot say" instead of claiming it reports one.
		// `cursor` is the live case — it has skills but no invocation record at all.
		expect(skillOutcomeConfidence("cursor", "tool")).toBe("assumed");
		expect(skillOutcomeConfidence("gemini", "tool")).toBe("assumed");
		expect(skillOutcomeConfidence("some-future-agent", "command")).toBe("assumed");
	});

	it("keys on the pair, not on either half alone", () => {
		// `claude` reports outcomes and `command` does not report them anywhere, so a
		// lookup that considered only the source (or only the mechanism) would answer
		// differently for at least one of these two.
		expect(skillOutcomeConfidence("claude", "tool")).toBe("observed");
		expect(skillOutcomeConfidence("claude", "command")).toBe("assumed");
		expect(skillOutcomeConfidence("codex", "tool")).toBe("assumed");
	});
});
