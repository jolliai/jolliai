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
});

describe("doctor --recover", () => {
	it("lists candidates under a fake HOME and reports a failed restore", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { runRecover } = await import("./DoctorCommand.js");
		const home = mkdtempSync(join(tmpdir(), "jolli-doctor-recover-"));
		const realHome = process.env.HOME;
		process.env.HOME = home;
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
			process.env.HOME = realHome;
			rmSync(home, { recursive: true, force: true });
		}
	});
});
