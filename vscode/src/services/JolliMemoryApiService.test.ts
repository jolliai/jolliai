import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { VSCODE_CLIENT_INFO } from "./ClientInfo.js";
import {
	createJolliMemoryBinding,
	listJolliMemorySpaces,
} from "./JolliMemoryApiService.js";
import {
	BindingAlreadyExistsError,
	PluginOutdatedError,
} from "./JolliPushService.js";

const OLD_KEY = "sk-jol-aabbccdd11223344aabbccdd11223344";

function encodeKeyMeta(meta: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(meta)).toString("base64url");
}
function makeNewKey(meta: Record<string, unknown>): string {
	const randomPart = Buffer.from("a".repeat(32)).toString("base64url");
	return `sk-jol-${encodeKeyMeta(meta)}.${randomPart}`;
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("listJolliMemorySpaces", () => {
	it("returns spaces from a flat array body with defaultSpaceId=null", async () => {
		const body = JSON.stringify([
			{ id: 1, name: "backend-team", slug: "backend-team" },
			{ id: 2, name: "infra-ops", slug: "infra-ops" },
		]);
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, body));
				return createMockRequest();
			},
		);

		const result = await listJolliMemorySpaces(
			"https://acme.jolli.ai",
			OLD_KEY,
		);
		expect(result).toEqual({
			spaces: [
				{ id: 1, name: "backend-team", slug: "backend-team" },
				{ id: 2, name: "infra-ops", slug: "infra-ops" },
			],
			defaultSpaceId: null,
		});
	});

	it("unwraps a `{ spaces, defaultSpaceId }` envelope", async () => {
		const body = JSON.stringify({
			spaces: [
				{ id: 1, name: "team", slug: "team" },
				{ id: 7, name: "default", slug: "default" },
			],
			defaultSpaceId: 7,
		});
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, body));
				return createMockRequest();
			},
		);

		const result = await listJolliMemorySpaces(
			"https://acme.jolli.ai",
			OLD_KEY,
		);
		expect(result).toEqual({
			spaces: [
				{ id: 1, name: "team", slug: "team" },
				{ id: 7, name: "default", slug: "default" },
			],
			defaultSpaceId: 7,
		});
	});

	it("envelope without defaultSpaceId reports defaultSpaceId=null", async () => {
		const body = JSON.stringify({
			spaces: [{ id: 1, name: "team", slug: "team" }],
		});
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, body));
				return createMockRequest();
			},
		);

		const result = await listJolliMemorySpaces(
			"https://acme.jolli.ai",
			OLD_KEY,
		);
		expect(result).toEqual({
			spaces: [{ id: 1, name: "team", slug: "team" }],
			defaultSpaceId: null,
		});
	});

	it("coerces non-numeric defaultSpaceId to null", async () => {
		const body = JSON.stringify({
			spaces: [{ id: 1, name: "team", slug: "team" }],
			defaultSpaceId: "1",
		});
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, body));
				return createMockRequest();
			},
		);

		const result = await listJolliMemorySpaces(
			"https://acme.jolli.ai",
			OLD_KEY,
		);
		expect(result.defaultSpaceId).toBeNull();
	});

	it("hits GET /api/jolli-memory/spaces with bearer auth and x-jolli-client", async () => {
		const body = JSON.stringify([]);
		const mockReq = createMockRequest();
		mockHttpsRequest.mockImplementation(
			(
				url: URL,
				opts: { method: string; headers: Record<string, string> },
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, body));
				expect(url.pathname).toBe("/api/jolli-memory/spaces");
				expect(opts.method).toBe("GET");
				expect(opts.headers.Authorization).toBe(`Bearer ${OLD_KEY}`);
				expect(opts.headers["x-jolli-client"]).toBe(
					`${VSCODE_CLIENT_INFO.kind}/${VSCODE_CLIENT_INFO.version}`,
				);
				return mockReq;
			},
		);
		await listJolliMemorySpaces("https://acme.jolli.ai", OLD_KEY);
		expect(mockHttpsRequest).toHaveBeenCalledOnce();
	});

	it("includes x-tenant-slug for path-based base URL", async () => {
		const body = JSON.stringify([]);
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				opts: { headers: Record<string, string> },
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, body));
				expect(opts.headers["x-tenant-slug"]).toBe("test1");
				return createMockRequest();
			},
		);
		await listJolliMemorySpaces("https://jolli.ai/test1/", OLD_KEY);
	});

	it("includes x-org-slug when key has org", async () => {
		const body = JSON.stringify([]);
		const key = makeNewKey({
			t: "acme",
			u: "https://acme.jolli.ai",
			o: "org1",
		});
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				opts: { headers: Record<string, string> },
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, body));
				expect(opts.headers["x-org-slug"]).toBe("org1");
				return createMockRequest();
			},
		);
		await listJolliMemorySpaces("https://acme.jolli.ai", key);
	});

	it("throws PluginOutdatedError on 426", async () => {
		const body = JSON.stringify({ message: "upgrade!" });
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(426, body));
				return createMockRequest();
			},
		);
		await expect(
			listJolliMemorySpaces("https://acme.jolli.ai", OLD_KEY),
		).rejects.toBeInstanceOf(PluginOutdatedError);
	});

	it("uses a default message on 426 when the body omits one", async () => {
		const body = JSON.stringify({});
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(426, body));
				return createMockRequest();
			},
		);
		await expect(
			listJolliMemorySpaces("https://acme.jolli.ai", OLD_KEY),
		).rejects.toThrow(/Plugin version is outdated/);
	});

	it("rejects with `HTTP <status>` when an error body has no `error` field", async () => {
		// Exercises the `json.error ?? \`HTTP ${status}\`` fallback branch.
		const body = JSON.stringify({});
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(500, body));
				return createMockRequest();
			},
		);
		await expect(
			listJolliMemorySpaces("https://acme.jolli.ai", OLD_KEY),
		).rejects.toThrow("HTTP 500");
	});

	it("returns empty spaces with defaultSpaceId=null when the envelope is missing the `spaces` key", async () => {
		// Exercises the `body.spaces ?? []` fallback branch.
		const body = JSON.stringify({});
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, body));
				return createMockRequest();
			},
		);
		await expect(
			listJolliMemorySpaces("https://acme.jolli.ai", OLD_KEY),
		).resolves.toEqual({ spaces: [], defaultSpaceId: null });
	});

	it("uses http.request for http URL", async () => {
		const body = JSON.stringify([]);
		mockHttpRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, body));
				return createMockRequest();
			},
		);
		await listJolliMemorySpaces("http://localhost:7034", OLD_KEY);
		expect(mockHttpRequest).toHaveBeenCalledOnce();
		expect(mockHttpsRequest).not.toHaveBeenCalled();
	});

	it("rejects on network error", async () => {
		const mockReq = createMockRequest() as MockClientRequest & {
			_emit: (event: string, ...args: Array<unknown>) => void;
		};
		mockHttpsRequest.mockImplementation(
			(_url: unknown, _opts: unknown, _cb: unknown) => {
				queueMicrotask(() => mockReq._emit("error", new Error("ECONNREFUSED")));
				return mockReq;
			},
		);
		await expect(
			listJolliMemorySpaces("https://acme.jolli.ai", OLD_KEY),
		).rejects.toThrow("Network error: ECONNREFUSED");
	});

	it("rejects with HTTP status on unrecognized error", async () => {
		const body = JSON.stringify({ error: "forbidden" });
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(403, body));
				return createMockRequest();
			},
		);
		await expect(
			listJolliMemorySpaces("https://acme.jolli.ai", OLD_KEY),
		).rejects.toThrow("forbidden");
	});

	it("rejects with raw snippet on invalid JSON", async () => {
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(200, "not json"));
				return createMockRequest();
			},
		);
		await expect(
			listJolliMemorySpaces("https://acme.jolli.ai", OLD_KEY),
		).rejects.toThrow(/Invalid JSON response/);
	});
});

