/**
 * HookStatus — cheap, per-repo "is it actually installed" probe for the
 * Settings → Hooks card.
 *
 * Deliberately NOT `Installer.getStatus()`: that scans every session store
 * (including Cursor/Devin/OpenCode SQLite) to answer a much bigger question
 * ("what does this whole machine look like"), which is far too heavy to run
 * synchronously inside an HTTP handler. Everything here is a filesystem read
 * — no git subprocess, no SQLite, no network — bounded by the number of
 * enabled repos.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isClaudeHookInstalled } from "../install/ClaudeHookInstaller.js";
import { isGeminiHookInstalled } from "../install/GeminiHookInstaller.js";
import { isGitHookInstalled } from "../install/GitHookInstaller.js";
import type { RepoHookStatus } from "./DashboardModel.js";

/** Whether `<worktreeRoot>/.mcp.json` carries a `jollimemory` server entry. */
async function isMcpRegistered(worktreeRoot: string): Promise<boolean> {
	try {
		const raw = await readFile(join(worktreeRoot, ".mcp.json"), "utf-8");
		const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
		return Boolean(parsed.mcpServers?.jollimemory);
	} catch {
		return false;
	}
}

export async function readRepoHookStatus(
	repos: ReadonlyArray<{ readonly repoIdentity: string; readonly repoName: string; readonly worktreeRoot: string }>,
): Promise<ReadonlyArray<RepoHookStatus>> {
	return Promise.all(
		repos.map(async (repo) => {
			const [gitHookInstalled, claudeHookInstalled, geminiHookInstalled, mcpRegistered] = await Promise.all([
				isGitHookInstalled(repo.worktreeRoot),
				isClaudeHookInstalled(repo.worktreeRoot),
				isGeminiHookInstalled(repo.worktreeRoot),
				isMcpRegistered(repo.worktreeRoot),
			]);
			return {
				repoIdentity: repo.repoIdentity,
				repoName: repo.repoName,
				gitHookInstalled,
				claudeHookInstalled,
				geminiHookInstalled,
				mcpRegistered,
			};
		}),
	);
}
