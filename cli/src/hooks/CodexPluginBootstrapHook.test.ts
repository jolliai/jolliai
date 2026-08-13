import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isLocalAgentChild: vi.fn().mockReturnValue(false),
	isInsideGitRepo: vi.fn().mockResolvedValue(true),
	execGit: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "/repo\n", stderr: "" }),
	withRepoHooksLock: vi.fn(),
	readManualDisableFlag: vi.fn().mockResolvedValue(false),
	loadConfig: vi.fn().mockResolvedValue({}),
	install: vi.fn().mockResolvedValue({ success: true, message: "ok", warnings: [] }),
	uninstall: vi.fn().mockResolvedValue({ success: true, message: "ok", warnings: [] }),
	buildSessionStartContext: vi.fn().mockResolvedValue("codex briefing"),
	ensurePluginDefaultProvider: vi.fn().mockResolvedValue(true),
	readStdin: vi.fn().mockResolvedValue(JSON.stringify({ cwd: "/repo/subdir" })),
	triggerEnsureGlobalDaemon: vi.fn().mockReturnValue(true),
	bootstrapTelemetry: vi.fn().mockResolvedValue(undefined),
	flushTelemetryNow: vi.fn().mockResolvedValue(undefined),
	maybeEmitOnboardingProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../core/AgentReentry.js", () => ({ isLocalAgentChild: mocks.isLocalAgentChild }));
vi.mock("../core/GitOps.js", () => ({
	isInsideGitRepo: mocks.isInsideGitRepo,
	execGit: mocks.execGit,
}));
vi.mock("../core/Locks.js", () => ({ withRepoHooksLock: mocks.withRepoHooksLock }));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: mocks.readManualDisableFlag }));
vi.mock("../core/SessionTracker.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../core/TelemetryStartup.js", () => ({
	BOUNDED_FLUSH_BUDGET_MS: 2_000,
	bootstrapTelemetry: mocks.bootstrapTelemetry,
	flushTelemetryNow: mocks.flushTelemetryNow,
}));
vi.mock("../core/OnboardingFunnel.js", () => ({ maybeEmitOnboardingProgress: mocks.maybeEmitOnboardingProgress }));
vi.mock("../install/Installer.js", () => ({ install: mocks.install, uninstall: mocks.uninstall }));
vi.mock("./SessionStartHook.js", () => ({
	buildSessionStartContext: mocks.buildSessionStartContext,
	ensurePluginDefaultProvider: mocks.ensurePluginDefaultProvider,
}));
vi.mock("./HookUtils.js", () => ({ readStdin: mocks.readStdin }));
vi.mock("../Logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
	setLogDir: vi.fn(),
}));
// `main()` now triggers the detached global-daemon ensure helper after writing
// its stdout envelope. Without this mock the real helper would spawn a
// detached child on every test that reaches `main()`'s success path — real
// process work this unit suite should not depend on.
vi.mock("../daemon/EnsureGlobalDaemon.js", () => ({
	triggerEnsureGlobalDaemon: mocks.triggerEnsureGlobalDaemon,
	retireGlobalDaemon: vi.fn().mockResolvedValue(true),
}));

const { buildCodexBootstrapOutput, main, runCodexPluginBootstrap } = await import("./CodexPluginBootstrapHook.js");

