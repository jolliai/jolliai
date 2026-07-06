import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock node:http / node:https ────────────────────────────────────────────

const { mockHttpRequest, mockHttpsRequest } = vi.hoisted(() => ({
	mockHttpRequest: vi.fn(),
	mockHttpsRequest: vi.fn(),
}));

vi.mock("node:http", () => ({ request: mockHttpRequest }));
vi.mock("node:https", () => ({ request: mockHttpsRequest }));
vi.mock("../util/Logger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	clearOrgMembersCache,
	createLiveShare,
	exportSharedBranch,
	type LiveSharePayload,
	listOrgMembers,
	sendShareInviteAndGrantAccess,
	PluginOutdatedError,
	revokeBranchShare,
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

	it("sends the org visibility on the wire unchanged and echoes it back as 'org'", async () => {
		const req = mockRequest();
		mockHttpsRequest.mockImplementation((_url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
			cb(
				mockResponse(
					201,
					JSON.stringify({
						shareId: 7,
						shareUrl: "https://acme.jolli.ai/share/branch/7/view",
						expiresAt: "2026-09-01T00:00:00.000Z",
						// The org tier uses the same value end-to-end — no wire translation.
						visibility: "org",
					}),
				),
			);
			return req;
		});
		const res = await createLiveShare(BASE, KEY, { ...LIVE_PAYLOAD, visibility: "org" });
		const sentBody = JSON.parse((req.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
		expect(sentBody.visibility).toBe("org");
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

	it("sends the org visibility on a PATCH unchanged and echoes it back as 'org'", async () => {
		const req = mockRequest();
		mockHttpsRequest.mockImplementation((_url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
			cb(mockResponse(200, JSON.stringify({ shareId: "sh_1", visibility: "org" })));
			return req;
		});
		const res = await updateLiveShare(BASE, KEY, "sh_1", { visibility: "org" });
		const sentBody = JSON.parse((req.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
		expect(sentBody.visibility).toBe("org");
		expect(res.visibility).toBe("org");
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

describe("exportSharedBranch", () => {
	const EXPORT_BODY = JSON.stringify({
		branch: "feature/x",
		repoName: "acme/widgets",
		repoUrl: "https://github.com/acme/widgets",
		kind: "branch",
		headCommitHash: "a1b2c3",
		commits: [{ commitHash: "a1b2c3", summaryJson: '{"commitHash":"a1b2c3"}', attachments: [] }],
	});

	it("resolves the structured export on 2xx", async () => {
		replyHttps(200, EXPORT_BODY);
		const res = await exportSharedBranch(BASE, KEY, "tok");
		expect(res.repoUrl).toBe("https://github.com/acme/widgets");
		expect(res.commits).toHaveLength(1);
		expect(res.commits[0].commitHash).toBe("a1b2c3");
	});

	it("hits the api-key-authed /export path with the encoded token", async () => {
		let requestedUrl: URL | undefined;
		mockHttpsRequest.mockImplementation((url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
			requestedUrl = url as URL;
			cb(mockResponse(200, EXPORT_BODY));
			return mockRequest();
		});
		await exportSharedBranch(BASE, KEY, "tok/en");
		expect(requestedUrl?.pathname).toBe("/api/share/branch/tok%2Fen/export");
	});

	it("rejects a 2xx that is not a real export payload (missing commits array)", async () => {
		replyHttps(200, JSON.stringify({ branch: "x" }));
		await expect(exportSharedBranch(BASE, KEY, "tok")).rejects.toThrow(/HTTP 200|request failed/);
	});

	it("rejects a 2xx whose commits are an array but the identity fields are missing", async () => {
		// commits is an array, but repoName/branch/headCommitHash are absent — the importer
		// would otherwise feed `undefined` into path building and throw a raw TypeError.
		replyHttps(200, JSON.stringify({ commits: [] }));
		await expect(exportSharedBranch(BASE, KEY, "tok")).rejects.toThrow(/HTTP 200|request failed/);
	});

	it("rejects a 403 (not authorized for this share)", async () => {
		replyHttps(403, JSON.stringify({ error: "forbidden" }));
		await expect(exportSharedBranch(BASE, KEY, "tok")).rejects.toThrow(/forbidden \(HTTP 403\)/);
	});

	it("accepts a public-tier payload whose repoUrl is null (backend withholds it)", async () => {
		const body = JSON.parse(EXPORT_BODY) as Record<string, unknown>;
		replyHttps(200, JSON.stringify({ ...body, repoUrl: null }));
		const res = await exportSharedBranch(BASE, KEY, "tok");
		expect(res.repoUrl).toBeNull();
		expect(res.repoName).toBe("acme/widgets");
	});

	it("rejects a 404 — a cross-deployment/unknown token", async () => {
		replyHttps(404, JSON.stringify({ error: "not_found" }));
		await expect(exportSharedBranch(BASE, KEY, "tok")).rejects.toThrow(/HTTP 404/);
	});
});

describe("listOrgMembers", () => {
	beforeEach(() => {
		// Each case wires its own reply; a cached list from a prior case would mask it.
		clearOrgMembersCache();
	});

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

	it("caps the directory at 100 members", async () => {
		const members = Array.from({ length: 150 }, (_, i) => ({ name: `User ${i}`, email: `u${i}@example.com` }));
		replyHttps(200, JSON.stringify({ members }));
		const result = await listOrgMembers(BASE, KEY);
		expect(result).toHaveLength(100);
		expect(result[99]).toEqual({ name: "User 99", email: "u99@example.com" });
	});

	it("serves a repeat call from the cache within the TTL (one HTTP request total)", async () => {
		replyHttps(200, JSON.stringify({ members: [{ name: "Ada", email: "ada@example.com" }] }));
		const first = await listOrgMembers(BASE, KEY);
		const second = await listOrgMembers(BASE, KEY);
		expect(second).toEqual(first);
		expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
	});

	it("re-fetches once the 3-minute TTL has elapsed", async () => {
		vi.useFakeTimers();
		try {
			replyHttps(200, JSON.stringify({ members: [{ name: "Ada", email: "ada@example.com" }] }));
			// mockResponse delivers via queueMicrotask, which fake timers don't gate — awaiting still resolves.
			await listOrgMembers(BASE, KEY);
			vi.advanceTimersByTime(3 * 60 * 1000 + 1);
			replyHttps(200, JSON.stringify({ members: [{ name: "Grace", email: "grace@example.com" }] }));
			expect(await listOrgMembers(BASE, KEY)).toEqual([{ name: "Grace", email: "grace@example.com" }]);
			expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("caches per (baseUrl, apiKey) — a different key is a fresh fetch", async () => {
		replyHttps(200, JSON.stringify({ members: [{ name: "Ada", email: "ada@example.com" }] }));
		await listOrgMembers(BASE, KEY);
		await listOrgMembers(BASE, makeKey({ t: "other", u: "https://acme.jolli.ai" }));
		expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
	});

	it("does not cache a failed fetch — the next call retries", async () => {
		replyHttps(500, JSON.stringify({ error: "boom" }));
		expect(await listOrgMembers(BASE, KEY)).toEqual([]);
		replyHttps(200, JSON.stringify({ members: [{ name: "Ada", email: "ada@example.com" }] }));
		expect(await listOrgMembers(BASE, KEY)).toEqual([{ name: "Ada", email: "ada@example.com" }]);
		expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
	});

	it("does not cache an empty result — the next call re-fetches", async () => {
		replyHttps(200, JSON.stringify({ members: [] }));
		expect(await listOrgMembers(BASE, KEY)).toEqual([]);
		replyHttps(200, JSON.stringify({ members: [{ name: "Ada", email: "ada@example.com" }] }));
		expect(await listOrgMembers(BASE, KEY)).toEqual([{ name: "Ada", email: "ada@example.com" }]);
		expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
	});
});

describe("sendShareInviteAndGrantAccess", () => {
	it("POSTs the invite (grant + email) and returns the sent/failed report", async () => {
		let requestedUrl: URL | undefined;
		let sentBody = "";
		mockHttpsRequest.mockImplementation((url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
			requestedUrl = url as URL;
			const req = mockRequest();
			req.write = vi.fn((chunk: string) => {
				sentBody += chunk;
			});
			cb(mockResponse(200, JSON.stringify({ sent: ["cy@x.io"], failed: ["down@x.io"] })));
			return req;
		});
		const out = await sendShareInviteAndGrantAccess(BASE, KEY, "42", {
			recipients: ["cy@x.io", "down@x.io"],
			message: "note",
		});
		expect(requestedUrl?.pathname).toBe("/api/share/branch/42/invite");
		expect(JSON.parse(sentBody)).toEqual({ recipients: ["cy@x.io", "down@x.io"], message: "note" });
		expect(out).toEqual({ sent: ["cy@x.io"], failed: ["down@x.io"] });
	});

	it("rejects a non-2xx (e.g. owner-only 403) with the status", async () => {
		replyHttps(403, JSON.stringify({ error: "forbidden" }));
		await expect(sendShareInviteAndGrantAccess(BASE, KEY, "42", { recipients: ["a@x.io"] })).rejects.toThrow(
			/HTTP 403/,
		);
	});

	it("treats a 202 Accepted (empty async body) as success — all requested recipients sent", async () => {
		replyHttps(202, "");
		const out = await sendShareInviteAndGrantAccess(BASE, KEY, "42", { recipients: ["a@x.io", "b@x.io"] });
		expect(out).toEqual({ sent: ["a@x.io", "b@x.io"], failed: [] });
	});

	it("treats a 2xx JSON body without a sent/failed report as success (all sent)", async () => {
		replyHttps(200, JSON.stringify({ ok: true }));
		const out = await sendShareInviteAndGrantAccess(BASE, KEY, "42", { recipients: ["a@x.io"] });
		expect(out).toEqual({ sent: ["a@x.io"], failed: [] });
	});

	it("still rejects a 2xx whose body is an SPA HTML page (misrouted host)", async () => {
		replyHttps(200, "<!doctype html><html><title>Jolli</title></html>");
		await expect(sendShareInviteAndGrantAccess(BASE, KEY, "42", { recipients: ["a@x.io"] })).rejects.toThrow();
	});
});
