import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexBackend } from "./CodexBackend.js";
import * as resolver from "./ExecutableResolver.js";
import { LocalAgentAuthError, LocalAgentSetupError } from "./Types.js";

const fixture = readFileSync(join(__dirname, "__fixtures__/codex/success.json"), "utf8");
const b = new CodexBackend();

describe("CodexBackend", () => {
	it("parses the real JSONL success stream into text and real usage tokens", () => {
		const out = b.parseResult(fixture);
		expect(out.text).toContain("42");
		expect(out.inputTokens).toBe(18019);
		expect(out.outputTokens).toBe(42);
		expect(out.cachedTokens).toBe(1920);
		expect(out.costUsd).toBe(0);
		expect(out.stopReason).toBeNull();
	});

	it("does not blank the text when turn.completed follows item.completed", () => {
		const stream = [
			JSON.stringify({ type: "thread.started", thread_id: "abc" }),
			JSON.stringify({ type: "turn.started" }),
			JSON.stringify({
				type: "item.completed",
				item: { id: "item_0", type: "agent_message", text: "hello 42" },
			}),
			JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
		].join("\n");
		const out = b.parseResult(stream);
		expect(out.text).toBe("hello 42");
	});

	it("scrubs OPENAI_API_KEY and OPENAI_BASE_URL, sets child-reentry env", () => {
		const inv = b.buildInvocation(
			{ file: "codex", version: "1" },
			{ prompt: "hi", model: "", systemPrompt: "sys" },
		);
		expect(inv.env.OPENAI_API_KEY).toBeUndefined();
		expect(inv.env.OPENAI_BASE_URL).toBeUndefined();
		expect(inv.env.JOLLI_LOCAL_AGENT_CHILD).toBe("1");
		expect(inv.cwd).toContain("jolli-localagent-");
		expect(inv.stdin).toBe("");
		expect(inv.args).toEqual([
			"exec",
			"--json",
			"--skip-git-repo-check",
			"-s",
			"read-only",
			"-C",
			inv.cwd,
			"sys\n\nhi",
		]);
	});

	it("includes -m when a model is requested", () => {
		const inv = b.buildInvocation(
			{ file: "codex", version: "1" },
			{ prompt: "hi", model: "gpt-5", systemPrompt: "" },
		);
		expect(inv.args).toEqual([
			"exec",
			"--json",
			"--skip-git-repo-check",
			"-s",
			"read-only",
			"-C",
			inv.cwd,
			"-m",
			"gpt-5",
			"hi",
		]);
	});

	it("classifies an auth-phrased error event", () => {
		const stream = JSON.stringify({ type: "error", message: "please login to continue: unauthorized" });
		expect(() => b.parseResult(stream)).toThrow(LocalAgentAuthError);
	});

	it("throws LocalAgentSetupError when no JSON event is parsed at all", () => {
		expect(() => b.parseResult("not json\nalso not json\n")).toThrow(LocalAgentSetupError);
	});

	it("ignores blank and non-JSON lines without throwing", () => {
		expect(() => b.parseResult('\nnot json\n{"type":"turn.completed"}\n')).not.toThrow();
	});
});

describe("CodexBackend.buildInvocation with launcher args", () => {
	it("prepends launchArgs ahead of the `exec` subcommand", () => {
		const inv = b.buildInvocation(
			{ file: "node.exe", version: "1", launchArgs: ["cli.js"] },
			{ prompt: "hi", model: "", systemPrompt: "" },
		);
		expect(inv.args.slice(0, 2)).toEqual(["cli.js", "exec"]);
	});
});

describe("CodexBackend.isPresent", () => {
	it("is false for an override path that does not exist", () => {
		expect(new CodexBackend().isPresent("/nonexistent/path/to/codex")).toBe(false);
	});

	it("delegates to the CODEX_SPEC discovery, not another tool's", () => {
		const spy = vi.spyOn(resolver, "isPresent").mockReturnValue(true);
		expect(new CodexBackend().isPresent()).toBe(true);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ binName: "codex" }), { overridePath: undefined });
	});
});
