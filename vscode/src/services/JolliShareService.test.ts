import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock node:http / node:https ────────────────────────────────────────────

const { mockHttpRequest, mockHttpsRequest } = vi.hoisted(() => ({
	mockHttpRequest: vi.fn(),
	mockHttpsRequest: vi.fn(),
}));

vi.mock("node:http", () => ({ request: mockHttpRequest }));
vi.mock("node:https", () => ({ request: mockHttpsRequest }));

import {
	type BranchSharePayload,
	createBranchShare,
	createLiveShare,
	fetchSharedSnapshot,
	type LiveSharePayload,
	listOrgMembers,
	PluginOutdatedError,
	revokeBranchShare,
	ShareRevokedError,
	updateBranchShareExpiry,
	updateLiveShare,
} from "./JolliShareService.js";

// ─── Mock request/response plumbing ─────────────────────────────────────────

interface Listeners {
	[event: string]: Array<(...args: Array<unknown>) => void>;
}

function mockResponse(statusCode: number | undefined, body: string) {
	const listeners: Listeners = {};
	const res = {
		statusCode,
		on: vi.fn((event: string, cb: (...args: Array<unknown>) => void) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(cb);
			return res;
		}),
		resume: vi.fn(),
	};
	queueMicrotask(() => {
		if (body) for (const cb of listeners.data ?? []) cb(Buffer.from(body));
		for (const cb of listeners.end ?? []) cb();
	});
	return res;
}

function mockRequest() {
	const listeners: Listeners = {};
	return {
		on: vi.fn((event: string, cb: (...args: Array<unknown>) => void) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(cb);
		}),
		write: vi.fn(),
		end: vi.fn(),
		_emit(event: string, ...args: Array<unknown>) {
			for (const cb of listeners[event] ?? []) cb(...args);
		},
	};
}

/** Wires the https mock to reply with the given status + body (`undefined` = response with no status code). */
function replyHttps(statusCode: number | undefined, body: string): void {
	mockHttpsRequest.mockImplementation((_url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
		cb(mockResponse(statusCode, body));
		return mockRequest();
	});
}

/** Wires the http (non-TLS) mock to reply — used for http base URLs in local dev. */
function replyHttp(statusCode: number, body: string): void {
	mockHttpRequest.mockImplementation((_url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
		cb(mockResponse(statusCode, body));
		return mockRequest();
	});
}

function encodeKeyMeta(meta: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(meta)).toString("base64url");
}
function makeKey(meta: Record<string, unknown>): string {
	return `sk-jol-${encodeKeyMeta(meta)}.${Buffer.from("a".repeat(32)).toString("base64url")}`;
}

const KEY = makeKey({ t: "acme", u: "https://acme.jolli.ai" });
const BASE = "https://acme.jolli.ai";

const PAYLOAD: BranchSharePayload = {
	repoUrl: "https://github.com/acme/repo",
	repoName: "repo",
	branch: "feature/x",
	branchSlug: "feature-x",
	headCommitHash: "a".repeat(40),
	commitHashes: ["a".repeat(40)],
	decisionCount: 3,
	scope: { summary: true, plans: true, notes: true, transcripts: false },
	content: "# memory",
};

const OK_RESULT = JSON.stringify({
	shareId: "sh_1",
	token: "tok_abc",
	shareUrl: "https://acme.jolli.ai/b/feature-x-tok_abc",
	expiresAt: "2026-09-01T00:00:00.000Z",
	visibility: "public",
});

beforeEach(() => {
	mockHttpRequest.mockReset();
	mockHttpsRequest.mockReset();
});

