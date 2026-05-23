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

	describe("maxTokens validation (positive integer only)", () => {
		async function expectMaxTokensRejected(value: string): Promise<void> {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prev = process.exitCode;
			try {
				await runConfigure(["--set", `maxTokens=${value}`]);
				expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/positive integer/));
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prev;
			}
		}

		it("accepts a positive integer value", async () => {
			await runConfigure(["--set", "maxTokens=8192"]);
			expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 8192 }));
		});

		it("rejects a fractional value", async () => {
			await expectMaxTokensRejected("4096.5");
		});

		it("rejects non-numeric input (no silent parseInt-style truncation)", async () => {
			// `Number("8192abc")` is NaN, NOT 8192 — guarding against the
			// classic parseInt pitfall.
			await expectMaxTokensRejected("8192abc");
		});

		it("rejects zero / negative values", async () => {
			await expectMaxTokensRejected("0");
			await expectMaxTokensRejected("-1");
		});
	});

	describe("syncEnabled / syncTranscripts boolean coercion via --set", () => {
		it("accepts true/false/yes/no/1/0 forms for syncEnabled", async () => {
			for (const truthy of ["true", "yes", "1"]) {
				mockSaveConfig.mockClear();
				await runConfigure(["--set", `syncEnabled=${truthy}`]);
				expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncEnabled: true }));
			}
			for (const falsy of ["false", "no", "0"]) {
				mockSaveConfig.mockClear();
				await runConfigure(["--set", `syncEnabled=${falsy}`]);
				expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncEnabled: false }));
			}
		});

		it("rejects garbage boolean values", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prev = process.exitCode;
			try {
				await runConfigure(["--set", "syncEnabled=maybe"]);
				expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/true\/false/));
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prev;
			}
		});

		it("accepts a string-coerced boolean for syncTranscripts as well", async () => {
			await runConfigure(["--set", "syncTranscripts=true"]);
			expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncTranscripts: true }));
		});
	});

	describe("syncPollIntervalSec validation", () => {
		// `--set syncPollIntervalSec=N` accepts only positive integers in
		// [5400, 86400] (90 min – 24 h). Anything outside that window would
		// either hammer the backend or park the engine.
		async function expectSetRejected(value: string, errMatch: RegExp | string): Promise<void> {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prev = process.exitCode;
			try {
				await runConfigure(["--set", `syncPollIntervalSec=${value}`]);
				const calls = errorSpy.mock.calls.map((c) => String(c[0]));
				const joined = calls.join("\n");
				expect(joined).toMatch(errMatch);
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prev;
			}
		}

		it("accepts a value in the [5400, 86400] window", async () => {
			await runConfigure(["--set", "syncPollIntervalSec=5400"]);
			expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncPollIntervalSec: 5400 }));
		});

		it("rejects non-integer values", async () => {
			await expectSetRejected("60.5", /positive integer/);
		});

		it("rejects non-numeric input", async () => {
			await expectSetRejected("ninety-min", /positive integer/);
		});

		it("rejects values below the 5400 floor (would push too often)", async () => {
			await expectSetRejected("60", /at least 5400/);
		});

		it("rejects values above the 86400 ceiling (would park sync for too long)", async () => {
			await expectSetRejected("99999", /at most 86400/);
		});

		it("rejects zero / negative values (must be positive)", async () => {
			await expectSetRejected("0", /positive integer/);
			await expectSetRejected("-30", /positive integer/);
		});
	});

	describe("--sync-enable / --sync-disable shortcuts", () => {
		it("--sync-enable sets syncEnabled=true and prints the reload hint", async () => {
			const out = await runConfigure(["--sync-enable"]);
			expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncEnabled: true }));
			expect(out).toContain("ENABLED");
		});

		it("--sync-disable sets syncEnabled=undefined and notes manual sync still works", async () => {
			const out = await runConfigure(["--sync-disable"]);
			expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncEnabled: undefined }));
			expect(out).toContain("DISABLED");
		});

		it("rejects --sync-enable AND --sync-disable together (mutually exclusive)", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prevExitCode = process.exitCode;
			try {
				await runConfigure(["--sync-enable", "--sync-disable"]);
				expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("mutually exclusive"));
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prevExitCode;
			}
		});
	});
});
