import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CursorAgentBackend, cursorKnownPaths, expandCursorShim } from "./CursorAgentBackend.js";
import * as resolver from "./ExecutableResolver.js";
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

/**
 * Pinned to a real Windows install (CLI 2026.07.20, `%LOCALAPPDATA%\cursor-agent`):
 * the top level holds ONLY `{agent,cursor-agent,cursor-agent-svc}.{cmd,ps1}` — no
 * `.exe` anywhere — and the runnable pair lives one level down under
 * `versions\<version>\{node.exe, index.js}`.
 */
describe("expandCursorShim", () => {
	const LOCAL = "C:\\Users\\dev\\AppData\\Local\\cursor-agent";
	const VERSION = "2026.07.20-8cc9c0b";
	const VDIR = `${LOCAL}\\versions\\${VERSION}`;

	const realInstall = {
		listDir: (p: string) => (p === `${LOCAL}\\versions` ? [VERSION] : []),
		exists: (p: string) => p === `${VDIR}\\node.exe` || p === `${VDIR}\\index.js`,
	};

	it("resolves cursor-agent.cmd to the bundled node + index.js, preferring --use-system-ca", () => {
		expect(expandCursorShim(`${LOCAL}\\cursor-agent.cmd`, realInstall)).toEqual([
			{ file: `${VDIR}\\node.exe`, launchArgs: ["--use-system-ca", `${VDIR}\\index.js`] },
			{ file: `${VDIR}\\node.exe`, launchArgs: [`${VDIR}\\index.js`] },
		]);
	});

	it("resolves the .ps1 launcher identically (same directory, same targets)", () => {
		expect(expandCursorShim(`${LOCAL}\\cursor-agent.ps1`, realInstall)).toHaveLength(2);
	});

	// Newest-first, regardless of the order the filesystem hands back: the names
	// are date-stamped, so a descending sort IS chronological.
	it("offers every installed version newest-first and lets the probe pick, rather than guessing one", () => {
		const older = `${LOCAL}\\versions\\2026.07.01-aaaaaaa`;
		const out = expandCursorShim(`${LOCAL}\\cursor-agent.cmd`, {
			listDir: () => ["2026.07.01-aaaaaaa", VERSION], // readdir order: oldest first
			exists: (p: string) => p.endsWith("node.exe") || p.endsWith("index.js"),
		});
		expect(out.map((c) => c.file)).toEqual([
			`${VDIR}\\node.exe`,
			`${VDIR}\\node.exe`,
			`${older}\\node.exe`,
			`${older}\\node.exe`,
		]);
	});

	it("skips a version directory that is missing either half of the pair", () => {
		const out = expandCursorShim(`${LOCAL}\\cursor-agent.cmd`, {
			listDir: () => [VERSION],
			exists: (p: string) => p.endsWith("index.js"), // node.exe absent — a torn upgrade
		});
		expect(out).toEqual([]);
	});

	it("yields nothing when there is no versions directory at all", () => {
		expect(expandCursorShim(`${LOCAL}\\cursor-agent.cmd`, { listDir: () => [], exists: () => true })).toEqual([]);
	});
});

describe("cursorKnownPaths", () => {
	it("honours a redirected %LOCALAPPDATA% rather than composing it from the profile", () => {
		expect(cursorKnownPaths("C:\\Users\\dev", "win32", { LOCALAPPDATA: "D:\\Profiles\\dev\\Local" })[0]).toBe(
			"D:\\Profiles\\dev\\Local\\cursor-agent\\cursor-agent.cmd",
		);
	});

	it("composes the default location when the variable is absent", () => {
		expect(cursorKnownPaths("C:\\Users\\dev", "win32", {})[0]).toBe(
			"C:\\Users\\dev\\AppData\\Local\\cursor-agent\\cursor-agent.cmd",
		);
	});

	it("reads the ambient environment when none is injected", () => {
		expect(cursorKnownPaths("C:\\Users\\dev", "win32")).toHaveLength(2);
	});

	it("is a single POSIX path, untouched by any of the Windows machinery", () => {
		expect(cursorKnownPaths("/Users/dev", "darwin")).toEqual(["/Users/dev/.local/bin/cursor-agent"]);
	});
});

describe("CursorAgentBackend.buildInvocation with a resolved Windows launcher", () => {
	it("leads with the bundled node's script args so they reach node, not the CLI", () => {
		const node = "C:\\cursor-agent\\versions\\2026.07.20-8cc9c0b\\node.exe";
		const entry = "C:\\cursor-agent\\versions\\2026.07.20-8cc9c0b\\index.js";
		const inv = b.buildInvocation(
			{ file: node, version: "2026.07.20-8cc9c0b", launchArgs: ["--use-system-ca", entry] },
			{ prompt: "hi", model: "", systemPrompt: "" },
		);
		expect(inv.file).toBe(node);
		expect(inv.args).toEqual(["--use-system-ca", entry, "-p", "--output-format", "json", "--trust", "hi"]);
	});
});

describe("CursorAgentBackend.isPresent", () => {
	it("is false for an override path that does not exist", () => {
		expect(new CursorAgentBackend().isPresent("/nonexistent/path/to/cursor-agent")).toBe(false);
	});

	it("delegates to the CURSOR_SPEC discovery, not another tool's", () => {
		const spy = vi.spyOn(resolver, "isPresent").mockReturnValue(true);
		expect(new CursorAgentBackend().isPresent()).toBe(true);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ binName: "cursor-agent" }), {
			overridePath: undefined,
		});
	});
});
