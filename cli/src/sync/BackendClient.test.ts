/**
 * Tests for BackendClient. `fetch` is replaced with a stub via the
 * `fetchImpl` constructor option so we control responses without touching
 * the network.
 */

import { describe, expect, it, vi } from "vitest";
import { BackendClient, SyncBackendNetworkError, SyncBackendUnauthorizedError } from "./BackendClient.js";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function emptyResponse(status: number): Response {
	return new Response("", { status });
}

/**
 * Builds a syntactically valid `sk-jol-<base64url(JSON)>.<secret>` key that
 * `parseJolliApiKey` will decode. Tests use this to drive the auth path
 * without depending on a real backend key.
 */
function makeApiKey(opts?: { tenantUrl?: string; t?: string; o?: string }): string {
	const meta: Record<string, string> = {
		t: opts?.t ?? "test-tenant",
		u: opts?.tenantUrl ?? "https://app.jolli.ai",
	};
	if (opts?.o) meta.o = opts.o;
	const payload = Buffer.from(JSON.stringify(meta)).toString("base64url");
	return `sk-jol-${payload}.secretpart`;
}

/** A complete-looking mint response — tests can shallow-override individual fields. */
function mintResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		token: "ghs_abc",
		expiresAt: Date.now() + 3600_000,
		repoCloneUrl: "https://github.com/jolli-vaults/foo-abc.git",
		repoFullName: "jolli-vaults/foo-abc",
		defaultBranch: "main",
		githubRepoCreated: false,
		alreadyVaultBound: true,
		lockOwnerToken: "test-lock-owner-token",
		...overrides,
	};
}

function makeClient(opts: {
	fetchImpl: typeof fetch;
	apiKey?: string;
	baseUrl?: string;
	timeoutMs?: number;
}): BackendClient {
	return new BackendClient({
		fetchImpl: opts.fetchImpl,
		baseUrlOverride: opts.baseUrl ?? "https://app.jolli.ai",
		jolliApiKeyProvider: async () => opts.apiKey ?? makeApiKey(),
		timeoutMs: opts.timeoutMs,
	});
}

