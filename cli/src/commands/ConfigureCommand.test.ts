/**
 * Tests for ConfigureCommand — `jolli configure` settable keys.
 *
 * Covers:
 *   - copilotEnabled accepted as a settable boolean key
 *   - localFolder accepted as a string path key (CLI-only setup parity)
 *   - aiProvider accepted as the "anthropic" | "jolli" enum, rejected otherwise
 *   - All three keys appear in --list-keys output
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

describe("ConfigureCommand — settable keys", () => {
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

	it("accepts localFolder as a string path key", async () => {
		// CLI-only setups (no VS Code Settings panel) need a way to point Memory
		// Bank at a folder; without this key the only option was hand-editing
		// config.json, which silently bypasses any future validation.
		await runConfigure(["--set", "localFolder=/tmp/jolli-memory-bank"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ localFolder: "/tmp/jolli-memory-bank" }));
		expect((await loadConfig()).localFolder).toBe("/tmp/jolli-memory-bank");
	});

	it("accepts aiProvider with the two allowed values", async () => {
		await runConfigure(["--set", "aiProvider=anthropic"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ aiProvider: "anthropic" }));

		await runConfigure(["--set", "aiProvider=jolli"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ aiProvider: "jolli" }));
	});

	it("rejects aiProvider values that aren't in the allowlist", async () => {
		// Without this guard, `jolli configure --set aiProvider=openai` would
		// silently corrupt the config — `resolveLlmCredentialSource` ignores
		// unknown values, so commits would fall back to legacy precedence
		// while the user thinks they switched providers.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const prevExitCode = process.exitCode;
		try {
			await runConfigure(["--set", "aiProvider=openai"]);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("anthropic, jolli"));
			expect(process.exitCode).toBe(1);
			expect(mockSaveConfig).not.toHaveBeenCalled();
		} finally {
			errorSpy.mockRestore();
			process.exitCode = prevExitCode;
		}
	});

	it("removes localFolder and aiProvider via --remove", async () => {
		// --remove writes `undefined` for the field, which saveConfig drops
		// from the persisted JSON — this is what an "unset" looks like on disk.
		await runConfigure(["--remove", "localFolder", "--remove", "aiProvider"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(
			expect.objectContaining({ localFolder: undefined, aiProvider: undefined }),
		);
	});

	it("lists copilotEnabled, localFolder, and aiProvider in help/description output", async () => {
		const help = await runConfigureHelp();
		expect(help).toContain("copilotEnabled");
		expect(help).toContain("localFolder");
		expect(help).toContain("aiProvider");
	});
});
