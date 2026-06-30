import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	callLlm,
	DIRECT_FETCH_TIMEOUT_MS,
	isLlmCredentialError,
	LlmCredentialError,
	NO_LLM_PROVIDER_MESSAGE,
	NONSTREAM_MAX_OUTPUT_TOKENS,
	NONSTREAM_MAX_PROMPT_CHARS,
	PROXY_FETCH_TIMEOUT_MS,
	resolveLlmCredentialSource,
	STREAM_IDLE_TIMEOUT_MS,
	STREAM_MAX_WALL_CLOCK_MS,
} from "./LlmClient.js";
import { COMMIT_MSG_DIFF_BUDGET } from "./Summarizer.js";
import { runWithTrace } from "./TraceContext.js";

const { mockCreate, mockStream, mockLogInfo, mockLogWarn, mockLogError } = vi.hoisted(() => ({
	mockCreate: vi.fn(),
	mockStream: vi.fn(),
	mockLogInfo: vi.fn(),
	mockLogWarn: vi.fn(),
	mockLogError: vi.fn(),
}));

// Mock Anthropic SDK — must use `function` (not arrow) so `new Anthropic()` works in Vitest 4.x
vi.mock("@anthropic-ai/sdk", () => ({
	// biome-ignore lint/complexity/useArrowFunction: Vitest 4.x requires `function` for constructor mocks
	default: vi.fn().mockImplementation(function () {
		return {
			messages: { create: mockCreate, stream: mockStream },
			baseURL: "https://api.anthropic.com",
		};
	}),
}));

