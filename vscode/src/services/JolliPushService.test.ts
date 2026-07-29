import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock types ─────────────────────────────────────────────────────────────

interface MockIncomingMessage {
	statusCode: number;
	on: ReturnType<typeof vi.fn>;
	resume: ReturnType<typeof vi.fn>;
}

interface MockClientRequest {
	on: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a mock IncomingMessage that emits data chunks then 'end'.
 *
 * Emission is scheduled when the consumer registers its `end` listener (rather
 * than eagerly at creation): by then pushToJolli has attached both `data` and
 * `end` handlers. This is robust against the outbound-push gate's extra `await`,
 * which reorders microtasks — a creation-time pre-scheduled emit would fire
 * before the listeners attach and hang the test.
 */
function createMockResponse(
	statusCode: number,
	body: string,
): MockIncomingMessage {
	const listeners: Record<
		string,
		Array<(...args: Array<unknown>) => void>
	> = {};
	const res: MockIncomingMessage = {
		statusCode,
		on: vi.fn((event: string, cb: (...args: Array<unknown>) => void) => {
			if (!listeners[event]) {
				listeners[event] = [];
			}
			listeners[event].push(cb);
			if (event === "end") {
				queueMicrotask(() => {
					if (body && listeners.data) {
						for (const dataCb of listeners.data) {
							dataCb(Buffer.from(body));
						}
					}
					for (const endCb of listeners.end ?? []) {
						endCb();
					}
				});
			}
			return res;
		}),
		resume: vi.fn(),
	};
	return res;
}

/** Creates a mock ClientRequest with on/write/end. */
function createMockRequest(): MockClientRequest {
	const listeners: Record<
		string,
		Array<(...args: Array<unknown>) => void>
	> = {};
	return {
		on: vi.fn((event: string, cb: (...args: Array<unknown>) => void) => {
			if (!listeners[event]) {
				listeners[event] = [];
			}
			listeners[event].push(cb);
		}),
		write: vi.fn(),
		end: vi.fn(),
		// Exposed for test to trigger errors
		_emit(event: string, ...args: Array<unknown>) {
			if (listeners[event]) {
				for (const cb of listeners[event]) {
					cb(...args);
				}
			}
		},
	} as MockClientRequest & {
		_emit: (event: string, ...args: Array<unknown>) => void;
	};
}

// ─── Mock node:http and node:https ──────────────────────────────────────────

const { mockHttpRequest, mockHttpsRequest } = vi.hoisted(() => ({
	mockHttpRequest: vi.fn(),
	mockHttpsRequest: vi.fn(),
}));

vi.mock("node:http", () => ({
	request: mockHttpRequest,
}));

vi.mock("node:https", () => ({
	request: mockHttpsRequest,
}));

// spec 306: the outbound-push gate. Default allowed; individual gate tests flip it.
const { mockIsOutboundPushAllowed } = vi.hoisted(() => ({
	mockIsOutboundPushAllowed: vi.fn(async () => true),
}));
vi.mock("../../../cli/src/core/PushControl.js", () => ({
	isOutboundPushAllowed: mockIsOutboundPushAllowed,
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { VSCODE_CLIENT_INFO } from "./ClientInfo.js";
import type { JolliPushPayload } from "./JolliPushService.js";
import {
	BindingAlreadyExistsError,
	BindingRequiredError,
	deleteFromJolli,
	PermissionDeniedError,
	PluginOutdatedError,
	parseJolliApiKey,
	pushToJolli,
	PushDisabledError,
} from "./JolliPushService.js";

// ─── Helpers for API keys ───────────────────────────────────────────────────

/** Encodes a JSON object as a base64url string. */
function encodeKeyMeta(meta: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(meta)).toString("base64url");
}

/** Creates a new-format API key with the given meta. */
function makeNewKey(meta: Record<string, unknown>): string {
	const randomPart = Buffer.from("a".repeat(32)).toString("base64url");
	return `sk-jol-${encodeKeyMeta(meta)}.${randomPart}`;
}

/** An old-format API key (no dot). */
const OLD_KEY = "sk-jol-aabbccdd11223344aabbccdd11223344";

/** A default payload for push tests. */
const DEFAULT_PAYLOAD: JolliPushPayload = {
	title: "Test Summary",
	content: "# Test\nSome content",
	commitHash: "abc123",
	docType: "summary",
	branch: "main",
};

/**
 * A sentinel workspace path for the now-required `cwd` gate argument. These
 * request/response-shape tests don't care about the opt-out, so the mocked
 * `isOutboundPushAllowed` (below) resolves true by default; the two dedicated
 * gate tests flip it to false.
 */
const WS = "/ws";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PluginOutdatedError", () => {
	it("extends Error and has correct name", () => {
		const err = new PluginOutdatedError("outdated");
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("PluginOutdatedError");
		expect(err.message).toBe("outdated");
	});
});

describe("parseJolliApiKey", () => {
	it("returns null for non-sk-jol prefix", () => {
		expect(parseJolliApiKey("Bearer abc123")).toBeNull();
	});

	it("returns null for old format (no dot)", () => {
		expect(parseJolliApiKey(OLD_KEY)).toBeNull();
	});

	it("returns parsed meta for new format with valid JSON", () => {
		const key = makeNewKey({ t: "acme", u: "https://acme.jolli.ai" });
		const result = parseJolliApiKey(key);
		expect(result).toEqual({ t: "acme", u: "https://acme.jolli.ai" });
	});

	it("returns meta with o field when present", () => {
		const key = makeNewKey({
			t: "acme",
			u: "https://acme.jolli.ai",
			o: "org1",
		});
		const result = parseJolliApiKey(key);
		expect(result).toEqual({
			t: "acme",
			u: "https://acme.jolli.ai",
			o: "org1",
		});
	});

	it("returns null for new format with invalid JSON", () => {
		const invalidBase64 = Buffer.from("not-json{{{").toString("base64url");
		const key = `sk-jol-${invalidBase64}.randompart`;
		expect(parseJolliApiKey(key)).toBeNull();
	});

	it("returns null when t field is missing", () => {
		const key = makeNewKey({ u: "https://acme.jolli.ai" });
		expect(parseJolliApiKey(key)).toBeNull();
	});

	it("returns null when u field is missing", () => {
		const key = makeNewKey({ t: "acme" });
		expect(parseJolliApiKey(key)).toBeNull();
	});

	it("returns null when t is not a string", () => {
		const key = makeNewKey({ t: 123, u: "https://acme.jolli.ai" });
		expect(parseJolliApiKey(key)).toBeNull();
	});

	it("returns null when o is not a string (ignores non-string o)", () => {
		const key = makeNewKey({ t: "acme", u: "https://acme.jolli.ai", o: 42 });
		const result = parseJolliApiKey(key);
		// o is not a string, so it should be omitted
		expect(result).toEqual({ t: "acme", u: "https://acme.jolli.ai" });
	});
});

// assertJolliOriginAllowed is owned by cli/src/core/JolliApiUtils.ts and
// covered by cli/src/core/JolliApiUtils.test.ts — no duplicate here.

describe("pushToJolli", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		// resetAllMocks clears the hoisted implementation, so restore the default
		// "push allowed" here; the gate tests override it per-case.
		mockIsOutboundPushAllowed.mockResolvedValue(true);
	});

	it("succeeds with HTTPS and 2xx response", async () => {
		const responseBody = JSON.stringify({
			url: "https://acme.jolli.ai/doc/1",
			docId: 1,
			jrn: "jrn:doc:1",
			created: true,
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(200, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		const result = await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			DEFAULT_PAYLOAD,
			WS,
		);
		expect(result).toEqual({
			url: "https://acme.jolli.ai/doc/1",
			docId: 1,
			jrn: "jrn:doc:1",
			created: true,
		});
		expect(mockHttpsRequest).toHaveBeenCalledOnce();
		expect(mockReq.write).toHaveBeenCalledWith(JSON.stringify(DEFAULT_PAYLOAD));
		expect(mockReq.end).toHaveBeenCalledOnce();
		const callArgs = mockHttpsRequest.mock.calls[0] as [
			unknown,
			{ headers: Record<string, string> },
		];
		expect(callArgs[1].headers["x-jolli-client"]).toBe(
			`${VSCODE_CLIENT_INFO.kind}/${VSCODE_CLIENT_INFO.version}`,
		);
		// Every Jolli API request carries a fresh x-jolli-trace value for backend correlation.
		expect(callArgs[1].headers["x-jolli-trace"]).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}$/);
	});

	it("round-trips docType into the JSON request body for each kind", async () => {
		const responseBody = JSON.stringify({
			url: "u",
			docId: 1,
			jrn: "j",
			created: true,
		});
		const writtenBodies: Array<string> = [];
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, responseBody));
				const req = createMockRequest();
				req.write.mockImplementation((body: string) => {
					writtenBodies.push(body);
					return true;
				});
				return req;
			},
		);

		for (const docType of ["summary", "plan", "note"] as const) {
			await pushToJolli(
				"https://acme.jolli.ai",
				OLD_KEY,
				{
					...DEFAULT_PAYLOAD,
					docType,
				},
				WS,
			);
		}

		expect(writtenBodies).toHaveLength(3);
		const parsedDocTypes = writtenBodies.map(
			(b) => (JSON.parse(b) as { docType: string }).docType,
		);
		expect(parsedDocTypes).toEqual(["summary", "plan", "note"]);
	});

	it("round-trips summaryJson into the request body when present, and omits the key when absent", async () => {
		const responseBody = JSON.stringify({
			url: "u",
			docId: 1,
			jrn: "j",
			created: true,
		});
		const writtenBodies: Array<string> = [];
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, responseBody));
				const req = createMockRequest();
				req.write.mockImplementation((body: string) => {
					writtenBodies.push(body);
					return true;
				});
				return req;
			},
		);

		const summaryJson = JSON.stringify({ version: 4, commitHash: "abc123" });
		await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			{
				...DEFAULT_PAYLOAD,
				docType: "summary",
				summaryJson,
			},
			WS,
		);
		await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			{
				...DEFAULT_PAYLOAD,
				docType: "summary",
			},
			WS,
		);

		expect(writtenBodies).toHaveLength(2);
		const withField = JSON.parse(writtenBodies[0]) as Record<string, unknown>;
		expect(withField.summaryJson).toBe(summaryJson);
		const withoutField = JSON.parse(writtenBodies[1]) as Record<string, unknown>;
		expect("summaryJson" in withoutField).toBe(false);
	});

	it("throws PluginOutdatedError on HTTP 426", async () => {
		const responseBody = JSON.stringify({
			message: "Please update your plugin.",
		});

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(426, responseBody));
				return createMockRequest();
			},
		);

		const err = await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			DEFAULT_PAYLOAD,
			WS,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PluginOutdatedError);
		expect((err as Error).message).toBe("Please update your plugin.");
	});

	it("throws PluginOutdatedError with default message when no message in response", async () => {
		const responseBody = JSON.stringify({ error: "upgrade" });
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(426, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await expect(
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS),
		).rejects.toThrow(
			"Plugin version is outdated. Please update to the latest version.",
		);
	});

	it("throws Error with status on non-2xx response", async () => {
		const responseBody = JSON.stringify({ error: "Forbidden" });
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(403, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await expect(
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS),
		).rejects.toThrow("Forbidden");
	});

	it("throws Error with HTTP status when error field is missing", async () => {
		const responseBody = JSON.stringify({ something: "else" });
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(500, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await expect(
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS),
		).rejects.toThrow("HTTP 500");
	});

	it("throws Error with raw body snippet on invalid JSON response", async () => {
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(200, "not json at all");

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await expect(
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS),
		).rejects.toThrow(/Invalid JSON response \(HTTP 200\): not json at all/);
	});

	it("throws Error on network error", async () => {
		const mockReq = createMockRequest() as MockClientRequest & {
			_emit: (event: string, ...args: Array<unknown>) => void;
		};

		mockHttpsRequest.mockImplementation(
			(_url: unknown, _opts: unknown, _cb: unknown) => {
				// Trigger network error after returning the request
				queueMicrotask(() => {
					mockReq._emit("error", new Error("ECONNREFUSED"));
				});
				return mockReq;
			},
		);

		await expect(
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS),
		).rejects.toThrow("Network error: ECONNREFUSED");
	});

	it("sends x-tenant-slug header for path-based URL", async () => {
		const responseBody = JSON.stringify({
			url: "u",
			docId: 1,
			jrn: "j",
			created: true,
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(200, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await pushToJolli("https://jolli.ai/test1/", OLD_KEY, DEFAULT_PAYLOAD, WS);

		const callArgs = mockHttpsRequest.mock.calls[0] as [
			unknown,
			{ headers: Record<string, string> },
		];
		expect(callArgs[1].headers["x-tenant-slug"]).toBe("test1");
	});

	it("does not send x-tenant-slug header for subdomain URL", async () => {
		const responseBody = JSON.stringify({
			url: "u",
			docId: 1,
			jrn: "j",
			created: true,
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(200, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS);

		const callArgs = mockHttpsRequest.mock.calls[0] as [
			unknown,
			{ headers: Record<string, string> },
		];
		expect(callArgs[1].headers["x-tenant-slug"]).toBeUndefined();
	});

	it("sends x-org-slug header when key has o field", async () => {
		const responseBody = JSON.stringify({
			url: "u",
			docId: 1,
			jrn: "j",
			created: true,
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(200, responseBody);
		const keyWithOrg = makeNewKey({
			t: "acme",
			u: "https://acme.jolli.ai",
			o: "org1",
		});

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await pushToJolli("https://acme.jolli.ai", keyWithOrg, DEFAULT_PAYLOAD, WS);

		const callArgs = mockHttpsRequest.mock.calls[0] as [
			unknown,
			{ headers: Record<string, string> },
		];
		expect(callArgs[1].headers["x-org-slug"]).toBe("org1");
	});

	it("does not send x-org-slug header when key has no o field", async () => {
		const responseBody = JSON.stringify({
			url: "u",
			docId: 1,
			jrn: "j",
			created: true,
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(200, responseBody);
		const keyNoOrg = makeNewKey({ t: "acme", u: "https://acme.jolli.ai" });

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await pushToJolli("https://acme.jolli.ai", keyNoOrg, DEFAULT_PAYLOAD, WS);

		const callArgs = mockHttpsRequest.mock.calls[0] as [
			unknown,
			{ headers: Record<string, string> },
		];
		expect(callArgs[1].headers["x-org-slug"]).toBeUndefined();
	});

	it("falls back to key URL when no baseUrl provided", async () => {
		const responseBody = JSON.stringify({
			url: "u",
			docId: 1,
			jrn: "j",
			created: true,
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(200, responseBody);
		const keyWithUrl = makeNewKey({ t: "acme", u: "https://acme.jolli.ai" });

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		const result = await pushToJolli(undefined, keyWithUrl, DEFAULT_PAYLOAD, WS);
		expect(result.docId).toBe(1);
		expect(mockHttpsRequest).toHaveBeenCalledOnce();
	});

	it("rejects with clear error when no baseUrl and old key", async () => {
		await expect(
			pushToJolli(undefined, OLD_KEY, DEFAULT_PAYLOAD, WS),
		).rejects.toThrow(/Jolli site URL could not be determined/);
	});

	it("uses http.request for HTTP URL", async () => {
		const responseBody = JSON.stringify({
			url: "u",
			docId: 1,
			jrn: "j",
			created: true,
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(200, responseBody);

		mockHttpRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await pushToJolli("http://localhost:7034", OLD_KEY, DEFAULT_PAYLOAD, WS);
		expect(mockHttpRequest).toHaveBeenCalledOnce();
		expect(mockHttpsRequest).not.toHaveBeenCalled();
	});

	it("throws BindingRequiredError on 412 with binding_required", async () => {
		const responseBody = JSON.stringify({
			error: "binding_required",
			repoUrl: "https://github.com/jolliai/jolli",
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(412, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		const err = await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			DEFAULT_PAYLOAD,
			WS,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BindingRequiredError);
		expect((err as BindingRequiredError).repoUrl).toBe(
			"https://github.com/jolliai/jolli",
		);
	});

	it("falls back to payload.repoUrl when 412 body omits repoUrl", async () => {
		const responseBody = JSON.stringify({ error: "binding_required" });
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(412, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		const payload: JolliPushPayload = {
			...DEFAULT_PAYLOAD,
			repoUrl: "https://github.com/jolliai/jolli",
		};
		const err = await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			payload,
			WS,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BindingRequiredError);
		expect((err as BindingRequiredError).repoUrl).toBe(
			"https://github.com/jolliai/jolli",
		);
	});

	it("falls back to an empty repoUrl when both the 412 body and the payload omit it", async () => {
		const responseBody = JSON.stringify({ error: "binding_required" });
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(412, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		// DEFAULT_PAYLOAD carries no repoUrl, so the error's repoUrl bottoms out at "".
		const err = await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			DEFAULT_PAYLOAD,
			WS,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BindingRequiredError);
		expect((err as BindingRequiredError).repoUrl).toBe("");
	});

	it("does not treat unrelated 412 errors as BindingRequiredError", async () => {
		const responseBody = JSON.stringify({ error: "precondition_failed" });
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(412, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		const err = await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			DEFAULT_PAYLOAD,
			WS,
		).catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(BindingRequiredError);
		expect((err as Error).message).toBe("precondition_failed (HTTP 412)");
	});

	it("throws BindingAlreadyExistsError on 409 with binding_already_exists", async () => {
		const responseBody = JSON.stringify({
			error: "binding_already_exists",
			id: 7,
			jmSpaceId: 42,
			jmSpaceName: "backend-team",
			repoName: "jolli",
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(409, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		const err = await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			DEFAULT_PAYLOAD,
			WS,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BindingAlreadyExistsError);
		expect((err as BindingAlreadyExistsError).winner.jmSpaceId).toBe(42);
		expect((err as BindingAlreadyExistsError).winner.jmSpaceName).toBe(
			"backend-team",
		);
	});

	it("does not treat unrelated 409 errors as BindingAlreadyExistsError", async () => {
		const responseBody = JSON.stringify({ error: "conflict" });
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(409, responseBody);

		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(mockRes);
				return mockReq;
			},
		);

		const err = await pushToJolli(
			"https://acme.jolli.ai",
			OLD_KEY,
			DEFAULT_PAYLOAD,
			WS,
		).catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(BindingAlreadyExistsError);
		expect((err as Error).message).toBe("conflict (HTTP 409)");
	});

	it("throws PermissionDeniedError on 412 repo_not_allowlisted with the server's message (cross-client parity)", async () => {
		// The allowlist refusal is a 412 (NOT 403 — that status is the bind path's
		// space_restricted). It must map to PermissionDeniedError, not the generic
		// "(HTTP 412)" branch, so callers stop retrying.
		const responseBody = JSON.stringify({
			error: "repo_not_allowlisted",
			message: "Ask an administrator to add this repo to the Space.",
		});
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(412, responseBody);
		mockHttpsRequest.mockImplementation((_u: unknown, _o: unknown, cb: (r: MockIncomingMessage) => void) => {
			cb(mockRes);
			return mockReq;
		});

		const err = await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PermissionDeniedError);
		// The full sentence, not the bare slug.
		expect((err as Error).message).toBe("Ask an administrator to add this repo to the Space.");
	});

	it("falls back to the error slug on 412 repo_not_allowlisted when no message is present", async () => {
		const responseBody = JSON.stringify({ error: "repo_not_allowlisted" });
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(412, responseBody);
		mockHttpsRequest.mockImplementation((_u: unknown, _o: unknown, cb: (r: MockIncomingMessage) => void) => {
			cb(mockRes);
			return mockReq;
		});

		const err = await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PermissionDeniedError);
		expect((err as Error).message).toBe("repo_not_allowlisted");
	});

	it("throws PermissionDeniedError on a push-path 403 (ownership mismatch), cross-client parity", async () => {
		// On the push path a 403 is an ownership mismatch (doc belongs to another
		// user). The server's sentence is surfaced; a proxy/gateway 403 with a
		// non-JSON body still maps to PermissionDeniedError with the default
		// sentence, not a generic "Invalid JSON response" — the branch decides on
		// status alone (matching the CLI).
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(403, "Forbidden");
		mockHttpsRequest.mockImplementation((_u: unknown, _o: unknown, cb: (r: MockIncomingMessage) => void) => {
			cb(mockRes);
			return mockReq;
		});

		const err = await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PermissionDeniedError);
		expect((err as Error).message).toBe("You don't have permission to push to this Space.");
	});

	it("prefers message over the error slug in the generic branch (cross-client parity)", async () => {
		const responseBody = JSON.stringify({ error: "some_slug", message: "A human sentence." });
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(400, responseBody);
		mockHttpsRequest.mockImplementation((_u: unknown, _o: unknown, cb: (r: MockIncomingMessage) => void) => {
			cb(mockRes);
			return mockReq;
		});

		const err = await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS).catch((e: unknown) => e);
		expect((err as Error).message).toBe("A human sentence. (HTTP 400)");
	});

	it("keeps a snippet of an UNPARSEABLE non-2xx body, collapsed to one line", async () => {
		// Branching on status before parsing (so a proxy 403 maps correctly) makes
		// non-JSON bodies reachable in the generic branch too. Those bodies are the
		// CDN / WAF / gateway case, and the HTML is the only thing naming which
		// intermediary refused — a bare "request failed (HTTP 502)" is undebuggable.
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(502, "<html>\n  <title>502 Bad Gateway</title>\n</html>");
		mockHttpsRequest.mockImplementation((_u: unknown, _o: unknown, cb: (r: MockIncomingMessage) => void) => {
			cb(mockRes);
			return mockReq;
		});

		const err = await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS).catch((e: unknown) => e);
		expect((err as Error).message).toBe("<html> <title>502 Bad Gateway</title> </html> (HTTP 502)");
	});

	it("truncates a very long unparseable body instead of dumping the page", async () => {
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(500, "x".repeat(5000));
		mockHttpsRequest.mockImplementation((_u: unknown, _o: unknown, cb: (r: MockIncomingMessage) => void) => {
			cb(mockRes);
			return mockReq;
		});

		const err = await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS).catch((e: unknown) => e);
		expect((err as Error).message).toBe(`${"x".repeat(200)}… (HTTP 500)`);
	});

	it("falls back to 'request failed' when a non-2xx body is empty", async () => {
		// Nothing to quote — the static fallback is correct here, and this is the
		// case the snippet fallback must NOT turn into an empty-string message.
		const mockReq = createMockRequest();
		const mockRes = createMockResponse(503, "");
		mockHttpsRequest.mockImplementation((_u: unknown, _o: unknown, cb: (r: MockIncomingMessage) => void) => {
			cb(mockRes);
			return mockReq;
		});

		const err = await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS).catch((e: unknown) => e);
		expect((err as Error).message).toBe("request failed (HTTP 503)");
	});

	it("throws PushDisabledError before any request when the repo opted out (spec 306)", async () => {
		mockIsOutboundPushAllowed.mockResolvedValue(false);
		const err = await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, "/ws").catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PushDisabledError);
		expect(mockHttpsRequest).not.toHaveBeenCalled();
	});

	it("still pushes when the repo is push-allowed and a cwd is given", async () => {
		mockIsOutboundPushAllowed.mockResolvedValue(true);
		const mockReq = createMockRequest();
		// Emit synchronously AFTER pushToJolli registers its listeners. The gate's
		// extra `await` reorders microtasks, so a pre-scheduled emit (the shared
		// createMockResponse helper) would fire before listeners attach and hang.
		mockHttpsRequest.mockImplementation((_u: unknown, _o: unknown, cb: (r: unknown) => void) => {
			const listeners: Record<string, Array<(...a: Array<unknown>) => void>> = {};
			const res = {
				statusCode: 200,
				on: (event: string, fn: (...a: Array<unknown>) => void) => {
					if (!listeners[event]) listeners[event] = [];
					listeners[event].push(fn);
					return res;
				},
				resume: vi.fn(),
			};
			cb(res);
			for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify({ url: "u", docId: 1, jrn: "j", created: true })));
			for (const fn of listeners.end ?? []) fn();
			return mockReq;
		});
		const result = await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, "/ws");
		expect(result.docId).toBe(1);
		expect(mockHttpsRequest).toHaveBeenCalledOnce();
	});

	it("handles statusCode being undefined (defaults to 0)", async () => {
		const responseBody = JSON.stringify({ something: "else" });
		const mockReq = createMockRequest();
		// Create a response where statusCode is undefined
		const listeners: Record<
			string,
			Array<(...args: Array<unknown>) => void>
		> = {};
		const mockRes = {
			statusCode: undefined as number | undefined,
			on: vi.fn((event: string, cb: (...args: Array<unknown>) => void) => {
				if (!listeners[event]) {
					listeners[event] = [];
				}
				listeners[event].push(cb);
				return mockRes;
			}),
			resume: vi.fn(),
		};

		mockHttpsRequest.mockImplementation(
			(_url: unknown, _opts: unknown, cb: (res: typeof mockRes) => void) => {
				cb(mockRes);
				queueMicrotask(() => {
					for (const dataCb of listeners.data ?? []) {
						dataCb(Buffer.from(responseBody));
					}
					for (const endCb of listeners.end ?? []) {
						endCb();
					}
				});
				return mockReq;
			},
		);

		await expect(
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD, WS),
		).rejects.toThrow("HTTP 0");
	});
});

