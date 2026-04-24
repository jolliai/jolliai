import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();

vi.mock("../core/SessionTracker.js", () => ({
	loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
	saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));

import { clearAuthCredentials, getJolliUrl, loadAuthToken, saveAuthCredentials, saveAuthToken } from "./AuthConfig.js";

describe("AuthConfig", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.JOLLI_URL;
		delete process.env.JOLLI_AUTH_TOKEN;
	});

	describe("getJolliUrl", () => {
		it("should return default URL when no env var is set", () => {
			expect(getJolliUrl()).toBe("https://app.jolli.ai");
		});

		it("should return JOLLI_URL env var when set", () => {
			process.env.JOLLI_URL = "https://custom.jolli.ai";
			expect(getJolliUrl()).toBe("https://custom.jolli.ai");
		});

		it("should trim whitespace from JOLLI_URL", () => {
			process.env.JOLLI_URL = "  https://custom.jolli.ai  ";
			expect(getJolliUrl()).toBe("https://custom.jolli.ai");
		});

		it("should return default when JOLLI_URL is empty", () => {
			process.env.JOLLI_URL = "   ";
			expect(getJolliUrl()).toBe("https://app.jolli.ai");
		});

		it("should accept a staging jolli.dev host with trailing slash stripped", () => {
			process.env.JOLLI_URL = "https://staging.jolli.dev/";
			expect(getJolliUrl()).toBe("https://staging.jolli.dev");
		});

		it("should throw when JOLLI_URL points off the allowlist", () => {
			process.env.JOLLI_URL = "https://evil.com";
			expect(() => getJolliUrl()).toThrow(/evil\.com/);
		});

		it("should throw when JOLLI_URL uses http scheme", () => {
			process.env.JOLLI_URL = "http://app.jolli.ai";
			expect(() => getJolliUrl()).toThrow(/Rejected/);
		});
	});

	describe("saveAuthToken", () => {
		it("should save token via saveConfig", async () => {
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthToken("test-token-123");
			expect(mockSaveConfig).toHaveBeenCalledWith({ authToken: "test-token-123" });
		});
	});

	describe("loadAuthToken", () => {
		it("should return env var when JOLLI_AUTH_TOKEN is set", async () => {
			process.env.JOLLI_AUTH_TOKEN = "env-token-abc";
			const token = await loadAuthToken();
			expect(token).toBe("env-token-abc");
			expect(mockLoadConfig).not.toHaveBeenCalled();
		});

		it("should trim JOLLI_AUTH_TOKEN env var", async () => {
			process.env.JOLLI_AUTH_TOKEN = "  env-token-abc  ";
			const token = await loadAuthToken();
			expect(token).toBe("env-token-abc");
		});

		it("should load from config when no env var is set", async () => {
			mockLoadConfig.mockResolvedValue({ authToken: "config-token" });
			const token = await loadAuthToken();
			expect(token).toBe("config-token");
			expect(mockLoadConfig).toHaveBeenCalled();
		});

		it("should return undefined when no token exists", async () => {
			mockLoadConfig.mockResolvedValue({});
			const token = await loadAuthToken();
			expect(token).toBeUndefined();
		});
	});

	describe("clearAuthCredentials", () => {
		it("should clear both authToken and jolliApiKey via saveConfig", async () => {
			mockSaveConfig.mockResolvedValue(undefined);
			await clearAuthCredentials();
			expect(mockSaveConfig).toHaveBeenCalledWith({ authToken: undefined, jolliApiKey: undefined });
		});
	});

	describe("saveAuthCredentials", () => {
		/** Builds a valid new-format sk-jol key whose embedded meta is the given object. */
		function buildNewFormatKey(meta: Record<string, unknown>): string {
			const encoded = Buffer.from(JSON.stringify(meta)).toString("base64url");
			return `sk-jol-${encoded}.secretbytes`;
		}

		// Valid new-format key: meta is {t:"tenant",u:"https://tenant.jolli.ai"} base64url-encoded.
		const VALID_KEY = "sk-jol-eyJ0IjoidGVuYW50IiwidSI6Imh0dHBzOi8vdGVuYW50LmpvbGxpLmFpIn0.secret";

		it("should save both authToken and jolliApiKey in a single saveConfig call", async () => {
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: VALID_KEY });
			expect(mockSaveConfig).toHaveBeenCalledTimes(1);
			expect(mockSaveConfig).toHaveBeenCalledWith({ authToken: "tk-abc", jolliApiKey: VALID_KEY });
		});

		it("should omit jolliApiKey from the write when not provided", async () => {
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc" });
			expect(mockSaveConfig).toHaveBeenCalledWith({ authToken: "tk-abc" });
		});

		it("should omit jolliApiKey when explicitly undefined", async () => {
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: undefined });
			expect(mockSaveConfig).toHaveBeenCalledWith({ authToken: "tk-abc" });
		});

		it("should persist a new-format key whose embedded origin is on the allowlist", async () => {
			mockSaveConfig.mockResolvedValue(undefined);
			const key = buildNewFormatKey({ t: "tenant1", u: "https://tenant1.jolli.ai" });
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: key });
			expect(mockSaveConfig).toHaveBeenCalledWith({ authToken: "tk-abc", jolliApiKey: key });
		});

		it("should reject a new-format key whose embedded origin is off the allowlist", async () => {
			const key = buildNewFormatKey({ t: "x", u: "https://evil.com" });
			await expect(saveAuthCredentials({ token: "tk-abc", jolliApiKey: key })).rejects.toThrow(/evil\.com/);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});

		it("should reject a key that cannot be decoded (wrong prefix)", async () => {
			await expect(saveAuthCredentials({ token: "tk-abc", jolliApiKey: "sf-jol-garbage" })).rejects.toThrow(
				/cannot be decoded/,
			);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});

		it("should reject a legacy-shape key with no embedded meta", async () => {
			await expect(
				saveAuthCredentials({ token: "tk-abc", jolliApiKey: "sk-jol-legacyhex32chars" }),
			).rejects.toThrow(/cannot be decoded/);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});

		it("should reject a key with non-ASCII characters (e.g. pasted garbage)", async () => {
			await expect(
				saveAuthCredentials({ token: "tk-abc", jolliApiKey: "sk-jol-windows大大大大" }),
			).rejects.toThrow(/cannot be decoded/);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		});
	});
});
