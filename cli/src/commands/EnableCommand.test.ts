/**
 * EnableCommand tests — focused on the local-agent tool-selection prompt in
 * `promptSetup` (`handleLocalAgent`), and on the generalized presence-based
 * auto-select / picker branches that front it.
 *
 * Covers:
 *   - picking the local-agent option then a non-default tool (Codex) persists
 *     { aiProvider: "local-agent", localAgentTool: "codex" }
 *   - the tool sub-menu has NO default: a blank answer is re-asked exactly like
 *     an out-of-range / unparseable one, and holding Enter skips without writing
 *   - a tool that fails its probe is dropped from the menu, so the loop can
 *     never re-probe a known-broken tool
 *   - the flow is self-sufficient: no Anthropic-key prompt runs afterward
 *   - zero present tools falls through to the provider menu unchanged
 *   - exactly one present + usable tool auto-selects silently, no prompt
 *   - exactly one present but unusable tool falls through to the menu
 *   - the local-agent route is gated on "no usable credential", NOT on an unset
 *     aiProvider: a keyless leftover provider must not close it, while a real
 *     Anthropic key must
 *   - two or more present tools prompt among them, probing before saving
 *   - a failed probe on the chosen tool retries rather than looping forever
 *   - menu choice 3 lists only present tools, or all four with a note when
 *     none are present
 *   - exhausting the AUTO-ROUTED picker (every detected tool broken) hands the
 *     user back the provider menu instead of dead-ending, while an explicit
 *     "Skip for now" still ends the flow
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../Types.js";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
	getJolliUrl: vi.fn(),
	browserLogin: vi.fn(),
	isLocalAgentChild: vi.fn(),
	validateJolliApiKey: vi.fn(),
	readManualDisableFlag: vi.fn(),
	writeManualDisableFlag: vi.fn(),
	getGlobalConfigDir: vi.fn(),
	loadConfig: vi.fn(),
	loadConfigFromDir: vi.fn(),
	saveConfigScoped: vi.fn(),
	track: vi.fn(),
	maybeEmitOnboardingProgress: vi.fn(),
	capturePluginOnboardingSnapshot: vi.fn(),
	triggerPendingPushRetry: vi.fn(),
	isValidSourceTag: vi.fn(),
	install: vi.fn(),
	uninstall: vi.fn(),
	promptText: vi.fn(),
	isInteractive: vi.fn(),
	resolveProjectDir: vi.fn(),
	registerRepo: vi.fn(),
	canUseDashboardDb: vi.fn(),
	importDashboardHistory: vi.fn(),
}));

vi.mock("../auth/AuthConfig.js", () => ({ getJolliUrl: h.getJolliUrl }));
vi.mock("../auth/Login.js", () => ({ browserLogin: h.browserLogin }));
vi.mock("../core/AgentReentry.js", () => ({ isLocalAgentChild: h.isLocalAgentChild }));
vi.mock("../core/JolliApiUtils.js", () => ({ validateJolliApiKey: h.validateJolliApiKey }));
vi.mock("../core/RepoProfile.js", () => ({
	readManualDisableFlag: h.readManualDisableFlag,
	writeManualDisableFlag: h.writeManualDisableFlag,
}));
vi.mock("../core/SessionTracker.js", () => ({
	getGlobalConfigDir: h.getGlobalConfigDir,
	loadConfig: h.loadConfig,
	loadConfigFromDir: h.loadConfigFromDir,
	saveConfigScoped: h.saveConfigScoped,
}));
vi.mock("../core/Telemetry.js", () => ({ track: h.track }));
vi.mock("../core/TelemetryCommandHook.js", () => ({ markSkipExitFlush: vi.fn() }));
vi.mock("../core/OnboardingFunnel.js", () => ({ maybeEmitOnboardingProgress: h.maybeEmitOnboardingProgress }));
vi.mock("../hooks/PluginBootstrapTelemetry.js", () => ({
	capturePluginOnboardingSnapshot: h.capturePluginOnboardingSnapshot,
}));
vi.mock("../hooks/PushCompensation.js", () => ({ triggerPendingPushRetry: h.triggerPendingPushRetry }));
vi.mock("../install/DistPathResolver.js", () => ({ isValidSourceTag: h.isValidSourceTag }));
vi.mock("../install/Installer.js", () => ({ install: h.install, uninstall: h.uninstall }));
vi.mock("../dashboard/RepoRegistry.js", () => ({ registerRepo: h.registerRepo }));
vi.mock("../dashboard/DashboardDb.js", () => ({ canUseDashboardDb: h.canUseDashboardDb }));
vi.mock("./DashboardCommand.js", () => ({ importDashboardHistory: h.importDashboardHistory }));
vi.mock("./CliUtils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./CliUtils.js")>();
	return {
		...actual,
		promptText: h.promptText,
		isInteractive: h.isInteractive,
		resolveProjectDir: h.resolveProjectDir,
	};
});

import { Command } from "commander";
import * as detect from "../core/localagent/DetectAgents.js";
import { LOCAL_AGENT_TOOLS } from "../core/localagent/ToolMeta.js";
import { promptSetup, registerDisableCommand, registerEnableCommand } from "./EnableCommand.js";

/** The sub-menu lists every registered tool plus one "go back" entry. Derived so
 *  a new backend cannot silently break the two size assertions below. */
