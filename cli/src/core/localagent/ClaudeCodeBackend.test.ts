import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeBackend } from "./ClaudeCodeBackend.js";
import * as resolver from "./ExecutableResolver.js";
import { LocalAgentAuthError, LocalAgentSetupError, LocalAgentTransientError } from "./Types.js";

const successFixture = readFileSync(
	fileURLToPath(new URL("./fixtures/claude-print-success.json", import.meta.url)),
	"utf8",
);
const backend = new ClaudeCodeBackend();

describe("ClaudeCodeBackend.parseResult", () => {
	it("maps the real success envelope to LocalAgentOutcome", () => {
		const out = backend.parseResult(successFixture);
		expect(out.text).toBe("PONG");
		expect(out.inputTokens).toBe(10);
		expect(out.outputTokens).toBe(198);
		// cachedTokens = cache_read + cache_creation.
		expect(out.cachedTokens).toBe(4738);
		expect(out.costUsd).toBeCloseTo(0.010476);
		expect(out.stopReason).toBe("end_turn");
	});

	it("throws auth error on is_error with a 401/403 api status", () => {
		const json = JSON.stringify({
			type: "result",
			is_error: true,
			subtype: "error",
			api_error_status: 401,
			result: "Unauthorized",
		});
		expect(() => backend.parseResult(json)).toThrowError(LocalAgentAuthError);
	});

	it("throws transient error on is_error with a 429 api status", () => {
		const json = JSON.stringify({
			type: "result",
			is_error: true,
			subtype: "error",
			api_error_status: 429,
			result: "rate limited",
		});
		expect(() => backend.parseResult(json)).toThrowError(LocalAgentTransientError);
	});

	it("throws on non-JSON stdout", () => {
		expect(() => backend.parseResult("not json at all")).toThrowError(/could not parse/i);
	});

	it("throws auth error on is_error with a 403 api status", () => {
		const json = JSON.stringify({
			type: "result",
			is_error: true,
			subtype: "error",
			api_error_status: 403,
			result: "Forbidden",
		});
		expect(() => backend.parseResult(json)).toThrowError(LocalAgentAuthError);
	});

	it("throws transient error on is_error with a 500+ api status", () => {
		const json = JSON.stringify({
			type: "result",
			is_error: true,
			subtype: "error",
			api_error_status: 503,
			result: "Service Unavailable",
		});
		expect(() => backend.parseResult(json)).toThrowError(LocalAgentTransientError);
	});

	it("throws setup error on is_error with a non-transient/non-auth status", () => {
		const json = JSON.stringify({
			type: "result",
			is_error: true,
			subtype: "error",
			api_error_status: 400,
			result: "Bad Request",
		});
		expect(() => backend.parseResult(json)).toThrowError(LocalAgentSetupError);
	});

	it("classifies a not-signed-in is_error envelope (no HTTP status) as an auth error", () => {
		// print+json mode can surface a local sign-in failure as an is_error
		// envelope without an api_error_status, so the 401/403 branch can't catch
		// it — the phrasing heuristic must, so the user gets sign-in guidance.
		for (const detail of ["Please run `claude` to log in", "Invalid API key", "authentication_error"]) {
			const json = JSON.stringify({ type: "result", is_error: true, result: detail });
			expect(() => backend.parseResult(json)).toThrowError(LocalAgentAuthError);
		}
	});

	it("still classifies a generic statusless is_error as a setup error", () => {
		const json = JSON.stringify({ type: "result", is_error: true, result: "some unrelated failure" });
		expect(() => backend.parseResult(json)).toThrowError(LocalAgentSetupError);
	});

	it("handles missing fields with defaults", () => {
		const json = JSON.stringify({ is_error: false });
		const out = backend.parseResult(json);
		expect(out.text).toBe("");
		expect(out.inputTokens).toBe(0);
		expect(out.outputTokens).toBe(0);
		expect(out.cachedTokens).toBe(0);
		expect(out.costUsd).toBe(0);
		expect(out.stopReason).toBe(null);
	});

	it("throws error with subtype in message when result is missing", () => {
		const json = JSON.stringify({ type: "result", is_error: true, subtype: "model_error", api_error_status: 400 });
		expect(() => backend.parseResult(json)).toThrowError(/model_error/);
	});

	it("throws error with status 0 when api_error_status is missing", () => {
		const json = JSON.stringify({ type: "result", is_error: true });
		expect(() => backend.parseResult(json)).toThrowError(/status 0/);
	});

	it("handles cache_read_input_tokens in cachedTokens calculation", () => {
		const json = JSON.stringify({
			is_error: false,
			result: "OK",
			usage: {
				cache_read_input_tokens: 100,
				cache_creation_input_tokens: 200,
			},
		});
		const out = backend.parseResult(json);
		expect(out.cachedTokens).toBe(300);
	});

	it("handles cache_read_input_tokens without cache_creation_input_tokens", () => {
		const json = JSON.stringify({
			is_error: false,
			result: "OK",
			usage: {
				cache_read_input_tokens: 150,
			},
		});
		const out = backend.parseResult(json);
		expect(out.cachedTokens).toBe(150);
	});

	// `modelUsage` is the only record of what actually ran — a pinned model is a
	// request, not a receipt, so without reading this back stored metadata would
	// name a model the CLI may never have used. Shape from a real 2.1.220 run.
	it("reports the model the CLI actually ran, keeping the context-window variant", () => {
		const json = JSON.stringify({
			is_error: false,
			result: "OK",
			modelUsage: {
				"claude-opus-5[1m]": { outputTokens: 4, canonicalModel: "claude-opus-5" },
			},
		});
		// The `[1m]` suffix is a distinct SKU at a distinct price, so the map key
		// wins over the tidier `canonicalModel`.
		expect(backend.parseResult(json).model).toBe("claude-opus-5[1m]");
	});

	// The regression this whole parameter exists for. Captured verbatim from a real
	// 2.1.212 run with the full isolation set: claude runs a small helper turn of
	// its own, and on a short answer that helper OUT-PRODUCES the model we asked
	// for. Picking by output tokens named haiku for a sonnet run.
	const TWO_ENTRY_SONNET_RUN = JSON.stringify({
		is_error: false,
		result: "ok",
		modelUsage: {
			"claude-haiku-4-5-20251001": { inputTokens: 523, outputTokens: 12, cacheReadInputTokens: 0 },
			"claude-sonnet-5": { inputTokens: 1, outputTokens: 4, cacheReadInputTokens: 3289 },
		},
	});

	it("names the requested model when the envelope reports a helper turn alongside it", () => {
		expect(backend.parseResult(TWO_ENTRY_SONNET_RUN, "sonnet").model).toBe("claude-sonnet-5");
	});

	it("falls back to the heaviest-input turn when nothing was requested", () => {
		// The `inherit` choice sends no model flag, so there is no alias to match.
		// Total input is what identifies the answering turn — it carries the
		// conversation cache (1 + 3289) while the helper carries none (523 + 0),
		// which is the opposite of what the output column says.
		expect(backend.parseResult(TWO_ENTRY_SONNET_RUN).model).toBe("claude-sonnet-5");
		expect(backend.parseResult(TWO_ENTRY_SONNET_RUN, "").model).toBe("claude-sonnet-5");
		expect(backend.parseResult(TWO_ENTRY_SONNET_RUN, "   ").model).toBe("claude-sonnet-5");
	});

	it("reports the model that DID run when the requested one is absent, so the caller can warn", () => {
		// Nothing matches "sonnet", so the heuristic answers and LlmClient's
		// requested-vs-actual check has a real value to disagree with. Reporting
		// undefined here would silently suppress that warning instead.
		const json = JSON.stringify({
			is_error: false,
			result: "OK",
			modelUsage: { "claude-opus-5[1m]": { inputTokens: 10, outputTokens: 900 } },
		});
		expect(backend.parseResult(json, "sonnet").model).toBe("claude-opus-5[1m]");
	});

	it("prefers the heavier match when two entries both name the requested model", () => {
		const json = JSON.stringify({
			is_error: false,
			result: "OK",
			modelUsage: {
				"claude-sonnet-4-6": { inputTokens: 5, outputTokens: 900 },
				"claude-sonnet-5": { inputTokens: 4000, outputTokens: 4 },
			},
		});
		expect(backend.parseResult(json, "sonnet").model).toBe("claude-sonnet-5");
	});

	it("keeps the matching entry even when a later helper turn is far heavier", () => {
		// Order matters here: the match arrives FIRST, so the guard that refuses to
		// demote an already-matched entry is what carries it. Without that, a helper
		// turn with a big cached prompt would displace the model we asked for.
		const json = JSON.stringify({
			is_error: false,
			result: "OK",
			modelUsage: {
				"claude-sonnet-5": { inputTokens: 1, cacheReadInputTokens: 0 },
				"claude-haiku-4-5": { inputTokens: 9000, cacheReadInputTokens: 9000 },
			},
		});
		expect(backend.parseResult(json, "sonnet").model).toBe("claude-sonnet-5");
	});

	it("keeps the heaviest turn when no entry matches and the heavier one came first", () => {
		// Exercises the "this entry is lighter, leave the incumbent" arm of the
		// fallback, which the two-entry fixture above never reaches.
		const json = JSON.stringify({
			is_error: false,
			result: "OK",
			modelUsage: {
				"claude-opus-4-8": { inputTokens: 4000 },
				"claude-haiku-4-5": { inputTokens: 12 },
			},
		});
		expect(backend.parseResult(json).model).toBe("claude-opus-4-8");
	});

	it("matches the alias case-insensitively", () => {
		const json = JSON.stringify({
			is_error: false,
			result: "OK",
			modelUsage: {
				"claude-haiku-4-5": { inputTokens: 900 },
				"Claude-Sonnet-5": { inputTokens: 1 },
			},
		});
		expect(backend.parseResult(json, "SONNET").model).toBe("Claude-Sonnet-5");
	});

	it("leaves model unset when the envelope names none, so the caller can fall back", () => {
		// Real runs emit `"modelUsage":{}` on an error turn, and an older CLI may
		// omit the field entirely. Both must read as "unknown", not as a model id.
		for (const envelope of [
			{ is_error: false, result: "OK" },
			{ is_error: false, result: "OK", modelUsage: {} },
		]) {
			expect(backend.parseResult(JSON.stringify(envelope)).model).toBeUndefined();
		}
	});

	it("tolerates a null per-model entry rather than throwing", () => {
		const json = JSON.stringify({ is_error: false, result: "OK", modelUsage: { "claude-opus-5": null } });
		expect(backend.parseResult(json).model).toBe("claude-opus-5");
	});
});

