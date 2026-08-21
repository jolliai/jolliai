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
	BOUNDED_FLUSH_BUDGET_MS: 2_000,
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

	it("snapshots AFTER the default provider is seeded, and holds the return until the deferred flush resolves", async () => {
		// Fresh-install regression pin: the capture route is seeded by
		// ensurePluginDefaultProvider in this same run, so the snapshot must read
		// the config AFTER that write — earlier and the funnel would misreport
		// capture_method "none" for a state the run repairs milliseconds later.
		// (The chain's internal bootstrap→emit→flush completion ordering is
		// pinned in PluginBootstrapTelemetry.test.ts.)
		let seeded = false;
		mocks.ensurePluginDefaultProvider.mockImplementation(async () => {
			seeded = true;
			return true;
		});
		mocks.loadConfig.mockImplementation(async () => (seeded ? { aiProvider: "local-agent" } : {}));
		let flushDone = false;
		mocks.flushTelemetryNow.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			flushDone = true;
		});
		await runPluginBootstrap("/repo");
		expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledWith({
			cwd: "/repo",
			config: { aiProvider: "local-agent" },
		});
		// The chain is started early (overlapping the briefing build) but the
		// hook must not return before it has fully completed.
		expect(flushDone).toBe(true);
	});

	it("still snapshots when the context-phase lock is contended", async () => {
		// The context phase is where the snapshot normally starts; when its lock
		// is busy the finally-fallback must still emit, or the surface's only
		// per-session trigger goes silent whenever two bootstraps race.
		mocks.withRepoHooksLock
			.mockImplementationOnce(async (_cwd: string, fn: () => Promise<unknown>) => ({
				acquired: true,
				value: await fn(),
			}))
			.mockResolvedValueOnce({ acquired: false });
		await runPluginBootstrap("/repo");
		expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledTimes(1);
		expect(mocks.flushTelemetryNow).toHaveBeenCalledTimes(1);
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

	it("does not seed or emit context when Claude integration is disabled — but still snapshots", async () => {
		mocks.loadConfig.mockResolvedValue({ claudeEnabled: false });
		expect(await runPluginBootstrap("/repo")).toBeNull();
		expect(mocks.ensurePluginDefaultProvider).not.toHaveBeenCalled();
		// The funnel is host-independent: turning Claude discovery off must not
		// blind the install snapshot (the finally-fallback carries it).
		expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledWith({
			cwd: "/repo",
			config: { claudeEnabled: false },
		});
	});

	it("main skips local-agent children and swallows malformed stdin", async () => {
		mocks.isLocalAgentChild.mockReturnValueOnce(true);
		await main();
		expect(mocks.readStdin).not.toHaveBeenCalled();

		mocks.isLocalAgentChild.mockReturnValue(false);
		mocks.readStdin.mockResolvedValueOnce("{bad");
		await expect(main()).resolves.toBeUndefined();
	});

	it("keeps going when saveSession rejects — the first session is best-effort", async () => {
		mocks.saveSession.mockRejectedValueOnce(new Error("disk full"));
		const output = await runPluginBootstrap("/repo", { sessionId: "s1", transcriptPath: "/tmp/t.jsonl" });
		expect(mocks.saveSession).toHaveBeenCalled();
		// The rejection is caught and logged; the rest of the bootstrap still runs.
		expect(mocks.install).toHaveBeenCalled();
		expect(output).not.toBeNull();
	});

	it("skips context-phase work when manual-disable flips true between the two lock phases", async () => {
		// menuPhase's read (line ~120) sees not-disabled and proceeds to `install`;
		// the SECOND read, inside the context phase, sees disabled and returns early
		// — a race the first check alone cannot catch.
		mocks.readManualDisableFlag.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		await runPluginBootstrap("/repo");
		expect(mocks.install).toHaveBeenCalled();
		expect(mocks.ensurePluginDefaultProvider).not.toHaveBeenCalled();
		expect(mocks.buildSessionStartContext).not.toHaveBeenCalled();
	});

	it("main falls back to process.cwd() when stdin is blank, and writes nothing when there is no output", async () => {
		mocks.readStdin.mockResolvedValueOnce("   ");
		mocks.isInsideGitRepo.mockResolvedValueOnce(false);
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await main();
			expect(mocks.isInsideGitRepo).toHaveBeenCalledWith(process.cwd());
			expect(writeSpy).not.toHaveBeenCalled();
			// The daemon trigger runs regardless of whether bootstrap produced output.
			expect(mocks.triggerEnsureGlobalDaemon).toHaveBeenCalled();
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("main writes the JSON output to stdout and triggers the global daemon on a full run", async () => {
		mocks.isPluginJolliMenuCanonical.mockResolvedValueOnce(false).mockResolvedValue(true);
		mocks.readStdin.mockResolvedValueOnce(JSON.stringify({ cwd: "/repo/subdir" }));
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await main();
			expect(writeSpy).toHaveBeenCalledTimes(1);
			const written = JSON.parse(writeSpy.mock.calls[0]?.[0] as string);
			expect(written.hookSpecificOutput.hookEventName).toBe("SessionStart");
			expect(mocks.triggerEnsureGlobalDaemon).toHaveBeenCalled();
		} finally {
			writeSpy.mockRestore();
		}
	});
});
