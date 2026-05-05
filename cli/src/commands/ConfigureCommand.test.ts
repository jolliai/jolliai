/**
 * Tests for ConfigureCommand — `jolli configure` copilotEnabled key.
 *
 * Covers:
 *   - copilotEnabled accepted as a settable boolean key
 *   - copilotEnabled appears in --list-keys output
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../Types.js";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────

const { mockLoadConfig, mockSaveConfig } = vi.hoisted(() => ({
	mockLoadConfig: vi.fn(),
	mockSaveConfig: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({
	getGlobalConfigDir: vi.fn().mockReturnValue("/mock/global/config"),
	loadConfig: mockLoadConfig,
	saveConfig: mockSaveConfig,
}));

vi.mock("../core/JolliApiUtils.js", () => ({
	validateJolliApiKey: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Captured config built up from saveConfig calls. */
let savedConfig: Partial<JolliMemoryConfig> = {};

/**
 * Runs `jolli configure` with the given args and returns stdout output.
 * Side effects on savedConfig accumulate across calls (reset in beforeEach).
 */
async function runConfigure(args: string[]): Promise<string> {
	const { registerConfigureCommand } = await import("./ConfigureCommand.js");
	const program = new Command();
	program.exitOverride();
	registerConfigureCommand(program);

	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	});
	try {
		await program.parseAsync(["configure", ...args], { from: "user" });
	} finally {
		spy.mockRestore();
	}
	return lines.join("\n");
}

/**
 * Returns a loadable config object reflecting whatever saveConfig was last
 * called with.  Mimics the real SessionTracker round-trip.
 */
async function loadConfig(): Promise<Partial<JolliMemoryConfig>> {
	return savedConfig;
}

/**
 * Runs `jolli configure --list-keys` and returns the captured output.
 */
async function runConfigureHelp(): Promise<string> {
	return runConfigure(["--list-keys"]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConfigureCommand — copilotEnabled key", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		savedConfig = {};
		mockLoadConfig.mockResolvedValue({});
		// Wire saveConfig to capture what was saved
		mockSaveConfig.mockImplementation(async (update: Partial<JolliMemoryConfig>) => {
			savedConfig = { ...savedConfig, ...update };
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("accepts copilotEnabled as a boolean key", async () => {
		await runConfigure(["--set", "copilotEnabled=true"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ copilotEnabled: true }));
		expect((await loadConfig()).copilotEnabled).toBe(true);

		await runConfigure(["--set", "copilotEnabled=false"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ copilotEnabled: false }));
		expect((await loadConfig()).copilotEnabled).toBe(false);
	});

	it("lists copilotEnabled in help/description output", async () => {
		const help = await runConfigureHelp();
		expect(help).toContain("copilotEnabled");
	});
});
