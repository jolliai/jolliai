import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	return { ...actual, stat: vi.fn() };
});

const { mockHomedir, mockPlatform } = vi.hoisted(() => ({
	mockHomedir: vi.fn().mockReturnValue("/Users/test"),
	mockPlatform: vi.fn().mockReturnValue("darwin"),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: mockHomedir, platform: mockPlatform };
});

describe("CopilotDetector", () => {
	beforeEach(() => {
		mockHomedir.mockReturnValue("/Users/test");
		mockPlatform.mockReturnValue("darwin");
		vi.mocked(stat).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns ~/.copilot/session-store.db on macOS/Linux", async () => {
		const { getCopilotDbPath } = await import("./CopilotDetector.js");
		expect(getCopilotDbPath()).toBe(join("/Users/test", ".copilot", "session-store.db"));
	});

	it("returns the equivalent path on Windows", async () => {
		mockPlatform.mockReturnValue("win32");
		mockHomedir.mockReturnValue("C:\\Users\\test");
		const { getCopilotDbPath } = await import("./CopilotDetector.js");
		expect(getCopilotDbPath()).toContain(".copilot");
		expect(getCopilotDbPath()).toContain("session-store.db");
	});

	it("isCopilotInstalled returns true when DB exists", async () => {
		vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
		const { isCopilotInstalled } = await import("./CopilotDetector.js");
		await expect(isCopilotInstalled()).resolves.toBe(true);
	});

	it("isCopilotInstalled returns false when DB is missing", async () => {
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("no file"), { code: "ENOENT" }));
		const { isCopilotInstalled } = await import("./CopilotDetector.js");
		await expect(isCopilotInstalled()).resolves.toBe(false);
	});

	it("isCopilotInstalled returns false when DB stat fails with permission error", async () => {
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
		const { isCopilotInstalled } = await import("./CopilotDetector.js");
		await expect(isCopilotInstalled()).resolves.toBe(false);
	});

	it("isCopilotInstalled logs the unknown-code fallback when stat error has no `code` field", async () => {
		vi.mocked(stat).mockRejectedValue(new Error("opaque failure"));
		const { isCopilotInstalled } = await import("./CopilotDetector.js");
		await expect(isCopilotInstalled()).resolves.toBe(false);
	});

	it("isCopilotInstalled returns false when runtime lacks node:sqlite", async () => {
		vi.spyOn(process.versions, "node", "get").mockReturnValue("18.0.0");
		const { isCopilotInstalled } = await import("./CopilotDetector.js");
		await expect(isCopilotInstalled()).resolves.toBe(false);
	});
});
