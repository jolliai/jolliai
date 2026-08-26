import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVscodeUserDataDir } from "../../core/VscodeWorkspaceLocator.js";
import { MCP_GIT_EXCLUDE_PATH } from "../McpRegistration.js";
import { buildRegistrars, registerRepoMcpHosts, removeRepoMcpHosts } from "./HostRegistrars.js";

const NONE = {
	claude: false,
	codex: false,
	cursor: false,
	gemini: false,
	opencode: false,
	copilot: false,
	copilotChat: false,
	cline: false,
	devin: false,
	antigravity: false,
	kimi: false,
	hermes: false,
} as const;

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-host-reg-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("buildRegistrars", () => {
	it("returns claude registrar when detected.claude is true", () => {
		const registrars = buildRegistrars({ ...NONE, claude: true });
		expect(registrars.map((r) => r.host)).toEqual(["claude"]);
	});

	it("omits claude when detected.claude is false", () => {
		const registrars = buildRegistrars({ ...NONE });
		expect(registrars).toHaveLength(0);
	});

	it("claude registrar.register() writes .mcp.json with the jollimemory mcp subcommand", async () => {
		const [claude] = buildRegistrars({ ...NONE, claude: true });
		await claude.register(dir);
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		// `.toContain` not `.toEqual(["mcp"])`: on Windows the args are prefixed with
		// the resolved `Cli.js` path (see mcpServerEntry). The exact per-platform shape
		// is asserted by the mcpServerEntry unit tests and the "jolliEntry — Windows" test.
		expect(json.mcpServers.jollimemory.args).toContain("mcp");
	});

	it("claude registrar.gitExcludePaths() returns [MCP_GIT_EXCLUDE_PATH]", () => {
		const [claude] = buildRegistrars({ ...NONE, claude: true });
		expect(claude.gitExcludePaths()).toEqual([MCP_GIT_EXCLUDE_PATH]);
	});

	it("claude registrar.remove() is a no-op when file is absent", async () => {
		const [claude] = buildRegistrars({ ...NONE, claude: true });
		await expect(claude.remove(dir)).resolves.toBeUndefined();
	});
});

describe("registerRepoMcpHosts", () => {
	it("registers claude (repo-scoped) when detected", async () => {
		await registerRepoMcpHosts(dir, { ...NONE, claude: true });
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		expect(json.mcpServers.jollimemory.args).toContain("mcp");
	});

	it("skips registration when no hosts detected", async () => {
		await registerRepoMcpHosts(dir, { ...NONE });
		await expect(readFile(join(dir, ".mcp.json"), "utf-8")).rejects.toThrow();
	});

	it("does not write global-host configs (codex etc.) — those go through registerGlobalMcpHosts", async () => {
		// codex is global-scoped; registerRepoMcpHosts must skip it even when detected.
		await registerRepoMcpHosts(dir, { ...NONE, codex: true });
		await expect(readFile(join(dir, ".mcp.json"), "utf-8")).rejects.toThrow();
	});

	it("swallows thrown register error with warn (non-fatal) — unwritable nested path", async () => {
		// An unwritable nested path causes registerMcpInClaude to throw ENOENT;
		// registerRepoMcpHosts must catch it and resolve without rethrowing.
		const unwritable = join(dir, "no-such-dir", "nested");
		await expect(registerRepoMcpHosts(unwritable, { ...NONE, claude: true })).resolves.toBeUndefined();
	});
});

describe("cursor registrar", () => {
	it("appears in buildRegistrars when detected.cursor is true", () => {
		const registrars = buildRegistrars({ ...NONE, cursor: true });
		expect(registrars.map((r) => r.host)).toContain("cursor");
	});

	it("does not appear when detected.cursor is false", () => {
		const registrars = buildRegistrars({ ...NONE });
		expect(registrars.map((r) => r.host)).not.toContain("cursor");
	});

	it("gitExcludePaths() returns ['/.cursor/mcp.json']", () => {
		const [cursor] = buildRegistrars({ ...NONE, cursor: true });
		expect(cursor.gitExcludePaths()).toEqual(["/.cursor/mcp.json"]);
	});

	it("register() writes <worktree>/.cursor/mcp.json with mcpServers.jollimemory", async () => {
		const [cursor] = buildRegistrars({ ...NONE, cursor: true });
		await cursor.register(dir);
		const json = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf-8"));
		expect(json.mcpServers.jollimemory).toBeDefined();
		expect(json.mcpServers.jollimemory.args).toContain("mcp");
	});

	it("remove() is a no-op when .cursor/mcp.json is absent", async () => {
		const [cursor] = buildRegistrars({ ...NONE, cursor: true });
		await expect(cursor.remove(dir)).resolves.toBeUndefined();
	});

	it("remove() removes only jollimemory from .cursor/mcp.json", async () => {
		const [cursor] = buildRegistrars({ ...NONE, cursor: true });
		await cursor.register(dir);
		await cursor.remove(dir);
		const json = JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf-8"));
		expect(json.mcpServers?.jollimemory).toBeUndefined();
	});
});

