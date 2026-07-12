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
	type PlatformToolManifestEntry,
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

describe("frontDoor", () => {
	const args = { repoUrl: "https://github.com/o/r", repoName: "r" };

	it("POSTs the repo identity to /api/jolli-memory/front-door", async () => {
		let capturedUrl: string | undefined;
		let capturedInit: RequestInit | undefined;
		const c = client(async (url, init) => {
			capturedUrl = String(url);
			capturedInit = init;
			return jsonResponse(200, { status: "no_spaces" });
		});
		await c.frontDoor(args);
		expect(capturedUrl).toBe("https://jolli.ai/api/jolli-memory/front-door");
		expect(capturedInit?.method).toBe("POST");
		expect(JSON.parse(String(capturedInit?.body))).toEqual(args);
	});
	it("returns bound with the space name", async () => {
		const c = client(async () =>
			jsonResponse(200, { status: "bound", binding: { jmSpaceId: 7, spaceName: "Eng" } }),
		);
		await expect(c.frontDoor(args)).resolves.toEqual({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: "Eng" },
		});
	});
	it("coalesces missing bound Space details to null", async () => {
		const c = client(async () => jsonResponse(200, { status: "bound", binding: {} }));
		await expect(c.frontDoor(args)).resolves.toEqual({
			status: "bound",
			binding: { jmSpaceId: null, spaceName: null },
		});
	});
	it("accepts explicit null Space details on a bound response", async () => {
		const c = client(async () =>
			jsonResponse(200, { status: "bound", binding: { jmSpaceId: null, spaceName: null } }),
		);
		await expect(c.frontDoor(args)).resolves.toEqual({
			status: "bound",
			binding: { jmSpaceId: null, spaceName: null },
		});
	});
	it("coalesces a missing spaceName to null when the Space id is visible", async () => {
		const c = client(async () => jsonResponse(200, { status: "bound", binding: { jmSpaceId: 7 } }));
		await expect(c.frontDoor(args)).resolves.toEqual({
			status: "bound",
			binding: { jmSpaceId: 7, spaceName: null },
		});
	});
	it("returns unbound with the space list and defaultSpaceId", async () => {
		const c = client(async () =>
			jsonResponse(200, {
				status: "unbound",
				spaces: [{ id: 1, name: "Eng", slug: "eng" }],
				defaultSpaceId: 1,
			}),
		);
		await expect(c.frontDoor(args)).resolves.toEqual({
			status: "unbound",
			spaces: [{ id: 1, name: "Eng", slug: "eng" }],
			defaultSpaceId: 1,
		});
	});
	it("defaults spaces to [] and defaultSpaceId to null on a sparse unbound body", async () => {
		const c = client(async () => jsonResponse(200, { status: "unbound" }));
		await expect(c.frontDoor(args)).resolves.toEqual({ status: "unbound", spaces: [], defaultSpaceId: null });
	});
	it("returns no_spaces", async () => {
		const c = client(async () => jsonResponse(200, { status: "no_spaces" }));
		await expect(c.frontDoor(args)).resolves.toEqual({ status: "no_spaces" });
	});
	it("maps 426 to ClientOutdatedError", async () => {
		const c = client(async () => jsonResponse(426, { error: "client_outdated" }));
		await expect(c.frontDoor(args)).rejects.toBeInstanceOf(ClientOutdatedError);
	});
	it("maps 401/403 to NotAuthenticatedError", async () => {
		const c401 = client(async () => jsonResponse(401, { error: "unauthorized" }));
		await expect(c401.frontDoor(args)).rejects.toBeInstanceOf(NotAuthenticatedError);
		const c403 = client(async () => jsonResponse(403, { error: "forbidden" }));
		await expect(c403.frontDoor(args)).rejects.toBeInstanceOf(NotAuthenticatedError);
	});
	it("throws a plain Error on a generic non-2xx", async () => {
		const c = client(async () => jsonResponse(500, { error: "boom" }));
		await expect(c.frontDoor(args)).rejects.toThrow("boom");
	});
	it("throws on a 2xx response with a non-JSON body instead of misreading the repo state", async () => {
		const c = client(async () => textResponse(200, "<html>200 OK</html>"));
		await expect(c.frontDoor(args)).rejects.toThrow(/Malformed/);
	});
	it("throws on a 2xx body with an unrecognized status", async () => {
		const c = client(async () => jsonResponse(200, { status: "??" }));
		await expect(c.frontDoor(args)).rejects.toThrow(/Unexpected front-door response shape/);
	});
	it("throws on a bound body whose binding object is missing", async () => {
		const c = client(async () => jsonResponse(200, { status: "bound" }));
		await expect(c.frontDoor(args)).rejects.toThrow(/Unexpected front-door response shape/);
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

const TOOL_A = {
	name: "create_ticket",
	description: "Create a ticket",
	inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
};
const TOOL_B = {
	name: "list_projects",
	description: "List projects",
	inputSchema: { type: "object", properties: {} },
};

describe("fetchManifest", () => {
	it("returns the validated tools from a { tools: [...] } envelope", async () => {
		const c = client(async () => jsonResponse(200, { tools: [TOOL_A, TOOL_B] }));
		const tools = await c.fetchManifest();
		expect(tools.map((t) => t.name)).toEqual(["create_ticket", "list_projects"]);
	});

	it("accepts a bare top-level array manifest", async () => {
		const c = client(async () => jsonResponse(200, [TOOL_A]));
		const tools = await c.fetchManifest();
		expect(tools.map((t) => t.name)).toEqual(["create_ticket"]);
	});

	it("returns [] on an empty manifest ({} or { tools: [] })", async () => {
		expect(await client(async () => jsonResponse(200, {})).fetchManifest()).toEqual([]);
		expect(await client(async () => jsonResponse(200, { tools: [] })).fetchManifest()).toEqual([]);
	});

	it("returns [] on 404 (surface disabled) without throwing", async () => {
		const c = client(async () => jsonResponse(404, { error: "not_found" }));
		await expect(c.fetchManifest()).resolves.toEqual([]);
	});

	it("returns [] on 403 (key lacks the invoke scope) without throwing", async () => {
		const c = client(async () => jsonResponse(403, { error: "forbidden" }));
		await expect(c.fetchManifest()).resolves.toEqual([]);
	});

	it("returns [] on a generic non-2xx without throwing", async () => {
		const c = client(async () => jsonResponse(500, { error: "boom" }));
		await expect(c.fetchManifest()).resolves.toEqual([]);
	});

	it("returns [] on a non-JSON 200 body (parse failure)", async () => {
		const c = client(async () => textResponse(200, "<html>200 OK</html>"));
		await expect(c.fetchManifest()).resolves.toEqual([]);
	});

	it("returns [] when the fetch rejects (network error / abort)", async () => {
		const c = client(async () => {
			throw new Error("network down");
		});
		await expect(c.fetchManifest()).resolves.toEqual([]);
	});

	it("returns [] (not a throw) when no api key is configured", async () => {
		const c = new JolliMemoryPushClient({
			fetchImpl: async () => jsonResponse(200, { tools: [TOOL_A] }),
			apiKeyProvider: async () => undefined,
		});
		await expect(c.fetchManifest()).resolves.toEqual([]);
	});

	it("drops malformed entries but keeps the valid ones", async () => {
		const c = client(async () =>
			jsonResponse(200, {
				tools: [
					TOOL_A,
					{ name: "", description: "empty name", inputSchema: { type: "object", properties: {} } },
					{ name: "bad_desc", description: 123, inputSchema: { type: "object", properties: {} } },
					{ description: "no name", inputSchema: { type: "object", properties: {} } },
					{ name: "no_schema", description: "missing schema" },
					{ name: "bad_schema", description: "wrong type", inputSchema: { type: "array", properties: {} } },
					{
						name: "arr_props",
						description: "properties is an array",
						inputSchema: { type: "object", properties: [] },
					},
					{
						name: "bad_required",
						description: "required is not an array",
						inputSchema: { type: "object", properties: {}, required: "title" },
					},
					{
						name: "bad_required_elems",
						description: "required has non-string members",
						inputSchema: { type: "object", properties: {}, required: [123] },
					},
					"not-an-object",
					TOOL_B,
				],
			}),
		);
		const tools = await c.fetchManifest();
		expect(tools.map((t) => t.name)).toEqual(["create_ticket", "list_projects"]);
	});

	it("accepts a zero-arg tool with no `properties` and defaults it to {}", async () => {
		// MCP treats `{ type: "object" }` (no properties) as a valid no-arg schema;
		// the validator must keep it and normalize the advertised schema.
		const c = client(async () =>
			jsonResponse(200, {
				tools: [{ name: "ping", description: "no-arg tool", inputSchema: { type: "object" } }],
			}),
		);
		const [tool] = await c.fetchManifest();
		expect(tool.name).toBe("ping");
		expect(tool.inputSchema).toEqual({ type: "object", properties: {} });
	});

	it("preserves extra JSON-Schema keywords on inputSchema", async () => {
		const c = client(async () =>
			jsonResponse(200, {
				tools: [
					{
						name: "t",
						description: "d",
						inputSchema: {
							type: "object",
							properties: { x: { type: "string" } },
							required: ["x"],
							additionalProperties: false,
						},
					},
				],
			}),
		);
		const [tool] = await c.fetchManifest();
		expect(tool.inputSchema).toMatchObject({
			type: "object",
			properties: { x: { type: "string" } },
			required: ["x"],
			additionalProperties: false,
		});
	});

	it("preserves a valid binding on a fetched entry", async () => {
		const withBinding = {
			name: "list_workflow_definitions",
			description: "List workflow definitions",
			inputSchema: { type: "object", properties: {} },
			binding: { method: "POST", path: "/api/mcp/tools/list_workflow_definitions" },
		};
		const c = client(async () => jsonResponse(200, { tools: [withBinding] }));
		const [tool] = await c.fetchManifest();
		expect(tool.binding).toEqual({ method: "POST", path: "/api/mcp/tools/list_workflow_definitions" });
	});

	it("drops a malformed binding WITHOUT dropping the tool (like menu)", async () => {
		// `binding` is internal routing metadata, never advertised, so a bad one can
		// never poison tools/list — drop only the binding and keep the tool callable
		// (the generic executor then falls back to POST /api/mcp/tools/<name>).
		const c = client(async () =>
			jsonResponse(200, {
				tools: [
					{
						name: "not_object",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						binding: "nope",
					},
					{
						name: "arr_binding",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						binding: [],
					},
					{
						name: "no_path",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						binding: { method: "POST" },
					},
					{
						name: "no_method",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						binding: { path: "/api/mcp/tools/x" },
					},
					{
						name: "non_string_method",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						binding: { method: 1, path: "/api/mcp/tools/x" },
					},
				],
			}),
		);
		const tools = await c.fetchManifest();
		expect(tools.map((t) => t.name)).toEqual([
			"not_object",
			"arr_binding",
			"no_path",
			"no_method",
			"non_string_method",
		]);
		expect(tools.every((t) => t.binding === undefined)).toBe(true);
	});

	it("preserves a valid menu block on a fetched entry", async () => {
		const withMenu = {
			name: "create_ticket",
			description: "Create a ticket",
			inputSchema: { type: "object", properties: {} },
			menu: { label: "Create ticket", description: "Open a new ticket", order: 2 },
		};
		const c = client(async () => jsonResponse(200, { tools: [withMenu] }));
		const [tool] = await c.fetchManifest();
		expect(tool.menu).toEqual({ label: "Create ticket", description: "Open a new ticket", order: 2 });
	});

	it("keeps only the label when a menu block omits description/order", async () => {
		const c = client(async () =>
			jsonResponse(200, {
				tools: [
					{
						name: "t",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						menu: { label: "Just a label" },
					},
				],
			}),
		);
		const [tool] = await c.fetchManifest();
		expect(tool.menu).toEqual({ label: "Just a label" });
	});

	it("drops a malformed menu block WITHOUT dropping the tool (like binding)", async () => {
		// Each of these entries has a bad menu but must remain a usable tool with no
		// menu — a partially-rolled-out backend must never lose a working tool.
		const c = client(async () =>
			jsonResponse(200, {
				tools: [
					{
						name: "not_object",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						menu: "nope",
					},
					{ name: "menu_array", description: "d", inputSchema: { type: "object", properties: {} }, menu: [] },
					{
						name: "no_label",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						menu: { description: "no label here" },
					},
					{
						name: "blank_label",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						menu: { label: "   " },
					},
				],
			}),
		);
		const tools = await c.fetchManifest();
		expect(tools.map((t) => t.name)).toEqual(["not_object", "menu_array", "no_label", "blank_label"]);
		expect(tools.every((t) => t.menu === undefined)).toBe(true);
	});

	it("drops only the malformed description/order fields, keeping the label", async () => {
		const c = client(async () =>
			jsonResponse(200, {
				tools: [
					{
						name: "t",
						description: "d",
						inputSchema: { type: "object", properties: {} },
						menu: { label: "Keep me", description: 123, order: "high" },
					},
				],
			}),
		);
		const [tool] = await c.fetchManifest();
		expect(tool.menu).toEqual({ label: "Keep me" });
	});

	it("sends Bearer auth to /api/mcp/manifest", async () => {
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> = {};
		const c = client(async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = init?.headers as Record<string, string>;
			return jsonResponse(200, { tools: [] });
		});
		await c.fetchManifest();
		expect(capturedUrl).toBe("https://jolli.ai/api/mcp/manifest");
		expect(capturedHeaders.Authorization).toBe(`Bearer ${KEY}`);
	});
});

describe("invokePlatformTool", () => {
	function entry(name: string, binding?: { method: string; path: string }): PlatformToolManifestEntry {
		return {
			name,
			description: "d",
			inputSchema: { type: "object", properties: {} },
			...(binding ? { binding } : {}),
		};
	}

	it("returns a 2xx JSON body verbatim", async () => {
		const c = client(async () => jsonResponse(200, { type: "ok", result: 42 }));
		await expect(c.invokePlatformTool(entry("create_ticket"), { title: "x" })).resolves.toEqual({
			type: "ok",
			result: 42,
		});
	});

	it("returns a backend {type:'error'} body as-is (does NOT throw — the server flags it)", async () => {
		const c = client(async () => jsonResponse(200, { type: "error", message: "bad args" }));
		await expect(c.invokePlatformTool(entry("create_ticket"), {})).resolves.toEqual({
			type: "error",
			message: "bad args",
		});
	});

	it("throws on a non-2xx status so the server surfaces it", async () => {
		const c = client(async () => jsonResponse(500, { error: "boom" }));
		await expect(c.invokePlatformTool(entry("create_ticket"), {})).rejects.toThrow("boom");
	});

	it("falls back to `HTTP <status>` when a non-2xx body carries no message", async () => {
		const c = client(async () => jsonResponse(400, {}));
		await expect(c.invokePlatformTool(entry("create_ticket"), {})).rejects.toThrow("HTTP 400");
	});

	it("maps 426 to ClientOutdatedError", async () => {
		const c = client(async () => jsonResponse(426, { error: "client_outdated" }));
		await expect(c.invokePlatformTool(entry("create_ticket"), {})).rejects.toBeInstanceOf(ClientOutdatedError);
	});

	it("throws on a 2xx body that isn't JSON (proxy page)", async () => {
		const c = client(async () => textResponse(200, "<html>OK</html>"));
		await expect(c.invokePlatformTool(entry("create_ticket"), {})).rejects.toThrow(/Malformed/);
	});

	it("falls back to POST /api/mcp/tools/<name> (URL-encoded) with the args as the JSON body when no binding", async () => {
		let capturedUrl: string | undefined;
		let capturedBody: string | undefined;
		let capturedMethod: string | undefined;
		let capturedHeaders: Record<string, string> = {};
		const c = client(async (url, init) => {
			capturedUrl = String(url);
			capturedBody = init?.body as string;
			capturedMethod = init?.method;
			capturedHeaders = init?.headers as Record<string, string>;
			return jsonResponse(200, { ok: true });
		});
		await c.invokePlatformTool(entry("weird/name space"), { a: 1 });
		expect(capturedMethod).toBe("POST");
		expect(capturedUrl).toBe("https://jolli.ai/api/mcp/tools/weird%2Fname%20space");
		expect(capturedBody).toBe(JSON.stringify({ a: 1 }));
		expect(capturedHeaders.Authorization).toBe(`Bearer ${KEY}`);
		expect(capturedHeaders["Content-Type"]).toBe("application/json");
	});

	it("honors the manifest binding's method and path when present", async () => {
		let capturedUrl: string | undefined;
		let capturedMethod: string | undefined;
		const c = client(async (url, init) => {
			capturedUrl = String(url);
			capturedMethod = init?.method;
			return jsonResponse(200, { ok: true });
		});
		await c.invokePlatformTool(
			entry("list_workflow_definitions", { method: "POST", path: "/api/mcp/tools/list_workflow_definitions" }),
			{},
		);
		expect(capturedMethod).toBe("POST");
		expect(capturedUrl).toBe("https://jolli.ai/api/mcp/tools/list_workflow_definitions");
	});

	it("ignores an off-origin binding path (including URL-parser bypass vectors) and falls back", async () => {
		// A manifest must never redirect the bearer token off-origin. A raw string
		// prefix check is not enough: the WHATWG URL parser rewrites `\` to `/` and
		// strips embedded tab/CR/LF, so each of these normalizes to an off-origin
		// host. The guard must compare the RESOLVED origin, not the raw string.
		const vectors = [
			"https://evil.example/steal",
			"//evil.example/steal",
			"/\\evil.example/steal",
			"/\t/evil.example",
			"/\r/evil.example",
			"/\n/evil.example",
		];
		for (const evil of vectors) {
			let capturedUrl: string | undefined;
			const c = client(async (url) => {
				capturedUrl = String(url);
				return jsonResponse(200, { ok: true });
			});
			await c.invokePlatformTool(entry("create_ticket", { method: "POST", path: evil }), {});
			expect(capturedUrl).toBe("https://jolli.ai/api/mcp/tools/create_ticket");
		}
	});

	it("honors a same-origin binding supplied as an absolute URL", async () => {
		let capturedUrl: string | undefined;
		const c = client(async (url) => {
			capturedUrl = String(url);
			return jsonResponse(200, { ok: true });
		});
		await c.invokePlatformTool(
			entry("create_ticket", { method: "POST", path: "https://jolli.ai/api/mcp/tools/custom" }),
			{},
		);
		expect(capturedUrl).toBe("https://jolli.ai/api/mcp/tools/custom");
	});

	it("honors a valid non-POST method case-insensitively on a same-origin binding", async () => {
		let capturedMethod: string | undefined;
		const c = client(async (_url, init) => {
			capturedMethod = init?.method;
			return jsonResponse(200, { ok: true });
		});
		await c.invokePlatformTool(entry("create_ticket", { method: "put", path: "/api/mcp/tools/create_ticket" }), {});
		expect(capturedMethod).toBe("PUT");
	});

	it("falls back to the conventional POST endpoint when the binding method is not a known HTTP method", async () => {
		let capturedUrl: string | undefined;
		let capturedMethod: string | undefined;
		const c = client(async (url, init) => {
			capturedUrl = String(url);
			capturedMethod = init?.method;
			return jsonResponse(200, { ok: true });
		});
		await c.invokePlatformTool(entry("create_ticket", { method: "FETCH", path: "/api/mcp/tools/x" }), {});
		expect(capturedMethod).toBe("POST");
		expect(capturedUrl).toBe("https://jolli.ai/api/mcp/tools/create_ticket");
	});
});
