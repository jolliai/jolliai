import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mcp/McpServer.js", () => ({ startMcpServer: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../mcp/McpProxy.js", () => ({ runMcpProxy: vi.fn().mockResolvedValue("proxied") }));
vi.mock("../mcp/McpDaemon.js", () => ({ runMcpDaemon: vi.fn().mockResolvedValue("idle") }));
vi.mock("../core/SearchIndex.js", () => ({ SearchIndex: { rebuild: vi.fn() } }));
vi.mock("../core/StorageFactory.js", () => ({ createStorage: vi.fn().mockResolvedValue({ kind: "mock" }) }));
vi.mock("../core/SummaryStore.js", () => ({ setActiveStorage: vi.fn() }));
vi.mock("../core/ProjectDir.js", () => ({
	resolveProjectDir: vi.fn(() => "/repo/wt"),
	resolveProjectDirInfo: vi.fn(() => ({ dir: "/repo/wt", fromGit: true })),
}));

import { resolveProjectDirInfo } from "../core/ProjectDir.js";
import { SearchIndex } from "../core/SearchIndex.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { runMcpDaemon } from "../mcp/McpDaemon.js";
import { runMcpProxy } from "../mcp/McpProxy.js";
import { startMcpServer } from "../mcp/McpServer.js";
import { MCP_NO_DAEMON_ENV, registerMcpCommand } from "./McpCommand.js";

describe("jolli mcp", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// `clearAllMocks` wipes call history but not implementations, so a test that
		// points this at a non-repo cwd would leak into every test after it.
		vi.mocked(resolveProjectDirInfo).mockReturnValue({ dir: "/repo/wt", fromGit: true });
		delete process.env[MCP_NO_DAEMON_ENV];
	});

	it("runs the proxy by default, not a server of its own", async () => {
		// The host-facing contract is unchanged (still stdio, still one
		// process per session), but the server itself now lives in a shared
		// per-worktree daemon that this proxy ensures and forwards to.
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp"]);
		expect(runMcpProxy).toHaveBeenCalledTimes(1);
		expect(startMcpServer).not.toHaveBeenCalled();
	});

	it("forwards whether the resolved cwd is a real worktree root", async () => {
		// The proxy cannot re-derive this: it is handed a cwd, and a cwd that came
		// from `resolveProjectDir`'s fallback looks identical to a real root. Same
		// reason `mcp-serve` is given `--cwd` explicitly rather than resolving again.
		vi.mocked(resolveProjectDirInfo).mockReturnValue({ dir: "/", fromGit: false });
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp"]);
		expect(runMcpProxy).toHaveBeenCalledWith({ cwd: "/", isWorktreeRoot: false });
	});

	it("serves in-process when the escape hatch is set", async () => {
		// The bisect path for a suspected daemon problem on a real machine. An env
		// var rather than a flag because the ten host registrations write a fixed
		// `mcp` argv that a flag could not reach.
		process.env[MCP_NO_DAEMON_ENV] = "1";
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp"]);
		expect(startMcpServer).toHaveBeenCalledTimes(1);
		expect(runMcpProxy).not.toHaveBeenCalled();
	});

	it("registers the hidden mcp-serve daemon command and routes --cwd/--socket to it", async () => {
		// Both are passed explicitly so the daemon never re-derives a cwd the proxy
		// already resolved — a disagreement would put it on a socket nobody reads.
		const program = new Command();
		registerMcpCommand(program);
		const serve = program.commands.find((c) => c.name() === "mcp-serve");
		expect(serve).toBeDefined();
		await program.parseAsync(["node", "jolli", "mcp-serve", "--cwd", "/repo/wt", "--socket", "/tmp/x.sock"]);
		expect(runMcpDaemon).toHaveBeenCalledWith({ cwd: "/repo/wt", socketPath: "/tmp/x.sock" });
	});

	it("defaults mcp-serve's cwd to the resolved worktree root when --cwd is absent", async () => {
		// Only reachable if someone runs the hidden command by hand; the proxy
		// always passes --cwd so the daemon never re-derives an answer it was given.
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp-serve"]);
		expect(runMcpDaemon).toHaveBeenCalledWith({ cwd: expect.any(String) });
	});

	it("omits socketPath entirely when mcp-serve is given no --socket", async () => {
		// Spread-conditionally, not `socketPath: undefined`: the daemon treats an
		// explicitly supplied path as the caller taking responsibility for it and
		// skips the ownership gate on the managed directory.
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp-serve", "--cwd", "/repo/wt"]);
		expect(runMcpDaemon).toHaveBeenCalledWith({ cwd: "/repo/wt" });
	});

	it("--reindex rebuilds and does not start the server", async () => {
		vi.mocked(SearchIndex.rebuild).mockResolvedValue({ index: {} as never, docCount: 3 });
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp", "--reindex"]);
		expect(SearchIndex.rebuild).toHaveBeenCalledTimes(1);
		expect(startMcpServer).not.toHaveBeenCalled();
	});

	it("--reindex establishes the configured storage before rebuilding (folder-mode users)", async () => {
		vi.mocked(SearchIndex.rebuild).mockResolvedValue({ index: {} as never, docCount: 3 });
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp", "--reindex"]);
		// Without this, rebuild reads through the orphan-branch fallback and a
		// folder-mode user reindexes from the wrong (empty) store.
		expect(createStorage).toHaveBeenCalledTimes(1);
		expect(setActiveStorage).toHaveBeenCalledWith({ kind: "mock" });
		expect(vi.mocked(setActiveStorage).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(SearchIndex.rebuild).mock.invocationCallOrder[0],
		);
		// And the SAME storage is passed to rebuild so the index file lands in the
		// folder's kbRoot dir (matching where the MCP server reads it), not cwd.
		expect(SearchIndex.rebuild).toHaveBeenCalledWith(expect.any(String), { kind: "mock" });
	});
});