describe("gemini registrar — structure", () => {
	it("appears in buildRegistrars when detected.gemini is true", () => {
		const registrars = buildRegistrars({ ...NONE, gemini: true });
		expect(registrars.map((r) => r.host)).toContain("gemini");
	});

	it("does not appear when detected.gemini is false", () => {
		const registrars = buildRegistrars({ ...NONE });
		expect(registrars.map((r) => r.host)).not.toContain("gemini");
	});

	it("gitExcludePaths() returns [] (global config, never committed)", () => {
		const [gemini] = buildRegistrars({ ...NONE, gemini: true });
		expect(gemini.gitExcludePaths()).toEqual([]);
	});
});

describe("gemini registrar — register/remove target ~/.gemini/settings.json", () => {
	// Use vi.doMock + resetModules so the mock is scoped to this describe block
	// and does not affect the cursor tests above, which rely on real file writes.
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const removeMock = vi.fn().mockResolvedValue(undefined);
	const geminiSettingsPath = join(homedir(), ".gemini", "settings.json");

	beforeEach(() => {
		vi.resetModules();
		vi.doMock("./JsonMcpWriter.js", () => ({
			upsertJsonMcpServer: upsertMock,
			removeJsonMcpServer: removeMock,
		}));
		upsertMock.mockClear();
		removeMock.mockClear();
	});

	afterEach(() => {
		vi.doUnmock("./JsonMcpWriter.js");
		vi.resetModules();
	});

	it("register() calls upsertJsonMcpServer with ~/.gemini/settings.json", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [gemini] = build({ ...NONE, gemini: true });
		await gemini.register("/some/wt");
		expect(upsertMock).toHaveBeenCalledOnce();
		expect(upsertMock.mock.calls[0][0]).toBe(geminiSettingsPath);
	});

	it("remove() calls removeJsonMcpServer with ~/.gemini/settings.json", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [gemini] = build({ ...NONE, gemini: true });
		await gemini.remove("/some/wt");
		expect(removeMock).toHaveBeenCalledOnce();
		expect(removeMock.mock.calls[0][0]).toBe(geminiSettingsPath);
	});
});

describe("codex registrar — structure", () => {
	it("appears in buildRegistrars when detected.codex is true", () => {
		const registrars = buildRegistrars({ ...NONE, codex: true });
		expect(registrars.map((r) => r.host)).toContain("codex");
	});

	it("does not appear when detected.codex is false", () => {
		const registrars = buildRegistrars({ ...NONE });
		expect(registrars.map((r) => r.host)).not.toContain("codex");
	});

	it("gitExcludePaths() returns [] (global config, never committed)", () => {
		const [codex] = buildRegistrars({ ...NONE, codex: true });
		expect(codex.gitExcludePaths()).toEqual([]);
	});
});

describe("codex registrar — register/remove target ~/.codex/config.toml", () => {
	// Use vi.doMock + resetModules so the mock is scoped to this describe block
	// and does not affect other tests that rely on real file writes.
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const removeMock = vi.fn().mockResolvedValue(undefined);
	const codexConfigPath = join(homedir(), ".codex", "config.toml");

	beforeEach(() => {
		vi.resetModules();
		vi.doMock("./CodexTomlWriter.js", () => ({
			upsertCodexMcpServer: upsertMock,
			removeCodexMcpServer: removeMock,
		}));
		upsertMock.mockClear();
		removeMock.mockClear();
	});

	afterEach(() => {
		vi.doUnmock("./CodexTomlWriter.js");
		vi.resetModules();
	});

	it("register() calls upsertCodexMcpServer with ~/.codex/config.toml", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [codex] = build({ ...NONE, codex: true });
		await codex.register("/some/wt");
		expect(upsertMock).toHaveBeenCalledOnce();
		expect(upsertMock.mock.calls[0][0]).toBe(codexConfigPath);
	});

	it("remove() calls removeCodexMcpServer with ~/.codex/config.toml", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [codex] = build({ ...NONE, codex: true });
		await codex.remove("/some/wt");
		expect(removeMock).toHaveBeenCalledOnce();
		expect(removeMock.mock.calls[0][0]).toBe(codexConfigPath);
	});
});

