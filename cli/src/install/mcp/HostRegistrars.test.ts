import { mkdtemp, readFile, rm } from "node:fs/promises";
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

	it("claude registrar.register() writes .mcp.json with mcpServers.jollimemory.args === ['mcp']", async () => {
		const [claude] = buildRegistrars({ ...NONE, claude: true });
		await claude.register(dir);
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		expect(json.mcpServers.jollimemory.args).toEqual(["mcp"]);
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
		expect(json.mcpServers.jollimemory.args).toEqual(["mcp"]);
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
		expect(json.mcpServers.jollimemory.args).toEqual(["mcp"]);
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
	it("copilot appears when detected.copilot is true", () => {
		expect(buildRegistrars({ ...NONE, copilot: true }).map((r) => r.host)).toContain("copilot");
	});
	it("copilotChat appears when detected.copilotChat is true", () => {
		expect(buildRegistrars({ ...NONE, copilotChat: true }).map((r) => r.host)).toContain("copilotChat");
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
		expect(entry.args).toEqual(["mcp"]);
	});

	it("copilotChat register() → VS Code User/mcp.json, key `servers`, type:stdio", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		const [r] = build({ ...NONE, copilotChat: true });
		await r.register("/some/wt");
		const [path, entry, key] = upsertMock.mock.calls[0];
		expect(path).toBe(join(getVscodeUserDataDir("Code"), "User", "mcp.json"));
		expect(key).toBe("servers");
		expect(entry.type).toBe("stdio");
		expect(entry.args).toEqual(["mcp"]);
	});

	it("opencode/copilotChat remove() pass the right serversKey", async () => {
		const { buildRegistrars: build } = await import("./HostRegistrars.js");
		await build({ ...NONE, opencode: true })[0].remove("/some/wt");
		expect(removeMock.mock.calls[0][1]).toBe("mcp");
		removeMock.mockClear();
		await build({ ...NONE, copilotChat: true })[0].remove("/some/wt");
		expect(removeMock.mock.calls[0][1]).toBe("servers");
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
