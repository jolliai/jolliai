import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isLocalAgentChild: vi.fn().mockReturnValue(false),
	isInsideGitRepo: vi.fn().mockResolvedValue(true),
	execGit: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "/repo\n", stderr: "" }),
	withRepoHooksLock: vi.fn(),
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
	loadConfig: vi.fn().mockResolvedValue({}),
	saveSession: vi.fn().mockResolvedValue(undefined),
	addGitExcludePaths: vi.fn().mockResolvedValue(undefined),
	getClaudeAgentHookHealth: vi.fn().mockResolvedValue({ stop: false, sessionStart: false }),
	install: vi.fn().mockResolvedValue({ success: true, message: "ok", warnings: [] }),
	uninstall: vi.fn().mockResolvedValue({ success: true, message: "ok", warnings: [] }),
	installPluginJolliMenu: vi.fn().mockResolvedValue(undefined),
	isPluginJolliMenuCanonical: vi.fn().mockResolvedValue(true),
	removeClaudeLegacySkills: vi.fn().mockResolvedValue(undefined),
	buildSessionStartContext: vi.fn().mockResolvedValue("first context"),
	ensurePluginDefaultProvider: vi.fn().mockResolvedValue(true),
	readStdin: vi.fn().mockResolvedValue(JSON.stringify({ cwd: "/repo/subdir" })),
}));

vi.mock("../core/AgentReentry.js", () => ({ isLocalAgentChild: mocks.isLocalAgentChild }));
vi.mock("../core/GitOps.js", () => ({
	isInsideGitRepo: mocks.isInsideGitRepo,
	execGit: mocks.execGit,
}));
vi.mock("../core/Locks.js", () => ({ withRepoHooksLock: mocks.withRepoHooksLock }));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: mocks.readManualDisableFlag }));
vi.mock("../core/SessionTracker.js", () => ({ loadConfig: mocks.loadConfig, saveSession: mocks.saveSession }));
vi.mock("../install/GitExclude.js", () => ({ addGitExcludePaths: mocks.addGitExcludePaths }));
vi.mock("../install/ClaudeHookInstaller.js", () => ({
	getClaudeAgentHookHealth: mocks.getClaudeAgentHookHealth,
}));
vi.mock("../install/Installer.js", () => ({ install: mocks.install, uninstall: mocks.uninstall }));
vi.mock("../install/SkillInstaller.js", () => ({
	installPluginJolliMenu: mocks.installPluginJolliMenu,
	isPluginJolliMenuCanonical: mocks.isPluginJolliMenuCanonical,
	PLUGIN_JOLLI_MENU_GIT_EXCLUDE_PATHS: ["/.claude/skills/jolli/"],
	removeClaudeLegacySkills: mocks.removeClaudeLegacySkills,
}));
vi.mock("./SessionStartHook.js", () => ({
	buildSessionStartContext: mocks.buildSessionStartContext,
	ensurePluginDefaultProvider: mocks.ensurePluginDefaultProvider,
}));
vi.mock("./HookUtils.js", () => ({ readStdin: mocks.readStdin }));
vi.mock("../Logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
	setLogDir: vi.fn(),
}));

const { buildPluginBootstrapOutput, main, runPluginBootstrap } = await import("./PluginBootstrapHook.js");