describe("kimi registrar — structure", () => {
	it("appears in buildRegistrars when detected.kimi is true", () => {
		const registrars = buildRegistrars({ ...NONE, kimi: true });
		expect(registrars.map((r) => r.host)).toContain("kimi");
	});

	it("does not appear when detected.kimi is false", () => {
		const registrars = buildRegistrars({ ...NONE });
		expect(registrars.map((r) => r.host)).not.toContain("kimi");
	});

	it("gitExcludePaths() returns [] (global config, never committed)", () => {
		const [kimi] = buildRegistrars({ ...NONE, kimi: true });
		expect(kimi.gitExcludePaths()).toEqual([]);
	});
});

describe("kimi registrar — register/remove target ~/.kimi-code/mcp.json", () => {
	// Scoped JsonMcpWriter mock (same pattern as the gemini block above): verifies
	// the path/writer without touching the developer's real ~/.kimi-code.
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const removeMock = vi.fn().mockResolvedValue(undefined);
	const kimiMcpPath = join(homedir(), ".kimi-code", "mcp.json");

	beforeEach(() => {
		vi.resetModules();
		vi.doMock("./JsonMcpWriter.js", () => ({
			upsertJsonMcpServer: upsertMock,
			removeJsonMcpServer: removeMock,
		}));
		upsertMock.mockClear();
		removeMock.mockClear();
	});

	afterEach(() => {
		vi.doUnmock("./JsonMcpWriter.js");
		vi.resetModules();
	});

	it("register() calls upsertJsonMcpServer with ~/.kimi-code/mcp.json (default mcpServers key)", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [kimi] = build({ ...NONE, kimi: true });
		await kimi.register("/some/wt");
		expect(upsertMock).toHaveBeenCalledOnce();
		expect(upsertMock.mock.calls[0][0]).toBe(kimiMcpPath);
		// No third arg → JsonMcpWriter's default `mcpServers` key, which is what Kimi wants.
		expect(upsertMock.mock.calls[0][2]).toBeUndefined();
	});

	it("remove() calls removeJsonMcpServer with ~/.kimi-code/mcp.json", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [kimi] = build({ ...NONE, kimi: true });
		await kimi.remove("/some/wt");
		expect(removeMock).toHaveBeenCalledOnce();
		expect(removeMock.mock.calls[0][0]).toBe(kimiMcpPath);
	});
});

describe("removeRepoMcpHosts", () => {
	it("removes claude regardless of detection", async () => {
		await registerRepoMcpHosts(dir, { ...NONE, claude: true });
		await removeRepoMcpHosts(dir);
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		expect(json.mcpServers?.jollimemory).toBeUndefined();
	});

	it("resolves without throwing when dir has no .mcp.json", async () => {
		await expect(removeRepoMcpHosts(dir)).resolves.toBeUndefined();
	});

	it("swallows removal error with warn (non-fatal) — spied registrar remove", async () => {
		// claudeRegistrar is the module-level singleton that buildRegistrars returns.
		// Temporarily replace its remove method to force a throw, exercise the
		// catch/warn path in removeRepoMcpHosts, then restore.
		const [registrar] = buildRegistrars({ ...NONE, claude: true });
		const originalRemove = registrar.remove;
		registrar.remove = vi.fn().mockRejectedValue(new Error("simulated removal failure"));
		try {
			await expect(removeRepoMcpHosts(dir)).resolves.toBeUndefined();
		} finally {
			registrar.remove = originalRemove;
		}
	});
});

describe("opencode/copilot/copilotChat registrars — structure", () => {
	it("opencode appears when detected.opencode is true, with empty gitExcludePaths", () => {
		const [r] = buildRegistrars({ ...NONE, opencode: true });
		expect(r.host).toBe("opencode");
		expect(r.gitExcludePaths()).toEqual([]);
	});
	it("copilot appears when detected.copilot is true, with empty gitExcludePaths", () => {
		const [r] = buildRegistrars({ ...NONE, copilot: true });
		expect(r.host).toBe("copilot");
		expect(r.gitExcludePaths()).toEqual([]);
	});
	it("copilotChat appears when detected.copilotChat is true, with empty gitExcludePaths", () => {
		const [r] = buildRegistrars({ ...NONE, copilotChat: true });
		expect(r.host).toBe("copilotChat");
		expect(r.gitExcludePaths()).toEqual([]);
	});
});

