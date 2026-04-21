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
		it("should save both authToken and jolliApiKey in a single saveConfig call", async () => {
			mockSaveConfig.mockResolvedValue(undefined);
			await saveAuthCredentials({ token: "tk-abc", jolliApiKey: "sk-jol-xyz" });
			expect(mockSaveConfig).toHaveBeenCalledTimes(1);
			expect(mockSaveConfig).toHaveBeenCalledWith({ authToken: "tk-abc", jolliApiKey: "sk-jol-xyz" });
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
	});
});
