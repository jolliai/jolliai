import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_AGENT_CHILD_ENV } from "../AgentReentry.js";
import * as resolver from "./ExecutableResolver.js";
import { argvPromptBudget, HermesBackend, hermesKnownPaths } from "./HermesBackend.js";
import { LocalAgentSetupError } from "./Types.js";

const b = new HermesBackend();
const exe = { file: "/usr/local/bin/hermes", version: "0.20.5" };
const realUsageFixture = readFileSync(join(__dirname, "__fixtures__/hermes/success-usage.json"), "utf8");

/** A directory holding a `usage.json`, as `--usage-file` would have written it. */
function cwdWithUsage(report: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "hermes-usage-"));
	writeFileSync(join(dir, "usage.json"), typeof report === "string" ? report : JSON.stringify(report));
	return dir;
}

const madeDirs: string[] = [];
afterEach(() => {
	for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function tempCwd(report: unknown): string {
	const dir = cwdWithUsage(report);
	madeDirs.push(dir);
	return dir;
}

describe("HermesBackend.buildInvocation", () => {
	it("passes the prompt on argv, isolates the cwd and marks the child", () => {
		const inv = b.buildInvocation(exe, { prompt: "do the thing", model: "", systemPrompt: "be terse" });
		madeDirs.push(inv.cwd);
		expect(inv.file).toBe(exe.file);
		// One-shot mode has no system-prompt flag, so it is prepended to the prompt.
		expect(inv.args).toContain("-z");
		expect(inv.args[inv.args.indexOf("-z") + 1]).toBe("be terse\n\ndo the thing");
		expect(inv.args).toContain("--ignore-rules");
		expect(inv.args[inv.args.indexOf("--usage-file") + 1]).toBe(join(inv.cwd, "usage.json"));
		expect(inv.env[LOCAL_AGENT_CHILD_ENV]).toBe("1");
		// stdin is unused: `-z` carries the prompt and Hermes exposes no stdin path.
		expect(inv.stdin).toBe("");
	});

	it("inherits HERMES_HOME rather than isolating it", () => {
		// The user's provider, credentials and model default live in that home;
		// a scratch one would leave the child with no way to reach a model.
		process.env.HERMES_HOME = "/somewhere/real";
		try {
			const inv = b.buildInvocation(exe, { prompt: "p", model: "", systemPrompt: "" });
			madeDirs.push(inv.cwd);
			expect(inv.env.HERMES_HOME).toBe("/somewhere/real");
		} finally {
			delete process.env.HERMES_HOME;
		}
	});

	it("emits no model flag when nothing is pinned, and one when something is", () => {
		const bare = b.buildInvocation(exe, { prompt: "p", model: "", systemPrompt: "" });
		madeDirs.push(bare.cwd);
		expect(bare.args).not.toContain("--model");
		const pinned = b.buildInvocation(exe, { prompt: "p", model: "anthropic/claude-x", systemPrompt: "" });
		madeDirs.push(pinned.cwd);
		expect(pinned.args[pinned.args.indexOf("--model") + 1]).toBe("anthropic/claude-x");
	});

	it("drops --ignore-rules when the degradation loop has disabled it", () => {
		const inv = b.buildInvocation(exe, {
			prompt: "p",
			model: "",
			systemPrompt: "",
			disabledFlagIds: new Set(["--ignore-rules"]),
		});
		madeDirs.push(inv.cwd);
		expect(inv.args).not.toContain("--ignore-rules");
		// Everything load-bearing survives the drop.
		expect(inv.args).toContain("-z");
		expect(inv.args).toContain("--usage-file");
	});

	it("never drops the load-bearing usage receipt, even with stale degradation state", () => {
		const inv = b.buildInvocation(exe, {
			prompt: "p",
			model: "",
			systemPrompt: "",
			disabledFlagIds: new Set(["--usage-file"]),
		});
		madeDirs.push(inv.cwd);
		expect(inv.args).toContain("--usage-file");
		expect(inv.args[inv.args.indexOf("--usage-file") + 1]).toBe(join(inv.cwd, "usage.json"));
		expect(inv.args).toContain("--ignore-rules");
		expect(inv.args).toContain("-z");
		expect(b.optionalFlags?.map((flag) => flag.id)).toEqual(["--ignore-rules"]);
	});

	it("spreads the executable's launcher args ahead of its own", () => {
		const inv = b.buildInvocation(
			{ ...exe, launchArgs: ["--flag", "/path/entry.py"] },
			{
				prompt: "p",
				model: "",
				systemPrompt: "",
			},
		);
		madeDirs.push(inv.cwd);
		expect(inv.args.slice(0, 2)).toEqual(["--flag", "/path/entry.py"]);
	});

	it("fails instead of generating a summary from a truncated prompt", () => {
		const saved = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			expect(() =>
				b.buildInvocation(exe, {
					prompt: "x".repeat(argvPromptBudget("linux") + 1),
					model: "",
					systemPrompt: "",
				}),
			).toThrow(/refusing to generate a partial summary/);
		} finally {
			/* v8 ignore next -- the platform descriptor is always present on supported runtimes */
			if (saved) Object.defineProperty(process, "platform", saved);
		}
	});

	it("measures the Linux ceiling in UTF-8 bytes", () => {
		const saved = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			expect(() => b.buildInvocation(exe, { prompt: "😀".repeat(30_001), model: "", systemPrompt: "" })).toThrow(
				/120004 UTF-8 bytes/,
			);
		} finally {
			/* v8 ignore next -- the platform descriptor is always present on supported runtimes */
			if (saved) Object.defineProperty(process, "platform", saved);
		}
	});

	it("carries a 400-KiB summarize prompt plus its system prompt on macOS", () => {
		const saved = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		try {
			const inv = b.buildInvocation(exe, {
				prompt: "x".repeat(400 * 1024),
				model: "",
				systemPrompt: "system",
			});
			madeDirs.push(inv.cwd);
			expect(inv.args[inv.args.indexOf("-z") + 1]).toHaveLength(400 * 1024 + "system\n\n".length);
		} finally {
			/* v8 ignore next -- the platform descriptor is always present on supported runtimes */
			if (saved) Object.defineProperty(process, "platform", saved);
		}
	});
});

