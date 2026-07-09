import { describe, expect, it, vi } from "vitest";
import { runWithTrace } from "./TraceContext.js";

// The default apiKeyProvider reads `jolliApiKey` from SessionTracker.loadConfig;
// mock it so the "no apiKeyProvider" path is deterministic and doesn't touch disk.
const loadConfigMock = vi.fn(async () => ({ jolliApiKey: "sk-jol-cfg" }) as { jolliApiKey?: string });
vi.mock("./SessionTracker.js", () => ({ loadConfig: () => loadConfigMock() }));

import {
	BindingAlreadyExistsError,
	BindingRequiredError,
	ClientOutdatedError,
	JolliMemoryPushClient,
	NotAuthenticatedError,
} from "./JolliMemoryPushClient.js";

const KEY = "sk-jol-test"; // parseJolliApiKey may return null for a plain key → baseUrlOverride supplies the URL
function client(fetchImpl: typeof fetch) {
	return new JolliMemoryPushClient({
		fetchImpl,
		baseUrlOverride: "https://jolli.ai",
		apiKeyProvider: async () => KEY,
	});
}
function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
/** A response with a non-JSON body — e.g. a gateway HTML error page or a plain-text status line. */
function textResponse(status: number, body: string): Response {
	return new Response(body, { status, headers: { "content-type": "text/html" } });
}

describe("listSpaces", () => {
	it("returns spaces + defaultSpaceId", async () => {
		const c = client(async () =>
			jsonResponse(200, { defaultSpaceId: 7, spaces: [{ id: 7, name: "Eng", slug: "eng" }] }),
		);
		const r = await c.listSpaces();
		expect(r.defaultSpaceId).toBe(7);
		expect(r.spaces[0]).toEqual({ id: 7, name: "Eng", slug: "eng" });
	});
	it("throws NotAuthenticatedError when no api key", async () => {
		const c = new JolliMemoryPushClient({
			fetchImpl: async () => jsonResponse(200, {}),
			apiKeyProvider: async () => undefined,
		});
		await expect(c.listSpaces()).rejects.toBeInstanceOf(NotAuthenticatedError);
	});
	it("throws NotAuthenticatedError when a key is present but no base URL can be resolved", async () => {
		// `sk-jol-plain` has no dot → parseJolliApiKey returns null → keyMeta.u is undefined,
		// and with no baseUrlOverride there is nothing to resolve.
		const c = new JolliMemoryPushClient({
			fetchImpl: async () => jsonResponse(200, {}),
			apiKeyProvider: async () => "sk-jol-plain",
		});
		await expect(c.listSpaces()).rejects.toBeInstanceOf(NotAuthenticatedError);
	});
	it("maps 426 to ClientOutdatedError", async () => {
		const c = client(async () => jsonResponse(426, { error: "client_outdated" }));
		await expect(c.listSpaces()).rejects.toBeInstanceOf(ClientOutdatedError);
	});
	it("throws a plain Error on a generic non-2xx", async () => {
		const c = client(async () => jsonResponse(500, { error: "boom" }));
		await expect(c.listSpaces()).rejects.toThrow("boom");
	});
	it("prefers the `message` field over `error` in ClientOutdatedError", async () => {
		const c = client(async () => jsonResponse(426, { message: "please upgrade", error: "client_outdated" }));
		await expect(c.listSpaces()).rejects.toThrow("please upgrade");
	});
	it("falls back to `HTTP <status>` when the error body is not an object", async () => {
		const c = client(async () => jsonResponse(500, "just a string"));
		await expect(c.listSpaces()).rejects.toThrow("HTTP 500");
	});
	it("defaults spaces to [] and defaultSpaceId to null on an empty 200 body", async () => {
		const c = client(async () => jsonResponse(200, {}));
		const r = await c.listSpaces();
		expect(r.spaces).toEqual([]);
		expect(r.defaultSpaceId).toBeNull();
	});
	it("still maps 426 to ClientOutdatedError when the body is non-JSON (proxy/gateway page)", async () => {
		// A non-JSON body must not throw a SyntaxError that bypasses the
		// status-based error taxonomy — the 426 has to still surface as outdated.
		const c = client(async () => textResponse(426, "<html>426 Upgrade Required</html>"));
		await expect(c.listSpaces()).rejects.toBeInstanceOf(ClientOutdatedError);
	});
	it("falls back to `HTTP <status>` on a non-JSON 5xx body", async () => {
		const c = client(async () => textResponse(502, "<html>502 Bad Gateway</html>"));
		await expect(c.listSpaces()).rejects.toThrow("HTTP 502");
	});
	it("throws on a 2xx response with a non-JSON body instead of reporting an empty list", async () => {
		// A proxy 200 HTML page must not masquerade as "no Spaces available".
		const c = client(async () => textResponse(200, "<html>200 OK</html>"));
		await expect(c.listSpaces()).rejects.toThrow(/Malformed/);
	});
});

