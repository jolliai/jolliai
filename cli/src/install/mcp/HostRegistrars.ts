/**
 * Per-host MCP registrar abstraction.
 *
 * Each AI coding host that supports the Model Context Protocol gets a
 * `McpHostRegistrar` implementation, tagged with a `scope` ("repo" | "global")
 * that says where its config file lives. `buildRegistrars` assembles the list of
 * active registrars based on which hosts were detected in the user's project.
 * `registerRepoMcpHosts` / `registerGlobalMcpHosts` / `removeRepoMcpHosts`
 * iterate over the relevant scope with per-host error isolation so a single
 * failing registration never blocks the others or fails the install.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getGlobalConfigDir } from "../../core/SessionTracker.js";
import { getVscodeUserDataDir } from "../../core/VscodeWorkspaceLocator.js";
import { createLogger } from "../../Logger.js";
import {
	MCP_GIT_EXCLUDE_PATH,
	mcpServerEntry,
	registerMcpInClaude,
	removeMcpFromClaude,
	resolveCliJs,
} from "../McpRegistration.js";
import { removeCodexMcpServer, upsertCodexMcpServer } from "./CodexTomlWriter.js";
import { removeJsonMcpServer, upsertJsonMcpServer } from "./JsonMcpWriter.js";

const log = createLogger("HostRegistrars");

export interface DetectedHosts {
	claude: boolean;
	codex: boolean;
	cursor: boolean;
	gemini: boolean;
	opencode: boolean;
	copilot: boolean;
	copilotChat: boolean;
}

export interface McpHostRegistrar {
	host: string;
	/**
	 * Where this host's config lives:
	 * - `"repo"`: project-scoped file inside the worktree (`.mcp.json`,
	 *   `.cursor/mcp.json`). Belongs to this repo — safe to remove on uninstall.
	 * - `"global"`: a single machine-wide file shared by EVERY repo
	 *   (`~/.codex/config.toml`, `~/.gemini/settings.json`, …). The `jollimemory`
	 *   entry is repo-agnostic, so a single-repo uninstall must NOT remove it or
	 *   it breaks MCP for every other repo still using Jolli.
	 */
	scope: "repo" | "global";
	register(wt: string): Promise<void>;
	remove(wt: string): Promise<void>;
	gitExcludePaths(): string[];
}

const claudeRegistrar: McpHostRegistrar = {
	host: "claude",
	scope: "repo",
	register: registerMcpInClaude,
	remove: removeMcpFromClaude,
	gitExcludePaths: () => [MCP_GIT_EXCLUDE_PATH],
};

/**
 * Build the `{ command, args }` entry for non-Claude MCP hosts.
 *
 * Uses the same `run-cli` dispatch script as the Claude registrar so version
 * bumps are handled transparently. Windows note: `run-cli` is an extension-less
 * bash script that a host cannot spawn directly (no shebang support, not on
 * PATHEXT), so on win32 we resolve the winning dist's `Cli.js` and spawn `node`
 * on it — exactly what `registerMcpInClaude` does. Mirroring it here keeps
 * Codex/Cursor/Gemini/OpenCode/Copilot working on Windows instead of writing a
 * command the host can't launch. POSIX spawns the bash shebang directly, so
 * `cliJs` stays undefined there.
 */
function jolliEntry() {
	const globalDir = getGlobalConfigDir();
	const cliJs = process.platform === "win32" ? resolveCliJs(globalDir) : undefined;
	return mcpServerEntry(process.platform, join(globalDir, "run-cli"), cliJs);
}

/**
 * Cursor: project-scoped `<worktree>/.cursor/mcp.json`.
 * Format verified from Cursor app source (parseMcpServersFromFile in workbench.desktop.main.js):
 * top-level key `mcpServers`, entry shape `{ command, args?, env?, envFile?, cwd? }`.
 * Contains an absolute machine-local path, so it must not be committed.
 */
const cursorRegistrar: McpHostRegistrar = {
	host: "cursor",
	scope: "repo",
	register: (wt) => upsertJsonMcpServer(join(wt, ".cursor", "mcp.json"), { ...jolliEntry() }),
	remove: (wt) => removeJsonMcpServer(join(wt, ".cursor", "mcp.json")),
	gitExcludePaths: () => ["/.cursor/mcp.json"],
};

/**
 * Gemini CLI: global `~/.gemini/settings.json` (GEMINI_DIR = ".gemini").
 * Format verified from Gemini CLI 0.38.2 source (SETTINGS_SCHEMA_DEFINITIONS.MCPServerConfig):
 * top-level key `mcpServers`, entry shape `{ command?, args?, env?, cwd?, url? }`.
 * Global config — never committed, so gitExcludePaths returns [].
 */
