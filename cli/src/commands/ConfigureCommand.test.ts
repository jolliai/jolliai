/**
 * Tests for ConfigureCommand — `jolli configure` settable keys.
 *
 * Covers:
 *   - copilotEnabled accepted as a settable boolean key
 *   - localFolder accepted as a string path key (CLI-only setup parity)
 *   - aiProvider accepted as the "anthropic" | "jolli" enum, rejected otherwise
 *   - globalInstructions accepted as the "enabled" | "disabled" enum, rejected otherwise
 *   - All keys appear in --list-keys output
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../Types.js";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────

const { mockLoadConfig, mockSaveConfig, mockSyncGlobalInstructions } = vi.hoisted(() => ({
	mockLoadConfig: vi.fn(),
	mockSaveConfig: vi.fn(),
	mockSyncGlobalInstructions: vi.fn(),
}));

vi.mock("../core/SessionTracker.js", () => ({
	getGlobalConfigDir: vi.fn().mockReturnValue("/mock/global/config"),
	loadConfig: mockLoadConfig,
	saveConfig: mockSaveConfig,
}));

vi.mock("../core/JolliApiUtils.js", () => ({
	validateJolliApiKey: vi.fn(),
}));

// Configure applies a globalInstructions change immediately via syncGlobalInstructions.
// Stub it so the test never touches the real installer / global instruction files.
vi.mock("../install/Installer.js", () => ({
	syncGlobalInstructions: mockSyncGlobalInstructions,
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

	it("accepts syncOnPush as a boolean key", async () => {
		await runConfigure(["--set", "syncOnPush=false"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncOnPush: false }));
		expect((await loadConfig()).syncOnPush).toBe(false);

		await runConfigure(["--set", "syncOnPush=true"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncOnPush: true }));
		expect((await loadConfig()).syncOnPush).toBe(true);
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

	it("accepts globalInstructions with the two allowed values and applies the change immediately", async () => {
		await runConfigure(["--set", "globalInstructions=enabled"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ globalInstructions: "enabled" }));
		// Persisting is not enough: configure must apply it now (write the block),
		// mirroring the VS Code Settings toggle — no `jolli enable` round-trip needed.
		expect(mockSyncGlobalInstructions).toHaveBeenCalled();

		mockSyncGlobalInstructions.mockClear();
		await runConfigure(["--set", "globalInstructions=disabled"]);
		expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ globalInstructions: "disabled" }));
		expect(mockSyncGlobalInstructions).toHaveBeenCalled();
	});

	it("does NOT apply global instructions for unrelated config keys", async () => {
		await runConfigure(["--set", "model=claude-sonnet-4-20250514"]);
		expect(mockSaveConfig).toHaveBeenCalled();
		expect(mockSyncGlobalInstructions).not.toHaveBeenCalled();
	});

	it("rejects globalInstructions values that aren't in the allowlist", async () => {
		// Without this guard, `jolli configure --set globalInstructions=on` would
		// silently persist a value that resolveGlobalInstructionsDecision treats as
		// undecided — the user would think they opted in but nothing would change.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const prevExitCode = process.exitCode;
		try {
			await runConfigure(["--set", "globalInstructions=on"]);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("enabled, disabled"));
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

	it("lists copilotEnabled, localFolder, aiProvider, and globalInstructions in help/description output", async () => {
		const help = await runConfigureHelp();
		expect(help).toContain("copilotEnabled");
		expect(help).toContain("localFolder");
		expect(help).toContain("aiProvider");
		expect(help).toContain("globalInstructions");
	});

	describe("slack.workspaceUrl validation", () => {
		it("accepts an https://<workspace>.slack.com URL and persists it nested under slack", async () => {
			// Fallback source for the reference extractor's thread permalinks when
			// the user never pasted one into the transcript (see Slack capture).
			await runConfigure(["--set", "slack.workspaceUrl=https://flyer-q4r7867.slack.com"]);
			expect(mockSaveConfig).toHaveBeenCalledWith(
				expect.objectContaining({ slack: { workspaceUrl: "https://flyer-q4r7867.slack.com" } }),
			);
			expect((await loadConfig()).slack?.workspaceUrl).toBe("https://flyer-q4r7867.slack.com");
		});

		it("normalizes a trailing-slash URL to its origin (no double slash on permalink reconstruction)", async () => {
			await runConfigure(["--set", "slack.workspaceUrl=https://flyer-q4r7867.slack.com/"]);
			expect((await loadConfig()).slack?.workspaceUrl).toBe("https://flyer-q4r7867.slack.com");
		});

		it("merges with an existing slack object instead of clobbering it", async () => {
			mockLoadConfig.mockResolvedValue({ slack: { workspaceUrl: "https://old-team.slack.com" } });
			await runConfigure(["--set", "slack.workspaceUrl=https://new-team.slack.com"]);
			expect(mockSaveConfig).toHaveBeenCalledWith(
				expect.objectContaining({ slack: { workspaceUrl: "https://new-team.slack.com" } }),
			);
		});

		it("rejects a non-slack.com host", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prevExitCode = process.exitCode;
			try {
				await runConfigure(["--set", "slack.workspaceUrl=https://evil.example"]);
				expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("slack.com"));
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prevExitCode;
			}
		});

		it("rejects a non-https URL", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prevExitCode = process.exitCode;
			try {
				await runConfigure(["--set", "slack.workspaceUrl=http://team.slack.com"]);
				expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("slack.com"));
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prevExitCode;
			}
		});

		it("lists slack.workspaceUrl in help/description output", async () => {
			const help = await runConfigureHelp();
			expect(help).toContain("slack.workspaceUrl");
		});

		it("rejects a malformed URL (not-a-url string)", async () => {
			// Closes the untested `catch` branch in coerceConfigValue when
			// `new URL(raw)` throws. Confirms the error is propagated and config
			// is not persisted.
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prevExitCode = process.exitCode;
			try {
				await runConfigure(["--set", "slack.workspaceUrl=not-a-url"]);
				expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("slack.com"));
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prevExitCode;
			}
		});

		it("rejects a spoof host matching .slack.com suffix but with evil prefix", async () => {
			// https://evilslack.com does not end with `.slack.com`, so the
			// suffix-boundary host check in isAllowedSlackHost rejects it.
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prevExitCode = process.exitCode;
			try {
				await runConfigure(["--set", "slack.workspaceUrl=https://evilslack.com"]);
				expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("slack.com"));
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prevExitCode;
			}
		});

		it("rejects a URL with .slack.com in the domain but evil TLD", async () => {
			// https://x.slack.com.evil.com has `.slack.com` in the name but ends
			// with `.evil.com`, so the suffix boundary check rejects it.
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prevExitCode = process.exitCode;
			try {
				await runConfigure(["--set", "slack.workspaceUrl=https://x.slack.com.evil.com"]);
				expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("slack.com"));
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prevExitCode;
			}
		});

		it("removes slack.workspaceUrl via --remove", async () => {
			// Set a valid workspace URL first, then remove it.
			mockLoadConfig.mockResolvedValue({ slack: { workspaceUrl: "https://team.slack.com" } });
			await runConfigure(["--remove", "slack.workspaceUrl"]);
			expect(mockSaveConfig).toHaveBeenCalledWith(
				expect.objectContaining({ slack: { workspaceUrl: undefined } }),
			);
		});
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

	describe("syncTranscripts boolean coercion via --set", () => {
		it("accepts true/false/yes/no/1/0 forms for syncTranscripts", async () => {
			for (const truthy of ["true", "yes", "1"]) {
				mockSaveConfig.mockClear();
				await runConfigure(["--set", `syncTranscripts=${truthy}`]);
				expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncTranscripts: true }));
			}
			for (const falsy of ["false", "no", "0"]) {
				mockSaveConfig.mockClear();
				await runConfigure(["--set", `syncTranscripts=${falsy}`]);
				expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ syncTranscripts: false }));
			}
		});

		it("rejects garbage boolean values", async () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prev = process.exitCode;
			try {
				await runConfigure(["--set", "syncTranscripts=maybe"]);
				expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/true\/false/));
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prev;
			}
		});

		it("rejects autoSyncEnabled — auto-sync is plugin-only (CLI is not a daemon)", async () => {
			// CLI can't run a polling loop, so the toggle has nothing to act
			// on at the CLI level. Users set it through the IDE plugin
			// Settings UI; the loader still migrates legacy `syncEnabled`
			// values written by older builds.
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const prev = process.exitCode;
			try {
				await runConfigure(["--set", "autoSyncEnabled=true"]);
				expect(process.exitCode).toBe(1);
				expect(mockSaveConfig).not.toHaveBeenCalled();
			} finally {
				errorSpy.mockRestore();
				process.exitCode = prev;
			}
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
});