describe("createBranchShare", () => {
	it("resolves the share result on 2xx", async () => {
		replyHttps(200, OK_RESULT);
		const res = await createBranchShare(BASE, KEY, PAYLOAD);
		expect(res.shareUrl).toBe("https://acme.jolli.ai/b/feature-x-tok_abc");
		expect(res.token).toBe("tok_abc");
	});

	it("rejects when no base URL can be determined", async () => {
		await expect(createBranchShare(undefined, "sk-jol-plainnowurl", PAYLOAD)).rejects.toThrow(
			/site URL could not be determined/,
		);
	});

	it("derives the base URL from the API key when none is passed", async () => {
		replyHttps(200, OK_RESULT);
		const res = await createBranchShare(undefined, KEY, PAYLOAD);
		expect(res.shareId).toBe("sh_1");
	});

	it("maps 426 to PluginOutdatedError", async () => {
		replyHttps(426, JSON.stringify({ message: "too old" }));
		await expect(createBranchShare(BASE, KEY, PAYLOAD)).rejects.toBeInstanceOf(PluginOutdatedError);
	});

	it("surfaces a detailed error on other non-2xx", async () => {
		replyHttps(400, JSON.stringify({ error: "bad_request", message: "nope" }));
		await expect(createBranchShare(BASE, KEY, PAYLOAD)).rejects.toThrow(/bad_request — nope \(HTTP 400\)/);
	});

	it("rejects on invalid JSON", async () => {
		replyHttps(200, "not json");
		await expect(createBranchShare(BASE, KEY, PAYLOAD)).rejects.toThrow(/Invalid JSON/);
	});

	it("accepts a numeric shareId (server auto-increment id)", async () => {
		replyHttps(200, JSON.stringify({ ...JSON.parse(OK_RESULT), shareId: 1 }));
		const res = await createBranchShare(BASE, KEY, PAYLOAD);
		expect(res.shareId).toBe(1);
	});

	it("rejects a 2xx whose body is missing required fields, surfacing the raw body", async () => {
		replyHttps(200, JSON.stringify({ token: null, url: "https://acme.jolli.ai/x" }));
		await expect(createBranchShare(BASE, KEY, PAYLOAD)).rejects.toThrow(
			/unexpected response \(missing shareId\/token\/shareUrl\).*acme\.jolli\.ai/s,
		);
	});

	it("rejects on a network error", async () => {
		mockHttpsRequest.mockImplementation((_url: unknown, _opts: unknown, _cb: unknown) => {
			const req = mockRequest();
			queueMicrotask(() => req._emit("error", new Error("boom")));
			return req;
		});
		await expect(createBranchShare(BASE, KEY, PAYLOAD)).rejects.toThrow(/Network error: boom/);
	});

	it("uses plain http for an http base URL", async () => {
		replyHttp(200, OK_RESULT);
		const res = await createBranchShare("http://jolli-local.me/test1", KEY, PAYLOAD);
		expect(res.shareId).toBe("sh_1");
		expect(mockHttpRequest).toHaveBeenCalled();
		expect(mockHttpsRequest).not.toHaveBeenCalled();
	});

	it("falls back to a generic message on 426 with no body message", async () => {
		replyHttps(426, JSON.stringify({}));
		await expect(createBranchShare(BASE, KEY, PAYLOAD)).rejects.toThrow(/Plugin version is outdated/);
	});

	it("falls back to 'request failed' when the error body is empty", async () => {
		replyHttps(500, JSON.stringify({}));
		await expect(createBranchShare(BASE, KEY, PAYLOAD)).rejects.toThrow(/request failed \(HTTP 500\)/);
	});

	it("treats a response with no status code as HTTP 0 and rejects", async () => {
		replyHttps(undefined, JSON.stringify({}));
		await expect(createBranchShare(BASE, KEY, PAYLOAD)).rejects.toThrow(/request failed \(HTTP 0\)/);
	});
});

describe("revokeBranchShare", () => {
	it.each([200, 204, 404])("resolves on status %i", async (status) => {
		replyHttps(status, "");
		await expect(revokeBranchShare(BASE, KEY, "sh_1")).resolves.toBeUndefined();
	});

	it("rejects on an unexpected status", async () => {
		replyHttps(500, "");
		await expect(revokeBranchShare(BASE, KEY, "sh_1")).rejects.toThrow(/Revoke failed with status 500/);
	});

	it("rejects when no base URL can be determined", async () => {
		await expect(revokeBranchShare(undefined, "sk-jol-plain", "sh_1")).rejects.toThrow(
			/site URL could not be determined/,
		);
	});

	it("rejects on a network error", async () => {
		mockHttpsRequest.mockImplementation((_url: unknown, _opts: unknown, _cb: unknown) => {
			const req = mockRequest();
			queueMicrotask(() => req._emit("error", new Error("down")));
			return req;
		});
		await expect(revokeBranchShare(BASE, KEY, "sh_1")).rejects.toThrow(/Network error: down/);
	});

	it("uses plain http for an http base URL", async () => {
		replyHttp(204, "");
		await expect(revokeBranchShare("http://jolli-local.me/test1", KEY, "sh_1")).resolves.toBeUndefined();
		expect(mockHttpRequest).toHaveBeenCalled();
		expect(mockHttpsRequest).not.toHaveBeenCalled();
	});

	it("treats a response with no status code as HTTP 0 and rejects", async () => {
		replyHttps(undefined, "");
		await expect(revokeBranchShare(BASE, KEY, "sh_1")).rejects.toThrow(/Revoke failed with status 0/);
	});
});

