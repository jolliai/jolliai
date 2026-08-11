/**
 * DoctorCommand tests.
 *
 * Covers:
 *   - `getBackend` is probed with the configured `localAgentTool` (defaulting
 *     to "claude-code" when unset)
 *   - a failed probe's message includes that tool's login hint (LOCAL_AGENT_TOOLS)
 *     so a not-signed-in user gets actionable guidance
 *   - `doctor --recover`'s survey / restore arms, against a real database
 *   - the parked-event diagnostic and its `--fix`, also against a real database
 *
 * Note for anyone adding a case here: `withDashboardDb` must NOT be mocked in
 * this file. Two describes build a real database through it, so a module-level
 * replacement would silently rewire them into passing for the wrong reason.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitSummary, JolliMemoryConfig } from "../Types.js";

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
	runSessionSync: vi.fn(),
	createStorage: vi.fn(),
	// Sentinel commit hash the TranscriptRepair.js mock below throws for, so the
	// `--repair-transcripts` per-candidate error-isolation test can make exactly
	// one candidate fail without touching any other test's real repair behavior.
	throwHash: "f".repeat(40),
	findStrandedRoots: vi.fn(),
	unparkStuckEvents: vi.fn(),
	withReadonlyDashboardDb: vi.fn(),
}));

vi.mock("../dashboard/SessionSyncRunner.js", () => ({ runSessionSync: h.runSessionSync }));

vi.mock("../core/GitOps.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/GitOps.js")>()),
	orphanBranchExists: h.orphanBranchExists,
	// Backup's default-folder guard probes whether $HOME is a git worktree (git
	// clean -xdf there would delete every snapshot). The fake HOME is a tmpdir, so
	// "false" is the honest answer and the snapshot proceeds.
	execGit: vi.fn(async () => ({ exitCode: 0, stdout: "false", stderr: "" })),
	// The `--repair-transcripts` tests below build fixtures with a real
	// FolderStorage over a plain temp dir (not a git worktree) —
	// resolveStateRoot/getTreeHash/getDiffStats are stubbed to their non-repo-cwd
	// fallback values so repairSummaryTranscripts (via storeSummary's
	// flattenSummaryTree) never shells `git` out against a directory that isn't
	// one. Same rationale as TranscriptRepair.test.ts.
	resolveStateRoot: vi.fn((cwd: string) => cwd),
	getTreeHash: vi.fn().mockResolvedValue(null),
	getDiffStats: vi.fn().mockResolvedValue({ filesChanged: 0, insertions: 0, deletions: 0 }),
}));
vi.mock("../core/LlmClient.js", () => ({ resolveLlmCredentialSource: h.resolveLlmCredentialSource }));
vi.mock("../core/Locks.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/Locks.js")>()),
	isWorkerLockStale: h.isWorkerLockStale,
	releaseWorkerLock: h.releaseWorkerLock,
	// The repo-registry row's dry-run repair pass takes this lock. A plain
	// pass-through rather than a spy: these tests are about doctor's output, and an
	// unmocked export throws on the very first check that reaches it.
	withRepoRegistryLock: async <T>(fn: () => Promise<T>) => fn(),
	// storeSummary always wraps its write in withRequiredOrphanWriteLock, which
	// calls these two directly regardless of active storage backend — stubbed
	// to always-succeed/no-op so the `--repair-transcripts` fixtures (plain temp
	// dirs, not git worktrees) don't shell out to `git rev-parse
	// --git-common-dir` to resolve the shared lock directory.
	acquireOrphanWriteLock: vi.fn().mockResolvedValue(true),
	releaseOrphanWriteLock: vi.fn().mockResolvedValue(undefined),
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
// createStorage is the cutover router: on a real cutover repo it points the active
// storage at SQLite. `runDoctor --repair-transcripts` must establish it itself, so
// the tests below stand it in for the fixture FolderStorage. Every other export
// (createFolderStorageAtRoot) stays real.
vi.mock("../core/StorageFactory.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../core/StorageFactory.js")>()),
	createStorage: h.createStorage,
}));
vi.mock("../core/TranscriptRepair.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/TranscriptRepair.js")>();
	return {
		...actual,
		// Real behavior for every commit except the sentinel — `runRepairTranscripts`
		// must isolate one candidate's failure from the rest of the loop, and the
		// only way to prove that without mocking away the whole engine is to make
		// exactly one real invocation throw.
		repairSummaryTranscripts: vi.fn(
			async (
				commitHash: string,
				cwd: string,
				opts?: { readonly apply?: boolean; readonly globalDir?: string },
			) => {
				if (commitHash === h.throwHash) throw new Error("simulated lock contention");
				return actual.repairSummaryTranscripts(commitHash, cwd, opts);
			},
		),
	};
});
vi.mock("../core/repair/StrandedTrees.js", () => ({ findStrandedRoots: h.findStrandedRoots }));
vi.mock("../install/DistPathResolver.js", () => ({ traverseDistPaths: h.traverseDistPaths }));
vi.mock("../install/Installer.js", () => ({ getStatus: h.getStatus, install: h.install }));
vi.mock("../PluginLoader.js", () => ({ inspectPlugins: h.inspectPlugins }));
// Spread the originals and override ONLY the parked-event surface: `Backup.ts`
// and `Recovery.ts` both import `withDashboardDb` from this module, so replacing
// it wholesale would silently rewire the `doctor --recover` tests below.
//
// `withReadonlyDashboardDb` is NOT exclusive to the parked-event check, though it
// once was: `runSchemaLog` reads the migration log through the same helper, so the
// `doctor --schema-log` describe hands this seam back to the real implementation in
// its own `beforeEach`. Under the default (a rejected open) that command reports an
// unavailable database and prints no listing — a green-looking mock that answers the
// wrong question.
vi.mock("../dashboard/DashboardDb.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../dashboard/DashboardDb.js")>()),
	withReadonlyDashboardDb: h.withReadonlyDashboardDb,
}));
vi.mock("../dashboard/StatsWriter.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../dashboard/StatsWriter.js")>()),
	unparkStuckEvents: h.unparkStuckEvents,
}));
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

import { recordClaudeOwners } from "../core/ClaudeOwnership.js";
import { createFolderStorageAtRoot } from "../core/StorageFactory.js";
import { getSummary, setActiveStorage, storeSummary } from "../core/SummaryStore.js";
import { setIsolatedHome } from "../testUtils/isolatedHome.js";
import { registerDoctorCommand, runRepairTranscripts } from "./DoctorCommand.js";

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

/**
 * Puts every probe on its healthy answer. Shared by the describes below so a
 * new diagnostic's setup does not have to restate fifteen unrelated mocks —
 * each test then overrides only the probe it is about.
 */
