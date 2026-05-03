import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────

const { saveAuthCredentials, clearAuthCredentials, getJolliUrl } = vi.hoisted(
	() => ({
		saveAuthCredentials: vi.fn().mockResolvedValue(undefined),
		clearAuthCredentials: vi.fn().mockResolvedValue(undefined),
		getJolliUrl: vi.fn(() => "https://app.jolli.ai"),
	}),
);

const { exchangeCliCode } = vi.hoisted(() => ({
	exchangeCliCode: vi.fn(),
}));

const { loadConfig } = vi.hoisted(() => ({
	loadConfig: vi.fn().mockResolvedValue({}),
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

vi.mock("../../../cli/src/auth/AuthConfig.js", () => ({
	saveAuthCredentials,
	clearAuthCredentials,
	getJolliUrl,
}));

vi.mock("../../../cli/src/auth/CliExchange.js", () => ({
	exchangeCliCode,
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
				jolliApiKey: "sk-jol-test",
			});
			expect(saveAuthCredentials).toHaveBeenCalledTimes(1);
			expect(executeCommand).toHaveBeenCalledWith(
				"setContext",
				"jollimemory.signedIn",
				true,
			);
		});

		it("should save only the token when the exchange omits an API key", async () => {
			exchangeCliCode.mockResolvedValueOnce({ token: "test-token" });
			const state = await primeStateViaSignIn(service);
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			const result = await service.handleAuthCallback(uri as never);

			expect(result).toEqual({ success: true });
			expect(saveAuthCredentials).toHaveBeenCalledWith({ token: "test-token" });
		});

		it("should pass the configured JOLLI_URL through to the exchange", async () => {
			const state = await primeStateViaSignIn(service);
			getJolliUrl.mockReturnValueOnce("https://custom.jolli.ai");
			const uri = makeUri("/auth-callback", `code=abc123&state=${state}`);

			await service.handleAuthCallback(uri as never);

			expect(exchangeCliCode).toHaveBeenCalledWith(
				"https://custom.jolli.ai",
				"abc123",
			);
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
		// server hasn't shipped JOLLI-1270 yet. Once all server tenants emit
		// `?code=` callbacks, this whole describe block (and the matching
		// branch in handleAuthCallback) can be deleted.

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
		// from pre-1270 servers don't echo state and can't be tightened
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
				// Pre-1270 servers don't echo state; demanding it would lock
				// those users out of sign-in. The legacy hole closes when the
				// fallback is removed.
				await primeStateViaSignIn(service);
				const uri = makeUri("/auth-callback", "token=legacy-tk");

				const result = await service.handleAuthCallback(uri as never);

				expect(result).toEqual({ success: true });
				expect(saveAuthCredentials).toHaveBeenCalledWith({
					token: "legacy-tk",
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

		it("should clear pendingState when openExternal returns false (covers leak-on-launch-failure path)", async () => {
			// Sets pendingState, then openExternal fails → state must be
			// cleared so it doesn't validate a future code callback.
			openExternal.mockResolvedValueOnce(false);
			await service.openSignInPage();

			// A subsequent code callback would fail with "state mismatch" even
			// if it carries the nonce from the failed attempt's URL — because
			// pendingState is null again.
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

		it("should use custom JOLLI_URL when configured", async () => {
			getJolliUrl.mockReturnValueOnce("https://custom.jolli.ai");

			await service.openSignInPage();

			expect(uriParse).toHaveBeenCalledTimes(1);
			expect(uriParse.mock.calls[0]?.[0]).toContain(
				"https://custom.jolli.ai/login",
			);
		});

		it("should omit generate_api_key when a jolliApiKey already exists", async () => {
			// Preserves manually configured keys: if we always asked for
			// generation, the server-issued key would overwrite the manual one
			// via handleAuthCallback().
			loadConfig.mockResolvedValueOnce({ jolliApiKey: "sk-jol-existing" });

			await service.openSignInPage();

			expect(uriParse).toHaveBeenCalledTimes(1);
			const parsed = uriParse.mock.calls[0]?.[0] ?? "";
			expect(parsed).not.toContain("generate_api_key");
			expect(parsed).toContain("client=vscode");
		});

		it("should show an error message when openExternal returns false", async () => {
			openExternal.mockResolvedValueOnce(false);

			await service.openSignInPage();

			expect(showErrorMessage).toHaveBeenCalledWith(
				expect.stringContaining("Couldn't launch the browser"),
			);
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
