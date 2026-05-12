import { describe, expect, it, vi } from "vitest";

const { mockPlatform, mockSpawnSync } = vi.hoisted(() => ({
	mockPlatform: vi.fn().mockReturnValue("linux"),
	mockSpawnSync: vi.fn().mockReturnValue({ status: 0 }),
}));

vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, platform: mockPlatform };
});

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return { ...original, spawnSync: mockSpawnSync };
});

describe("tryMarkHiddenOnWindows", () => {
	it("is a no-op on linux", async () => {
		mockPlatform.mockReturnValue("linux");
		mockSpawnSync.mockClear();
		const { tryMarkHiddenOnWindows } = await import("./WindowsHidden.js");
		tryMarkHiddenOnWindows("/some/path");
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});

	it("is a no-op on darwin", async () => {
		mockPlatform.mockReturnValue("darwin");
		mockSpawnSync.mockClear();
		const { tryMarkHiddenOnWindows } = await import("./WindowsHidden.js");
		tryMarkHiddenOnWindows("/some/path");
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});

	it("spawns `attrib +h` with windowsHide and a timeout on win32", async () => {
		mockPlatform.mockReturnValue("win32");
		mockSpawnSync.mockClear();
		mockSpawnSync.mockReturnValueOnce({ status: 0 });
		const { tryMarkHiddenOnWindows } = await import("./WindowsHidden.js");
		tryMarkHiddenOnWindows("C:\\Users\\test\\.jolli");
		expect(mockSpawnSync).toHaveBeenCalledWith(
			"attrib",
			["+h", "C:\\Users\\test\\.jolli"],
			expect.objectContaining({ windowsHide: true, timeout: 2000 }),
		);
	});

	it("swallows spawnSync errors on win32", async () => {
		mockPlatform.mockReturnValue("win32");
		mockSpawnSync.mockImplementationOnce(() => {
			throw new Error("simulated");
		});
		const { tryMarkHiddenOnWindows } = await import("./WindowsHidden.js");
		expect(() => tryMarkHiddenOnWindows("C:\\fake")).not.toThrow();
	});
});
