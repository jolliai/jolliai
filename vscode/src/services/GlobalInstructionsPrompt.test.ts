import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { showInformationMessage } = vi.hoisted(() => ({ showInformationMessage: vi.fn() }));
vi.mock("vscode", () => ({ window: { showInformationMessage } }));

const { loadConfig, saveConfig } = vi.hoisted(() => ({
	loadConfig: vi.fn(),
	saveConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../cli/src/core/SessionTracker.js", () => ({ loadConfig, saveConfig }));

import { maybePromptGlobalInstructions, resetGlobalInstructionsSessionFlagForTests } from "./GlobalInstructionsPrompt.js";

function makeBridge() {
	return { enable: vi.fn().mockResolvedValue({ success: true, message: "ok" }) };
}

beforeEach(() => {
	vi.clearAllMocks();
	resetGlobalInstructionsSessionFlagForTests();
});
afterEach(() => vi.clearAllMocks());

describe("maybePromptGlobalInstructions", () => {
	it("does nothing when the switch is already decided", async () => {
		loadConfig.mockResolvedValue({ globalInstructions: "enabled" });
		await maybePromptGlobalInstructions(makeBridge());
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it("persists 'enabled' and re-runs enable when the user clicks Add", async () => {
		loadConfig.mockResolvedValue({});
		showInformationMessage.mockResolvedValue("Add");
		const bridge = makeBridge();
		await maybePromptGlobalInstructions(bridge);
		expect(saveConfig).toHaveBeenCalledWith({ globalInstructions: "enabled" });
		expect(bridge.enable).toHaveBeenCalledOnce();
	});

	it("persists 'disabled' and does not re-run enable when the user clicks Never", async () => {
		loadConfig.mockResolvedValue({});
		showInformationMessage.mockResolvedValue("Never");
		const bridge = makeBridge();
		await maybePromptGlobalInstructions(bridge);
		expect(saveConfig).toHaveBeenCalledWith({ globalInstructions: "disabled" });
		expect(bridge.enable).not.toHaveBeenCalled();
	});

	it("stays undecided and suppresses re-prompt for the session on dismiss", async () => {
		loadConfig.mockResolvedValue({});
		showInformationMessage.mockResolvedValue(undefined); // dismissed / Not now
		const bridge = makeBridge();
		await maybePromptGlobalInstructions(bridge);
		expect(saveConfig).not.toHaveBeenCalled();

		// Second call in the same session must not prompt again.
		await maybePromptGlobalInstructions(bridge);
		expect(showInformationMessage).toHaveBeenCalledOnce();
	});
});