describe("updateBranchShareExpiry", () => {
	const EXPIRES = "2026-10-01T00:00:00.000Z";

	it("PATCHes and resolves the server-confirmed expiry", async () => {
		replyHttps(200, JSON.stringify({ shareId: 1, expiresAt: EXPIRES, visibility: "public" }));
		const res = await updateBranchShareExpiry(BASE, KEY, "1", EXPIRES);
		expect(res.expiresAt).toBe(EXPIRES);
		const opts = mockHttpsRequest.mock.calls[0][1] as { method: string };
		expect(opts.method).toBe("PATCH");
	});

	it("rejects a non-2xx with detail", async () => {
		replyHttps(400, JSON.stringify({ error: "invalid_expiry", message: "must be in the future" }));
		await expect(updateBranchShareExpiry(BASE, KEY, "1", EXPIRES)).rejects.toThrow(/must be in the future/);
	});

	it("rejects when no base URL can be determined", async () => {
		await expect(updateBranchShareExpiry(undefined, "sk-jol-plain", "1", EXPIRES)).rejects.toThrow(
			/site URL could not be determined/,
		);
	});

	it("rejects on invalid JSON", async () => {
		replyHttps(200, "nope");
		await expect(updateBranchShareExpiry(BASE, KEY, "1", EXPIRES)).rejects.toThrow(/Invalid JSON/);
	});

	it("uses plain http for an http base URL", async () => {
		replyHttp(200, JSON.stringify({ shareId: 1, expiresAt: EXPIRES, visibility: "public" }));
		const res = await updateBranchShareExpiry("http://jolli-local.me/test1", KEY, "1", EXPIRES);
		expect(res.expiresAt).toBe(EXPIRES);
		expect(mockHttpRequest).toHaveBeenCalled();
		expect(mockHttpsRequest).not.toHaveBeenCalled();
	});

	it("treats a response with no status code as HTTP 0 and rejects", async () => {
		replyHttps(undefined, JSON.stringify({ shareId: 1, expiresAt: EXPIRES, visibility: "public" }));
		await expect(updateBranchShareExpiry(BASE, KEY, "1", EXPIRES)).rejects.toThrow(/\(HTTP 0\)/);
	});

	it("falls back to a generic message when the error body is empty", async () => {
		replyHttps(500, JSON.stringify({}));
		await expect(updateBranchShareExpiry(BASE, KEY, "1", EXPIRES)).rejects.toThrow(
			/expiry update failed \(HTTP 500\)/,
		);
	});

	it("rejects on a network error", async () => {
		mockHttpsRequest.mockImplementation((_url: unknown, _opts: unknown, _cb: unknown) => {
			const req = mockRequest();
			queueMicrotask(() => req._emit("error", new Error("offline")));
			return req;
		});
		await expect(updateBranchShareExpiry(BASE, KEY, "1", EXPIRES)).rejects.toThrow(/Network error: offline/);
	});
});

