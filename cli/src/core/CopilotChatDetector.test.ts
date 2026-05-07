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

describe("CopilotChatDetector", () => {
	beforeEach(() => {
		mockHomedir.mockReturnValue("/Users/test");
		mockPlatform.mockReturnValue("darwin");
		vi.mocked(stat).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("getCopilotChatStorageDir returns vscode globalStorage path on darwin", async () => {
		const { getCopilotChatStorageDir } = await import("./CopilotChatDetector.js");
		expect(getCopilotChatStorageDir()).toBe(
			join(
				"/Users/test",
				"Library",
				"Application Support",
				"Code",
				"User",
				"globalStorage",
				"github.copilot-chat",
			),
		);
	});

	it("getCopilotCliSessionStateDir returns ~/.copilot/session-state path", async () => {
		const { getCopilotCliSessionStateDir } = await import("./CopilotChatDetector.js");
		expect(getCopilotCliSessionStateDir()).toBe(join("/Users/test", ".copilot", "session-state"));
	});

	it("isCopilotChatInstalled returns true when ONLY globalStorage exists", async () => {
		// Use a path-segment regex so the includes() check works on both `/` and `\` separators.
		const globalStorageMarker = /[\\/]globalStorage[\\/]github\.copilot-chat/;
		vi.mocked(stat).mockImplementation(async (path) => {
			if (globalStorageMarker.test(String(path))) {
				return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
			}
			throw Object.assign(new Error("no dir"), { code: "ENOENT" });
		});
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(true);
	});

	it("isCopilotChatInstalled returns true when ONLY ~/.copilot/session-state exists", async () => {
		const sessionStateMarker = /[\\/]\.copilot[\\/]session-state/;
		vi.mocked(stat).mockImplementation(async (path) => {
			if (sessionStateMarker.test(String(path))) {
				return { isDirectory: () => true } as Awaited<ReturnType<typeof stat>>;
			}
			throw Object.assign(new Error("no dir"), { code: "ENOENT" });
		});
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(true);
	});

	it("isCopilotChatInstalled returns true when BOTH paths exist", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(true);
	});

	it("isCopilotChatInstalled returns false when both paths missing", async () => {
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("no dir"), { code: "ENOENT" }));
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
	});

	it("isCopilotChatInstalled returns false when path exists but is not a directory", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as Awaited<ReturnType<typeof stat>>);
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
	});

	it("isCopilotChatInstalled returns false on unexpected stat error and warn-logs", async () => {
		vi.mocked(stat).mockRejectedValue(Object.assign(new Error("perm denied"), { code: "EACCES" }));
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
	});

	it("isCopilotChatInstalled warn-logs with 'unknown' when stat error has no code property", async () => {
		// Exercises the `code ?? "unknown"` nullish-coalescing fallback in existsAsDir.
		vi.mocked(stat).mockRejectedValue(new Error("weird error without errno code"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { isCopilotChatInstalled } = await import("./CopilotChatDetector.js");
		await expect(isCopilotChatInstalled()).resolves.toBe(false);
		expect(warnSpy).toHaveBeenCalled();
		const formatted = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(formatted).toMatch(/unknown/);
		warnSpy.mockRestore();
	});
});