const geminiRegistrar: McpHostRegistrar = {
	host: "gemini",
	scope: "global",
	register: () => upsertJsonMcpServer(join(homedir(), ".gemini", "settings.json"), { ...jolliEntry() }),
	remove: () => removeJsonMcpServer(join(homedir(), ".gemini", "settings.json")),
	gitExcludePaths: () => [],
};

/**
 * Codex CLI: global `~/.codex/config.toml`.
 * Format verified from official Codex docs (https://developers.openai.com/codex/mcp)
 * and confirmed against a real ~/.codex/config.toml on developer machine:
 *   [mcp_servers.jollimemory]
 *   command = "/path/to/run-cli"
 *   args = ["mcp"]
 * Table key is `mcp_servers` (underscore). Global config — never committed, so
 * gitExcludePaths returns [].
 */
const codexRegistrar: McpHostRegistrar = {
	host: "codex",
	scope: "global",
	register: () => upsertCodexMcpServer(join(homedir(), ".codex", "config.toml"), jolliEntry()),
	remove: () => removeCodexMcpServer(join(homedir(), ".codex", "config.toml")),
	gitExcludePaths: () => [],
};

/**
 * OpenCode: global `~/.config/opencode/opencode.json`.
 * Format live-verified via `opencode mcp list` (opencode-ai 1.4.1): top-level key
 * `mcp`; entry REQUIRES `type:"local"` and a single `command` ARRAY (command + args
 * combined). `mcpServers` key → "Unrecognized key"; split {command,args} → "Invalid
 * input"; missing `type` → "Invalid input". `enabled` defaults true. Global config —
 * never committed, so gitExcludePaths returns [].
 */
const opencodeRegistrar: McpHostRegistrar = {
	host: "opencode",
	scope: "global",
	register: () => {
		const base = jolliEntry();
		const entry = { type: "local", command: [base.command, ...base.args], enabled: true };
		return upsertJsonMcpServer(join(homedir(), ".config", "opencode", "opencode.json"), entry, "mcp");
	},
	remove: () => removeJsonMcpServer(join(homedir(), ".config", "opencode", "opencode.json"), "mcp"),
	gitExcludePaths: () => [],
};

/**
 * GitHub Copilot CLI: user-global `~/.copilot/mcp-config.json`.
 * Format live-verified via `copilot mcp add`/`get` (copilot CLI): top-level key
 * `mcpServers`, entry `{ command, args }` (Copilot defaults `type:"local"` when omitted —
 * live-verified). Same shape as Cursor/Gemini, so the default writer key is reused.
 * NOTE: Copilot CLI ALSO reads workspace `.mcp.json`, which the Claude registrar already
 * writes — so the workspace path is covered there; this registrar handles only the
 * user-global file. Global config — never committed, so gitExcludePaths returns [].
 */
const copilotCliRegistrar: McpHostRegistrar = {
	host: "copilot",
	scope: "global",
	register: () => upsertJsonMcpServer(join(homedir(), ".copilot", "mcp-config.json"), { ...jolliEntry() }),
	remove: () => removeJsonMcpServer(join(homedir(), ".copilot", "mcp-config.json")),
	gitExcludePaths: () => [],
};

/**
 * VS Code Copilot Chat: user-global `<vscodeUserDataDir>/User/mcp.json`.
 * Format from VS Code app source (workbench.desktop.main.js): top-level key
 * `servers` (`serversKey ?? "servers"`); stdio entry `{ type:"stdio", command, args }`.
 * ⚠️ Verified against VS Code app source; not yet confirmed by a live smoke test.
 * Global config — never committed, so gitExcludePaths returns [].
 */
const copilotChatRegistrar: McpHostRegistrar = {
	host: "copilotChat",
	scope: "global",
	register: () => {
		const base = jolliEntry();
		const entry = { type: "stdio", command: base.command, args: base.args };
		return upsertJsonMcpServer(join(getVscodeUserDataDir("Code"), "User", "mcp.json"), entry, "servers");
	},
	remove: () => removeJsonMcpServer(join(getVscodeUserDataDir("Code"), "User", "mcp.json"), "servers"),
	gitExcludePaths: () => [],
};

/**
 * Return the ordered list of registrars for the detected set of hosts.
 */
export function buildRegistrars(detected: DetectedHosts): McpHostRegistrar[] {
	const out: McpHostRegistrar[] = [];
	if (detected.claude) out.push(claudeRegistrar);
	if (detected.cursor) out.push(cursorRegistrar);
	if (detected.gemini) out.push(geminiRegistrar);
	if (detected.codex) out.push(codexRegistrar);
	if (detected.opencode) out.push(opencodeRegistrar);
	if (detected.copilot) out.push(copilotCliRegistrar);
	if (detected.copilotChat) out.push(copilotChatRegistrar);
	return out;
}

