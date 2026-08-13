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
 *   - findVscodeWorkspaceHash(flavor, projectDir)   — one repo → its workspace hash
 *   - listVscodeWorkspaceFolders(flavor)            — every workspace → its folder
 *   - normalizePathForMatch(p)
 *
 * The last two are the two directions of the same lookup, and which one a caller
 * wants follows from how many repos it serves: a per-repo question takes the find,
 * a machine-wide scan serving every registered repo takes the list. Calling the
 * find in a loop re-reads every `workspace.json` on the machine once per repo.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../Logger.js";

const log = createLogger("VscodeWorkspaceLocator");

export type VscodeFlavor = "Cursor" | "Code" | "Code - Insiders" | "VSCodium" | "Windsurf";

/** All VS Code-family flavors Jolli scans for extension data. Directory name == flavor string. */
export const ALL_VSCODE_FLAVORS: ReadonlyArray<VscodeFlavor> = [
	"Code",
	"Code - Insiders",
	"Cursor",
	"VSCodium",
	"Windsurf",
];

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
 * Reads one `workspaceStorage/<entry>/workspace.json` and returns the local path its
 * `folder` URI points at, or undefined when there is none to read.
 *
 * Single-folder workspaces only — an entry with a `workspace` field instead of
 * `folder` (a multi-root `.code-workspace` file) yields undefined and is skipped by
 * every caller.
 */
async function readWorkspaceFolderPath(
	flavor: VscodeFlavor,
	wsStorageDir: string,
	entry: string,
): Promise<string | undefined> {
	const wsJsonPath = join(wsStorageDir, entry, "workspace.json");
	let folderUri: string | undefined;
	try {
		const raw = await readFile(wsJsonPath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		folderUri = typeof parsed.folder === "string" ? parsed.folder : undefined;
	} catch {
		return undefined;
	}

	if (!folderUri || !folderUri.startsWith("file://")) {
		return undefined;
	}

	try {
		return fileURLToPath(folderUri);
	} catch {
		log.warn("%s workspace %s has unparseable folder URI: %s", flavor, entry, folderUri);
		return undefined;
	}
}

/** One VS Code-family workspace: its storage directory name and the folder it opens. */
export interface VscodeWorkspaceFolder {
	/** The `workspaceStorage/<hash>` entry name. */
	readonly hash: string;
	/** The local path its `folder` URI resolves to. Raw — not normalised for matching. */
	readonly folderPath: string;
}

/**
 * Every single-folder workspace this flavour has storage for.
 *
 * The forward direction of {@link findVscodeWorkspaceHash}, and the one a machine-wide
 * scan needs. Resolving a hash FROM a repo path can only answer for the repo you
 * already have, so a scan built on it re-reads every `workspace.json` on the machine
 * once per registered repo. Listing them once gives every repo its answer from one
 * pass.
 *
 * Returns an empty list when the storage directory is unreadable — the same silent
 * degradation `findVscodeWorkspaceHash` applies, and for the same reason: a machine
 * without this editor installed is not a failure to report.
 */
export async function listVscodeWorkspaceFolders(flavor: VscodeFlavor): Promise<ReadonlyArray<VscodeWorkspaceFolder>> {
	const wsStorageDir = getVscodeWorkspaceStorageDir(flavor);

	let entries: string[];
	try {
		entries = await readdir(wsStorageDir);
	} catch {
		log.debug("%s workspaceStorage not readable at %s", flavor, wsStorageDir);
		return [];
	}

	const out: VscodeWorkspaceFolder[] = [];
	for (const entry of entries) {
		const folderPath = await readWorkspaceFolderPath(flavor, wsStorageDir, entry);
		if (folderPath !== undefined) out.push({ hash: entry, folderPath });
	}
	return out;
}

/**
 * Scans the workspaceStorage directory for an entry whose `workspace.json` has
 * a `folder` URI that resolves to projectDir. Returns the entry name (workspace
 * hash) on match, or null when no match is found.
 *
 * Single-folder workspaces only — entries with a `workspace` field instead of
 * `folder` (multi-root .code-workspace files) are skipped silently.
 *
 * Deliberately NOT written as a filter over {@link listVscodeWorkspaceFolders}: this
 * stops at the first match, and its callers ask about one repo at a time. A caller
 * that needs every workspace should use the list directly rather than calling this in
 * a loop.
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
		const folderPath = await readWorkspaceFolderPath(flavor, wsStorageDir, entry);
		if (folderPath !== undefined && normalizePathForMatch(folderPath) === target) {
			return entry;
		}
	}

	return null;
}