describe("createBinding", () => {
	it("parses the real {binding, repoFolder} shape", async () => {
		const c = client(async () =>
			jsonResponse(201, {
				binding: { id: 3, jmSpaceId: 7, repoName: "repo" },
				repoFolder: { id: 9, jrn: "jrn:..." },
			}),
		);
		const r = await c.createBinding({ repoUrl: "https://github.com/o/r", repoName: "repo", jmSpaceId: 7 });
		expect(r).toEqual({ bindingId: 3, jmSpaceId: 7, repoName: "repo" });
	});
	it("maps 409 to BindingAlreadyExistsError", async () => {
		const c = client(async () => jsonResponse(409, { error: "binding_already_exists" }));
		await expect(c.createBinding({ repoUrl: "u", repoName: "r", jmSpaceId: 7 })).rejects.toBeInstanceOf(
			BindingAlreadyExistsError,
		);
	});
	it("carries the existing binding's jmSpaceId on the 409 error", async () => {
		// The server returns `{ error, binding: existing }` on 409 — the existing
		// space id must reach the caller so it can detect a wrong-space bind.
		const c = client(async () =>
			jsonResponse(409, { error: "binding_already_exists", binding: { id: 1, jmSpaceId: 5, repoName: "r" } }),
		);
		await expect(c.createBinding({ repoUrl: "u", repoName: "r", jmSpaceId: 7 })).rejects.toMatchObject({
			existingSpaceId: 5,
		});
	});
	it("leaves existingSpaceId undefined on a 409 with no observable winner", async () => {
		const c = client(async () => jsonResponse(409, { error: "binding_already_exists" }));
		await expect(c.createBinding({ repoUrl: "u", repoName: "r", jmSpaceId: 7 })).rejects.toMatchObject({
			existingSpaceId: undefined,
		});
	});
	it("maps 426 to ClientOutdatedError", async () => {
		const c = client(async () => jsonResponse(426, { error: "client_outdated" }));
		await expect(c.createBinding({ repoUrl: "u", repoName: "r", jmSpaceId: 7 })).rejects.toBeInstanceOf(
			ClientOutdatedError,
		);
	});
	it("throws a plain Error on a generic non-2xx", async () => {
		const c = client(async () => jsonResponse(500, { error: "boom" }));
		await expect(c.createBinding({ repoUrl: "u", repoName: "r", jmSpaceId: 7 })).rejects.toThrow("boom");
	});
	it("throws a plain Error on a malformed 2xx with no binding field", async () => {
		const c = client(async () => jsonResponse(201, { repoFolder: { id: 9 } }));
		await expect(c.createBinding({ repoUrl: "u", repoName: "r", jmSpaceId: 7 })).rejects.toThrow("HTTP 201");
	});
});

describe("header plumbing", () => {
	it("sends Bearer auth, x-jolli-client, x-org-slug, and resolves base URL from keyMeta.u", async () => {
		// Realistic key: meta segment base64url-decodes to JSON {t,u,o}; secret segment after the dot.
		const meta = Buffer.from(JSON.stringify({ t: "tenant", u: "https://jolli.ai", o: "myorg" })).toString(
			"base64url",
		);
		const key = `sk-jol-${meta}.secret`;
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> = {};
		const c = new JolliMemoryPushClient({
			apiKeyProvider: async () => key,
			fetchImpl: async (url, init) => {
				capturedUrl = String(url);
				capturedHeaders = init?.headers as Record<string, string>;
				return jsonResponse(200, { defaultSpaceId: null, spaces: [] });
			},
		});
		await c.listSpaces();
		expect(capturedUrl).toBe("https://jolli.ai/api/jolli-memory/spaces");
		expect(capturedHeaders.Authorization).toBe(`Bearer ${key}`);
		expect(capturedHeaders["x-jolli-client"]).toBeTruthy();
		expect(capturedHeaders["x-org-slug"]).toBe("myorg");
		// GET has no body → no Content-Type header.
		expect(capturedHeaders["Content-Type"]).toBeUndefined();
	});
	it("sends x-tenant-slug from the base URL path and Content-Type on a POST body", async () => {
		let capturedHeaders: Record<string, string> = {};
		const c = new JolliMemoryPushClient({
			apiKeyProvider: async () => "sk-jol-test",
			baseUrlOverride: "https://jolli-local.me/test1",
			fetchImpl: async (_url, init) => {
				capturedHeaders = init?.headers as Record<string, string>;
				return jsonResponse(201, { binding: { id: 1, jmSpaceId: 2, repoName: "r" } });
			},
		});
		await c.createBinding({ repoUrl: "u", repoName: "r", jmSpaceId: 2 });
		expect(capturedHeaders["x-tenant-slug"]).toBe("test1");
		expect(capturedHeaders["Content-Type"]).toBe("application/json");
	});
	it("uses the ambient trace id when inside a trace scope", async () => {
		let capturedHeaders: Record<string, string> = {};
		const c = client(async (_url, init) => {
			capturedHeaders = (init as RequestInit).headers as Record<string, string>;
			return jsonResponse(200, { defaultSpaceId: null, spaces: [] });
		});
		await runWithTrace("a".repeat(32), () => c.listSpaces());
		// x-jolli-trace value is `<traceId>-<spanId>` — starts with the adopted trace id.
		expect(capturedHeaders["x-jolli-trace"]).toMatch(/^a{32}-/);
	});
});

