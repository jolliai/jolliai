import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeCodexMcpServer, upsertCodexMcpServer } from "./CodexTomlWriter.js";

const entry = { command: "/h/.jolli/jollimemory/run-cli", args: ["mcp"] };

describe("CodexTomlWriter", () => {
	it("creates a [mcp_servers.jollimemory] table", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await upsertCodexMcpServer(p, entry);
		const t = await readFile(p, "utf-8");
		expect(t).toContain("[mcp_servers.jollimemory]");
		expect(t).toContain('command = "/h/.jolli/jollimemory/run-cli"');
		expect(t).toContain('args = ["mcp"]');
	});
	it("preserves unrelated content and other tables", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await writeFile(p, 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n', "utf-8");
		await upsertCodexMcpServer(p, entry);
		const t = await readFile(p, "utf-8");
		expect(t).toContain('model = "o4"');
		expect(t).toContain("[mcp_servers.other]");
		expect(t).toContain("[mcp_servers.jollimemory]");
	});
	it("replaces an existing jollimemory table idempotently", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await upsertCodexMcpServer(p, { command: "old", args: ["mcp"] });
		await upsertCodexMcpServer(p, entry);
		const t = await readFile(p, "utf-8");
		expect(t).not.toContain('command = "old"');
		expect((t.match(/\[mcp_servers\.jollimemory\]/g) ?? []).length).toBe(1);
	});
	it("removeCodexMcpServer drops only the jollimemory table", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await writeFile(p, '[mcp_servers.other]\ncommand = "x"\n', "utf-8");
		await upsertCodexMcpServer(p, entry);
		await removeCodexMcpServer(p);
		const t = await readFile(p, "utf-8");
		expect(t).not.toContain("jollimemory");
		expect(t).toContain("[mcp_servers.other]");
	});
	it("upsertCodexMcpServer skips and warns when file exists but is unreadable (non-ENOENT)", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await writeFile(p, 'model = "o4"\n', "utf-8");
		await chmod(p, 0o000);
		try {
			await upsertCodexMcpServer(p, entry);
			// file should be untouched (chmod 000 means we cannot write either)
		} finally {
			await chmod(p, 0o644);
		}
		const t = await readFile(p, "utf-8");
		expect(t).toBe('model = "o4"\n');
	});
	it("removeCodexMcpServer is a no-op when file is absent", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await expect(removeCodexMcpServer(p)).resolves.toBeUndefined();
	});
	it("removeCodexMcpServer is a no-op when jollimemory header is absent", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await writeFile(p, 'model = "o4"\n', "utf-8");
		await removeCodexMcpServer(p);
		expect(await readFile(p, "utf-8")).toBe('model = "o4"\n');
	});
	it("upsertCodexMcpServer works when args is omitted (defaults to [])", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await upsertCodexMcpServer(p, { command: "/path/to/cli" });
		const t = await readFile(p, "utf-8");
		expect(t).toContain("args = []");
	});
	it("removeCodexMcpServer handles block at EOF without trailing header", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		// jollimemory is the last table in the file (no subsequent '[' header)
		await writeFile(p, '[mcp_servers.jollimemory]\ncommand = "old"\nargs = ["mcp"]\n', "utf-8");
		await removeCodexMcpServer(p);
		const t = await readFile(p, "utf-8");
		expect(t).not.toContain("jollimemory");
	});
	it("preserves intentional blank-line runs elsewhere when replacing the block", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		// A deliberate triple-newline gap between [a] and [b] must survive an upsert
		// that replaces the jollimemory block — only the block's own seam is touched.
		await writeFile(
			p,
			'[a]\nx = 1\n\n\n[b]\ny = 2\n\n[mcp_servers.jollimemory]\ncommand = "old"\nargs = ["mcp"]\n',
			"utf-8",
		);
		await upsertCodexMcpServer(p, entry);
		const t = await readFile(p, "utf-8");
		expect(t).toContain("x = 1\n\n\n[b]");
		expect(t).not.toContain('command = "old"');
		expect((t.match(/\[mcp_servers\.jollimemory\]/g) ?? []).length).toBe(1);
	});
	it("does not treat a header string inside a comment as the table (line-anchored)", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		// The header substring appears mid-line in a comment; removal must be a
		// no-op (the real table is absent) and must not truncate the file.
		const original = '# example: [mcp_servers.jollimemory]\nmodel = "o4"\n';
		await writeFile(p, original, "utf-8");
		await removeCodexMcpServer(p);
		expect(await readFile(p, "utf-8")).toBe(original);
	});
	it("removeCodexMcpServer strips a jollimemory block followed by another table", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		// jollimemory is NOT the last table — a subsequent '[' header follows it,
		// so stripBlock must cut only up to that header (the after !== -1 branch).
		await writeFile(
			p,
			'[mcp_servers.jollimemory]\ncommand = "old"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "x"\n',
			"utf-8",
		);
		await removeCodexMcpServer(p);
		const t = await readFile(p, "utf-8");
		expect(t).not.toContain("jollimemory");
		expect(t).toContain("[mcp_servers.other]");
		expect(t).toContain('command = "x"');
	});
});