describe("BackendClient.mintGitCredentials", () => {
	it("maps backend response shape into GitCredentials", async () => {
		const expiresAt = Date.now() + 3600_000;
		const fetchImpl = vi.fn(async () =>
			jsonResponse(
				200,
				mintResponse({
					expiresAt,
					repoCloneUrl: "https://github.com/jolli-vaults/foo-abc.git",
					repoFullName: "jolli-vaults/foo-abc",
					defaultBranch: "main",
					githubRepoCreated: true,
					alreadyVaultBound: false,
					lockOwnerToken: "test-lock-owner-token",
				}),
			),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });

		const creds = await client.mintGitCredentials();
		expect(creds.gitUrl).toBe("https://github.com/jolli-vaults/foo-abc.git");
		expect(creds.token).toBe("ghs_abc");
		expect(creds.expiresAt).toBe(expiresAt);
		expect(creds.repoFullName).toBe("jolli-vaults/foo-abc");
		expect(creds.defaultBranch).toBe("main");
		expect(creds.githubRepoCreated).toBe(true);
		expect(creds.alreadyVaultBound).toBe(false);
	});

	it("parses ISO-string expiresAt to epoch ms", async () => {
		const iso = "2027-01-01T00:00:00Z";
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, mintResponse({ expiresAt: iso })),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		const creds = await client.mintGitCredentials();
		expect(creds.expiresAt).toBe(Date.parse(iso));
	});

	it("sends Authorization: Bearer <jolliApiKey> + tenant headers + x-jolli-client", async () => {
		let capturedHeaders: Headers | undefined;
		let capturedBody: string | undefined;
		const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			capturedHeaders = new Headers(init?.headers);
			capturedBody = init?.body as string;
			return jsonResponse(200, mintResponse());
		}) as unknown as typeof fetch;
		const apiKey = makeApiKey({ o: "org-acme" });
		const client = new BackendClient({
			fetchImpl,
			baseUrlOverride: "https://app.jolli.ai/acme",
			jolliApiKeyProvider: async () => apiKey,
		});

		await client.mintGitCredentials();

		expect(capturedHeaders?.get("Authorization")).toBe(`Bearer ${apiKey}`);
		expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
		expect(capturedHeaders?.get("x-jolli-client")).toMatch(/^cli\//);
		expect(capturedHeaders?.get("x-tenant-slug")).toBe("acme");
		expect(capturedHeaders?.get("x-org-slug")).toBe("org-acme");
		expect(capturedBody).toBe("{}");
	});

	it("derives base URL from the jolliApiKey when no override is supplied", async () => {
		let capturedUrl: string | undefined;
		const fetchImpl = vi.fn(async (url: string | URL) => {
			capturedUrl = String(url);
			return jsonResponse(200, mintResponse());
		}) as unknown as typeof fetch;
		const apiKey = makeApiKey({ tenantUrl: "https://acme.jolli.ai" });
		const client = new BackendClient({
			fetchImpl,
			jolliApiKeyProvider: async () => apiKey,
		});

		await client.mintGitCredentials();
		expect(capturedUrl).toBe("https://acme.jolli.ai/api/mb-sync/credentials");
	});

	it("posts to the resolved /api/mb-sync/credentials path", async () => {
		let capturedUrl: string | undefined;
		const fetchImpl = vi.fn(async (url: string | URL) => {
			capturedUrl = String(url);
			return jsonResponse(200, mintResponse());
		}) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl, baseUrl: "https://app.jolli.ai" });

		await client.mintGitCredentials();
		expect(capturedUrl).toBe("https://app.jolli.ai/api/mb-sync/credentials");
	});

	it("throws SyncBackendUnauthorizedError on 401", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthorized" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toBeInstanceOf(SyncBackendUnauthorizedError);
	});

	it("throws SyncBackendUnauthorizedError on 403", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(403, { error: "forbidden" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toBeInstanceOf(SyncBackendUnauthorizedError);
	});

	it("throws SyncBackendError on 500", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "internal" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toMatchObject({
			name: "SyncBackendError",
			status: 500,
		});
	});

	it("throws SyncBackendNetworkError when fetch rejects (DNS / refused / abort)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toBeInstanceOf(SyncBackendNetworkError);
	});

	it("throws SyncBackendUnauthorizedError when jolliApiKeyProvider returns undefined", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(200, mintResponse())) as unknown as typeof fetch;
		const client = new BackendClient({
			fetchImpl,
			baseUrlOverride: "https://app.jolli.ai",
			jolliApiKeyProvider: async () => undefined,
		});
		await expect(client.mintGitCredentials()).rejects.toBeInstanceOf(SyncBackendUnauthorizedError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("throws SyncBackendUnauthorizedError when jolliApiKey is malformed", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(200, mintResponse())) as unknown as typeof fetch;
		const client = new BackendClient({
			fetchImpl,
			baseUrlOverride: "https://app.jolli.ai",
			jolliApiKeyProvider: async () => "not-a-jolli-key",
		});
		await expect(client.mintGitCredentials()).rejects.toBeInstanceOf(SyncBackendUnauthorizedError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("throws SyncBackendError(502) when 2xx body is missing required fields", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, { token: "ghs_abc", expiresAt: Date.now() + 3600_000 }),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining("repoCloneUrl"),
		});
	});

	it("throws SyncBackendError(502) when repoCloneUrl uses a non-https scheme", async () => {
		// Defense in depth: the askpass helper injects a bearer token into
		// the clone URL, so a `http://` URL would leak the token in cleartext.
		// The backend contract is "always https://"; treat anything else as a
		// hard server bug rather than try to recover.
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, mintResponse({ repoCloneUrl: "http://github.com/jolli-vaults/foo-abc.git" })),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining("non-https repoCloneUrl"),
		});
	});

	it("throws SyncBackendError(502) when repoCloneUrl is not a parseable URL", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, mintResponse({ repoCloneUrl: "not a url at all" })),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining("unparseable repoCloneUrl"),
		});
	});

	it("throws SyncBackendError(502) when token is missing from 2xx body", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, mintResponse({ token: undefined })),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining("token"),
		});
	});

	it("throws SyncBackendError(502) when expiresAt is missing from 2xx body", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, mintResponse({ expiresAt: undefined })),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining("expiresAt"),
		});
	});

	it("throws SyncBackendError(502) when alreadyVaultBound is invalid", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, mintResponse({ alreadyVaultBound: "yes" })),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining("alreadyVaultBound"),
		});
	});

	it("throws SyncBackendError(502) when expiresAt is not parseable", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, mintResponse({ expiresAt: "not a date" })),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining("invalid expiresAt"),
		});
	});

	it("throws SyncBackendError(502) when body is not JSON", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("<html>oops</html>", { status: 200 }),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.mintGitCredentials()).rejects.toMatchObject({
			status: 502,
			message: expect.stringContaining("non-JSON"),
		});
	});
});

