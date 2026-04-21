import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("__PKG_VERSION__", "1.0.0");

const mockExistsSync = vi.fn();
const mockInstallDistPath = vi.fn().mockResolvedValue(true);
const mockInstallResolveScripts = vi.fn().mockResolvedValue(true);
const mockMigrateLegacy = vi.fn().mockResolvedValue(false);

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: mockExistsSync };
});

vi.mock("./install/Installer.js", () => ({
	installDistPath: mockInstallDistPath,
	installHookScripts: mockInstallResolveScripts,
}));

vi.mock("./install/DistPathResolver.js", () => ({
	migrateLegacyDistPath: mockMigrateLegacy,
}));

describe("PostInstall", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(false);
	});

	async function runPostInstall(): Promise<void> {
		vi.resetModules();
		vi.stubGlobal("__PKG_VERSION__", "1.0.0");
		await import("./PostInstall.js");
		await new Promise((r) => setTimeout(r, 50));
	}

	it("should do nothing when neither dist-paths/ nor legacy dist-path exists", async () => {
		mockExistsSync.mockReturnValue(false);
		await runPostInstall();
		expect(mockInstallDistPath).not.toHaveBeenCalled();
		expect(mockInstallResolveScripts).not.toHaveBeenCalled();
		expect(mockMigrateLegacy).not.toHaveBeenCalled();
	});

	it("should refresh resolve scripts AND write dist-paths/cli when dist-paths/ exists", async () => {
		mockExistsSync.mockImplementation((p: string) => p.endsWith("dist-paths"));
		await runPostInstall();
		expect(mockInstallResolveScripts).toHaveBeenCalledTimes(1);
		expect(mockInstallDistPath).toHaveBeenCalledTimes(1);
		expect(mockInstallDistPath).toHaveBeenCalledWith("cli", expect.any(String));
	});

	it("should refresh resolve scripts AND write dist-paths/cli when only legacy dist-path exists", async () => {
		mockExistsSync.mockImplementation((p: string) => p.endsWith("dist-path"));
		await runPostInstall();
		expect(mockInstallResolveScripts).toHaveBeenCalledTimes(1);
		expect(mockInstallDistPath).toHaveBeenCalledTimes(1);
		expect(mockInstallDistPath).toHaveBeenCalledWith("cli", expect.any(String));
	});

	it("should call migrateLegacyDistPath before writing dist-paths/cli", async () => {
		mockExistsSync.mockImplementation((p: string) => p.endsWith("dist-path"));
		const callOrder: string[] = [];
		mockMigrateLegacy.mockImplementation(async () => {
			callOrder.push("migrate");
			return true;
		});
		mockInstallDistPath.mockImplementation(async () => {
			callOrder.push("installDistPath");
			return true;
		});
		await runPostInstall();
		expect(mockMigrateLegacy).toHaveBeenCalledTimes(1);
		expect(callOrder).toEqual(["migrate", "installDistPath"]);
	});

	it("should not crash when migrateLegacyDistPath rejects", async () => {
		mockExistsSync.mockReturnValue(true);
		mockMigrateLegacy.mockRejectedValueOnce(new Error("migration failed"));
		await runPostInstall();
		// main() catches all errors — test passes if no unhandled rejection escapes
	});

	it("should not crash when installDistPath rejects", async () => {
		mockExistsSync.mockReturnValue(true);
		mockInstallDistPath.mockRejectedValueOnce(new Error("disk full"));
		await runPostInstall();
		// Test passes if no unhandled rejection escapes (main() catches errors)
	});

	it("should not crash when installHookScripts rejects", async () => {
		mockExistsSync.mockReturnValue(true);
		mockInstallResolveScripts.mockRejectedValueOnce(new Error("permission denied"));
		await runPostInstall();
		// Test passes if no unhandled rejection escapes
	});
});