describe("CodexPluginBootstrapHook", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isLocalAgentChild.mockReturnValue(false);
		mocks.isInsideGitRepo.mockResolvedValue(true);
		mocks.execGit.mockResolvedValue({ exitCode: 0, stdout: "/repo\n", stderr: "" });
		mocks.readManualDisableFlag.mockResolvedValue(false);
		mocks.loadConfig.mockResolvedValue({});
		mocks.install.mockResolvedValue({ success: true, message: "ok", warnings: [] });
		mocks.uninstall.mockResolvedValue({ success: true, message: "ok", warnings: [] });
		mocks.buildSessionStartContext.mockResolvedValue("codex briefing");
		mocks.readStdin.mockResolvedValue(JSON.stringify({ cwd: "/repo/subdir" }));
		mocks.withRepoHooksLock.mockImplementation(async (_cwd: string, fn: () => Promise<unknown>) => ({
			acquired: true,
			value: await fn(),
		}));
	});

	describe("output shape", () => {
		/*
		 * The `hookSpecificOutput` envelope is mandatory, and `hookEventName` with it.
		 * Pinned against the schema embedded in the codex binary
		 * (`session-start.command.output`, codex-cli 0.146.0): the top level is
		 * `additionalProperties: false`, so the flat `{ additionalContext }` this used
		 * to emit was rejected outright — `hook: SessionStart Failed`, no briefing in
		 * the model's context, while every side effect still landed and made the
		 * install look healthy. There is no `reloadSkills`: absent from the schema, and
		 * the plugin's skills come from its bundle rather than a file this hook writes.
		 */
		it("wraps the context in the hookSpecificOutput envelope Codex requires", () => {
			expect(buildCodexBootstrapOutput("ctx")).toEqual({
				hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" },
			});
		});

		it("emits nothing when there is no context", () => {
			expect(buildCodexBootstrapOutput(null)).toBeNull();
			expect(buildCodexBootstrapOutput("")).toBeNull();
		});
	});

	describe("host isolation", () => {
		it("reconciles the shared repo runtime under the codex-plugin source tag", async () => {
			await runCodexPluginBootstrap("/repo/subdir");

			expect(mocks.install).toHaveBeenCalledWith("/repo", {
				repoHooksOnly: true,
				sourceTag: "codex-plugin",
				respectManualDisable: true,
				automatic: true,
			});
		});

		it("seeds the provider under its own source tag, not Claude's", async () => {
			await runCodexPluginBootstrap("/repo/subdir");

			expect(mocks.ensurePluginDefaultProvider).toHaveBeenCalledWith("codex-plugin", {});
		});

		it("primes telemetry and emits the onboarding-funnel snapshot after repo-hook reconciliation", async () => {
			await runCodexPluginBootstrap("/repo/subdir");

			expect(mocks.bootstrapTelemetry).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: "/repo", sessionId: undefined }),
			);
			expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledWith({ cwd: "/repo", config: {} });
			// Both caps: timeoutMs bounds each POST, deadlineMs bounds the whole
			// flush — this hook blocks the Codex session start, and a hook the
			// host kills for overrunning loses its stdout envelope entirely.
			expect(mocks.flushTelemetryNow).toHaveBeenCalledWith(
				"/repo",
				expect.objectContaining({ timeoutMs: 2_000, deadlineMs: 2_000 }),
			);
		});

		it("snapshots AFTER the default provider is seeded, and holds the return until the deferred flush resolves", async () => {
			// Fresh-install regression pin: the capture route is seeded by
			// ensurePluginDefaultProvider in this same run, so the snapshot must
			// read the config AFTER that write — earlier and the funnel would
			// misreport capture_method "none" for a state the run repairs
			// milliseconds later. (The chain's internal bootstrap→emit→flush
			// completion ordering is pinned in PluginBootstrapTelemetry.test.ts.)
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
			await runCodexPluginBootstrap("/repo");
			expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledWith({
				cwd: "/repo",
				config: { aiProvider: "local-agent" },
			});
			// The chain is started early (overlapping the briefing build) but the
			// hook must not return before it has fully completed.
			expect(flushDone).toBe(true);
		});

		it("still snapshots when the context-phase lock is contended", async () => {
			// The context phase is where the snapshot normally starts; when its
			// lock is busy the finally-fallback must still emit, or the surface's
			// only per-session trigger goes silent whenever two bootstraps race.
			mocks.withRepoHooksLock
				.mockImplementationOnce(async (_cwd: string, fn: () => Promise<unknown>) => ({
					acquired: true,
					value: await fn(),
				}))
				.mockResolvedValueOnce({ acquired: false });
			await runCodexPluginBootstrap("/repo");
			expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledTimes(1);
			expect(mocks.flushTelemetryNow).toHaveBeenCalledTimes(1);
		});

		// The bare `$jolli` skill ships in the plugin bundle because Codex plugin skill
		// names are flat, so nothing is written into the work tree — no menu install and
		// therefore no git-exclude entry either. Pinned by the module mocks: importing
		// SkillInstaller or GitExclude at all would fail this suite's mock set.
		it("resolves the worktree root from git rather than trusting the session cwd", async () => {
			await runCodexPluginBootstrap("/repo/subdir");

			expect(mocks.execGit).toHaveBeenCalledWith(["rev-parse", "--show-toplevel"], "/repo/subdir");
			expect(mocks.install).toHaveBeenCalledWith("/repo", expect.anything());
		});
	});

	describe("manual disable", () => {
		it("tears down the shared repo hooks and installs nothing", async () => {
			mocks.readManualDisableFlag.mockResolvedValue(true);

			const output = await runCodexPluginBootstrap("/repo/subdir");

			expect(mocks.uninstall).toHaveBeenCalled();
			expect(mocks.install).not.toHaveBeenCalled();
			expect(mocks.bootstrapTelemetry).not.toHaveBeenCalled();
			expect(output).toBeNull();
		});

		// Load-bearing even though this host installs no menu: preserveMenu:false makes
		// uninstall() delete `.claude/skills/jolli/`, and a Codex session must never
		// remove another host's assets.
		it("preserves the other host's menu while tearing down", async () => {
			mocks.readManualDisableFlag.mockResolvedValue(true);

			await runCodexPluginBootstrap("/repo/subdir");

			expect(mocks.uninstall).toHaveBeenCalledWith("/repo", { preserveMenu: true, repoLockHeld: true });
		});
	});

	describe("briefing", () => {
		it("returns the briefing as additionalContext", async () => {
			const output = await runCodexPluginBootstrap("/repo/subdir");

			expect(mocks.buildSessionStartContext).toHaveBeenCalledWith("/repo", "codex-plugin", {
				includeBriefing: true,
				includePluginReminders: true,
			});
			expect(output).toEqual({
				hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "codex briefing" },
			});
		});

		it("skips the briefing when Codex discovery is turned off — but still snapshots", async () => {
			mocks.loadConfig.mockResolvedValue({ codexEnabled: false });

			const output = await runCodexPluginBootstrap("/repo/subdir");

			// Runtime reconciliation still happened — only the Codex-specific context is
			// suppressed, mirroring the Claude path's claudeEnabled gate.
			expect(mocks.install).toHaveBeenCalled();
			expect(mocks.buildSessionStartContext).not.toHaveBeenCalled();
			expect(output).toBeNull();
			// The funnel is host-independent: turning Codex discovery off must not
			// blind the install snapshot (the finally-fallback carries it).
			expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledWith({
				cwd: "/repo",
				config: { codexEnabled: false },
			});
		});

		it("returns no context when repo-hook reconciliation fails", async () => {
			mocks.install.mockResolvedValue({ success: false, message: "boom", warnings: [] });

			expect(await runCodexPluginBootstrap("/repo/subdir")).toBeNull();
			expect(mocks.buildSessionStartContext).not.toHaveBeenCalled();
			// Fires on BOTH the success and failure branch, mirroring the Claude path.
			expect(mocks.maybeEmitOnboardingProgress).toHaveBeenCalledWith({ cwd: "/repo", config: {} });
		});
	});

	describe("guards", () => {
		it("does nothing outside a git repo", async () => {
			mocks.isInsideGitRepo.mockResolvedValue(false);

			expect(await runCodexPluginBootstrap("/tmp/not-a-repo")).toBeNull();
			expect(mocks.install).not.toHaveBeenCalled();
			expect(mocks.bootstrapTelemetry).not.toHaveBeenCalled();
		});

		it("does nothing when rev-parse cannot resolve a toplevel", async () => {
			mocks.execGit.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "fatal" });

			expect(await runCodexPluginBootstrap("/repo/subdir")).toBeNull();
			expect(mocks.install).not.toHaveBeenCalled();
		});

		it("defers when the repo lifecycle lock is busy", async () => {
			mocks.withRepoHooksLock.mockResolvedValue({ acquired: false, value: undefined });

			expect(await runCodexPluginBootstrap("/repo/subdir")).toBeNull();
			expect(mocks.install).not.toHaveBeenCalled();
		});

		// A jollimemory-spawned local agent triggers the host's SessionStart against a
		// throwaway temp cwd; bootstrapping there is pure self-recursion.
		it("main() bails inside a jollimemory-spawned local agent", async () => {
			mocks.isLocalAgentChild.mockReturnValue(true);

			await main();

			expect(mocks.readStdin).not.toHaveBeenCalled();
			expect(mocks.install).not.toHaveBeenCalled();
		});
	});

	describe("main()", () => {
		it("writes the flat output object to stdout", async () => {
			const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			try {
				await main();
				expect(write).toHaveBeenCalledWith(
					JSON.stringify({
						hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "codex briefing" },
					}),
				);
			} finally {
				write.mockRestore();
			}
		});

		it("writes nothing when there is no context", async () => {
			mocks.buildSessionStartContext.mockResolvedValue(null);
			const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
			try {
				await main();
				expect(write).not.toHaveBeenCalled();
			} finally {
				write.mockRestore();
			}
		});

		it("falls back to process.cwd() when the hook input carries no cwd", async () => {
			mocks.readStdin.mockResolvedValue("");

			await main();

			expect(mocks.isInsideGitRepo).toHaveBeenCalledWith(process.cwd());
		});

		it("never throws when the hook input is malformed", async () => {
			mocks.readStdin.mockResolvedValue("{not json");

			await expect(main()).resolves.toBeUndefined();
			expect(mocks.install).not.toHaveBeenCalled();
		});
	});
});

// A source-shape assertion, because no unit test can reach this guard: `VITEST`
// short-circuits it, and the failure it prevents only exists inside an esbuild
// bundle (`import.meta.url` rewritten to the bundle, which is also `argv[1]`, so a
// path-only comparison is true for every inlined module). `QueueWorker` and
// `SessionStartHook` both shipped that bug; this pins the fix for this bootstrap, whose stdout must stay exactly one JSON object.
describe("entry-point guard shape", () => {
	it("gates auto-run on the entry file's basename, not just its path", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("./CodexPluginBootstrapHook.ts", import.meta.url), "utf-8");

		expect(source).toMatch(/entryName === "codexpluginbootstraphook\.js"/);
		expect(source).toMatch(/entryName === "codexpluginbootstraphook\.ts"/);
		expect(source).toMatch(/basename\(argv1\)\.toLowerCase\(\)/);
	});
});