describe("new registrars — register targets & entry shape (mocked writer)", () => {
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const removeMock = vi.fn().mockResolvedValue(undefined);
	beforeEach(() => {
		vi.resetModules();
		vi.doMock("./JsonMcpWriter.js", () => ({ upsertJsonMcpServer: upsertMock, removeJsonMcpServer: removeMock }));
		upsertMock.mockClear();
		removeMock.mockClear();
	});
	afterEach(() => {
		vi.doUnmock("./JsonMcpWriter.js");
		vi.resetModules();
	});

	it("opencode register() → ~/.config/opencode/opencode.json, key `mcp`, type:local + array command", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, opencode: true });
		await r.register("/some/wt");
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(homedir(), ".config", "opencode", "opencode.json"));
		expect(key).toBe("mcp");
		expect(entry.type).toBe("local");
		expect(Array.isArray(entry.command)).toBe(true);
		expect(entry.command.at(-1)).toBe("mcp");
	});

	it("copilot register() → ~/.copilot/mcp-config.json, default key, {command,args}", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, copilot: true });
		await r.register("/some/wt");
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(homedir(), ".copilot", "mcp-config.json"));
		expect(key).toBeUndefined(); // default mcpServers
		expect(entry.args).toContain("mcp");
	});

	it("copilotChat register() → VS Code User/mcp.json, key `servers`, type:stdio", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, copilotChat: true });
		await r.register("/some/wt");
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(getVscodeUserDataDir("Code"), "User", "mcp.json"));
		expect(key).toBe("servers");
		expect(entry.type).toBe("stdio");
		expect(entry.args).toContain("mcp");
	});

	it("opencode/copilotChat remove() pass the right serversKey", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		await build({ ...NONE, opencode: true })[0].remove("/some/wt");
		expect(removeMock.mock.calls[0][1]).toBe("mcp");
		removeMock.mockClear();
		await build({ ...NONE, copilotChat: true })[0].remove("/some/wt");
		expect(removeMock.mock.calls[0][1]).toBe("servers");
	});

	it("copilot remove() → ~/.copilot/mcp-config.json, default key", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, copilot: true });
		await r.remove("/some/wt");
		const [path, key] = removeMock.mock.calls[0];
		expect(path).toBe(join(homedir(), ".copilot", "mcp-config.json"));
		expect(key).toBeUndefined(); // default mcpServers
	});
});

describe("cline/devin/antigravity registrars — structure", () => {
	it("cline appears when detected.cline is true, with empty gitExcludePaths", () => {
		const [r] = buildRegistrars({ ...NONE, cline: true });
		expect(r.host).toBe("cline");
		expect(r.gitExcludePaths()).toEqual([]);
	});
	it("devin appears when detected.devin is true, with empty gitExcludePaths", () => {
		const [r] = buildRegistrars({ ...NONE, devin: true });
		expect(r.host).toBe("devin");
		expect(r.gitExcludePaths()).toEqual([]);
	});
	it("antigravity appears when detected.antigravity is true, with empty gitExcludePaths", () => {
		const [r] = buildRegistrars({ ...NONE, antigravity: true });
		expect(r.host).toBe("antigravity");
		expect(r.gitExcludePaths()).toEqual([]);
	});
	it("all three are global-scoped — registerRepoMcpHosts writes no worktree file for them", async () => {
		// Global hosts must be skipped by the repo pass; if they leaked through, cline
		// would even write to a real machine-global settings file — so this also guards
		// against that. registerRepoMcpHosts filters to scope === "repo".
		await registerRepoMcpHosts(dir, { ...NONE, cline: true, devin: true, antigravity: true });
		await expect(readFile(join(dir, ".mcp.json"), "utf-8")).rejects.toThrow();
	});
});

