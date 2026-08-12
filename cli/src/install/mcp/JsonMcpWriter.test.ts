import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
	/*
	 * The steady state, and the reason this guard exists at all.
	 *
	 * A plugin bootstrap reaches this on EVERY session start (the Cursor plugin's
	 * `sessionStart` hook registers `.cursor/mcp.json` regardless of `automatic`), where
	 * before it only ran from a user-invoked `jolli enable`. Without a no-op check this
	 * re-serialises the whole file — other tools' servers included — every session:
	 * concurrent sessions become last-writer-wins over the entire file, the host's
	 * watcher fires each time, and a user's hand formatting is normalised away. Observed
	 * live before the fix: the file's mtime tracked the second session start exactly.
	 *
	 * Asserted by mtime rather than content, because content is identical either way —
	 * which is exactly what made the old behavior invisible.
	 */
	it("does not rewrite the file when the entry is already current", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await upsertJsonMcpServer(p, entry);
		const first = (await stat(p)).mtimeMs;
		// A coarse clock could tie two genuinely separate writes; make any second write
		// unmistakably later.
		await new Promise((r) => setTimeout(r, 25));
		await upsertJsonMcpServer(p, entry);
		expect((await stat(p)).mtimeMs).toBe(first);
	});

	/*
	 * The guard compares CONTENT, not bytes, and this is why.
	 *
	 * A byte compare against the file on disk only holds while the file stays in the
	 * exact shape this writer emits. A Windows checkout (CRLF) or a user who indents
	 * with four spaces defeats it — and then the per-session bootstrap rewrites
	 * `.cursor/mcp.json` forever, which is the state the guard was added to end. The
	 * entry here is already correct, so there is nothing to do regardless of how the
	 * file happens to be laid out.
	 *
	 * Not normalising the user's formatting is the wanted outcome, not a side effect:
	 * the file is mostly other tools' configuration.
	 *
	 * A leading BOM is deliberately NOT in this list. `JSON.parse` rejects one, so such
	 * a file takes the unreadable-guard path above and is left alone for an entirely
	 * different reason — including it here would assert the right outcome via the wrong
	 * branch.
	 */
	it("does not rewrite a differently-formatted file whose entry is already current", async () => {
		for (const render of [
			(cfg: unknown) => JSON.stringify(cfg, null, 4),
			(cfg: unknown) => `${JSON.stringify(cfg, null, 2)}\n`.replace(/\n/gu, "\r\n"),
		]) {
			const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
			const original = render({ mcpServers: { other: { command: "x" }, jollimemory: entry } });
			await writeFile(p, original, "utf-8");
			const first = (await stat(p)).mtimeMs;
			await new Promise((r) => setTimeout(r, 25));
			await upsertJsonMcpServer(p, entry);
			expect((await stat(p)).mtimeMs).toBe(first);
			expect(await readFile(p, "utf-8")).toBe(original);
		}
	});

	it("still writes when the entry actually changed", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await upsertJsonMcpServer(p, entry);
		await upsertJsonMcpServer(p, { ...entry, args: ["mcp", "--reindex"] });
		expect(JSON.parse(await readFile(p, "utf-8")).mcpServers.jollimemory.args).toEqual(["mcp", "--reindex"]);
	});

	// Another server appearing is a real change even though Jolli's entry is untouched,
	// because the rendered file differs — so the guard must not suppress it.
	it("rewrites when another tool's entry changed but jollimemory did not", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await upsertJsonMcpServer(p, entry);
		const cfg = JSON.parse(await readFile(p, "utf-8"));
		cfg.mcpServers.other = { command: "x" };
		await writeFile(p, JSON.stringify(cfg, null, 2), "utf-8");
		await upsertJsonMcpServer(p, entry);
		const after = JSON.parse(await readFile(p, "utf-8"));
		expect(after.mcpServers.other).toEqual({ command: "x" });
		expect(after.mcpServers.jollimemory).toEqual(entry);
	});

	// A repeat uninstall must not rewrite either — `removeJsonMcpServer` returns on the
	// already-gone guard before touching the file.
	it("removeJsonMcpServer does not rewrite when the entry is already gone", async () => {
		const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
		await writeFile(p, `${JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2)}\n`, "utf-8");
		const first = (await stat(p)).mtimeMs;
		await new Promise((r) => setTimeout(r, 25));
		await removeJsonMcpServer(p);
		expect((await stat(p)).mtimeMs).toBe(first);
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
	/*
	 * Permissions, which the switch to an atomic write silently took away.
	 *
	 * `writeFile` overwrites in place and leaves the target's mode alone;
	 * `atomicWriteFile` replaces the INODE, so the tmpfile's umask-derived mode rides
	 * the rename onto the target — measured, 0600 in and 0644 out. Every file this
	 * writer touches is another tool's MCP config, holding the commands this machine
	 * will spawn and the `env` blocks (tokens included) they carry, so widening one is
	 * a real regression and an invisible one: the content is byte-identical and
	 * everything keeps working. `CodexTomlWriter` reads the mode back for exactly this
	 * reason; this module has to as well.
	 *
	 * POSIX-only: `chmod` on Windows moves the read-only bit and nothing else, so the
	 * assertion would be about a permission model that does not exist there.
	 */
	describe.skipIf(process.platform === "win32")("permissions", () => {
		const tightened = async (): Promise<string> => {
			const p = join(await mkdtemp(join(tmpdir(), "j-")), "mcp.json");
			await writeFile(p, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8");
			await chmod(p, 0o600);
			return p;
		};

		it("keeps a tightened file's mode through the upsert", async () => {
			const p = await tightened();
			await upsertJsonMcpServer(p, entry);
			expect((await stat(p)).mode & 0o777).toBe(0o600);
			// Guard against passing by doing nothing: the write really did happen.
			expect(JSON.parse(await readFile(p, "utf-8")).mcpServers.jollimemory).toEqual(entry);
		});

		it("keeps a tightened file's mode through the removal", async () => {
			const p = await tightened();
			await upsertJsonMcpServer(p, entry);
			await chmod(p, 0o600);
			await removeJsonMcpServer(p);
			expect((await stat(p)).mode & 0o777).toBe(0o600);
			expect(JSON.parse(await readFile(p, "utf-8")).mcpServers.jollimemory).toBeUndefined();
		});

		/*
		 * A file this writer CREATES keeps node's umask-derived default, unchanged from
		 * before the atomic write. Tightening it on first contact would be a separate
		 * decision — the one `CodexTomlWriter` made for `~/.codex/config.toml` — and not
		 * part of preserving what the user already chose.
		 */
		it("leaves creation on the platform default", async () => {
			const dir = await mkdtemp(join(tmpdir(), "j-"));
			const probe = join(dir, "probe.json");
			await writeFile(probe, "{}", "utf-8");
			const created = join(dir, "mcp.json");
			await upsertJsonMcpServer(created, entry);
			expect((await stat(created)).mode & 0o777).toBe((await stat(probe)).mode & 0o777);
		});
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
