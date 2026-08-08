import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installClaudeHook } from "../install/ClaudeHookInstaller.js";
import { installGeminiHook } from "../install/GeminiHookInstaller.js";
import { installGitHook } from "../install/GitHookInstaller.js";
import { readRepoHookStatus } from "./HookStatus.js";

describe("readRepoHookStatus", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jolli-hookstatus-"));
		mkdirSync(join(dir, ".git"), { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports everything false for a repo with nothing installed", async () => {
		const [status] = await readRepoHookStatus([{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: dir }]);
		expect(status).toEqual({
			repoIdentity: "r1",
			repoName: "acme-api",
			gitHookInstalled: false,
			claudeHookInstalled: false,
			geminiHookInstalled: false,
			mcpRegistered: false,
		});
	});

	it("detects a real git hook install (filesystem, no git subprocess)", async () => {
		await installGitHook(dir);
		const [status] = await readRepoHookStatus([{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: dir }]);
		expect(status.gitHookInstalled).toBe(true);
	});

	it("detects a real Claude hook install (installClaudeHook reconciles both Stop and SessionStart together)", async () => {
		await installClaudeHook(dir);
		const [status] = await readRepoHookStatus([{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: dir }]);
		expect(status.claudeHookInstalled).toBe(true);
	});

	it("detects a real Gemini hook install", async () => {
		await installGeminiHook(dir);
		const [status] = await readRepoHookStatus([{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: dir }]);
		expect(status.geminiHookInstalled).toBe(true);
	});

	it("detects an .mcp.json jollimemory entry, and ignores an .mcp.json with other servers only", async () => {
		writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
		const other = await readRepoHookStatus([{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: dir }]);
		expect(other[0].mcpRegistered).toBe(false);

		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({ mcpServers: { jollimemory: { command: "node", args: ["mcp.js"] } } }),
		);
		const mine = await readRepoHookStatus([{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: dir }]);
		expect(mine[0].mcpRegistered).toBe(true);
	});

	it("tolerates malformed .mcp.json as not-registered rather than throwing", async () => {
		writeFileSync(join(dir, ".mcp.json"), "{not json");
		const [status] = await readRepoHookStatus([{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: dir }]);
		expect(status.mcpRegistered).toBe(false);
	});

	it("probes multiple repos independently and in order", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "jolli-hookstatus-2-"));
		mkdirSync(join(dir2, ".git"), { recursive: true });
		try {
			await installGitHook(dir2);
			const rows = await readRepoHookStatus([
				{ repoIdentity: "r1", repoName: "acme-api", worktreeRoot: dir },
				{ repoIdentity: "r2", repoName: "acme-web", worktreeRoot: dir2 },
			]);
			expect(rows.map((r) => r.repoIdentity)).toEqual(["r1", "r2"]);
			expect(rows[0].gitHookInstalled).toBe(false);
			expect(rows[1].gitHookInstalled).toBe(true);
		} finally {
			rmSync(dir2, { recursive: true, force: true });
		}
	});
});