describe("devin & antigravity registrars — register/remove targets (mocked writer)", () => {
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const removeMock = vi.fn().mockResolvedValue(undefined);
	beforeEach(() => {
		vi.resetModules();
		vi.doMock("./JsonMcpWriter.js", () => ({ upsertJsonMcpServer: upsertMock, removeJsonMcpServer: removeMock }));
		upsertMock.mockClear();
		removeMock.mockClear();
	});
	afterEach(() => {
		vi.doUnmock("./JsonMcpWriter.js");
		vi.resetModules();
	});

	it("devin register() → ~/.config/devin/config.json, default key, {command,args,transport:'stdio'}", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, devin: true });
		await r.register("/some/wt");
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(homedir(), ".config", "devin", "config.json"));
		expect(key).toBeUndefined(); // default mcpServers
		expect(entry.transport).toBe("stdio"); // Devin's stdio envelope
		expect(entry.args).toContain("mcp");
	});

	it("devin remove() → ~/.config/devin/config.json, default key", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		await build({ ...NONE, devin: true })[0].remove("/some/wt");
		const [path, key] = removeMock.mock.calls[0];
		expect(path).toBe(join(homedir(), ".config", "devin", "config.json"));
		expect(key).toBeUndefined();
	});

	it("antigravity register() → ~/.gemini/config/mcp_config.json, default key, {command,args} (no transport/type)", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, antigravity: true });
		await r.register("/some/wt");
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(homedir(), ".gemini", "config", "mcp_config.json"));
		expect(key).toBeUndefined(); // default mcpServers
		expect(entry.args).toContain("mcp");
		// Antigravity infers stdio from the presence of `command`; the shipped
		// mcp_servers.md schema uses no transport/type field for local servers.
		expect(entry.transport).toBeUndefined();
		expect(entry.type).toBeUndefined();
	});

	it("antigravity remove() → ~/.gemini/config/mcp_config.json, default key", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		await build({ ...NONE, antigravity: true })[0].remove("/some/wt");
		const [path, key] = removeMock.mock.calls[0];
		expect(path).toBe(join(homedir(), ".gemini", "config", "mcp_config.json"));
		expect(key).toBeUndefined();
	});
});

describe("cline registrar — per-flavor settings files (mocked writer + detector)", () => {
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const removeMock = vi.fn().mockResolvedValue(undefined);
	const fakeInstalled = [join("/fake", "Code", "globalStorage", "saoudrizwan.claude-dev")];
	const fakeAll = [
		join("/fake", "Code", "globalStorage", "saoudrizwan.claude-dev"),
		join("/fake", "Cursor", "globalStorage", "saoudrizwan.claude-dev"),
	];
	beforeEach(() => {
		vi.resetModules();
		vi.doMock("./JsonMcpWriter.js", () => ({ upsertJsonMcpServer: upsertMock, removeJsonMcpServer: removeMock }));
		// getInstalledClineStorageDirs / getClineStorageDirs read real disk; mock them
		// so the test is deterministic regardless of what's installed on the machine.
		vi.doMock("../../core/ClineDetector.js", () => ({
			getInstalledClineStorageDirs: async () => fakeInstalled,
			getClineStorageDirs: () => fakeAll,
			clineMcpSettingsPath: (dir: string) => join(dir, "settings", "cline_mcp_settings.json"),
		}));
		upsertMock.mockClear();
		removeMock.mockClear();
	});
	afterEach(() => {
		vi.doUnmock("./JsonMcpWriter.js");
		vi.doUnmock("../../core/ClineDetector.js");
		vi.resetModules();
	});

	it("register() writes settings/cline_mcp_settings.json for each INSTALLED flavor, default key, {command,args}", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, cline: true });
		await r.register("/some/wt");
		expect(upsertMock).toHaveBeenCalledTimes(fakeInstalled.length);
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(fakeInstalled[0], "settings", "cline_mcp_settings.json"));
		expect(key).toBeUndefined(); // default mcpServers
		expect(entry.args).toContain("mcp");
	});

	it("remove() clears settings/cline_mcp_settings.json for EVERY flavor (not just installed)", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, cline: true });
		await r.remove("/some/wt");
		expect(removeMock).toHaveBeenCalledTimes(fakeAll.length);
		expect(removeMock.mock.calls.map((c) => c[0])).toEqual(
			fakeAll.map((d) => join(d, "settings", "cline_mcp_settings.json")),
		);
	});
});