describe("deleteFromJolli", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mockIsOutboundPushAllowed.mockResolvedValue(true);
	});

	it("throws PushDisabledError before any request when the repo opted out (spec 306)", async () => {
		mockIsOutboundPushAllowed.mockResolvedValue(false);
		const err = await deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 42, "/ws").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PushDisabledError);
		expect(mockHttpsRequest).not.toHaveBeenCalled();
	});

	it("resolves on 204 status", async () => {
		const mockReq = createMockRequest();
		const mockRes: MockIncomingMessage = {
			statusCode: 204,
			on: vi.fn(),
			resume: vi.fn(),
		};

		mockHttpsRequest.mockImplementation(
			(_opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await expect(
			deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 42, WS),
		).resolves.toBeUndefined();
	});

	it("resolves on 200 status", async () => {
		const mockReq = createMockRequest();
		const mockRes: MockIncomingMessage = {
			statusCode: 200,
			on: vi.fn(),
			resume: vi.fn(),
		};

		mockHttpsRequest.mockImplementation(
			(_opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await expect(
			deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 42, WS),
		).resolves.toBeUndefined();
	});

	it("rejects on non-200/204 status", async () => {
		const mockReq = createMockRequest();
		const mockRes: MockIncomingMessage = {
			statusCode: 500,
			on: vi.fn(),
			resume: vi.fn(),
		};

		mockHttpsRequest.mockImplementation(
			(_opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await expect(
			deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 42, WS),
		).rejects.toThrow("Delete failed with status 500");
	});

	it("rejects on network error", async () => {
		const mockReq = createMockRequest() as MockClientRequest & {
			_emit: (event: string, ...args: Array<unknown>) => void;
		};

		mockHttpsRequest.mockImplementation((_opts: unknown, _cb: unknown) => {
			queueMicrotask(() => {
				mockReq._emit("error", new Error("ECONNRESET"));
			});
			return mockReq;
		});

		await expect(
			deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 42, WS),
		).rejects.toThrow("Network error: ECONNRESET");
	});

	it("falls back to key URL when no baseUrl provided", async () => {
		const mockReq = createMockRequest();
		const mockRes: MockIncomingMessage = {
			statusCode: 204,
			on: vi.fn(),
			resume: vi.fn(),
		};
		const keyWithUrl = makeNewKey({ t: "acme", u: "https://acme.jolli.ai" });

		mockHttpsRequest.mockImplementation(
			(_opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await expect(
			deleteFromJolli(undefined, keyWithUrl, 42, WS),
		).resolves.toBeUndefined();
		expect(mockHttpsRequest).toHaveBeenCalledOnce();
	});

	it("rejects when no baseUrl and old key", async () => {
		await expect(deleteFromJolli(undefined, OLD_KEY, 42, WS)).rejects.toThrow(
			"Jolli site URL could not be determined.",
		);
	});

	it("sends x-tenant-slug header for path-based URL", async () => {
		const mockReq = createMockRequest();
		const mockRes: MockIncomingMessage = {
			statusCode: 204,
			on: vi.fn(),
			resume: vi.fn(),
		};

		mockHttpsRequest.mockImplementation(
			(_opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await deleteFromJolli("https://jolli.ai/test1/", OLD_KEY, 42, WS);

		const callArgs = mockHttpsRequest.mock.calls[0] as [
			{ headers: Record<string, string> },
		];
		expect(callArgs[0].headers["x-tenant-slug"]).toBe("test1");
	});

	it("sends x-org-slug header when key has o field", async () => {
		const mockReq = createMockRequest();
		const mockRes: MockIncomingMessage = {
			statusCode: 204,
			on: vi.fn(),
			resume: vi.fn(),
		};
		const keyWithOrg = makeNewKey({
			t: "acme",
			u: "https://acme.jolli.ai",
			o: "org1",
		});

		mockHttpsRequest.mockImplementation(
			(_opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await deleteFromJolli("https://acme.jolli.ai", keyWithOrg, 42, WS);

		const callArgs = mockHttpsRequest.mock.calls[0] as [
			{ headers: Record<string, string> },
		];
		expect(callArgs[0].headers["x-org-slug"]).toBe("org1");
	});

	it("constructs the correct delete path with docId", async () => {
		const mockReq = createMockRequest();
		const mockRes: MockIncomingMessage = {
			statusCode: 204,
			on: vi.fn(),
			resume: vi.fn(),
		};

		mockHttpsRequest.mockImplementation(
			(_opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 99, WS);

		const callArgs = mockHttpsRequest.mock.calls[0] as [
			{ path: string; method: string },
		];
		expect(callArgs[0].path).toBe("/api/push/jollimemory/99");
		expect(callArgs[0].method).toBe("DELETE");
	});

	it("uses http.request for HTTP URL (mirrors pushToJolli http branch)", async () => {
		// The DELETE path also has to support the http://localhost dev
		// scenario — `pushToJolli` does this above, but `deleteFromJolli`
		// constructs its own request options and was tested only against
		// https. Without this case the `isHttps ? httpsRequest : httpRequest`
		// tail (and the `port || 80` fallback) would silently regress to
		// always-https on a future refactor.
		const mockReq = createMockRequest();
		const mockRes: MockIncomingMessage = {
			statusCode: 204,
			on: vi.fn(),
			resume: vi.fn(),
		};

		mockHttpRequest.mockImplementation(
			(_opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await deleteFromJolli("http://localhost:7034", OLD_KEY, 42, WS);

		expect(mockHttpRequest).toHaveBeenCalledOnce();
		expect(mockHttpsRequest).not.toHaveBeenCalled();
	});

	it("defaults the port to 80 for an http URL without an explicit port", async () => {
		const mockReq = createMockRequest();
		const mockRes: MockIncomingMessage = {
			statusCode: 204,
			on: vi.fn(),
			resume: vi.fn(),
		};

		mockHttpRequest.mockImplementation(
			(_opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(mockRes);
				return mockReq;
			},
		);

		await deleteFromJolli("http://localhost", OLD_KEY, 42, WS);

		expect(mockHttpRequest).toHaveBeenCalledOnce();
		const callArgs = mockHttpRequest.mock.calls[0] as [
			{ port: number | string },
		];
		expect(callArgs[0].port).toBe(80);
	});
});