describe("fetchSharedSnapshot", () => {
	const SNAP = JSON.stringify({
		branch: "feature/x",
		repoName: "repo",
		decisionCount: 3,
		headCommitHash: "a".repeat(40),
		generatedAt: "2026-01-01T00:00:00.000Z",
		scope: { summary: true, plans: true, notes: true, transcripts: false },
		content: "# shared",
	});

	it("rejects an empty token", async () => {
		await expect(fetchSharedSnapshot(BASE, "")).rejects.toThrow(/Missing share token/);
	});

	it("rejects an off-allowlist origin", async () => {
		await expect(fetchSharedSnapshot("https://evil.example.com", "tok")).rejects.toThrow(/Rejected Jolli origin/);
	});

	it("resolves the snapshot on 2xx", async () => {
		replyHttps(200, SNAP);
		const snap = await fetchSharedSnapshot(BASE, "tok_abc");
		expect(snap.branch).toBe("feature/x");
		expect(snap.content).toBe("# shared");
	});

	it("sends a tenant-slug header for a path-based origin", async () => {
		replyHttps(200, SNAP);
		await fetchSharedSnapshot("https://jolli-local.me/test1", "tok_abc");
		const opts = mockHttpsRequest.mock.calls[0][1] as { headers: Record<string, string> };
		expect(opts.headers["x-tenant-slug"]).toBe("test1");
	});

	it("maps 410 to ShareRevokedError", async () => {
		replyHttps(410, "");
		await expect(fetchSharedSnapshot(BASE, "tok_abc")).rejects.toBeInstanceOf(ShareRevokedError);
	});

	it("maps a 200 with revoked:true to ShareRevokedError", async () => {
		replyHttps(200, JSON.stringify({ revoked: true }));
		await expect(fetchSharedSnapshot(BASE, "tok_abc")).rejects.toBeInstanceOf(ShareRevokedError);
	});

	it("maps 426 to PluginOutdatedError", async () => {
		replyHttps(426, JSON.stringify({ message: "old" }));
		await expect(fetchSharedSnapshot(BASE, "tok_abc")).rejects.toBeInstanceOf(PluginOutdatedError);
	});

	it("surfaces a detailed error on other non-2xx", async () => {
		replyHttps(404, JSON.stringify({ error: "not_found" }));
		await expect(fetchSharedSnapshot(BASE, "tok_abc")).rejects.toThrow(/not_found \(HTTP 404\)/);
	});

	it("rejects on invalid JSON", async () => {
		replyHttps(200, "nope");
		await expect(fetchSharedSnapshot(BASE, "tok_abc")).rejects.toThrow(/Invalid JSON/);
	});

	it("rejects on a network error", async () => {
		mockHttpsRequest.mockImplementation((_url: unknown, _opts: unknown, _cb: unknown) => {
			const req = mockRequest();
			queueMicrotask(() => req._emit("error", new Error("net")));
			return req;
		});
		await expect(fetchSharedSnapshot(BASE, "tok_abc")).rejects.toThrow(/Network error: net/);
	});

	it("treats a response with no status code as HTTP 0 and rejects", async () => {
		replyHttps(undefined, JSON.stringify({}));
		await expect(fetchSharedSnapshot(BASE, "tok_abc")).rejects.toThrow(/request failed \(HTTP 0\)/);
	});

	it("falls back to the default 426 message when the body has none", async () => {
		replyHttps(426, JSON.stringify({}));
		await expect(fetchSharedSnapshot(BASE, "tok_abc")).rejects.toThrow(/Plugin version is outdated/);
	});

	it("falls back to 'request failed' when the error body is empty", async () => {
		replyHttps(500, JSON.stringify({}));
		await expect(fetchSharedSnapshot(BASE, "tok_abc")).rejects.toThrow(/request failed \(HTTP 500\)/);
	});
});

const LIVE_PAYLOAD: LiveSharePayload = {
	repoUrl: "https://github.com/acme/repo",
	repoName: "repo",
	branch: "feature/x",
	kind: "branch",
	visibility: "public",
	decisionCount: 3,
	headCommitHash: "a".repeat(40),
	commitHashes: ["a".repeat(40)],
	branchSlug: "feature-x",
	ref: {
		kind: "branchCollection",
		relativePath: "feature/x",
		covered: [{ commitHash: "a".repeat(40), summaryDocId: 11, attachmentDocIds: [12] }],
	},
};