/** Every host treated as detected — used so removal covers hosts that may have
 * been registered by a previous install even if not detected right now. */
const ALL_DETECTED: DetectedHosts = {
	claude: true,
	codex: true,
	cursor: true,
	gemini: true,
	opencode: true,
	copilot: true,
	copilotChat: true,
};

/** Run `fn` over `regs` with per-host error isolation — one failure is logged
 * as a warning but never blocks the rest or fails the install/uninstall. */
async function forEachIsolated(
	regs: McpHostRegistrar[],
	wt: string,
	verb: string,
	fn: (r: McpHostRegistrar) => Promise<void>,
): Promise<void> {
	for (const r of regs) {
		try {
			await fn(r);
		} catch (err) {
			log.warn("MCP %s failed for %s in %s (non-fatal): %s", verb, r.host, wt, String(err));
		}
	}
}

/**
 * Register the MCP server in the detected **repo-scoped** hosts (Claude, Cursor).
 * Their config files live inside the worktree, so this is called once per
 * worktree in the install loop.
 */
export async function registerRepoMcpHosts(wt: string, detected: DetectedHosts): Promise<void> {
	const regs = buildRegistrars(detected).filter((r) => r.scope === "repo");
	await forEachIsolated(regs, wt, "registration", (r) => r.register(wt));
}

/**
 * Register the MCP server in the detected **global** hosts (Codex, Gemini,
 * OpenCode, Copilot, Copilot Chat). Their config files are machine-wide and
 * shared by every repo, so this is called ONCE per install — not per worktree —
 * to avoid rewriting the same file N times.
 */
export async function registerGlobalMcpHosts(detected: DetectedHosts): Promise<void> {
	const regs = buildRegistrars(detected).filter((r) => r.scope === "global");
	// `wt` is ignored by global registrars; pass "" purely to satisfy the signature.
	await forEachIsolated(regs, "(global)", "registration", (r) => r.register(""));
}

/**
 * Remove the JolliMemory MCP entry from the **repo-scoped** hosts (Claude,
 * Cursor) for this worktree. Runs for ALL known repo hosts regardless of current
 * detection so an uninstall still cleans up a host that was registered earlier.
 *
 * Global hosts are deliberately NOT removed: their `jollimemory` entry is shared
 * across every repo on the machine, so removing it during a single-repo
 * uninstall would break MCP for all other repos still using Jolli. A stale
 * global entry is harmless (idempotently refreshed on the next install) and far
 * preferable to cross-repo breakage.
 */
export async function removeRepoMcpHosts(wt: string): Promise<void> {
	const regs = buildRegistrars(ALL_DETECTED).filter((r) => r.scope === "repo");
	await forEachIsolated(regs, wt, "removal", (r) => r.remove(wt));
}

/** A host key in {@link DetectedHosts}. */
export type McpHostName = keyof DetectedHosts;

/** A `DetectedHosts` with exactly `host` flagged true. */
function onlyHost(host: McpHostName): DetectedHosts {
	return {
		claude: host === "claude",
		codex: host === "codex",
		cursor: host === "cursor",
		gemini: host === "gemini",
		opencode: host === "opencode",
		copilot: host === "copilot",
		copilotChat: host === "copilotChat",
	};
}

/**
 * Remove the JolliMemory MCP entry for a SINGLE **repo-scoped** host (Claude or
 * Cursor) in this worktree — the granular counterpart to {@link removeRepoMcpHosts},
 * for the control-center TUI's per-source disable. A no-op for global hosts:
 * their entry is machine-wide and shared across repos, so a per-repo TUI must
 * never remove it (see {@link removeRepoMcpHosts} rationale).
 */
export async function removeRepoMcpHostsFor(wt: string, host: McpHostName): Promise<void> {
	const regs = buildRegistrars(onlyHost(host)).filter((r) => r.scope === "repo");
	await forEachIsolated(regs, wt, "removal", (r) => r.remove(wt));
}

/**
 * Register the MCP server for a SINGLE **repo-scoped** host (Claude or Cursor)
 * in this worktree — granular counterpart to {@link registerRepoMcpHosts}. A
 * no-op for global hosts (their registration stays install/detection-driven).
 */
export async function registerRepoMcpHostsFor(wt: string, host: McpHostName): Promise<void> {
	const regs = buildRegistrars(onlyHost(host)).filter((r) => r.scope === "repo");
	await forEachIsolated(regs, wt, "registration", (r) => r.register(wt));
}