describe("BackendClient.notifyPush", () => {
	const LOCK_OWNER = "0123456789abcdef0123456789abcdef";

	it("posts { commitSha, branch, lockOwnerToken } to /api/mb-sync/notify-push", async () => {
		let capturedUrl: string | undefined;
		let capturedBody: string | undefined;
		const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedBody = init?.body as string;
			return emptyResponse(200);
		}) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });

		await client.notifyPush({ commitSha: "abc1234", branch: "main", lockOwnerToken: LOCK_OWNER });
		expect(capturedUrl).toBe("https://app.jolli.ai/api/mb-sync/notify-push");
		expect(capturedBody).toBe(JSON.stringify({ commitSha: "abc1234", branch: "main", lockOwnerToken: LOCK_OWNER }));
	});

	it("tolerates an empty 2xx body (returns void)", async () => {
		const fetchImpl = vi.fn(async () => emptyResponse(200)) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(
			client.notifyPush({ commitSha: "abc", branch: "main", lockOwnerToken: LOCK_OWNER }),
		).resolves.toBeUndefined();
	});

	it("surfaces 5xx as SyncBackendError so the engine can log it", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "busy" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(
			client.notifyPush({ commitSha: "abc", branch: "main", lockOwnerToken: LOCK_OWNER }),
		).rejects.toMatchObject({ status: 503 });
	});

	it("surfaces 400 invalid_request as SyncBackendError (client bug — token missing/malformed)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(400, { error: "invalid_request" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(
			client.notifyPush({ commitSha: "abc", branch: "main", lockOwnerToken: LOCK_OWNER }),
		).rejects.toMatchObject({ status: 400 });
	});
});

