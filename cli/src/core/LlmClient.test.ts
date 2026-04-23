import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callLlm, resolveLlmCredentialSource } from "./LlmClient.js";

const { mockCreate, mockLogWarn } = vi.hoisted(() => ({
	mockCreate: vi.fn(),
	mockLogWarn: vi.fn(),
}));

// Mock Anthropic SDK — must use `function` (not arrow) so `new Anthropic()` works in Vitest 4.x
vi.mock("@anthropic-ai/sdk", () => ({
	// biome-ignore lint/complexity/useArrowFunction: Vitest 4.x requires `function` for constructor mocks
	default: vi.fn().mockImplementation(function () {
		return { messages: { create: mockCreate }, baseURL: "https://api.anthropic.com" };
	}),
}));

// Mock Logger
vi.mock("../Logger.js", () => ({
	createLogger: () => ({
		info: vi.fn(),
		warn: mockLogWarn,
		debug: vi.fn(),
		error: vi.fn(),
	}),
}));

// Mock JolliApiUtils
vi.mock("./JolliApiUtils.js", () => ({
	parseBaseUrl: vi.fn().mockReturnValue({ origin: "https://jolli.app", tenantSlug: undefined }),
	parseJolliApiKey: vi.fn().mockReturnValue({ t: "tenant1", u: "https://jolli.app", o: "eng" }),
}));

