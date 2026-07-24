import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenCodeBackend } from "./OpenCodeBackend.js";
import { LocalAgentAuthError, LocalAgentSetupError } from "./Types.js";

const fixture = readFileSync(join(__dirname, "__fixtures__/opencode/success.json"), "utf8");
const b = new OpenCodeBackend();

describe("OpenCodeBackend", () => {
	it("returns the assistant text verbatim from stdout (no envelope)", () => {
		const out = b.parseResult(fixture);
		expect(out.text).toContain("42");
		expect(out.text).toBe(fixture.trim());
		expect(out.inputTokens).toBe(0);
		expect(out.outputTokens).toBe(0);
		expect(out.cachedTokens).toBe(0);
		expect(out.costUsd).toBe(0);
		expect(out.stopReason).toBeNull();
	});

	it("throws LocalAgentSetupError on empty stdout", () => {
		expect(() => b.parseResult("")).toThrow(LocalAgentSetupError);
		expect(() => b.parseResult("   \n  ")).toThrow(LocalAgentSetupError);
	});

	// False-positive guard (grounded in this repo's real use case): a genuine,
	// structured commit summary that itself mentions "login" / "authenticate" /
	// "error" must be returned verbatim, NOT misread as an auth failure. The
	// length gate in looksLikeOpenCodeAuthError is what makes this safe.
	it("returns a real summary that mentions auth vocabulary (no false positive)", () => {
		const summary = [
			"## Summary",
			"Fixed the login error handling in the auth middleware so an unauthorized",
			"request no longer crashes. Added a credential check and a sign in retry.",
			"### Details",
			"The authenticate() call now validates the api key before use.",
			// pad well past the auth-line length gate, as a real summary always is
			"More context ".repeat(40),
		].join("\n");
		const out = b.parseResult(summary);
		expect(out.text).toBe(summary.trim());
	});

	// Illustrative positive case. NOTE: opencode's exact auth-failure wording is
	// unverified (no logged-out fixture captured yet) — this asserts the
	// classifier's behaviour on a representative short error line, not a
	// guaranteed real opencode string.
	it("classifies a short auth-failure line as LocalAgentAuthError", () => {
		expect(() => b.parseResult("Error: not logged in. Run `opencode auth login`.")).toThrow(LocalAgentAuthError);
		expect(() => b.parseResult("No provider configured")).toThrow(LocalAgentAuthError);
	});

	it("does NOT scrub provider credentials (BYOK), sets child-reentry env, isolates cwd", () => {
		process.env.OPENCODE_TEST_KEY = "x";
		const inv = b.buildInvocation(
			{ file: "opencode", version: "1" },
			{ prompt: "hi", model: "", systemPrompt: "sys" },
		);
		expect(inv.env.OPENCODE_TEST_KEY).toBe("x");
		delete process.env.OPENCODE_TEST_KEY;
		expect(inv.env.JOLLI_LOCAL_AGENT_CHILD).toBe("1");
		expect(inv.cwd).toContain("jolli-localagent-");
		expect(inv.stdin).toBe("");
		// system prompt is prepended into the prompt positional; no --model since empty
		expect(inv.args).toEqual(["run", "sys\n\nhi"]);
	});

	it("includes --model when a model is requested", () => {
		const inv = b.buildInvocation(
			{ file: "opencode", version: "1" },
			{ prompt: "hi", model: "anthropic/claude-sonnet", systemPrompt: "" },
		);
		expect(inv.args).toEqual(["run", "--model", "anthropic/claude-sonnet", "hi"]);
	});
});
