/**
 * DoctorCommand tests — focused on the local-agent tool-selection diagnostic.
 *
 * Covers:
 *   - `getBackend` is probed with the configured `localAgentTool` (defaulting
 *     to "claude-code" when unset)
 *   - a failed probe's message includes that tool's login hint (LOCAL_AGENT_TOOLS)
 *     so a not-signed-in user gets actionable guidance
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JolliMemoryConfig } from "../Types.js";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
	orphanBranchExists: vi.fn(),
	resolveSotBackend: vi.fn(),
	resolveLlmCredentialSource: vi.fn(),
	isWorkerLockStale: vi.fn(),
	releaseWorkerLock: vi.fn(),
	getBackend: vi.fn(),
	readManualDisableFlag: vi.fn(),
	countActiveQueueEntries: vi.fn(),
	getGlobalConfigDir: vi.fn(),
	loadAllSessions: vi.fn(),
	loadConfig: vi.fn(),
	traverseDistPaths: vi.fn(),
	getStatus: vi.fn(),
	install: vi.fn(),
	inspectPlugins: vi.fn(),
	resolveProjectDir: vi.fn(),
}));

vi.mock("../core/GitOps.js", () => ({
	orphanBranchExists: h.orphanBranchExists,
	// Backup's default-folder guard probes whether $HOME is a git worktree (git
	// clean -xdf there would delete every snapshot). The fake HOME is a tmpdir, so
	// "false" is the honest answer and the snapshot proceeds.
	execGit: vi.fn(async () => ({ exitCode: 0, stdout: "false", stderr: "" })),
}));
vi.mock("../core/LlmClient.js", () => ({ resolveLlmCredentialSource: h.resolveLlmCredentialSource }));
vi.mock("../core/Locks.js", () => ({
	isWorkerLockStale: h.isWorkerLockStale,
	releaseWorkerLock: h.releaseWorkerLock,
	// The repo-registry row's dry-run repair pass takes this lock. A plain
	// pass-through rather than a spy: these tests are about doctor's output, and an
	// unmocked export throws on the very first check that reaches it.
	withRepoRegistryLock: async <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock("../core/localagent/BackendRegistry.js", () => ({ getBackend: h.getBackend }));
vi.mock("../core/RepoProfile.js", () => ({
	// Pre-cutover default: no fence (plain fn — survives mock resets).
	readCutoverFence: async () => null,
	readManualDisableFlag: h.readManualDisableFlag,
}));
vi.mock("../core/SessionTracker.js", () => ({
	countActiveQueueEntries: h.countActiveQueueEntries,
	getGlobalConfigDir: h.getGlobalConfigDir,
	loadAllSessions: h.loadAllSessions,
	loadConfig: h.loadConfig,
}));
vi.mock("../core/SotStorageResolver.js", () => ({ resolveSotBackend: h.resolveSotBackend }));
vi.mock("../install/DistPathResolver.js", () => ({ traverseDistPaths: h.traverseDistPaths }));
vi.mock("../install/Installer.js", () => ({ getStatus: h.getStatus, install: h.install }));
vi.mock("../PluginLoader.js", () => ({ inspectPlugins: h.inspectPlugins }));
vi.mock("../Logger.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../Logger.js")>();
	return {
		...actual,
		setLogDir: vi.fn(),
		createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
	};
});
vi.mock("./CliUtils.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./CliUtils.js")>();
	return { ...actual, resolveProjectDir: h.resolveProjectDir };
});

import { setIsolatedHome } from "../testUtils/isolatedHome.js";
import { registerDoctorCommand } from "./DoctorCommand.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Runs `jolli doctor` with the given args and returns captured stdout lines. */
async function runDoctor(args: string[] = []): Promise<string[]> {
	const program = new Command();
	program.exitOverride();
	registerDoctorCommand(program);

	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	});
	try {
		await program.parseAsync(["doctor", ...args], { from: "user" });
	} finally {
		spy.mockRestore();
	}
	return lines;
}

const BASE_CONFIG: Partial<JolliMemoryConfig> = {};