describe("createJolliMemoryBinding", () => {
	const PAYLOAD = {
		repoUrl: "https://github.com/jolliai/jolli",
		repoName: "jolli",
		jmSpaceId: 42,
	};

	it("POSTs the binding payload and resolves with the binding info", async () => {
		const body = JSON.stringify({
			id: 5,
			jmSpaceId: 42,
			jmSpaceName: "backend-team",
			repoName: "jolli",
		});
		const mockReq = createMockRequest();
		mockHttpsRequest.mockImplementation(
			(url: URL, _opts: unknown, cb: (res: MockIncomingMessage) => void) => {
				cb(createMockResponse(201, body));
				expect(url.pathname).toBe("/api/jolli-memory/bindings");
				return mockReq;
			},
		);
		const result = await createJolliMemoryBinding(
			"https://acme.jolli.ai",
			OLD_KEY,
			PAYLOAD,
		);
		expect(result).toEqual({
			id: 5,
			jmSpaceId: 42,
			jmSpaceName: "backend-team",
			repoName: "jolli",
		});
		expect(mockReq.write).toHaveBeenCalledWith(JSON.stringify(PAYLOAD));
	});

	it("throws BindingAlreadyExistsError on 409 with the winner body", async () => {
		const body = JSON.stringify({
			error: "binding_already_exists",
			id: 11,
			jmSpaceId: 42,
			jmSpaceName: "backend-team",
			repoName: "jolli",
		});
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(409, body));
				return createMockRequest();
			},
		);
		const err = await createJolliMemoryBinding(
			"https://acme.jolli.ai",
			OLD_KEY,
			PAYLOAD,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BindingAlreadyExistsError);
		expect((err as BindingAlreadyExistsError).winner.jmSpaceId).toBe(42);
		expect((err as BindingAlreadyExistsError).winner.jmSpaceName).toBe(
			"backend-team",
		);
	});

	it("propagates a server-supplied message in BindingAlreadyExistsError", async () => {
		// Exercises the truthy branch of `typeof json.message === "string"`.
		const body = JSON.stringify({
			error: "binding_already_exists",
			message: "repo already bound to backend-team",
			id: 11,
			jmSpaceId: 42,
			jmSpaceName: "backend-team",
			repoName: "jolli",
		});
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(409, body));
				return createMockRequest();
			},
		);
		const err = await createJolliMemoryBinding(
			"https://acme.jolli.ai",
			OLD_KEY,
			PAYLOAD,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BindingAlreadyExistsError);
		expect((err as Error).message).toBe("repo already bound to backend-team");
	});

	it("does not treat unrelated 409 errors as BindingAlreadyExistsError", async () => {
		const body = JSON.stringify({ error: "conflict" });
		mockHttpsRequest.mockImplementation(
			(
				_url: unknown,
				_opts: unknown,
				cb: (res: MockIncomingMessage) => void,
			) => {
				cb(createMockResponse(409, body));
				return createMockRequest();
			},
		);
		const err = await createJolliMemoryBinding(
			"https://acme.jolli.ai",
			OLD_KEY,
			PAYLOAD,
		).catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(BindingAlreadyExistsError);
		expect((err as Error).message).toBe("conflict");
	});
});