describe("BindingRequiredError", () => {
	it("carries repoUrl and defaults its message", () => {
		const e = new BindingRequiredError("https://github.com/o/r");
		expect(e).toBeInstanceOf(Error);
		expect(e.repoUrl).toBe("https://github.com/o/r");
		expect(e.message).toBe("binding_required");
		expect(e.name).toBe("BindingRequiredError");
	});
	it("accepts a custom message", () => {
		const e = new BindingRequiredError("u", "no binding yet");
		expect(e.message).toBe("no binding yet");
	});
});

describe("error classes default their messages", () => {
	it("NotAuthenticatedError / ClientOutdatedError / BindingAlreadyExistsError have sensible defaults + names", () => {
		expect(new NotAuthenticatedError().message).toBe("Not signed in to Jolli.");
		expect(new NotAuthenticatedError().name).toBe("NotAuthenticatedError");
		expect(new ClientOutdatedError().message).toBe("Client outdated — update the CLI/extension.");
		expect(new ClientOutdatedError().name).toBe("ClientOutdatedError");
		expect(new BindingAlreadyExistsError().message).toBe("binding_already_exists");
		expect(new BindingAlreadyExistsError().name).toBe("BindingAlreadyExistsError");
	});
});

describe("push", () => {
	it("returns the push result on 201", async () => {
		const c = client(async () => jsonResponse(201, { url: "/articles/x", docId: 42, jrn: "jrn", created: true }));
		const r = await c.push({
			title: "t",
			content: "c",
			commitHash: "abc1234",
			docType: "summary",
			repoUrl: "https://github.com/o/r",
			relativePath: "main",
		});
		expect(r.docId).toBe(42);
		expect(r.created).toBe(true);
	});
	it("maps 412 binding_required to BindingRequiredError carrying repoUrl", async () => {
		const c = client(async () =>
			jsonResponse(412, { error: "binding_required", repoUrl: "https://github.com/o/r" }),
		);
		await expect(
			c.push({
				title: "t",
				content: "c",
				commitHash: "abc1234",
				docType: "summary",
				repoUrl: "https://github.com/o/r",
			}),
		).rejects.toMatchObject({ name: "BindingRequiredError", repoUrl: "https://github.com/o/r" });
	});
	it("falls back to payload.repoUrl when the 412 body has none", async () => {
		const c = client(async () => jsonResponse(412, { error: "binding_required" }));
		await expect(
			c.push({
				title: "t",
				content: "c",
				commitHash: "abc1234",
				docType: "summary",
				repoUrl: "https://github.com/o/fallback",
			}),
		).rejects.toMatchObject({ repoUrl: "https://github.com/o/fallback" });
	});
	it("falls back to an empty string when neither the body nor the payload has a repoUrl", async () => {
		const c = client(async () => jsonResponse(412, { error: "binding_required" }));
		await expect(
			c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary" }),
		).rejects.toMatchObject({ repoUrl: "" });
	});
	it("maps 426 to ClientOutdatedError", async () => {
		const c = client(async () => jsonResponse(426, { error: "client_outdated" }));
		await expect(
			c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary" }),
		).rejects.toBeInstanceOf(ClientOutdatedError);
	});
	it("maps 409 binding_already_exists to BindingAlreadyExistsError", async () => {
		const c = client(async () => jsonResponse(409, { error: "binding_already_exists" }));
		await expect(
			c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary" }),
		).rejects.toBeInstanceOf(BindingAlreadyExistsError);
	});
	it("throws a plain Error on a generic non-2xx", async () => {
		const c = client(async () => jsonResponse(500, { error: "boom" }));
		await expect(c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary" })).rejects.toThrow(
			"boom",
		);
	});
	it("falls back to `HTTP <status>` when the non-2xx body has no error field", async () => {
		const c = client(async () => jsonResponse(500, {}));
		await expect(c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary" })).rejects.toThrow(
			"HTTP 500",
		);
	});
	it("surfaces the server `message` on a generic non-2xx, not just `error`", async () => {
		// Parity with listSpaces/createBinding, which read `message ?? error`. The
		// server can put the human-readable reason in `message`; push must not drop it.
		const c = client(async () => jsonResponse(500, { message: "space is archived" }));
		await expect(c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary" })).rejects.toThrow(
			"space is archived",
		);
	});
	it("throws on a 2xx response missing docId (empty JSON body)", async () => {
		// A 2xx with no docId would otherwise yield docId:undefined → `doc=undefined`
		// links and a re-CREATE (not UPDATE) on the next push. Fail loudly instead.
		const c = client(async () => jsonResponse(200, {}));
		await expect(c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary" })).rejects.toThrow(
			/docId/i,
		);
	});
	it("throws on a 2xx response with a non-JSON body (proxy 200 page)", async () => {
		// call() falls the body back to {} for non-JSON — on a 2xx that would slip
		// through as an undefined docId. The push must reject.
		const c = client(async () => textResponse(200, "<html>OK</html>"));
		await expect(c.push({ title: "t", content: "c", commitHash: "abc1234", docType: "summary" })).rejects.toThrow(
			/docId/i,
		);
	});
});

