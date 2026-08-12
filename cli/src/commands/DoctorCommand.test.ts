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
