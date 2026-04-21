import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSaveAuthCredentials = vi.fn();
const mockLoadConfig = vi.fn();

vi.mock("./AuthConfig.js", () => ({
	saveAuthCredentials: (...args: unknown[]) => mockSaveAuthCredentials(...args),
}));

vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

const mockOpen = vi.fn();
vi.mock("open", () => ({
	default: (...args: unknown[]) => mockOpen(...args),
}));

import { browserLogin, createLoginServer } from "./Login.js";

describe("Login", () => {
	let server: Server | null = null;

	beforeEach(() => {
		vi.clearAllMocks();
		mockSaveAuthCredentials.mockResolvedValue(undefined);
		mockLoadConfig.mockResolvedValue({});
	});

	afterEach(() => {
		if (server) {
			server.close();
			server = null;
		}
	});

	it("should save token on successful callback", async () => {
		const result = await new Promise<void>((resolve, reject) => {
			server = createLoginServer({
				port: 0, // random available port
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?token=test-token-abc`);
				},
				onSuccess: resolve,
				onError: reject,
			});
		});

		expect(result).toBeUndefined();
		expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "test-token-abc", jolliApiKey: undefined });
	});

	it("should save apiKey when provided in callback", async () => {
		await new Promise<void>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?token=tok&jolli_api_key=jk_test_key`);
				},
				onSuccess: resolve,
				onError: reject,
			});
		});

		expect(mockSaveAuthCredentials).toHaveBeenCalledTimes(1);
		expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "tok", jolliApiKey: "jk_test_key" });
	});

	it("should not save apiKey when not provided", async () => {
		await new Promise<void>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?token=tok`);
				},
				onSuccess: resolve,
				onError: reject,
			});
		});

		expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "tok", jolliApiKey: undefined });
	});

	it("should handle error parameter", async () => {
		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
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
	});

	it("should handle unknown error codes", async () => {
		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
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

	it("should handle missing token", async () => {
		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
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

		expect(error.message).toBe("No token received");
	});

	it("should return 404 for non-callback paths", async () => {
		let responseStatus = 0;

		server = createLoginServer({
			port: 0,
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

	it("should handle saveAuthCredentials failure", async () => {
		mockSaveAuthCredentials.mockRejectedValueOnce(new Error("Write failed"));

		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?token=test`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toBe("Write failed");
	});

	it("should wrap non-Error throws from saveAuthCredentials", async () => {
		mockSaveAuthCredentials.mockRejectedValueOnce("plain string error");

		const error = await new Promise<Error>((resolve, reject) => {
			server = createLoginServer({
				port: 0,
				onListen() {
					const addr = server?.address();
					if (!addr || typeof addr === "string") {
						reject(new Error("No address"));
						return;
					}
					fetch(`http://127.0.0.1:${addr.port}/callback?token=test`);
				},
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toBe("plain string error");
	});

	it("should handle all known error codes", async () => {
		const errorCodes: Record<string, string> = {
			oauth_failed: "OAuth authentication failed. Please try again.",
			session_missing: "Session expired or missing. Please try again.",
			invalid_provider: "Invalid authentication provider.",
			auth_fetch_failed: "Failed to fetch user information from the authentication provider.",
			no_verified_emails: "No verified email addresses found on your account.",
			server_error: "An unexpected server error occurred. Please try again later.",
			failed_to_get_token: "We couldn't retrieve your credentials. Please try signing in again.",
		};

		for (const [code, expectedMessage] of Object.entries(errorCodes)) {
			const error = await new Promise<Error>((resolve, reject) => {
				server = createLoginServer({
					port: 0,
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

	it("should call onError when server fails to bind", async () => {
		// Occupy a port, then try to bind to it. Wait for blocker to actually
		// be listening before reading .address() — listen() is async, so reading
		// synchronously after createLoginServer can race and yield port 0.
		const blocker = await new Promise<Server>((resolve) => {
			const s = createLoginServer({
				port: 0,
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
				onListen: () => reject(new Error("Should not listen")),
				onSuccess: () => reject(new Error("Should not succeed")),
				onError: resolve,
			});
		});

		expect(error.message).toContain("EADDRINUSE");
		blocker.close();
	});

	describe("browserLogin", () => {
		/** Simulates a browser: extracts cli_callback from the opened URL and fetches it with a token. */
		function simulateBrowserCallback(token: string) {
			return (url: string) => {
				const callbackUrl = new URL(url).searchParams.get("cli_callback");
				if (callbackUrl) {
					fetch(`${callbackUrl}?token=${token}`);
				}
				return { unref: vi.fn() };
			};
		}

		it("should open browser with generate_api_key when no jolliApiKey", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockOpen.mockImplementation(simulateBrowserCallback("browser-token"));

			await browserLogin("https://app.jolli.ai/login");

			expect(mockOpen).toHaveBeenCalledWith(expect.stringContaining("generate_api_key=true"));
			expect(mockOpen).toHaveBeenCalledWith(expect.stringContaining("client=cli"));
			expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "browser-token", jolliApiKey: undefined });
		});

		it("should open browser without generate_api_key when jolliApiKey exists", async () => {
			mockLoadConfig.mockResolvedValue({ jolliApiKey: "jk_existing" });
			mockOpen.mockImplementation(simulateBrowserCallback("browser-token-2"));

			await browserLogin("https://app.jolli.ai/login");

			const openUrl = mockOpen.mock.calls[0][0] as string;
			expect(openUrl).not.toContain("generate_api_key");
			expect(mockSaveAuthCredentials).toHaveBeenCalledWith({ token: "browser-token-2", jolliApiKey: undefined });
		});

		it("should reject when open() throws (e.g. headless server)", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockOpen.mockRejectedValue(new Error("No browser available"));

			await expect(browserLogin("https://app.jolli.ai/login")).rejects.toThrow("No browser available");
		});

		it("should reject with wrapped error when open() throws a non-Error", async () => {
			mockLoadConfig.mockResolvedValue({});
			mockOpen.mockRejectedValue("string error");

			await expect(browserLogin("https://app.jolli.ai/login")).rejects.toThrow("string error");
		});
	});
});