describe("deleteDoc", () => {
	it("resolves on a 200 response", async () => {
		const c = client(async () => jsonResponse(200, {}));
		await expect(c.deleteDoc(42)).resolves.toBeUndefined();
	});
	it("throws on a non-2xx response", async () => {
		const c = client(async () => jsonResponse(500, {}));
		await expect(c.deleteDoc(42)).rejects.toThrow("delete failed: HTTP 500");
	});
});

describe("resolveBaseUrl", () => {
	it("returns the resolved base URL (baseUrlOverride wins over the key's embedded URL)", async () => {
		const c = client(async () => jsonResponse(200, {}));
		await expect(c.resolveBaseUrl()).resolves.toBe("https://jolli.ai");
	});
	it("throws NotAuthenticatedError when no api key is configured", async () => {
		const c = new JolliMemoryPushClient({
			fetchImpl: async () => jsonResponse(200, {}),
			apiKeyProvider: async () => undefined,
		});
		await expect(c.resolveBaseUrl()).rejects.toBeInstanceOf(NotAuthenticatedError);
	});
});

describe("resolveEnvKey", () => {
	it("derives an env key from the resolved base URL + api key (no network)", async () => {
		const c = client(async () => jsonResponse(200, {}));
		await expect(c.resolveEnvKey()).resolves.toBe("https://jolli.ai");
	});
	it("throws NotAuthenticatedError when no api key is configured", async () => {
		const c = new JolliMemoryPushClient({
			fetchImpl: async () => jsonResponse(200, {}),
			apiKeyProvider: async () => undefined,
		});
		await expect(c.resolveEnvKey()).rejects.toBeInstanceOf(NotAuthenticatedError);
	});
});

describe("constructor defaults", () => {
	it("falls back to the SessionTracker config loader when no apiKeyProvider is given", async () => {
		let capturedHeaders: Record<string, string> = {};
		const c = new JolliMemoryPushClient({
			baseUrlOverride: "https://jolli.ai",
			fetchImpl: async (_url, init) => {
				capturedHeaders = init?.headers as Record<string, string>;
				return jsonResponse(200, { defaultSpaceId: null, spaces: [] });
			},
		});
		await c.listSpaces();
		expect(loadConfigMock).toHaveBeenCalled();
		expect(capturedHeaders.Authorization).toBe("Bearer sk-jol-cfg");
	});
	it("constructs with no opts at all (global fetch + default provider + timeout)", () => {
		expect(() => new JolliMemoryPushClient()).not.toThrow();
	});
	it("fires the abort timer when the request outlives timeoutMs", async () => {
		let aborted = false;
		const c = new JolliMemoryPushClient({
			apiKeyProvider: async () => "sk-jol-test",
			baseUrlOverride: "https://jolli.ai",
			timeoutMs: 1,
			fetchImpl: async (_url, init) => {
				// Outlive the 1 ms timeout so the abort timer fires; our stub ignores the signal.
				(init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
					aborted = true;
				});
				await new Promise((r) => setTimeout(r, 20));
				return jsonResponse(200, { defaultSpaceId: null, spaces: [] });
			},
		});
		await c.listSpaces();
		expect(aborted).toBe(true);
	});
	it("treats an empty response body as {}", async () => {
		const c = client(
			async () => new Response(null, { status: 200, headers: { "content-type": "application/json" } }),
		);
		const r = await c.listSpaces();
		expect(r).toEqual({ spaces: [], defaultSpaceId: null });
	});
});
