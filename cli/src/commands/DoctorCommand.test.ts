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

vi.mock("../core/GitOps.js", () => ({ orphanBranchExists: h.orphanBranchExists }));
vi.mock("../core/LlmClient.js", () => ({ resolveLlmCredentialSource: h.resolveLlmCredentialSource }));
vi.mock("../core/Locks.js", () => ({
	isWorkerLockStale: h.isWorkerLockStale,
	releaseWorkerLock: h.releaseWorkerLock,
}));
vi.mock("../core/localagent/BackendRegistry.js", () => ({ getBackend: h.getBackend }));
vi.mock("../core/RepoProfile.js", () => ({ readManualDisableFlag: h.readManualDisableFlag }));
vi.mock("../core/SessionTracker.js", () => ({
	countActiveQueueEntries: h.countActiveQueueEntries,
	getGlobalConfigDir: h.getGlobalConfigDir,
	loadAllSessions: h.loadAllSessions,
	loadConfig: h.loadConfig,
}));
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

	it("skips the local-agent probe entirely when the credential source isn't local-agent", async () => {
		h.resolveLlmCredentialSource.mockReturnValue("anthropic-config");

		const lines = await runDoctor();

		expect(h.getBackend).not.toHaveBeenCalled();
		expect(lines.join("\n")).not.toContain("Local agent CLI");
	});
});