describe("HermesBackend.argvPromptBudget", () => {
	it("uses the measured per-platform single-argument ceilings", () => {
		expect(argvPromptBudget("win32")).toBe(24_000);
		expect(argvPromptBudget("darwin")).toBe(512 * 1024);
		expect(argvPromptBudget("linux")).toBe(120_000);
		expect(argvPromptBudget("freebsd")).toBe(120_000);
	});
});

describe("HermesBackend.parseResult", () => {
	it("parses a real Hermes v0.20.5 success usage report", () => {
		const out = b.parseResult("fixture-ok\n", undefined, tempCwd(realUsageFixture));
		expect(out).toMatchObject({
			text: "fixture-ok",
			inputTokens: 3,
			outputTokens: 6,
			cachedTokens: 24_191,
			costUsd: 0,
			model: "anthropic/claude-opus-4.6",
			stopReason: null,
		});
	});

	it("returns the trimmed stdout with the usage the report carries", () => {
		const cwd = tempCwd({
			input_tokens: 100,
			output_tokens: 20,
			cache_read_tokens: 5,
			cache_write_tokens: 3,
			estimated_cost_usd: 0.0125,
			model: "anthropic/claude-opus-4.6",
			failed: false,
		});
		const out = b.parseResult("  the answer\n", undefined, cwd);
		expect(out.text).toBe("the answer");
		expect(out.inputTokens).toBe(100);
		expect(out.outputTokens).toBe(20);
		// Hermes splits its cache accounting in two; the outcome carries one figure.
		expect(out.cachedTokens).toBe(8);
		expect(out.costUsd).toBe(0.0125);
		// A receipt, not a request — which is what makes it worth reading on an
		// unpinned tool.
		expect(out.model).toBe("anthropic/claude-opus-4.6");
		expect(out.stopReason).toBeNull();
	});

	it("rejects plausible failure text when no usage report was written", () => {
		const cwd = mkdtempSync(join(tmpdir(), "hermes-nousage-"));
		madeDirs.push(cwd);
		expect(() => b.parseResult("Your workspace is out of credits.", undefined, cwd)).toThrow(
			/refusing unverified stdout/,
		);
	});

	it("rejects stdout when no cwd is supplied at all", () => {
		expect(() => b.parseResult("answer")).toThrow(/refusing unverified stdout/);
	});

	it("rejects a malformed or non-object report", () => {
		expect(() => b.parseResult("answer", undefined, tempCwd("{not json"))).toThrow(/valid usage report/);
		expect(() => b.parseResult("answer", undefined, tempCwd("[1,2]"))).toThrow(/valid usage report/);
	});

	it("ignores non-numeric and negative usage fields", () => {
		const cwd = tempCwd({
			failed: false,
			input_tokens: "lots",
			output_tokens: -5,
			estimated_cost_usd: null,
			model: 7,
		});
		const out = b.parseResult("answer", undefined, cwd);
		expect(out).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
		expect(out.model).toBeUndefined();
	});

	it("accepts finite non-negative numeric strings in usage fields", () => {
		const cwd = tempCwd({
			input_tokens: "1234",
			output_tokens: " 20 ",
			cache_read_tokens: "5",
			cache_write_tokens: "3",
			estimated_cost_usd: "0.0021",
		});
		const out = b.parseResult("answer", undefined, cwd);
		expect(out).toMatchObject({
			inputTokens: 1234,
			outputTokens: 20,
			cachedTokens: 8,
			costUsd: 0.0021,
		});
	});

	it("throws with the reported reason when Hermes says the run failed", () => {
		// Producing no answer MUST throw: returning "" would let an empty summary
		// overwrite a good stored one and be reported as success.
		const cwd = tempCwd({ failed: true, failure: "Your workspace is out of credits." });
		expect(() => b.parseResult("", undefined, cwd)).toThrow(/out of credits/);
	});

	it("prefers the reported failure over the empty-stdout message even when stdout has text", () => {
		const cwd = tempCwd({ failed: true, failure: "provider refused" });
		expect(() => b.parseResult("partial", undefined, cwd)).toThrow(/provider refused/);
	});

	it("names the failure generically when the report gives no reason", () => {
		const cwd = tempCwd({ failed: true });
		expect(() => b.parseResult("", undefined, cwd)).toThrow(/no reason reported/);
	});

	it("honors a legacy failure reason even when the failed field is absent", () => {
		const cwd = tempCwd({ failure: "provider refused" });
		expect(() => b.parseResult("diagnostic text", undefined, cwd)).toThrow(/provider refused/);
	});

	it("accepts a success report that omits the optional failed field", () => {
		const cwd = tempCwd({ input_tokens: 10, output_tokens: 2 });
		expect(b.parseResult("answer", undefined, cwd)).toMatchObject({ inputTokens: 10, outputTokens: 2 });
	});

	it("rejects an explicitly non-boolean failed field", () => {
		const cwd = tempCwd({ failed: "false", input_tokens: 10, output_tokens: 2 });
		expect(() => b.parseResult("answer", undefined, cwd)).toThrow(/non-boolean failure status/);
	});

	it("throws LocalAgentSetupError on empty stdout with no failure recorded", () => {
		// A `-z` run that writes nothing at all has not started properly — the class
		// the runner already reports with its stderr tail.
		const cwd = tempCwd({ failed: false });
		expect(() => b.parseResult("", undefined, cwd)).toThrow(LocalAgentSetupError);
		expect(() => b.parseResult("   \n  ", undefined, cwd)).toThrow(LocalAgentSetupError);
	});
});

describe("HermesBackend discovery", () => {
	it("looks in the documented installer location on POSIX", () => {
		expect(hermesKnownPaths("/home/u", "linux")).toEqual(["/home/u/.local/bin/hermes"]);
	});

	it("looks for the .exe under both installer layouts on win32", () => {
		expect(hermesKnownPaths("C:\\Users\\u", "win32")).toEqual([
			"C:\\Users\\u\\.hermes\\bin\\hermes.exe",
			"C:\\Users\\u\\.local\\bin\\hermes.exe",
		]);
	});

	it("delegates presence and resolution to the shared resolver", () => {
		const isPresent = vi.spyOn(resolver, "isPresent").mockReturnValue(true);
		expect(b.isPresent("/custom/hermes")).toBe(true);
		expect(isPresent.mock.calls[0][1]).toEqual({ overridePath: "/custom/hermes" });

		const resolve = vi.spyOn(resolver, "resolveExecutable").mockReturnValue(exe);
		return b.discoverExecutable().then((resolved) => {
			expect(resolved).toEqual(exe);
			expect(resolve).toHaveBeenCalled();
		});
	});
});
