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
	// Defaults to "no layout" so every existing case keeps exercising the `git`
	// fallback it was written against.
	resolveGitFsLayout: vi.fn<() => { worktreeRoot: string } | null>(() => null),
	triggerEnsureGlobalDaemon: vi.fn().mockReturnValue(true),
	bootstrapTelemetry: vi.fn().mockResolvedValue(undefined),
	flushTelemetryNow: vi.fn().mockResolvedValue(undefined),
	maybeEmitOnboardingProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/GitFsLayout.js", () => ({ resolveGitFsLayout: mocks.resolveGitFsLayout }));

vi.mock("../core/AgentReentry.js", () => ({ isLocalAgentChild: mocks.isLocalAgentChild }));
vi.mock("../core/GitOps.js", () => ({
	isInsideGitRepo: mocks.isInsideGitRepo,
	execGit: mocks.execGit,
}));
vi.mock("../core/Locks.js", () => ({ withRepoHooksLock: mocks.withRepoHooksLock }));
vi.mock("../core/RepoProfile.js", () => ({
	// Pre-cutover default: no fence (plain fn — survives mock resets).
	readCutoverFence: async () => null,
	readManualDisableFlag: mocks.readManualDisableFlag,
}));
vi.mock("../core/SessionTracker.js", () => ({ loadConfig: mocks.loadConfig, saveSession: mocks.saveSession }));
vi.mock("../core/TelemetryStartup.js", () => ({
	bootstrapTelemetry: mocks.bootstrapTelemetry,
	flushTelemetryNow: mocks.flushTelemetryNow,
}));
vi.mock("../core/OnboardingFunnel.js", () => ({ maybeEmitOnboardingProgress: mocks.maybeEmitOnboardingProgress }));
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
vi.mock("../daemon/EnsureGlobalDaemon.js", () => ({
	triggerEnsureGlobalDaemon: mocks.triggerEnsureGlobalDaemon,
	retireGlobalDaemon: vi.fn().mockResolvedValue(true),
}));
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

	it("primes telemetry and emits the onboarding-funnel snapshot after repo-hook reconciliation", async () => {
		await runPluginBootstrap("/repo/subdir");
		expect(mocks.bootstrapTelemetry).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/repo", sessionId: undefined }),
		);
		expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledWith({ cwd: "/repo", config: {} });
		// Both caps: timeoutMs bounds each POST, deadlineMs bounds the whole
		// flush — a full buffer is several sequential POSTs, and this hook blocks
		// the host's session start.
		expect(mocks.flushTelemetryNow).toHaveBeenCalledWith(
			"/repo",
			expect.objectContaining({ timeoutMs: 2_000, deadlineMs: 2_000 }),
		);
	});

	it("orders telemetry by COMPLETION and holds the return until the overlapped flush resolves", async () => {
		// invocationCallOrder only records when each call STARTED — a Promise.all
		// rewrite would pass such an assertion while breaking the real contract:
		// bootstrap must COMPLETE before the emit can track() through its context,
		// the emit must COMPLETE before the flush reads the buffer, and the hook
		// must not return before the flush (started early, awaited late) resolves.
		const timeline: Array<string> = [];
		const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));
		mocks.bootstrapTelemetry.mockImplementation(async () => {
			await tick();
			timeline.push("bootstrap:done");
		});
		mocks.maybeEmitOnboardingProgress.mockImplementation(async () => {
			timeline.push("emit:start");
			await tick();
			timeline.push("emit:done");
		});
		mocks.flushTelemetryNow.mockImplementation(async () => {
			timeline.push("flush:start");
			await tick();
			timeline.push("flush:done");
		});
		await runPluginBootstrap("/repo");
		expect(timeline).toContain("bootstrap:done");
		expect(timeline).toContain("flush:done");
		expect(timeline.indexOf("bootstrap:done")).toBeLessThan(timeline.indexOf("emit:start"));
		expect(timeline.indexOf("emit:done")).toBeLessThan(timeline.indexOf("flush:start"));
		// The flush is STARTED before the briefing build so the two overlap.
		expect(mocks.flushTelemetryNow.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.buildSessionStartContext.mock.invocationCallOrder[0],
		);
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
		// The hook is the one bootstrapTelemetry caller that actually holds a
		// session id — forward it so the funnel events carry the session dimension.
		expect(mocks.bootstrapTelemetry).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/repo", sessionId: "s1" }),
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
		// Never reaches repo-hook reconciliation, so the funnel snapshot must not fire —
		// maybeEmitOnboardingProgress has its own manual-disable gate, but this path
		// should not even pay for loadConfig()/bootstrapTelemetry() to reach it.
		expect(mocks.bootstrapTelemetry).not.toHaveBeenCalled();
		expect(mocks.maybeEmitOnboardingProgress).not.toHaveBeenCalled();
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
		expect(mocks.bootstrapTelemetry).not.toHaveBeenCalled();
	});

	it("takes the worktree root off the filesystem, without asking git twice", async () => {
		mocks.resolveGitFsLayout.mockReturnValueOnce({ worktreeRoot: "/linked-wt" });

		await runPluginBootstrap("/linked-wt/src");

		expect(mocks.installPluginJolliMenu).toHaveBeenCalledWith("/linked-wt");
		// Both the `--git-dir` probe and the `--show-toplevel` that followed it are
		// answered by the one filesystem walk.
		expect(mocks.isInsideGitRepo).not.toHaveBeenCalled();
		expect(mocks.execGit).not.toHaveBeenCalled();
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
		// The onboarding-funnel snapshot fires on BOTH the success and failure branch of
		// repo-hook reconciliation, mirroring EnableCommand's report tail — a failed
		// install is exactly the "installed but never got into a working state" drop-off
		// this snapshot exists to make visible.
		expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledWith({ cwd: "/repo", config: {} });
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
