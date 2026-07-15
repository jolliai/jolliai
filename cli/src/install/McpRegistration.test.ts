import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cliInvocation,
	mcpServerEntry,
	registerMcpInClaude,
	removeMcpFromClaude,
	resolveCliInvocation,
	resolveCliJs,
} from "./McpRegistration.js";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-mcp-reg-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("registerMcpInClaude", () => {
	it("creates .mcp.json with a jollimemory server entry", async () => {
		await registerMcpInClaude(dir);
		const raw = await readFile(join(dir, ".mcp.json"), "utf-8");
		const json = JSON.parse(raw);
		expect(json.mcpServers.jollimemory).toBeDefined();
		expect(Array.isArray(json.mcpServers.jollimemory.args)).toBe(true);
		expect(json.mcpServers.jollimemory.args).toContain("mcp");
	});

	it("takes the Windows branch (node command) without throwing", async () => {
		// Exercises the win32 path of registerMcpInClaude (resolveCliJs + entry
		// selection). The exact command depends on whether a dist path is resolvable
		// on the host, so we only assert a well-formed entry — the command logic
		// itself is asserted by the mcpServerEntry unit tests.
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			await registerMcpInClaude(dir);
			const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
			expect(json.mcpServers.jollimemory.args).toContain("mcp");
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
		}
	});

	it("preserves existing servers and is idempotent", async () => {
		await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8");
		await registerMcpInClaude(dir);
		await registerMcpInClaude(dir); // second call must not duplicate or corrupt
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		expect(json.mcpServers.other).toBeDefined();
		expect(json.mcpServers.jollimemory).toBeDefined();
	});

	it("leaves a malformed-but-non-empty .mcp.json untouched (never clobbers the user's other servers)", async () => {
		// Regression: a parse failure on an EXISTING file must not be treated like an
		// absent file. Overwriting it would silently drop every other MCP server the
		// user had configured. We leave the file byte-for-byte as-is and skip.
		const malformed = '{ "mcpServers": { "other": { "command": "x" } },\n'; // trailing comma, unterminated
		await writeFile(join(dir, ".mcp.json"), malformed, "utf-8");
		await registerMcpInClaude(dir);
		const raw = await readFile(join(dir, ".mcp.json"), "utf-8");
		expect(raw).toBe(malformed); // untouched — not overwritten with a jollimemory-only config
	});
});

describe("mcpServerEntry", () => {
	const runCli = "/home/u/.jolli/jollimemory/run-cli";
	const cliJs = "/abs/dist/Cli.js";

	it("uses the run-cli shell wrapper on POSIX", () => {
		// run-cli has a shebang + is +x, so a direct spawn honors it on macOS/Linux.
		expect(mcpServerEntry("darwin", runCli, cliJs)).toEqual({ command: runCli, args: ["mcp"] });
		expect(mcpServerEntry("linux", runCli, cliJs)).toEqual({ command: runCli, args: ["mcp"] });
	});

	it("spawns node on the resolved Cli.js on Windows (run-cli is an unexecutable bash script there)", () => {
		// The MCP host spawns `command` directly (no shell), so a no-extension bash
		// script is ENOENT on Windows. node.exe is on PATH (hooks already require it).
		expect(mcpServerEntry("win32", runCli, cliJs)).toEqual({ command: "node", args: [cliJs, "mcp"] });
	});

	it("returns the run-cli last resort on Windows when the dist Cli.js can't be resolved", () => {
		// Last resort only: this run-cli entry is itself NOT launchable on win32
		// (same ENOENT as the shell wrapper), so it does not avoid breakage — it
		// defers it. The branch is effectively unreachable on the normal install
		// path (installDistPath runs, and aborts on failure, before registration),
		// and re-registration replaces it with `node Cli.js` once a dist is known.
		expect(mcpServerEntry("win32", runCli, undefined)).toEqual({ command: runCli, args: ["mcp"] });
	});
});

