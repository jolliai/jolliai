/**
 * Auto-registration of the JolliMemory MCP server into a worktree's `.mcp.json`
 * (Claude Code project config), JOLLI-1226 P0. Idempotent; preserves other
 * servers. Uses the same global `run-cli` entry script as the CLI/skills so
 * version bumps don't strand the registration.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalConfigDir } from "../core/SessionTracker.js";
import { createLogger } from "../Logger.js";
import { pickBestDistPath, traverseDistPaths } from "./DistPathResolver.js";

const log = createLogger("McpRegistration");
const SERVER_KEY = "jollimemory";

interface McpServerEntry {
	command: string;
	args: string[];
}

/**
 * The platform-correct `{ command, args }` to launch the jolli CLI with the given
 * subcommand `args`. The launcher spawns `command` DIRECTLY (no shell), so the
 * platform matters:
 * - POSIX: the `run-cli` dispatch script has a `#!/bin/bash` shebang and is +x,
 *   so a direct spawn honors it — and we keep the dist-path indirection (a
 *   version bump that moves the dist still resolves at spawn time).
 * - Windows: `run-cli` is an extension-less bash script; a direct spawn is
 *   ENOENT (no shebang support, not on PATHEXT). So we spawn `node` (already a
 *   hard requirement for the hooks, hence on PATH) on the resolved `Cli.js`.
 *   This bakes in an absolute path, but callers re-run on every install/activate,
 *   so a moved dist is re-resolved then.
 *
 *   If the dist can't be resolved yet on Windows there is no launchable command:
 *   `run-cli` is returned only as a last resort and is itself NOT launchable on
 *   win32 (same ENOENT) — i.e. it does NOT "avoid a broken entry", it just defers
 *   the breakage. On the normal install path `Installer.install()` writes this
 *   source's dist-path entry (aborting on failure) BEFORE any registration runs,
 *   so `resolveCliJs` resolves by then.
 */
export function cliInvocation(
	platform: NodeJS.Platform,
	runCli: string,
	cliJs: string | undefined,
	args: string[],
): McpServerEntry {
	if (platform === "win32" && cliJs) return { command: "node", args: [cliJs, ...args] };
	return { command: runCli, args: [...args] };
}

/** The `command`/`args` an MCP host should spawn to start the server (`<cli> mcp`). */
export function mcpServerEntry(platform: NodeJS.Platform, runCli: string, cliJs: string | undefined): McpServerEntry {
	return cliInvocation(platform, runCli, cliJs, ["mcp"]);
}

/**
 * Resolves the `{ command, args }` to spawn the jolli CLI with `args`, via the
 * machine-global `run-cli` indirection host registration already writes (POSIX)
 * or `node <Cli.js>` (win32). Deliberately NEVER a bare `jolli` on PATH — under
 * GUI-launched hosts and the VS Code bundle (which by design needs no global CLI
 * install) a bare-PATH spawn misfires. `globalDir` is injectable for tests.
 */
export function resolveCliInvocation(args: string[], globalDir: string = getGlobalConfigDir()): McpServerEntry {
	const runCli = join(globalDir, "run-cli");
	const cliJs = process.platform === "win32" ? resolveCliJs(globalDir) : undefined;
	return cliInvocation(process.platform, runCli, cliJs, args);
}

/**
 * Absolute path to the winning dist's `Cli.js` — the same dist `run-cli` would
 * resolve at runtime (highest available version across registered sources).
 * Returns undefined if no dist path is registered/available yet. `globalDir` is
 * injectable for tests; production passes the machine-global config dir.
 */
export function resolveCliJs(globalDir?: string): string | undefined {
	const best = pickBestDistPath(traverseDistPaths(globalDir));
	return best ? join(best.distDir, "Cli.js") : undefined;
}

/**
 * Git-exclude path for the auto-written `.mcp.json`. It carries a machine-local
 * ABSOLUTE `run-cli` path, so it must never be committed — Claude Code's
 * convention of committing `.mcp.json` for team sharing would otherwise ship a
 * path that's broken on every other machine/CI. Recorded in `.git/info/exclude`
 * (gitignore syntax: leading `/` anchors to repo root) alongside the skill paths.
 */
export const MCP_GIT_EXCLUDE_PATH = "/.mcp.json";

interface McpConfig {
	mcpServers?: Record<string, { command: string; args?: string[] }>;
}

/** Add (or refresh) the jollimemory server entry in <worktreeDir>/.mcp.json. */
export async function registerMcpInClaude(worktreeDir: string): Promise<void> {
	const mcpPath = join(worktreeDir, ".mcp.json");
	let config: McpConfig;
	try {
		config = JSON.parse(await readFile(mcpPath, "utf-8")) as McpConfig;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			// The file exists but couldn't be read/parsed (mid-edit, trailing comma,
			// partial write, EACCES). Resetting to `{}` and writing would silently
			// drop the user's OTHER MCP servers — so refuse to write and leave the
			// file untouched. Re-registration on the next install/activate recovers
			// once the file is valid again.
			log.warn("Skipping MCP registration: %s exists but is unreadable/invalid (%s)", mcpPath, String(err));
			return;
		}
		config = {}; // no file yet — fine to create a fresh one
	}
	const servers = config.mcpServers ?? {};

	// run-cli resolves the active dist path and execs `node <dist>/Cli.js "$@"`,
	// so passing `mcp` starts the server. Indirection survives version bumps —
	// but only POSIX can spawn the bash script directly (see mcpServerEntry), so
	// on Windows we resolve the winning dist's Cli.js and spawn node on it.
	const globalDir = getGlobalConfigDir();
	const runCli = join(globalDir, "run-cli");
	const cliJs = process.platform === "win32" ? resolveCliJs(globalDir) : undefined;
	servers[SERVER_KEY] = mcpServerEntry(process.platform, runCli, cliJs);

	const next: McpConfig = { ...config, mcpServers: servers };
	await writeFile(mcpPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	log.info("Registered MCP server in %s", mcpPath);
}

/** Remove the jollimemory server entry; no-op if file or entry is absent. */
export async function removeMcpFromClaude(worktreeDir: string): Promise<void> {
	const mcpPath = join(worktreeDir, ".mcp.json");
	let config: McpConfig;
	try {
		config = JSON.parse(await readFile(mcpPath, "utf-8")) as McpConfig;
	} catch {
		return; // absent or unreadable → nothing to remove
	}
	if (!config.mcpServers?.[SERVER_KEY]) return;
	delete config.mcpServers[SERVER_KEY];
	await writeFile(mcpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	log.info("Removed MCP server from %s", mcpPath);
}
