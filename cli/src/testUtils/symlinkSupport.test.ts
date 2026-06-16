import { afterEach, describe, expect, it, vi } from "vitest";

describe("canCreateSymlinks", () => {
	afterEach(() => {
		vi.doUnmock("node:fs");
		vi.resetModules();
	});

	it("returns true when symlinkSync succeeds", async () => {
		vi.resetModules();
		vi.doMock("node:fs", () => ({
			mkdtempSync: () => "/tmp/jolli-symlink-probe-xyz",
			writeFileSync: () => {},
			symlinkSync: () => {},
			rmSync: () => {},
		}));
		const { canCreateSymlinks } = await import("./symlinkSupport.js");
		expect(canCreateSymlinks()).toBe(true);
	});

	it("returns false when symlinkSync throws (EPERM on a non-elevated Windows account)", async () => {
		vi.resetModules();
		vi.doMock("node:fs", () => ({
			mkdtempSync: () => "/tmp/jolli-symlink-probe-xyz",
			writeFileSync: () => {},
			symlinkSync: () => {
				throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
			},
			rmSync: () => {},
		}));
		const { canCreateSymlinks } = await import("./symlinkSupport.js");
		expect(canCreateSymlinks()).toBe(false);
	});

	it("exposes a boolean snapshot via symlinksSupported", async () => {
		const mod = await import("./symlinkSupport.js");
		expect(typeof mod.symlinksSupported).toBe("boolean");
	});
});