describe("DoctorCommand — local-agent tool diagnostic", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = undefined;
		h.resolveProjectDir.mockReturnValue("/repo");
		h.readManualDisableFlag.mockResolvedValue(false);
		h.getStatus.mockResolvedValue({ gitHookInstalled: true, claudeHookInstalled: true, geminiHookInstalled: true });
		h.orphanBranchExists.mockResolvedValue(true);
		h.resolveSotBackend.mockResolvedValue({ ok: true, state: "uncutover", storage: {} });
		h.isWorkerLockStale.mockResolvedValue(false);
		h.loadAllSessions.mockResolvedValue([]);
		h.countActiveQueueEntries.mockResolvedValue(0);
		h.loadConfig.mockResolvedValue(BASE_CONFIG);
		h.resolveLlmCredentialSource.mockReturnValue("local-agent");
		h.getGlobalConfigDir.mockReturnValue("/global");
		h.traverseDistPaths.mockReturnValue([]);
		h.inspectPlugins.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
		process.exitCode = undefined;
	});

	it("survives a registry it cannot read, and still prints every other check", async () => {
		// The repo-registry row reads STRICTLY (its repair pass is a
		// read-modify-write), so corrupt JSON throws — and nothing has been printed
		// by then, so an unguarded throw costs the user all ten diagnoses above it on
		// exactly the machine doctor exists for.
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "jolli-doctor-corrupt-"));
		h.getGlobalConfigDir.mockReturnValue(dir);
		writeFileSync(join(dir, "dashboard-repos.json"), "{ not json", "utf-8");
		h.getBackend.mockReturnValue({
			discoverExecutable: vi.fn().mockResolvedValue({ file: "/usr/bin/claude", version: "2.0.0" }),
		});

		try {
			const joined = (await runDoctor()).join("\n");

			expect(joined).toContain("Jolli Memory Doctor");
			expect(joined).toContain("Git hooks");
			expect(joined).toContain("Repo registry");
			expect(joined).toContain("unreadable");
			// The survey reads fail-open, so it would have answered "0 repos, every
			// recorded checkout present" about a registry nothing could read. Sharing
			// the guard is what stops that reaching the screen.
			expect(joined).not.toContain("every recorded checkout present");
			expect(process.exitCode).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			process.exitCode = undefined;
		}
	});

	it("probes getBackend with the configured localAgentTool (not the claude-code default)", async () => {
		h.loadConfig.mockResolvedValue({ localAgentTool: "codex" } as Partial<JolliMemoryConfig>);
		h.getBackend.mockReturnValue({
			discoverExecutable: vi.fn().mockResolvedValue({ file: "/usr/bin/codex", version: "1.2.3" }),
		});

		await runDoctor();

		expect(h.getBackend).toHaveBeenCalledWith("codex");
	});

	it("defaults to claude-code when localAgentTool is unset", async () => {
		h.getBackend.mockReturnValue({
			discoverExecutable: vi.fn().mockResolvedValue({ file: "/usr/bin/claude", version: "2.0.0" }),
		});

		await runDoctor();

		expect(h.getBackend).toHaveBeenCalledWith("claude-code");
	});

	it("appends the tool's login hint to the fail message when discovery fails (opencode)", async () => {
		h.loadConfig.mockResolvedValue({ localAgentTool: "opencode" } as Partial<JolliMemoryConfig>);
		h.getBackend.mockReturnValue({
			discoverExecutable: vi.fn().mockRejectedValue(new Error("opencode not found on PATH")),
		});

		const lines = await runDoctor();
		const joined = lines.join("\n");

		expect(joined).toContain("opencode not found on PATH");
		// LOCAL_AGENT_TOOLS.opencode.loginHint
		expect(joined).toContain("opencode auth login");
		expect(process.exitCode).toBe(1);
	});

	it("appends the tool's login hint to the fail message when discovery fails (cursor-agent)", async () => {
		h.loadConfig.mockResolvedValue({ localAgentTool: "cursor-agent" } as Partial<JolliMemoryConfig>);
		h.getBackend.mockReturnValue({
			discoverExecutable: vi.fn().mockRejectedValue(new Error("cursor-agent not found")),
		});

		const lines = await runDoctor();
		const joined = lines.join("\n");

		expect(joined).toContain("cursor-agent not found");
		// LOCAL_AGENT_TOOLS["cursor-agent"].loginHint
		expect(joined).toContain("cursor-agent login");
	});

	it("appends the claude-code login hint when discovery fails and no tool is configured", async () => {
		h.getBackend.mockReturnValue({
			discoverExecutable: vi.fn().mockRejectedValue(new Error("claude not found")),
		});

		const lines = await runDoctor();
		const joined = lines.join("\n");

		expect(joined).toContain("claude not found");
		expect(joined).toContain("Run `claude` once and sign in");
	});

	it("names localAgentPath as the likely cause when the probe fails with one configured", async () => {
		// An override short-circuits discovery, so a stale path IS the failure —
		// including a path orphaned by an older version that didn't clear it on a
		// tool switch. Nothing else tells the user discovery never ran.
		h.loadConfig.mockResolvedValue({
			localAgentTool: "cursor-agent",
			localAgentPath: "/opt/codex",
		} as Partial<JolliMemoryConfig>);
		h.getBackend.mockReturnValue({
			discoverExecutable: vi
				.fn()
				.mockRejectedValue(
					new Error('Configured local agent path "/opt/codex" is not a working cursor-agent CLI.'),
				),
		});

		const joined = (await runDoctor()).join("\n");

		expect(joined).toContain("Discovery was skipped because localAgentPath is set");
		expect(joined).toContain("jolli configure --remove localAgentPath");
	});

	it("omits the localAgentPath hint when the probe fails without one", async () => {
		h.getBackend.mockReturnValue({
			discoverExecutable: vi.fn().mockRejectedValue(new Error("claude not found")),
		});

		expect((await runDoctor()).join("\n")).not.toContain("localAgentPath");
	});

	it("skips the local-agent probe entirely when the credential source isn't local-agent", async () => {
		h.resolveLlmCredentialSource.mockReturnValue("anthropic-config");

		const lines = await runDoctor();

		expect(h.getBackend).not.toHaveBeenCalled();
		expect(lines.join("\n")).not.toContain("Local agent CLI");
	});

	// ─── System-of-record / orphan-branch rows ───────────────────────────────
	// The orphan row is informational in every state; what changes is whether it
	// says the branch is coming or frozen. Getting that backwards points the one
	// reader with a broken repo at the wrong explanation.

	it("names the backend that holds the truth on an un-cutover repo", async () => {
		const lines = (await runDoctor()).join("\n");
		expect(lines).toContain("System of record");
		expect(lines).toContain("orphan branch (jollimemory/summaries/v3)");
		expect(lines).toContain("exists");
	});

	it("names SQLite and calls the surviving branch frozen once the repo is cut over", async () => {
		h.resolveSotBackend.mockResolvedValue({ ok: true, state: "cutover", storage: {} });

		const lines = (await runDoctor()).join("\n");

		expect(lines).toContain("SQLite (cutover)");
		expect(lines).toContain("present but frozen");
	});

	it("reports a fenced repo with an absent branch as expected, not as a pending first commit", async () => {
		h.resolveSotBackend.mockResolvedValue({ ok: true, state: "legacy-fenced", storage: {} });
		h.orphanBranchExists.mockResolvedValue(false);

		const lines = (await runDoctor()).join("\n");

		expect(lines).toContain("SQLite (legacy-fenced)");
		expect(lines).toContain("absent (expected");
		expect(lines).not.toContain("will be created on first commit");
	});

	it("fails the system-of-record row (and still explains the branch) when no backend is available", async () => {
		// `blocked` is reported only for a repo that IS fenced, so the branch row
		// must read as cut over here — telling this user the branch "will be
		// created on first commit" promises what the fence forbids.
		h.resolveSotBackend.mockResolvedValue({ ok: false, reason: "database file does not exist" });
		h.orphanBranchExists.mockResolvedValue(false);

		const lines = (await runDoctor()).join("\n");

		expect(lines).toContain("unavailable — database file does not exist");
		expect(lines).toContain("absent (expected");
		expect(lines).not.toContain("will be created on first commit");
	});

	it("--dry-run lists what --fix would do and applies nothing", async () => {
		h.getStatus.mockResolvedValue({
			gitHookInstalled: false,
			claudeHookInstalled: true,
			geminiHookInstalled: true,
		});

		const lines = (await runDoctor(["--dry-run"])).join("\n");

		expect(lines).toContain("--fix would apply:");
		expect(lines).toContain("→ Git hooks:");
		expect(lines).not.toContain("Applying fixes...");
		expect(h.install).not.toHaveBeenCalled();
		// Nothing was repaired, so it exits like a plain report.
		expect(process.exitCode).toBe(1);
	});

	it("--fix applies the fixers and reports each one", async () => {
		h.getStatus.mockResolvedValue({
			gitHookInstalled: false,
			claudeHookInstalled: true,
			geminiHookInstalled: true,
		});
		h.install.mockResolvedValue({ success: true, warnings: [] });

		const lines = (await runDoctor(["--fix"])).join("\n");

		expect(lines).toContain("Applying fixes...");
		expect(lines).toContain("Git hooks: reinstalled");
		expect(lines).not.toContain("--fix would apply:");
		expect(h.install).toHaveBeenCalled();
	});
});