function healthyDefaults(): void {
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
	h.findStrandedRoots.mockResolvedValue([]);
	// A discoverable agent CLI: without it the local-agent probe fails and pushes
	// `exitCode` to 1, which then confounds any OTHER check's exit-code assertion.
	h.getBackend.mockReturnValue({
		discoverExecutable: vi.fn().mockResolvedValue({ file: "/usr/bin/claude", version: "2.0.0" }),
	});
	h.getGlobalConfigDir.mockReturnValue("/global");
	h.traverseDistPaths.mockReturnValue([]);
	h.inspectPlugins.mockResolvedValue([]);
	// Default: no database to consult — the shape of a machine where no writer has
	// ever run, and the state every other describe in this file already assumes.
	// `getDashboardDbPath()` resolves under the mocked `/global` config dir, which
	// does not exist, so `probeParkedEvents` returns `absent` before any open.
	h.withReadonlyDashboardDb.mockRejectedValue(new Error("unable to open database file"));
}

describe("DoctorCommand — local-agent tool diagnostic", () => {
	beforeEach(healthyDefaults);

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

describe("DoctorCommand — Memory tree check", () => {
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
		h.loadConfig.mockResolvedValue({});
		h.resolveLlmCredentialSource.mockReturnValue("anthropic-config");
		h.getGlobalConfigDir.mockReturnValue("/global");
		// A healthy, fully-registered install (not `[]`, which independently fails
		// the unrelated "dist-paths" check) so this describe's exit-code
		// assertions isolate what the Memory tree check itself contributes.
		h.traverseDistPaths.mockReturnValue([{ source: "cli", version: "1.0.0", distDir: "/dist", available: true }]);
		h.inspectPlugins.mockResolvedValue([]);
		h.findStrandedRoots.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
		process.exitCode = undefined;
	});

	it("reports ok with no stranded trees", async () => {
		const lines = (await runDoctor()).join("\n");

		expect(lines).toContain("Memory tree");
		expect(lines).toContain("no stranded trees");
	});

	it("warns with a count and points at `jolli repair-memory` when trees are stranded", async () => {
		h.findStrandedRoots.mockResolvedValue([{}, {}] as never);

		const lines = (await runDoctor()).join("\n");

		expect(lines).toContain("2 stranded tree(s)");
		expect(lines).toContain("jolli repair-memory");
		// warn, not fail: a stranded tree must not flip doctor's overall exit code.
		expect(process.exitCode).toBeUndefined();
	});

	it("does not repair stranded trees under --fix — the check carries no fixer", async () => {
		h.findStrandedRoots.mockResolvedValue([{}, {}] as never);

		const lines = (await runDoctor(["--fix"])).join("\n");

		expect(lines).toContain("2 stranded tree(s)");
		// `findStrandedRoots` runs exactly once for the report; no second call from
		// an "Applying fixes..." pass, because this check declares no `fixer`.
		expect(h.findStrandedRoots).toHaveBeenCalledTimes(1);
		expect(lines).not.toMatch(/Applying fixes[\s\S]*Memory tree/);
	});

	it("reports a detection failure as its own warn state, never as 'no stranded trees'", async () => {
		h.findStrandedRoots.mockRejectedValue(new Error("not a git repo"));

		const lines = (await runDoctor()).join("\n");

		expect(lines).toContain("Memory tree");
		expect(lines).toContain("could not determine — not a git repo");
		expect(lines).not.toContain("no stranded trees");
		// warn, not fail: a detection failure must not flip doctor's overall exit
		// code either — it is diagnostic, not a fault this build caused.
		expect(process.exitCode).toBeUndefined();
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
	// The file-wide mock of `withReadonlyDashboardDb` exists for the parked-event
	// check and defaults to a rejected open. `runSchemaLog` reads the log through
	// the same helper, so without this every assertion below would be measuring the
	// mock's failure rather than the command.
	beforeEach(async () => {
		const realDb =
			await vi.importActual<typeof import("../dashboard/DashboardDb.js")>("../dashboard/DashboardDb.js");
		h.withReadonlyDashboardDb.mockImplementation(realDb.withReadonlyDashboardDb);
	});

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

describe("DoctorCommand — parked dashboard events", () => {
	beforeEach(healthyDefaults);

	afterEach(() => {
		vi.clearAllMocks();
		process.exitCode = undefined;
	});

	/** The one printed row this describe is about. */
	const eventRow = (lines: ReadonlyArray<string>): string => lines.find((l) => l.includes("Dashboard events")) ?? "";

	/**
	 * Point `getDashboardDbPath()` at an isolated home and create the db FILE, so
	 * `probeParkedEvents` passes its `existsSync` guard and reaches the (mocked)
	 * open. The file's contents never matter — `withReadonlyDashboardDb` is the seam
	 * that decides `counted` vs `unreadable`. Returns a teardown that removes it.
	 */
	async function withPresentDb(): Promise<() => void> {
		const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-parked-present-"));
		const restoreHome = setIsolatedHome(home);
		const configDir = join(home, ".jolli", "jollimemory");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "jollimemory.db"), "present");
		h.getGlobalConfigDir.mockReturnValue(configDir);
		return () => {
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		};
	}

	// Asserted on the ROW ICON rather than on `process.exitCode`: the exit code is
	// the whole check list's verdict, so any unrelated probe (dist-paths is `✗`
	// under these mocks) would make the assertion pass or fail for the wrong
	// reason. The icon is this check's own status.

	it("reports none parked when the database cannot be consulted at all", async () => {
		// The default `getDashboardDbPath()` (under `/global`) does not exist, so the
		// probe returns `absent` before any open — the honest shape of a machine where
		// no writer has ever run. Doctor must still complete and still print the row:
		// it is the command a user runs when things are broken.
		const row = eventRow(await runDoctor());
		expect(row).toMatch(/✓/);
		expect(row).toMatch(/none parked/);
	});

	it("reports the database as present but unreadable when the open throws", async () => {
		// The state that permanently disables the daemon's re-scan, and the one doctor
		// used to print NOTHING for: the file exists (so `absent` is wrong) and the
		// open throws (so a count is impossible). Its own row, no fixer — re-queuing
		// cannot repair a database that will not open.
		const teardown = await withPresentDb();
		try {
			h.withReadonlyDashboardDb.mockRejectedValue(new Error("database disk image is malformed"));
			const row = eventRow(await runDoctor());
			expect(row).toMatch(/⚠/);
			expect(row).toMatch(/present but unreadable/);
			expect(row).toMatch(/malformed/);
			expect(row).toMatch(/re-scan is stopped/);
		} finally {
			teardown();
		}
	});

	it("warns with the count rather than failing the run", async () => {
		const teardown = await withPresentDb();
		try {
			// `probeParkedEvents` counts via `withReadonlyDashboardDb(countStuckEvents)`;
			// the seam resolves the count directly.
			h.withReadonlyDashboardDb.mockResolvedValue(10);
			const row = eventRow(await runDoctor());
			// ⚠ not ✗: the memories are safe in the system of record, so an otherwise
			// healthy install must not start exiting non-zero over dashboard gaps.
			expect(row).toMatch(/⚠/);
			expect(row).not.toMatch(/✗/);
			expect(row).toMatch(/10 event\(s\) parked/);
		} finally {
			teardown();
		}
	});

	it("offers no fixer when nothing is parked", async () => {
		const teardown = await withPresentDb();
		try {
			h.withReadonlyDashboardDb.mockResolvedValue(0);
			await runDoctor(["--fix"]);
			expect(h.unparkStuckEvents).not.toHaveBeenCalled();
		} finally {
			teardown();
		}
	});

	it("--fix revives and drains against a real database, reporting both numbers", async () => {
		// Against a REAL database rather than a stub: `withDashboardDb` cannot be
		// mocked in this file (the `doctor --recover` test above builds a real
		// database through it), and the fixer's whole claim is that the numbers are
		// correct when the command exits — which only a real drain can show.
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-parked-"));
		const restoreHome = setIsolatedHome(home);
		const configDir = join(home, ".jolli", "jollimemory");
		h.getGlobalConfigDir.mockReturnValue(configDir);
		// Delegate the mocked seam back to the real implementations for this test.
		const real = await vi.importActual<typeof import("../dashboard/StatsWriter.js")>("../dashboard/StatsWriter.js");
		const realDb =
			await vi.importActual<typeof import("../dashboard/DashboardDb.js")>("../dashboard/DashboardDb.js");
		// `probeParkedEvents` counts via `withReadonlyDashboardDb(countStuckEvents)` —
		// countStuckEvents stays REAL (spread), so only the read-only handle and the
		// fixer's un-park need delegating back to their real implementations.
		h.unparkStuckEvents.mockImplementation(real.unparkStuckEvents);
		h.withReadonlyDashboardDb.mockImplementation(realDb.withReadonlyDashboardDb);
		try {
			const { STATS_EVENT_SCHEMA_VERSION } = await import("../dashboard/DashboardModel.js");
			const dbPath = join(configDir, "jollimemory.db");
			// One event that cannot be projected, driven to `failed` the only way a
			// real one gets there: by spending its whole attempt budget.
			await realDb.withDashboardDb(
				(db) =>
					db
						.prepare(
							`INSERT INTO events_raw (event_id, type, schema_version, received_at, data_json)
							 VALUES ('bad', 'session.upserted', ?, 't', 'not json')`,
						)
						.run(STATS_EVENT_SCHEMA_VERSION),
				{ dbPath },
			);
			for (let i = 0; i < 5; i++) await real.applyStatsEvents([], { producerKind: "cli", dbPath });
			expect(await realDb.withReadonlyDashboardDb((db) => real.countStuckEvents(db), { dbPath })).toBe(1);

			const lines = (await runDoctor(["--fix"])).join("\n");

			// Nothing was actually recovered: one drain spends ONE attempt, so the row
			// is back to `pending` rather than projected or re-parked. The message has
			// to say that — "1 revived" alone would read as a completed repair. The
			// leftover is COUNTED off the table (`drainPending`'s `pending`), not
			// derived as `revived - projected` — that subtraction ignored the
			// `DRAIN_BATCH_SIZE` cap and could go negative when rows were already
			// queued before the un-park.
			expect(lines).toMatch(/Dashboard events: 1 revived, 0 projected, 1 still queued \(will retry\)/);

			// Park it again — the fix above left it `pending`, and the point of the
			// next assertion is that the FIXER is what recovers it.
			for (let i = 0; i < 5; i++) await real.applyStatsEvents([], { producerKind: "cli", dbPath });
			expect(await realDb.withReadonlyDashboardDb((db) => real.countStuckEvents(db), { dbPath })).toBe(1);

			// Now the blocker is gone — the real case: an event that failed against a
			// table a skipped migration never created, replayed after the repair.
			await realDb.withDashboardDb(
				(db) =>
					db.prepare("UPDATE events_raw SET data_json = ? WHERE event_id = 'bad'").run(
						JSON.stringify({
							type: "session.upserted",
							repoIdentity: "repo-1",
							source: "claude",
							sessionId: "s1",
							updatedAtMs: 1_700_000_000_000,
							messageCount: 1,
							models: [],
							tokenCoverage: "none",
						}),
					),
				{ dbPath },
			);
			expect((await runDoctor(["--fix"])).join("\n")).toMatch(/Dashboard events: 1 revived, 1 projected/);

			// The race the fixer guards against: the diagnosis saw a parked row on its
			// own read-only handle, but by the time the fixer took the write lock
			// another doctor had already revived it. Forced here by making the probe's
			// read-only count report one while the real database (which the fixer's
			// writable handle sees) is clean.
			h.withReadonlyDashboardDb.mockResolvedValue(1);
			expect((await runDoctor(["--fix"])).join("\n")).toMatch(/Dashboard events: nothing parked/);
		} finally {
			restoreHome();
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("doctor --sync-sessions", () => {
	// `process.exitCode` is process-global, and the reset hooks above belong to the
	// FIRST describe in this file — so they do not run here. Two cases below assert
	// on it, and `runDoctor` sets it to 1 on any warning, so without this they read
	// whichever value an earlier block left behind rather than what this command
	// did: the skip case failed while the code under test was correct.
	beforeEach(() => {
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	/** Captures stdout for one call and hands back what was printed. */
	async function run(outcome: unknown): Promise<string> {
		const { runSessionSyncNow } = await import("./DoctorCommand.js");
		h.runSessionSync.mockResolvedValue(outcome);
		const logs: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((m) => void logs.push(String(m)));
		try {
			await runSessionSyncNow();
			return logs.join("\n");
		} finally {
			spy.mockRestore();
		}
	}

	it("routes the flag to the upload instead of running the whole diagnostic", async () => {
		// The flag is a different command wearing `doctor`'s clothes: the ordinary
		// run probes hooks, the registry and the queue, and none of that is what a
		// user typing `--sync-sessions` is waiting for. It also returns straight
		// after, so no diagnostic output follows the upload's one line.
		h.runSessionSync.mockResolvedValue({ status: "done", batches: 0, rows: 0 });
		const lines = await runDoctor(["--sync-sessions", "--cwd", "/repo"]);
		// No cwd on the call: the channel is cross-repo, so this covers the whole
		// machine and withholds the disabled repos row by row rather than skipping
		// the run because the user happened to type it inside one.
		expect(h.runSessionSync).toHaveBeenCalledWith({ force: true });
		expect(lines.join("\n")).toContain("up to date");
	});

	it("forces the run, so a fixed backend does not have to wait out its silence", async () => {
		await run({ status: "done", batches: 2, rows: 40 });
		expect(h.runSessionSync).toHaveBeenCalledWith({ force: true });
	});

	it("reports what was uploaded", async () => {
		expect(await run({ status: "done", batches: 2, rows: 40 })).toContain("Uploaded 40 row(s) in 2 batch(es)");
	});

	it("says so when there was nothing to send, rather than printing a bare success", async () => {
		expect(await run({ status: "done", batches: 0, rows: 0 })).toContain("up to date");
	});

	it("names a skip reason instead of exiting quietly", async () => {
		// Every reason is either the user's own setting or the server's answer, so
		// this is the one output that makes the command worth typing.
		const out = await run({ status: "skipped", reason: "syncSessions is off" });
		expect(out).toContain("syncSessions is off");
		expect(process.exitCode).not.toBe(1);
	});

	it("exits non-zero on a failure, so a script can tell", async () => {
		try {
			expect(await run({ status: "failed", reason: "network down" })).toContain("network down");
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = 0;
		}
	});
});

describe("doctor --repair-transcripts", () => {
	// Storage seam (same as TranscriptRepair.test.ts): a real FolderStorage
	// rooted at a temp "repo" dir, set as the process-global override so
	// listSummaries/getSummary/storeSummary inside runRepairTranscripts read and
	// write it without a real git worktree or the orphan branch. GitOps/Locks
	// are stubbed at the top of this file for the same non-repo-cwd reason.
	let globalDir: string;
	let repo: string;
	let transcript: string;

	const HASH = "a".repeat(40);
	const EDGE = { firstSeenAt: "2026-08-17T10:00:00.000Z", firstSeenLine: 0, lastSeenAt: "2026-08-17T10:00:00.000Z" };

	function summary(over: Partial<CommitSummary> = {}): CommitSummary {
		return {
			version: 5,
			commitHash: HASH,
			commitMessage: "x",
			commitAuthor: "a",
			commitDate: "2026-08-17T11:00:00.000Z",
			branch: "main",
			generatedAt: "2026-08-17T11:00:05.000Z",
			topics: [],
			transcripts: [],
			...over,
		};
	}

	/** Same console.log-capture idiom as `runDoctor()` above, generalised to any callback. */
	async function captureLog(fn: () => Promise<void>): Promise<string> {
		const lines: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			lines.push(a.map(String).join(" "));
		});
		try {
			await fn();
		} finally {
			spy.mockRestore();
		}
		return lines.join("\n");
	}

	beforeEach(async () => {
		globalDir = await mkdtemp(join(tmpdir(), "jolli-doctor-repair-g-"));
		repo = await mkdtemp(join(tmpdir(), "jolli-doctor-repair-r-"));
		transcript = join(globalDir, "s.jsonl");
		// A real user turn (not just a bare `{cwd, timestamp}` line) — a line with
		// no `message` object parses to zero entries, which would misreport every
		// repair here as "no-entries-in-window".
		await writeFile(
			transcript,
			`${JSON.stringify({
				cwd: repo,
				timestamp: "2026-08-17T10:00:00.000Z",
				message: { role: "user", content: "hello" },
			})}\n`,
			"utf-8",
		);
		const st = await import("../core/SessionTracker.js");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(globalDir);
		setActiveStorage(createFolderStorageAtRoot(repo));
		// What the cutover router hands the CLI entry: the same disk-backed fixture
		// storage. Direct `runRepairTranscripts` unit calls ignore this (they use the
		// pre-set active storage above); the `runDoctor` dispatch path consumes it.
		h.createStorage.mockResolvedValue(createFolderStorageAtRoot(repo));
	});

	afterEach(() => {
		setActiveStorage(undefined);
	});

	it("lists repair candidates without writing when --fix is absent", async () => {
		await storeSummary(summary(), repo);
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);

		const out = await captureLog(() => runRepairTranscripts(repo, false));

		expect(out).toContain("would repair");
		expect((await getSummary(HASH, repo))?.transcripts ?? []).toHaveLength(0);
	});

	it("repairs and reports per-summary reasons with --fix", async () => {
		await storeSummary(summary(), repo);
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);

		const out = await captureLog(() => runRepairTranscripts(repo, true));

		expect(out).toContain("repaired");
		expect((await getSummary(HASH, repo))?.transcripts).toHaveLength(1);
	});

	it("reports a clean result when no summary has an empty transcript list", async () => {
		await storeSummary(summary({ transcripts: ["existing"] }), repo);

		const out = await captureLog(() => runRepairTranscripts(repo, true));

		expect(out).toContain("No summaries need transcript repair");
	});

	it("continues past a candidate whose repair throws, and the totals still add up", async () => {
		// Two candidates: the default HASH one (which the mock lets through to
		// the real engine and succeeds) and a second at the sentinel `throwHash`
		// (which the TranscriptRepair.js mock above throws for, simulating real
		// orphan-write-lock contention with a concurrently-running QueueWorker).
		// Without per-candidate error isolation, the throw would abort the loop
		// before the totals line ever printed and, depending on iteration order,
		// might also swallow the first candidate's own line.
		await storeSummary(summary(), repo);
		await storeSummary(summary({ commitHash: h.throwHash }), repo);
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);

		const out = await captureLog(() => runRepairTranscripts(repo, true));

		expect(out).toContain(`${h.throwHash.substring(0, 8)}  error — simulated lock contention`);
		expect(out).toContain("repaired — 1 entries");
		expect(out).toContain("Repaired 1 of 2 summaries.");
		expect(out).toContain("1 errored — see above.");
		// The surviving candidate's write still landed — one failure must not
		// have rolled back or blocked an unrelated candidate's own repair.
		expect((await getSummary(HASH, repo))?.transcripts).toHaveLength(1);
	});

	it("dispatches --repair-transcripts before the ordinary doctor report, honoring --fix", async () => {
		await storeSummary(summary(), repo);
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		const st = await import("../core/SessionTracker.js");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(globalDir);

		const lines = await runDoctor(["--repair-transcripts", "--fix", "--cwd", repo]);
		const out = lines.join("\n");

		expect(out).toContain("repaired");
		expect(out).not.toContain("Jolli Memory Doctor");
		expect((await getSummary(HASH, repo))?.transcripts).toHaveLength(1);
	});

	it("establishes routed storage itself, so repair works when nothing pre-set the active storage", async () => {
		// The real CLI entry never pre-sets active storage — the action handler must
		// route its own via createStorage(cwd) (which the cutover router points at
		// SQLite on a cutover repo). Without that, resolveStorage falls back to the
		// system of record, which is FROZEN after cutover, and the repair reads
		// nothing while claiming success. Plant the candidate through the fixture
		// storage, then clear the global so the command is forced to re-establish it.
		await storeSummary(summary(), repo);
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		setActiveStorage(undefined);
		const st = await import("../core/SessionTracker.js");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(globalDir);
		// The system-of-record the command wrongly falls back to today is reachable
		// but empty — post-cutover the orphan branch is frozen and holds nothing the
		// routed SQLite storage has. So a fallback read finds zero candidates.
		h.resolveSotBackend.mockResolvedValue({
			ok: true,
			state: "cutover",
			storage: createFolderStorageAtRoot(await mkdtemp(join(tmpdir(), "jolli-doctor-repair-sot-"))),
		});

		const lines = await runDoctor(["--repair-transcripts", "--fix", "--cwd", repo]);

		expect(lines.join("\n")).toContain("repaired");
		expect((await getSummary(HASH, repo))?.transcripts).toHaveLength(1);
	});

	it("does not apply the repair through the CLI when --fix is omitted", async () => {
		// Distinct from the unit-level "lists ... without writing" test above:
		// that one calls runRepairTranscripts directly with apply=false, so it
		// cannot catch a dispatch bug that hardcodes `apply: true` (or any other
		// constant) instead of threading `options.fix === true` through.
		await storeSummary(summary(), repo);
		await recordClaudeOwners(
			{ sessionId: "s", transcriptPath: transcript, edges: new Map([[repo, EDGE]]) },
			globalDir,
		);
		const st = await import("../core/SessionTracker.js");
		vi.mocked(st.getGlobalConfigDir).mockReturnValue(globalDir);

		const lines = await runDoctor(["--repair-transcripts", "--cwd", repo]);
		const out = lines.join("\n");

		expect(out).toContain("would repair");
		expect((await getSummary(HASH, repo))?.transcripts ?? []).toHaveLength(0);
	});
});