describe("BackendClient.releaseLock (JOLLI-1577)", () => {
	const LOCK_OWNER = "0123456789abcdef0123456789abcdef";

	it("posts { lockOwnerToken } to /api/mb-sync/release-lock", async () => {
		let capturedUrl: string | undefined;
		let capturedBody: string | undefined;
		const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedBody = init?.body as string;
			return emptyResponse(202);
		}) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });

		await client.releaseLock({ lockOwnerToken: LOCK_OWNER });
		expect(capturedUrl).toBe("https://app.jolli.ai/api/mb-sync/release-lock");
		// Body shape is exactly `{ lockOwnerToken }` — no commitSha, no
		// branch. The backend's `ReleaseLockSchema` rejects extras with
		// 400 `invalid_request`.
		expect(capturedBody).toBe(JSON.stringify({ lockOwnerToken: LOCK_OWNER }));
	});

	it("tolerates a 202 success (returns void)", async () => {
		// Backend returns `202 { released: true }`. Client doesn't care
		// about the response body — runRound's finally just needs the
		// HTTP call to succeed.
		const fetchImpl = vi.fn(async () => jsonResponse(202, { released: true })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.releaseLock({ lockOwnerToken: LOCK_OWNER })).resolves.toBeUndefined();
	});

	it("surfaces 400 invalid_request as SyncBackendError (client bug — token malformed)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(400, { error: "invalid_request" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.releaseLock({ lockOwnerToken: LOCK_OWNER })).rejects.toMatchObject({ status: 400 });
	});

	it("surfaces 404 personal_space_not_found as SyncBackendError (caller swallows in finally)", async () => {
		// 404 happens when the token was never held (e.g. mint happened
		// before account-switch) or backend TTL already released it.
		// `runRound`'s finally catches the throw and logs warn — the round
		// outcome is unaffected.
		const fetchImpl = vi.fn(async () =>
			jsonResponse(404, { error: "personal_space_not_found" }),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.releaseLock({ lockOwnerToken: LOCK_OWNER })).rejects.toMatchObject({ status: 404 });
	});

	it("surfaces 5xx as SyncBackendError so the engine can log it", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "busy" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(client.releaseLock({ lockOwnerToken: LOCK_OWNER })).rejects.toMatchObject({ status: 503 });
	});
});

describe("BackendClient — 423 vault_locked (§0.8)", () => {
	it("mintGitCredentials throws VaultLockedError on 423", async () => {
		const { VaultLockedError } = await import("./BackendClient.js");
		const fetchImpl = vi.fn(async () => jsonResponse(423, { error: "vault_locked" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		const err = await client.mintGitCredentials().catch((e) => e);
		expect(err).toBeInstanceOf(VaultLockedError);
		expect(err.status).toBe(423);
		expect(err.message).toContain("Personal Space");
	});
});

describe("BackendClient — 503 pending_flush_failed", () => {
	it("mintGitCredentials throws WebFlushPendingError on 503 pending_flush_failed with retryAfterSeconds", async () => {
		const { WebFlushPendingError } = await import("./BackendClient.js");
		const fetchImpl = vi.fn(async () =>
			jsonResponse(503, {
				error: "pending_flush_failed",
				message: "Some recent edits from your web session have not made it to GitHub yet.",
				retryAfterSeconds: 45,
			}),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		const err = await client.mintGitCredentials().catch((e) => e);
		expect(err).toBeInstanceOf(WebFlushPendingError);
		expect(err.status).toBe(503);
		expect(err.retryAfterSeconds).toBe(45);
		expect(err.message).toContain("web");
	});

	it("defaults retryAfterSeconds to 30 when the field is missing or invalid", async () => {
		const { WebFlushPendingError } = await import("./BackendClient.js");
		const fetchImpl = vi.fn(async () =>
			jsonResponse(503, { error: "pending_flush_failed", message: "wait" }),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		const err = await client.mintGitCredentials().catch((e) => e);
		expect(err).toBeInstanceOf(WebFlushPendingError);
		expect(err.retryAfterSeconds).toBe(30);
	});

	it("503 with a different error code falls through to generic SyncBackendError (not WebFlushPendingError)", async () => {
		const { WebFlushPendingError, SyncBackendError } = await import("./BackendClient.js");
		const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "flip_failed" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		const err = await client.mintGitCredentials().catch((e) => e);
		expect(err).not.toBeInstanceOf(WebFlushPendingError);
		expect(err).toBeInstanceOf(SyncBackendError);
		expect(err.status).toBe(503);
	});
});

describe("BackendClient.getLegacyContent", () => {
	it("GETs /api/mb-sync/legacy-content without a body", async () => {
		let capturedMethod: string | undefined;
		let capturedUrl: string | undefined;
		let capturedBody: RequestInit["body"] | undefined;
		const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedMethod = init?.method;
			capturedBody = init?.body;
			return jsonResponse(200, {
				spaceId: 42,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [],
			});
		}) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });

		const res = await client.getLegacyContent();
		expect(capturedMethod).toBe("GET");
		expect(capturedUrl).toBe("https://app.jolli.ai/api/mb-sync/legacy-content");
		expect(capturedBody).toBeUndefined();
		expect(res.alreadyMigrated).toBe(false);
		expect(res.docs).toEqual([]);
	});

	it("returns alreadyMigrated: true + empty docs when space is git-backed", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, {
				spaceId: 42,
				spaceSlug: "personal",
				alreadyMigrated: true,
				docs: [],
			}),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		const res = await client.getLegacyContent();
		expect(res.alreadyMigrated).toBe(true);
		expect(res.docs).toHaveLength(0);
	});

	it("returns the docs array with all schema fields preserved", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, {
				spaceId: 42,
				spaceSlug: "personal",
				alreadyMigrated: false,
				docs: [
					{
						id: 1,
						jrn: "doc:abc",
						slug: "hello",
						path: "/notes",
						docType: "document",
						parentId: null,
						content: "# hi",
						contentType: "text/markdown",
						sortOrder: 0,
						createdAt: "2026-05-01T00:00:00Z",
						updatedAt: "2026-05-01T00:00:00Z",
					},
				],
			}),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		const res = await client.getLegacyContent();
		expect(res.docs).toHaveLength(1);
		expect(res.docs[0]).toMatchObject({
			id: 1,
			slug: "hello",
			contentType: "text/markdown",
		});
	});

	it("does not send Content-Type on GET requests", async () => {
		let capturedHeaders: Headers | undefined;
		const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			capturedHeaders = new Headers(init?.headers);
			return jsonResponse(200, {
				spaceId: 1,
				spaceSlug: "personal",
				alreadyMigrated: true,
				docs: [],
			});
		}) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await client.getLegacyContent();
		expect(capturedHeaders?.get("Content-Type")).toBeNull();
		// Authorization is still required.
		expect(capturedHeaders?.get("Authorization")).toMatch(/^Bearer sk-jol-/);
	});
});

