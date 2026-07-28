import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALL_VSCODE_FLAVORS, getVscodeUserDataDir } from "./VscodeWorkspaceLocator.js";

const EXTENSION_ID = "saoudrizwan.claude-dev";

/** globalStorage dir for the Cline extension under one VS Code flavor. */
function flavorStorageDir(flavor: (typeof ALL_VSCODE_FLAVORS)[number], home: string): string {
	return join(getVscodeUserDataDir(flavor, home), "User", "globalStorage", EXTENSION_ID);
}

/** Existing-or-not, one entry per flavor (caller filters). */
export function getClineStorageDirs(home: string = homedir()): string[] {
	return ALL_VSCODE_FLAVORS.map((f) => flavorStorageDir(f, home));
}

/**
 * Cline's MCP settings file inside one flavor's globalStorage dir. Single source
 * of truth for the path: it is both the presence signal below and the file the
 * MCP registrar writes, so the two must never drift apart.
 */
export function clineMcpSettingsPath(storageDir: string): string {
	return join(storageDir, "settings", "cline_mcp_settings.json");
}

export async function isClineInstalled(home: string = homedir()): Promise<boolean> {
	for (const dir of getClineStorageDirs(home)) {
		try {
			await access(join(dir, "state", "taskHistory.json"));
			return true;
		} catch {
			// try next flavor
		}
	}
	return false;
}

/**
 * The Cline-extension globalStorage dirs where the extension is PRESENT, one per
 * VS Code flavor that has it. Used by MCP registration to write
 * `settings/cline_mcp_settings.json` only into the flavors that host Cline —
 * never creating a spurious settings file under a flavor that doesn't. Unlike
 * `isClineInstalled`, this does not short-circuit: a user may run Cline in more
 * than one flavor (e.g. Code and Cursor), and each has its own independent MCP
 * settings file.
 *
 * The presence signal is `settings/cline_mcp_settings.json`, NOT
 * `state/taskHistory.json`. Cline's McpHub creates the settings file (seeded as
 * `{"mcpServers": {}}`) when the extension first activates, before any task
 * exists; `taskHistory.json` is written lazily on the first history save, and
 * Cline itself treats its absence as an empty history. So taskHistory proves the
 * user has USED Cline, not that they installed it — gating on it silently skipped
 * MCP registration for a freshly installed, not-yet-used Cline. Verified on a
 * real install: `settings/cline_mcp_settings.json` predates the first `tasks/`
 * entry, while `taskHistory.json` appears only later.
 */
export async function getInstalledClineStorageDirs(home: string = homedir()): Promise<string[]> {
	const out: string[] = [];
	for (const dir of getClineStorageDirs(home)) {
		try {
			await access(clineMcpSettingsPath(dir));
			out.push(dir);
		} catch {
			// extension not present under this flavor — skip it
		}
	}
	return out;
}

/**
 * Is the Cline VS Code EXTENSION present in any flavor? The MCP-registration
 * gate, deliberately distinct from `isClineInstalled`, which is the broader
 * "has the user used Cline" signal that session discovery / auto-enable / the
 * status tree want. It is also narrower than the installer's `clineDetectedOnce`
 * (`isClineInstalled() || isClineCliInstalled()`): the Cline CLI ships no MCP
 * config file, so it is not an MCP host, and a CLI-only user must not make the
 * MCP `detected.cline` flag true.
 */
export async function isClinePresent(home: string = homedir()): Promise<boolean> {
	return (await getInstalledClineStorageDirs(home)).length > 0;
}
