import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exchangeCliCode } from "./CliExchange.js";

describe("exchangeCliCode", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function jsonResponse(status: number, body: unknown): Response {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: vi.fn().mockResolvedValue(body),
		} as unknown as Response;
	}

	it("posts the code to /api/auth/cli-exchange and returns the credentials", async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonResponse(200, { token: "tk-abc", jolliApiKey: "sk-jol-xyz", space: "personal" }),
		);

		const result = await exchangeCliCode("https://app.jolli.ai", "code-123");

		expect(result).toEqual({ token: "tk-abc", jolliApiKey: "sk-jol-xyz", space: "personal" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(String(url)).toBe("https://app.jolli.ai/api/auth/cli-exchange");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "content-type": "application/json" });
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(init.body as string)).toEqual({ code: "code-123" });
	});

	it("strips the tenant path and sends x-tenant-slug for path-based tenant URLs", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse(200, { token: "tk-abc" }));

		await exchangeCliCode("https://jolli-local.me/dev", "code-123");

		const [url, init] = fetchSpy.mock.calls[0];
		expect(String(url)).toBe("https://jolli-local.me/api/auth/cli-exchange");
		expect(init.headers).toEqual({
			"content-type": "application/json",
			"x-tenant-slug": "dev",
		});
	});

	it("omits x-tenant-slug for origin-only URLs", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse(200, { token: "tk-abc" }));

		await exchangeCliCode("https://app.jolli.ai", "code-123");

		const [, init] = fetchSpy.mock.calls[0];
		expect(init.headers).not.toHaveProperty("x-tenant-slug");
	});

	it("surfaces a clear timeout message when fetch is aborted by AbortSignal.timeout", async () => {
		const timeoutErr = new DOMException("The operation was aborted due to timeout", "TimeoutError");
		fetchSpy.mockRejectedValueOnce(timeoutErr);

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(/timed out after \d+s/);
	});

	it("returns only the token when the response omits jolliApiKey and space", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse(200, { token: "tk-only" }));

		const result = await exchangeCliCode("https://app.jolli.ai", "code-1");

		expect(result).toEqual({ token: "tk-only" });
		expect(result.jolliApiKey).toBeUndefined();
		expect(result.space).toBeUndefined();
	});

	it("rejects an off-allowlist jolliUrl before issuing the request", async () => {
		await expect(exchangeCliCode("https://evil.example.com", "code-1")).rejects.toThrow(/evil\.example\.com/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("wraps a network failure in a friendly message", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:443"));

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(
			/Couldn't reach Jolli to complete sign-in.*ECONNREFUSED/,
		);
	});

	it("stringifies non-Error throws from fetch", async () => {
		fetchSpy.mockRejectedValueOnce("bare-string-rejection");

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(/bare-string-rejection/);
	});

	it("returns a clear message for an expired/consumed code (404)", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse(404, { error: "invalid_or_expired_code" }));

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(
			/Sign-in code expired or already used/,
		);
	});

	it("returns a generic HTTP message for other non-OK statuses", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse(500, { error: "server_error" }));

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(/HTTP 500/);
	});

	it("rejects when the server response is not valid JSON", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
		} as unknown as Response);

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(
			/malformed response.*Unexpected token/,
		);
	});

	it("stringifies non-Error throws from json()", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: vi.fn().mockRejectedValue("not-an-error-instance"),
		} as unknown as Response);

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(/not-an-error-instance/);
	});

	it("rejects when the server response omits the token", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse(200, { jolliApiKey: "sk-jol-xyz" }));

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(
			/server response did not include a token/,
		);
	});

	it("rejects when the server response token is empty", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse(200, { token: "" }));

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(
			/server response did not include a token/,
		);
	});

	it("rejects when the server response token is not a string", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse(200, { token: 123 }));

		await expect(exchangeCliCode("https://app.jolli.ai", "code-1")).rejects.toThrow(
			/server response did not include a token/,
		);
	});

	it("ignores non-string jolliApiKey and space fields", async () => {
		fetchSpy.mockResolvedValueOnce(jsonResponse(200, { token: "tk-abc", jolliApiKey: null, space: 42 }));

		const result = await exchangeCliCode("https://app.jolli.ai", "code-1");

		expect(result).toEqual({ token: "tk-abc" });
	});
});