describe("global daemon check", () => {
	it("reports the daemon as running with its pid, version and uptime", async () => {
		const { formatGlobalDaemonCheck } = await import("./DoctorCommand.js");
		const check = formatGlobalDaemonCheck(
			{ t: "hello", protocol: 1, version: "0.99.3", pid: 4242, startedAt: 1_000_000 },
			1_000_000 + 3 * 60 * 60 * 1000,
		);

		expect(check.status).toBe("ok");
		expect(check.message).toContain("4242");
		expect(check.message).toContain("0.99.3");
		expect(check.message).toContain("3h");
	});

	it("reports 'not running' as a warning, never a failure", async () => {
		const { formatGlobalDaemonCheck } = await import("./DoctorCommand.js");
		const check = formatGlobalDaemonCheck(undefined, Date.now());

		// Not a failure: backups still land from the opportunistic callers, and
		// the row that reports whether they ACTUALLY landed is "Database backup".
		expect(check.status).toBe("warn");
		expect(check.message).toContain("not running");
	});
});

describe("repo registry check", () => {
	const repo = (repoIdentity: string, worktreeRoot: string) => ({
		repoIdentity,
		repoName: "r",
		worktreeRoot,
		enabledAt: "t",
	});
	const empty = { live: [], disposable: [], dead: [], unavailable: [] };
	const fixer = async () => "did it";

	it("is ok, and offers no fixer, when every recorded checkout is present", async () => {
		const { formatRepoRegistryCheck } = await import("./DoctorCommand.js");
		const check = formatRepoRegistryCheck({ ...empty, live: [repo("a", "/here")] }, [], fixer);

		expect(check.status).toBe("ok");
		expect(check.message).toContain("1 repo");
		expect(check.fixer).toBeUndefined();
	});

	it("warns rather than failing — a stale entry breaks nothing", async () => {
		const { formatRepoRegistryCheck } = await import("./DoctorCommand.js");
		const check = formatRepoRegistryCheck({ ...empty, dead: [repo("a", "/gone")] }, [], fixer);

		// A `fail` would exit 1 on an otherwise healthy machine over a row that
		// only wastes a sweep.
		expect(check.status).toBe("warn");
	});

	it("offers no fixer for a dead entry until --forget-dead-repos is passed", async () => {
		const { formatRepoRegistryCheck } = await import("./DoctorCommand.js");
		const survey = { ...empty, dead: [repo("a", "/gone")] };

		// Plain `--fix` must not delete a repo's memories as a side effect of
		// releasing a lock — and a button that would do nothing is not offered.
		const plain = formatRepoRegistryCheck(survey, [], fixer);
		expect(plain.fixer).toBeUndefined();
		expect(plain.message).toContain("1 to forget with --forget-dead-repos");
		expect(plain.message).toContain("removed by --fix --forget-dead-repos");

		const optedIn = formatRepoRegistryCheck(survey, [], fixer, { forgetDead: true });
		expect(optedIn.fixer).toBeDefined();
		expect(optedIn.message).toContain("1 entry to remove");
		expect(optedIn.message).not.toContain("--forget-dead-repos");
	});

	it("still offers the repair fixer while a dead entry waits for its flag", async () => {
		const { formatRepoRegistryCheck } = await import("./DoctorCommand.js");
		const check = formatRepoRegistryCheck(
			{ ...empty, dead: [repo("a", "/gone")] },
			[{ repoIdentity: "b", droppedPaths: ["/tmp/x"], collapsedPaths: [] }],
			fixer,
		);

		// The two halves are independent: withholding the removal must not withhold
		// the path repair, which deletes nothing.
		expect(check.fixer).toBeDefined();
		expect(check.message).toContain("1 to repair");
	});

	it("names every entry rather than only counting them", async () => {
		const { formatRepoRegistryCheck } = await import("./DoctorCommand.js");
		const check = formatRepoRegistryCheck(
			{
				...empty,
				disposable: [repo("local:t", "/tmp/fix/repo")],
				dead: [repo("https://x/y", "/gone/real")],
			},
			[],
			fixer,
			{ forgetDead: true },
		);

		expect(check.message).toContain("2 entries to remove");
		expect(check.message).toContain("/tmp/fix/repo");
		expect(check.message).toContain("/gone/real");
		expect(check.message).toContain("removed automatically");
		expect(check.message).toContain("removed by --fix");
	});

	it("reports an unavailable volume and offers NO fixer for it", async () => {
		const { formatRepoRegistryCheck } = await import("./DoctorCommand.js");
		const check = formatRepoRegistryCheck({ ...empty, unavailable: [repo("a", "Z:\\work\\repo")] }, [], fixer);

		// The ticket's rule: warn, never remove. A button that must not act is
		// worse than no button.
		expect(check.status).toBe("warn");
		expect(check.fixer).toBeUndefined();
		expect(check.message).toContain("not mounted");
		expect(check.message).toContain("left alone");
	});

	describe("the fixer", () => {
		let fixDir: string;

		beforeEach(async () => {
			const { mkdtempSync } = await import("node:fs");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");
			fixDir = mkdtempSync(join(tmpdir(), "jolli-doctor-fix-"));
		});

		afterEach(async () => {
			const { rmSync } = await import("node:fs");
			rmSync(fixDir, { recursive: true, force: true });
		});

		const seedRegistry = async (repos: ReadonlyArray<unknown>): Promise<void> => {
			const { getRepoRegistryPath } = await import("../dashboard/RepoRegistry.js");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(getRepoRegistryPath(fixDir), JSON.stringify({ version: 1, repos }), "utf-8");
		};

		it("backs the registry up before removing anything, and says where", async () => {
			const { applyRepoRegistryFix } = await import("./DoctorCommand.js");
			const { existsSync, readFileSync } = await import("node:fs");
			const { getRepoRegistryPath } = await import("../dashboard/RepoRegistry.js");
			await seedRegistry([{ repoIdentity: "https://x/y", repoName: "r", worktreeRoot: "/gone", enabledAt: "t" }]);

			const message = await applyRepoRegistryFix(
				{ ...empty, dead: [repo("https://x/y", "/gone")] },
				{
					configDir: fixDir,
					dbPath: `${fixDir}/none.db`,
					nowMs: Date.UTC(2026, 7, 17, 1, 2, 3),
					forgetDead: true,
				},
			);

			expect(message).toContain("backed up the registry to");
			expect(message).toContain("forgot 1 entry");
			// The backup holds the state BEFORE the removal — that is the whole point.
			// `[^;]+`, not `\S+`: the parts are joined with "; " and a path has no
			// spaces to stop a greedy match at.
			const backup = /backed up the registry to ([^;]+)/.exec(message)?.[1];
			expect(backup && existsSync(backup)).toBe(true);
			expect(JSON.parse(readFileSync(backup as string, "utf-8")).repos).toHaveLength(1);
			expect(JSON.parse(readFileSync(getRepoRegistryPath(fixDir), "utf-8")).repos).toEqual([]);
		});

		it("throws when a removal failed rather than reporting a partial success", async () => {
			const { applyRepoRegistryFix } = await import("./DoctorCommand.js");
			const forget = await import("../dashboard/RepoForget.js");
			const spy = vi.spyOn(forget, "forgetRepos").mockResolvedValue([
				{
					identity: "https://x/y",
					removedFromRegistry: false,
					repoRowDeleted: false,
					childRowsDeleted: 0,
					pendingEventsDeleted: 0,
					error: "database is locked",
				},
			]);
			try {
				await expect(
					applyRepoRegistryFix(
						{ ...empty, dead: [repo("https://x/y", "/gone")] },
						{ configDir: fixDir, forgetDead: true },
					),
				).rejects.toThrow(/database is locked/);
			} finally {
				spy.mockRestore();
			}
		});

		it("leaves a dead entry alone unless the fix was asked for it", async () => {
			const { applyRepoRegistryFix } = await import("./DoctorCommand.js");
			const forget = await import("../dashboard/RepoForget.js");
			const spy = vi.spyOn(forget, "forgetRepos");
			await seedRegistry([{ repoIdentity: "https://x/y", repoName: "r", worktreeRoot: "/gone", enabledAt: "t" }]);

			try {
				const message = await applyRepoRegistryFix(
					{ ...empty, dead: [repo("https://x/y", "/gone")] },
					{ configDir: fixDir },
				);

				// The registry is still backed up (the repair pass rewrites it too), but
				// nothing was forgotten — the twelve child tables `forgetRepos` deletes
				// are exactly what no backup here restores.
				expect(spy).not.toHaveBeenCalled();
				expect(message).not.toContain("forgot");
				const { readFileSync } = await import("node:fs");
				const { getRepoRegistryPath } = await import("../dashboard/RepoRegistry.js");
				expect(JSON.parse(readFileSync(getRepoRegistryPath(fixDir), "utf-8")).repos).toHaveLength(1);
			} finally {
				spy.mockRestore();
			}
		});

		/**
		 * JOLLI-2212's acceptance case, on the shape it was measured in: a registry
		 * carrying 84 fixture entries under the system temp directory plus ONE real
		 * repo whose `worktrees` had two of those fixture paths merged into it. One
		 * pass has to remove the 84 and repair the 1, without touching the real
		 * repo's own checkout.
		 *
		 * The `C:` / `c:` half of that entry is pinned by RepoRegistry's own win32
		 * case instead: `sameRecordedRoot` folds case by platform on purpose, and the
		 * doctor's fixer takes the host's — so asserting it here would pass on Windows
		 * and quietly assert nothing on Linux.
		 */
		it("removes the measured fixture entries and repairs the real one in a single pass", async () => {
			const { surveyRepoRegistry } = await import("../dashboard/RepoForget.js");
			const { applyRepoRegistryFix } = await import("./DoctorCommand.js");
			const { getRepoRegistryPath } = await import("../dashboard/RepoRegistry.js");
			const { mkdirSync, mkdtempSync, readFileSync, rmSync } = await import("node:fs");
			const { tmpdir } = await import("node:os");
			const { join } = await import("node:path");

			// Under the REAL temp dir: the fixer's repair pass asks `tempRoots()`, not
			// an injected list, so a fake root would make the drop a no-op.
			const scratch = mkdtempSync(join(tmpdir(), "jolli-2212-"));
			const live = join(scratch, "jollimemory-design");
			mkdirSync(live, { recursive: true });
			const ghosts = [
				join(scratch, "jolli-cutover-sG1Rx7", "repo"),
				join(scratch, "jolli-cutover-sG1Rx7", "repo2"),
			];
			const fixtures = Array.from({ length: 84 }, (_, i) => ({
				repoIdentity: `local:${String(i).padStart(32, "0")}`,
				repoName: "repo",
				worktreeRoot: join(scratch, `fixture-${i}`, "repo"),
				enabledAt: "1970-01-01T00:00:00.000Z",
			}));
			await seedRegistry([
				...fixtures,
				{
					repoIdentity: "https://github.com/jolliai/jolli-design",
					repoName: "jolli-design",
					worktreeRoot: live,
					worktrees: [...ghosts, live],
					remoteUrl: "https://github.com/jolliai/jolli-design",
					enabledAt: "2026-08-01T00:00:00.000Z",
				},
			]);

			try {
				const dbPath = join(scratch, "none.db");
				const survey = await surveyRepoRegistry({ configDir: fixDir, dbPath });
				expect(survey.disposable).toHaveLength(84);
				expect(survey.live.map((r) => r.repoIdentity)).toEqual(["https://github.com/jolliai/jolli-design"]);

				const message = await applyRepoRegistryFix(survey, { configDir: fixDir, dbPath });

				expect(message).toContain("forgot 84 entries");
				expect(message).toContain("repaired 1 entry");
				const after = JSON.parse(readFileSync(getRepoRegistryPath(fixDir), "utf-8"));
				expect(after.repos).toHaveLength(1);
				expect(after.repos[0].repoIdentity).toBe("https://github.com/jolliai/jolli-design");
				// The fixture paths are gone from its list; its own checkout is untouched.
				expect(after.repos[0].worktrees).toEqual([live]);
				expect(after.repos[0].worktreeRoot).toBe(live);
			} finally {
				rmSync(scratch, { recursive: true, force: true });
			}
		});

		it("says so when there turned out to be nothing left to do", async () => {
			// Reachable when another window cleaned up between the survey and the fix:
			// nothing removable, nothing repairable, and no registry left to back up.
			const { applyRepoRegistryFix } = await import("./DoctorCommand.js");
			expect(await applyRepoRegistryFix(empty, { configDir: fixDir })).toBe("nothing left to do");
		});
	});

	it("describes a repairable entry by what is wrong with it", async () => {
		const { formatRepoRegistryCheck } = await import("./DoctorCommand.js");
		const check = formatRepoRegistryCheck(
			{ ...empty, live: [repo("id", "/here")] },
			[{ repoIdentity: "id", droppedPaths: ["/tmp/x"], collapsedPaths: ["C:\\A"], repointedTo: "/here" }],
			fixer,
		);

		expect(check.message).toContain("1 to repair");
		expect(check.message).toContain("1 stale temp path(s)");
		expect(check.message).toContain("1 duplicate spelling(s)");
		expect(check.message).toContain("a dead recorded root");
		expect(check.fixer).toBeDefined();
	});

	it("fails, with no fixer, when the registry could not be read at all", async () => {
		const { formatRepoRegistryReadFailure } = await import("./DoctorCommand.js");
		const check = formatRepoRegistryReadFailure(
			"Unexpected token } in JSON at position 12",
			"/home/u/.jolli/jollimemory/dashboard-repos.json",
		);

		// A fault, not a warning: every writer of this file is a read-modify-write
		// over the strict read, so no repo can register until it is resolved.
		expect(check.status).toBe("fail");
		expect(check.message).toContain("Unexpected token");
		expect(check.message).toContain("dashboard-repos.json");
		// No fixer: the remedy discards every registration the file holds, which is
		// not something `--fix` may decide on the user's behalf.
		expect(check.fixer).toBeUndefined();
	});
});