// Mock Logger
vi.mock("../Logger.js", () => ({
	createLogger: () => ({
		info: mockLogInfo,
		warn: mockLogWarn,
		debug: vi.fn(),
		error: mockLogError,
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
		mockStream.mockReset();
		mockLogInfo.mockReset();
		mockLogWarn.mockReset();
		mockLogError.mockReset();
		mockCreate.mockResolvedValue({
			content: [{ type: "text", text: "response text" }],
			model: "claude-sonnet-4-6",
			usage: { input_tokens: 50, output_tokens: 10 },
			stop_reason: "end_turn",
		});
		// Streaming path: messages.stream(...) returns a MessageStream-like
		// object whose `finalMessage()` resolves to the same Message shape.
		// `on` registers stream-event listeners (the inactivity watchdog) and
		// `abort` cancels the in-flight request.
		mockStream.mockReturnValue({
			finalMessage: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "streamed response" }],
				model: "claude-sonnet-4-6",
				usage: { input_tokens: 1000, output_tokens: 32_000 },
				stop_reason: "end_turn",
			}),
			on: vi.fn(),
			abort: vi.fn(),
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
			// maxTokens 256 + a tiny prompt keeps this on the non-streaming
			// `messages.create` carve-out (the default 8192 budget streams now).
			const result = await callLlm({
				action: "translate",
				params: { content: "# Test" },
				apiKey: "sk-ant-test",
				model: "claude-sonnet-4-6",
				maxTokens: 256,
			});

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: "claude-sonnet-4-6",
					max_tokens: 256,
					temperature: 0,
					messages: [
						{
							role: "user",
							content: expect.stringContaining("# Test"),
						},
					],
				},
				// Second arg carries the wall-clock timeout — see the
				// dedicated "AbortSignal" test below for the verification.
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect(result.text).toBe("response text");
			expect(result.model).toBe("claude-sonnet-4-6");
			expect(result.inputTokens).toBe(50);
			expect(result.outputTokens).toBe(10);
			// No cache fields in this usage → cachedTokens defaults to 0.
			expect(result.cachedTokens).toBe(0);
			expect(result.stopReason).toBe("end_turn");
			// Authoritative provider tag for the saved summary's metadata —
			// must match resolveLlmCredentialSource for the same options.
			expect(result.source).toBe("anthropic-config");
		});

		it("sums cache_read + cache_creation into cachedTokens", async () => {
			mockCreate.mockResolvedValueOnce({
				content: [{ type: "text", text: "cached response" }],
				model: "claude-sonnet-4-6",
				usage: {
					input_tokens: 50,
					output_tokens: 10,
					cache_read_input_tokens: 1500,
					cache_creation_input_tokens: 200,
				},
				stop_reason: "end_turn",
			});
			const result = await callLlm({
				action: "translate",
				params: { content: "# Test" },
				apiKey: "sk-ant-test",
				model: "claude-sonnet-4-6",
				maxTokens: 256,
			});
			// input_tokens stays the uncached prompt; cached folds both cache totals.
			expect(result.inputTokens).toBe(50);
			expect(result.cachedTokens).toBe(1700);
		});

		it("warns when direct mode params do not fill every placeholder", async () => {
			await callLlm({
				action: "translate",
				params: {},
				apiKey: "sk-ant-test",
				maxTokens: 256,
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
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
		});

		it("uses ANTHROPIC_API_KEY env var as fallback", async () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-env";

			const result = await callLlm({
				action: "translate",
				params: { content: "test prompt" },
				maxTokens: 256,
			});

			expect(result.text).toBe("response text");
			// Env-var fallback distinguishes itself from the config-key path
			// in the saved metadata — useful when a user has both set and we
			// need to know which one actually fired.
			expect(result.source).toBe("anthropic-env");
		});

		it("respects custom maxTokens", async () => {
			await callLlm({
				action: "translate",
				params: { content: "test" },
				apiKey: "sk-ant-test",
				maxTokens: 256,
			});

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({ max_tokens: 256 }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
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
					maxTokens: 256,
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
					maxTokens: 256,
				}),
			).rejects.toThrow("LLM direct request to https://api.anthropic.com failed: raw string failure");
		});

		it("flattens a transport-layer error cause chain into the diagnostic log", async () => {
			// Mimic the undici "fetch failed → cause" wrapping that motivated the helper.
			const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
				code: "ECONNREFUSED",
				errno: -61,
				syscall: "connect",
				address: "127.0.0.1",
				port: 443,
				hostname: "api.anthropic.com",
			});
			const middle = Object.assign(new Error(""), { name: "AggregateError", cause: inner });
			const outer = Object.assign(new TypeError("fetch failed"), { cause: middle });
			mockCreate.mockRejectedValueOnce(outer);

			await expect(
				callLlm({
					action: "translate",
					params: { content: "test" },
					apiKey: "sk-ant-test",
					maxTokens: 256,
				}),
			).rejects.toThrow("LLM direct request to https://api.anthropic.com failed: fetch failed");
		});

		it("treats a primitive-cause SDK error as having an empty diagnostic chain", async () => {
			// Exercises formatCause's "non-Error cause" branch (String(cause) at line 43).
			const err = Object.assign(new Error("boom"), { cause: "raw string cause" });
			mockCreate.mockRejectedValueOnce(err);

			await expect(
				callLlm({
					action: "translate",
					params: { content: "test" },
					apiKey: "sk-ant-test",
					maxTokens: 256,
				}),
			).rejects.toThrow("LLM direct request to https://api.anthropic.com failed: boom");
		});

		it("logs '(empty)' when the cause is an Error with no fields populated", async () => {
			// Exercises the `fields.join(' ') || '(empty)'` fallback in formatCause.
			// An Error whose `name` is "Error" (default) and whose message is "" produces
			// no fields — the helper must still return a non-empty string.
			const cause = new Error("");
			cause.name = "Error";
			const err = Object.assign(new Error("outer"), { cause });
			mockCreate.mockRejectedValueOnce(err);

			await expect(
				callLlm({
					action: "translate",
					params: { content: "test" },
					apiKey: "sk-ant-test",
					maxTokens: 256,
				}),
			).rejects.toThrow("LLM direct request to https://api.anthropic.com failed: outer");
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
					maxTokens: 256,
				}),
			).rejects.toThrow("No text content");
		});

		it("attaches an AbortSignal to bound the direct-call wall time", async () => {
			// Regression: pre-fix `callDirect` invoked the SDK without any
			// signal. A wedged TCP socket (firewall blackhole, suspended
			// cloud edge, half-open after suspend/resume) would hold the
			// in-flight call indefinitely — observed holding
			// `ConflictResolver.resolveAll` for 2+ hours and leaving the
			// sidebar "Sorting out conflicts…" label stuck.
			await callLlm({
				action: "translate",
				params: { content: "test" },
				apiKey: "sk-ant-test",
				maxTokens: 256,
			});
			const call = mockCreate.mock.calls.at(-1);
			expect(call).toBeDefined();
			// Second positional arg is the SDK's per-request options bag.
			const requestOptions = call?.[1] as { signal?: unknown } | undefined;
			expect(requestOptions?.signal).toBeInstanceOf(AbortSignal);
		});

		it("logs model, maxTokens, promptChars, elapsedMs plus errorName/httpStatus/requestId so timeout-vs-size-vs-server is diagnosable", async () => {
			// A large call streams; when it aborts on the wall-clock/idle timeout the
			// catch must log enough to tell "prompt too big for the budget" from a
			// wedged connection from a server-side rejection — without re-running.
			// An abort that fired on an in-flight request has NO httpStatus and NO
			// requestId (the response never came), the wedge/slow fingerprint.
			mockStream.mockReturnValueOnce({
				finalMessage: vi.fn().mockRejectedValue(new Error("Request was aborted.")),
				on: vi.fn(),
				abort: vi.fn(),
			});

			await expect(
				callLlm({
					action: "translate",
					params: { content: "test" },
					apiKey: "sk-ant-test",
					model: "claude-sonnet-4-6",
					maxTokens: 8192,
				}),
			).rejects.toThrow("LLM direct request to https://api.anthropic.com failed: Request was aborted.");

			expect(mockLogError).toHaveBeenCalledWith(
				expect.stringMatching(
					/maxTokens=%d.*promptChars=%d.*elapsedMs=%d.*errorName=%s.*httpStatus=%s.*requestId=%s/,
				),
				"translate", // action
				expect.any(String), // resolved model id
				8192, // maxTokens
				expect.any(Number), // promptChars
				expect.any(Number), // elapsedMs
				"https://api.anthropic.com", // baseUrl
				"Error", // errorName (the rejected Error's name)
				"(none)", // httpStatus — an in-flight abort carries no HTTP status
				"(none)", // requestId — the request never reached the server
				"Request was aborted.", // message
				expect.any(String), // cause
			);
		});

		it("surfaces httpStatus and request_id when a server-side error carries them", async () => {
			// A rate-limit (429) / overloaded (529) / 5xx error from Anthropic carries
			// an HTTP status and a request id; surfacing them separates "the API
			// rejected us" from "the connection never produced a response".
			const apiErr = Object.assign(new Error("429 rate limited"), { status: 429, request_id: "req_abc123" });
			mockCreate.mockRejectedValueOnce(apiErr);

			await expect(
				callLlm({ action: "translate", params: { content: "x" }, apiKey: "sk-ant-test", maxTokens: 256 }),
			).rejects.toThrow("429 rate limited");

			expect(mockLogError).toHaveBeenCalledWith(
				expect.stringMatching(/errorName=%s.*httpStatus=%s.*requestId=%s/),
				"translate",
				expect.any(String),
				256,
				expect.any(Number),
				expect.any(Number),
				"https://api.anthropic.com",
				"Error",
				"429",
				"req_abc123",
				"429 rate limited",
				expect.any(String),
			);
		});

		it("surfaces status + requestID (camelCase fallback) on the STREAMING path too", async () => {
			// Server-side errors (429/529/5xx) most often hit the large STREAMING
			// calls (reconcile/summarize), where `finalMessage()` rejects. The shared
			// catch must surface status + the id there too, reading the camelCase
			// `requestID` fallback when `request_id` is absent. maxTokens 8192 streams.
			const apiErr = Object.assign(new Error("500 server error"), { status: 500, requestID: "req_xyz789" });
			mockStream.mockReturnValueOnce({
				finalMessage: vi.fn().mockRejectedValue(apiErr),
				on: vi.fn(),
				abort: vi.fn(),
			});

			await expect(
				callLlm({ action: "translate", params: { content: "x" }, apiKey: "sk-ant-test", maxTokens: 8192 }),
			).rejects.toThrow("500 server error");

			expect(mockLogError).toHaveBeenCalledWith(
				expect.stringMatching(/httpStatus=%s.*requestId=%s/),
				"translate",
				expect.any(String),
				8192,
				expect.any(Number),
				expect.any(Number),
				"https://api.anthropic.com",
				"Error",
				"500",
				"req_xyz789",
				"500 server error",
				expect.any(String),
			);
		});

		it("uses streaming when maxTokens exceeds the SDK's non-streaming guardrail", async () => {
			// The Anthropic SDK refuses non-streaming requests whose estimated
			// duration exceeds 10 minutes. The topic-KB `reconcile` action raises
			// maxTokens to 64K and triggers this. Verify the high-token call goes
			// through `messages.stream`, not `create`.
			const result = await callLlm({
				action: "reconcile",
				params: { topicTitle: "Auth", currentPage: "", sources: "src" },
				apiKey: "sk-ant-test",
				model: "claude-sonnet-4-6",
				maxTokens: 64_000,
			});

			expect(mockStream).toHaveBeenCalledTimes(1);
			expect(mockCreate).not.toHaveBeenCalled();
			expect(mockStream.mock.calls[0][0]).toMatchObject({ max_tokens: 64_000 });
			expect(result.text).toBe("streamed response");
			expect(result.outputTokens).toBe(32_000);
		});

		it("uses non-streaming only when the call is small on BOTH axes", async () => {
			// Tiny output cap AND tiny prompt → the simple non-streaming path.
			await callLlm({
				action: "translate",
				params: { content: "x" },
				apiKey: "sk-ant-test",
				model: "claude-sonnet-4-6",
				maxTokens: 256,
			});

			expect(mockCreate).toHaveBeenCalledTimes(1);
			expect(mockStream).not.toHaveBeenCalled();
		});

		it("streams when the output cap is large even if the prompt is tiny", async () => {
			await callLlm({
				action: "translate",
				params: { content: "x" },
				apiKey: "sk-ant-test",
				model: "claude-sonnet-4-6",
				maxTokens: 8192,
			});

			expect(mockStream).toHaveBeenCalledTimes(1);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it("streams when the prompt is large even if the output cap is tiny (commit-message with a huge diff)", async () => {
			// The motivating case: a small-output action carrying a large input must
			// NOT be pinned to the fixed-budget non-streaming path. The filled
			// template is already > NONSTREAM_MAX_PROMPT_CHARS from `content` alone.
			await callLlm({
				action: "translate",
				params: { content: "x".repeat(NONSTREAM_MAX_PROMPT_CHARS + 1) },
				apiKey: "sk-ant-test",
				model: "claude-sonnet-4-6",
				maxTokens: 256,
			});

			expect(mockStream).toHaveBeenCalledTimes(1);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it("treats the output-cap boundary correctly: ≤ limit stays non-streaming, +1 streams", async () => {
			await callLlm({
				action: "translate",
				params: { content: "x" },
				apiKey: "sk-ant-test",
				maxTokens: NONSTREAM_MAX_OUTPUT_TOKENS,
			});
			expect(mockCreate).toHaveBeenCalledTimes(1);
			expect(mockStream).not.toHaveBeenCalled();

			mockCreate.mockClear();
			await callLlm({
				action: "translate",
				params: { content: "x" },
				apiKey: "sk-ant-test",
				maxTokens: NONSTREAM_MAX_OUTPUT_TOKENS + 1,
			});
			expect(mockStream).toHaveBeenCalledTimes(1);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it("treats the prompt-char boundary correctly: prompt == limit stays non-streaming, +1 streams", async () => {
			// The decision compares prompt.length (the FILLED template), not the raw
			// param. Measure the template overhead with a probe call, then size
			// `content` to land the prompt exactly on NONSTREAM_MAX_PROMPT_CHARS — with
			// a tiny maxTokens so only the input axis decides. This pins the `<=` on
			// the input side (a `<` slip or wrong constant breaks one assertion).
			const probe = "PROBE";
			await callLlm({ action: "translate", params: { content: probe }, apiKey: "sk-ant-test", maxTokens: 256 });
			const probeBody = mockCreate.mock.calls.at(-1)?.[0] as { messages: { content: string }[] };
			const overhead = probeBody.messages[0].content.length - probe.length;

			mockCreate.mockClear();
			mockStream.mockClear();
			await callLlm({
				action: "translate",
				params: { content: "x".repeat(NONSTREAM_MAX_PROMPT_CHARS - overhead) },
				apiKey: "sk-ant-test",
				maxTokens: 256,
			});
			expect(mockCreate).toHaveBeenCalledTimes(1);
			expect(mockStream).not.toHaveBeenCalled();
			// Confirm we actually landed on the boundary, not merely under it.
			const atLimitBody = mockCreate.mock.calls.at(-1)?.[0] as { messages: { content: string }[] };
			expect(atLimitBody.messages[0].content.length).toBe(NONSTREAM_MAX_PROMPT_CHARS);

			mockCreate.mockClear();
			await callLlm({
				action: "translate",
				params: { content: "x".repeat(NONSTREAM_MAX_PROMPT_CHARS - overhead + 1) },
				apiKey: "sk-ant-test",
				maxTokens: 256,
			});
			expect(mockStream).toHaveBeenCalledTimes(1);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it("uses streaming when forceStreaming is set, even for an otherwise-trivial call", async () => {
			// forceStreaming's only remaining job is to force the streaming path on a
			// call that WOULD be trivial (small output AND small prompt). Use exactly
			// such a call (maxTokens 256 + tiny prompt) so this test actually guards
			// the `forceStreaming === true ||` branch — dropping that branch would
			// route this to messages.create and fail the assertion.
			await callLlm({
				action: "translate",
				params: { content: "x" },
				apiKey: "sk-ant-test",
				model: "claude-sonnet-4-6",
				maxTokens: 256,
				forceStreaming: true,
			});

			expect(mockStream).toHaveBeenCalledTimes(1);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it("logs the streaming path decision (observability) with the reason on every direct call", async () => {
			// A successful call otherwise records nothing about the chosen path;
			// this info log lets debug.log confirm streaming-vs-non-streaming (and
			// why) without forcing a failure. Verify the decision + reason per case.

			// trivial → non-streaming
			await callLlm({ action: "translate", params: { content: "x" }, apiKey: "sk-ant-test", maxTokens: 256 });
			expect(mockLogInfo).toHaveBeenCalledWith(
				expect.stringContaining("Direct path: action=%s streaming=%s reason=%s"),
				"translate",
				false,
				"trivial(small output+prompt)",
				256,
				expect.any(Number),
				NONSTREAM_MAX_OUTPUT_TOKENS,
				NONSTREAM_MAX_PROMPT_CHARS,
			);

			// large output only → streaming
			mockLogInfo.mockClear();
			await callLlm({ action: "translate", params: { content: "x" }, apiKey: "sk-ant-test", maxTokens: 8192 });
			expect(mockLogInfo).toHaveBeenCalledWith(
				expect.stringContaining("streaming=%s reason=%s"),
				"translate",
				true,
				"large output",
				8192,
				expect.any(Number),
				NONSTREAM_MAX_OUTPUT_TOKENS,
				NONSTREAM_MAX_PROMPT_CHARS,
			);

			// large output AND large prompt → streaming (covers the combined reason)
			mockLogInfo.mockClear();
			await callLlm({
				action: "translate",
				params: { content: "x".repeat(NONSTREAM_MAX_PROMPT_CHARS + 1) },
				apiKey: "sk-ant-test",
				maxTokens: 8192,
			});
			expect(mockLogInfo).toHaveBeenCalledWith(
				expect.stringContaining("reason=%s"),
				"translate",
				true,
				"large output+prompt",
				8192,
				expect.any(Number),
				NONSTREAM_MAX_OUTPUT_TOKENS,
				NONSTREAM_MAX_PROMPT_CHARS,
			);
		});

		it("aborts a streaming call when no stream events arrive within the idle window", async () => {
			vi.useFakeTimers();
			try {
				// finalMessage hangs (wedged socket) until abort() rejects it — the
				// SDK surfaces an aborted request as a rejection.
				let rejectFinal: (err: Error) => void = () => {};
				const finalMessage = vi.fn(
					() =>
						new Promise((_resolve, reject) => {
							rejectFinal = reject;
						}),
				);
				const abort = vi.fn(() => rejectFinal(new Error("Request was aborted.")));
				mockStream.mockReturnValue({ finalMessage, on: vi.fn(), abort });

				const promise = callLlm({
					action: "reconcile",
					params: { topicTitle: "Auth", currentPage: "", sources: "src" },
					apiKey: "sk-ant-test",
					model: "claude-sonnet-4-6",
					maxTokens: 64_000,
				});
				// Catch eagerly so the rejection isn't flagged as unhandled while
				// fake timers advance.
				const settled = promise.catch((e: unknown) => e);

				// No stream events fire; the inactivity watchdog must abort once the
				// idle window elapses.
				await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 10);

				expect(abort).toHaveBeenCalledTimes(1);
				const err = await settled;
				expect(String(err)).toContain("aborted");
			} finally {
				vi.useRealTimers();
			}
		});

		it("aborts a streaming call at the wall-clock cap even while stream events keep arriving", async () => {
			vi.useFakeTimers();
			try {
				let rejectFinal: (err: Error) => void = () => {};
				const finalMessage = vi.fn(
					() =>
						new Promise((_resolve, reject) => {
							rejectFinal = reject;
						}),
				);
				const abort = vi.fn(() => rejectFinal(new Error("Request was aborted.")));
				let onStreamEvent: (() => void) | undefined;
				const on = vi.fn((event: string, cb: () => void) => {
					if (event === "streamEvent") onStreamEvent = cb;
				});
				mockStream.mockReturnValue({ finalMessage, on, abort });

				const promise = callLlm({
					action: "reconcile",
					params: { topicTitle: "Auth", currentPage: "", sources: "src" },
					apiKey: "sk-ant-test",
					model: "claude-sonnet-4-6",
					maxTokens: 64_000,
				});
				const settled = promise.catch((e: unknown) => e);

				// A stream that pings forever keeps resetting the idle watchdog. Each
				// step is below the idle window so the idle watchdog never fires; the
				// independent wall-clock cap must still abort once it elapses.
				const step = STREAM_IDLE_TIMEOUT_MS - 20_000;
				for (let elapsed = 0; elapsed <= STREAM_MAX_WALL_CLOCK_MS; elapsed += step) {
					await vi.advanceTimersByTimeAsync(step);
					onStreamEvent?.();
				}

				expect(abort).toHaveBeenCalled();
				const err = await settled;
				expect(String(err)).toContain("aborted");
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not abort a streaming call while stream events keep arriving", async () => {
			vi.useFakeTimers();
			try {
				let resolveFinal: (msg: unknown) => void = () => {};
				const finalMessage = vi.fn(
					() =>
						new Promise((resolve) => {
							resolveFinal = resolve;
						}),
				);
				const abort = vi.fn();
				let onStreamEvent: (() => void) | undefined;
				const on = vi.fn((event: string, cb: () => void) => {
					if (event === "streamEvent") onStreamEvent = cb;
				});
				mockStream.mockReturnValue({ finalMessage, on, abort });

				const promise = callLlm({
					action: "reconcile",
					params: { topicTitle: "Auth", currentPage: "", sources: "src" },
					apiKey: "sk-ant-test",
					model: "claude-sonnet-4-6",
					maxTokens: 64_000,
				});

				// A slow stream: an event arrives just before each idle deadline,
				// resetting the watchdog. Total elapsed far exceeds the idle window
				// yet abort must never fire.
				for (let i = 0; i < 5; i++) {
					await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1_000);
					onStreamEvent?.();
				}
				expect(abort).not.toHaveBeenCalled();

				resolveFinal({
					content: [{ type: "text", text: "streamed response" }],
					model: "claude-sonnet-4-6",
					usage: { input_tokens: 1000, output_tokens: 32_000 },
					stop_reason: "end_turn",
				});
				const result = await promise;
				expect(result.text).toBe("streamed response");
			} finally {
				vi.useRealTimers();
			}
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
						"x-jolli-client": expect.stringMatching(/^cli\//),
					}),
				}),
			);
			expect(result.text).toBe("proxy result");
			expect(result.inputTokens).toBe(30);
			expect(result.outputTokens).toBe(5);
			// Proxy results have no model from the backend, but source is
			// still carried back so saved metadata can record "via proxy".
			expect(result.source).toBe("jolli-proxy");
		});

		it("mints a fresh x-jolli-trace value outside any trace scope", async () => {
			await callLlm({
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
				jolliApiKey: "sk-jol-test.secret",
			});
			const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
			// Every outbound request is traceable — a fresh standalone value, not omitted.
			expect(headers["x-jolli-trace"]).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}$/);
		});

		it("injects an x-jolli-trace value carrying the ambient trace id", async () => {
			const traceId = "a".repeat(32);
			await runWithTrace(traceId, () =>
				callLlm({
					action: "commit-message",
					params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
					jolliApiKey: "sk-jol-test.secret",
				}),
			);
			const headers = fetchSpy.mock.calls[0][1].headers as Record<string, string>;
			expect(headers["x-jolli-trace"]).toMatch(new RegExp(`^${traceId}-[0-9a-f]{16}$`));
		});

		// Pins the build-time identity in the `x-jolli-client` header. Kind
		// comes from `__JOLLI_CLIENT_KIND__`, version from `__PKG_VERSION__` —
		// both are baked in at bundle time by either vite (CLI build) or
		// esbuild (VSCode build). The two cases below exercise both paths via
		// `vi.resetModules()` + `vi.stubGlobal(...)` so a future builder change
		// can't silently regress to e.g. `cli/<vscode-version>`.
		describe("x-jolli-client identity is bundler-driven", () => {
			it("reports the cli kind and cli version under a CLI build", async () => {
				vi.resetModules();
				vi.stubGlobal("__JOLLI_CLIENT_KIND__", "cli");
				vi.stubGlobal("__PKG_VERSION__", "0.98.0");
				vi.stubGlobal("fetch", fetchSpy);
				const { callLlm: callLlmFresh } = await import("./LlmClient.js");

				await callLlmFresh({
					action: "commit-message",
					params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
					jolliApiKey: "sk-jol-test.secret",
				});

				expect(fetchSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						headers: expect.objectContaining({
							"x-jolli-client": "cli/0.98.0",
						}),
					}),
				);
			});

			it("reports vscode-plugin and the VSCode version under a VSCode-bundled build, even when the inlined CLI code is older", async () => {
				vi.resetModules();
				// Reproduce the VSCode esbuild path: kind is the surface
				// (`vscode-plugin`), and __PKG_VERSION__ is the VSCode
				// extension version (NOT the cli/package.json version of the
				// bundled CLI code, which is what __CLI_PKG_VERSION__ holds).
				vi.stubGlobal("__JOLLI_CLIENT_KIND__", "vscode-plugin");
				vi.stubGlobal("__PKG_VERSION__", "0.98.17");
				// Also set __CLI_PKG_VERSION__ to the older CLI code version
				// — the test would catch a regression that read this token
				// instead: any "0.98.0" in the header would mean we're
				// advertising the inlined CLI code version under a VSCode
				// surface, which is also wrong.
				vi.stubGlobal("__CLI_PKG_VERSION__", "0.98.0");
				vi.stubGlobal("fetch", fetchSpy);
				const { callLlm: callLlmFresh } = await import("./LlmClient.js");

				await callLlmFresh({
					action: "commit-message",
					params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
					jolliApiKey: "sk-jol-test.secret",
				});

				expect(fetchSpy).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({
						headers: expect.objectContaining({
							"x-jolli-client": "vscode-plugin/0.98.17",
						}),
					}),
				);
			});

			// Note: the cli/dev fallback (when neither global is defined, e.g.
			// `tsx`-driven dev runs) is implicitly exercised by every other
			// test in this file, which all hit the default `^cli\/` matcher
			// without stubbing these globals.
		});

		it("attaches an AbortSignal to bound proxy fetch wall time", async () => {
			await callLlm({
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff --git a/src/foo.ts" },
				jolliApiKey: "sk-jol-test.secret",
			});

			const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
			expect(init.signal).toBeInstanceOf(AbortSignal);
		});

		it("sends x-tenant-slug header from URL path", async () => {
			const { parseBaseUrl, parseJolliApiKey } = vi.mocked(await import("./JolliApiUtils.js"));
			parseBaseUrl.mockReturnValueOnce({ origin: "https://jolli-local.me", tenantSlug: "test1" });
			parseJolliApiKey.mockReturnValueOnce({ t: "test1", u: "https://jolli-local.me/test1", o: "eng" });

			await callLlm({
				action: "summarize",
				params: {
					commitHash: "abc123",
					commitMessage: "test",
					commitAuthor: "Ada",
					commitDate: "2026-04-01",
					conversation: "talk",
					diff: "diff",
					topicGuidance: "6. Return 1-3 topics.\n7. Single purpose preferred.",
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

		it("includes explicit caller-supplied version (overrides TEMPLATES default)", async () => {
			// Pass an unambiguous version (99) to verify the override path,
			// not the auto-injected version which happens to be 2 today.
			await callLlm({
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
				jolliApiKey: "sk-jol-test.secret",
				version: 99,
			});

			const fetchCall = fetchSpy.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(fetchCall[1].body as string) as Record<string, unknown>;
			expect(body.version).toBe(99);
		});

		it("auto-injects version from TEMPLATES when caller does not specify one", async () => {
			await callLlm({
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
				jolliApiKey: "sk-jol-test.secret",
			});

			const fetchCall = fetchSpy.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(fetchCall[1].body as string) as Record<string, unknown>;
			// commit-message is registered in TEMPLATES at version 2.
			// If anyone bumps it, update this assertion intentionally.
			expect(body.version).toBe(2);
		});

		it("omits version when action is unknown to TEMPLATES (graceful degrade)", async () => {
			// Direct mode would throw on an unknown action because it needs the
			// template; proxy mode delegates template resolution to the backend,
			// so an unknown-to-CLI action is allowed and the request goes through
			// without a version (backend resolves max-revision as fallback).
			await callLlm({
				action: "future-action-not-in-cli-templates",
				params: {},
				jolliApiKey: "sk-jol-test.secret",
			});

			const fetchCall = fetchSpy.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(fetchCall[1].body as string) as Record<string, unknown>;
			expect(body).not.toHaveProperty("version");
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

		it("rethrows the original transport error when fetch itself fails", async () => {
			const inner = Object.assign(new Error("getaddrinfo ENOTFOUND jolli.app"), {
				code: "ENOTFOUND",
				syscall: "getaddrinfo",
				hostname: "jolli.app",
			});
			const transport = Object.assign(new TypeError("fetch failed"), { cause: inner });
			fetchSpy.mockRejectedValueOnce(transport);

			await expect(
				callLlm({
					action: "commit-message",
					params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
					jolliApiKey: "sk-jol-test.secret",
				}),
			).rejects.toBe(transport);

			// Diagnostic parity with the direct path: the proxy catch logs
			// elapsedMs + bodyChars + errorName so a wall-clock-timeout abort (≈180s,
			// name AbortError) is distinguishable from a transport failure that fails
			// faster with a populated cause.
			expect(mockLogError).toHaveBeenCalledWith(
				expect.stringMatching(/elapsedMs=%d.*bodyChars=%d.*errorName=%s/),
				"commit-message",
				expect.stringContaining("/api/push/llm/complete"),
				expect.any(Number),
				expect.any(Number),
				"TypeError",
				"fetch failed",
				expect.any(String),
			);
		});

		it("rethrows when fetch rejects with a non-Error value", async () => {
			fetchSpy.mockRejectedValueOnce("kaboom");

			await expect(
				callLlm({
					action: "commit-message",
					params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
					jolliApiKey: "sk-jol-test.secret",
				}),
			).rejects.toBe("kaboom");
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

		// aiProvider as authoritative override — pins the bug fix that
		// closed the "Settings UI says Jolli, dispatcher routes to Anthropic"
		// mismatch. Settings explicit choice must win over credential
		// presence; missing credential for the chosen provider returns null
		// rather than silently fall through (silent fallback was the bug).

		it("aiProvider='jolli' picks proxy even when an Anthropic config key is also set", () => {
			expect(
				resolveLlmCredentialSource({
					apiKey: "sk-ant-cfg",
					jolliApiKey: "sk-jol-test.secret",
					aiProvider: "jolli",
				}),
			).toBe("jolli-proxy");
		});

		it("aiProvider='jolli' returns null when jolliApiKey is missing (no silent Anthropic fallback)", () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-env";
			expect(
				resolveLlmCredentialSource({
					apiKey: "sk-ant-cfg",
					aiProvider: "jolli",
				}),
			).toBeNull();
		});

		it("aiProvider='anthropic' picks config key over env when both are set", () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-env";
			expect(
				resolveLlmCredentialSource({
					apiKey: "sk-ant-cfg",
					jolliApiKey: "sk-jol-test.secret",
					aiProvider: "anthropic",
				}),
			).toBe("anthropic-config");
		});

		it("aiProvider='anthropic' falls back to env var when no config key", () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-env";
			expect(
				resolveLlmCredentialSource({
					jolliApiKey: "sk-jol-test.secret",
					aiProvider: "anthropic",
				}),
			).toBe("anthropic-env");
		});

		it("aiProvider='anthropic' returns null with only a Jolli key (no silent proxy fallback)", () => {
			expect(
				resolveLlmCredentialSource({
					jolliApiKey: "sk-jol-test.secret",
					aiProvider: "anthropic",
				}),
			).toBeNull();
		});

		it("aiProvider undefined keeps the legacy precedence so older configs still resolve", () => {
			// Pre-aiProvider configs (no field set) must keep working; a user
			// who only ever had ANTHROPIC_API_KEY in env shouldn't suddenly
			// see "no credentials" because the field defaults to undefined.
			process.env.ANTHROPIC_API_KEY = "sk-ant-env";
			expect(
				resolveLlmCredentialSource({
					apiKey: "sk-ant-cfg",
					jolliApiKey: "sk-jol-test.secret",
				}),
			).toBe("anthropic-config");
		});
	});

	// Dispatch-site logging — every callLlm leaves a single info trace
	// identifying the resolved provider, so users can grep `debug.log` after
	// a commit and verify Settings UI's choice was actually honored. Pinned
	// here because losing this log silently would re-create the original
	// "Settings says Jolli, can't tell from logs what actually ran" gap.

	describe("dispatch-site provider log", () => {
		// Local fetch mock — proxy mode tests live in a sibling describe with
		// their own fetchSpy beforeEach, but this block needs to exercise both
		// modes from one place to keep the contract assertions co-located.
		beforeEach(() => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: true,
					json: vi.fn().mockResolvedValue({ text: "proxy result", inputTokens: 1, outputTokens: 1 }),
				}),
			);
		});
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("logs source=anthropic-config for direct mode (config key)", async () => {
			await callLlm({
				action: "translate",
				params: { content: "test" },
				apiKey: "sk-ant-cfg",
			});
			expect(mockLogInfo).toHaveBeenCalledWith("LLM call: action=%s source=%s", "translate", "anthropic-config");
		});

		it("logs source=anthropic-env for direct mode (env fallback)", async () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-env";
			await callLlm({
				action: "translate",
				params: { content: "test" },
			});
			expect(mockLogInfo).toHaveBeenCalledWith("LLM call: action=%s source=%s", "translate", "anthropic-env");
		});

		it("logs source=jolli-proxy for proxy mode", async () => {
			await callLlm({
				action: "commit-message",
				params: { branch: "main", fileList: "src/foo.ts", stagedDiff: "diff" },
				jolliApiKey: "sk-jol-test.secret",
			});
			expect(mockLogInfo).toHaveBeenCalledWith("LLM call: action=%s source=%s", "commit-message", "jolli-proxy");
		});

		it("does NOT emit the dispatch log when no provider is available", async () => {
			// When source resolves to null, callLlm throws before dispatching.
			// The log line implies "an LLM call happened" — emitting it for the
			// no-credential path would be misleading in postmortems.
			await expect(callLlm({ action: "translate", params: { content: "x" } })).rejects.toThrow(
				"No LLM provider available",
			);
			expect(mockLogInfo).not.toHaveBeenCalledWith(
				"LLM call: action=%s source=%s",
				expect.anything(),
				expect.anything(),
			);
		});
	});

	describe("isLlmCredentialError", () => {
		it("returns true for the canonical no-provider error thrown by callLlm", async () => {
			let caught: unknown;
			try {
				await callLlm({ action: "translate", params: { content: "x" } });
			} catch (err) {
				caught = err;
			}
			expect(isLlmCredentialError(caught)).toBe(true);
			// Belt-and-suspenders: the thrown value is the dedicated subclass,
			// not just any Error with the canonical message. This is what lets
			// the QueueWorker's `instanceof` guard survive future tweaks to
			// NO_LLM_PROVIDER_MESSAGE.
			expect(caught).toBeInstanceOf(LlmCredentialError);
		});

		it("returns true for a freshly-constructed LlmCredentialError", () => {
			expect(isLlmCredentialError(new LlmCredentialError())).toBe(true);
		});

		// Pins the regression that motivated the subclass: a plain `new
		// Error(NO_LLM_PROVIDER_MESSAGE)` must NOT be recognized as a credential
		// error. This is what protects the QueueWorker guard from silently
		// breaking if anyone reformats / prefixes / i18ns the message constant.
		it("returns false for a plain Error whose message merely matches the constant", () => {
			expect(isLlmCredentialError(new Error(NO_LLM_PROVIDER_MESSAGE))).toBe(false);
		});

		it("returns false for unrelated errors", () => {
			expect(isLlmCredentialError(new Error("network timeout"))).toBe(false);
			expect(isLlmCredentialError(new Error("Could not derive Jolli site URL"))).toBe(false);
		});

		it("returns false for non-Error values", () => {
			expect(isLlmCredentialError(undefined)).toBe(false);
			expect(isLlmCredentialError("string error")).toBe(false);
			expect(isLlmCredentialError({ message: NO_LLM_PROVIDER_MESSAGE })).toBe(false);
		});
	});

	describe("fetch timeout budgets", () => {
		it("caps direct and proxy LLM calls at 180s (raised from 120s for large squash/regenerate prompts)", () => {
			// Regenerate of a large squash commit aggregates the whole tree's
			// transcripts + diff into one prompt; at the previous 120s ceiling the
			// non-streaming Anthropic call was aborted mid-flight ("Request was
			// aborted."). 180s gives the largest prompts headroom. Both paths move
			// together so the proxy backend's own Anthropic round-trip — which the
			// proxy fetch wraps — gets the same budget.
			expect(DIRECT_FETCH_TIMEOUT_MS).toBe(180_000);
			expect(PROXY_FETCH_TIMEOUT_MS).toBe(180_000);
		});
	});

	describe("streaming carve-out thresholds", () => {
		it("pins the non-streaming carve-out limits (a change here flips which calls stream)", () => {
			// The direct path streams unless a call is small on BOTH axes. These
			// values gate that decision; a regression here silently re-routes a
			// whole class of calls onto the fixed-budget non-streaming path.
			expect(NONSTREAM_MAX_OUTPUT_TOKENS).toBe(512);
			expect(NONSTREAM_MAX_PROMPT_CHARS).toBe(16_000);
		});

		it("keeps the commit-message diff budget under the non-streaming prompt limit (cross-module headroom)", () => {
			// commit-message truncates its diff to COMMIT_MSG_DIFF_BUDGET specifically
			// so the assembled prompt (diff + template + fileList) stays under
			// NONSTREAM_MAX_PROMPT_CHARS and keeps the fast non-streaming path. These
			// two constants live in different modules; bumping the budget past the
			// limit would silently re-route every commit-message onto streaming.
			expect(COMMIT_MSG_DIFF_BUDGET).toBeLessThan(NONSTREAM_MAX_PROMPT_CHARS);
		});
	});
});
