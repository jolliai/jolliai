import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mcp/McpServer.js", () => ({ startMcpServer: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../core/SearchIndex.js", () => ({ SearchIndex: { rebuild: vi.fn() } }));
vi.mock("../core/StorageFactory.js", () => ({ createStorage: vi.fn().mockResolvedValue({ kind: "mock" }) }));
vi.mock("../core/SummaryStore.js", () => ({ setActiveStorage: vi.fn() }));

import { SearchIndex } from "../core/SearchIndex.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { startMcpServer } from "../mcp/McpServer.js";
import { registerMcpCommand } from "./McpCommand.js";

describe("jolli mcp", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("starts the stdio server by default", async () => {
		const program = new Command();
		registerMcpCommand(program);
		await program.parseAsync(["node", "jolli", "mcp"]);
		expect(startMcpServer).toHaveBeenCalledTimes(1);
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
