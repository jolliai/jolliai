import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandOpenCodeShim, OpenCodeBackend } from "./OpenCodeBackend.js";
import { LocalAgentSetupError } from "./Types.js";

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

	// Real opencode provider/auth failures surface on STDERR with empty stdout (the
	// runner turns that into a LocalAgentSetupError before parseResult runs), never
	// as a parseable stdout line. So a non-empty stdout is always returned verbatim
	// as the summary — even one that itself mentions "login" / "authenticate" —
	// with no stdout-side auth classification to false-positive on.
	it("returns a summary that mentions auth vocabulary verbatim (no misclassification)", () => {
		const summary = "Fixed the login error in the auth middleware so an unauthorized request no longer crashes.";
		const out = b.parseResult(summary);
		expect(out.text).toBe(summary.trim());
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

/**
 * Pinned to a real Windows install: `where opencode` returns
 * `C:\nvm4w\nodejs\opencode` and `C:\nvm4w\nodejs\opencode.cmd` — npm cmd-shims,
 * no `.exe` on PATH. The package's own bin IS a native binary
 * (`opencode-ai` declares `"bin": {"opencode": "./bin/opencode.exe"}`), so the
 * shim resolves to it with no interpreter args.
 */
describe("expandOpenCodeShim", () => {
	const PREFIX = "C:\\nvm4w\\nodejs";
	const EXE = `${PREFIX}\\node_modules\\opencode-ai\\bin\\opencode.exe`;

	it("resolves the npm cmd-shim to the package's native binary", () => {
		expect(expandOpenCodeShim(`${PREFIX}\\opencode.cmd`, { exists: (p) => p === EXE, listDir: () => [] })).toEqual([
			{ file: EXE },
		]);
	});

	it("resolves the extensionless shim the same way (same npm prefix)", () => {
		expect(expandOpenCodeShim(`${PREFIX}\\opencode`, { exists: (p) => p === EXE, listDir: () => [] })).toEqual([
			{ file: EXE },
		]);
	});

	it("yields nothing when the package binary is absent, rather than a phantom candidate", () => {
		expect(expandOpenCodeShim(`${PREFIX}\\opencode.cmd`, { exists: () => false, listDir: () => [] })).toEqual([]);
	});
});

describe("OpenCodeBackend.buildInvocation with launcher args", () => {
	it("prepends launchArgs ahead of the `run` subcommand", () => {
		const inv = b.buildInvocation(
			{ file: "node.exe", version: "1", launchArgs: ["cli.js"] },
			{ prompt: "hi", model: "", systemPrompt: "" },
		);
		expect(inv.args).toEqual(["cli.js", "run", "hi"]);
	});
});
