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
 * The Cline-extension globalStorage dirs where the extension is actually
 * installed (its `state/taskHistory.json` exists), one per VS Code flavor that
 * has it. Used by MCP registration to write `settings/cline_mcp_settings.json`
 * only into the flavors that host Cline — never creating a spurious settings
 * file under a flavor that doesn't. Unlike `isClineInstalled`, this does not
 * short-circuit: a user may run Cline in more than one flavor (e.g. Code and
 * Cursor), and each has its own independent MCP settings file.
 */
export async function getInstalledClineStorageDirs(home: string = homedir()): Promise<string[]> {
	const out: string[] = [];
	for (const dir of getClineStorageDirs(home)) {
		try {
			await access(join(dir, "state", "taskHistory.json"));
			out.push(dir);
		} catch {
			// extension not present under this flavor — skip it
		}
	}
	return out;
}