describe("LlmClient", () => {
	const originalEnv = process.env.ANTHROPIC_API_KEY;

	beforeEach(() => {
		delete process.env.ANTHROPIC_API_KEY;
		mockCreate.mockReset();
		mockLogWarn.mockReset();
		mockCreate.mockResolvedValue({
			content: [{ type: "text", text: "response text" }],
			model: "claude-sonnet-4-6",
			usage: { input_tokens: 50, output_tokens: 10 },
			stop_reason: "end_turn",
		});
	});

	afterEach(() => {
		if (originalEnv) {
			process.env.ANTHROPIC_API_KEY = originalEnv;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	describe("direct mode", () => {
		it("resolves the prompt template from the action and fills params", async () => {
			const result = await callLlm({
				action: "translate",
				params: { content: "# Test" },
				apiKey: "sk-ant-test",
				model: "claude-sonnet-4-6",
			});

			expect(mockCreate).toHaveBeenCalledWith({
				model: "claude-sonnet-4-6",
				max_tokens: 8192,
				temperature: 0,
				messages: [
					{
						role: "user",
						content: expect.stringContaining("# Test"),
					},
				],
			});
			expect(result.text).toBe("response text");
			expect(result.model).toBe("claude-sonnet-4-6");
			expect(result.inputTokens).toBe(50);
			expect(result.outputTokens).toBe(10);
			expect(result.stopReason).toBe("end_turn");
		});

		it("warns when direct mode params do not fill every placeholder", async () => {
			await callLlm({
				action: "translate",
				params: {},
				apiKey: "sk-ant-test",
			});

			expect(mockLogWarn).toHaveBeenCalledWith(
				"Direct LLM call has unfilled placeholders for action=%s: %s",
				"translate",
				"content",
			);
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: [{ role: "user", content: expect.stringContaining("{{content}}") }],
				}),
			);
		});

		it("uses ANTHROPIC_API_KEY env var as fallback", async () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-env";

			const result = await callLlm({
				action: "translate",
				params: { content: "test prompt" },
			});

			expect(result.text).toBe("response text");
		});

		it("respects custom maxTokens", async () => {
			await callLlm({
				action: "translate",
				params: { content: "test" },
				apiKey: "sk-ant-test",
				maxTokens: 256,
			});

			expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 256 }));
		});

		it("throws when the action has no known template", async () => {
			await expect(
				callLlm({
					action: "unknown-action",
					params: {},
					apiKey: "sk-ant-test",
				}),
			).rejects.toThrow('Unknown LLM action: "unknown-action"');
		});

		it("wraps SDK errors with the client baseURL so relay failures are distinguishable", async () => {
			mockCreate.mockRejectedValueOnce(new Error("401 token expired"));

			await expect(
				callLlm({
					action: "translate",
					params: { content: "test" },
					apiKey: "sk-ant-test",
				}),
			).rejects.toThrow("LLM direct request to https://api.anthropic.com failed: 401 token expired");
		});

		it("wraps non-Error rejections by stringifying them", async () => {
			mockCreate.mockRejectedValueOnce("raw string failure");

			await expect(
				callLlm({
					action: "translate",
					params: { content: "test" },
					apiKey: "sk-ant-test",
				}),
			).rejects.toThrow("LLM direct request to https://api.anthropic.com failed: raw string failure");
		});

		it("throws when API returns no text content", async () => {
			mockCreate.mockResolvedValueOnce({
				content: [{ type: "image", source: {} }],
				usage: { input_tokens: 10, output_tokens: 0 },
			});

			await expect(
				callLlm({
					action: "translate",
					params: { content: "test" },
					apiKey: "sk-ant-test",
				}),
			).rejects.toThrow("No text content");
		});
	});

	describe("proxy mode", () => {
		let fetchSpy: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			fetchSpy = vi.fn().mockResolvedValue({
				ok: true,
				json: vi.fn().mockResolvedValue({ text: "proxy result", inputTokens: 30, outputTokens: 5 }),
			});
			vi.stubGlobal("fetch", fetchSpy);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("throws when proxy mode loses jolliApiKey before the inner proxy call", async () => {
			let reads = 0;
			const options = {
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
				get jolliApiKey() {
					reads += 1;
					return reads === 1 ? "sk-jol-test.secret" : undefined;
				},
			} as unknown as Parameters<typeof callLlm>[0];

			await expect(callLlm(options)).rejects.toThrow("Proxy mode requires jolliApiKey");
		});

		it("posts to the backend when jolliApiKey is provided", async () => {
			const result = await callLlm({
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff --git a/src/foo.ts" },
				jolliApiKey: "sk-jol-test.secret",
			});

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://jolli.app/api/push/llm/complete",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
						Authorization: "Bearer sk-jol-test.secret",
						"x-org-slug": "eng",
					}),
				}),
			);
			expect(result.text).toBe("proxy result");
			expect(result.inputTokens).toBe(30);
			expect(result.outputTokens).toBe(5);
		});

		it("sends x-tenant-slug header from URL path", async () => {
			const { parseBaseUrl, parseJolliApiKey } = vi.mocked(await import("./JolliApiUtils.js"));
			parseBaseUrl.mockReturnValueOnce({ origin: "https://jolli-local.me", tenantSlug: "test1" });
			parseJolliApiKey.mockReturnValueOnce({ t: "test1", u: "https://jolli-local.me/test1", o: "eng" });

			await callLlm({
				action: "summarize:small",
				params: {
					commitHash: "abc123",
					commitMessage: "test",
					commitAuthor: "Ada",
					commitDate: "2026-04-01",
					conversation: "talk",
					diff: "diff",
				},
				jolliApiKey: "sk-jol-test.secret",
			});

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://jolli-local.me/api/push/llm/complete",
				expect.objectContaining({
					headers: expect.objectContaining({
						"x-tenant-slug": "test1",
					}),
				}),
			);
		});

		it("throws when proxy returns error", async () => {
			fetchSpy.mockResolvedValueOnce({
				ok: false,
				status: 429,
				text: vi.fn().mockResolvedValue('{"error":"Rate limit exceeded"}'),
			});

			await expect(
				callLlm({
					action: "commit-message",
					params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
					jolliApiKey: "sk-jol-test.secret",
				}),
			).rejects.toThrow("status 429");
		});

		it("includes version in request body when specified", async () => {
			await callLlm({
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
				jolliApiKey: "sk-jol-test.secret",
				version: 2,
			});

			const fetchCall = fetchSpy.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(fetchCall[1].body as string) as Record<string, unknown>;
			expect(body.version).toBe(2);
		});

		it("defaults missing proxy token counts to zero", async () => {
			fetchSpy.mockResolvedValueOnce({
				ok: true,
				json: vi.fn().mockResolvedValue({ text: "proxy result" }),
			});

			const result = await callLlm({
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
				jolliApiKey: "sk-jol-test.secret",
			});

			expect(result.inputTokens).toBe(0);
			expect(result.outputTokens).toBe(0);
		});

		it("omits tenant and org headers when metadata is absent", async () => {
			const { parseBaseUrl, parseJolliApiKey } = vi.mocked(await import("./JolliApiUtils.js"));
			parseBaseUrl.mockReturnValueOnce({ origin: "https://jolli.app", tenantSlug: undefined });
			// Return null for both t and o to exercise the falsy-header branches
			parseJolliApiKey
				.mockReturnValueOnce({ t: "", u: "https://jolli.app", o: "" }) // callLlm's own parse
				.mockReturnValueOnce({ t: "", u: "https://jolli.app", o: "" }); // callProxy's parse

			await callLlm({
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
				jolliApiKey: "sk-jol-test.secret",
			});

			const fetchCall = fetchSpy.mock.calls[0] as [string, RequestInit];
			const headers = fetchCall[1].headers as Record<string, string>;
			expect(headers["x-tenant-slug"]).toBeUndefined();
			expect(headers["x-org-slug"]).toBeUndefined();
		});
	});

	describe("no credentials", () => {
		it("throws when neither apiKey nor jolliApiKey is provided", async () => {
			await expect(
				callLlm({
					action: "commit-message",
					params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
				}),
			).rejects.toThrow("No LLM provider available");
		});

		it("throws when jolliApiKey cannot be parsed for base URL", async () => {
			const { parseJolliApiKey } = vi.mocked(await import("./JolliApiUtils.js"));
			parseJolliApiKey.mockReturnValueOnce(null);

			await expect(
				callLlm({
					action: "commit-message",
					params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
					jolliApiKey: "sk-jol-invalid.key",
				}),
			).rejects.toThrow("Could not derive Jolli site URL");
		});
	});

	describe("resolveLlmCredentialSource", () => {
		it("prefers config apiKey over env var and jolliApiKey", () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-env";
			expect(resolveLlmCredentialSource({ apiKey: "sk-ant-cfg", jolliApiKey: "sk-jol-test.secret" })).toBe(
				"anthropic-config",
			);
		});

		it("falls back to ANTHROPIC_API_KEY env var when config apiKey is absent", () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-env";
			expect(resolveLlmCredentialSource({})).toBe("anthropic-env");
		});

		it("falls back to jolliApiKey when neither config apiKey nor env var is set", () => {
			expect(resolveLlmCredentialSource({ jolliApiKey: "sk-jol-test.secret" })).toBe("jolli-proxy");
		});

		it("returns null when no credentials are available", () => {
			expect(resolveLlmCredentialSource({})).toBeNull();
		});
	});
});
