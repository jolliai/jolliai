import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CODEX_SPEC, CodexBackend } from "./CodexBackend.js";
import * as resolver from "./ExecutableResolver.js";
import { LocalAgentAuthError, LocalAgentSetupError, LocalAgentTransientError } from "./Types.js";

const fixture = readFileSync(join(__dirname, "__fixtures__/codex/success.json"), "utf8");
const outOfCredits = readFileSync(join(__dirname, "__fixtures__/codex/out-of-credits.json"), "utf8");
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

	it("tolerates a typeless event, an empty agent_message, and a usage-less turn", () => {
		const stream = [
			// No `type` at all (a bare handshake line) — must not be treated as an
			// error just because the haystack is empty.
			JSON.stringify({ thread_id: "abc" }),
			JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "the answer" } }),
			// A later empty agent_message must not blank the text already captured.
			JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "" } }),
			// turn.completed with a usage object that reports nothing.
			JSON.stringify({ type: "turn.completed", usage: {} }),
		].join("\n");
		const out = b.parseResult(stream);
		expect(out.text).toBe("the answer");
		expect(out.inputTokens).toBe(0);
		expect(out.outputTokens).toBe(0);
		expect(out.cachedTokens).toBe(0);
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
			"--disable",
			"plugins",
			"sys\n\nhi",
		]);
	});

	it("disables plugins via the feature flag, as an adjacent --disable/plugins pair", () => {
		// Measured on 0.146.0-alpha.3 (RUST_LOG=info stderr): this drops the 4
		// codex_core_{plugins,skills} loader WARNs and the `plugins_enabled=true`
		// line, while `model=` stays on the user's configured value.
		const inv = b.buildInvocation({ file: "codex", version: "1" }, { prompt: "hi", model: "", systemPrompt: "" });
		const at = inv.args.indexOf("--disable");
		expect(at).toBeGreaterThanOrEqual(0);
		expect(inv.args[at + 1]).toBe("plugins");
	});

	it("omits the --disable pair when the installed codex is known to reject it", () => {
		// Both the flag AND its feature name have to go: a bare `--disable` would
		// consume the prompt as its value.
		const inv = b.buildInvocation(
			{ file: "codex", version: "1" },
			{ prompt: "hi", model: "", systemPrompt: "", disabledFlagIds: new Set(["--disable"]) },
		);
		expect(inv.args).not.toContain("--disable");
		expect(inv.args).not.toContain("plugins");
		expect(inv.args.at(-1)).toBe("hi");
	});

	it("matches codex's unknown-FEATURE failure too, which never writes the flag name", () => {
		// `--disable` exists but the feature does not (exit 1, different phrasing).
		// Same remedy, so the declaration must carry the phrase explicitly.
		expect(b.optionalFlags?.[0]?.matches).toContain("Unknown feature flag: plugins");
	});

	it("never passes -c table overrides, which codex merges into a no-op", () => {
		// `-c mcp_servers={}` / `-c plugins={}` were shipped as the isolation
		// mechanism and do NOTHING: `-c` is a dotted-path set that MERGES, so an
		// empty inline table merges nothing. Measured — both still loaded, stderr
		// state byte-identical to baseline. Only scalar dotted paths (what
		// `--disable plugins` expands to) take effect.
		const inv = b.buildInvocation({ file: "codex", version: "1" }, { prompt: "hi", model: "", systemPrompt: "" });
		expect(inv.args).not.toContain("mcp_servers={}");
		expect(inv.args).not.toContain("plugins={}");
	});

	it("never passes --ignore-user-config, which would silently change the model", () => {
		// It does genuinely drop the user's MCP servers (measured: 5 entries → the
		// built-in `codex_apps` alone) but takes `model` with it: gpt-5.4 →
		// gpt-5.6-sol on the same machine. LlmClient sends EVERY local-agent tool an
		// empty model, so codex resolves it from `$CODEX_HOME/config.toml` — and
		// ignoring that file silently changes which model writes every summary.
		const inv = b.buildInvocation({ file: "codex", version: "1" }, { prompt: "hi", model: "", systemPrompt: "" });
		expect(inv.args).not.toContain("--ignore-user-config");
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
			"--disable",
			"plugins",
			"-m",
			"gpt-5",
			"hi",
		]);
	});

	it("classifies an auth-phrased error event", () => {
		const stream = JSON.stringify({ type: "error", message: "please login to continue: unauthorized" });
		expect(() => b.parseResult(stream)).toThrow(LocalAgentAuthError);
	});

	// Real capture from codex 0.146.0-alpha.3 on an exhausted workspace (exit 1,
	// stderr only "Reading additional input from stdin..."). This shipped as a
	// SILENT failure: the stream is well-formed JSONL, so `sawEvent` was true and
	// the setup guard did not fire; "out of credits" names no login word, so the
	// auth regex did not fire either. parseResult returned text:"", the summarizer
	// parsed 0 topics from 0 chars, and regenerate OVERWROTE a good stored summary
	// with an empty one.
	it("throws on the real out-of-credits stream instead of returning an empty completion", () => {
		expect(() => b.parseResult(outOfCredits)).toThrow(/out of credits/i);
	});

	it("classifies a non-auth failure event as transient, never as a setup fault", () => {
		// Not LocalAgentSetupError specifically: that class is the ONLY one that
		// triggers LlmClient's optional-flag degradation, and this failure has
		// nothing to do with argv — degrading would drop `--disable plugins` and
		// retry into the same exhausted workspace.
		expect(() => b.parseResult(outOfCredits)).toThrow(LocalAgentTransientError);
		expect(() => b.parseResult(outOfCredits)).not.toThrow(LocalAgentSetupError);
	});

	it("reads turn.failed's nested error.message, which is not the top-level `message` field", () => {
		// codex reports a mid-turn failure twice, and the two events carry the text
		// in different places: `error` uses `message`, `turn.failed` uses
		// `error.message`. A parser that only reads the top level sees an empty
		// reason on any stream where the standalone `error` event is absent.
		const stream = JSON.stringify({ type: "turn.failed", error: { message: "model stream disconnected" } });
		expect(() => b.parseResult(stream)).toThrow(/model stream disconnected/);
	});

	it("lets a recovered error event through when the turn still produced an answer", () => {
		// An `error` event is a CANDIDATE reason, not a verdict: codex emits them
		// for conditions it retries past (a dropped model stream). Throwing on
		// sight would turn a run that recovered into a hard failure — and protects
		// nothing extra, since a stream that errors and produces no text still
		// throws, from the end-of-stream check below.
		const stream = [
			JSON.stringify({ type: "turn.started" }),
			JSON.stringify({ type: "error", message: "stream disconnected; retrying" }),
			JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "the answer" } }),
			JSON.stringify({ type: "turn.completed", usage: { output_tokens: 3 } }),
		].join("\n");

		expect(() => b.parseResult(stream)).not.toThrow();
		expect(b.parseResult(stream).text).toBe("the answer");
	});

	it("throws the held error reason when the stream ends with no assistant text and no turn.failed", () => {
		// The other half of the split: nothing recovered it, so the held reason is
		// the only explanation available. LlmClient's empty-completion guard would
		// also catch this, but only generically — this is what puts codex's own
		// words in front of the user.
		const stream = [
			JSON.stringify({ type: "turn.started" }),
			JSON.stringify({ type: "error", message: "Your workspace is out of credits." }),
		].join("\n");

		expect(() => b.parseResult(stream)).toThrow(LocalAgentTransientError);
		expect(() => b.parseResult(stream)).toThrow(/out of credits/i);
	});

	it("keeps the FIRST error reason, the root cause rather than a cascade from it", () => {
		const stream = [
			JSON.stringify({ type: "error", message: "Your workspace is out of credits." }),
			JSON.stringify({ type: "error", message: "session aborted" }),
		].join("\n");

		expect(() => b.parseResult(stream)).toThrow(/out of credits/i);
	});

	it("does not mistake a successful turn for a failure just because an item mentions errors", () => {
		// Guard against classifying on the wrong haystack: the assistant TEXT is
		// free-form and routinely contains the word "error".
		const stream = [
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "Fixed the unauthorized login error." },
			}),
			JSON.stringify({ type: "turn.completed", usage: { output_tokens: 7 } }),
		].join("\n");
		expect(() => b.parseResult(stream)).not.toThrow();
		expect(b.parseResult(stream).text).toContain("unauthorized login error");
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

describe("CodexBackend.discoverExecutable", () => {
	it("resolves through the shared resolver, forwarding the override path", async () => {
		const spy = vi.spyOn(resolver, "resolveExecutable").mockReturnValue({ file: "/opt/codex", version: "0.9.0" });
		await expect(b.discoverExecutable("/opt/codex")).resolves.toEqual({ file: "/opt/codex", version: "0.9.0" });
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ binName: "codex" }), {
			overridePath: "/opt/codex",
		});
		spy.mockRestore();
	});
});

describe("CODEX_SPEC.knownPaths", () => {
	// Built with path.win32 / path.posix rather than the host `path`, so the
	// expectations hold on a Windows dev machine and in POSIX CI alike.
	it("points at the standalone installer's location on each platform", () => {
		expect(CODEX_SPEC.knownPaths("C:\\Users\\u", "win32")).toEqual(["C:\\Users\\u\\.local\\bin\\codex.exe"]);
		expect(CODEX_SPEC.knownPaths("/home/u", "darwin")).toEqual(["/home/u/.local/bin/codex"]);
		expect(CODEX_SPEC.knownPaths("/home/u", "linux")).toEqual(["/home/u/.local/bin/codex"]);
	});
});
