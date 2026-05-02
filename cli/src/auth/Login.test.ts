import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSaveAuthCredentials = vi.fn();
const mockLoadConfig = vi.fn();
const mockExchangeCliCode = vi.fn();

vi.mock("./AuthConfig.js", () => ({
	saveAuthCredentials: (...args: unknown[]) => mockSaveAuthCredentials(...args),
}));

vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("./CliExchange.js", () => ({
	exchangeCliCode: (...args: unknown[]) => mockExchangeCliCode(...args),
}));

const mockOpen = vi.fn();
vi.mock("open", () => ({
	default: (...args: unknown[]) => mockOpen(...args),
}));

import { browserLogin, createLoginServer } from "./Login.js";

const TEST_JOLLI_URL = "https://app.jolli.ai";

describe("Login", () => {
	let server: Server | null = null;

	beforeEach(() => {
		vi.clearAllMocks();
		mockSaveAuthCredentials.mockResolvedValue(undefined);
		mockLoadConfig.mockResolvedValue({});
		// Default: exchange succeeds with token only. Tests override per-call.
		mockExchangeCliCode.mockResolvedValue({ token: "tk-default" });
	});

	afterEach(() => {
		if (server) {
			server.close();
			server = null;
		}
	});

	it("redeems the code and saves the resulting token on a successful callback", async () => {
		mockExchangeCliCode.mockResolvedValueOnce({ token: "tk-abc" });

		await new Promise<void>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?code=code-abc`);
				},
				onSuccess: resolve,
				onError: reject,
			});
		});

		expect(mockExchangeCliCode).toHaveBeenCalledWith(TEST_JOLLI_URL, "code-abc");
		expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "tk-abc" });
	});

	it("forwards a jolliApiKey from the exchange to saveAuthCredentials", async () => {
		mockExchangeCliCode.mockResolvedValueOnce({ token: "tk-1", jolliApiKey: "sk-jol-xyz" });

		await new Promise<void>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?code=code-1`);
				},
				onSuccess: resolve,
				onError: reject,
			});
		});

		expect(mockSaveAuthCredentials).toHaveBeenCalledTimes(1);
		expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "tk-1", jolliApiKey: "sk-jol-xyz" });
	});

	it("omits jolliApiKey from the save call when the exchange did not return one", async () => {
		mockExchangeCliCode.mockResolvedValueOnce({ token: "tk-bare" });

		await new Promise<void>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?code=code-bare`);
				},
				onSuccess: resolve,
				onError: reject,
			});
		});

		expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "tk-bare" });
	});

	it("surfaces a server-reported error code as a friendly message", async () => {
		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?error=oauth_failed`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toBe("OAuth authentication failed. Please try again.");
		expect(mockExchangeCliCode).not.toHaveBeenCalled();
	});

	it("maps user_denied to a cancellation message and skips the exchange", async () => {
		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?error=user_denied`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toContain("Sign-in was cancelled");
		expect(mockExchangeCliCode).not.toHaveBeenCalled();
	});

	it("falls back to a generic message for unknown error codes", async () => {
		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?error=unknown_error`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toBe("Authentication error: unknown_error");
	});

	it("rejects when the callback arrives without a code or token", async () => {
		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toBe("No authorization code or token received");
		expect(mockExchangeCliCode).not.toHaveBeenCalled();
	});

	// ── Legacy token-in-URL fallback ──────────────────────────────────────
	// Compatibility window for users on the latest CLI whose Jolli server
	// hasn't shipped JOLLI-1270 yet. Once all server tenants emit `?code=`
	// callbacks, this whole describe block (and the matching branch in
	// createLoginServer) can be deleted.

	describe("legacy token-in-URL fallback", () => {
		// Silence the warn we emit on every legacy callback — it's exercised
		// explicitly by the dedicated assertion below.
		let warnSpy: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		});
		afterEach(() => {
			warnSpy.mockRestore();
		});

		it("accepts a legacy callback with token + jolli_api_key", async () => {
			await new Promise<void>((resolve, reject) => {
				server = createLoginServer({
					port: 0,
					jolliUrl: TEST_JOLLI_URL,
					onListen() {
						const addr = server?.address();
						if (!addr || typeof addr === "string") {
							reject(new Error("No address"));
							return;
						}
						fetch(`http://127.0.0.1:${addr.port}/callback?token=legacy-tk&jolli_api_key=sk-jol-legacy`);
					},
					onSuccess: resolve,
					onError: reject,
				});
			});

			// No exchange call — old-server callback delivers the token directly.
			expect(mockExchangeCliCode).not.toHaveBeenCalled();
			expect(mockSaveAuthCredentials).toHaveBeenCalledWith({
				token: "legacy-tk",
				jolliApiKey: "sk-jol-legacy",
			});
		});

		it("accepts a legacy token-only callback (no jolli_api_key)", async () => {
			await new Promise<void>((resolve, reject) => {
				server = createLoginServer({
					port: 0,
					jolliUrl: TEST_JOLLI_URL,
					onListen() {
						const addr = server?.address();
						if (!addr || typeof addr === "string") {
							reject(new Error("No address"));
							return;
						}
						fetch(`http://127.0.0.1:${addr.port}/callback?token=legacy-tk-2`);
					},
					onSuccess: resolve,
					onError: reject,
				});
			});

			expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "legacy-tk-2" });
		});

		it("emits a warn log so residual old-server traffic is observable", async () => {
			await new Promise<void>((resolve, reject) => {
				server = createLoginServer({
					port: 0,
					jolliUrl: TEST_JOLLI_URL,
					onListen() {
						const addr = server?.address();
						if (!addr || typeof addr === "string") {
							reject(new Error("No address"));
							return;
						}
						fetch(`http://127.0.0.1:${addr.port}/callback?token=legacy-tk`);
					},
					onSuccess: resolve,
					onError: reject,
				});
			});

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("legacy token-in-URL"));
		});

		it("prefers code over token when a misconfigured server emits both", async () => {
			// Code wins because the credential takes a more private path
			// (server→server JSON body vs. URL string). If a server ever ships
			// a hybrid response, we don't want to silently downgrade users.
			mockExchangeCliCode.mockResolvedValueOnce({ token: "exchanged-tk" });

			await new Promise<void>((resolve, reject) => {
				server = createLoginServer({
					port: 0,
					jolliUrl: TEST_JOLLI_URL,
					onListen() {
						const addr = server?.address();
						if (!addr || typeof addr === "string") {
							reject(new Error("No address"));
							return;
						}
						fetch(
							`http://127.0.0.1:${addr.port}/callback?code=abc&token=ignored&jolli_api_key=sk-jol-ignored`,
						);
					},
					onSuccess: resolve,
					onError: reject,
				});
			});

			expect(mockExchangeCliCode).toHaveBeenCalledWith(TEST_JOLLI_URL, "abc");
			expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "exchanged-tk" });
		});

		it("propagates a save failure from the legacy path", async () => {
			// `saveAuthCredentials` calls `validateJolliApiKey` internally — a
			// malformed `jolli_api_key` from a legacy server reaches us here as
			// a thrown Error and must surface through onError, not silently succeed.
			mockSaveAuthCredentials.mockRejectedValueOnce(new Error("invalid jolli api key"));

			const error = await new Promise<Error>((resolve, reject) => {
				server = createLoginServer({
					port: 0,
					jolliUrl: TEST_JOLLI_URL,
					onListen() {
						const addr = server?.address();
						if (!addr || typeof addr === "string") {
							reject(new Error("No address"));
							return;
						}
						fetch(`http://127.0.0.1:${addr.port}/callback?token=legacy-tk&jolli_api_key=garbage`);
					},
					onSuccess: () => reject(new Error("Should not succeed")),
					onError: resolve,
				});
			});

			expect(error.message).toBe("invalid jolli api key");
		});
	});

	it("returns 404 for non-callback paths", async () => {
		let responseStatus = 0;

		server = createLoginServer({
			port: 0,
			jolliUrl: TEST_JOLLI_URL,
			onListen() {
				const addr = server?.address();
				if (!addr || typeof addr === "string") return;
				fetch(`http://127.0.0.1:${addr.port}/other`).then((res) => {
					responseStatus = res.status;
				});
			},
			onSuccess: vi.fn(),
			onError: vi.fn(),
		});

		// Give the request time to complete
		await new Promise((r) => setTimeout(r, 100));
		expect(responseStatus).toBe(404);
	});

	it("propagates an exchange failure as the onError reason", async () => {
		mockExchangeCliCode.mockRejectedValueOnce(
			new Error("Sign-in code expired or already used. Please try signing in again."),
		);

		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?code=code-expired`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toContain("expired or already used");
		expect(mockSaveAuthCredentials).not.toHaveBeenCalled();
	});

	it("wraps non-Error throws from the exchange", async () => {
		mockExchangeCliCode.mockRejectedValueOnce("plain string from fetch layer");

		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?code=code-1`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toBe("plain string from fetch layer");
	});

	it("propagates a saveAuthCredentials failure as the onError reason", async () => {
		mockSaveAuthCredentials.mockRejectedValueOnce(new Error("Write failed"));

		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?code=code-1`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toBe("Write failed");
	});

	it("wraps non-Error throws from saveAuthCredentials", async () => {
		mockSaveAuthCredentials.mockRejectedValueOnce("plain string error");

		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?code=code-1`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toBe("plain string error");
	});

	it("maps every known error code to a friendly message", async () => {
		const errorCodes: Record<string, string> = {
			oauth_failed: "OAuth authentication failed. Please try again.",
			session_missing: "Session expired or missing. Please try again.",
			invalid_provider: "Invalid authentication provider.",
			auth_fetch_failed: "Failed to fetch user information from the authentication provider.",
			no_verified_emails: "No verified email addresses found on your account.",
			server_error: "An unexpected server error occurred. Please try again later.",
			failed_to_get_token: "We couldn't retrieve your credentials. Please try signing in again.",
			user_denied: "Sign-in was cancelled. You can try again with `jolli auth login`.",
			invalid_callback: "The sign-in callback was rejected by the server. Please try again.",
		};

		for (const [code, expectedMessage] of Object.entries(errorCodes)) {
			const error = await new Promise<Error>((resolve, reject) => {
				server = createLoginServer({
					port: 0,
					jolliUrl: TEST_JOLLI_URL,
					onListen() {
						const addr = server?.address();
						if (!addr || typeof addr === "string") {
							reject(new Error("No address"));
							return;
						}
						fetch(`http://127.0.0.1:${addr.port}/callback?error=${code}`);
					},
					onSuccess: () => reject(new Error("Should not succeed")),
					onError: resolve,
				});
			});

			expect(error.message).toBe(expectedMessage);
			server?.close();
			server = null;
		}
	});

	it("calls onError when the server fails to bind to the chosen port", async () => {
		// Occupy a port, then try to bind to it. Wait for blocker to actually
		// be listening before reading .address() — listen() is async, so reading
		// synchronously after createLoginServer can race and yield port 0.
		const blocker = await new Promise<Server>((resolve) => {
			const s = createLoginServer({
				port: 0,
				jolliUrl: TEST_JOLLI_URL,
				onListen: () => resolve(s),
				onSuccess: vi.fn(),
				onError: vi.fn(),
			});
		});
		const blockerAddr = blocker.address();
		const blockerPort = typeof blockerAddr === "object" && blockerAddr ? blockerAddr.port : 0;

		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: blockerPort,
				jolliUrl: TEST_JOLLI_URL,
				onListen: () => reject(new Error("Should not listen")),
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toContain("EADDRINUSE");
		blocker.close();
	});

	describe("browserLogin", () => {
		/**
		 * Simulates a browser: extracts cli_callback from the opened URL and
		 * sends a callback with the supplied code. The exchange step itself is
		 * stubbed via `mockExchangeCliCode`, so the test only asserts the URL
		 * round-trip.
		 */
		function simulateBrowserCallback(code: string) {
			return (url: string) => {
				const callbackUrl = new URL(url).searchParams.get("cli_callback");
				if (callbackUrl) {
					fetch(`${callbackUrl}?code=${code}`);
				}
				return { unref: vi.fn() };
			};
		}

		it("opens the browser to <jolliUrl>/login with generate_api_key when no jolliApiKey is set", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockExchangeCliCode.mockResolvedValue({ token: "browser-token" });
			mockOpen.mockImplementation(simulateBrowserCallback("browser-code"));

			await browserLogin(TEST_JOLLI_URL);

			const openedUrl = mockOpen.mock.calls[0][0] as string;
			expect(openedUrl).toContain("https://app.jolli.ai/login?");
			expect(openedUrl).toContain("generate_api_key=true");
			expect(openedUrl).toContain("client=cli");
			expect(mockExchangeCliCode).toHaveBeenCalledWith(TEST_JOLLI_URL, "browser-code");
			expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "browser-token" });
		});

		it("omits generate_api_key when a jolliApiKey is already configured", async () => {
			mockLoadConfig.mockResolvedValue({ jolliApiKey: "jk_existing" });
			mockExchangeCliCode.mockResolvedValue({ token: "browser-token-2" });
			mockOpen.mockImplementation(simulateBrowserCallback("browser-code-2"));

			await browserLogin(TEST_JOLLI_URL);

			const openUrl = mockOpen.mock.calls[0][0] as string;
			expect(openUrl).not.toContain("generate_api_key");
			expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "browser-token-2" });
		});

		it("rejects when open() throws (e.g. headless server)", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockOpen.mockRejectedValue(new Error("No browser available"));

			await expect(browserLogin(TEST_JOLLI_URL)).rejects.toThrow("No browser available");
		});

		it("rejects with a wrapped error when open() throws a non-Error", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockOpen.mockRejectedValue("string error");

			await expect(browserLogin(TEST_JOLLI_URL)).rejects.toThrow("string error");
		});
	});
});