describe("scope filtering — global vs repo", () => {
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const removeMock = vi.fn().mockResolvedValue(undefined);
	beforeEach(() => {
		vi.resetModules();
		vi.doMock("./JsonMcpWriter.js", () => ({ upsertJsonMcpServer: upsertMock, removeJsonMcpServer: removeMock }));
		upsertMock.mockClear();
		removeMock.mockClear();
	});
	afterEach(() => {
		vi.doUnmock("./JsonMcpWriter.js");
		vi.resetModules();
	});

	it("registerGlobalMcpHosts writes detected global hosts (copilot) and skips repo hosts (cursor)", async () => {
		const { registerGlobalMcpHosts: regGlobal } = await import("./HostRegistrars.js");
		await regGlobal({ ...NONE, copilot: true, cursor: true });
		const paths = upsertMock.mock.calls.map((c) => c[0] as string);
		expect(paths).toContain(join(homedir(), ".copilot", "mcp-config.json"));
		expect(paths.every((p) => !p.includes(".cursor"))).toBe(true);
	});

	it("registerGlobalMcpHosts writes the new global hosts (devin, antigravity)", async () => {
		const { registerGlobalMcpHosts: regGlobal } = await import("./HostRegistrars.js");
		await regGlobal({ ...NONE, devin: true, antigravity: true });
		const paths = upsertMock.mock.calls.map((c) => c[0] as string);
		expect(paths).toContain(join(homedir(), ".config", "devin", "config.json"));
		expect(paths).toContain(join(homedir(), ".gemini", "config", "mcp_config.json"));
	});

	it("registerGlobalMcpHosts is a no-op when no global hosts detected", async () => {
		const { registerGlobalMcpHosts: regGlobal } = await import("./HostRegistrars.js");
		await regGlobal({ ...NONE, claude: true, cursor: true });
		expect(upsertMock).not.toHaveBeenCalled();
	});

	it("removeRepoMcpHosts touches only repo hosts (cursor), never global hosts", async () => {
		const { removeRepoMcpHosts: rmRepo } = await import("./HostRegistrars.js");
		await rmRepo("/some/wt");
		// Only the cursor (.cursor/mcp.json) repo host flows through JsonMcpWriter;
		// claude uses removeMcpFromClaude directly, and every global host is skipped.
		expect(removeMock.mock.calls.map((c) => c[0] as string)).toEqual([join("/some/wt", ".cursor", "mcp.json")]);
	});
});

describe("jolliEntry — Windows resolves Cli.js and spawns node", () => {
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const originalPlatform = process.platform;
	beforeEach(() => {
		vi.resetModules();
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		vi.doMock("./JsonMcpWriter.js", () => ({ upsertJsonMcpServer: upsertMock, removeJsonMcpServer: vi.fn() }));
		vi.doMock("../McpRegistration.js", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../McpRegistration.js")>();
			return { ...actual, resolveCliJs: () => "/dist/Cli.js" };
		});
		upsertMock.mockClear();
	});
	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		vi.doUnmock("./JsonMcpWriter.js");
		vi.doUnmock("../McpRegistration.js");
		vi.resetModules();
	});

	it("non-Claude host entry on win32 is { command: 'node', args: ['<Cli.js>', 'mcp'] }", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [copilot] = build({ ...NONE, copilot: true });
		await copilot.register("/wt");
		const entry = upsertMock.mock.calls[0][1] as { command: string; args: string[] };
		expect(entry.command).toBe("node");
		expect(entry.args).toEqual(["/dist/Cli.js", "mcp"]);
	});
});

/*
 * Codex's win32 entry prefers the launcher over a resolved Cli.js. Both bake in an
 * absolute path (unavoidable in a static config file), but Cli.js also freezes the
 * runtime VERSION until the next register, while the launcher re-resolves the winning
 * dist on every MCP start. Codex is the one host where a plugin bundle and a
 * standalone CLI compete on the same machine, so a frozen version is most likely to
 * be the wrong one there.
 */
describe("codex registrar — win32 prefers the MCP launcher", () => {
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const originalPlatform = process.platform;

	function mockRegistration(launcher: string | undefined): void {
		vi.doMock("../McpRegistration.js", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../McpRegistration.js")>();
			return { ...actual, resolveCliJs: () => "/dist/Cli.js", resolveMcpLauncherJs: () => launcher };
		});
	}

	beforeEach(() => {
		vi.resetModules();
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		vi.doMock("./CodexTomlWriter.js", () => ({
			upsertCodexMcpServer: upsertMock,
			removeCodexMcpServer: vi.fn(),
		}));
		upsertMock.mockClear();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		vi.doUnmock("./CodexTomlWriter.js");
		vi.doUnmock("../McpRegistration.js");
		vi.resetModules();
	});

	// No trailing "mcp" argument: the launcher appends it when spawning the CLI.
	it("spawns the launcher when the winning dist ships one", async () => {
		mockRegistration("/dist/McpLauncher.js");
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [codex] = build({ ...NONE, codex: true });
		await codex.register("/wt");
		expect(upsertMock.mock.calls[0][1]).toEqual({ command: "node", args: ["/dist/McpLauncher.js"] });
	});

	// The normal case for a cli/vscode dist — only the Codex plugin's bundle ships a
	// launcher today, so the fallback is the load-bearing branch.
	it("falls back to node <Cli.js> mcp when the winning dist ships no launcher", async () => {
		mockRegistration(undefined);
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [codex] = build({ ...NONE, codex: true });
		await codex.register("/wt");
		expect(upsertMock.mock.calls[0][1]).toEqual({ command: "node", args: ["/dist/Cli.js", "mcp"] });
	});
});

