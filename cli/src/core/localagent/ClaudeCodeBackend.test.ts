import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCodeBackend } from "./ClaudeCodeBackend.js";
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
		]);
		expect(inv.stdin).toBe("PROMPT_BODY");
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
});