describe("PluginBootstrapHook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isLocalAgentChild.mockReturnValue(false);
		mocks.isInsideGitRepo.mockResolvedValue(true);
		mocks.execGit.mockResolvedValue({ exitCode: 0, stdout: "/repo\n", stderr: "" });
		mocks.readManualDisableFlag.mockResolvedValue(false);
		mocks.loadConfig.mockResolvedValue({});
		mocks.getClaudeAgentHookHealth.mockResolvedValue({ stop: false, sessionStart: false });
		mocks.install.mockResolvedValue({ success: true, message: "ok", warnings: [] });
		mocks.isPluginJolliMenuCanonical.mockResolvedValue(true);
		mocks.buildSessionStartContext.mockResolvedValue("first context");
		mocks.readStdin.mockResolvedValue(JSON.stringify({ cwd: "/repo/subdir" }));
		mocks.withRepoHooksLock.mockImplementation(async (_cwd: string, fn: () => Promise<unknown>) => ({
			acquired: true,
			value: await fn(),
		}));
	});

	it("combines reloadSkills and additionalContext into one SessionStart result", () => {
		expect(buildPluginBootstrapOutput(true, "context")).toEqual({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				reloadSkills: true,
				additionalContext: "context",
			},
		});
		expect(buildPluginBootstrapOutput(false, null)).toBeNull();
	});

	it("fresh plugin-only repo installs menu/runtime/hooks and covers first-session context", async () => {
		mocks.isPluginJolliMenuCanonical.mockResolvedValueOnce(false).mockResolvedValue(true);
		const output = await runPluginBootstrap("/repo/subdir");
		expect(mocks.execGit).toHaveBeenCalledWith(["rev-parse", "--show-toplevel"], "/repo/subdir");
		expect(mocks.installPluginJolliMenu).toHaveBeenCalledWith("/repo");
		expect(mocks.install).toHaveBeenCalledWith("/repo", {
			repoHooksOnly: true,
			sourceTag: "claude-plugin",
			respectManualDisable: true,
			automatic: true,
		});
		expect(mocks.ensurePluginDefaultProvider).toHaveBeenCalledWith("claude-plugin", {});
		expect(mocks.buildSessionStartContext).toHaveBeenCalledWith(
			"/repo",
			"claude-plugin",
			expect.objectContaining({ includeBriefing: true, includePluginReminders: true }),
		);
		expect(output?.hookSpecificOutput).toEqual({
			hookEventName: "SessionStart",
			reloadSkills: true,
			additionalContext: "first context",
		});
	});

	it("records the first session without depending on Stop-hook hot reload", async () => {
		await runPluginBootstrap("/repo", { sessionId: "s1", transcriptPath: "/tmp/transcript.jsonl" });
		expect(mocks.saveSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "s1",
				transcriptPath: "/tmp/transcript.jsonl",
				source: "claude",
			}),
			"/repo",
		);
	});

	it("healthy repo leaves briefing to the canonical SessionStart hook", async () => {
		mocks.getClaudeAgentHookHealth.mockResolvedValue({ stop: true, sessionStart: true });
		await runPluginBootstrap("/repo");
		expect(mocks.buildSessionStartContext).toHaveBeenCalledWith(
			"/repo",
			"claude-plugin",
			expect.objectContaining({ includeBriefing: false, includePluginReminders: true }),
		);
	});

	it("manual disable keeps the menu, removes residual hooks, and does not auto-enable", async () => {
		mocks.readManualDisableFlag.mockResolvedValue(true);
		const output = await runPluginBootstrap("/repo");
		expect(mocks.installPluginJolliMenu).toHaveBeenCalled();
		expect(mocks.uninstall).toHaveBeenCalledWith("/repo", {
			preserveMenu: true,
			repoLockHeld: true,
		});
		expect(mocks.install).not.toHaveBeenCalled();
		expect(mocks.ensurePluginDefaultProvider).not.toHaveBeenCalled();
		expect(output).toBeNull();
	});

	it("lock contention never writes unlocked and rechecks whether a peer created the menu", async () => {
		mocks.isPluginJolliMenuCanonical.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		mocks.withRepoHooksLock.mockResolvedValueOnce({ acquired: false });
		const output = await runPluginBootstrap("/repo");
		expect(mocks.installPluginJolliMenu).not.toHaveBeenCalled();
		expect(output?.hookSpecificOutput.reloadSkills).toBe(true);
	});

	it("defers first-session context when the SECOND (context-phase) lock is busy", async () => {
		// The menu phase acquires and repo reconciliation runs, but the context-phase
		// lock is contended — so ensurePluginDefaultProvider / buildSessionStartContext
		// never run and no additionalContext is emitted. reloadSkills still fires because
		// the menu became canonical. Guards the `if (!contextPhase.acquired)` branch.
		mocks.isPluginJolliMenuCanonical.mockResolvedValueOnce(false).mockResolvedValue(true);
		mocks.withRepoHooksLock
			.mockImplementationOnce(async (_cwd: string, fn: () => Promise<unknown>) => ({
				acquired: true,
				value: await fn(),
			}))
			.mockResolvedValueOnce({ acquired: false });

		const output = await runPluginBootstrap("/repo");

		expect(mocks.install).toHaveBeenCalled();
		expect(mocks.ensurePluginDefaultProvider).not.toHaveBeenCalled();
		expect(mocks.buildSessionStartContext).not.toHaveBeenCalled();
		expect(output?.hookSpecificOutput).toEqual({
			hookEventName: "SessionStart",
			reloadSkills: true,
		});
	});

	it("uses the current linked worktree root, not the main worktree", async () => {
		mocks.execGit.mockResolvedValue({ exitCode: 0, stdout: "/linked-wt\n", stderr: "" });
		await runPluginBootstrap("/linked-wt/src");
		expect(mocks.installPluginJolliMenu).toHaveBeenCalledWith("/linked-wt");
		expect(mocks.install).toHaveBeenCalledWith("/linked-wt", expect.any(Object));
	});

	it("is inert outside Git and when top-level resolution fails", async () => {
		mocks.isInsideGitRepo.mockResolvedValueOnce(false);
		expect(await runPluginBootstrap("/tmp")).toBeNull();
		mocks.execGit.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "no repo" });
		expect(await runPluginBootstrap("/tmp")).toBeNull();
	});

	it("fails soft when repo reconciliation fails", async () => {
		mocks.install.mockResolvedValue({ success: false, message: "broken", warnings: [] });
		expect(
			await runPluginBootstrap("/repo", { sessionId: "s-deferred", transcriptPath: "/tmp/deferred.jsonl" }),
		).toBeNull();
		expect(mocks.saveSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "s-deferred", transcriptPath: "/tmp/deferred.jsonl" }),
			"/repo",
		);
		expect(mocks.buildSessionStartContext).not.toHaveBeenCalled();
	});

	it("does not seed or emit context when Claude integration is disabled", async () => {
		mocks.loadConfig.mockResolvedValue({ claudeEnabled: false });
		expect(await runPluginBootstrap("/repo")).toBeNull();
		expect(mocks.ensurePluginDefaultProvider).not.toHaveBeenCalled();
	});

	it("main skips local-agent children and swallows malformed stdin", async () => {
		mocks.isLocalAgentChild.mockReturnValueOnce(true);
		await main();
		expect(mocks.readStdin).not.toHaveBeenCalled();

		mocks.isLocalAgentChild.mockReturnValue(false);
		mocks.readStdin.mockResolvedValueOnce("{bad");
		await expect(main()).resolves.toBeUndefined();
	});
});