// POSIX is unaffected by the launcher preference: `run-cli` already resolves the
// winning dist at spawn time, so the entry must stay exactly what every other host
// gets. Guards against the win32 branch leaking out of its platform check.
describe("codex registrar — POSIX keeps the run-cli entry", () => {
	const upsertMock = vi.fn().mockResolvedValue(undefined);
	const originalPlatform = process.platform;

	beforeEach(() => {
		vi.resetModules();
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		vi.doMock("./CodexTomlWriter.js", () => ({
			upsertCodexMcpServer: upsertMock,
			removeCodexMcpServer: vi.fn(),
		}));
		vi.doMock("../McpRegistration.js", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../McpRegistration.js")>();
			return {
				...actual,
				resolveMcpLauncherJs: () => {
					throw new Error("resolveMcpLauncherJs must not be consulted on POSIX");
				},
			};
		});
		upsertMock.mockClear();
	});

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		vi.doUnmock("./CodexTomlWriter.js");
		vi.doUnmock("../McpRegistration.js");
		vi.resetModules();
	});

	it("registers run-cli with the mcp argument", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [codex] = build({ ...NONE, codex: true });
		await codex.register("/wt");
		const entry = upsertMock.mock.calls[0][1] as { command: string; args: string[] };
		expect(entry.command).toBe(join(homedir(), ".jolli", "jollimemory", "run-cli"));
		expect(entry.args).toEqual(["mcp"]);
	});
});

/*
 * Hermes registrar — end-to-end against a real, throwaway HERMES_HOME.
 *
 * Unlike Codex/Gemini/Kimi, we exercise the actual YAML writer here rather than
 * mocking it. The writer's shape is the whole point (block-level upsert against
 * an arbitrary user-authored config), and the drift risk is not "does the writer
 * work" — it is "does the registrar hand it the right block, the right sub-key,
 * and the right body". A mock cannot catch a body whose indent is off by one
 * space or whose args array is JSON-quoted wrong.
 */
describe("hermes registrar — structure", () => {
	it("appears in buildRegistrars when detected.hermes is true", () => {
		const registrars = buildRegistrars({ ...NONE, hermes: true });
		expect(registrars.map((r) => r.host)).toContain("hermes");
	});
	it("does not appear when detected.hermes is false", () => {
		expect(buildRegistrars({ ...NONE }).map((r) => r.host)).not.toContain("hermes");
	});
	it("gitExcludePaths() returns [] — global config, never committed", () => {
		const [hermes] = buildRegistrars({ ...NONE, hermes: true });
		expect(hermes.gitExcludePaths()).toEqual([]);
	});
});

