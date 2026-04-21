import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadGlobalConfig, saveConfig, debug, info } = vi.hoisted(() => ({
	loadGlobalConfig: vi.fn(),
	saveConfig: vi.fn().mockResolvedValue(undefined),
	debug: vi.fn(),
	info: vi.fn(),
}));

vi.mock("../../../cli/src/core/SessionTracker.js", () => ({
	saveConfig,
}));

vi.mock("./WorkspaceUtils.js", () => ({
	loadGlobalConfig,
}));

vi.mock("./Logger.js", () => ({
	log: {
		debug,
		info,
	},
}));

import { ExcludeFilterManager } from "./ExcludeFilterManager.js";

describe("ExcludeFilterManager", () => {
	beforeEach(() => {
		loadGlobalConfig.mockReset();
		saveConfig.mockClear();
		debug.mockClear();
		info.mockClear();
	});

	it("loads patterns from config and reports derived helpers", async () => {
		loadGlobalConfig.mockResolvedValue({
			excludePatterns: ["*.log", "dist/**"],
		});
		const manager = new ExcludeFilterManager();

		await manager.load();

		expect(manager.getPatterns()).toEqual(["*.log", "dist/**"]);
		expect(manager.hasPatterns()).toBe(true);
		expect(manager.toPatternsString()).toBe("*.log, dist/**");
		expect(manager.isExcluded("build.log")).toBe(true);
		expect(manager.isExcluded("dist/output.js")).toBe(true);
		expect(manager.isExcluded("src/App.ts")).toBe(false);
		expect(debug).toHaveBeenCalledWith("ExcludeFilter", "Loaded 2 patterns");
	});

	it("defaults to empty patterns when config has no excludePatterns field", async () => {
		loadGlobalConfig.mockResolvedValue({});
		const manager = new ExcludeFilterManager();

		await manager.load();

		expect(manager.getPatterns()).toEqual([]);
		expect(manager.hasPatterns()).toBe(false);
	});

	it("falls back to an empty pattern list when config loading fails", async () => {
		loadGlobalConfig.mockRejectedValue(new Error("boom"));
		const manager = new ExcludeFilterManager();

		await manager.load();

		expect(manager.getPatterns()).toEqual([]);
		expect(manager.hasPatterns()).toBe(false);
	});

	it("trims and persists new patterns", async () => {
		const manager = new ExcludeFilterManager();

		await manager.setPatterns([" *.tmp ", "", "docs/*.md", "   "]);

		expect(manager.getPatterns()).toEqual(["*.tmp", "docs/*.md"]);
		expect(saveConfig).toHaveBeenCalledWith({
			excludePatterns: ["*.tmp", "docs/*.md"],
		});
		expect(info).toHaveBeenCalledWith("ExcludeFilter", "Saved 2 patterns");
	});
});
