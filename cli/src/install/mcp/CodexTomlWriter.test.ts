import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Spy on readFile so a single test can simulate a non-ENOENT read failure (EACCES)
// deterministically on every platform. Default passes through to the real impl.
// (chmod(0o000) can't make a file unreadable on Windows — it only sets read-only,
// which leaves reads working and instead fails the later write.)
const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn<typeof import("node:fs/promises").readFile>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	mockReadFile.mockImplementation(original.readFile);
	return { ...original, readFile: mockReadFile };
});

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
	/*
	 * Codex's config lists commands this machine will spawn, and other tools' `env`
	 * blocks routinely hold tokens — so when WE create the file, it should not be
	 * world-readable. A file that already exists keeps whatever permissions its owner
	 * chose: this writer goes through a tmpfile + rename, which WOULD impose the
	 * tmpfile's mode, so the existing mode is read and passed back deliberately.
	 * Silently re-chmod'ing another tool's config would be an overreach either way.
	 *
	 * POSIX-only: on Windows the mode bits are not meaningful and node reports 0666.
	 */
	it.skipIf(process.platform === "win32")("creates the file 0600, and never re-chmods an existing one", async () => {
		const dir = await mkdtemp(join(tmpdir(), "c-"));
		const created = join(dir, "config.toml");
		await upsertCodexMcpServer(created, entry);
		const { stat, chmod } = await import("node:fs/promises");
		expect((await stat(created)).mode & 0o777).toBe(0o600);

		const preexisting = join(dir, "other.toml");
		await writeFile(preexisting, 'model = "o4"\n', "utf-8");
		await chmod(preexisting, 0o644);
		await upsertCodexMcpServer(preexisting, entry);
		expect((await stat(preexisting)).mode & 0o777).toBe(0o644);
	});

	/*
	 * The load-bearing guard. The Codex plugin's SessionStart bootstrap reaches this
	 * upsert on EVERY session — `install` with `repoHooksOnly` registers Codex whether
	 * or not the call is `automatic` — and this function rewrites the file WHOLE,
	 * including the user's model settings, sandbox policy and other servers' `env`
	 * blocks. Re-serialising all of that to produce identical bytes on every session
	 * start is pure risk: two sessions starting together would be last-writer-wins over
	 * the entire file, not just over Jolli's own table.
	 *
	 * Asserted via mtime rather than content, because content is identical either way —
	 * which is exactly why the bug would have been invisible.
	 */
	it("does not touch the file when the entry already matches", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await writeFile(p, 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"\n', "utf-8");
		await upsertCodexMcpServer(p, entry);

		const { stat, utimes } = await import("node:fs/promises");
		const before = await readFile(p, "utf-8");
		// Backdate so a rewrite is detectable even at coarse filesystem timestamp
		// granularity.
		const stale = new Date(Date.now() - 60_000);
		await utimes(p, stale, stale);
		const mtimeBefore = (await stat(p)).mtimeMs;

		await upsertCodexMcpServer(p, entry);

		expect((await stat(p)).mtimeMs).toBe(mtimeBefore);
		expect(await readFile(p, "utf-8")).toBe(before);
	});

	// ...but a real change must still be written, or the guard above would have turned
	// registration into a no-op for the case that matters (an upgrade whose command or
	// args moved).
	it("still writes when the entry's command changes", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		await upsertCodexMcpServer(p, entry);
		await upsertCodexMcpServer(p, { command: "/new/path/run-cli", args: ["mcp"] });
		const t = await readFile(p, "utf-8");
		expect(t).toContain('command = "/new/path/run-cli"');
		expect(t).not.toContain('command = "/h/.jolli/jollimemory/run-cli"');
		// Exactly one table — the replacement must not append a second one.
		expect(t.match(/\[mcp_servers\.jollimemory\]/g)).toHaveLength(1);
	});

	// No tmpfile may survive a successful write; a leftover `config.toml.<pid>.<uuid>.tmp`
	// beside the real config would be visible to the user and to Codex's own tooling.
	it("leaves no tmpfile behind", async () => {
		const dir = await mkdtemp(join(tmpdir(), "c-"));
		const p = join(dir, "config.toml");
		await upsertCodexMcpServer(p, entry);
		await upsertCodexMcpServer(p, { command: "/other", args: [] });
		const { readdir } = await import("node:fs/promises");
		expect(await readdir(dir)).toEqual(["config.toml"]);
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
		// Simulate an unreadable-but-present file (EACCES). The writer must skip rather
		// than treat it like ENOENT and clobber the user's other Codex config.
		mockReadFile.mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
		await upsertCodexMcpServer(p, entry);
		const t = await readFile(p, "utf-8"); // passthrough (real impl) — file untouched
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
	it("removeCodexMcpServer normalizes the seam when the block sits between other tables", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "c-")), "config.toml");
		// jollimemory sits BETWEEN [a] and [b]: removing it leaves non-empty `before`
		// AND non-empty `rest`, so stripBlock must collapse the seam to one blank line.
		await writeFile(
			p,
			'[a]\nx = 1\n\n[mcp_servers.jollimemory]\ncommand = "old"\nargs = ["mcp"]\n\n[b]\ny = 2\n',
			"utf-8",
		);
		await removeCodexMcpServer(p);
		const t = await readFile(p, "utf-8");
		expect(t).not.toContain("jollimemory");
		expect(t).toBe("[a]\nx = 1\n\n[b]\ny = 2\n");
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