describe("BackendClient.completeMigration", () => {
	it("POSTs { commitSha, lockOwnerToken } to /api/mb-sync/complete-migration", async () => {
		let capturedUrl: string | undefined;
		let capturedMethod: string | undefined;
		let capturedBody: string | undefined;
		const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
			capturedUrl = String(url);
			capturedMethod = init?.method;
			capturedBody = init?.body as string;
			return jsonResponse(200, { spaceId: 1, alreadyMigrated: false });
		}) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });

		const res = await client.completeMigration({
			commitSha: "abcdef1234567",
			lockOwnerToken: "test-lock-owner-token",
		});
		expect(capturedUrl).toBe("https://app.jolli.ai/api/mb-sync/complete-migration");
		expect(capturedMethod).toBe("POST");
		expect(JSON.parse(capturedBody ?? "")).toEqual({
			commitSha: "abcdef1234567",
			lockOwnerToken: "test-lock-owner-token",
		});
		expect(res.alreadyMigrated).toBe(false);
	});

	it("returns alreadyMigrated: true when backend says the flip already happened", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(200, { spaceId: 1, alreadyMigrated: true }),
		) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		const res = await client.completeMigration({
			commitSha: "abcdef1234567",
			lockOwnerToken: "test-lock-owner-token",
		});
		expect(res.alreadyMigrated).toBe(true);
	});

	it("surfaces 5xx as SyncBackendError so the engine can retry next round", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "flip_failed" })) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl });
		await expect(
			client.completeMigration({ commitSha: "abcdef1234567", lockOwnerToken: "test-lock-owner-token" }),
		).rejects.toMatchObject({ status: 503 });
	});
});

describe("BackendClient timeout", () => {
	it("aborts via AbortController and wraps as SyncBackendNetworkError", async () => {
		const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit): Promise<Response> => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				});
			});
		}) as unknown as typeof fetch;
		const client = makeClient({ fetchImpl, timeoutMs: 30 });
		await expect(client.mintGitCredentials()).rejects.toBeInstanceOf(SyncBackendNetworkError);
	});
});
