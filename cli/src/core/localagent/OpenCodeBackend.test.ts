import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as resolver from "./ExecutableResolver.js";
import { expandOpenCodeShim, OPENCODE_SPEC, OpenCodeBackend } from "./OpenCodeBackend.js";
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
		expect(inv.args).toEqual(["run", "--pure", "sys\n\nhi"]);
	});

	it("disables Claude Code compatibility so ~/.claude skills and CLAUDE.md are not loaded", () => {
		// Verified against a real run: without this, `opencode run` reads
		// ~/.claude/skills (observed log: `duplicate skill name … existing=
		// /Users/…/.claude/skills/context7-mcp/SKILL.md`). With it set, that
		// disappears. `--pure` alone does NOT cover skills — only opencode's own
		// external plugins.
		const inv = b.buildInvocation(
			{ file: "opencode", version: "1" },
			{ prompt: "hi", model: "", systemPrompt: "" },
		);
		expect(inv.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
	});

	it("omits --pure when the installed opencode is known to reject it", () => {
		// opencode exits 1 on an unknown flag (printing its whole help and naming
		// nothing), so an older install would otherwise fail every summary.
		const inv = b.buildInvocation(
			{ file: "opencode", version: "1" },
			{ prompt: "hi", model: "", systemPrompt: "", disabledFlagIds: new Set(["--pure"]) },
		);
		expect(inv.args).toEqual(["run", "hi"]);
	});

	it("keeps OPENCODE_DISABLE_CLAUDE_CODE out of the droppable set", () => {
		// An unrecognised env var is ignored by every version, so it can never fail
		// a run — degrading it would give up the skills isolation for nothing.
		expect(b.optionalFlags?.map((f) => f.id)).toEqual(["--pure"]);
	});

	it("passes the user's OPENCODE_CONFIG through untouched, rather than redirecting it", () => {
		// Pointing OPENCODE_CONFIG at a minimal file would kill MCP servers too,
		// but `model` can also live in the user's opencode.json and LlmClient sends
		// EVERY local-agent tool an empty model — so it would silently change which
		// model runs. Same trap as codex's --ignore-user-config (measured there).
		// opencode exposes no CLI/env lever that drops MCP without also dropping
		// model config, so MCP stays for this backend.
		//
		// The var is SET here on purpose: asserting against an unset
		// `process.env.OPENCODE_CONFIG` compares undefined to undefined and passes
		// even if the backend deleted it.
		const prev = process.env.OPENCODE_CONFIG;
		process.env.OPENCODE_CONFIG = "/tmp/user-opencode.json";
		try {
			const inv = b.buildInvocation(
				{ file: "opencode", version: "1" },
				{ prompt: "hi", model: "", systemPrompt: "" },
			);
			expect(inv.env.OPENCODE_CONFIG).toBe("/tmp/user-opencode.json");
		} finally {
			if (prev === undefined) delete process.env.OPENCODE_CONFIG;
			else process.env.OPENCODE_CONFIG = prev;
		}
	});

	it("includes --model when a model is requested", () => {
		const inv = b.buildInvocation(
			{ file: "opencode", version: "1" },
			{ prompt: "hi", model: "anthropic/claude-sonnet", systemPrompt: "" },
		);
		expect(inv.args).toEqual(["run", "--pure", "--model", "anthropic/claude-sonnet", "hi"]);
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
		expect(inv.args).toEqual(["cli.js", "run", "--pure", "hi"]);
	});
});

describe("OpenCodeBackend.isPresent", () => {
	it("is false for an override path that does not exist", () => {
		expect(new OpenCodeBackend().isPresent("/nonexistent/path/to/opencode")).toBe(false);
	});

	it("delegates to the OPENCODE_SPEC discovery, not another tool's", () => {
		const spy = vi.spyOn(resolver, "isPresent").mockReturnValue(true);
		expect(new OpenCodeBackend().isPresent()).toBe(true);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ binName: "opencode" }), {
			overridePath: undefined,
		});
	});
});

describe("OpenCodeBackend.discoverExecutable", () => {
	it("resolves through the shared resolver, forwarding the override path", async () => {
		const spy = vi
			.spyOn(resolver, "resolveExecutable")
			.mockReturnValue({ file: "/opt/opencode", version: "1.2.3" });
		await expect(b.discoverExecutable("/opt/opencode")).resolves.toEqual({
			file: "/opt/opencode",
			version: "1.2.3",
		});
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ binName: "opencode" }), {
			overridePath: "/opt/opencode",
		});
		spy.mockRestore();
	});
});

describe("OPENCODE_SPEC.knownPaths", () => {
	// Built with path.win32 / path.posix rather than the host `path`, so the
	// expectations hold on a Windows dev machine and in POSIX CI alike. Windows
	// lists the standalone installer's native binary first, then the npm layout.
	it("lists the install locations for each platform", () => {
		expect(OPENCODE_SPEC.knownPaths("C:\\Users\\u", "win32")).toEqual([
			"C:\\Users\\u\\.opencode\\bin\\opencode.exe",
			"C:\\Users\\u\\.local\\bin\\opencode.exe",
		]);
		expect(OPENCODE_SPEC.knownPaths("/home/u", "darwin")).toEqual(["/home/u/.local/bin/opencode"]);
	});
});
