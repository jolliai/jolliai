import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────

const { saveAuthCredentials, clearAuthCredentials, getJolliUrl, shouldRequestFreshApiKey } = vi.hoisted(
	() => ({
		saveAuthCredentials: vi.fn().mockResolvedValue(undefined),
		clearAuthCredentials: vi.fn().mockResolvedValue(undefined),
		getJolliUrl: vi.fn(() => "https://app.jolli.ai"),
		// Default: ask for a fresh key (clean install / no on-disk key).
		// Cross-tenant / same-tenant re-auth tests override per-case.
		shouldRequestFreshApiKey: vi.fn(() => true),
	}),
);

const { exchangeCliCode } = vi.hoisted(() => ({
	exchangeCliCode: vi.fn(),
}));

const { loadConfig } = vi.hoisted(() => ({
	loadConfig: vi.fn().mockResolvedValue({}),
}));

const { getDeviceLabel } = vi.hoisted(() => ({
	getDeviceLabel: vi.fn(),
}));

const {
	executeCommand,
	openExternal,
	showErrorMessage,
	Uri,
	uriParse,
	appNameState,
} = vi.hoisted(() => {
	const executeCommand = vi.fn().mockResolvedValue(undefined);
	const showErrorMessage = vi.fn();
	const openExternal = vi.fn().mockResolvedValue(true);
	// Mutable holder so individual tests can swap the host IDE (e.g. set to
	// `"Cursor"` to simulate running inside Cursor) and verify AuthService's
	// scheme resolution adapts. The `vi.mock` factory below reads it via a
	// getter so runtime mutation is honored — the factory itself only
	// executes once.
	const appNameState = { current: "Visual Studio Code" };

	// Minimal Uri shape — AuthService only reads path/query, so full URI semantics
	// aren't required. Enough to stand in for vscode.Uri in tests.
	interface FakeUri {
		readonly scheme: string;
		readonly authority: string;
		readonly path: string;
		readonly query: string;
		readonly fragment: string;
	}

	// `parse` is a vi.fn so tests can assert on the exact string that was parsed
	// (this is the login URL AuthService hands to openExternal).
	const uriParse = vi.fn((value: string): FakeUri => {
		const url = new URL(value);
		return {
			scheme: url.protocol.replace(":", ""),
			authority: url.hostname,
			path: url.pathname,
			query: url.search.replace("?", ""),
			fragment: url.hash.replace("#", ""),
		};
	});
	const Uri = { parse: uriParse };

	return {
		executeCommand,
		openExternal,
		showErrorMessage,
		Uri,
		uriParse,
		appNameState,
	};
});

const {
	info,
	warn,
	error: logError,
} = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock("vscode", () => ({
	commands: { executeCommand },
	env: {
		openExternal,
		// Getter so tests can mutate `appNameState.current` at runtime
		// (the factory itself only executes once). `appName` is the signal
		// AuthService uses to derive the OS-registered URI scheme.
		get appName() {
			return appNameState.current;
		},
	},
	window: { showErrorMessage },
	Uri,
}));

vi.mock("../../../cli/src/auth/AuthConfig.js", async (importActual) => {
	// `resolveSignInJolliUrl` is a pure key→tenant helper with no config I/O —
	// keep the real implementation so the callback path exercises the actual
	// tenant resolution (a decodable key's `meta.u` wins over the sign-in
	// origin), matching the CLI's Login.test wiring.
	const actual = await importActual<typeof import("../../../cli/src/auth/AuthConfig.js")>();
	return {
		saveAuthCredentials,
		clearAuthCredentials,
		getJolliUrl,
		shouldRequestFreshApiKey,
		resolveSignInJolliUrl: actual.resolveSignInJolliUrl,
	};
});

vi.mock("../../../cli/src/auth/CliExchange.js", () => ({
	exchangeCliCode,
}));

vi.mock("../../../cli/src/auth/DeviceLabel.js", () => ({
	getDeviceLabel,
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	loadConfig,
}));

vi.mock("../util/Logger.js", () => ({
	log: { info, warn, error: logError },
}));

import type { JolliMemoryConfig } from "../../../cli/src/Types.js";
import { AuthService } from "./AuthService.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Creates a mock vscode.Uri with the given path and query string. */
function makeUri(path: string, query: string): { path: string; query: string } {
	return { path, query };
}

/**
 * Drives openSignInPage() to seed `pendingState`, then returns the nonce that
 * appeared on the resulting login URL — exactly what an upgraded server would
 * echo back as `state=…`. Tests use this so they exercise the full nonce
 * lifecycle (generate → URL → callback) without poking private state.
 */
async function primeStateViaSignIn(service: AuthService): Promise<string> {
	const callsBefore = uriParse.mock.calls.length;
	await service.openSignInPage();
	const parsed = uriParse.mock.calls[callsBefore]?.[0] ?? "";
	return new URL(parsed).searchParams.get("state") ?? "";
}

