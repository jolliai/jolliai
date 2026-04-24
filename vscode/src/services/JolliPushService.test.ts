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

/** Creates a mock IncomingMessage that emits data chunks then 'end'. */
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
			return res;
		}),
		resume: vi.fn(),
	};
	// Schedule data + end emission after the callback registers listeners
	queueMicrotask(() => {
		if (body && listeners.data) {
			for (const cb of listeners.data) {
				cb(Buffer.from(body));
			}
		}
		if (listeners.end) {
			for (const cb of listeners.end) {
				cb();
			}
		}
	});
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

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import type { JolliPushPayload } from "./JolliPushService.js";
import {
	deleteFromJolli,
	PluginOutdatedError,
	parseJolliApiKey,
	pushToJolli,
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
	branch: "main",
};

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
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD),
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
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD),
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
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD),
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
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD),
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
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD),
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

		await pushToJolli("https://jolli.ai/test1/", OLD_KEY, DEFAULT_PAYLOAD);

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

		await pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD);

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

		await pushToJolli("https://acme.jolli.ai", keyWithOrg, DEFAULT_PAYLOAD);

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

		await pushToJolli("https://acme.jolli.ai", keyNoOrg, DEFAULT_PAYLOAD);

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

		const result = await pushToJolli(undefined, keyWithUrl, DEFAULT_PAYLOAD);
		expect(result.docId).toBe(1);
		expect(mockHttpsRequest).toHaveBeenCalledOnce();
	});

	it("rejects with clear error when no baseUrl and old key", async () => {
		await expect(
			pushToJolli(undefined, OLD_KEY, DEFAULT_PAYLOAD),
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

		await pushToJolli("http://localhost:7034", OLD_KEY, DEFAULT_PAYLOAD);
		expect(mockHttpRequest).toHaveBeenCalledOnce();
		expect(mockHttpsRequest).not.toHaveBeenCalled();
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
			pushToJolli("https://acme.jolli.ai", OLD_KEY, DEFAULT_PAYLOAD),
		).rejects.toThrow("HTTP 0");
	});
});

describe("deleteFromJolli", () => {
	beforeEach(() => {
		vi.resetAllMocks();
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
			deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 42),
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
			deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 42),
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
			deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 42),
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
			deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 42),
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
			deleteFromJolli(undefined, keyWithUrl, 42),
		).resolves.toBeUndefined();
		expect(mockHttpsRequest).toHaveBeenCalledOnce();
	});

	it("rejects when no baseUrl and old key", async () => {
		await expect(deleteFromJolli(undefined, OLD_KEY, 42)).rejects.toThrow(
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

		await deleteFromJolli("https://jolli.ai/test1/", OLD_KEY, 42);

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

		await deleteFromJolli("https://acme.jolli.ai", keyWithOrg, 42);

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

		await deleteFromJolli("https://acme.jolli.ai", OLD_KEY, 99);

		const callArgs = mockHttpsRequest.mock.calls[0] as [
			{ path: string; method: string },
		];
		expect(callArgs[0].path).toBe("/api/push/jollimemory/99");
		expect(callArgs[0].method).toBe("DELETE");
	});
});