const LOCAL_AGENT_TOOL_COUNT = Object.keys(LOCAL_AGENT_TOOLS).length;

const GLOBAL_CONFIG_DIR = "/global/config";
const promptText = h.promptText;

let logs: string[];
let output: string;
let savedConfig: Partial<JolliMemoryConfig> | undefined;

beforeEach(() => {
	// resetAllMocks (not clearAllMocks): also drains any queued
	// `.mockResolvedValueOnce(...)` values a prior test left unconsumed on the
	// shared `h.promptText` mock — clearAllMocks only clears call history, so a
	// leftover queued answer would silently leak into the next test's prompts.
	vi.resetAllMocks();
	logs = [];
	output = "";
	savedConfig = undefined;
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
		output = logs.join("\n");
	});
	h.getGlobalConfigDir.mockReturnValue(GLOBAL_CONFIG_DIR);
	// No tools present by default, so promptSetup falls through to the provider
	// menu rather than the zero-friction auto-select-and-return branch. (Left
	// unmocked, the real detector would depend on whatever local agent CLIs are
	// installed on the machine running the test.) Individual tests override via
	// vi.spyOn(detect, ...) when they need presence.
	vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([]);
	vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
	// No jolliApiKey configured, so promptSetup shows the top-level menu
	// instead of taking the early-return "already configured" branch.
	h.loadConfigFromDir.mockResolvedValue({} as Partial<JolliMemoryConfig>);
	// `reportEnableResult` reads the merged config for the onboarding-progress
	// emit; it is fully guarded but still needs the export to exist.
	h.loadConfig.mockResolvedValue({} as Partial<JolliMemoryConfig>);
	h.saveConfigScoped.mockImplementation((partial: Partial<JolliMemoryConfig>) => {
		savedConfig = partial;
		return Promise.resolve(undefined);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("EnableCommand — promptSetup local-agent tool selection", () => {
	it("persists the chosen local-agent tool (Codex, the 2nd listed tool)", async () => {
		// Top-level menu choice "3" = local agent; second-level menu choice "2" =
		// Codex, per LOCAL_AGENT_TOOLS insertion order (claude-code, codex, ...).
		// No tools present (beforeEach default), so the picker falls back to all
		// tools with a note.
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

	it("marks the currently-configured tool with (current) in the picker", async () => {
		// Config already drives local-agent → codex; the picker must show which one
		// is active so the user isn't guessing. Two tools present routes straight
		// into the sub-menu (>1 detected), so a single pick answer is consumed.
		h.loadConfigFromDir.mockResolvedValue({
			aiProvider: "local-agent",
			localAgentTool: "codex",
		} as Partial<JolliMemoryConfig>);
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "codex", label: "Codex" },
			{ id: "opencode", label: "OpenCode" },
		]);
		h.promptText.mockResolvedValueOnce("1"); // keep Codex

		await promptSetup();

		expect(output).toContain("1. Codex  (current)");
		expect(output).not.toContain("OpenCode  (current)");
	});

	it("re-asks (never pins the first tool) when the tool sub-menu answer is blank", async () => {
		// The sub-menu has NO default. A bare Enter used to be coerced to "1" and
		// silently wrote { aiProvider: "local-agent", localAgentTool: "claude-code" }
		// to the global config — the whole product's first prompt, decided by a
		// stray newline (one queued in the TTY buffer during startup is enough).
		// Blank now takes the same re-ask path an out-of-range answer takes.
		h.promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("").mockResolvedValueOnce("2");

		await promptSetup();

		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			expect.objectContaining({ aiProvider: "local-agent", localAgentTool: "codex" }),
			GLOBAL_CONFIG_DIR,
		);
		// Never probed claude-code on the way through — the blank consumed no candidate.
		expect(logs.join("\n")).toContain(`Enter a number between 1 and ${LOCAL_AGENT_TOOL_COUNT + 1}`);
	});

	it("gives up and skips (writing nothing) when the sub-menu answer stays blank", async () => {
		// Holding Enter is the exact input that used to auto-select Claude Code.
		// It must now exhaust MAX_INVALID_CHOICES and leave the config untouched.
		h.promptText.mockResolvedValueOnce("3").mockResolvedValue("");

		await promptSetup();

		expect(h.saveConfigScoped).not.toHaveBeenCalled();
		expect(logs.join("\n")).toContain("Couldn't read a choice");
	});

	it("advertises no default in the sub-menu prompt", async () => {
		// The `[1]` hint is what made a bare Enter look like a legitimate answer.
		h.promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("2");

		await promptSetup();

		const subMenuPrompt = h.promptText.mock.calls[1][0] as string;
		expect(subMenuPrompt).toContain(`Choice (1-${LOCAL_AGENT_TOOL_COUNT + 1})`);
		expect(subMenuPrompt).not.toContain("[1]");
	});

	it("re-prompts (never silently pins the first tool) on an out-of-range sub-menu answer", async () => {
		// `99` used to index past the list and fall back to list[0], pinning a tool
		// the user never named. It must now be rejected and re-asked instead.
		h.promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("99").mockResolvedValueOnce("3");

		await promptSetup();

		expect(h.saveConfigScoped).toHaveBeenCalledWith(
			expect.objectContaining({ aiProvider: "local-agent", localAgentTool: "cursor-agent" }),
			GLOBAL_CONFIG_DIR,
		);
	});

	it("gives up and skips after repeated unreadable sub-menu answers, writing nothing", async () => {
		// The one loop branch that consumes no candidate needs its own bound.
		h.promptText.mockResolvedValueOnce("3").mockResolvedValue("nonsense");

		await promptSetup();

		expect(h.saveConfigScoped).not.toHaveBeenCalled();
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

describe("promptSetup — local agent auto-select", () => {
	it("auto-selects silently when exactly one tool is present and usable", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([{ id: "codex", label: "Codex" }]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		await promptSetup();
		expect(savedConfig).toMatchObject({ aiProvider: "local-agent", localAgentTool: "codex" });
		expect(promptText).not.toHaveBeenCalled();
	});

	it("falls through to the provider menu when the single present tool fails its probe", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([{ id: "codex", label: "Codex" }]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(false);
		promptText.mockResolvedValue("4"); // Skip
		await promptSetup();
		expect(savedConfig).toBeUndefined();
		expect(output).toContain("How would you like to generate summaries?");
	});

	it("prompts when two or more tools are present", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		promptText.mockResolvedValue("2");
		await promptSetup();
		expect(savedConfig).toMatchObject({ aiProvider: "local-agent", localAgentTool: "opencode" });
	});

	it("still routes to local agents when a KEYLESS aiProvider is left over on disk", async () => {
		// The route used to be gated on `aiProvider === undefined`, i.e. "the field
		// was never written" as a proxy for "the user never chose". VS Code's
		// Settings panel breaks that proxy: it DERIVES a provider for display when
		// the field is unset (not signed in → "anthropic") and persists it on the
		// next Apply — even an Apply that only touched an unrelated field. That one
		// stray write permanently closed the local-agent route on a machine with
		// agents installed, sending the user to the top-level provider menu forever.
		// A provider with no key behind it is a stale preference, not a decision.
		h.loadConfigFromDir.mockResolvedValue({ aiProvider: "anthropic" } as Partial<JolliMemoryConfig>);
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([{ id: "codex", label: "Codex" }]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);

		await promptSetup();

		expect(savedConfig).toMatchObject({ aiProvider: "local-agent", localAgentTool: "codex" });
		expect(output).not.toContain("How would you like to generate summaries?");
	});

	it("does NOT route to local agents when a REAL Anthropic key backs the provider", async () => {
		// The other half of the same contract: an actual credential is a decision to
		// honour, so detection must not second-guess it even with tools installed.
		h.loadConfigFromDir.mockResolvedValue({
			aiProvider: "anthropic",
			apiKey: "sk-ant-real",
		} as Partial<JolliMemoryConfig>);
		const present = vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([{ id: "codex", label: "Codex" }]);
		promptText.mockResolvedValue("4"); // Skip at the provider menu.

		await promptSetup();

		expect(present).not.toHaveBeenCalled();
		expect(output).toContain("How would you like to generate summaries?");
		expect(savedConfig).toBeUndefined();
	});

	it("re-prompts when the chosen tool fails its probe, writing nothing", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		// A failed tool is REMOVED from the menu, so the second round renumbers:
		// OpenCode becomes choice 1. Both answers are "1" against the freshly
		// printed list — which is also what stops a held-Enter run from
		// re-probing the same broken tool.
		promptText.mockResolvedValueOnce("1").mockResolvedValueOnce("1");
		await promptSetup();
		expect(output).toContain("OpenCode");
		expect(savedConfig).toMatchObject({ localAgentTool: "opencode" });
	});

	it("shows the provider menu unchanged when no tool is present", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([]);
		promptText.mockResolvedValue("4");
		await promptSetup();
		expect(output).toContain("How would you like to generate summaries?");
	});
});

describe("menu choice 3 — explicit local agent", () => {
	it("lists only present tools", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "codex", label: "Codex" },
			{ id: "opencode", label: "OpenCode" },
		]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("1");
		await promptSetup();
		expect(output).toContain("1. Codex");
		expect(output).toContain("2. OpenCode");
		expect(output).not.toContain("Cursor");
	});

	it("falls back to all tools with a note when none are present", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("1");
		await promptSetup();
		expect(output).toContain("None detected");
		expect(output).toContain("Cursor");
	});

	it("terminates with install guidance, writing nothing, when the only listed tool fails its probe", async () => {
		// Exactly one tool present: promptSetup's own fresh-config check probes
		// it, the probe fails, and it falls through to the top-level menu (per
		// the "1 present but unusable → menu" row). Choosing menu option "3"
		// re-detects the same single tool and re-probes it inside
		// handleLocalAgent's loop, which must empty the candidate list and return
		// rather than looping forever waiting for a second promptText answer that
		// never comes.
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([{ id: "codex", label: "Codex" }]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(false);
		promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("1");
		await promptSetup();
		expect(output).toContain("Codex isn't usable on this machine — nothing was saved.");
		// Detected-but-broken: "install one" would be a wrong diagnosis for a user
		// who already has it on disk (that wording is reserved for the blind list).
		expect(output).toContain("Every detected tool failed to run");
		expect(savedConfig).toBeUndefined();
		// Exactly the top-menu choice + the one submenu answer — proves the loop
		// returned instead of prompting again.
		expect(h.promptText).toHaveBeenCalledTimes(2);
	});

	it("terminates (rather than reprompting forever) when 2+ candidates all keep failing their probe", async () => {
		// Regression for the deterministic hang: with 2+ candidates that never
		// pass their probe, the old `for(;;)` loop only ever returned on
		// `list.length === 1`, so it reprompted forever. A fresh config with
		// 2+ present tools drives straight into handleLocalAgent's submenu
		// (see "prompts when two or more tools are present" above), and
		// promptText here always answers "1" (never "Skip"), so the ONLY thing
		// that can stop this test from hanging until the test-runner's timeout
		// is the loop shrinking its own candidate list. The low `it()` timeout
		// below means a reintroduced unbounded loop fails fast via timeout
		// instead of hanging the whole suite.
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		]);
		const usable = vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(false);
		promptText.mockResolvedValue("1");

		await promptSetup();

		expect(output).toContain("Every detected tool failed to run");
		// Each failed tool is removed, so the loop runs exactly once per
		// candidate — never re-probing a tool already known to be broken.
		expect(usable).toHaveBeenCalledTimes(2);
		// Exhausting the auto-routed picker hands the user back the provider menu
		// (see the dedicated test below), where the always-"1" answer takes
		// browser sign-in — hence the third prompt.
		expect(h.promptText.mock.calls.length).toBe(3);
		expect(h.browserLogin).toHaveBeenCalledTimes(1);
	}, 2000);

	it("falls through to the provider menu when every auto-routed candidate fails its probe", async () => {
		// The user never ASKED for a local agent here — detection routed them into
		// the picker. Dead-ending there ("install one, then run jolli enable
		// again") stranded a multi-tool machine with no way to reach browser
		// sign-in or an Anthropic key in the same run.
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(false);
		// Two failing picks, then the provider menu's "2" (Anthropic key), then the
		// key itself.
		promptText
			.mockResolvedValueOnce("1")
			.mockResolvedValueOnce("1")
			.mockResolvedValueOnce("2")
			.mockResolvedValueOnce("sk-ant-test");

		await promptSetup();

		expect(output).toContain("How would you like to generate summaries?");
		expect(savedConfig).toEqual({ apiKey: "sk-ant-test", aiProvider: "anthropic" });
	}, 2000);

	it("does NOT re-offer the provider menu when the user skips the auto-routed picker", async () => {
		// Skip is the user's own decision and already names where to configure
		// later — re-asking would read as the command ignoring the answer.
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		]);
		vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		promptText.mockResolvedValueOnce("3");

		await promptSetup();

		expect(output).not.toContain("How would you like to generate summaries?");
		expect(savedConfig).toBeUndefined();
		expect(h.promptText).toHaveBeenCalledTimes(1);
	});

	it("offers an explicit Skip choice in the local-agent submenu and honors it without probing", async () => {
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		]);
		const usable = vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		// Fresh config + 2 present tools enters the submenu directly (no
		// top-level menu). Submenu lists 2 tools, so "Skip for now" is choice 3.
		promptText.mockResolvedValue("3");

		await promptSetup();

		expect(output).toContain("3. Skip for now (configure later)");
		expect(savedConfig).toBeUndefined();
		expect(usable).not.toHaveBeenCalled();
	});

	it("threads config.localAgentPath into the probe for the two-or-more-present picker", async () => {
		h.loadConfigFromDir.mockResolvedValue({ localAgentPath: "/custom/bin/tool" } as Partial<JolliMemoryConfig>);
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([
			{ id: "claude-code", label: "Claude Code" },
			{ id: "opencode", label: "OpenCode" },
		]);
		const usable = vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		promptText.mockResolvedValue("1");

		await promptSetup();

		// Tool-SCOPED: the config names no localAgentTool, so the override binds to
		// the "claude-code" default and reaches the probe only for that tool.
		expect(usable).toHaveBeenCalledWith("claude-code", {
			override: { tool: "claude-code", path: "/custom/bin/tool" },
		});
	});

	it("threads config.localAgentPath into the probe for the explicit menu-choice-3 submenu", async () => {
		h.loadConfigFromDir.mockResolvedValue({ localAgentPath: "/custom/bin/codex" } as Partial<JolliMemoryConfig>);
		vi.spyOn(detect, "listPresentLocalAgents").mockReturnValue([]);
		const usable = vi.spyOn(detect, "isLocalAgentUsable").mockResolvedValue(true);
		promptText.mockResolvedValueOnce("3").mockResolvedValueOnce("1");

		await promptSetup();

		expect(usable).toHaveBeenCalledWith("claude-code", {
			override: { tool: "claude-code", path: "/custom/bin/codex" },
		});
	});
});