describe("cliInvocation", () => {
	const runCli = "/home/u/.jolli/jollimemory/run-cli";
	const cliJs = "/abs/dist/Cli.js";

	it("spawns the run-cli wrapper with the given args on POSIX", () => {
		expect(cliInvocation("darwin", runCli, cliJs, ["space", "clones", "--json"])).toEqual({
			command: runCli,
			args: ["space", "clones", "--json"],
		});
		expect(cliInvocation("linux", runCli, cliJs, ["mcp"])).toEqual({ command: runCli, args: ["mcp"] });
	});

	it("spawns node on the resolved Cli.js with the given args on Windows", () => {
		expect(cliInvocation("win32", runCli, cliJs, ["space", "clones", "--json"])).toEqual({
			command: "node",
			args: [cliJs, "space", "clones", "--json"],
		});
	});

	it("falls back to the run-cli last resort on Windows when Cli.js can't be resolved", () => {
		expect(cliInvocation("win32", runCli, undefined, ["mcp"])).toEqual({ command: runCli, args: ["mcp"] });
	});
});

describe("resolveCliInvocation", () => {
	it("resolves the run-cli indirection (never a bare `jolli`) with the given args on the host platform", () => {
		const globalDir = "/home/u/.jolli/jollimemory";
		const entry = resolveCliInvocation(["space", "clones", "--json"], globalDir);
		expect(entry.args).toEqual(["space", "clones", "--json"]);
		expect(entry.command).not.toBe("jolli");
		// On POSIX hosts the run-cli wrapper is spawned directly; on win32 CI it is
		// `node <Cli.js>` (or the run-cli last resort with no dist).
		expect(entry.command === "node" || entry.command.endsWith("run-cli")).toBe(true);
	});

	it("consults resolveCliJs on Windows (no dist ⇒ run-cli last resort)", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		const original = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			// No dist-paths dir under globalDir ⇒ resolveCliJs returns undefined ⇒ the
			// win32 branch falls back to the run-cli path (exercises the win32 ternary).
			expect(resolveCliInvocation(["mcp"], globalDir)).toEqual({
				command: join(globalDir, "run-cli"),
				args: ["mcp"],
			});
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
			await rm(globalDir, { recursive: true, force: true });
		}
	});
});

describe("resolveCliJs", () => {
	it("returns the winning dist's Cli.js", async () => {
		const distDir = await mkdtemp(join(tmpdir(), "jolli-dist-"));
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		try {
			await mkdir(join(globalDir, "dist-paths"), { recursive: true });
			// dist-path file format: line 1 = version, line 2 = existing dist dir.
			await writeFile(join(globalDir, "dist-paths", "cli"), `1.2.3\n${distDir}\n`, "utf-8");
			expect(resolveCliJs(globalDir)).toBe(join(distDir, "Cli.js"));
		} finally {
			await rm(distDir, { recursive: true, force: true });
			await rm(globalDir, { recursive: true, force: true });
		}
	});

	it("returns undefined when no dist path is registered", async () => {
		const globalDir = await mkdtemp(join(tmpdir(), "jolli-global-"));
		try {
			expect(resolveCliJs(globalDir)).toBeUndefined();
		} finally {
			await rm(globalDir, { recursive: true, force: true });
		}
	});
});

describe("removeMcpFromClaude", () => {
	it("removes only the jollimemory entry", async () => {
		await writeFile(
			join(dir, ".mcp.json"),
			JSON.stringify({ mcpServers: { other: { command: "x" }, jollimemory: { command: "y" } } }),
			"utf-8",
		);
		await removeMcpFromClaude(dir);
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		expect(json.mcpServers.jollimemory).toBeUndefined();
		expect(json.mcpServers.other).toBeDefined();
	});

	it("no-ops when .mcp.json is absent", async () => {
		await expect(removeMcpFromClaude(dir)).resolves.toBeUndefined();
	});

	it("no-ops when the file exists but has no jollimemory entry", async () => {
		await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8");
		await removeMcpFromClaude(dir);
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		expect(json.mcpServers.other).toBeDefined();
	});
});
