import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeJsonMcpServer, upsertJsonMcpServer } from "./JsonMcpWriter.js";

const entry = { command: "/h/.jolli/jollimemory/run-cli", args: ["mcp"] };

describe("JsonMcpWriter", () => {
	it("creates the file with jollimemory under mcpServers", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await upsertJsonMcpServer(p, entry);
		expect(JSON.parse(await readFile(p, "utf-8")).mcpServers.jollimemory).toEqual(entry);
	});
	it("preserves other servers", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(p, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8");
		await upsertJsonMcpServer(p, entry);
		const cfg = JSON.parse(await readFile(p, "utf-8"));
		expect(cfg.mcpServers.other).toEqual({ command: "x" });
		expect(cfg.mcpServers.jollimemory).toEqual(entry);
	});
	it("refuses to overwrite unreadable JSON", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(p, "{ not json", "utf-8");
		await upsertJsonMcpServer(p, entry);
		expect(await readFile(p, "utf-8")).toBe("{ not json");
	});
	it("treats an empty/whitespace-only file as a fresh start (VS Code ships an empty mcp.json)", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(p, "   \n", "utf-8"); // empty placeholder, not corruption
		await upsertJsonMcpServer(p, { type: "stdio", command: "x", args: ["mcp"] }, "servers");
		const cfg = JSON.parse(await readFile(p, "utf-8"));
		expect(cfg.servers.jollimemory).toEqual({ type: "stdio", command: "x", args: ["mcp"] });
	});
	it("removeJsonMcpServer drops only jollimemory", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(p, JSON.stringify({ mcpServers: { jollimemory: entry, other: { command: "x" } } }), "utf-8");
		await removeJsonMcpServer(p);
		const cfg = JSON.parse(await readFile(p, "utf-8"));
		expect(cfg.mcpServers.jollimemory).toBeUndefined();
		expect(cfg.mcpServers.other).toEqual({ command: "x" });
	});
	it("removeJsonMcpServer is a no-op when file is absent", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await expect(removeJsonMcpServer(p)).resolves.toBeUndefined();
	});
	it("removeJsonMcpServer is a no-op when jollimemory key is absent", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(p, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8");
		const before = await readFile(p, "utf-8");
		await removeJsonMcpServer(p);
		// File unchanged (early return when key absent)
		expect(await readFile(p, "utf-8")).toBe(before);
	});
	it("upsertJsonMcpServer is idempotent (re-registering updates in place)", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await upsertJsonMcpServer(p, entry);
		const updated = { command: "/new/run-cli", args: ["mcp"] };
		await upsertJsonMcpServer(p, updated);
		const cfg = JSON.parse(await readFile(p, "utf-8"));
		expect(cfg.mcpServers.jollimemory).toEqual(updated);
	});
	it("creates parent dir if it does not exist", async () => {
		const base = await mkdtemp(join(tmpdir(), "j-"));
		const p = join(base, "sub", "dir", "mcp.json");
		await upsertJsonMcpServer(p, entry);
		expect(JSON.parse(await readFile(p, "utf-8")).mcpServers.jollimemory).toEqual(entry);
	});
	it("pretty-prints with 2-space indent and trailing newline", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await upsertJsonMcpServer(p, entry);
		const raw = await readFile(p, "utf-8");
		expect(raw).toMatch(/\n$/);
		expect(raw).toContain("  ");
	});
	it("writes under a custom serversKey (mcp) preserving the entry shape", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "opencode.json");
		const customEntry = { type: "local", command: ["node", "/x/Cli.js", "mcp"], enabled: true };
		await writeFile(p, JSON.stringify({ $schema: "https://opencode.ai/config.json" }), "utf-8");
		await upsertJsonMcpServer(p, customEntry, "mcp");
		const cfg = JSON.parse(await readFile(p, "utf-8"));
		expect(cfg.$schema).toBe("https://opencode.ai/config.json"); // other keys preserved
		expect(cfg.mcp.jollimemory).toEqual(customEntry);
		expect(cfg.mcpServers).toBeUndefined(); // default key NOT used
	});
	it("removes from a custom serversKey (servers)", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(
			p,
			JSON.stringify({ servers: { jollimemory: { type: "stdio", command: "x" }, other: { command: "y" } } }),
			"utf-8",
		);
		await removeJsonMcpServer(p, "servers");
		const cfg = JSON.parse(await readFile(p, "utf-8"));
		expect(cfg.servers.jollimemory).toBeUndefined();
		expect(cfg.servers.other).toEqual({ command: "y" });
	});
});
