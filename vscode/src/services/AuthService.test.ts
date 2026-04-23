import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────

const { saveAuthCredentials, clearAuthCredentials, getJolliUrl } = vi.hoisted(
	() => ({
		saveAuthCredentials: vi.fn().mockResolvedValue(undefined),
		clearAuthCredentials: vi.fn().mockResolvedValue(undefined),
		getJolliUrl: vi.fn(() => "https://app.jolli.ai"),
	}),
);

const { loadConfig } = vi.hoisted(() => ({
	loadConfig: vi.fn().mockResolvedValue({}),
}));

const { executeCommand, openExternal, showErrorMessage, Uri, uriParse } =
	vi.hoisted(() => {
		const executeCommand = vi.fn().mockResolvedValue(undefined);
		const showErrorMessage = vi.fn();
		const openExternal = vi.fn().mockResolvedValue(true);

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

		return { executeCommand, openExternal, showErrorMessage, Uri, uriParse };
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
	env: { openExternal },
	window: { showErrorMessage },
	Uri,
}));

vi.mock("../../../cli/src/auth/AuthConfig.js", () => ({
	saveAuthCredentials,
	clearAuthCredentials,
	getJolliUrl,
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
		service = new AuthService();
	});

	// ── handleAuthCallback ──────────────────────────────────────────────

	describe("handleAuthCallback", () => {
		it("should save token and API key atomically on successful callback", async () => {
			const uri = makeUri(
				"/auth-callback",
				"token=test-token&jolli_api_key=sk-jol-test",
			);

			const result = await service.handleAuthCallback(uri as never);

			expect(result).toEqual({ success: true });
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

		it("should save only token when API key is absent", async () => {
			const uri = makeUri("/auth-callback", "token=test-token");

			const result = await service.handleAuthCallback(uri as never);

			expect(result).toEqual({ success: true });
			expect(saveAuthCredentials).toHaveBeenCalledWith({
				token: "test-token",
				jolliApiKey: undefined,
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
			expect(saveAuthCredentials).not.toHaveBeenCalled();
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

		it("should return error when token is missing", async () => {
			const uri = makeUri("/auth-callback", "jolli_api_key=sk-jol-test");

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe("No authentication token received");
			}
			expect(saveAuthCredentials).not.toHaveBeenCalled();
		});

		it("should ignore unknown URI paths", async () => {
			const uri = makeUri("/some-other-path", "token=test-token");

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toBe("Unknown callback path");
			}
			expect(saveAuthCredentials).not.toHaveBeenCalled();
		});

		it("should return error when save fails", async () => {
			saveAuthCredentials.mockRejectedValueOnce(new Error("disk full"));
			const uri = makeUri("/auth-callback", "token=test-token");

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
			const uri = makeUri("/auth-callback", "token=test-token");

			const result = await service.handleAuthCallback(uri as never);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error).toContain("bare string rejection");
			}
		});

		it("should continue returning success when setContext throws", async () => {
			// Covers the log.warn branch in the setContext catch (line 106).
			// executeCommand succeeds for saveAuthCredentials's lifecycle but throws
			// specifically for the setContext call.
			executeCommand.mockImplementationOnce(() => {
				throw new Error("setContext unavailable");
			});
			const uri = makeUri("/auth-callback", "token=test-token");

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
