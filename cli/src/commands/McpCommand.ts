/**
 * `jolli mcp` — the stdio MCP server entry every AI host spawns.
 * `jolli mcp --reindex` forces a full rebuild of the local search index and exits.
 *
 * This is now a thin proxy onto a per-worktree daemon rather than a
 * server itself; `jolli mcp-serve` (hidden) is that daemon. The host-facing
 * contract is unchanged — still stdio, still spawned per session — so no MCP
 * host registration had to move.
 */

import type { Command } from "commander";
import { resolveProjectDir, resolveProjectDirInfo } from "../core/ProjectDir.js";
import { SearchIndex } from "../core/SearchIndex.js";
import { createStorage } from "../core/StorageFactory.js";
import { setActiveStorage } from "../core/SummaryStore.js";
import { createLogger } from "../Logger.js";
import { runMcpDaemon } from "../mcp/McpDaemon.js";
import { runMcpProxy } from "../mcp/McpProxy.js";
import { startMcpServer } from "../mcp/McpServer.js";

const log = createLogger("McpCommand");

/**
 * Escape hatch: serve in-process, exactly as before the daemon existed.
 *
 * Deliberately an env var and not a flag — the ten host registrations write a
 * fixed `mcp` argv, so a flag would need every registrar (and every already
 * installed config) to change before it could be used. An env var is settable at
 * the host level today, which is what makes it usable for bisecting a suspected
 * daemon problem on a real machine.
 */
export const MCP_NO_DAEMON_ENV = "JOLLI_MCP_NO_DAEMON";

/**
 * The hidden subcommand the proxy spawns detached.
 *
 * Named as a constant because `Cli.ts` has to recognise this invocation BEFORE
 * Commander exists — see `isDetachedDaemonInvocation` there and the lockstep
 * test that pins the two spellings together.
 */
export const MCP_DAEMON_COMMAND = "mcp-serve";

export function registerMcpCommand(program: Command): void {
	program
		.command("mcp")
		.description("Start the JolliMemory MCP server (stdio) for AI agents")
		.option("--reindex", "Rebuild the local search index from source and exit")
		.action(async (options: { reindex?: boolean }) => {
			// Anchor to the git worktree root: an AI host may launch `jolli mcp` from
			// a subdirectory, and this cwd drives storage / queue / telemetry for the
			// whole (long-lived) server. See resolveStateRoot / resolveProjectDir.
			const { dir: cwd, fromGit } = resolveProjectDirInfo();
			if (options.reindex) {
				// Establish the configured backend before reading sources — mirrors
				// startMcpServer. Without it, rebuild's reads fall through to the
				// orphan-branch fallback, so a folder-mode user would reindex from the
				// wrong (possibly empty) store and see a misleading "0 document(s)".
				const storage = await createStorage(cwd, cwd);
				setActiveStorage(storage);
				// Pass `storage` so the index file lands in the SAME dir the MCP server
				// reads from (`<kbRoot>/.jolli/jollimemory/` in folder/dual-write mode).
				// Without it resolveIndexDir falls back to cwd and `--reindex` writes to
				// the checkout instead of the Memory Bank folder.
				const { docCount } = await SearchIndex.rebuild(cwd, storage);
				process.stdout.write(`Reindexed ${docCount} document(s).\n`);
				return;
			}
			if (process.env[MCP_NO_DAEMON_ENV] === "1") {
				await startMcpServer(cwd);
				return;
			}
			await runMcpProxy({ cwd, isWorktreeRoot: fromGit });
		});

	// Hidden: spawned detached by the proxy, never typed by a user. `--cwd` and
	// `--socket` are both explicit because the daemon is launched with an
	// inherited cwd it must not re-derive — `resolveProjectDir` would shell out
	// to git again for an answer the proxy has already resolved, and any
	// disagreement between the two would put the daemon on a socket the proxy
	// does not look at.
	program
		.command(MCP_DAEMON_COMMAND, { hidden: true })
		.description("Run the shared per-worktree MCP daemon (internal)")
		.option("--cwd <dir>", "Worktree root to serve")
		.option("--socket <path>", "Socket path to bind")
		.action(async (options: { cwd?: string; socket?: string }) => {
			const cwd = options.cwd ?? resolveProjectDir();
			const reason = await runMcpDaemon({ cwd, ...(options.socket ? { socketPath: options.socket } : {}) });
			// Exit code stays 0 for every reason, including "another daemon won the
			// race". Losing that race is the intended outcome — a server for this
			// worktree exists — and nothing reads this code anyway: the process is
			// detached with stdio ignored.
			log.info("MCP daemon exited: %s", reason);
		});
}
