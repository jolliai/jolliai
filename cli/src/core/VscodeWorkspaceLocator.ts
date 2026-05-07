/**
 * VscodeWorkspaceLocator
 *
 * Per-platform path resolution and workspace.json scanning for VS Code-family
 * user data directories. Used by both Cursor (`flavor: "Cursor"`) and VS Code
 * Copilot Chat (`flavor: "Code"`) integrations. Adding a new vscode fork
 * (Insiders, Code-OSS, Windsurf, …) requires only extending the flavor union.
 *
 * Public symbols:
 *   - getVscodeUserDataDir(flavor, home?)
 *   - getVscodeWorkspaceStorageDir(flavor, home?)
 *   - findVscodeWorkspaceHash(flavor, projectDir)
 *   - normalizePathForMatch(p)
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../Logger.js";

const log = createLogger("VscodeWorkspaceLocator");

export type VscodeFlavor = "Cursor" | "Code";

/**
 * Returns the VS Code-family user-data root for the current platform.
 *
 *   darwin   ~/Library/Application Support/<flavor>
 *   linux    ~/.config/<flavor>
 *   win32    %APPDATA%/<flavor>  (fallback to ~/AppData/Roaming/<flavor>)
 */
export function getVscodeUserDataDir(flavor: VscodeFlavor, home: string = homedir()): string {
	switch (platform()) {
		case "darwin":
			return join(home, "Library", "Application Support", flavor);
		case "win32":
			return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), flavor);
		default:
			return join(home, ".config", flavor);
	}
}

/** Returns the workspaceStorage dir for the given flavor. */
export function getVscodeWorkspaceStorageDir(flavor: VscodeFlavor, home?: string): string {
	return join(getVscodeUserDataDir(flavor, home), "User", "workspaceStorage");
}

/**
 * Normalises a filesystem path for workspace matching.
 * - Converts backslashes to forward slashes so Windows paths from
 *   fileURLToPath (which returns `\`-separated paths) compare correctly
 *   against caller-supplied forward-slash paths.
 * - Strips trailing slashes (linear-time loop, not regex — avoids CodeQL polynomial-redos
 *   warnings on JSON-loaded paths).
 * - Lowercases on case-insensitive platforms (darwin, win32).
 */
export function normalizePathForMatch(p: string): string {
	const fwd = p.replace(/\\/g, "/");
	let end = fwd.length;
	while (end > 0 && fwd[end - 1] === "/") {
		end--;
	}
	const trimmed = fwd.slice(0, end);
	const os = platform();
	return os === "darwin" || os === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * Scans the workspaceStorage directory for an entry whose `workspace.json` has
 * a `folder` URI that resolves to projectDir. Returns the entry name (workspace
 * hash) on match, or null when no match is found.
 *
 * Single-folder workspaces only — entries with a `workspace` field instead of
 * `folder` (multi-root .code-workspace files) are skipped silently.
 */
export async function findVscodeWorkspaceHash(flavor: VscodeFlavor, projectDir: string): Promise<string | null> {
	const wsStorageDir = getVscodeWorkspaceStorageDir(flavor);

	let entries: string[];
	try {
		entries = await readdir(wsStorageDir);
	} catch {
		log.debug("%s workspaceStorage not readable at %s", flavor, wsStorageDir);
		return null;
	}

	const target = normalizePathForMatch(projectDir);

	for (const entry of entries) {
		const wsJsonPath = join(wsStorageDir, entry, "workspace.json");
		let folderUri: string | undefined;
		try {
			const raw = await readFile(wsJsonPath, "utf8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			folderUri = typeof parsed.folder === "string" ? parsed.folder : undefined;
		} catch {
			continue;
		}

		if (!folderUri || !folderUri.startsWith("file://")) {
			continue;
		}

		let folderPath: string;
		try {
			folderPath = fileURLToPath(folderUri);
		} catch {
			log.warn("%s workspace %s has unparseable folder URI: %s", flavor, entry, folderUri);
			continue;
		}

		if (normalizePathForMatch(folderPath) === target) {
			return entry;
		}
	}

	return null;
}