describe("ClaudeCodeBackend.buildInvocation", () => {
	const exe = { file: "/usr/bin/claude", version: "2.1.210" };
	const req = { prompt: "PROMPT_BODY", model: "claude-haiku-4-5-20251001", systemPrompt: "SYS", maxTokens: 8192 };

	it("builds the headless print-mode arg vector with tools disabled", () => {
		const inv = backend.buildInvocation(exe, req);
		expect(inv.file).toBe("/usr/bin/claude");
		expect(inv.args).toEqual([
			"-p",
			"--output-format",
			"json",
			"--model",
			"claude-haiku-4-5-20251001",
			"--system-prompt",
			"SYS",
			"--tools",
			"",
			"--permission-mode",
			"dontAsk",
			"--no-session-persistence",
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--setting-sources",
			"",
		]);
		expect(inv.stdin).toBe("PROMPT_BODY");
	});

	it("omits --model entirely when no model is requested, so the CLI's own default is used", () => {
		// LlmClient sends every local-agent tool an EMPTY model, because the
		// Settings UI offers no model picker for this provider. Passing `--model ""`
		// would be an explicit empty selection rather than "no opinion", so the flag
		// pair has to disappear — matching how codex/cursor-agent/kimi already do it.
		const inv = backend.buildInvocation(exe, { ...req, model: "" });
		expect(inv.args).not.toContain("--model");
		expect(inv.args).toEqual([
			"-p",
			"--output-format",
			"json",
			"--system-prompt",
			"SYS",
			"--tools",
			"",
			"--permission-mode",
			"dontAsk",
			"--no-session-persistence",
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--setting-sources",
			"",
		]);
	});

	it("isolates the child from the user's MCP servers, skills and settings sources", () => {
		const inv = backend.buildInvocation(exe, req);
		// These three carry ~6.3k tokens of unusable tool/skill schema into a
		// prompt that is forbidden from calling any tool (`--tools ""`), so they
		// are load-bearing for cost, not cosmetic. Asserted by name as well as in
		// the full vector above so a reordering refactor cannot silently drop one.
		expect(inv.args).toContain("--strict-mcp-config");
		expect(inv.args).toContain("--disable-slash-commands");
		expect(inv.args.slice(inv.args.indexOf("--setting-sources"))).toEqual(["--setting-sources", ""]);
	});

	it("omits an isolation flag the installed CLI is known to reject, keeping the others", () => {
		// An older `claude` exits non-zero on an unknown flag rather than ignoring
		// it, so without this one stale install would fail every summary. Losing
		// one flag only costs the tokens that flag was saving.
		const inv = backend.buildInvocation(exe, { ...req, disabledFlagIds: new Set(["--disable-slash-commands"]) });
		expect(inv.args).not.toContain("--disable-slash-commands");
		expect(inv.args).toContain("--strict-mcp-config");
		expect(inv.args.slice(inv.args.indexOf("--setting-sources"))).toEqual(["--setting-sources", ""]);
	});

	it("drops --setting-sources together with its empty value argument", () => {
		// The flag and its "" are one unit; leaving the value behind would hand
		// `claude` a stray empty positional.
		const inv = backend.buildInvocation(exe, { ...req, disabledFlagIds: new Set(["--setting-sources"]) });
		expect(inv.args).not.toContain("--setting-sources");
		expect(inv.args.at(-1)).toBe("--disable-slash-commands");
	});

	it("falls back to the pre-isolation vector when every optional flag is rejected", () => {
		const inv = backend.buildInvocation(exe, {
			...req,
			disabledFlagIds: new Set(["--strict-mcp-config", "--disable-slash-commands", "--setting-sources"]),
		});
		expect(inv.args).toEqual([
			"-p",
			"--output-format",
			"json",
			"--model",
			"claude-haiku-4-5-20251001",
			"--system-prompt",
			"SYS",
			"--tools",
			"",
			"--permission-mode",
			"dontAsk",
			"--no-session-persistence",
		]);
	});

	it("declares its three isolation flags as individually droppable, and nothing else", () => {
		// Pins the granularity contract: if these were ever collapsed into one
		// entry, a single unsupported flag would cost all three.
		//
		// `--model` is deliberately NOT here. It was, briefly: the degradation loop
		// only sees failures `run()` rejects with, and a refused model exits nonzero
		// having written its envelope to stdout, which the runner resolves — so the
		// entry was inert for the case it existed for while silently dropping the
		// pin on any unattributed setup error. The un-pinned retry in
		// `LlmClient.callLocalAgent` replaces it.
		expect(backend.optionalFlags?.map((f) => f.id)).toEqual([
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--setting-sources",
		]);
	});

	it("never passes --bare, which would break subscription auth", () => {
		// `--bare` reads as the ideal isolation flag (skips hooks, plugin sync,
		// auto-memory, CLAUDE.md discovery) but it also stops `claude` reading
		// OAuth/keychain — and this backend deliberately scrubs ANTHROPIC_API_KEY
		// so keychain subscription auth is the ONLY credential path left. Measured:
		// `--bare` returns `is_error` / "Not logged in · Please run /login".
		const inv = backend.buildInvocation(exe, req);
		expect(inv.args).not.toContain("--bare");
	});

	it("runs in a real, fresh temp cwd (no repo CLAUDE.md auto-discovery)", () => {
		const inv = backend.buildInvocation(exe, req);
		expect(existsSync(inv.cwd)).toBe(true);
		expect(inv.cwd).not.toBe(process.cwd());
	});

	it("scrubs Anthropic/Claude credential env vars so subscription OAuth is used", () => {
		const prev = { ...process.env };
		process.env.ANTHROPIC_API_KEY = "sk-ant-should-be-removed";
		process.env.ANTHROPIC_BASE_URL = "https://relay.example";
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale";
		process.env.CLAUDECODE = "1";
		try {
			const inv = backend.buildInvocation(exe, req);
			expect(inv.env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(inv.env.ANTHROPIC_BASE_URL).toBeUndefined();
			expect(inv.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			expect(inv.env.CLAUDECODE).toBeUndefined();
			// Non-credential env is preserved.
			expect(inv.env.PATH).toBe(process.env.PATH);
		} finally {
			process.env = prev;
		}
	});

	it("marks the child as a jollimemory-spawned agent to block hook/enable re-entry", () => {
		const inv = backend.buildInvocation(exe, req);
		expect(inv.env.JOLLI_LOCAL_AGENT_CHILD).toBe("1");
	});
});

describe("ClaudeCodeBackend.buildInvocation with launcher args", () => {
	it("prepends launchArgs ahead of the CLI's own flags", () => {
		const inv = new ClaudeCodeBackend().buildInvocation(
			{ file: "node.exe", version: "2.1.210", launchArgs: ["cli.js"] },
			{ prompt: "p", model: "m", systemPrompt: "s" },
		);
		expect(inv.args.slice(0, 2)).toEqual(["cli.js", "-p"]);
	});
});

describe("ClaudeCodeBackend.isPresent", () => {
	it("is false for an override path that does not exist", () => {
		expect(new ClaudeCodeBackend().isPresent("/nonexistent/path/to/claude")).toBe(false);
	});

	it("delegates to the CLAUDE_SPEC discovery, not another tool's", () => {
		const spy = vi.spyOn(resolver, "isPresent").mockReturnValue(true);
		expect(new ClaudeCodeBackend().isPresent()).toBe(true);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ binName: "claude" }), { overridePath: undefined });
	});
});
