import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ saveConfig: vi.fn(), syncGlobalInstructions: vi.fn() }));
vi.mock("../../core/SessionTracker.js", () => ({ saveConfig: m.saveConfig }));
vi.mock("../../install/Installer.js", () => ({ syncGlobalInstructions: m.syncGlobalInstructions }));

import { applySetting } from "./SettingsWrite.js";

beforeEach(() => vi.clearAllMocks());

describe("applySetting", () => {
	it("persists a plain field without side effects", async () => {
		await applySetting("aiProvider", "jolli");
		expect(m.saveConfig).toHaveBeenCalledWith({ aiProvider: "jolli" });
		expect(m.syncGlobalInstructions).not.toHaveBeenCalled();
	});

	it("runs syncGlobalInstructions after saving globalInstructions", async () => {
		await applySetting("globalInstructions", "enabled");
		expect(m.saveConfig).toHaveBeenCalledWith({ globalInstructions: "enabled" });
		expect(m.syncGlobalInstructions).toHaveBeenCalledTimes(1);
	});
});