function makeConfig(
	overrides: Partial<JolliMemoryConfig> = {},
): JolliMemoryConfig {
	return { apiKey: "sk-ant-test", ...overrides };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("AuthService", () => {
	let service: AuthService;

	beforeEach(() => {
		vi.clearAllMocks();
		// Default: no jolliApiKey configured — sign-in should request key generation.
		loadConfig.mockResolvedValue({});
		// Reset host-IDE appName to VSCode Stable; per-test overrides simulate forks.
		appNameState.current = "Visual Studio Code";
		// Default: code-exchange succeeds and returns a token only. Tests that
		// need an API key or different failure modes override per-call.
		exchangeCliCode.mockResolvedValue({ token: "test-token" });
		// Default: no device label so URL-construction tests that don't care
		// about the param stay unchanged. Multi-device tests override per-call.
		getDeviceLabel.mockReturnValue(undefined);
		service = new AuthService();
	});

	// ── handleAuthCallback ──────────────────────────────────────────────

	describe("handleAuthCallback", () => {
		it("should exchange the code and save token + API key atomically on success", async () => {
			exchangeCliCode.mockResolvedValueOnce({
				token: "test-token",
				jolliApiKey: "sk-jol-test",
			});
			const state = await primeStateViaSignIn(service);
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			expect(result).toEqual({ success: true });
			expect(exchangeCliCode).toHaveBeenCalledWith(
				"https://app.jolli.ai",
				"abc123",
			);
			expect(saveAuthCredentials).toHaveBeenCalledWith({
				token: "test-token",
				jolliUrl: "https://app.jolli.ai",
				jolliApiKey: "sk-jol-test",
			});
			expect(saveAuthCredentials).toHaveBeenCalledTimes(1);
			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.signedIn",
				true,
			);
		});

		it("persists the minted key's tenant as jolliUrl, not the sign-in origin", async () => {
			// Regression guard for the default-login break: getJolliUrl() is the
			// auth hub by default, but the minted key targets the user's real
			// tenant. Persisting the hub would trip saveAuthCredentials's
			// same-tenant symmetry check and reject every normal key.
			// Sign-in origin defaults to https://app.jolli.ai (the mock); the key
			// targets a different tenant, so the persisted jolliUrl must follow the
			// key, not the origin.
			const tenantKey = `sk-jol-${Buffer.from(
				JSON.stringify({ t: "tenant1", u: "https://tenant1.jolli.ai" }),
			).toString("base64url")}.secret`;
			exchangeCliCode.mockResolvedValueOnce({ token: "hub-tk", jolliApiKey: tenantKey });
			const state = await primeStateViaSignIn(service);
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			await service.handleAuthCallback(uri as never);

			expect(saveAuthCredentials).toHaveBeenCalledWith({
				token: "hub-tk",
				jolliUrl: "https://tenant1.jolli.ai",
				jolliApiKey: tenantKey,
			});
		});

		it("should save only the token when the exchange omits an API key", async () => {
			exchangeCliCode.mockResolvedValueOnce({ token: "test-token" });
			const state = await primeStateViaSignIn(service);
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			expect(result).toEqual({ success: true });
			expect(saveAuthCredentials).toHaveBeenCalledWith({
				token: "test-token",
				jolliUrl: "https://app.jolli.ai",
			});
		});

		it("should pass the configured JOLLI_URL through to the exchange and into the saved credentials", async () => {
			const state = await primeStateViaSignIn(service);
			// `mockReturnValueOnce` (not mockReturnValue) — the default
			// `clearAllMocks` in beforeEach only clears call history, not
			// implementations, so a permanent override would leak into every
			// later test in the suite. AuthService captures `getJolliUrl()`
			// once at the top of handleAuthCallback, so a single Once is
			// enough to cover both the exchange call and the saved credential.
			getJolliUrl.mockReturnValueOnce("https://custom.jolli.ai");
			exchangeCliCode.mockResolvedValueOnce({ token: "custom-tk" });
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			await service.handleAuthCallback(uri as never);

			expect(exchangeCliCode).toHaveBeenCalledWith(
				"https://custom.jolli.ai",
				"abc123",
			);
			expect(saveAuthCredentials).toHaveBeenCalledWith({
				token: "custom-tk",
				jolliUrl: "https://custom.jolli.ai",
			});
		});

		it("should return error for server-reported error codes", async () => {
			const uri = makeUri("/auth-callback", "error=oauth_failed");

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe(
					"OAuth authentication failed. Please try again.",
				);
			}
			expect(exchangeCliCode).not.toHaveBeenCalled();
			expect(saveAuthCredentials).not.toHaveBeenCalled();
		});

		it("should return a friendly message when the user cancels on the consent page", async () => {
			const uri = makeUri("/auth-callback", "error=user_denied");

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe(
					"Sign-in was cancelled. You can try again from the side panel.",
				);
			}
			expect(exchangeCliCode).not.toHaveBeenCalled();
		});

		it("should return user-friendly message for known error codes", async () => {
			const uri = makeUri("/auth-callback", "error=session_missing");

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe(
					"Session expired or missing. Please try again.",
				);
			}
		});

		it("should return generic message for unknown error codes", async () => {
			const uri = makeUri("/auth-callback", "error=custom_error");

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe("Authentication error: custom_error");
			}
		});

		it("should return error when both code and token are missing", async () => {
			// `jolli_api_key` alone is meaningless — we have no token to pair it
			// with, regardless of which server flow the callback came from.
			const uri = makeUri("/auth-callback", "jolli_api_key=sk-jol-test");

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe("No authorization code or token received");
			}
			expect(exchangeCliCode).not.toHaveBeenCalled();
			expect(saveAuthCredentials).not.toHaveBeenCalled();
		});

		// ── Legacy token-in-URL fallback ──────────────────────────────────
		// Compatibility window for users on the latest extension whose Jolli
		// server hasn't shipped the code-exchange endpoint yet. Once all
		// server tenants emit `?code=` callbacks, this whole describe block
		// (and the matching branch in handleAuthCallback) can be deleted.

		it("should accept legacy token-in-URL callback with jolli_api_key", async () => {
			const uri = makeUri(
				"/auth-callback",
				"token=legacy-token&jolli_api_key=sk-jol-legacy",
			);

			const result = await service.handleAuthCallback(uri as never);

			expect(result).toEqual({ success: true });
			// No exchange call — old-server callback delivers the token directly.
			expect(exchangeCliCode).not.toHaveBeenCalled();
			expect(saveAuthCredentials).toHaveBeenCalledWith({
				token: "legacy-token",
				jolliUrl: "https://app.jolli.ai",
				jolliApiKey: "sk-jol-legacy",
			});
			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.signedIn",
				true,
			);
		});

		it("should accept legacy token-only callback (no jolli_api_key param)", async () => {
			const uri = makeUri("/auth-callback", "token=legacy-token");

			const result = await service.handleAuthCallback(uri as never);

			expect(result).toEqual({ success: true });
			expect(saveAuthCredentials).toHaveBeenCalledWith({
				token: "legacy-token",
				jolliUrl: "https://app.jolli.ai",
			});
		});

		it("should log a warning when falling back to legacy token-in-URL", async () => {
			// The warn log is our signal for tracking residual old-server traffic
			// after the server rollout — needed to know when it's safe to drop
			// the fallback branch.
			const uri = makeUri("/auth-callback", "token=legacy-token");

			await service.handleAuthCallback(uri as never);

			expect(warn).toHaveBeenCalledWith(
				"AuthService",
				expect.stringContaining("legacy token-in-URL"),
			);
		});

		it("should prefer code over token when both are present", async () => {
			// A misconfigured server could in theory emit both — code takes
			// priority because it leaks the actual credential through fewer
			// surfaces (no browser history, no referer, no URI handler chain).
			exchangeCliCode.mockResolvedValueOnce({
				token: "exchanged-token",
				jolliApiKey: "sk-jol-exchanged",
			});
			const state = await primeStateViaSignIn(service);
			const uri = makeUri(
				"/auth-callback",
				`code=abc123&state=${state}&token=ignored-legacy-token&jolli_api_key=sk-jol-ignored`,
			);

			const result = await service.handleAuthCallback(uri as never);

			expect(result).toEqual({ success: true });
			expect(exchangeCliCode).toHaveBeenCalledWith(
				"https://app.jolli.ai",
				"abc123",
			);
			expect(saveAuthCredentials).toHaveBeenCalledWith({
				token: "exchanged-token",
				jolliUrl: "https://app.jolli.ai",
				jolliApiKey: "sk-jol-exchanged",
			});
		});

		it("should propagate save failure from the legacy token path", async () => {
			// `saveAuthCredentials` calls `validateJolliApiKey` internally — a
			// malformed `jolli_api_key` from a legacy server reaches us here as
			// a thrown Error and must surface the same way as the code-flow
			// save failures (so the user sees "Failed to save credentials: …"
			// instead of a silent success).
			saveAuthCredentials.mockRejectedValueOnce(
				new Error("invalid jolli api key"),
			);
			const uri = makeUri(
				"/auth-callback",
				"token=legacy-token&jolli_api_key=garbage",
			);

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("Failed to save credentials");
				expect(result.error).toContain("invalid jolli api key");
			}
		});

		// ── CSRF state validation (RFC 6749 §10.12) ──────────────────────
		// Only enforced on the `?code=` path. Legacy `?token=` callbacks
		// from older servers don't echo state and can't be tightened
		// without locking those users out of sign-in — see the legacy
		// describe block above for the bypass tests.

		describe("state validation", () => {
			it("rejects a code callback that omits the state param", async () => {
				await primeStateViaSignIn(service);
				const uri = makeUri("/auth-callback", "code=attacker-code");

				const result = await service.handleAuthCallback(uri as never);

				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toContain("state mismatch");
				}
				expect(exchangeCliCode).not.toHaveBeenCalled();
				expect(saveAuthCredentials).not.toHaveBeenCalled();
			});

			it("rejects a code callback whose state does not match the pending nonce", async () => {
				await primeStateViaSignIn(service);
				const uri = makeUri(
					"/auth-callback",
					"code=attacker-code&state=wrong-state",
				);

				const result = await service.handleAuthCallback(uri as never);

				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toContain("state mismatch");
				}
				expect(exchangeCliCode).not.toHaveBeenCalled();
			});

			it("rejects a code callback whose state matches in length but not content", async () => {
				// timingSafeEqual requires equal-length inputs — a length-matched
				// mismatch exercises the actual constant-time compare path.
				const real = await primeStateViaSignIn(service);
				const wrongSameLength = "0".repeat(real.length);
				expect(wrongSameLength).not.toBe(real);
				const uri = makeUri(
					"/auth-callback",
					`code=c&state=${wrongSameLength}`,
				);

				const result = await service.handleAuthCallback(uri as never);

				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toContain("state mismatch");
				}
			});

			it("rejects a code callback whose state has matching JS length but non-ASCII bytes", async () => {
				// Without a byte-aware length check, a state whose JS char
				// length equals the expected nonce length but contains a
				// non-ASCII char (extra UTF-8 continuation bytes) slips past
				// `a.length !== b.length` and crashes `timingSafeEqual` with
				// RangeError — breaking the documented AuthCallbackResult
				// contract by rejecting the Promise instead of resolving to
				// `{ success: false, error: "...state mismatch..." }`.
				const real = await primeStateViaSignIn(service);
				const sneakyState = `${"0".repeat(real.length - 1)}é`;
				expect(sneakyState.length).toBe(real.length);
				expect(Buffer.byteLength(sneakyState, "utf8")).not.toBe(
					Buffer.byteLength(real, "utf8"),
				);
				const uri = makeUri(
					"/auth-callback",
					`code=c&state=${encodeURIComponent(sneakyState)}`,
				);

				const result = await service.handleAuthCallback(uri as never);

				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toContain("state mismatch");
				}
				expect(exchangeCliCode).not.toHaveBeenCalled();
			});

			it("rejects a code callback when no sign-in was initiated (no pending state)", async () => {
				// An attacker firing a callback URI directly — without the user
				// ever having clicked Sign In — has no nonce to forge against.
				const uri = makeUri(
					"/auth-callback",
					"code=attacker-code&state=any-value",
				);

				const result = await service.handleAuthCallback(uri as never);

				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toContain("state mismatch");
				}
			});

			it("consumes the pending state on one callback (replay protection)", async () => {
				// First callback uses the nonce; a second callback with the same
				// state must fail because pendingState was cleared.
				const state = await primeStateViaSignIn(service);
				exchangeCliCode.mockResolvedValueOnce({ token: "first-token" });

				const firstResult = await service.handleAuthCallback(
					makeUri("/auth-callback", `code=first&state=${state}`) as never,
				);
				expect(firstResult.success).toBe(true);

				const secondResult = await service.handleAuthCallback(
					makeUri("/auth-callback", `code=second&state=${state}`) as never,
				);
				expect(secondResult.success).toBe(false);
				if (!secondResult.success) {
					expect(secondResult.error).toContain("state mismatch");
				}
			});

			it("does NOT enforce state on the legacy token-in-URL fallback", async () => {
				// Older servers don't echo state; demanding it would lock
				// those users out of sign-in. The legacy hole closes when the
				// fallback is removed.
				await primeStateViaSignIn(service);
				const uri = makeUri("/auth-callback", "token=legacy-tk");

				const result = await service.handleAuthCallback(uri as never);

				expect(result).toEqual({ success: true });
				expect(saveAuthCredentials).toHaveBeenCalledWith({
					token: "legacy-tk",
					jolliUrl: "https://app.jolli.ai",
				});
			});
		});

		it("should ignore unknown URI paths", async () => {
			const uri = makeUri("/some-other-path", "code=abc123");

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe("Unknown callback path");
			}
			expect(exchangeCliCode).not.toHaveBeenCalled();
			expect(saveAuthCredentials).not.toHaveBeenCalled();
		});

		it("should surface the exchange failure message and skip saving", async () => {
			exchangeCliCode.mockRejectedValueOnce(
				new Error(
					"Sign-in code expired or already used. Please try signing in again.",
				),
			);
			const state = await primeStateViaSignIn(service);
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("expired or already used");
			}
			expect(saveAuthCredentials).not.toHaveBeenCalled();
		});

		it("should stringify non-Error throws from the exchange", async () => {
			exchangeCliCode.mockRejectedValueOnce("bare exchange rejection");
			const state = await primeStateViaSignIn(service);
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("bare exchange rejection");
			}
		});

		it("should return error when save fails", async () => {
			saveAuthCredentials.mockRejectedValueOnce(new Error("disk full"));
			const state = await primeStateViaSignIn(service);
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("Failed to save credentials");
				expect(result.error).toContain("disk full");
			}
		});

		it("should stringify non-Error throw from saveAuthCredentials", async () => {
			// Covers the `err instanceof Error ? err.message : String(err)` right branch.
			saveAuthCredentials.mockRejectedValueOnce("bare string rejection");
			const state = await primeStateViaSignIn(service);
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("bare string rejection");
			}
		});

		it("returns a structured error (not a rejected Promise) when getJolliUrl throws after the callback arrives", async () => {
			// `getJolliUrl()` is captured once inside handleAuthCallback after
			// the openSignInPage call already succeeded. If `JOLLI_URL` is
			// mutated to an off-allowlist value between sign-in launch and
			// callback arrival, `assertJolliOriginAllowed` throws there — that
			// must surface as `{ success: false, error }` per the
			// AuthCallbackResult contract, not as an unhandled rejection that
			// crashes the URI handler.
			const state = await primeStateViaSignIn(service);
			getJolliUrl.mockImplementationOnce(() => {
				throw new Error("Rejected Jolli origin \"https://evil.com\".");
			});
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("Rejected Jolli origin");
			}
			expect(exchangeCliCode).not.toHaveBeenCalled();
			expect(saveAuthCredentials).not.toHaveBeenCalled();
			expect(logError).toHaveBeenCalledWith(
				"AuthService",
				expect.stringContaining("getJolliUrl rejected mid-callback"),
				expect.any(String),
			);
		});

		it("stringifies a non-Error throw from getJolliUrl mid-callback", async () => {
			// Covers the `err instanceof Error ? err.message : String(err)`
			// right branch of the mid-callback `getJolliUrl` guard above.
			const state = await primeStateViaSignIn(service);
			getJolliUrl.mockImplementationOnce(() => {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw "bare-string allowlist rejection";
			});
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("bare-string allowlist rejection");
			}
		});

		it("should continue returning success when setContext throws", async () => {
			// Covers the log.warn branch in the setContext catch.
			// executeCommand succeeds for saveAuthCredentials's lifecycle but throws
			// specifically for the setContext call.
			executeCommand.mockImplementationOnce(() => {
				throw new Error("setContext unavailable");
			});
			const state = await primeStateViaSignIn(service);
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			// Save succeeded → overall result is success even though setContext threw.
			expect(result.success).toBe(true);
		});
	});

	// ── signOut ─────────────────────────────────────────────────────────

	describe("signOut", () => {
		it("should clear both auth token and Jolli API key", async () => {
			await service.signOut();

			// clearAuthCredentials removes authToken AND jolliApiKey in a single write.
			expect(clearAuthCredentials).toHaveBeenCalledTimes(1);
			expect(saveAuthCredentials).not.toHaveBeenCalled();
		});

		it("should set signedIn context key to false", async () => {
			await service.signOut();

			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.signedIn",
				false,
			);
		});
	});

	// ── openSignInPage ──────────────────────────────────────────────────

	describe("openSignInPage", () => {
		it("should open browser with correct login URL", async () => {
			await service.openSignInPage();

			expect(openExternal).toHaveBeenCalledTimes(1);
			expect(uriParse).toHaveBeenCalledTimes(1);
			const parsed = uriParse.mock.calls[0]?.[0];
			expect(parsed).toBeDefined();
			expect(parsed).toContain("https://app.jolli.ai/login");
			expect(parsed).toContain("cli_callback=");
			// Callback URI must be percent-encoded so Better Auth accepts it.
			expect(parsed).toContain(
				"vscode%3A%2F%2Fjolli.jollimemory-vscode%2Fauth-callback",
			);
			expect(parsed).toContain("generate_api_key=true");
			expect(parsed).toContain("client=vscode");
			// client_version pairs with client=vscode so server-side min-version
			// gating can run at sign-in. Test bundles don't define __PKG_VERSION__,
			// so the fallback "dev" is what reaches the URL here — what matters
			// is that the param is populated and not the literal value.
			expect(parsed).toMatch(/[?&]client_version=[^&]+/);
		});

		it("embeds the esbuild-injected __PKG_VERSION__ in client_version when defined", async () => {
			// CLIENT_VERSION is computed once at module load from the build-injected
			// `__PKG_VERSION__` global; test bundles don't define it (→ "dev"). To
			// exercise the populated arm of that ternary, stub the global and re-import
			// the module fresh so its top-level constant is recomputed.
			vi.resetModules();
			vi.stubGlobal("__PKG_VERSION__", "9.9.9-test");
			try {
				const { AuthService: FreshAuthService } = await import("./AuthService.js");
				const fresh = new FreshAuthService();
				const callsBefore = uriParse.mock.calls.length;
				await fresh.openSignInPage();
				const parsed = uriParse.mock.calls[callsBefore]?.[0] ?? "";
				expect(parsed).toContain("client_version=9.9.9-test");
			} finally {
				vi.unstubAllGlobals();
				vi.resetModules();
			}
		});

		it("should include a 256-bit hex state nonce on the login URL (RFC 6749 §10.12)", async () => {
			await service.openSignInPage();

			const parsed = uriParse.mock.calls[0]?.[0] ?? "";
			const state = new URL(parsed).searchParams.get("state");
			// 32 bytes → 64 hex chars. Asserting the format guards both the
			// existence of the param and that we're not regressing to a weaker
			// nonce (e.g. Math.random()).
			expect(state).toMatch(/^[0-9a-f]{64}$/);
		});

		it("should generate a fresh nonce on each sign-in attempt", async () => {
			await service.openSignInPage();
			await service.openSignInPage();

			const first = new URL(uriParse.mock.calls[0]?.[0] ?? "").searchParams.get(
				"state",
			);
			const second = new URL(
				uriParse.mock.calls[1]?.[0] ?? "",
			).searchParams.get("state");
			expect(first).toBeTruthy();
			expect(second).toBeTruthy();
			expect(first).not.toBe(second);
		});

		it("should preserve pendingState when openExternal returns false (Copy path completes via paste-in-browser)", async () => {
			// `openExternal` resolves `false` when the user picks either "Copy"
			// or "Cancel" in VSCode's external-URI consent dialog. The API
			// doesn't distinguish them, but the Copy flow needs the nonce
			// preserved — the user is about to paste the URL into a browser
			// and finish sign-in normally. A captured nonce from the URL must
			// therefore validate successfully on the subsequent callback.
			openExternal.mockResolvedValueOnce(false);
			await service.openSignInPage();

			const url = uriParse.mock.calls[0]?.[0] ?? "";
			const state = new URL(url).searchParams.get("state") ?? "";
			const result = await service.handleAuthCallback(
				makeUri("/auth-callback", `code=abc123&state=${state}`) as never,
			);

			expect(result).toEqual({ success: true });
			expect(exchangeCliCode).toHaveBeenCalledWith(
				"https://app.jolli.ai",
				"abc123",
			);
		});

		it("should expire pendingState after the TTL when no callback arrives (Cancel path leftover)", async () => {
			// The Cancel branch of the consent dialog can't be distinguished
			// from Copy at the API surface, so we keep the nonce alive for
			// PENDING_STATE_TTL_MS (5 min) and then drop it. After expiry,
			// a callback carrying the same state must be rejected.
			vi.useFakeTimers();
			try {
				openExternal.mockResolvedValueOnce(false);
				await service.openSignInPage();

				const url = uriParse.mock.calls[0]?.[0] ?? "";
				const state = new URL(url).searchParams.get("state") ?? "";

				// Advance just past the 5-minute TTL.
				vi.advanceTimersByTime(5 * 60 * 1000 + 1);

				const result = await service.handleAuthCallback(
					makeUri("/auth-callback", `code=late&state=${state}`) as never,
				);
				expect(result.success).toBe(false);
				if (!result.success) {
					expect(result.error).toContain("state mismatch");
				}
			} finally {
				vi.useRealTimers();
			}
		});

		it("should clear pendingState when openExternal throws (covers leak-on-throw path)", async () => {
			openExternal.mockRejectedValueOnce(new Error("no browser"));
			await service.openSignInPage();

			const failedUrl = uriParse.mock.calls[0]?.[0] ?? "";
			const failedState = new URL(failedUrl).searchParams.get("state") ?? "";
			const result = await service.handleAuthCallback(
				makeUri("/auth-callback", `code=stale&state=${failedState}`) as never,
			);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("state mismatch");
			}
		});

		it("should cancel a stale TTL timer when a fresh sign-in is started", async () => {
			// First attempt: Copy/Cancel path arms a 5-min TTL timer for nonce A.
			// Second attempt: a successful launch arms a fresh nonce B. The
			// previous timer must be cancelled — otherwise it would fire 5 min
			// later and wipe nonce B mid-flight, breaking the second sign-in.
			vi.useFakeTimers();
			try {
				openExternal.mockResolvedValueOnce(false); // attempt 1: Copy/Cancel
				await service.openSignInPage();
				openExternal.mockResolvedValueOnce(true); // attempt 2: Open
				await service.openSignInPage();

				// Advance past attempt 1's TTL. If its timer wasn't cancelled,
				// it would null out the freshly-committed nonce B here.
				vi.advanceTimersByTime(5 * 60 * 1000 + 1);

				const secondUrl = uriParse.mock.calls[1]?.[0] ?? "";
				const secondState = new URL(secondUrl).searchParams.get("state") ?? "";
				const result = await service.handleAuthCallback(
					makeUri("/auth-callback", `code=abc&state=${secondState}`) as never,
				);
				expect(result).toEqual({ success: true });
			} finally {
				vi.useRealTimers();
			}
		});

		it("should drop in-flight pendingState on signOut", async () => {
			// signOut is meant to clear *all* auth state. A late callback from
			// a sign-in attempt that started before sign-out must not retroactively
			// complete sign-in against the cleared credentials.
			openExternal.mockResolvedValueOnce(false);
			await service.openSignInPage();

			const url = uriParse.mock.calls[0]?.[0] ?? "";
			const state = new URL(url).searchParams.get("state") ?? "";

			await service.signOut();

			const result = await service.handleAuthCallback(
				makeUri("/auth-callback", `code=abc&state=${state}`) as never,
			);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("state mismatch");
			}
		});

		it("should not commit pendingState when getJolliUrl throws (no URL was opened)", async () => {
			// If URL construction fails, no nonce reached the user's browser —
			// keeping pendingState null prevents a later callback from
			// matching against a state that was never sent out.
			getJolliUrl.mockImplementationOnce(() => {
				throw new Error("JOLLI_URL points off the allowlist");
			});

			await service.openSignInPage();

			// Fire a code callback with any state — without a pending state,
			// validation must reject.
			const result = await service.handleAuthCallback(
				makeUri("/auth-callback", "code=c&state=anything") as never,
			);
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("state mismatch");
			}
		});

		it("should stringify a non-Error throw from getJolliUrl and surface it (covers String(err) branch)", async () => {
			// Covers the `err instanceof Error ? err.message : String(err)` right
			// branch in openSignInPage's getJolliUrl guard (line 323). A non-Error
			// rejection must still produce a readable error dialog rather than
			// "[object Object]" / undefined.
			getJolliUrl.mockImplementationOnce(() => {
				// eslint-disable-next-line @typescript-eslint/no-throw-literal
				throw "bare-string allowlist rejection at launch";
			});

			await service.openSignInPage();

			// No URL was opened — construction never reached openExternal.
			expect(openExternal).not.toHaveBeenCalled();
			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("bare-string allowlist rejection at launch"),
			);
		});

		it("should use custom JOLLI_URL when configured", async () => {
			getJolliUrl.mockReturnValueOnce("https://custom.jolli.ai");

			await service.openSignInPage();

			expect(uriParse).toHaveBeenCalledTimes(1);
			expect(uriParse.mock.calls[0]?.[0]).toContain(
				"https://custom.jolli.ai/login",
			);
		});

		it("should omit generate_api_key when a jolliApiKey already exists and targets the same tenant", async () => {
			// Preserves manually configured keys / same-tenant re-auth: if we
			// always asked for generation, the server-issued key would
			// overwrite the existing one via handleAuthCallback().
			loadConfig.mockResolvedValueOnce({ jolliApiKey: "sk-jol-existing" });
			shouldRequestFreshApiKey.mockReturnValueOnce(false);

			await service.openSignInPage();

			expect(uriParse).toHaveBeenCalledTimes(1);
			const parsed = uriParse.mock.calls[0]?.[0] ?? "";
			expect(parsed).not.toContain("generate_api_key");
			expect(parsed).toContain("client=vscode");
			expect(shouldRequestFreshApiKey).toHaveBeenCalledWith("sk-jol-existing", "https://app.jolli.ai");
		});

		it("appends generate_api_key when an existing key targets a different tenant (cross-tenant rekey)", async () => {
			// Cross-tenant: existing key for tenant-A, signing into tenant-B.
			// shouldRequestFreshApiKey returns true so the server mints a fresh
			// key in this sign-in instead of forcing a second login.
			loadConfig.mockResolvedValueOnce({ jolliApiKey: "sk-jol-tenant-a" });
			shouldRequestFreshApiKey.mockReturnValueOnce(true);
			getDeviceLabel.mockReturnValue("Foster-MBP");

			await service.openSignInPage();

			const parsed = uriParse.mock.calls[0]?.[0] ?? "";
			expect(parsed).toContain("generate_api_key=true");
			expect(parsed).toContain("device_name=Foster-MBP");
			expect(shouldRequestFreshApiKey).toHaveBeenCalledWith("sk-jol-tenant-a", "https://app.jolli.ai");
		});

		// ── device_name (per-device API-key scoping) ──────────────────────
		// The server uses device_name to scope its auto-generated-key
		// idempotency check so signing in from a second machine doesn't
		// invalidate the first machine's key. Only meaningful when paired
		// with generate_api_key=true.

		it("appends device_name when generate_api_key is requested and getDeviceLabel returns a value", async () => {
			getDeviceLabel.mockReturnValue("Foster-MBP");

			await service.openSignInPage();

			const parsed = uriParse.mock.calls[0]?.[0] ?? "";
			expect(parsed).toContain("generate_api_key=true");
			expect(new URL(parsed).searchParams.get("device_name")).toBe(
				"Foster-MBP",
			);
		});

		it("URL-encodes a device_name that contains spaces or dots", async () => {
			// Hostnames like "Foster MacBook Pro.local" must round-trip safely
			// through the URL — otherwise the server sees a malformed query.
			getDeviceLabel.mockReturnValue("Foster MacBook Pro.local");

			await service.openSignInPage();

			const parsed = uriParse.mock.calls[0]?.[0] ?? "";
			expect(parsed).toContain("device_name=Foster%20MacBook%20Pro.local");
			expect(new URL(parsed).searchParams.get("device_name")).toBe(
				"Foster MacBook Pro.local",
			);
		});

		it("omits device_name when getDeviceLabel returns undefined (sanitized to empty)", async () => {
			// Hostnames that sanitize to undefined (empty / only disallowed
			// characters) must not appear on the URL so the server falls back
			// to its legacy keyName path.
			getDeviceLabel.mockReturnValue(undefined);

			await service.openSignInPage();

			const parsed = uriParse.mock.calls[0]?.[0] ?? "";
			expect(parsed).toContain("generate_api_key=true");
			expect(parsed).not.toContain("device_name");
		});

		it("omits device_name when generate_api_key is not being requested", async () => {
			// Pre-existing jolliApiKey for the same tenant → no generate_api_key.
			// device_name is only meaningful at key-creation time, so it must
			// not appear here even if the machine has a perfectly valid hostname.
			loadConfig.mockResolvedValueOnce({ jolliApiKey: "sk-jol-existing" });
			shouldRequestFreshApiKey.mockReturnValueOnce(false);
			getDeviceLabel.mockReturnValue("Foster-MBP");

			await service.openSignInPage();

			const parsed = uriParse.mock.calls[0]?.[0] ?? "";
			expect(parsed).not.toContain("generate_api_key");
			expect(parsed).not.toContain("device_name");
		});

		it("should NOT show an error message when openExternal returns false (Copy path is a legitimate user choice, not a failure)", async () => {
			// Previously the `!opened` branch surfaced "Couldn't launch the
			// browser…" — but that fires under the Copy path too, where the
			// user *intends* to complete sign-in by pasting the URL. Showing
			// an error there mis-signals failure and (paired with the old
			// pendingState reset) made the subsequent callback fail with
			// "state mismatch". The branch is now a silent log only.
			openExternal.mockResolvedValueOnce(false);

			await service.openSignInPage();

			expect(showErrorMessage).not.toHaveBeenCalled();
		});

		it("should show an error message when openExternal throws", async () => {
			openExternal.mockRejectedValueOnce(new Error("no browser"));

			await service.openSignInPage();

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("no browser"),
			);
		});

		it("should stringify a non-Error throw from openExternal", async () => {
			// Covers the `err instanceof Error ? err.message : String(err)` right branch
			// in openSignInPage (line 145).
			openExternal.mockRejectedValueOnce("bare string from browser layer");

			await service.openSignInPage();

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("bare string from browser layer"),
			);
		});

		// Each VSCode fork rebrands `vscode.env.appName` (product.json nameLong)
		// while often leaving `vscode.env.uriScheme` at the upstream default
		// "vscode". AuthService therefore derives the callback scheme from
		// appName — these mappings must stay in sync with Jolli's cli_callback
		// allowlist. If a new fork shows up, add a row here AND to
		// resolveUriScheme() in AuthService.ts AND to the server-side allowlist.
		describe.each([
			["Visual Studio Code", "vscode"],
			["Visual Studio Code - Insiders", "vscode-insiders"],
			["VSCodium", "vscodium"],
			["Cursor", "cursor"],
			["Windsurf", "windsurf"],
			["Kiro", "kiro"],
			["Antigravity", "antigravity"],
		])("with host appName=%s", (appName, expectedScheme) => {
			it(`constructs the callback URI with the ${expectedScheme} scheme`, async () => {
				appNameState.current = appName;

				await service.openSignInPage();

				expect(uriParse).toHaveBeenCalledTimes(1);
				const parsed = uriParse.mock.calls[0]?.[0] ?? "";

				// Decoding the full cli_callback value guards against false
				// positives from `client=vscode` (which also contains "vscode"
				// but is unrelated to the callback scheme).
				const match = parsed.match(/cli_callback=([^&]+)/);
				expect(match).not.toBeNull();
				const decoded = decodeURIComponent(match?.[1] ?? "");
				expect(decoded).toBe(
					`${expectedScheme}://jolli.jollimemory-vscode/auth-callback`,
				);
			});
		});

		it("should fall back to vscode:// for an unrecognized host appName", async () => {
			// Safety net for forks resolveUriScheme() doesn't know about yet:
			// we route to "vscode" so at least the VSCode-family install on the
			// machine catches the callback (better than a scheme that nothing
			// on the OS is registered to handle). The user can then add the new
			// fork to the mapping.
			appNameState.current = "Some Brand New Fork";

			await service.openSignInPage();

			expect(uriParse).toHaveBeenCalledTimes(1);
			const parsed = uriParse.mock.calls[0]?.[0] ?? "";
			const match = parsed.match(/cli_callback=([^&]+)/);
			const decoded = decodeURIComponent(match?.[1] ?? "");
			expect(decoded).toBe("vscode://jolli.jollimemory-vscode/auth-callback");
		});
	});

	// ── isSignedIn ──────────────────────────────────────────────────────

	describe("isSignedIn", () => {
		it("should return true when authToken is present", () => {
			expect(service.isSignedIn(makeConfig({ authToken: "some-token" }))).toBe(
				true,
			);
		});

		it("should return false when authToken is absent", () => {
			expect(service.isSignedIn(makeConfig())).toBe(false);
		});

		it("should return false when authToken is empty string", () => {
			expect(service.isSignedIn(makeConfig({ authToken: "" }))).toBe(false);
		});
	});

	// ── refreshContextKey ───────────────────────────────────────────────

	describe("refreshContextKey", () => {
		it("should set context key to true when signed in", () => {
			service.refreshContextKey(makeConfig({ authToken: "token" }));

			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.signedIn",
				true,
			);
		});

		it("should set context key to false when not signed in", () => {
			service.refreshContextKey(makeConfig());

			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.signedIn",
				false,
			);
		});
	});
});
