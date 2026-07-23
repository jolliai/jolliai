/**
 * EnableCommand tests — focused on the local-agent tool-selection prompt in
 * `promptSetup` (`handleLocalAgent`).
 *
 * Covers:
 *   - picking the local-agent option then a non-default tool (Codex) persists
 *     { aiProvider: "local-agent", localAgentTool: "codex" }
 *   - an out-of-range / blank answer falls back to the first listed tool
 *   - the flow is self-sufficient: no Anthropic-key prompt runs afterward
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../Types.js";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
	getJolliUrl: vi.fn(),
	browserLogin: vi.fn(),
	isLocalAgentChild: vi.fn(),
	isClaudeCodeUsable: vi.fn(),
	validateJolliApiKey: vi.fn(),
	readManualDisableFlag: vi.fn(),
	writeManualDisableFlag: vi.fn(),
	getGlobalConfigDir: vi.fn(),
	loadConfigFromDir: vi.fn(),
	saveConfigScoped: vi.fn(),
	track: vi.fn(),
	triggerPendingPushRetry: vi.fn(),
	isValidSourceTag: vi.fn(),
	install: vi.fn(),
	uninstall: vi.fn(),
	promptText: vi.fn(),
	isInteractive: vi.fn(),
	resolveProjectDir: vi.fn(),
}));

vi.mock("../auth/AuthConfig.js", () => ({ getJolliUrl: h.getJolliUrl }));
vi.mock("../auth/Login.js", () => ({ browserLogin: h.browserLogin }));
vi.mock("../core/AgentReentry.js", () => ({ isLocalAgentChild: h.isLocalAgentChild }));
vi.mock("../core/localagent/ClaudeExecutableResolver.js", () => ({ isClaudeCodeUsable: h.isClaudeCodeUsable }));
vi.mock("../core/JolliApiUtils.js", () => ({ validateJolliApiKey: h.validateJolliApiKey }));
vi.mock("../core/RepoProfile.js", () => ({
	readManualDisableFlag: h.readManualDisableFlag,
	writeManualDisableFlag: h.writeManualDisableFlag,
}));
vi.mock("../core/SessionTracker.js", () => ({
	getGlobalConfigDir: h.getGlobalConfigDir,
	loadConfigFromDir: h.loadConfigFromDir,
	saveConfigScoped: h.saveConfigScoped,
}));
vi.mock("../core/Telemetry.js", () => ({ track: h.track }));
vi.mock("../core/TelemetryCommandHook.js", () => ({ markSkipExitFlush: vi.fn() }));
vi.mock("../hooks/PushCompensation.js", () => ({ triggerPendingPushRetry: h.triggerPendingPushRetry }));
vi.mock("../install/DistPathResolver.js", () => ({ isValidSourceTag: h.isValidSourceTag }));
vi.mock("../install/Installer.js", () => ({ install: h.install, uninstall: h.uninstall }));
vi.mock("./CliUtils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./CliUtils.js")>();
	return {
		...actual,
		promptText: h.promptText,
		isInteractive: h.isInteractive,
		resolveProjectDir: h.resolveProjectDir,
	};
});

import { promptSetup } from "./EnableCommand.js";

const GLOBAL_CONFIG_DIR = "/global/config";

describe("EnableCommand — promptSetup local-agent tool selection", () => {
	let logs: string[];

	beforeEach(() => {
		vi.clearAllMocks();
		logs = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		});
		h.getGlobalConfigDir.mockReturnValue(GLOBAL_CONFIG_DIR);
		// No auto-detected Claude Code, so promptSetup falls through to the provider
		// menu rather than the zero-friction auto-select-and-return branch. (Left
		// unmocked, the real probe spawns `claude` and its result would depend on
		// whatever is installed on the test machine.)
		h.isClaudeCodeUsable.mockReturnValue(false);
		// No jolliApiKey configured, so promptSetup shows the top-level menu
		// instead of taking the early-return "already configured" branch.
		h.loadConfigFromDir.mockResolvedValue({} as Partial<JolliMemoryConfig>);
		h.saveConfigScoped.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("persists the chosen local-agent tool (Codex, the 2nd listed tool)", async () => {
		// Top-level menu choice "3" = local agent; second-level menu choice "2" =
		// Codex, per LOCAL_AGENT_TOOLS insertion order (claude-code, codex, ...).
		h.promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("2");

		await promptSetup();

		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			expect.objectContaining({ aiProvider: "local-agent", localAgentTool: "codex" }),
			GLOBAL_CONFIG_DIR,
		);
		expect(logs.join("\n")).toContain("Codex");
		// Self-sufficient: only one saveConfigScoped call, no fallthrough to the
		// Anthropic-key prompt (which would call promptText a 3rd time and/or
		// re-load config for that step).
		expect(h.promptText).toHaveBeenCalledTimes(2);
	});

	it("persists claude-code when the tool sub-menu answer is blank (defaults to choice 1)", async () => {
		h.promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("");

		await promptSetup();

		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			expect.objectContaining({ aiProvider: "local-agent", localAgentTool: "claude-code" }),
			GLOBAL_CONFIG_DIR,
		);
	});

	it("persists claude-code when the tool sub-menu answer is out of range", async () => {
		h.promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("99");

		await promptSetup();

		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			expect.objectContaining({ aiProvider: "local-agent", localAgentTool: "claude-code" }),
			GLOBAL_CONFIG_DIR,
		);
	});

	it("persists cursor-agent (the 3rd listed tool)", async () => {
		h.promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("3");

		await promptSetup();

		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			expect.objectContaining({ aiProvider: "local-agent", localAgentTool: "cursor-agent" }),
			GLOBAL_CONFIG_DIR,
		);
	});
});