describe("doctor --recover", () => {
	it("lists candidates under a fake HOME and reports a failed restore", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { runRecover } = await import("./DoctorCommand.js");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-recover-"));
		const restoreHome = setIsolatedHome(home);
		// This file mocks SessionTracker wholesale; point the two functions the
		// recovery path uses at the fake HOME.
		const st = await import("../core/SessionTracker.js");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(join(home, ".jolli", "jollimemory"));
		vi.mocked(st.loadConfig).mockResolvedValue({});
		const logs: string[] = [];
		const errs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
		const errSpy = vi.spyOn(console, "error").mockImplementation((m) => void errs.push(String(m)));
		try {
			// Survey-only: absent database, fresh-install verdict, zero candidates.
			await runRecover();
			const out = logs.join("\n");
			expect(out).toContain("Snapshot candidates (0)");
			expect(out).toContain("fresh-install");
			expect(out).toContain("--from <snapshot path>");
			// A restore attempt from a missing snapshot fails loudly, not silently.
			await runRecover(join(home, "missing.db"));
			expect(errs.join("\n")).toContain("Restore failed");
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;

			// End to end under the fake HOME: build a real database at the machine
			// default path, snapshot it, delete it, and recover via --from.
			const { withDashboardDb } = await import("../dashboard/DashboardDb.js");
			const { maybeSnapshot } = await import("../dashboard/Backup.js");
			const dbPath = join(home, ".jolli", "jollimemory", "jollimemory.db");
			const snap = await withDashboardDb(
				(db) => maybeSnapshot(db, { dbPath, nowMs: Date.UTC(2026, 7, 4), config: {}, force: true }),
				{ dbPath },
			);
			expect(snap.status).toBe("created");
			// Healthy database + listed candidates: the non-absent, non-empty arms,
			// including a pre-migration tag and an unparsable-stamp age.
			const { writeFileSync, mkdirSync } = await import("node:fs");
			mkdirSync(join(home, "jolli_back"), { recursive: true });
			writeFileSync(join(home, "jolli_back", "memory-premigration-20260101T000000Z-aaaaaaaa.db"), "x");
			writeFileSync(join(home, "jolli_back", "memory-99999999T999999Z-bbbbbbbb.db"), "x");
			logs.length = 0;
			await runRecover();
			const listed = logs.join("\n");
			expect(listed).toContain("Snapshot candidates (3)");
			expect(listed).toContain("[pre-migration]");
			expect(listed).toContain("(unparsable stamp)");
			rmSync(dbPath, { force: true });
			logs.length = 0;
			await runRecover((snap as { path: string }).path);
			expect(logs.join("\n")).toContain("Restored from");
		} finally {
			process.exitCode = 0;
			logSpy.mockRestore();
			errSpy.mockRestore();
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("doctor --schema-log", () => {
	it("prints the log, names a drift, and records a migration whose row went missing", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { runSchemaLog } = await import("./DoctorCommand.js");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-schemalog-"));
		const restoreHome = setIsolatedHome(home);
		const st = await import("../core/SessionTracker.js");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(join(home, ".jolli", "jollimemory"));
		const logs: string[] = [];
		const errs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
		const errSpy = vi.spyOn(console, "error").mockImplementation((m) => void errs.push(String(m)));
		try {
			const { withDashboardDb, withRepairDashboardDb } = await import("../dashboard/DashboardDb.js");
			// No database yet: the report says so instead of failing.
			await runSchemaLog({});
			expect(logs.join("\n")).toContain("Migration log: none");

			await withDashboardDb(() => undefined);
			logs.length = 0;
			await runSchemaLog({});
			const listing = logs.join("\n");
			// The one-SQL answer to "who ran what, when" — the whole diagnostic payoff.
			expect(listing).toContain("Migration log (oldest first)");
			expect(listing).toContain("BASELINE_DDL");
			expect(listing).toContain("applied");

			// Drift is REPORTED, not repaired: it no longer blocks anything, so there is
			// nothing to unblock and no `--accept-schema-ddl`.
			await withRepairDashboardDb((db) => {
				db.prepare("UPDATE schema_migrations SET ddl = 'from an unmerged branch' WHERE name = ?").run(
					"RECALL_RECEIPTS_DDL",
				);
			});
			logs.length = 0;
			await runSchemaLog({});
			expect(logs.join("\n")).toContain("Applied by a different build than this one: RECALL_RECEIPTS_DDL");
			expect(logs.join("\n")).toContain("not a fault");

			// The one repair left: record a name whose log row went missing, and refuse
			// a name this build does not carry.
			await withRepairDashboardDb((db) =>
				db.prepare("DELETE FROM schema_migrations WHERE name = ?").run("TOOL_CALL_TIME_DDL"),
			);
			logs.length = 0;
			await runSchemaLog({ mark: "TOOL_CALL_TIME_DDL" });
			expect(logs.join("\n")).toContain("Recorded TOOL_CALL_TIME_DDL as applied.");
			await runSchemaLog({ mark: "NOT_A_MIGRATION" });
			expect(errs.join("\n")).toContain("Unknown migration: NOT_A_MIGRATION");
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;

			// A log table that EXISTS but cannot be read is the state this report is for.
			// Reporting it as "none" would send the reader looking for a database that
			// predates the log — the one thing this file is not.
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			try {
				await withRepairDashboardDb((db) =>
					db.exec("ALTER TABLE schema_migrations RENAME COLUMN ddl TO ddl_moved_by_another_build"),
				);
				logs.length = 0;
				errs.length = 0;
				await runSchemaLog({});
				expect(logs.join("\n")).not.toContain("Migration log: none");
				expect(errs.join("\n")).toContain("PRESENT BUT UNREADABLE");
				expect(process.exitCode).toBe(1);
				process.exitCode = 0;
				// And the repair says which of its two "cannot record" reasons applies.
				errs.length = 0;
				await runSchemaLog({ mark: "TOOL_CALL_TIME_DDL" });
				expect(errs.join("\n")).toContain("The migration log exists but could not be read");
				expect(process.exitCode).toBe(1);
				process.exitCode = 0;
			} finally {
				warnSpy.mockRestore();
			}
		} finally {
			process.exitCode = 0;
			logSpy.mockRestore();
			errSpy.mockRestore();
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("does not CREATE a database when --mark-migration is run without one", async () => {
		// A writable `node:sqlite` open creates the file, so the repair used to manufacture
		// an empty database and then report that it had no log — a diagnostic producing the
		// artifact it is diagnosing. The existence check has to be read-only and first.
		const { mkdtempSync, mkdirSync, rmSync, existsSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { runSchemaLog } = await import("./DoctorCommand.js");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-schemalog-nodb-"));
		const restoreHome = setIsolatedHome(home);
		const st = await import("../core/SessionTracker.js");
		const configDir = join(home, ".jolli", "jollimemory");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(configDir);
		const errs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const errSpy = vi.spyOn(console, "error").mockImplementation((m) => void errs.push(String(m)));
		try {
			mkdirSync(configDir, { recursive: true });
			await runSchemaLog({ mark: "BASELINE_DDL" });
			expect(errs.join("\n")).toContain("does not exist yet");
			expect(existsSync(join(configDir, "jollimemory.db"))).toBe(false);
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = 0;
			logSpy.mockRestore();
			errSpy.mockRestore();
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("reports a database it cannot OPEN as unavailable, never as a missing log", async () => {
		// The opposite of what a diagnostic command should do: corruption, a permission
		// problem or a sidecars-only recovery state all arrive as a thrown open, and
		// mapping those onto "this database predates the log — run any Jolli command that
		// writes first" points the reader at the one explanation that is certainly wrong.
		const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { runSchemaLog } = await import("./DoctorCommand.js");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-schemalog-broken-"));
		const restoreHome = setIsolatedHome(home);
		const st = await import("../core/SessionTracker.js");
		const configDir = join(home, ".jolli", "jollimemory");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(configDir);
		const logs: string[] = [];
		const errs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
		const errSpy = vi.spyOn(console, "error").mockImplementation((m) => void errs.push(String(m)));
		try {
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "jollimemory.db"), "this is not a database");
			await runSchemaLog({});
			expect(logs.join("\n")).not.toContain("Migration log: none");
			expect(errs.join("\n")).toContain("Migration log: UNAVAILABLE");
			expect(errs.join("\n")).toContain("NOT a database that predates the log");
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = 0;
			logSpy.mockRestore();
			errSpy.mockRestore();
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("--mark-migration DIAGNOSES a database it cannot open instead of throwing", async () => {
		// The repair's open is writable and unguarded: an existing-but-corrupt (or locked,
		// or permission-denied) `.db` used to throw straight out of runSchemaLog, so the
		// "database could not be read" guidance the command was written to print was never
		// reached. It must degrade to that diagnosis and exit 1, never propagate the throw.
		const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { runSchemaLog } = await import("./DoctorCommand.js");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-schemalog-markbroken-"));
		const restoreHome = setIsolatedHome(home);
		const st = await import("../core/SessionTracker.js");
		const configDir = join(home, ".jolli", "jollimemory");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(configDir);
		const errs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const errSpy = vi.spyOn(console, "error").mockImplementation((m) => void errs.push(String(m)));
		try {
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "jollimemory.db"), "this is not a database");
			// The whole point: the call resolves, it does not reject.
			await expect(runSchemaLog({ mark: "TOOL_CALL_TIME_DDL" })).resolves.toBeUndefined();
			expect(errs.join("\n")).toContain("could not be read");
			expect(errs.join("\n")).not.toContain("does not exist yet");
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = 0;
			logSpy.mockRestore();
			errSpy.mockRestore();
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("routes the sidecars-only recovery state to --recover, never to 'no log yet'", async () => {
		// `.db` deleted out from under a live database while its -wal/-shm remain is the ONE
		// recovery alarm (DbDetection). Discriminating on `.db` existence alone collapsed it
		// into `none` / "does not exist yet" — the opposite of the recovery path — on both
		// the report and the mark path.
		const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { runSchemaLog } = await import("./DoctorCommand.js");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-schemalog-sidecars-"));
		const restoreHome = setIsolatedHome(home);
		const st = await import("../core/SessionTracker.js");
		const configDir = join(home, ".jolli", "jollimemory");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(configDir);
		const logs: string[] = [];
		const errs: string[] = [];
		const logSpy = vi.spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
		const errSpy = vi.spyOn(console, "error").mockImplementation((m) => void errs.push(String(m)));
		try {
			mkdirSync(configDir, { recursive: true });
			// Sidecars present, `.db` absent.
			writeFileSync(join(configDir, "jollimemory.db-wal"), "wal");
			writeFileSync(join(configDir, "jollimemory.db-shm"), "shm");

			await runSchemaLog({});
			expect(logs.join("\n")).not.toContain("Migration log: none");
			expect(errs.join("\n")).toContain("recover");
			expect(process.exitCode).toBe(1);
			process.exitCode = 0;

			errs.length = 0;
			await runSchemaLog({ mark: "TOOL_CALL_TIME_DDL" });
			expect(errs.join("\n")).not.toContain("does not exist yet");
			expect(errs.join("\n")).toContain("recover");
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = 0;
			logSpy.mockRestore();
			errSpy.mockRestore();
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("is reachable from --mark-migration without --schema-log", async () => {
		// A user who typed it and got silence would reasonably conclude it did nothing.
		// Asserted as "it did NOT run the ordinary doctor report", because the schema-log
		// path returns before that — and under this file's mocked HOME it may legitimately
		// report the missing log on stderr rather than printing a listing.
		const lines = await runDoctor(["--mark-migration", "BASELINE_DDL"]);
		expect(lines.join("\n")).not.toContain("Jolli Memory Doctor");
		process.exitCode = 0;
	});
});

describe("doctor — parked events", () => {
	it("reports parked events, and says nothing when there are none", async () => {
		// Until this row a parked event was invisible in every direction: the projection
		// wrote no `sessions` row to notice missing, nothing queries `events_raw`, and
		// the prune deletes only `projected` rows so a failure does not even age out.
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-parked-"));
		const restoreHome = setIsolatedHome(home);
		const st = await import("../core/SessionTracker.js");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(join(home, ".jolli", "jollimemory"));
		try {
			const { withDashboardDb } = await import("../dashboard/DashboardDb.js");

			// No database at all — a normal state, not a fault, so the row is absent
			// rather than reading a confident "0".
			expect((await runDoctor()).join("\n")).not.toContain("Dashboard events");

			// An empty database says nothing either.
			await withDashboardDb(() => undefined);
			expect((await runDoctor()).join("\n")).not.toContain("Dashboard events");

			await withDashboardDb((db) =>
				db
					.prepare(
						`INSERT INTO events_raw
						   (event_id, repo_identity, type, schema_version, received_at, data_json,
						    projection_status, failed_kind, attempts)
						 VALUES ('session:r:codex:s', 'r', 'session.upserted', 1, '2026-08-01T00:00:00.000Z',
						         '{}', 'failed', 'error', 5)`,
					)
					.run(),
			);

			const out = (await runDoctor()).join("\n");
			expect(out).toContain("Dashboard events");
			expect(out).toContain("1 event(s) parked unprojected");
		} finally {
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("does not count a row the next writable open revives by itself", async () => {
		// `drainPending` un-parks `unknown-type` rows whose type this build now understands
		// on every writable open — a version-skew artefact (an older CLI parked an event a
		// newer VS Code build wrote) whose repair is the upgrade that already happened.
		// Counting them made this row assert "some conversations may be missing from the
		// dashboard", with no fixer to offer, for rows the next commit silently revives.
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-revivable-"));
		const restoreHome = setIsolatedHome(home);
		const st = await import("../core/SessionTracker.js");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(join(home, ".jolli", "jollimemory"));
		try {
			const { withDashboardDb } = await import("../dashboard/DashboardDb.js");
			await withDashboardDb((db) =>
				db
					.prepare(
						`INSERT INTO events_raw
						   (event_id, repo_identity, type, schema_version, received_at, data_json,
						    projection_status, failed_kind, attempts)
						 VALUES ('session:r:codex:revivable', 'r', 'session.upserted', 1,
						         '2026-08-01T00:00:00.000Z', '{}', 'failed', 'unknown-type', 5)`,
					)
					.run(),
			);

			expect((await runDoctor()).join("\n")).not.toContain("Dashboard events");
		} finally {
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("says a database that is present and unreadable, instead of nothing at all", async () => {
		// The state the bare `catch { return null }` folded in with "no database": a zero-byte
		// or truncated `jollimemory.db` opens READ-ONLY without error and throws on the first
		// statement. It is also the state that permanently stops the daemon's re-scan, and the
		// one command whose job is to tell these apart printed no row for it.
		const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-unreadable-"));
		const restoreHome = setIsolatedHome(home);
		const st = await import("../core/SessionTracker.js");
		const configDir = join(home, ".jolli", "jollimemory");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(configDir);
		try {
			const { getDashboardDbPath } = await import("../dashboard/DashboardDb.js");
			const dbPath = getDashboardDbPath();
			mkdirSync(join(dbPath, ".."), { recursive: true });
			writeFileSync(dbPath, "");

			const out = (await runDoctor()).join("\n");
			expect(out).toContain("Dashboard events");
			expect(out).toContain("present but unreadable");
		} finally {
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});
});