// ─── Dashboard wiring on enable / disable ──────────────────────────────────

describe("EnableCommand — dashboard registration and history import", () => {
	const okInstall = { success: true, message: "ok", warnings: [] };

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		h.resolveProjectDir.mockReturnValue("/repo");
		h.getGlobalConfigDir.mockReturnValue(GLOBAL_CONFIG_DIR);
		h.isLocalAgentChild.mockReturnValue(false);
		h.install.mockResolvedValue(okInstall);
		h.uninstall.mockResolvedValue({ success: true, message: "ok", warnings: [] });
		h.registerRepo.mockResolvedValue({
			repoIdentity: "id-1",
			repoName: "repo",
			worktreeRoot: "/repo",
			enabledAt: "2026-07-30T00:00:00Z",
		});
		h.canUseDashboardDb.mockReturnValue(true);
		h.importDashboardHistory.mockResolvedValue(undefined);
		h.isInteractive.mockReturnValue(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function runEnable(...extraArgs: Array<string>): Promise<void> {
		const program = new Command();
		registerEnableCommand(program);
		await program.parseAsync(["node", "jolli", "enable", "--cwd", "/repo", ...extraArgs]);
	}

	async function runDisable(...extraArgs: Array<string>): Promise<void> {
		const program = new Command();
		registerDisableCommand(program);
		await program.parseAsync(["node", "jolli", "disable", "--cwd", "/repo", ...extraArgs]);
	}

	it("registers the repo on a successful non-interactive enable, without importing history", async () => {
		await runEnable("-y");

		// Registration is unconditional (the machine-level registry must know
		// every enabled repo)…
		expect(h.registerRepo).toHaveBeenCalledWith({ cwd: "/repo" });
		// …but the history import is interactive-only, and no server is ever started.
		expect(h.importDashboardHistory).not.toHaveBeenCalled();
	});

	it("keeps enable green when repo registration fails", async () => {
		h.registerRepo.mockRejectedValue(new Error("not a git repo"));

		await runEnable("-y");

		expect(process.exitCode ?? 0).toBe(0);
	});

	it("skips registration and history import for integrations-only repairs", async () => {
		await runEnable("--integrations-only", "-y");

		expect(h.registerRepo).not.toHaveBeenCalled();
		expect(h.importDashboardHistory).not.toHaveBeenCalled();
	});

	it("records the disable in the repo's profile and writes NOTHING to the registry", async () => {
		// One switch. `uninstall(persistManualDisable)` writes `profile.json`, which is
		// what every reader — `listActiveRepos` included — consults. The registry used
		// to get a second stamp here and NOWHERE else, while every `registerRepo`
		// cleared it, so a disabled repo kept coming back into the dashboard.
		await runDisable();

		expect(h.uninstall).toHaveBeenCalledWith("/repo", expect.objectContaining({ persistManualDisable: true }));
		expect(h.registerRepo).not.toHaveBeenCalled();
	});

	it("does not persist the opt-out on an integrations-only disable", async () => {
		await runDisable("--integrations-only");

		expect(h.uninstall).toHaveBeenCalledWith("/repo", expect.objectContaining({ persistManualDisable: false }));
		expect(h.registerRepo).not.toHaveBeenCalled();
	});
});

// ─── Onboarding funnel on the repo-hooks-only early return ─────────────────
//
// This branch returns before reportEnableResult's tail emit, and both plugins'
// /jolli:init run exactly this mode — so it must carry its own snapshot, or the
// plugins' primary install gesture is a funnel blind spot (the Codex plugin's
// SessionStart hook is trust-gated, so this can be that surface's only trigger).

describe("EnableCommand — repo-hooks-only onboarding funnel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		h.resolveProjectDir.mockReturnValue("/repo");
		h.isLocalAgentChild.mockReturnValue(false);
		h.loadConfig.mockResolvedValue({});
		h.install.mockResolvedValue({ success: true, message: "ok", warnings: [] });
		h.capturePluginOnboardingSnapshot.mockReturnValue({ done: Promise.resolve() });
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	async function runRepoHooksOnly(sourceTag?: string): Promise<void> {
		const program = new Command();
		registerEnableCommand(program);
		await program.parseAsync([
			"node",
			"jolli",
			"enable",
			"--cwd",
			"/repo",
			"--repo-hooks-only",
			...(sourceTag ? ["--source-tag", sourceTag] : []),
		]);
	}

	it("captures the shared onboarding snapshot on success, keyed on the requested cwd", async () => {
		await runRepoHooksOnly();

		// The shared helper carries the whole contract: its own bootstrap
		// re-points the telemetry context at options.cwd (so the buffer, the
		// bounded flush and the dedup ledger agree even under an explicit
		// --cwd), and its explicit flush replaces the exit flush that
		// markSkipExitFlush() disarmed for this mode.
		expect(h.capturePluginOnboardingSnapshot).toHaveBeenCalledTimes(1);
		// No source tag, so no host is known — the `agent` telemetry dimension is
		// passed as undefined rather than guessed. See below.
		expect(h.capturePluginOnboardingSnapshot).toHaveBeenCalledWith("/repo", undefined, undefined);
	});

	it("passes the host as the agent dimension when a plugin source tag names one", async () => {
		h.isValidSourceTag.mockReturnValue(true);
		await runRepoHooksOnly("codex-plugin");
		expect(h.capturePluginOnboardingSnapshot).toHaveBeenCalledWith("/repo", undefined, "codex");
	});

	it("passes no agent for a source tag that is not a plugin host, rather than defaulting to claude", async () => {
		// pluginBootstrapAgent, not pluginBootstrapHost: the latter falls back to
		// "claude" so a hand-run --repo-hooks-only still gets Claude's assets, but
		// that run proves nothing about which host the user is typing into.
		h.isValidSourceTag.mockReturnValue(true);
		await runRepoHooksOnly("cli");
		expect(h.capturePluginOnboardingSnapshot).toHaveBeenCalledWith("/repo", undefined, undefined);
	});

	it("captures on the failure branch too — a reconciliation that fails is exactly the drop-off the funnel observes", async () => {
		h.install.mockResolvedValue({ success: false, message: "boom", warnings: [] });

		await runRepoHooksOnly();

		expect(process.exitCode).toBe(1);
		expect(h.capturePluginOnboardingSnapshot).toHaveBeenCalledWith("/repo", undefined, undefined);
	});

	it("waits for the snapshot chain before returning", async () => {
		let settled = false;
		h.capturePluginOnboardingSnapshot.mockReturnValue({
			done: new Promise<void>((resolve) =>
				setTimeout(() => {
					settled = true;
					resolve();
				}, 5),
			),
		});

		await runRepoHooksOnly();

		// The command's action must await `done` — this branch has no exit flush
		// left to pick up a stranded buffer.
		expect(settled).toBe(true);
	});
});
