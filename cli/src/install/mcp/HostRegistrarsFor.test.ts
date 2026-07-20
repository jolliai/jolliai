import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerRepoMcpHostsFor, removeRepoMcpHostsFor } from "./HostRegistrars.js";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "jolli-host-for-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const readCursor = async (): Promise<{ mcpServers?: Record<string, unknown> }> =>
	JSON.parse(await readFile(join(dir, ".cursor", "mcp.json"), "utf-8"));

describe("registerRepoMcpHostsFor / removeRepoMcpHostsFor (single repo host)", () => {
	it("registers then removes just Cursor's jollimemory entry", async () => {
		await registerRepoMcpHostsFor(dir, "cursor");
		expect((await readCursor()).mcpServers?.jollimemory).toBeDefined();
		await removeRepoMcpHostsFor(dir, "cursor");
		expect((await readCursor()).mcpServers?.jollimemory).toBeUndefined();
	});

	it("is a no-op for a global host (codex writes no repo config)", async () => {
		await registerRepoMcpHostsFor(dir, "codex");
		await expect(readFile(join(dir, ".cursor", "mcp.json"), "utf-8")).rejects.toThrow();
	});

	it("registers Claude's repo .mcp.json", async () => {
		await registerRepoMcpHostsFor(dir, "claude");
		const json = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf-8"));
		expect(json.mcpServers.jollimemory).toBeDefined();
	});
});
