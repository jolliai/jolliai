import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as resolver from "./ExecutableResolver.js";
import { KimiCodeBackend, kimiKnownPaths } from "./KimiCodeBackend.js";
import { LocalAgentSetupError } from "./Types.js";

const fixture = readFileSync(join(__dirname, "__fixtures__/kimi/success.json"), "utf8");
const b = new KimiCodeBackend();

describe("KimiCodeBackend", () => {
	it("extracts the assistant content from the JSONL stream, ignoring the meta line", () => {
		const out = b.parseResult(fixture);
		expect(out.text).toBe('{"ok":true,"n":42}');
		expect(out.text).not.toContain("resume"); // the {role:meta} resume-hint line is dropped
		expect(out.inputTokens).toBe(0);
		expect(out.outputTokens).toBe(0);
		expect(out.cachedTokens).toBe(0);
		expect(out.costUsd).toBe(0);
		expect(out.stopReason).toBeNull();
	});

	it("takes the LAST assistant line and skips non-JSON noise", () => {
		const stream = [
			"warming up…", // non-JSON noise line — skipped
			JSON.stringify({ role: "assistant", content: "first" }),
			JSON.stringify({ role: "meta", type: "session.resume_hint", content: "To resume: kimi -r x" }),
			JSON.stringify({ role: "assistant", content: "final answer" }),
		].join("\n");
		expect(b.parseResult(stream).text).toBe("final answer");
	});

	it("throws LocalAgentSetupError on empty stdout", () => {
		expect(() => b.parseResult("")).toThrow(LocalAgentSetupError);
		expect(() => b.parseResult("   \n  ")).toThrow(LocalAgentSetupError);
	});

	it("throws when stdout has JSONL lines but no assistant content (e.g. only a meta line)", () => {
		const onlyMeta = JSON.stringify({ role: "meta", type: "session.resume_hint", content: "To resume: kimi -r x" });
		expect(() => b.parseResult(onlyMeta)).toThrow(LocalAgentSetupError);
	});

	it("scrubs Moonshot credentials, sets child-reentry env, isolates cwd, prepends system prompt", () => {
		process.env.MOONSHOT_API_KEY = "sk-moonshot-test";
		process.env.MOONSHOT_BASE_URL = "https://example.invalid";
		const inv = b.buildInvocation(
			{ file: "kimi", version: "0.1" },
			{ prompt: "hi", model: "", systemPrompt: "sys" },
		);
		expect(inv.env.MOONSHOT_API_KEY).toBeUndefined();
		expect(inv.env.MOONSHOT_BASE_URL).toBeUndefined();
		delete process.env.MOONSHOT_API_KEY;
		delete process.env.MOONSHOT_BASE_URL;
		expect(inv.env.JOLLI_LOCAL_AGENT_CHILD).toBe("1");
		expect(inv.cwd).toContain("jolli-localagent-");
		expect(inv.stdin).toBe("");
		// one-shot prompt mode, JSONL output; system prompt prepended into the
		// --prompt value; no --model since empty (kimi uses its own default_model).
		expect(inv.args).toEqual(["--output-format", "stream-json", "--prompt", "sys\n\nhi"]);
	});

	it("includes --model when a model is requested", () => {
		const inv = b.buildInvocation(
			{ file: "kimi", version: "0.1" },
			{ prompt: "hi", model: "kimi-k3", systemPrompt: "" },
		);
		expect(inv.args).toEqual(["--model", "kimi-k3", "--output-format", "stream-json", "--prompt", "hi"]);
	});

	it("prepends launchArgs ahead of the flags (interpreter launcher case)", () => {
		const inv = b.buildInvocation(
			{ file: "node.exe", version: "0.1", launchArgs: ["cli.js"] },
			{ prompt: "hi", model: "", systemPrompt: "" },
		);
		expect(inv.args).toEqual(["cli.js", "--output-format", "stream-json", "--prompt", "hi"]);
	});
});

describe("KimiCodeBackend.isPresent", () => {
	it("is false for an override path that does not exist", () => {
		expect(new KimiCodeBackend().isPresent("/nonexistent/path/to/kimi")).toBe(false);
	});

	it("delegates to the KIMI_SPEC discovery, not another tool's", () => {
		const spy = vi.spyOn(resolver, "isPresent").mockReturnValue(true);
		expect(new KimiCodeBackend().isPresent()).toBe(true);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ binName: "kimi" }), { overridePath: undefined });
		spy.mockRestore();
	});
});

describe("KimiCodeBackend.discoverExecutable", () => {
	// resolveExecutable throws synchronously (before Promise.resolve wraps it), so
	// discoverExecutable throws rather than rejecting — same shape as CodexBackend.
	// isLocalAgentUsable's `await` in a try/catch catches it either way.
	it("throws LocalAgentSetupError for an override path that is not a working kimi CLI", () => {
		expect(() => new KimiCodeBackend().discoverExecutable("/nonexistent/path/to/kimi")).toThrow(
			LocalAgentSetupError,
		);
	});
});

describe("kimiKnownPaths", () => {
	it("returns the native .exe install locations on win32", () => {
		expect(kimiKnownPaths("C:\\Users\\me", "win32")).toEqual([
			"C:\\Users\\me\\.kimi-code\\bin\\kimi.exe",
			"C:\\Users\\me\\.local\\bin\\kimi.exe",
		]);
	});

	it("returns the ~/.local/bin path on posix", () => {
		expect(kimiKnownPaths("/home/me", "linux")).toEqual(["/home/me/.local/bin/kimi"]);
	});
});