describe("hermes registrar — register/remove against a real config.yaml", () => {
	let hermesHome: string;
	let cfg: string;
	let allowlist: string;

	beforeEach(async () => {
		hermesHome = await mkdtemp(join(tmpdir(), "hermes-home-"));
		cfg = join(hermesHome, "config.yaml");
		allowlist = join(hermesHome, "shell-hooks-allowlist.json");
		process.env.HERMES_HOME = hermesHome;
	});
	afterEach(async () => {
		delete process.env.HERMES_HOME;
		await rm(hermesHome, { recursive: true, force: true });
	});

	it("writes both mcp_servers and hooks blocks when POSIX", async () => {
		if (process.platform === "win32") return; // covered by the win32 test below
		const [hermes] = buildRegistrars({ ...NONE, hermes: true });
		await hermes.register("/wt");
		const text = await readFile(cfg, "utf-8");
		expect(text).toContain("mcp_servers:\n  jollimemory:\n");
		expect(text).toContain("command:");
		expect(text).toContain("args:");
		expect(text).toContain("hooks:\n  on_session_end:");
		expect(text).toContain("run-hook");
		expect(text).toContain("hermes-stop");
		// And the allowlist got pre-approved.
		const parsed = JSON.parse(await readFile(allowlist, "utf-8"));
		expect(parsed.approvals).toHaveLength(1);
		expect(parsed.approvals[0].event).toBe("on_session_end");
	});

	it("quotes a spaced run-hook path in the hook command for shlex.split", async () => {
		if (process.platform === "win32") return;
		const spacedHome = join(tmpdir(), "First Last");
		vi.stubEnv("HOME", spacedHome);
		const [hermes] = buildRegistrars({ ...NONE, hermes: true });
		await hermes.register("/wt");
		const text = await readFile(cfg, "utf-8");
		const quoted = `"${join(spacedHome, ".jolli", "jollimemory", "run-hook")}" hermes-stop`;
		expect(text).toContain(`command: ${JSON.stringify(quoted)}`);
	});

	it("preserves an unrelated user MCP server", async () => {
		if (process.platform === "win32") return;
		await writeFile(
			cfg,
			`model:\n  default: anthropic/claude-opus-4.6\n` +
				`mcp_servers:\n  linear:\n    command: /usr/local/bin/linear-mcp\n    args: []\n` +
				`custom_providers:\n  - name: sub2api\n    api_key: sk-c8d69c\n`,
		);
		const [hermes] = buildRegistrars({ ...NONE, hermes: true });
		await hermes.register("/wt");
		const text = await readFile(cfg, "utf-8");
		expect(text).toContain("linear:");
		expect(text).toContain("jollimemory:");
		// The plaintext api_key MUST survive. This is the whole point of the
		// no-op short-circuit + atomic-write + mode-preservation contract.
		expect(text).toContain("api_key: sk-c8d69c");
	});

	it("preserves user commands in on_session_end during register and remove", async () => {
		if (process.platform === "win32") return;
		await writeFile(
			cfg,
			`mcp_servers: {}\nhooks:\n  on_session_end:\n    - command: "/user/session-end"\n      timeout: 10\n`,
		);
		const [hermes] = buildRegistrars({ ...NONE, hermes: true });
		await hermes.register("/wt");
		let text = await readFile(cfg, "utf-8");
		expect(text).toContain('command: "/user/session-end"');
		expect(text).toContain("hermes-stop");

		await hermes.remove("/wt");
		text = await readFile(cfg, "utf-8");
		expect(text).toContain('command: "/user/session-end"');
		expect(text).not.toContain("hermes-stop");
		expect(text).toContain("hooks:\n  on_session_end:");
	});

	it("registers every named profile's independent config and allowlist", async () => {
		if (process.platform === "win32") return;
		const workProfile = join(hermesHome, "profiles", "work");
		const personalProfile = join(hermesHome, "profiles", "personal");
		await mkdir(workProfile, { recursive: true });
		await mkdir(personalProfile, { recursive: true });
		// A named profile is a complete Hermes instance: its home carries a config
		// from creation. An EMPTY profile directory is not an instance yet and
		// must not be fabricated into one (see listHermesHomeDirs).
		await writeFile(join(workProfile, "config.yaml"), "model: {}\n");
		await writeFile(join(personalProfile, "config.yaml"), "model: {}\n");
		const emptyProfile = join(hermesHome, "profiles", "never-used");
		await mkdir(emptyProfile, { recursive: true });
		const [hermes] = buildRegistrars({ ...NONE, hermes: true });
		await hermes.register("/wt");

		for (const home of [hermesHome, personalProfile, workProfile]) {
			const text = await readFile(join(home, "config.yaml"), "utf-8");
			expect(text).toContain("mcp_servers:\n  jollimemory:");
			expect(text).toContain("hooks:\n  on_session_end:");
			const parsed = JSON.parse(await readFile(join(home, "shell-hooks-allowlist.json"), "utf-8"));
			expect(parsed.approvals).toHaveLength(1);
		}
		// The empty profile directory received nothing — it is not a Hermes home.
		await expect(readFile(join(emptyProfile, "config.yaml"), "utf-8")).rejects.toThrow(/ENOENT/);
	});

	it("is idempotent — a re-register on an already-registered file writes nothing", async () => {
		if (process.platform === "win32") return;
		const [hermes] = buildRegistrars({ ...NONE, hermes: true });
		await hermes.register("/wt");
		const first = await readFile(cfg, "utf-8");
		const firstAllow = await readFile(allowlist, "utf-8");
		await hermes.register("/wt");
		expect(await readFile(cfg, "utf-8")).toBe(first);
		expect(await readFile(allowlist, "utf-8")).toBe(firstAllow);
	});

	it("remove() clears BOTH blocks and the allowlist entry", async () => {
		if (process.platform === "win32") return;
		const [hermes] = buildRegistrars({ ...NONE, hermes: true });
		await hermes.register("/wt");
		await hermes.remove("/wt");
		const text = await readFile(cfg, "utf-8");
		expect(text).not.toContain("jollimemory:");
		expect(text).not.toContain("on_session_end:");
		// Collapsed back to the `{}` idiom Hermes' own writer emits.
		expect(text).toContain("mcp_servers: {}");
		expect(text).toContain("hooks: {}");
		const parsed = JSON.parse(await readFile(allowlist, "utf-8"));
		expect(parsed.approvals).toHaveLength(0);
	});
});
