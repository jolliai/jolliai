import { describe, expect, it, vi } from "vitest";

const mockSaveAuthCredentials = vi.fn();
const mockExchangeCliCode = vi.fn();
const mockLoadConfig = vi.fn(async () => ({}));

vi.mock("./AuthConfig.js", async (importActual) => {
	// `resolveSignInJolliUrl` is a pure helper (no config I/O) that derives the
	// tenant to persist from the minted key — keep the real implementation.
	const actual = await importActual<typeof import("./AuthConfig.js")>();
	return {
		saveAuthCredentials: (...args: unknown[]) => mockSaveAuthCredentials(...args),
		resolveSignInJolliUrl: actual.resolveSignInJolliUrl,
	};
});

vi.mock("./CliExchange.js", () => ({
	exchangeCliCode: (...args: unknown[]) => mockExchangeCliCode(...args),
}));

// `exchangeAndPersist` / `persistLegacyCredentials` read the on-disk config to
// supply an existing-key fallback to `resolveSignInJolliUrl` (so an idempotent-
// replay callback doesn't clear a working key). Mock the read so tests don't
// pick up the developer's real ~/.jolli/jollimemory/config.json — that leaked
// a real subdomain tenant into the "no existing key" tests and made them fail.
//
// Uses `importActual` spread so every OTHER SessionTracker export (e.g.
// `getGlobalConfigDir`, `saveConfig`) keeps its real implementation. Without
// this, adding a new SessionTracker import in AuthCallback.ts or any of its
// transitive dependencies would silently resolve to `undefined` in this test
// file and crash at call time — the failure mode is invisible until it strikes.
vi.mock("../core/SessionTracker.js", async (importActual) => {
	const actual = await importActual<typeof import("../core/SessionTracker.js")>();
	return { ...actual, loadConfig: () => mockLoadConfig() };
});

// JolliApiUtils is deliberately NOT mocked: the origin allowlist is the whole
// point of jolliPageUrl(), whose result becomes an HTTP `Location` header.
import { AUTH_ERROR_MESSAGES, getAuthErrorMessage, jolliPageUrl, resolveAuthCallback } from "./AuthCallback.js";

const STATE = "a".repeat(64);

const params = (query: string) => new URLSearchParams(query);

describe("getAuthErrorMessage", () => {
	it("maps every known code to a sentence", () => {
		for (const [code, message] of Object.entries(AUTH_ERROR_MESSAGES)) {
			expect(getAuthErrorMessage(code)).toBe(message);
		}
	});

	it("falls back to naming an unknown code", () => {
		expect(getAuthErrorMessage("something_weird")).toBe("Authentication error: something_weird");
	});

	it("templates the surface-specific retry hint into user_denied", () => {
		expect(getAuthErrorMessage("user_denied")).toBe("Sign-in was cancelled. You can try again.");
		expect(getAuthErrorMessage("user_denied", "Run `jolli auth login`.")).toBe(
			"Sign-in was cancelled. Run `jolli auth login`.",
		);
	});
});

describe("jolliPageUrl", () => {
	it("builds a page URL on a subdomain tenant", () => {
		expect(jolliPageUrl("https://app.jolli.ai", "/cli-complete")).toBe("https://app.jolli.ai/cli-complete");
	});

	it("preserves a path-based tenant prefix", () => {
		// `new URL("/cli-complete", "https://jolli-local.me/dev")` resolves
		// against the origin and silently drops `/dev`.
		expect(jolliPageUrl("https://jolli-local.me/dev", "/cli-complete")).toBe(
			"https://jolli-local.me/dev/cli-complete",
		);
	});

	it("normalizes trailing slashes and surrounding whitespace", () => {
		expect(jolliPageUrl("  https://app.jolli.ai//  ", "/cli-complete")).toBe("https://app.jolli.ai/cli-complete");
	});

	it("appends and encodes query params", () => {
		expect(jolliPageUrl("https://app.jolli.ai", "/cli-complete", { error: "a b&c" })).toBe(
			"https://app.jolli.ai/cli-complete?error=a+b%26c",
		);
	});

	it("rejects an off-allowlist origin before it can reach a Location header", () => {
		expect(() => jolliPageUrl("https://evil.com", "/cli-complete")).toThrow(/Rejected Jolli origin/);
	});

	it("rejects a plaintext origin", () => {
		expect(() => jolliPageUrl("http://app.jolli.ai", "/cli-complete")).toThrow(/Rejected Jolli origin/);
	});

	it("rejects a CRLF-carrying origin rather than splitting the response header", () => {
		expect(() => jolliPageUrl("https://app.jolli.ai\r\nX-Injected: 1", "/cli-complete")).toThrow();
	});
});