describe("createLiveShare", () => {
	it("resolves a public share (with token) on 2xx", async () => {
		replyHttps(200, OK_RESULT);
		const res = await createLiveShare(BASE, KEY, LIVE_PAYLOAD);
		expect(res.shareUrl).toBe("https://acme.jolli.ai/b/feature-x-tok_abc");
		expect(res.token).toBe("tok_abc");
	});

	it("resolves an org share with no token on 2xx", async () => {
		replyHttps(
			201,
			JSON.stringify({
				shareId: 7,
				shareUrl: "https://acme.jolli.ai/share/branch/7/view",
				expiresAt: "2026-09-01T00:00:00.000Z",
				visibility: "org",
			}),
		);
		const res = await createLiveShare(BASE, KEY, { ...LIVE_PAYLOAD, visibility: "org" });
		expect(res.visibility).toBe("org");
		expect(res.token).toBeUndefined();
	});

	it("rejects an unexpected 2xx shape (missing shareUrl)", async () => {
		replyHttps(200, JSON.stringify({ shareId: 1 }));
		await expect(createLiveShare(BASE, KEY, LIVE_PAYLOAD)).rejects.toThrow(/unexpected response/);
	});

	it("maps 426 to PluginOutdatedError", async () => {
		replyHttps(426, JSON.stringify({ message: "too old" }));
		await expect(createLiveShare(BASE, KEY, LIVE_PAYLOAD)).rejects.toBeInstanceOf(PluginOutdatedError);
	});

	it("rejects with detail on a 4xx", async () => {
		replyHttps(400, JSON.stringify({ error: "bad_request", message: "nope" }));
		await expect(createLiveShare(BASE, KEY, LIVE_PAYLOAD)).rejects.toThrow(/bad_request — nope \(HTTP 400\)/);
	});

	it("rejects when no base URL can be determined", async () => {
		await expect(createLiveShare(undefined, makeKey({ t: "acme" }), LIVE_PAYLOAD)).rejects.toThrow(
			/site URL could not be determined/,
		);
	});

	it("treats an unparseable 2xx body as a missing-field response", async () => {
		replyHttps(200, "not json");
		await expect(createLiveShare(BASE, KEY, LIVE_PAYLOAD)).rejects.toThrow(/unexpected response/);
	});

	it("uses plain http for an http base URL", async () => {
		replyHttp(200, OK_RESULT);
		const res = await createLiveShare("http://jolli-local.me/test1", KEY, LIVE_PAYLOAD);
		expect(res.shareId).toBe("sh_1");
		expect(mockHttpRequest).toHaveBeenCalled();
		expect(mockHttpsRequest).not.toHaveBeenCalled();
	});

	it("treats a response with no status code as HTTP 0 and rejects", async () => {
		replyHttps(undefined, OK_RESULT);
		await expect(createLiveShare(BASE, KEY, LIVE_PAYLOAD)).rejects.toThrow(/request failed \(HTTP 0\)/);
	});

	it("falls back to the default 426 message when the body has none", async () => {
		replyHttps(426, JSON.stringify({}));
		await expect(createLiveShare(BASE, KEY, LIVE_PAYLOAD)).rejects.toThrow(/Plugin version is outdated/);
	});

	it("rejects on a network error", async () => {
		mockHttpsRequest.mockImplementation((_url: unknown, _opts: unknown, _cb: unknown) => {
			const req = mockRequest();
			queueMicrotask(() => req._emit("error", new Error("gone")));
			return req;
		});
		await expect(createLiveShare(BASE, KEY, LIVE_PAYLOAD)).rejects.toThrow(/Network error: gone/);
	});
});

describe("updateLiveShare", () => {
	it("resolves the updated share on 2xx", async () => {
		replyHttps(200, OK_RESULT);
		const res = await updateLiveShare(BASE, KEY, "sh_1", { ref: LIVE_PAYLOAD.ref });
		expect(res.shareId).toBe("sh_1");
	});

	it("rejects on a non-2xx", async () => {
		replyHttps(500, JSON.stringify({ error: "boom" }));
		await expect(updateLiveShare(BASE, KEY, "sh_1", { visibility: "org" })).rejects.toThrow(/HTTP 500/);
	});

	it("treats an empty 2xx body as null json and rejects with the raw-body suffix", async () => {
		replyHttps(200, "");
		await expect(updateLiveShare(BASE, KEY, "sh_1", { visibility: "org" })).rejects.toThrow(
			/request failed \(HTTP 200\)/,
		);
	});
});

describe("listOrgMembers", () => {
	it("maps { members }, coalescing a non-string name to empty and skipping members with no email", async () => {
		replyHttps(
			200,
			JSON.stringify({
				members: [
					{ name: "Ada", email: "ada@example.com" },
					{ name: null, email: "grace@example.com" },
					{ name: "No Email" },
				],
			}),
		);
		expect(await listOrgMembers(BASE, KEY)).toEqual([
			{ name: "Ada", email: "ada@example.com" },
			{ name: "", email: "grace@example.com" },
		]);
	});

	it("requests the API-key-authenticated /api/jolli-memory/org-members endpoint", async () => {
		let requestedUrl: URL | undefined;
		mockHttpsRequest.mockImplementation((url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
			requestedUrl = url as URL;
			cb(mockResponse(200, JSON.stringify({ members: [] })));
			return mockRequest();
		});
		await listOrgMembers(BASE, KEY);
		expect(requestedUrl?.pathname).toBe("/api/jolli-memory/org-members");
	});

	it("returns [] on a non-2xx (picker still has git contributors + manual entry)", async () => {
		replyHttps(403, JSON.stringify({ error: "forbidden" }));
		expect(await listOrgMembers(BASE, KEY)).toEqual([]);
	});

	it("returns [] (never throws) when the request itself fails — e.g. no base URL", async () => {
		expect(await listOrgMembers(undefined, makeKey({ t: "acme" }))).toEqual([]);
	});

	it("returns [] when members is not an array", async () => {
		replyHttps(200, JSON.stringify({ members: "not-an-array" }));
		expect(await listOrgMembers(BASE, KEY)).toEqual([]);
	});
});
