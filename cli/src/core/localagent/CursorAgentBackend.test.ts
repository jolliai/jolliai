import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CursorAgentBackend } from "./CursorAgentBackend.js";
import { LocalAgentAuthError, LocalAgentSetupError } from "./Types.js";

const fixture = readFileSync(join(__dirname, "__fixtures__/cursor-agent/success.json"), "utf8");
const b = new CursorAgentBackend();

describe("CursorAgentBackend", () => {
	it("parses the real success envelope into text and real usage tokens", () => {
		const out = b.parseResult(fixture);
		expect(out.text).toContain("42"); // the JSON the probe prompt forced
		expect(out.inputTokens).toBe(21614);
		expect(out.outputTokens).toBe(25);
		expect(out.cachedTokens).toBe(256); // cacheReadTokens(256) + cacheWriteTokens(0)
		expect(out.costUsd).toBe(0); // cursor exposes no cost in headless json
		expect(out.stopReason).toBe("success");
	});

	it("scrubs CURSOR_API_KEY, sets child-reentry env, and denies repo cwd pollution", () => {
		const inv = b.buildInvocation(
			{ file: "cursor-agent", version: "1" },
			{ prompt: "hi", model: "", systemPrompt: "sys" },
		);
		expect(inv.env.CURSOR_API_KEY).toBeUndefined();
		expect(inv.env.JOLLI_LOCAL_AGENT_CHILD).toBe("1");
		expect(inv.cwd).toContain("jolli-localagent-");
		expect(inv.stdin).toBe("");
		// no system-prompt flag exists — it must be prepended into the prompt arg
		expect(inv.args).toEqual(["-p", "--output-format", "json", "--trust", "sys\n\nhi"]);
	});

	it("includes --model when a model is requested", () => {
		const inv = b.buildInvocation(
			{ file: "cursor-agent", version: "1" },
			{ prompt: "hi", model: "sonnet-4", systemPrompt: "" },
		);
		expect(inv.args).toEqual(["-p", "--output-format", "json", "--trust", "--model", "sonnet-4", "hi"]);
	});

	it("classifies an is_error auth envelope", () => {
		expect(() =>
			b.parseResult(
				JSON.stringify({ type: "result", is_error: true, subtype: "not_logged_in", result: "please log in" }),
			),
		).toThrow(LocalAgentAuthError);
	});

	it("classifies a non-auth is_error envelope as a setup error", () => {
		expect(() =>
			b.parseResult(
				JSON.stringify({ type: "result", is_error: true, subtype: "error", result: "something broke" }),
			),
		).toThrow(LocalAgentSetupError);
	});

	it("throws LocalAgentSetupError on non-JSON stdout", () => {
		expect(() => b.parseResult("not json")).toThrow(LocalAgentSetupError);
	});
});