describe("resolveAuthCallback", () => {
	const base = { jolliUrl: "https://app.jolli.ai", expectedState: STATE };

	it("reports a server error code before looking at state", () => {
		// `?error=` redirects carry no `state`; checking state first would report
		// a plain cancellation as a CSRF attack.
		return expect(resolveAuthCallback({ ...base, params: params("error=user_denied") })).resolves.toEqual({
			ok: false,
			code: "user_denied",
			message: "Sign-in was cancelled. You can try again.",
		});
	});

	it("enforces the CSRF nonce on the code path", async () => {
		await expect(resolveAuthCallback({ ...base, params: params("code=c1") })).resolves.toMatchObject({
			ok: false,
			code: "invalid_callback",
		});
		await expect(
			resolveAuthCallback({ ...base, params: params(`code=c1&state=${"b".repeat(64)}`) }),
		).resolves.toMatchObject({ ok: false, code: "invalid_callback" });
		// Mismatched byte length must be rejected by the length guard rather
		// than reaching timingSafeEqual, which throws RangeError on unequal
		// buffers — a crash instead of a clean rejection.
		await expect(resolveAuthCallback({ ...base, params: params("code=c1&state=蟹") })).resolves.toMatchObject({
			ok: false,
			code: "invalid_callback",
		});
		expect(mockExchangeCliCode).not.toHaveBeenCalled();
	});

	it("accepts the legacy ?token= shape WITHOUT a CSRF check", async () => {
		// Pre-code-exchange servers never echo `state`. Requiring it would lock
		// those tenants out of sign-in entirely. Mirrors main CLI / VS Code
		// (which have the same code-only CSRF policy in their own inline handlers).
		mockSaveAuthCredentials.mockResolvedValueOnce(undefined);
		await expect(resolveAuthCallback({ ...base, params: params("token=legacy-tk&space=team") })).resolves.toEqual({
			ok: true,
			token: "legacy-tk",
			space: "team",
		});
		expect(mockSaveAuthCredentials).toHaveBeenCalledWith({
			token: "legacy-tk",
			jolliUrl: "https://app.jolli.ai",
		});
	});

	it("carries jolli_api_key from the legacy shape into saveAuthCredentials", async () => {
		mockSaveAuthCredentials.mockResolvedValueOnce(undefined);
		await expect(
			resolveAuthCallback({ ...base, params: params("token=legacy-tk&jolli_api_key=sk-jol-legacy") }),
		).resolves.toMatchObject({ ok: true, token: "legacy-tk", jolliApiKey: "sk-jol-legacy" });
		expect(mockSaveAuthCredentials).toHaveBeenCalledWith({
			token: "legacy-tk",
			jolliUrl: "https://app.jolli.ai",
			jolliApiKey: "sk-jol-legacy",
		});
	});

	it("notifies the surface when the legacy shape is taken", async () => {
		mockSaveAuthCredentials.mockResolvedValueOnce(undefined);
		const onLegacyFallback = vi.fn();
		await resolveAuthCallback({ ...base, params: params("token=legacy-tk"), onLegacyFallback });
		expect(onLegacyFallback).toHaveBeenCalledOnce();
	});

	it("preserves the existing key's tenant when a code-path callback returns no fresh key", async () => {
		// The bug this guards against: an idempotent-replay callback (server
		// per-`device_name` reuse) returns no `jolliApiKey`. The caller-supplied
		// `jolliUrl` may be a generic hub (IntelliJ defaults to
		// `https://jolli.ai`) that differs from the on-disk key's subdomain
		// tenant, so `saveAuthCredentials` would compare them, decide they
		// mismatch, and silently drop the working key. Passing the existing key
		// as a fallback makes the persisted `jolliUrl` match the key's own
		// tenant, so the same-tenant check inside `saveAuthCredentials` holds.
		const existingKey = `sk-jol-${Buffer.from(JSON.stringify({ t: "acme", u: "https://acme.jolli.ai" })).toString("base64url")}.secret`;
		mockLoadConfig.mockResolvedValueOnce({ jolliApiKey: existingKey });
		mockSaveAuthCredentials.mockResolvedValueOnce(undefined);
		mockExchangeCliCode.mockResolvedValueOnce({ token: "tk" });
		await resolveAuthCallback({
			...base,
			jolliUrl: "https://jolli.ai",
			params: params(`code=c1&state=${STATE}`),
		});
		expect(mockSaveAuthCredentials).toHaveBeenCalledWith({
			token: "tk",
			jolliUrl: "https://acme.jolli.ai",
		});
	});

	it("prefers code over token when a misconfigured server emits both", async () => {
		// Code wins because the credential takes a more private path
		// (server→server JSON body vs. URL string).
		mockExchangeCliCode.mockResolvedValueOnce({ token: "exchanged-tk" });
		mockSaveAuthCredentials.mockResolvedValueOnce(undefined);
		await expect(
			resolveAuthCallback({
				...base,
				params: params(`code=abc&state=${STATE}&token=ignored&jolli_api_key=sk-jol-ignored`),
			}),
		).resolves.toMatchObject({ ok: true, token: "exchanged-tk" });
		expect(mockExchangeCliCode).toHaveBeenCalledWith("https://app.jolli.ai", "abc");
	});

	it("redeems the code and persists the exchanged credentials", async () => {
		mockExchangeCliCode.mockResolvedValueOnce({ token: "tk", jolliApiKey: undefined, space: "team" });
		mockSaveAuthCredentials.mockResolvedValueOnce(undefined);
		await expect(resolveAuthCallback({ ...base, params: params(`code=c1&state=${STATE}`) })).resolves.toMatchObject(
			{ ok: true, token: "tk", space: "team" },
		);
		expect(mockExchangeCliCode).toHaveBeenCalledWith("https://app.jolli.ai", "c1");
	});

	it("rejects a callback carrying neither code nor token", () => {
		return expect(resolveAuthCallback({ ...base, params: params("") })).resolves.toEqual({
			ok: false,
			code: "invalid_callback",
			message: "No authorization code or token received",
		});
	});

	it("surfaces an exchange failure as failed_to_get_token", () => {
		mockExchangeCliCode.mockRejectedValueOnce(new Error("Sign-in code expired or already used."));
		return expect(resolveAuthCallback({ ...base, params: params(`code=c1&state=${STATE}`) })).resolves.toEqual({
			ok: false,
			code: "failed_to_get_token",
			message: "Sign-in code expired or already used.",
		});
	});

	it("surfaces a persistence failure too, not just the network call", () => {
		// saveAuthCredentials rejects a malformed key, an off-allowlist origin,
		// and a key minted for a different tenant.
		mockSaveAuthCredentials.mockRejectedValueOnce(new Error("Refusing to persist"));
		return expect(resolveAuthCallback({ ...base, params: params("token=legacy-tk") })).resolves.toEqual({
			ok: false,
			code: "failed_to_get_token",
			message: "Refusing to persist",
		});
	});

	it("stringifies a non-Error throw", () => {
		mockExchangeCliCode.mockRejectedValueOnce("plain string error");
		return expect(
			resolveAuthCallback({ ...base, params: params(`code=c1&state=${STATE}`) }),
		).resolves.toMatchObject({ ok: false, message: "plain string error" });
	});
});
